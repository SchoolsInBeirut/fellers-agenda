// lms-canvas.mjs - the second learning-management source, over Canvas's REST API.
//
// WHY THIS ONE TALKS HTTP AND THE BRIGHTSPACE ONE DOES NOT
//
// Brightspace has no student API a script may use, so that connector drives a
// logged-in browser session through an MCP server. Canvas does have one: a
// documented, stable, read-only REST API that answers to a personal access
// token the student makes for themselves in two clicks. There is nothing to
// install, no server to register and no browser to keep alive, so the honest
// implementation is `fetch` and nothing else.
//
// THE TOKEN
//
// `connectors.lms.canvas.token` lives only in `config.json`, which is
// git-ignored. It is sent in an Authorization header, never in a URL, never in
// argv and never in a log line - `redact()` scrubs it out of every message this
// file can produce, including the ones that quote a response body. If your
// institution has disabled student API tokens (some have), the API answers 401
// or 403 and this connector says so in one sentence rather than retrying.
//
// WHAT IT SWEEPS, PER COURSE
//
//   GET /api/v1/courses?enrollment_state=active   the enrolment list
//   GET /api/v1/courses/:id/assignments           deadlines + your own submission
//   GET /api/v1/announcements?context_codes[]=... recent posts, for the digest
//
// Every list endpoint is paginated with RFC 5988 `Link` headers, so every sweep
// walks `rel="next"` to the end rather than silently keeping the first hundred
// rows. Every sweep is wrapped individually: one endpoint failing for one course
// costs that course one line in errors[], never the run. Authentication failures
// are the exception and stop the sweep, because retrying twelve more requests
// against a revoked token produces twelve confusing errors instead of one
// actionable one.
//
// BOTH LMS CONNECTORS MAY BE ON AT ONCE. Nothing here assumes it is the only
// one: a student mid-transfer, or one whose department uses each system for
// different courses, enables both and the merge chain dedupes across them.
import { classifyType } from "../merge.mjs";

export const meta = {
  id: "lms-canvas",
  kind: "lms",
  label: "Canvas (Instructure)",
  configPath: "connectors.lms.canvas",
  requires: { os: [], bin: [], mcp: [], app: [] },
  // Tier 1: a hosted API and a token you paste in. Nothing to install, no local
  // server, and it works identically on Windows, macOS, Linux and a hosted agent.
  tier: 1,
};

/** Canvas caps `per_page` at 100 on every list endpoint. */
const PER_PAGE = 100;

/** A runaway guard: 40 pages is 4000 rows, far past any real enrolment. */
const MAX_PAGES = 40;

/** One request's own timeout, so a hung socket cannot eat the whole deadline. */
const REQUEST_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Auth failures read the same from every layer of this stack. */
export const isAuthError = (e) => e?.status === 401 || e?.status === 403 || /401|403|token|unauthorized/i.test(String(e?.message ?? ""));

/**
 * An HTTP failure that carries its status, so callers can branch on 401 without
 * parsing English out of a message.
 */
export class CanvasHttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = "CanvasHttpError";
    this.status = status;
    this.url = url;
  }
}

/** Remove every occurrence of the token from text. A falsy token is a no-op. */
export function redact(text, token) {
  const s = String(text ?? "");
  if (!token || String(token).length < 8) return s;
  return s.split(String(token)).join("«redacted»");
}

/**
 * Turn whatever the user typed into an origin we can build URLs on.
 *
 * People paste "canvas.example.edu", "https://canvas.example.edu/", and
 * "https://canvas.example.edu/courses" with roughly equal frequency. All three
 * mean the same host. Anything that is not http(s) is refused rather than
 * guessed at, because a typo here sends a bearer token somewhere unintended.
 */
