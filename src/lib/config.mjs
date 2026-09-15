// config.mjs - one loader, one set of defaults, one place that derives a name.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
//
// Every user-visible string and every wire identifier in this repo comes from
// `config.namespace`. The Drive document titles, the browser storage keys, the
// calendar category, the scheduled-task names and the log prefix are all
// derived from it, here, once. Nothing anywhere else may rebuild one of those
// names by hand - the moment two modules spell a Doc title differently, a run
// writes a document nobody reads and a mark the user made is lost in a Doc that
// is never consumed.
//
// [NOT SET]
//
// A fresh checkout ships a config full of the literal string `[NOT SET]`. That
// is not a value; it is the absence of one, and this file treats it as absent
// everywhere. A module that genuinely needs a key calls `assertConfigured` and
// dies with the one sentence that tells a new user what to do about it. A
// module that only needs a key when an optional feature is on must never ask -
// an unset key belonging to a disabled feature is a normal, healthy state and
// must never block a run.
//
// COMMENTS IN JSON
//
// `config.json` is strict JSON, so it has no comment syntax. Users still want
// to leave themselves notes, so any key beginning with `//` or `_` is ignored
// at every level. `docs/CONFIG.md` is the annotated copy.
import { existsSync, readFileSync } from "node:fs";
import { configPath } from "./paths.mjs";

export const NOT_SET = "[NOT SET]";

export class ConfigError extends Error {
  constructor(message, key = null) {
    super(message);
    this.name = "ConfigError";
    this.key = key;
  }
}

/**
 * Every default, in the same order and with the same key names as
 * `config.example.json`. A key whose example value is `[NOT SET]` is `null`
 * here, because that is what "not set" means once it is loaded.
 * `test/config.test.mjs` asserts the two files agree key for key.
 */
