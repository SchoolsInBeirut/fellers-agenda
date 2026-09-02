// grades-gradescope.mjs - a thin shim over the optional Python adapter.
//
// OFF BY DEFAULT, AND THE ONLY CONNECTOR THAT NEEDS ANOTHER LANGUAGE. Read
// extras/gradescope/README.md before enabling it: it covers the terms-of-use
// question you should answer for yourself first, and how to install the one
// Python dependency it needs.
//
// WHY IT IS WORTH THE TROUBLE. Some courses collect everything on a grading
// service, which makes that service the only place that knows whether the work
// is DONE. Without it those items sit in the agenda looking undone forever, and
// an agenda that accuses its user of not doing work they finished is worse than
// no agenda at all.
//
// THIS FILE DOES ALMOST NOTHING ON PURPOSE. All the real work - the login, the
// scraping, the status classifier, the empty-result canary - lives in
// extras/gradescope/gradescope.py, where it can be tested with `--self-test`
// and where the credential handling never leaves Python. The shim's whole job
// is to check four preconditions in order and turn any failure into exactly one
// errors[] line. It never throws; a grading service being down is not a reason
// for the user to lose their week.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyType } from "../merge.mjs";
import { repoRoot } from "../lib/paths.mjs";

export const meta = {
  id: "grades-gradescope",
  kind: "grades",
  label: "Gradescope (optional extra)",
  configPath: "connectors.grades.gradescope",
  requires: { os: [], bin: [], mcp: [], app: ["Python 3, with gradescopeapi installed"] },
  // Tier 3: it depends on an unofficial library scraping a site that can change
  // under it. Expect it to break sooner than the others, and say so out loud
  // rather than pretending otherwise.
  tier: 3,
};

const ADAPTER = ["extras", "gradescope", "gradescope.py"];
const CREDENTIALS = ["extras", "gradescope", "gradescope-credentials.json"];
const TIMEOUT_MS = 120000;

const adapterPath = (root) => join(root, ...ADAPTER);
const credentialsPath = (root) => join(root, ...CREDENTIALS);

/**
 * Walk the four preconditions in order and return the first failure, or null
 * when everything is in place. Split out so healthCheck() and collect() can
 * never disagree about what "ready" means.
 *
 * @returns {{step: string, detail: string, fix: string}|null}
 */
export function precheck(ctx) {
  const root = ctx.root ?? repoRoot();
  const own = ctx.cfg?.connectors?.grades?.gradescope ?? {};

  if (own.enabled !== true) {
    return {
      step: "enabled",
      detail: "the connector is switched off",
      fix: "set connectors.grades.gradescope.enabled to true after reading extras/gradescope/README.md",
    };
  }
  if (!existsSync(adapterPath(root))) {
    return {
      step: "adapter",
      detail: "extras/gradescope/gradescope.py is missing",
      fix: "restore extras/gradescope/gradescope.py, or disable this connector",
    };
  }

  const python = String(own.python || "python");
  try {
    // Existence-checked, not assumed: "python" is absent on plenty of machines
    // and present-but-Python-2 on a few, and both fail in confusing ways later.
    ctx.exec(python, ["--version"], { timeout: 15000 });
  } catch (e) {
    return {
      step: "python",
      detail: `could not run "${python}" (${String(e.message).slice(0, 120)})`,
      fix: `install Python 3 and set connectors.grades.gradescope.python to the command that runs it (currently "${python}")`,
    };
  }

  if (!existsSync(credentialsPath(root))) {
    return {
      step: "credentials",
      detail: "no credentials file; the adapter is dormant",
      fix: `run \`${python} extras/gradescope/gradescope.py --setup\` - see extras/gradescope/README.md`,
    };
  }
  return null;
}

/**
 * The arguments the adapter gets, beyond the mode flag.
 *
 * `termLabel` is the one that matters: without it the adapter keeps any course
 * whose semester and year match the wall clock, which is wrong for anybody on a
 * quarter system, in a summer term, or reading last term's gradebook in
 * January. With it, the user says which term they mean and the same course
 * taken twice stops colliding.
 */
export function adapterArgs(cfg) {
  const own = cfg?.connectors?.grades?.gradescope ?? {};
  const term = typeof own.termLabel === "string" ? own.termLabel.trim() : "";
  return term ? ["--term", term] : [];
}

