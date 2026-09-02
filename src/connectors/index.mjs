// connectors/index.mjs - the registry.
//
// WHY THIS LAYER EXISTS
//
// The original of this pipeline could only run on one machine: it talked to a
// classic Outlook install over COM, which needs Windows and a local process. If
// mail and calendar are hard dependencies then the whole template is
// Windows-only, and every Mac user - and every hosted agent, which cannot run a
// local stdio server at all - is locked out before they start.
//
// So every source is an adapter behind one small contract, every adapter is off
// until someone turns it on, and the pipeline's only hard requirement is that
// SOME learning-management source is enabled. Everything else degrades to an
// empty array, and the page renders correctly with empty arrays.
//
// WHY THE IMPORT LIST IS STATIC
//
// No directory globbing, no dynamic import by string. A static list is
// analysable: a reader can see every source the pipeline can reach by reading
// the import list, a bundler or an auditor can follow it, and there is no path by
// which a stray file in this directory becomes executable code. Adding a
// connector costs one import and one array entry, which is the point.
import * as lmsBrightspace from "./lms-brightspace.mjs";
import * as lmsCanvas from "./lms-canvas.mjs";
import * as mailOutlook from "./mail-outlook.mjs";
import * as calendarOutlook from "./calendar-outlook.mjs";
import * as calendarIcs from "./calendar-ics.mjs";
import * as boardGithub from "./board-github.mjs";
import * as gradesGradescope from "./grades-gradescope.mjs";

export const ALL = Object.freeze([
  lmsBrightspace,
  lmsCanvas,
  mailOutlook,
  calendarOutlook,
  calendarIcs,
  boardGithub,
  gradesGradescope,
]);

