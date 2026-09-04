// ===========================================================================
//  setup-config.mjs - answers in, a config object out
// ===========================================================================
//
//  WHY THIS IS PURE
//  ----------------
//  The wizard asks five questions and then rewrites the one file that decides
//  what every later run does. If that transformation lives inside the prompt
//  loop it can only be tested by a human typing, which means in practice it is
//  never tested at all - and the failure mode is somebody's timezone silently
//  not being written.
//
//  So: `buildConfig(example, answers)` takes the parsed `config.example.json`
//  (or an existing `config.json`) and returns a NEW object. It mutates nothing,
//  it touches no disk, and every question the wizard asks has one visible
//  landing place below.
//
//  WHAT IT DELIBERATELY DOES NOT DO
//  --------------------------------
//    * It never invents a course, a difficulty or a timetable entry. Those come
//      from the user's real LMS at Steps 6 and 7 of docs/SETUP.md, and the
//      preflight's "Your courses" check is what keeps that honest.
//    * It writes exactly one secret, the Canvas token, and only because
//      `src/connectors/lms-canvas.mjs` already reads it from `config.json` and
//      the file is git-ignored. No new secret store is invented here.
//    * Every key it is not asked about keeps the example's value.
// ===========================================================================

import { gcalFeed } from "./setup-gcal.mjs";

/** The three answers Step 5 of docs/SETUP.md can end in. */
export const LMS_CHOICES = Object.freeze(["brightspace", "canvas", "none"]);

/** `src/lib/config.mjs` enforces this too; asking early gives a better message. */
export const NAMESPACE_RE = /^[a-z0-9-]{3,24}$/;

/** The two answers docs/SETUP.md Step 3 offers, written the way CLAUDE.md wants them. */
export const USER_STYLES = Object.freeze({
  hands_off: "just do it — never show commands, report results in plain English",
  terminal: "comfortable in a terminal — show the commands",
});

/** What Part 1 of CLAUDE.md already does when Part 2 is blank: show commands. */
export const DEFAULT_USER_STYLE = USER_STYLES.terminal;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Immutable deep set: returns a new object with `dotted` replaced. */
export function setIn(obj, dotted, value) {
  const [head, ...rest] = String(dotted).split(".");
  const base = isPlain(obj) ? obj : {};
  if (rest.length === 0) return { ...base, [head]: value };
  return { ...base, [head]: setIn(base[head], rest.join("."), value) };
}

/**
 * The machine's own IANA zone, or null when the runtime will not say.
 *
 * `UTC` has no slash in it and is still a perfectly good answer - it is what a
 * container, a CI runner and a freshly imaged laptop all report - so the shape
 * test cannot be "contains a slash". It is a zone NAME, though, never an offset:
 * a `GMT+2` would silently plan somebody's week against a fixed offset that does
 * not follow their daylight saving, so anything that is not name-shaped is
 * refused and the wizard asks instead.
 */
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function detectTimezone(intl = Intl) {
  try {
    const tz = intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && TZ_RE.test(tz) && !/^(GMT|UTC)[+-]/.test(tz) ? tz : null;
  } catch {
    return null;
  }
}

/**
 * A namespace suggestion from the folder the clone lives in, because that is
 * the one string the user has already chosen for themselves. Falls back to the
 * shipped default whenever the folder name cannot be squeezed into the 3-24
 * character lowercase shape `src/lib/config.mjs` requires.
 */