export const DEFAULTS = Object.freeze({
  namespace: "agenda",
  title: "Weekly Agenda",
  timezone: null,
  wakeTime: "10:00",

  institution: { name: null, lmsHost: null, mailDomains: [] },

  courses: [],
  difficulty: {},
  schedule: {},

  studyMinutes: {
    weekday: 240,
    weekend: 300,
    weekdayWindow: ["10:30", "23:00"],
    weekendWindow: ["10:30", "22:00"],
  },
  leadTimeDays: { exam: 7, project: 5, lab: 5, homework: 3, quiz: 2, default: 3 },
  focus: {
    tuning: {
      maxBlocksPerDay: 3,
      blockStepMinutes: 15,
      breakMinutes: 15,
      minBlockMinutes: 30,
      maxBlockMinutes: 150,
      dayStart: "08:00",
      dayEnd: "23:00",
    },
  },
  scrapeWindowDays: 60,
  announcementLookbackDays: 14,

  standardsPlan: { enabled: false, course: null, label: "Standards" },

  // INBOUND calendars: the user's own meetings, read into payload.meetings[].
  // Off by default and opt-in, because it costs an authorized calendar
  // connector in the user's own Claude account and most agendas do not need
  // one. `connectors.calendar.*` is the other direction - a SINK that writes
  // deadlines out - and the two never share a config block.
  //
  // `skipUidSuffix` is the loop guard: the ICS sink writes events whose UID
  // ends `@<namespace>.agenda.local`, so an agenda that also subscribes to its
  // own file would otherwise re-import every deadline it just published. null
  // means "derive it from the namespace", which is right for everyone who has
  // not renamed anything.
  calendars: {
    gcal: {
      enabled: false,
      calendarId: "primary",
      feed: "calendar",
      label: "Calendar",
      maxEvents: 200,
      skipUidSuffix: null,
      skipDescriptionMarker: "Auto-created by the agenda.",
    },
  },

  sideProject: {
    enabled: false,
    label: "Side Project",
    provider: "github",
    org: null,
    repos: [],
    minDailyMinutes: 60,
    maxDailyMinutes: 180,
  },

  connectors: {
    lms: {
      brightspace: { enabled: true, mcpServer: "brightspace", package: "brightspace-mcp-server@latest" },
      // Canvas talks REST directly - no MCP server, nothing to install. The
      // token is a personal access token from Canvas's own account settings and
      // it lives ONLY in your git-ignored config.json. Both LMS connectors may
      // be on at once; the merge chain dedupes across sources.
      canvas: { enabled: false, baseUrl: null, token: null, courseFilter: [] },
    },
    mail: {
      outlook: {
        enabled: false,
        sentItemsScan: true,
        windowDays: 14,
        noiseDomains: [],
        noiseLocalParts: [],
        keepDomains: [],
        dropAddrs: [],
      },
    },
    calendar: {
      outlook: { enabled: false, category: "Agenda", horizonDays: 21, maxEvents: 60 },
      // The cross-platform sink: one RFC 5545 file you import or subscribe to
      // from Google Calendar, Apple Calendar or anything else.
      ics: { enabled: false, path: "data/agenda.ics" },
    },
    board: { github: { enabled: false, budgetMs: 60000 } },
    grades: { gradescope: { enabled: false, python: "python", termLabel: null } },
    materials: {
      enabled: false,
      root: null,
      categories: ["Syllabus", "Lecture Notes", "Example Problems", "Homework", "Books", "Exams", "Other"],
      maxFileMB: 300,
    },
  },

  // `connectorName` is what the PAGE reads through (the user's own Drive
  // connector, named here only so the page can say it in an error). The
  // PIPELINE never uses a connector: `src/drive-rclone.mjs` moves every byte
  // over the `rclone` CLI, and those two keys name the remote it talks to and
  // the binary it runs. `rcloneExe` unset means "find it" - PATH first, then
  // the usual per-platform install location.
  drive: {
    enabled: true,
    connectorName: "Google Drive",
    rcloneRemote: "agenda",
    rcloneExe: null,
    maxEmitChars: 12000,
    maxMirrorChars: 20000,
    mirror: true,
  },

  artifact: { url: null },

  notifications: {
    calendar: false,
    emailDigest: "off",
    digestTo: null,
    push: { newAssignments: true, dueSoonUnsubmittedHours: 48 },
  },

  // ONE run a day. `dailyAt` is the only boundary in the system: the scheduled
  // task fires there, and `src/stale-check.mjs` calls the day missed if nothing
  // has run by `dailyAt + graceMinutes`. The two quiet keys bracket the hours
  // that watchdog may rescue in - never before `quietUntil`, never from
  // `quietFrom` - because a rescue sends mail, may push, and wakes the fans.
  scheduler: {
    taskPrefix: "Agenda",
    dailyAt: "10:30",
    quietUntil: "10:23",
    quietFrom: "23:00",
    graceMinutes: 20,
    debounceMinutes: 25,
    maxRescuesPerLane: 2,
  },

  // The model window inside the daily run (`scripts/run-daily.mjs`). Scripts do
  // every mechanical step; the model reads one work order, contributes judgment
  // and verifies the report. `maxTurns` and `maxBudgetUsd` are HARD CAPS, not
  // targets - a run that hits either is a run to look at, not one to widen.
  // `enabled: false` turns the window off entirely and the page still updates,
  // which is also what happens when `claude` is simply not installed.
  llm: {
    enabled: true,
    model: "claude-sonnet-5",
    effort: "medium",
    maxTurns: 20,
    maxBudgetUsd: 1,
    timeoutMinutes: 45,
  },

  // The hourly "can we still log in?" lane (src/auth-retry.mjs). `sessionFiles`
  // is also its opt-out: a connector that exposes no readable session file gives
  // that lane no way to tell "expired" from "never logged in", so an EMPTY list
  // means "this lane does not apply here" rather than "fire forever".
  authRetry: {
    enabled: true,
    sessionFiles: [".brightspace-mcp/session.json", ".d2l-session/session.json"],
    minIntervalMinutes: 50,
    pushHook: null,
  },
});

/** The top-level keys this version knows about. Anything else warns, once. */
const KNOWN_TOP_LEVEL = new Set(Object.keys(DEFAULTS));

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNote = (k) => k.startsWith("//") || k.startsWith("_");

/** Strip note keys and turn every `[NOT SET]` into null, at every depth. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter((v) => v !== NOT_SET);
  if (isPlain(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isNote(k)) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value === NOT_SET ? null : value;
}

/**
 * Merge user values over defaults. Objects merge key by key; arrays and
 * scalars replace wholesale (a user who lists two courses means two, not two
 * plus the examples), and an explicit null is "unset", which loses to a
 * default only where the default itself is not null.
 */