/** Read a dotted path such as "connectors.mail.outlook" out of a config. */
export function atPath(obj, dotted) {
  return String(dotted ?? "")
    .split(".")
    .reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/** The default enable rule: the connector's own config block says so. */
export function isEnabled(mod, cfg) {
  if (typeof mod.isEnabled === "function") return mod.isEnabled(cfg) === true;
  return atPath(cfg, mod.meta?.configPath)?.enabled === true;
}

/**
 * Can this machine satisfy the connector's stated prerequisites?
 *
 * Returns `{ ok, reason }` rather than a boolean, because the reason is what
 * the user sees: an enabled connector that cannot run must produce exactly one
 * explanatory line and then get out of the way. It is never an error - a
 * Windows-only connector on a Mac is a configuration the template supports.
 */
export function satisfies(mod, env = {}) {
  const platform = env.platform ?? process.platform;
  const hasBin = env.hasBin ?? (() => true);
  const mcpServers = env.mcpServers ?? null; // null = "unknown, do not judge"
  const req = mod.meta?.requires ?? {};

  const os = Array.isArray(req.os) ? req.os : [];
  if (os.length && !os.includes(platform)) {
    const names = { win32: "Windows", darwin: "macOS", linux: "Linux" };
    return { ok: false, reason: `requires ${os.map((o) => names[o] ?? o).join(" or ")}` };
  }
  for (const bin of req.bin ?? []) {
    if (!hasBin(bin)) return { ok: false, reason: `needs "${bin}" on PATH` };
  }
  if (mcpServers) {
    for (const key of req.mcp ?? []) {
      if (!mcpServers.includes(key)) return { ok: false, reason: `needs the "${key}" MCP server in .mcp.json` };
    }
  }
  return { ok: true, reason: null };
}

const isSink = (mod) => mod.meta?.kind === "calendar-sink";

/** Enabled, non-sink connectors, in registry order. */
export function sources(cfg, env = {}) {
  return ALL.filter((m) => !isSink(m) && isEnabled(m, cfg)).filter((m) => !env.strict || satisfies(m, env).ok);
}

/** Enabled sinks (things that write the outside world), in registry order. */
export function sinks(cfg, env = {}) {
  return ALL.filter((m) => isSink(m) && isEnabled(m, cfg)).filter((m) => !env.strict || satisfies(m, env).ok);
}

/** True when at least one `kind: "lms"` source is enabled. */
export function hasLmsSource(cfg) {
  return ALL.some((m) => m.meta?.kind === "lms" && isEnabled(m, cfg));
}

// ---------------------------------------------------------------------------
// Emission validation
// ---------------------------------------------------------------------------
//
// A connector is usually written by someone adding their own school's system,
// with a recorded sample response and an afternoon. The most valuable thing
// this registry can do for them is to reject a malformed emission loudly, at
// the boundary, naming the field - rather than letting a bad shape travel into
// the merge chain and surface a week later as a card with no date.
//
// THE TRI-STATE RULE IS THE IMPORTANT ONE. `submitted: false` means a source
// EXPLICITLY said "not submitted". If the connector does not know, it emits
// null. A connector that emits false on absence makes the agenda accuse its
// user of not doing work they have already done.

const ITEM_TYPES = new Set(["exam", "project", "lab", "quiz", "homework", "email", "task", "other"]);
const MAIL_TAGS = new Set(["research", "course", "action", "info"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class EmissionError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "EmissionError";
    this.field = field;
  }
}

const fail = (field, msg) => {
  throw new EmissionError(`${field}: ${msg}`, field);
};

function checkItem(it, where) {
  if (!it || typeof it !== "object") fail(where, "is not an object");
  if (typeof it.title !== "string" || !it.title.trim()) fail(`${where}.title`, "is required and must be a non-empty string");
  if (typeof it.course !== "string" || !it.course.trim()) fail(`${where}.course`, "is required");
  if (typeof it.due !== "string" || !it.due) fail(`${where}.due`, "is required - an undated thing belongs in mail[], not items[]");
  if (!ISO_RE.test(it.due) || Number.isNaN(Date.parse(it.due))) fail(`${where}.due`, `must be a full ISO instant (got ${JSON.stringify(it.due)})`);
  if (!ITEM_TYPES.has(it.type)) fail(`${where}.type`, `must be one of ${[...ITEM_TYPES].join(", ")} (got ${JSON.stringify(it.type)})`);
  if (!(it.submitted === true || it.submitted === false || it.submitted === null || it.submitted === undefined)) {
    fail(`${where}.submitted`, `must be true, false or null - null means "unknown" and is never a guess (got ${JSON.stringify(it.submitted)})`);
  }
  if (it.sources !== undefined && !Array.isArray(it.sources)) fail(`${where}.sources`, "must be an array of source names");
}

function checkMail(m, where) {
  if (!m || typeof m !== "object") fail(where, "is not an object");
  if (typeof m.subj !== "string" || !m.subj.trim()) fail(`${where}.subj`, "is required");
  if (typeof m.recv !== "string" || Number.isNaN(Date.parse(m.recv))) fail(`${where}.recv`, "must be an ISO instant");
  if (m.tag !== undefined && !MAIL_TAGS.has(m.tag)) fail(`${where}.tag`, `must be one of ${[...MAIL_TAGS].join(", ")}`);
}

function checkAnnouncement(a, where) {
  if (!a || typeof a !== "object") fail(where, "is not an object");
  if (typeof a.course !== "string" || !a.course.trim()) fail(`${where}.course`, "is required");
  if (typeof a.title !== "string") fail(`${where}.title`, "is required");
  if (typeof a.posted !== "string" || Number.isNaN(Date.parse(a.posted))) fail(`${where}.posted`, "must be an ISO instant");
}

function checkBoard(b, where) {
  if (!b || typeof b !== "object") fail(where, "is not an object");
  if (typeof b.repo !== "string" || !b.repo) fail(`${where}.repo`, "is required");
  if (typeof b.t !== "string" || !b.t.trim()) fail(`${where}.t`, "is required (the entry's title)");
  if (b.kind !== "issue" && b.kind !== "pr") fail(`${where}.kind`, 'must be "issue" or "pr"');
}

function checkGrade(g, where) {
  if (!g || typeof g !== "object") fail(where, "is not an object");
  if (typeof g.title !== "string" || !g.title.trim()) fail(`${where}.title`, "is required");
  if (typeof g.display !== "string") fail(`${where}.display`, "is required (what the gradebook shows)");
}

/**
 * Validate one connector's whole emission. Throws EmissionError naming the
 * exact field path; returns the emission (normalised to all six arrays) when
 * it is well formed.
 */
export function validateEmission(kind, out) {
  const id = kind || "connector";
  if (!out || typeof out !== "object" || Array.isArray(out)) fail(id, "collect() must return an object");
  const arrays = ["items", "mail", "announcements", "board", "grades", "errors"];
  for (const k of arrays) {
    if (out[k] !== undefined && !Array.isArray(out[k])) fail(`${id}.${k}`, "must be an array when present");
  }
  (out.items ?? []).forEach((it, i) => checkItem(it, `${id}.items[${i}]`));
  (out.mail ?? []).forEach((m, i) => checkMail(m, `${id}.mail[${i}]`));
  (out.announcements ?? []).forEach((a, i) => checkAnnouncement(a, `${id}.announcements[${i}]`));
  (out.board ?? []).forEach((b, i) => checkBoard(b, `${id}.board[${i}]`));
  (out.grades ?? []).forEach((g, i) => checkGrade(g, `${id}.grades[${i}]`));
  (out.errors ?? []).forEach((e, i) => {
    if (typeof e !== "string") fail(`${id}.errors[${i}]`, "must be a string");
  });
  return {
    items: out.items ?? [],
    mail: out.mail ?? [],
    announcements: out.announcements ?? [],
    board: out.board ?? [],
    grades: out.grades ?? [],
    errors: out.errors ?? [],
  };
}

export const EMPTY_EMISSION = Object.freeze({
  items: [],
  mail: [],
  announcements: [],
  board: [],
  grades: [],
  errors: [],
});

/**
 * An expired session, told apart from every other failure.
 *
 * This is the ONE failure a connector is allowed to take the run down with, and
 * the reason is arithmetic: with dead credentials every remaining sweep fails
 * too, so swallowing it turns one actionable error into a dozen confusing ones
 * and buries the single thing the user has to do. `scrape.mjs` turns it into
 * exit 2, which is what makes `scripts/reauth.mjs` reachable at all.
 */
export const isAuthFailure = (e) =>
  e?.status === 401 || e?.status === 403 || /\b401\b|\b403\b|auth|session|expired|unauthorized/i.test(String(e?.message ?? ""));

/**
 * Run one connector's `collect()` defensively.
 *
 * A connector that throws contributes one `errors[]` line and nothing else. It
 * never fails the run: a GitHub board that is briefly unreachable must not cost
 * the user the agenda they actually need this morning. `scrape.mjs` decides
 * separately whether the run had an LMS source at all - that is the only hard
 * requirement, and it is checked before any connector runs.
 *
 * The single exception is an authentication failure, which is re-thrown for
 * `scrape.mjs` to map onto exit 2. See `isAuthFailure` above.
 */
export async function runSource(mod, ctx, env = {}) {
  const id = mod.meta?.id ?? "connector";
  const ok = satisfies(mod, env);
  if (!ok.ok) return { ...EMPTY_EMISSION, errors: [`${id}: skipped (${ok.reason})`] };
  try {
    const raw = await mod.collect(ctx);
    return validateEmission(id, raw);
  } catch (e) {
    if (isAuthFailure(e) && !(e instanceof EmissionError)) throw e;
    return { ...EMPTY_EMISSION, errors: [`${id}: ${String(e?.message ?? e).slice(0, 200)}`] };
  }
}