export function suggestNamespace(folderName, fallback = "agenda") {
  const slug = String(folderName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return NAMESPACE_RE.test(slug) ? slug : fallback;
}

/**
 * The namespace a re-run must KEEP, or null when there is nothing to keep.
 *
 * `namespace` names all four Drive documents (`<ns>-data`, `<ns>-mirror`,
 * `<ns>-completions`, `<ns>-commands`) and both browser storage keys, and the
 * published page is compiled against those exact titles. Changing it renames
 * every document at once, so the page keeps reading a `<old>-data` nobody
 * writes any more and freezes on the week it was published - silently, because
 * a missing document and an idle pipeline look identical from a phone.
 *
 * So the rule is: whatever is already in `config.json`, if it is valid, wins.
 * `"agenda"` is the shipped default AND a perfectly good answer somebody may
 * have kept on purpose; there is no way to tell those apart, and guessing wrong
 * costs a republish. Only a config that has never been written gets a
 * suggestion.
 */
export function keepNamespace(cfg) {
  const ns = cfg?.namespace;
  return typeof ns === "string" && NAMESPACE_RE.test(ns) ? ns : null;
}

/** `example.edu` and `https://example.edu/` both mean the same Canvas. */
export function normaliseBaseUrl(input) {
  const raw = String(input ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** The bare host, which is what `institution.lmsHost` is a label for. */
export function hostOf(input) {
  const url = normaliseBaseUrl(input);
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Answers -> a new config object.
 *
 * @param {object} example  parsed config.example.json, or an existing config.json
 * @param {{timezone?:string, namespace?:string, lms?:string, schoolName?:string,
 *          lmsHost?:string, canvasToken?:string}} answers
 */
export function buildConfig(example, answers = {}) {
  if (!isPlain(example)) throw new TypeError("buildConfig: the example config must be an object");
  let cfg = { ...example };

  if (answers.namespace) cfg = setIn(cfg, "namespace", answers.namespace);
  if (answers.timezone) cfg = setIn(cfg, "timezone", answers.timezone);
  if (answers.schoolName) cfg = setIn(cfg, "institution.name", answers.schoolName);
  if (answers.lmsHost) cfg = setIn(cfg, "institution.lmsHost", hostOf(answers.lmsHost) ?? answers.lmsHost);

  if (answers.lms) {
    if (!LMS_CHOICES.includes(answers.lms)) {
      throw new TypeError(`buildConfig: lms must be one of ${LMS_CHOICES.join(", ")}`);
    }
    cfg = setIn(cfg, "connectors.lms.brightspace.enabled", answers.lms === "brightspace");
    cfg = setIn(cfg, "connectors.lms.canvas.enabled", answers.lms === "canvas");
    if (answers.lms === "canvas") {
      const base = normaliseBaseUrl(answers.lmsHost);
      if (base) cfg = setIn(cfg, "connectors.lms.canvas.baseUrl", base);
      // The token is the one credential this repo already keeps in config.json.
      if (answers.canvasToken) cfg = setIn(cfg, "connectors.lms.canvas.token", answers.canvasToken);
    }
  }
  return cfg;
}

/**
 * The `**Connectors on:**` line for CLAUDE.md Part 2.
 *
 * Deliberately the same walk `scripts/validate-setup.mjs` does for its
 * "Connectors turned on" note, so the two never disagree about what is on.
 */
export function connectorsOn(cfg) {
  const on = [];
  for (const [kind, providers] of Object.entries(cfg?.connectors ?? {})) {
    if (kind === "materials") {
      if (providers?.enabled === true) on.push("materials");
      continue;
    }
    for (const [name, c] of Object.entries(providers ?? {})) {
      if (c && c.enabled === true) on.push(`${kind}.${name}`);
    }
  }
  // The inbound calendar is NOT under `connectors` - it lives in `calendars`,
  // because it reads the user's meetings IN and `connectors.calendar.*` writes
  // deadlines OUT. Walking only `connectors` is why an enabled inbound calendar
  // never showed up on this line.
  if (cfg?.calendars?.gcal?.enabled === true) on.push(`inbound calendar (${gcalFeed(cfg)})`);
  if (cfg?.drive?.enabled === true) on.push("drive");
  return on;
}

/**
 * Which LMS an already-written config is pointing at, so a re-run can offer the
 * existing answer as its default instead of asking as though nothing happened.
 */
export function currentLms(cfg) {
  if (cfg?.connectors?.lms?.canvas?.enabled === true) return "canvas";
  if (cfg?.connectors?.lms?.brightspace?.enabled === true) return "brightspace";
  return "none";
}

/**
 * The npm package `.mcp.json` and `scripts/reauth.mjs` use for Brightspace.
 * Read from config rather than hardcoded: `docs/connectors/brightspace.md`
 * explains why this repository ships `@latest` on purpose, and a constant here
 * would quietly become a second, wrong source of truth.
 */
export function brightspacePackage(cfg, fallback = "brightspace-mcp-server@latest") {
  const pkg = cfg?.connectors?.lms?.brightspace?.package;
  return typeof pkg === "string" && pkg.trim() ? pkg.trim() : fallback;
}

/**
 * The Windows `npx` wrapper for `.mcp.json`, as a pure transform.
 *
 * `.mcp.json` ships portable - `{"command": "npx", "args": ["-y", "<pkg>"]}` -
 * and on Windows a bare `npx` stdio server FAILS SILENTLY: nothing starts,
 * nothing is raised, and the only symptom is an empty course list.
 * `.claude/agents/onboarding.md` Step 5 rewrites it to
 * `{"command": "cmd", "args": ["/c", "npx", ...]}` and so does the wizard, so
 * the two setup routes converge and `scripts/validate-setup.mjs` stops failing.
 *
 * @returns {{changed: string[], next: object}} which servers were wrapped, and
 *   the new document. `changed` empty means nothing needed doing.
 */
export function wrapNpxForWindows(mcp) {
  const entries = Object.entries(mcp?.mcpServers ?? {});
  const changed = entries.filter(([, s]) => /^npx(\.cmd)?$/i.test(String(s?.command ?? ""))).map(([k]) => k);
  if (!changed.length) return { changed, next: mcp };
  const servers = Object.fromEntries(
    entries.map(([k, s]) => [k, changed.includes(k) ? { ...s, command: "cmd", args: ["/c", "npx", ...(s.args ?? [])] } : s]),
  );
  return { changed, next: { ...mcp, mcpServers: servers } };
}