function mergeDefaults(base, over) {
  if (!isPlain(base)) return over === undefined ? base : over;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over ?? {})])) {
    const b = base[k];
    const o = over?.[k];
    if (o === undefined) out[k] = b;
    else if (isPlain(b) && isPlain(o)) out[k] = mergeDefaults(b, o);
    else if (o === null && b !== null && !isPlain(b)) out[k] = b === null ? null : b;
    else out[k] = o;
  }
  return out;
}

const NS_RE = /^[a-z0-9-]{3,24}$/;

// ---------------------------------------------------------------------------
// Feed ids
//
// A feed id prefixes every key an inbound calendar mints:
// `<feed>|<uid>|<start>`. That is a THIRD key space (docs/PROTOCOL.md 4a), and
// the only thing keeping it apart from a study session's `fb|<day>|<bucket>` is
// which prefix a key starts with - `isSessKey()` is a three-character test and
// nothing downstream re-checks. The charset alone does not do it: "fb" is two
// legal characters. So the id is refused here, once, and both the config and
// the ingest CLI ask this function rather than each keeping a regex.
// ---------------------------------------------------------------------------

/** The charset a feed id may use. */
export const FEED_ID_RE = /^[a-z0-9-]{1,24}$/;
/** Prefixes that already name a key space in this repo, so no feed may take one. */
export const RESERVED_FEED_IDS = Object.freeze({ fb: "study sessions (fb|<day>|<bucket>)" });
/** The longest feed label the page has room for. */
export const MAX_FEED_LABEL = 24;
/** The most events one inbound-calendar document may be asked to hold. */
export const MAX_FEED_EVENTS = 5000;

/**
 * Why this feed id is unusable, or `null` when it is fine. One sentence, safe
 * to print. PURE.
 */
export function feedIdError(value) {
  if (typeof value !== "string" || !FEED_ID_RE.test(value)) {
    return `expected [a-z0-9-]{1,24}, got ${JSON.stringify(value)}`;
  }
  const taken = RESERVED_FEED_IDS[value];
  return taken ? `${JSON.stringify(value)} is a reserved key-space prefix - it names ${taken}` : null;
}

/**
 * Resolve, read, validate and default a configuration.
 *
 * Resolution order: an explicit path argument, then `--config <path>` on the
 * command line, then `$AGENDA_CONFIG`, then `<repoRoot>/config.json`.
 * A missing file is not an error - it yields the pure defaults, which is
 * exactly what a first run before onboarding should see.
 *
 * @param {string|null} [pathOrNull]
 * @param {{argv?: string[], warn?: (msg: string) => void}} [opts]
 */
export function loadConfig(pathOrNull = null, opts = {}) {
  const warn = opts.warn ?? ((m) => console.warn(m));
  const file = pathOrNull ?? configPath(opts.argv ?? process.argv.slice(2));

  let raw = {};
  if (existsSync(file)) {
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch (e) {
      throw new ConfigError(`config: could not read ${file} (${e.message})`);
    }
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ConfigError(`config: ${file} is not valid JSON (${e.message})`);
    }
    if (!isPlain(raw)) throw new ConfigError(`config: ${file} must contain a JSON object`);
  }

  for (const k of Object.keys(raw)) {
    if (!isNote(k) && !KNOWN_TOP_LEVEL.has(k)) {
      warn(`config: ignoring unknown top-level key "${k}" (see docs/CONFIG.md)`);
    }
  }

  const cfg = mergeDefaults(DEFAULTS, clean(raw));
  cfg.sourcePath = file;
  validate(cfg, warn);
  return cfg;
}

/**
 * Every rule that makes a loaded config USABLE, in one place. Each one throws a
 * `ConfigError` naming the key, because the alternative is a value that loads
 * silently and then behaves as though it had been left out - `enabled: "true"`
 * is the shape of that bug, and it reads as ON to anything but a `=== true`.
 *
 * Unknown keys WARN rather than throw, matching what the top level already does
 * with them: a key this version has not heard of is usually a newer config or a
 * typo, and neither is worth refusing to draw somebody's week over.
 */
function validate(cfg, warn) {
  if (typeof cfg.namespace !== "string" || !NS_RE.test(cfg.namespace)) {
    throw new ConfigError(
      `config: "namespace" must be 3-24 characters of a-z, 0-9 or "-" (got ${JSON.stringify(cfg.namespace)})`,
      "namespace",
    );
  }
  validateCalendars(cfg, warn);
  validateScheduler(cfg, warn);
  validateLlm(cfg, warn);
  validateNotifications(cfg, warn);
}

