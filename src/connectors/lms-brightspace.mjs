// lms-brightspace.mjs - the default learning-management source.
//
// Brightspace (D2L) exposes no student API that a script may use directly, so
// this connector talks to it through an MCP server that drives a logged-in
// session. The server is named in `.mcp.json` and referenced from config by
// key, never spawned by path from here: a user on a different institution, or
// on Canvas, swaps one config line rather than editing code.
//
// FOUR SWEEPS PER COURSE, PLUS ONE GLOBAL
//
//   get_assignments        dropbox + quizzes, with whatever submission signal exists
//   get_course_content     due dates buried in content modules (professors hide them there)
//   get_announcements      recent posts, for context in the digest
//   get_my_grades          the gradebook - the authoritative completion signal
//   get_upcoming_due_dates one global call: the calendar view professors actually maintain
//
// Every one of them is wrapped individually. One endpoint failing for one
// course costs that one sweep and one line in errors[]; it never costs the run.
// An authentication failure is different and is re-thrown, because retrying
// three more endpoints against a dead session just produces four confusing
// errors instead of one actionable one.
import { classifyType } from "../merge.mjs";

export const meta = {
  id: "lms-brightspace",
  kind: "lms",
  label: "Brightspace (D2L)",
  configPath: "connectors.lms.brightspace",
  requires: { os: [], bin: [], mcp: ["brightspace"], app: [] },
  tier: 2,
};

/** Auth failures read the same from every layer of this stack. */
export const isAuthError = (e) => /401|auth|session|expired|unauthorized/i.test(String(e?.message ?? ""));

/**
 * Read submission evidence out of one assignment row.
 *
 * POSITIVE EVIDENCE ONLY, on purpose. The student-facing quiz endpoint lies in
 * the negative direction: quizzes that the gradebook scored 10/10 have been
 * observed reporting `attemptsUsed: 0, bestScore: null` on the same day. Code
 * that read fields the server never sends stamped `submitted: false` on every
 * quiz and dropbox row in the snapshot - which put finished work into the
 * overdue lane and onto the user's calendar.
 *
 * So: return true only when something was actually observed, and null
 * (unknown) otherwise. `false` is reserved for a source that explicitly states
 * it. The page, the focus engine and the calendar sink all treat null as "not
 * tracked" rather than "not done", so an unknown item is still nudged but never
 * accused.
 */
export function submissionEvidence(x) {
  if (typeof x.submitted === "boolean") return x.submitted; // explicit claim, honor it
  if ((x.attemptsUsed ?? x.submissionCount ?? x.attempts ?? 0) > 0) return true;
  if (x.bestScore !== null && x.bestScore !== undefined) return true;
  if (x.submission || x.feedback) return true; // dropbox: a submission/feedback object exists
  return null;
}

function toItem(courseId, courseCode, title, due, sourceType, extra = {}) {
  if (!due) return null;
  const at = new Date(due);
  if (Number.isNaN(at.getTime())) return null;
  return {
    courseId,
    course: courseCode,
    title: String(title ?? "").trim(),
    due: at.toISOString(),
    type: classifyType(title ?? "", sourceType),
    sources: [sourceType],
    submitted: extra.submitted ?? null,
    approx: extra.approx ?? false,
    url: extra.url ?? null,
  };
}

/** Content modules nest arbitrarily deep; hidden nodes are not the user's problem. */
function walkContent(nodes, courseId, courseCode, out) {
  for (const n of nodes ?? []) {
    const due = n.dueDate ?? n.endDate ?? null;
    if (due && !n.isHidden) {
      const item = toItem(courseId, courseCode, n.title, due, "content");
      if (item) out.push(item);
    }
    if (n.children) walkContent(n.children, courseId, courseCode, out);
  }
}