/** The tracked course whose code matches, or null. Ids matter for the item key. */
function courseOf(ctx, code) {
  const wanted = String(code ?? "").replace(/\s+/g, "").toUpperCase();
  for (const [c, course] of ctx.derived?.courseByCode ?? []) {
    if (String(c).replace(/\s+/g, "").toUpperCase() === wanted) return course;
  }
  return null;
}

export async function collect(ctx) {
  const fail = (why) => ({ items: [], grades: [], errors: [`${meta.id}: ${why}`] });

  const blocked = precheck(ctx);
  if (blocked) return fail(blocked.detail);

  const root = ctx.root ?? repoRoot();
  const python = String(ctx.cfg?.connectors?.grades?.gradescope?.python || "python");

  let raw;
  try {
    raw = ctx.exec(python, [adapterPath(root), "--json", ...adapterArgs(ctx.cfg)], {
      timeout: Math.max(1000, Math.min(TIMEOUT_MS, ctx.deadline - Date.now())),
    });
  } catch (e) {
    // A non-zero exit lands here, and the message is a generic "Command failed".
    // The adapter's actual finding - a canary hit such as "a course went 1 -> 0
    // assignments" - is on stderr, and it is the useful half.
    const detail = (e.stderr ? String(e.stderr).trim() : "") || String(e.message);
    return fail(detail.slice(0, 200));
  }

  let payload;
  try {
    payload = JSON.parse(String(raw));
  } catch (e) {
    return fail(`the adapter did not return JSON (${String(e.message).slice(0, 120)})`);
  }

  const errors = (payload.errors ?? []).map((e) => `${meta.id}: ${String(e).slice(0, 200)}`);
  const items = [];
  const grades = [];

  for (const a of payload.assignments ?? []) {
    const course = courseOf(ctx, a.courseCode);
    const courseId = course?.id ?? 0;
    const courseCode = course?.code ?? String(a.courseCode ?? "");
    if (!courseCode) continue;

    // A grade with a number on it is worth reporting whether or not the
    // assignment has a date.
    if (a.grade !== null && a.grade !== undefined) {
      grades.push({
        courseId,
        title: String(a.name ?? ""),
        display: a.maxGrade ? `${a.grade} / ${a.maxGrade}` : String(a.grade),
        numeric: typeof a.grade === "number" ? a.grade : null,
      });
    }

    // Undated rows are deliberately dropped here: an item with no deadline
    // belongs in mail[], never in items[], and the completion signal an undated
    // row carries reaches the pipeline through the grades[] entry above.
    if (!a.due) continue;
    const due = new Date(a.due);
    if (Number.isNaN(due.getTime())) continue;

    items.push({
      courseId,
      course: courseCode,
      title: String(a.name ?? "").trim(),
      due: due.toISOString(),
      type: classifyType(a.name ?? "", "dropbox"),
      // Straight through, tri-state and untouched. The adapter emits true only
      // on positive evidence, false only when the service explicitly said "No
      // Submission", and null when it did not say. Coercing null to false here
      // would undo the one thing that makes this data safe to act on.
      submitted: a.submitted === true ? true : a.submitted === false ? false : null,
      approx: false,
      sources: ["gradescope"],
      url: a.url ?? null,
    });
  }

  return { items, grades, errors };
}

export async function healthCheck(ctx) {
  const blocked = precheck(ctx);
  if (blocked) return { ok: false, detail: blocked.detail, fix: blocked.fix };

  const root = ctx.root ?? repoRoot();
  const python = String(ctx.cfg?.connectors?.grades?.gradescope?.python || "python");
  try {
    // --check needs no credentials and attempts no login: it confirms the
    // library is importable and that the site's login form still parses.
    const out = ctx.exec(python, [adapterPath(root), "--check"], { timeout: 60000 });
    return { ok: true, detail: String(out).trim().split(/\r?\n/).slice(-1)[0] ?? "adapter responded", fix: null };
  } catch (e) {
    const detail = (e.stderr ? String(e.stderr).trim() : "") || String(e.message);
    return {
      ok: false,
      detail: detail.slice(0, 200),
      fix: "install the dependency with `pip install -r extras/gradescope/requirements.txt`, then re-run - see extras/gradescope/README.md",
    };
  }
}