const typeError = (key, must, got) =>
  new ConfigError(`config: "${key}" ${must} (got ${JSON.stringify(got)}). See docs/CONFIG.md`, key);

/** Warn about keys this version does not know, the way the top level does. */
function warnUnknown(warn, prefix, value, known) {
  for (const k of Object.keys(value)) {
    if (!isNote(k) && !known.has(k)) warn(`config: ignoring unknown key "${prefix}.${k}" (see docs/CONFIG.md)`);
  }
}

/**
 * `calendars.gcal` - the INBOUND calendar. Every value here reaches a different
 * subsystem: `enabled` is the one switch `render.mjs` and `gcal-ingest.mjs`
 * read, `feed` becomes the prefix of every meeting key on the wire, and
 * `maxEvents` bounds a file on disk.
 */
function validateCalendars(cfg, warn) {
  if (!isPlain(cfg.calendars)) throw typeError("calendars", "must be an object", cfg.calendars);
  warnUnknown(warn, "calendars", cfg.calendars, new Set(Object.keys(DEFAULTS.calendars)));

  const gcal = cfg.calendars.gcal;
  if (!isPlain(gcal)) throw typeError("calendars.gcal", "must be an object", gcal);
  warnUnknown(warn, "calendars.gcal", gcal, new Set(Object.keys(DEFAULTS.calendars.gcal)));

  if (typeof gcal.enabled !== "boolean") {
    throw typeError("calendars.gcal.enabled", "must be true or false, not a string or a number", gcal.enabled);
  }
  const feedWhy = feedIdError(gcal.feed);
  if (feedWhy) throw new ConfigError(`config: "calendars.gcal.feed" ${feedWhy}. See docs/CONFIG.md`, "calendars.gcal.feed");

  if (gcal.calendarId !== null && typeof gcal.calendarId !== "string") {
    throw typeError("calendars.gcal.calendarId", "must be a string", gcal.calendarId);
  }
  if (typeof gcal.label !== "string" || !gcal.label.trim() || gcal.label.length > MAX_FEED_LABEL) {
    throw typeError("calendars.gcal.label", `must be 1-${MAX_FEED_LABEL} characters of text`, gcal.label);
  }
  if (!Number.isInteger(gcal.maxEvents) || gcal.maxEvents < 1 || gcal.maxEvents > MAX_FEED_EVENTS) {
    throw typeError("calendars.gcal.maxEvents", `must be a whole number from 1 to ${MAX_FEED_EVENTS}`, gcal.maxEvents);
  }
  // Both guards accept "" - that is how a user switches one off - and null,
  // which means "derive the default".
  for (const key of ["skipUidSuffix", "skipDescriptionMarker"]) {
    if (gcal[key] !== null && typeof gcal[key] !== "string") {
      throw typeError(`calendars.gcal.${key}`, "must be a string or null", gcal[key]);
    }
  }
}

// ---------------------------------------------------------------------------
// scheduler, llm, notifications
// ---------------------------------------------------------------------------

/**
 * The 1.x scheduler keys, retired in 2.0.0 when the two heavy runs and the
 * 2-hourly sync lane became one daily run.
 *
 * A config that still carries them is ACCEPTED. People upgrade by pulling, not
 * by rewriting a file they have never opened, and refusing to draw somebody's
 * week over a key nothing reads any more would be the worst of both worlds. So
 * they are ignored, and the user is told ONCE - in one sentence, naming the one
 * key that replaced all four.
 */
export const LEGACY_SCHEDULER_KEYS = Object.freeze(["morningAt", "eveningAt", "syncWindow", "syncGapHours"]);

/** A local wall-clock time, 00:00 to 23:59. */
const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** "10:30" -> 630. Only ever called on a string HHMM_RE has accepted. */
const hhmmToMin = (s) => {
  const [h, m] = String(s).split(":");
  return Number(h) * 60 + Number(m);
};