export function normalizeBaseUrl(raw, fallbackHost = null) {
  const candidate = String(raw ?? "").trim() || (fallbackHost ? String(fallbackHost).trim() : "");
  if (!candidate) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * Parse an RFC 5988 `Link` header into `{rel: url}`.
 *
 * Canvas paginates everything and puts the ONLY pointer to page two in this
 * header. A reader that ignores it looks like it is working - it returns a
 * hundred perfectly good rows - and quietly loses every deadline after that.
 */
export function parseLinkHeader(header) {
  const out = {};
  for (const part of String(header ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/i.exec(part.trim());
    if (m) out[m[2].trim().toLowerCase()] = m[1].trim();
  }
  return out;
}

/** Everything this connector needs out of the config, resolved once. */
export function settingsOf(cfg) {
  const own = cfg?.connectors?.lms?.canvas ?? {};
  return {
    baseUrl: normalizeBaseUrl(own.baseUrl, cfg?.institution?.lmsHost ?? null),
    token: typeof own.token === "string" && own.token.trim() ? own.token.trim() : null,
    courseFilter: (Array.isArray(own.courseFilter) ? own.courseFilter : [])
      .map((c) => String(c ?? "").trim())
      .filter(Boolean),
    windowDays: Number(cfg?.scrapeWindowDays) || 60,
    lookbackDays: Number(cfg?.announcementLookbackDays) || 14,
  };
}

/** Course codes compare without spaces or case: "phys221" === "PHYS 221". */
const foldCode = (s) => String(s ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * Is this course in scope? An empty filter means every active enrolment, which
 * is the right default: a student who has not told us otherwise wants their
 * whole term.
 */
export function courseMatches(course, filter) {
  if (!filter || filter.length === 0) return true;
  return filter.some((f) => foldCode(f) === foldCode(course.code) || String(f) === String(course.id));
}

/**
 * The shape the rest of the pipeline speaks, out of one Canvas course row.
 * `courses[]` in config wins on naming when it knows this course, so the codes
 * on the page match the ones the user chose.
 */
export function normalizeCourse(raw, derived = null) {
  const id = Number(raw?.id);
  if (!Number.isFinite(id)) return null;
  const known = derived?.courseById?.get(id) ?? null;
  const code = String(known?.code ?? raw?.course_code ?? raw?.name ?? "").trim();
  if (!code) return null;
  return { id, code, name: String(raw?.name ?? code).trim() };
}

/**
 * Read submission evidence out of one assignment's `submission` object.
 *
 * POSITIVE EVIDENCE ONLY, with one explicit negative. `submitted_at`, an
 * attempt count above zero, or a graded state with a score above zero are all
 * proof the work went in. Canvas's `missing: true` is the one case where the
 * service itself states the work is NOT there - the deadline passed with
 * nothing submitted - and that is a real `false`, not a guess.
 *
 * Everything else is null. A graded 0 is deliberately not evidence either way:
 * it cannot tell "never turned in" from "turned in and did badly", and guessing
 * either way puts a lie on the page.
 */
export function submissionEvidence(assignment) {
  const s = assignment?.submission;
  if (!s || typeof s !== "object") return null;
  if (s.submitted_at) return true;
  if (Number(s.attempt) > 0) return true;
  if (s.workflow_state === "graded" && typeof s.score === "number" && s.score > 0) return true;
  if (s.missing === true) return false; // Canvas states it: due date passed, nothing submitted
  if (s.workflow_state === "unsubmitted" && s.late === false && s.excused === true) return false;
  return null;
}

/** Quizzes and discussions are typed from Canvas's own submission_types list. */
function sourceTypeOf(assignment) {
  const types = Array.isArray(assignment?.submission_types) ? assignment.submission_types : [];
  if (types.some((t) => /quiz/i.test(String(t)))) return "quiz";
  if (assignment?.quiz_id != null) return "quiz";
  return "dropbox";
}

/**
 * One assignment row -> one item, or null when it has no usable deadline.
 * Undated work belongs in mail[], never in items[]: see rule 3 in
 * `docs/EXTENDING.md`. Never invent a date.
 */
export function toItem(course, assignment) {
  const due = assignment?.due_at ?? null;
  if (!due) return null;
  const at = new Date(due);
  if (Number.isNaN(at.getTime())) return null;
  const title = String(assignment?.name ?? "").trim();
  if (!title) return null;
  return {
    courseId: course.id,
    course: course.code,
    title,
    due: at.toISOString(),
    type: classifyType(title, sourceTypeOf(assignment)),
    sources: ["canvas"],
    submitted: submissionEvidence(assignment),
    approx: false,
    url: assignment?.html_url ?? null,
  };
}

/**
 * One assignment row -> one grade row, or null when nothing has been graded.
 * The gradebook is the authoritative completion signal, so it is worth carrying
 * even for items whose due date has passed.
 */
export function toGrade(course, assignment) {
  const s = assignment?.submission;
  if (!s || s.workflow_state !== "graded") return null;
  const score = typeof s.score === "number" ? s.score : null;
  const display =
    s.grade != null
      ? String(s.grade)
      : score != null && assignment.points_possible != null
        ? `${score} / ${assignment.points_possible}`
        : score != null
          ? String(score)
          : "";
  if (!display) return null;
  return {
    courseId: course.id,
    title: String(assignment?.name ?? ""),
    display,
    numeric: score,
  };
}

/** One announcement row -> the announcement shape, or null. */
export function toAnnouncement(course, raw) {
  const posted = raw?.posted_at ?? raw?.created_at ?? null;
  if (!posted) return null;
  const at = new Date(posted);
  if (Number.isNaN(at.getTime())) return null;
  return {
    id: String(raw?.id ?? `${at.toISOString()}:${String(raw?.title ?? "").slice(0, 40)}`),
    courseId: course.id,
    course: course.code,
    title: String(raw?.title ?? ""),
    posted: at.toISOString(),
    // Canvas announcement bodies are HTML written by other people. They are
    // data, never instructions; tags are stripped so the digest reads as prose.
    body: String(raw?.message ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000),
  };
}

/**
 * The one sentence a user gets for each way Canvas can refuse.
 *
 * These are the messages that decide whether somebody fixes their setup in a
 * minute or files an issue, so each one names the cause AND the next action.
 */
export function explainStatus(status, baseUrl) {
  if (status === 401) {
    return (
      "Canvas rejected the access token (401). It has been revoked, it expired, " +
      `or it was made on a different Canvas site. Make a new one at ${baseUrl}/profile/settings ` +
      '("+ New Access Token") and put it in connectors.lms.canvas.token'
    );
  }
  if (status === 403) {
    return (
      "Canvas refused the request (403). The token is recognised but not allowed " +
      "to read this - many institutions disable student API access entirely. " +
      "Ask your help desk whether API tokens are enabled for students; if they are not, " +
      "leave canvas.enabled false and see docs/connectors/not-supported.md"
    );
  }
  if (status === 404) return "Canvas has no such course, or the enrolment is concluded (404)";
  if (status === 429) return "Canvas is rate-limiting this account (429) - the next run will pick up where this one stopped";
  return `Canvas answered ${status}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One GET, with the token in a header and never in the URL.
 *
 * `fetchImpl` is injected so the whole paging and normalisation path can be
 * tested against recorded responses in `fixtures/canvas/` without a network.
 */
async function getJson(url, { token, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new CanvasHttpError(redact(`could not reach Canvas: ${e.message}`, token), 0, url);
  }
  if (!res.ok) {
    throw new CanvasHttpError(explainStatus(res.status, new URL(url).origin), res.status, url);
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new CanvasHttpError(redact(`Canvas did not return JSON: ${e.message}`, token), res.status, url);
  }
  const link = typeof res.headers?.get === "function" ? res.headers.get("link") : null;
  return { body, next: parseLinkHeader(link).next ?? null };
}

/**
 * Follow `rel="next"` to the end and concatenate the pages.
 *
 * The deadline is checked between pages rather than only at the top: a course
 * with two thousand assignments must not be able to spend the whole run's
 * budget, and a partial list plus one errors[] line is a far better outcome
 * than a run that never finishes.
 */
export async function fetchAll(url, { token, fetchImpl, deadline = Infinity, maxPages = MAX_PAGES }) {
  const rows = [];
  let cursor = url;
  for (let page = 0; page < maxPages && cursor; page += 1) {
    if (Date.now() > deadline) {
      throw new CanvasHttpError(`ran out of time after ${page} page(s)`, 0, cursor);
    }
    const { body, next } = await getJson(cursor, { token, fetchImpl });
    if (Array.isArray(body)) rows.push(...body);
    else if (body && typeof body === "object") rows.push(body);
    cursor = next;
  }
  return rows;
}

const api = (baseUrl, path, params = {}) => {
  const url = new URL(`/api/v1/${path.replace(/^\//, "")}`, baseUrl);
  url.searchParams.set("per_page", String(PER_PAGE));
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const one of v) url.searchParams.append(k, String(one));
    else if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
};

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

/**
 * The two things every entry point needs before it can talk to Canvas, or the
 * one sentence explaining which is missing. Split out so `collect()` and
 * `healthCheck()` can never disagree about what "ready" means - the preflight
 * calls the same rule, which is the whole point of BLOCKER-1's fix.
 */
export function precheck(cfg) {
  const s = settingsOf(cfg);
  if (!s.baseUrl) {
    return {
      ok: false,
      detail: "connectors.lms.canvas.baseUrl is not set",
      fix: 'set it to your school\'s Canvas address, e.g. "https://canvas.example.edu" (or fill in institution.lmsHost)',
    };
  }
  if (!s.token) {
    return {
      ok: false,
      detail: "connectors.lms.canvas.token is not set",
      fix: `make a token in Canvas at ${s.baseUrl}/profile/settings ("+ New Access Token") and paste it into config.json - it never leaves this machine`,
    };
  }
  return { ok: true, detail: `${s.baseUrl} with a token`, fix: null, settings: s };
}

/**
 * The active enrolment list, normalised and filtered.
 * Exported because the setup agent and the doctor both want "which courses can
 * this token actually see?" without running a whole sweep.
 */
export async function listCourses(ctx, s, fetchImpl) {
  const raw = await fetchAll(api(s.baseUrl, "courses", { enrollment_state: "active", "include[]": "term" }), {
    token: s.token,
    fetchImpl,
    deadline: ctx.deadline ?? Infinity,
  });
  return raw
    .map((c) => normalizeCourse(c, ctx.derived))
    .filter((c) => c && courseMatches(c, s.courseFilter));
}

async function sweepCourse(course, s, fetchImpl, ctx, out) {
  // 1. Assignments, with this student's own submission attached. One request
  //    per page rather than one per assignment: `include[]=submission` is what
  //    makes the completion signal affordable.
  try {
    const rows = await fetchAll(
      api(s.baseUrl, `courses/${course.id}/assignments`, {
        "include[]": "submission",
        order_by: "due_at",
      }),
      { token: s.token, fetchImpl, deadline: ctx.deadline ?? Infinity },
    );
    for (const row of rows) {
      const item = toItem(course, row);
      if (item) out.items.push(item);
      const grade = toGrade(course, row);
      if (grade) out.grades.push(grade);
    }
  } catch (e) {
    if (isAuthError(e)) throw e;
    out.errors.push(`${course.code} assignments: ${redact(String(e.message), s.token).slice(0, 200)}`);
  }

  // 2. Announcements, within the configured lookback.
  try {
    const since = new Date(Date.now() - s.lookbackDays * 86400000).toISOString();
    const rows = await fetchAll(
      api(s.baseUrl, "announcements", { "context_codes[]": `course_${course.id}`, start_date: since }),
      { token: s.token, fetchImpl, deadline: ctx.deadline ?? Infinity },
    );
    for (const row of rows) {
      const ann = toAnnouncement(course, row);
      if (ann) out.announcements.push(ann);
    }
  } catch (e) {
    if (isAuthError(e)) throw e;
    out.errors.push(`${course.code} announcements: ${redact(String(e.message), s.token).slice(0, 200)}`);
  }
}

export async function collect(ctx) {
  const out = { items: [], mail: [], announcements: [], board: [], grades: [], errors: [] };
  const ready = precheck(ctx.cfg);
  if (!ready.ok) {
    out.errors.push(`${meta.id}: ${ready.detail} - ${ready.fix}`);
    return out;
  }
  const s = ready.settings;
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    out.errors.push(`${meta.id}: this Node build has no global fetch - Node 22 or newer is required`);
    return out;
  }

  let courses;
  try {
    courses = await listCourses(ctx, s, fetchImpl);
  } catch (e) {
    // The enrolment list is the one request whose failure is worth stopping on:
    // without it there is nothing to sweep, and an auth failure here is what
    // `scrape.mjs` turns into exit 2 and a re-auth prompt.
    const message = redact(String(e.message), s.token);
    if (isAuthError(e)) throw Object.assign(new Error(`${meta.id}: ${message}`), { status: e.status });
    out.errors.push(`${meta.id}: ${message.slice(0, 200)}`);
    return out;
  }

  if (!courses.length) {
    out.errors.push(
      `${meta.id}: the token works but no active course matched` +
        (s.courseFilter.length ? ` connectors.lms.canvas.courseFilter (${s.courseFilter.join(", ")})` : " - the term may not have started yet"),
    );
    return out;
  }

  for (const course of courses) {
    if (Date.now() > (ctx.deadline ?? Infinity)) {
      out.errors.push(`${meta.id}: ran out of time before ${course.code}`);
      break;
    }
    await sweepCourse(course, s, fetchImpl, ctx, out);
  }
  return out;
}

export async function healthCheck(ctx) {
  const ready = precheck(ctx.cfg);
  if (!ready.ok) return { ok: false, detail: ready.detail, fix: ready.fix };
  const s = ready.settings;
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  try {
    const courses = await listCourses(ctx, s, fetchImpl);
    return {
      ok: true,
      detail: `${courses.length} active course(s) visible at ${s.baseUrl}`,
      fix: null,
    };
  } catch (e) {
    return {
      ok: false,
      detail: redact(String(e.message), s.token).slice(0, 200),
      fix:
        e?.status === 401 || e?.status === 403
          ? `make a fresh token at ${s.baseUrl}/profile/settings and update connectors.lms.canvas.token`
          : "check the address in connectors.lms.canvas.baseUrl, and that this machine can reach it",
    };
  }
}
