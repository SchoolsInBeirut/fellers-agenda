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

  drive: {
    enabled: true,
    connectorName: "Google Drive",
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

  scheduler: {
    taskPrefix: "Agenda",
    morningAt: "07:03",
    eveningAt: "18:07",
    quietUntil: "07:23",
    syncWindow: ["09:00", "23:00"],
    syncGapHours: 3,
    graceMinutes: 20,
    debounceMinutes: 25,
    maxRescuesPerLane: 2,
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

  if (typeof cfg.namespace !== "string" || !NS_RE.test(cfg.namespace)) {
    throw new ConfigError(
      `config: "namespace" must be 3-24 characters of a-z, 0-9 or "-" (got ${JSON.stringify(cfg.namespace)})`,
      "namespace",
    );
  }
  return cfg;
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
    taskNames: {
      morning: `${prefix} Morning`,
      evening: `${prefix} Evening`,
      sync: `${prefix} Sync`,
      staleCheck: `${prefix} StaleCheck`,
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