function validateScheduler(cfg, warn) {
  const s = cfg.scheduler;
  if (!isPlain(s)) throw typeError("scheduler", "must be an object", s);

  const legacy = LEGACY_SCHEDULER_KEYS.filter((k) => k in s);
  if (legacy.length) {
    const dailyAt = typeof s.dailyAt === "string" ? s.dailyAt : DEFAULTS.scheduler.dailyAt;
    warn(
      `config: "scheduler" still has ${legacy.join(", ")} from 1.x. ` +
        `2.0.0 runs once a day, so the only boundary read is "scheduler.dailyAt" (${dailyAt}). ` +
        "Those keys are ignored; delete them when convenient. See docs/CONFIG.md",
    );
  }

  // The three clocks. `stale-check.mjs` and `setup-schedule.mjs` both fall back
  // silently on a value they cannot parse, but `install-tasks.cmd` passes
  // `dailyAt` STRAIGHT to `New-ScheduledTaskTrigger -Daily -At` - so "10.30"
  // registers a task at one time and a watchdog that thinks the boundary is
  // somewhere else entirely. One typo, two disagreeing clocks, no error. Refuse
  // it here, once, where the key can be named.
  for (const key of ["dailyAt", "quietUntil", "quietFrom"]) {
    if (typeof s[key] !== "string" || !HHMM_RE.test(s[key].trim())) {
      throw typeError(`scheduler.${key}`, 'must be a local time as "HH:MM", 00:00 to 23:59', s[key]);
    }
  }

  // ...and the one arrangement of legal values that switches the watchdog off.
  // `decideStale` calls the day missed at `dailyAt + graceMinutes` and refuses
  // to fire outside [quietUntil, quietFrom). Put the boundary late enough - say
  // 22:50 against the shipped 23:00 ceiling - and the earliest "late" moment is
  // already inside quiet hours, so a missed run can never be rescued. That is a
  // WARNING and not an error: the run itself still happens at `dailyAt`, and
  // refusing to load would cost the user the whole agenda to save the watchdog.
  const grace = Number.isFinite(Number(s.graceMinutes)) ? Number(s.graceMinutes) : DEFAULTS.scheduler.graceMinutes;
  const fireAt = hhmmToMin(s.dailyAt.trim()) + grace;
  const from = hhmmToMin(s.quietUntil.trim());
  const to = hhmmToMin(s.quietFrom.trim());
  if (!(fireAt >= from && fireAt < to)) {
    warn(
      `config: "scheduler.dailyAt" (${s.dailyAt}) plus graceMinutes (${grace}) falls outside ` +
        `"scheduler.quietUntil" (${s.quietUntil}) to "scheduler.quietFrom" (${s.quietFrom}), ` +
        "so the stale-run watchdog can never rescue a missed run. The run itself is unaffected. " +
        "See docs/CONFIG.md",
    );
  }
}

/** The three effort levels `claude -p --effort` accepts. */
export const LLM_EFFORTS = Object.freeze(["low", "medium", "high"]);

/**
 * `llm` - the model window's whole budget.
 *
 * Every value here becomes a command-line argument in `scripts/run-daily.mjs`,
 * and two of them are the only thing standing between a wedged run and a
 * fortnight of usage. A string where a number belongs would be passed straight
 * through to a flag that silently accepts anything, so it is refused here.
 */
function validateLlm(cfg, warn) {
  const llm = cfg.llm;
  if (!isPlain(llm)) throw typeError("llm", "must be an object", llm);
  warnUnknown(warn, "llm", llm, new Set(Object.keys(DEFAULTS.llm)));

  if (typeof llm.enabled !== "boolean") {
    throw typeError("llm.enabled", "must be true or false, not a string or a number", llm.enabled);
  }
  if (typeof llm.model !== "string" || !llm.model.trim()) {
    throw typeError("llm.model", "must be a model name, as text", llm.model);
  }
  if (!LLM_EFFORTS.includes(llm.effort)) {
    throw typeError("llm.effort", `must be one of ${LLM_EFFORTS.join(", ")}`, llm.effort);
  }
  for (const [key, min, max] of [["maxTurns", 1, 200], ["timeoutMinutes", 1, 600]]) {
    if (!Number.isInteger(llm[key]) || llm[key] < min || llm[key] > max) {
      throw typeError(`llm.${key}`, `must be a whole number from ${min} to ${max}`, llm[key]);
    }
  }
  if (typeof llm.maxBudgetUsd !== "number" || !Number.isFinite(llm.maxBudgetUsd) || llm.maxBudgetUsd <= 0) {
    throw typeError("llm.maxBudgetUsd", "must be a positive number of dollars", llm.maxBudgetUsd);
  }
}