async function sweepCourse(client, course, cfg, out) {
  // 1. Dropbox assignments + quizzes, with whatever submission status exists.
  try {
    const a = await client.call("get_assignments", { courseId: course.id });
    const list = Array.isArray(a) ? a : (a.assignments ?? []);
    for (const x of list) {
      const isQuiz = x.quizId != null || x.QuizId != null || /quiz/i.test(x.type ?? "");
      const item = toItem(
        course.id,
        course.code,
        x.name ?? x.title,
        x.dueDate ?? x.due ?? x.endDate,
        isQuiz ? "quiz" : "dropbox",
        { submitted: submissionEvidence(x) },
      );
      if (item) out.items.push(item);
    }
  } catch (e) {
    if (isAuthError(e)) throw e;
    out.errors.push(`${course.code} assignments: ${String(e.message).slice(0, 200)}`);
  }

  // 2. Due dates hidden inside content modules.
  try {
    const c = await client.call("get_course_content", { courseId: course.id });
    walkContent(c.contentTree ?? [], course.id, course.code, out.items);
  } catch (e) {
    if (isAuthError(e)) throw e;
    out.errors.push(`${course.code} content: ${String(e.message).slice(0, 200)}`);
  }

  // 3. Announcements, within the configured lookback.
  try {
    const anns = await client.call("get_announcements", { courseId: course.id });
    const list = Array.isArray(anns) ? anns : (anns.announcements ?? []);
    const lookback = Number(cfg.announcementLookbackDays) || 14;
    const cutoff = Date.now() - lookback * 86400000;
    for (const x of list) {
      const posted = x.postedDate ?? x.date ?? x.startDate;
      if (!posted || new Date(posted).getTime() < cutoff) continue;
      out.announcements.push({
        id: x.id ?? x.Id ?? `${posted}:${String(x.title ?? "").slice(0, 40)}`,
        courseId: course.id,
        course: course.code,
        title: x.title ?? "",
        posted: new Date(posted).toISOString(),
        body: String(x.body ?? x.text ?? "").slice(0, 2000),
      });
    }
  } catch (e) {
    if (isAuthError(e)) throw e;
    out.errors.push(`${course.code} announcements: ${String(e.message).slice(0, 200)}`);
  }

  // 4. The gradebook. See submissionEvidence() for why this one is the truth.
  try {
    const g = await client.call("get_my_grades", { courseId: course.id });
    const rows = Array.isArray(g) ? g : (g.grades ?? []);
    for (const row of rows) {
      out.grades.push({
        courseId: course.id,
        title: String(row.name ?? row.title ?? ""),
        display: String(row.displayGrade ?? row.displayedGrade ?? row.grade ?? row.display ?? ""),
        // Points earned when the gradebook gives a number. Zero is kept as
        // zero and never promoted: a 0 cannot tell "never turned in" from
        // "turned in and did badly", and guessing either way is a lie.
        numeric:
          typeof row.pointsNumerator === "number"
            ? row.pointsNumerator
            : typeof row.numeric === "number"
              ? row.numeric
              : null,
      });
    }
  } catch (e) {
    if (isAuthError(e)) throw e;
    out.errors.push(`${course.code} grades: ${String(e.message).slice(0, 200)}`);
  }
}

export async function collect(ctx) {
  const out = { items: [], mail: [], announcements: [], board: [], grades: [], errors: [] };
  const cfg = ctx.cfg;
  const courses = Array.isArray(cfg.courses) ? cfg.courses.filter((c) => c && c.id != null && c.code) : [];
  if (!courses.length) {
    out.errors.push("lms-brightspace: no courses in config - run setup, or add them to config.json");
    return out;
  }

  const server = ctx.cfg?.connectors?.lms?.brightspace?.mcpServer ?? "brightspace";
  const client = await ctx.mcp(server);
  try {
    // The global calendar view. Professors maintain this one even when they
    // never touch the dropbox, so it is often the only source for an exam.
    try {
      const cal = await client.call("get_upcoming_due_dates", {
        daysAhead: Number(cfg.scrapeWindowDays) || 60,
      });
      const list = Array.isArray(cal) ? cal : (cal.dueDates ?? cal.events ?? []);
      const byId = new Map(courses.map((c) => [c.id, c]));
      for (const x of list) {
        const course = byId.get(x.courseId ?? x.orgUnitId);
        if (!course) continue; // a course the user did not ask us to track
        const item = toItem(
          course.id,
          course.code,
          x.title ?? x.name,
          x.dueDate ?? x.due ?? x.endDate,
          "calendar",
        );
        if (item) out.items.push(item);
      }
    } catch (e) {
      if (isAuthError(e)) throw e;
      out.errors.push(`calendar: ${String(e.message).slice(0, 200)}`);
    }

    for (const course of courses) {
      if (Date.now() > ctx.deadline) {
        out.errors.push(`lms-brightspace: ran out of time before ${course.code}`);
        break;
      }
      await sweepCourse(client, course, cfg, out);
    }
  } finally {
    client.close();
  }
  return out;
}

export async function healthCheck(ctx) {
  const server = ctx.cfg?.connectors?.lms?.brightspace?.mcpServer ?? "brightspace";
  const fix = "run `node scripts/reauth.mjs` and finish the login in the browser window it opens";
  let client;
  try {
    client = await ctx.mcp(server);
  } catch (e) {
    return {
      ok: false,
      detail: `could not start the "${server}" MCP server: ${e.message}`,
      fix: `check that "${server}" is listed in .mcp.json and that you approved this project's servers (claude mcp list)`,
    };
  }
  try {
    const auth = await client.call("check_auth", {});
    if (auth && auth.authenticated === false) return { ok: false, detail: "the saved session has expired", fix };
    const courses = await client.call("get_my_courses", {});
    const n = Array.isArray(courses) ? courses.length : (courses?.courses?.length ?? 0);
    return { ok: true, detail: `${n} course(s) visible`, fix: null };
  } catch (e) {
    return { ok: false, detail: String(e.message).slice(0, 200), fix };
  } finally {
    client.close();
  }
}