/** The only digest sink 2.0.0 has. `"off"` is the shipped answer. */
export const EMAIL_DIGEST_SINKS = Object.freeze(["off", "outlook"]);

/**
 * Every 1.x spelling of `notifications.emailDigest`, and what it means now.
 *
 * 1.x asked WHEN to send ("morning-only" / "every-run"), because there were two
 * heavy runs a day to choose between. 2.0.0 runs once, so the only question left
 * is WHERE it goes - and the answer for all of these is the one sink there is.
 * `true` and `false` are here for the same reason: they were the shape of the
 * key before it named anything, and a boolean would otherwise read as ON to
 * every truthiness test and as a sink to none.
 *
 * These are MAPPED, not refused. An upgrader who had the digest on pulls 2.0.0,
 * and a ConfigError here takes down the launcher, the pipeline AND both
 * watchdogs on the same line - the agenda goes dark with nothing anywhere to say
 * why, which is the exact failure `docs/design-notes/watchdogs.md` exists to
 * prevent. Same decision, same reasoning, as LEGACY_SCHEDULER_KEYS.
 */
export const LEGACY_EMAIL_DIGEST = Object.freeze(
  new Map([
    ["morning-only", "outlook"],
    ["every-run", "outlook"],
    [true, "outlook"],
    [false, "off"],
  ]),
);

/**
 * `notifications.emailDigest` names a SINK, not a switch. The daily run's digest
 * step matches it against one string, so there is exactly one string to match -
 * and every value that used to mean something is normalised to one of the two
 * before anything downstream sees it.
 */
function validateNotifications(cfg, warn) {
  const n = cfg.notifications;
  if (!isPlain(n)) throw typeError("notifications", "must be an object", n);

  if (LEGACY_EMAIL_DIGEST.has(n.emailDigest)) {
    const was = n.emailDigest;
    // The one normalisation this loader performs. It is deliberate: the value
    // travels to `send-digest.mjs` and to the pipeline's digest gate, and
    // leaving the old spelling in place would push the translation into both.
    n.emailDigest = LEGACY_EMAIL_DIGEST.get(was);
    warn(
      `config: "notifications.emailDigest" is ${JSON.stringify(was)}, which is a 1.x value. ` +
        `2.0.0 names a sink rather than a schedule, so it is being read as ${JSON.stringify(n.emailDigest)}. ` +
        `The values now are ${EMAIL_DIGEST_SINKS.map((s) => `"${s}"`).join(" and ")}. See docs/CONFIG.md`,
    );
    return;
  }

  if (!EMAIL_DIGEST_SINKS.includes(n.emailDigest)) {
    throw typeError(
      "notifications.emailDigest",
      `must be ${EMAIL_DIGEST_SINKS.map((s) => `"${s}"`).join(" or ")} - "outlook" is the only digest sink in 2.0.0`,
      n.emailDigest,
    );
  }
}

/**
 * Every derived name, in one pure function. Nothing else in the repo may
 * rebuild one of these strings.
 *
 * @returns {{docTitles: object, storageKeys: object, taskNames: object,
 *            skipCodes: Set<string>, skipIds: Set<number>, sideBucket: string,
 *            category: string, logPrefix: string, courseByCode: Map,
 *            courseById: Map}}
 */
export function derive(cfg) {
  const ns = cfg?.namespace ?? DEFAULTS.namespace;
  const prefix = cfg?.scheduler?.taskPrefix ?? DEFAULTS.scheduler.taskPrefix;
  const courses = Array.isArray(cfg?.courses) ? cfg.courses.filter(isPlain) : [];
  const skipped = courses.filter((c) => c.skip === true);

  return {
    ns,
    docTitles: {
      data: `${ns}-data`,
      mirror: `${ns}-mirror`,
      completions: `${ns}-completions`,
      commands: `${ns}-commands`,
    },
    storageKeys: { marks: `${ns}.marks.v1`, blocks: `${ns}.blocks.v1` },
    // Three tasks in 2.0.0. `<prefix> Morning`, `<prefix> Evening` and
    // `<prefix> Sync` are retired; `scripts/install-tasks.cmd /remove-legacy`
    // is the only thing that deletes them, and only when asked.
    taskNames: {
      daily: `${prefix} Daily`,
      staleCheck: `${prefix} StaleCheck`,
      authRetry: `${prefix} AuthRetry`,
    },
    skipCodes: new Set(skipped.map((c) => String(c.code ?? "")).filter(Boolean)),
    skipIds: new Set(skipped.map((c) => Number(c.id)).filter((n) => Number.isFinite(n))),
    sideBucket: cfg?.sideProject?.label || DEFAULTS.sideProject.label,
    category: cfg?.connectors?.calendar?.outlook?.category || DEFAULTS.connectors.calendar.outlook.category,
    logPrefix: `[${ns}]`,
    courseByCode: new Map(courses.filter((c) => c.code).map((c) => [String(c.code), c])),
    courseById: new Map(courses.filter((c) => c.id != null).map((c) => [Number(c.id), c])),
  };
}

const at = (cfg, dotted) => dotted.split(".").reduce((o, k) => (isPlain(o) || Array.isArray(o) ? o[k] : undefined), cfg);

/**
 * Refuse to run without a key the caller genuinely needs, and say what to do.
 * The message is deliberately identical everywhere - it is the one string a
 * confused new user will paste into a search box.
 */
export function assertConfigured(cfg, keys) {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const v = at(cfg, key);
    const missing = v === undefined || v === null || v === NOT_SET || (typeof v === "string" && !v.trim());
    if (!missing) continue;
    throw new ConfigError(
      `config: "${key}" is not set yet.\n` +
        `  Fix: open this folder in Claude Code and say "hey" - the setup agent fills it in.\n` +
        `  Or edit config.json directly; docs/CONFIG.md explains every key.`,
      key,
    );
  }
  return cfg;
}

/**
 * Load a config and refuse to continue without the keys the caller genuinely
 * needs - printing the one-sentence fix instead of a Node stack trace.
 *
 * WHY THIS EXISTS. `assertConfigured` throws, and a throw at the top of a
 * script reaches the user as ten lines of stack with the useful sentence buried
 * in the middle. To somebody who has never opened a terminal that reads as "I
 * broke it", and the actual instruction - say "hey" and let setup fill this in -
 * is the one line they do not see. Every entry point that needs a configured
 * repo goes through here instead.
 *
 * `onError` is injectable so a test can assert the message without exiting the
 * test runner.
 */
export function loadConfigured(keys, opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const onError =
    opts.onError ??
    ((message) => {
      console.error(message);
      process.exit(1);
    });
  try {
    const cfg = loadConfig(opts.path ?? null, { argv, warn: opts.warn });
    return assertConfigured(cfg, keys ?? []);
  } catch (e) {
    if (e instanceof ConfigError) return onError(e.message, e);
    throw e;
  }
}

/**
 * The object `render.mjs` substitutes into the page for `__PAGE_CONFIG__`.
 *
 * The page is a static artifact: once published it can never read config.json
 * again, so every identity string it needs is baked in here at build time.
 * The shape is a contract shared with `web/page-template.html` - add a field
 * before the page reads it, never the other way round.
 */
export function pageConfig(cfg) {
  const d = derive(cfg);
  const plan = cfg?.standardsPlan ?? {};
  return {
    ns: d.ns,
    timezone: cfg?.timezone ?? null,
    title: cfg?.title ?? DEFAULTS.title,
    leadTimeDays: { ...DEFAULTS.leadTimeDays, ...(cfg?.leadTimeDays ?? {}) },
    docTitles: {
      data: d.docTitles.data,
      completions: d.docTitles.completions,
      commands: d.docTitles.commands,
    },
    storageKeys: { marks: d.storageKeys.marks, blocks: d.storageKeys.blocks },
    buckets: { side: d.sideBucket, mail: "Mail", research: "Research" },
    standardsPlan: {
      enabled: plan.enabled === true && !!plan.course,
      course: plan.course ?? null,
      label: plan.label ?? DEFAULTS.standardsPlan.label,
    },
    wakeTime: cfg?.wakeTime ?? DEFAULTS.wakeTime,
    maxWeight: 5,
    driveConnector: cfg?.drive?.connectorName ?? DEFAULTS.drive.connectorName,
  };
}

/**
 * The standards-plan course, or null when the feature is off. Callers treat
 * null as "this whole subsystem is dormant" rather than as an error.
 */
export function standardsCourse(cfg) {
  const plan = cfg?.standardsPlan ?? {};
  return plan.enabled === true && plan.course ? String(plan.course) : null;
}
