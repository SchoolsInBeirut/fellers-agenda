#!/usr/bin/env node
/**
 * gcal-ingest.mjs - the inbound calendar route: one saved connector result in,
 * `<data>/gcal-items.json` out.
 *
 * WHY IT TAKES A FILE AND NOT A CALENDAR
 *
 * This pipeline holds no calendar credentials. It cannot: the whole point of
 * the design is that the user authorizes a calendar connector in their own
 * Claude account and the agent borrows it for the length of one run. So the
 * scheduled run calls the connector's list-events tool itself, saves the tool's
 * answer VERBATIM to a file, and hands that file to this script.
 *
 * **The agent copies bytes; this script decides.** Everything that is a
 * judgement - which events are the agenda's own, what an offset-less time
 * means, which events fall inside the window, what happens when the file is
 * missing - is here, in code a unit test can pin down, and none of it is left
 * to a language model. This script has no network access of any kind: it reads
 * one local file and writes one local file, so it CANNOT write to a calendar
 * even if something asked it to.
 *
 * The pure half - ids, records, zones, windowing, the two normalizers - lives
 * in `gcal-normalize.mjs` and is re-exported here, so one import reaches all of
 * it.
 *
 * SECRET HYGIENE. The `--in` file is a raw calendar dump: attendee addresses,
 * meeting bodies, sometimes conference PINs. Nothing from it is ever printed. A
 * warning names an event by an 8-character id prefix; a malformed body is
 * reported as "not valid JSON" with a byte count and never a snippet (Node's
 * own JSON error quotes the input, so that message is never passed through);
 * and `attendees` is never copied into the output at all.
 *
 * INPUT - one of two shapes, unwrapped ONE level
 *
 *   (a) a calendar-API list result. The claude.ai Google Calendar connector
 *       returns `{accessRole, defaultReminders, events:[...], summary,
 *       timeZone, updated}`; the documented Google API returns
 *       `{kind:"calendar#events", items:[...]}`. A bare array works too.
 *   (b) a hand-transcribed `{events:[{id,title,start,end,allDay?,location?,
 *       free?,url?}]}` for when an agent has to type it out.
 *
 * Either may arrive wrapped as `{content:[{type:"text",text:"<json>"}]}` or as
 * a JSON string. Anything else exits 1 with the TOP-LEVEL KEY NAMES and no
 * values.
 *
 * USAGE
 *   node src/connectors/gcal-ingest.mjs --in data/tmp/gcal-raw.json
 *   node src/connectors/gcal-ingest.mjs --in <p> --feed work --label Work
 *
 * THE SWITCH. `calendars.gcal.enabled` is the one thing that turns this route
 * on, and this script reads it as well as the runbook that decides whether to
 * fetch. Anything but `true` - absent, `false`, or a config it could not read -
 * and the run is a no-op: it prints one `skipped=disabled` line, writes NOTHING,
 * and exits 0. A step that fires while the route is off is therefore harmless,
 * and `render.mjs`, which gates on the same key, can never disagree with what is
 * on disk.
 *
 * EXIT CODES (`src/pipeline.mjs` keys off these)
 *   0  ingested, or skipped because the route is off (the last line says which).
 *   3  the `--in` file is missing or unreadable. If the previous
 *      `gcal-items.json` still holds this feed younger than 48 hours those
 *      events are kept as `status:"stale"`; otherwise `status:"failed"` with
 *      zero events. The file is written either way, so render sees the truth.
 *   1  hard failure - bad arguments, a payload that is not a calendar listing,
 *      or an unwritable output. The previous file is left exactly as it was.
 *
 * The last stdout line on exit 3, and on exit 0 when the route is on, is always:
 *   [gcal-ingest] feed=calendar source=connector events=7 skippedOwn=8 warnings=0 window=2026-09-02..2026-09-24
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_FEED_LABEL, derive, feedIdError, loadConfig } from "../lib/config.mjs";
import { dataDir as resolveDataDir } from "../lib/paths.mjs";
import {
  DEFAULT_FEED_ID,
  EVENT_CAP,
  WINDOW_BACK_DAYS,
  WINDOW_FORWARD_DAYS,
  collate,
  isPlainObject,
  normalizeApi,
  normalizeSimple,
} from "./gcal-normalize.mjs";

export * from "./gcal-normalize.mjs";

export const LOG = "[gcal-ingest]";
export const EXIT = { ok: 0, error: 1, partial: 3 };

export const SOURCE_CONNECTOR = "connector";
export const SOURCE_TRANSCRIBED = "transcribed";

export const OUTPUT_VERSION = 1;
export const OUT_NAME = "gcal-items.json";
/** How long a previous run's events may stand in for a failed one. */
export const STALE_MAX_MS = 48 * 3600 * 1000;
export const MAX_LABEL = MAX_FEED_LABEL;

/** The `--in` file is missing or unusable. Recoverable: stale tolerance takes over. */
export class IngestError extends Error {}

export const USAGE = [
  "gcal-ingest.mjs - normalize a saved calendar-connector result into",
  "<data>/gcal-items.json. Reads one file, writes one file, and has no network",
  "access of any kind.",
  "",
  "usage:",
  "  node src/connectors/gcal-ingest.mjs --in <path> [--feed <id>] [--label <text>]",
  "                                      [--now <ISO>] [--out <path>] [--dry-run]",
  "                                      [--config <path>] [--data <dir>]",
  "",
  "  --in <path>     REQUIRED. The connector result, saved VERBATIM. Accepts the",
  "                  API object (events[] or items[]), a bare array, an MCP",
  '                  {content:[{type:"text",text}]} envelope, or a JSON string.',
  "  --feed <id>     feed id, [a-z0-9-]{1,24}; prefixes every key",
  "  --label <text>  shown on the page, at most 24 chars (default: the feed id)",
  "  --now <ISO>     diagnostics only; NEVER in a scheduled step",
  "  --out <path>    where to write (default <data>/gcal-items.json)",
  "  --dry-run       print the summary, write nothing",
  "  --help, -h      this text",
  "",
  "The route is off unless calendars.gcal.enabled is true in config.json: with",
  "anything else this prints one skipped=disabled line, writes nothing, exits 0.",
  "",
  "exit codes: 0 ingested, or skipped because the route is off. 3 the --in file",
  "was missing or unreadable - previous",
  'events younger than 48h are kept as status:"stale", and the file is written',
  "either way. 1 hard failure - bad arguments, a payload that is not a calendar",
  "listing, or an unwritable output; the previous file is left alone.",
].join("\n");

// -------------------------------------------------------------------- window

const shiftDay = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12) + n * 86400000).toISOString().slice(0, 10);
};

/** The local day `now` falls on in `tz`. PURE. */
function dayKeyIn(now, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The window this run covers: local days [today-1, today+21]. PURE. */
export function windowFor(now, tz) {
  const today = dayKeyIn(now instanceof Date ? now : new Date(now), tz);
  return { from: shiftDay(today, -WINDOW_BACK_DAYS), to: shiftDay(today, WINDOW_FORWARD_DAYS) };
}

/**
 * Is an already-built record still near the window? Used only for records
 * inherited from a previous run - the window has moved since they were fetched,
 * and republishing last Tuesday's meeting would put it back on the grid. A day
 * of slack either side absorbs the zone offset without needing the zone: the
 * precise filter already ran when the record was first built. PURE.
 */
export function inWindow(event, window) {
  if (!event || typeof event !== "object") return false;
  if (event.ad === true) {
    return typeof event.s === "string" && typeof event.e === "string" && event.s <= window.to && event.e > window.from;
  }
  const s = Date.parse(event.s);
  const e = Date.parse(event.e);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  const startMs = Date.parse(`${window.from}T00:00:00Z`);
  const endMs = Date.parse(`${shiftDay(window.to, 1)}T00:00:00Z`);
  return s < endMs + 86400000 && e > startMs - 86400000;
}

// ----------------------------------------------------------------- hygiene

/** Remove anything URL-shaped before it is printed or stored. PURE. */
export function scrub(text) {
  return String(text ?? "").replace(/https?:\/\/\S+/gi, "<url>");
}

// --------------------------------------------------------------------- CLI

/**
 * argv (without node and the script) -> the run's shape. `error` is set rather
 * than thrown, so `run()` owns every exit. PURE.
 */
export function parseArgs(argv, defaults = {}) {
  const out = {
    inPath: null,
    feedId: defaults.feedId ?? DEFAULT_FEED_ID,
    label: null,
    now: new Date(),
    outPath: defaults.outPath ?? null,
    dryRun: false,
    help: false,
    error: null,
  };
  const args = Array.isArray(argv) ? argv : [];
  const fail = (message) => {
    if (!out.error) out.error = message;
    return out;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const inline = (prefix) => (arg.startsWith(prefix) ? arg.slice(prefix.length) : args[++i]);
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--dry-run") out.dryRun = true;
    // --config and --data are read by lib/paths.mjs before this runs; skipping
    // them here is what lets both live on the same command line.
    else if (arg === "--config" || arg === "--data") i++;
    else if (arg.startsWith("--config=") || arg.startsWith("--data=")) continue;
    else if (arg === "--in" || arg.startsWith("--in=")) {
      const raw = inline("--in=");
      if (!raw) return fail("--in needs a path to the saved connector result");
      out.inPath = String(raw);
    } else if (arg === "--feed" || arg.startsWith("--feed=")) {
      const raw = String(inline("--feed=") ?? "");
      const why = feedIdError(raw);
      if (why) return fail(`bad feed id: ${why}`);
      out.feedId = raw;
    } else if (arg === "--label" || arg.startsWith("--label=")) {
      const raw = inline("--label=");
      if (!raw) return fail("--label needs a value");
      out.label = String(raw).slice(0, MAX_LABEL);
    } else if (arg === "--now" || arg.startsWith("--now=")) {
      const raw = inline("--now=");
      const at = new Date(String(raw ?? ""));
      if (!raw || Number.isNaN(at.getTime())) return fail(`bad --now value: ${raw ?? "(missing)"} - expected an ISO instant`);
      out.now = at;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const raw = inline("--out=");
      if (!raw) return fail("--out needs a path");
      out.outPath = String(raw);
    } else return fail(`unknown argument: ${arg}`);
  }
  if (!out.error && !out.help && !out.inPath) return fail("--in is required (the file the connector result was saved to)");
  if (!out.label) out.label = defaults.label ?? out.feedId;
  return out;
}

// -------------------------------------------------------------- unwrapping

/**
 * Drop a UTF-8 byte-order mark and leading whitespace before parsing.
 * `readFileSync(path, "utf-8")` does not strip a BOM and `JSON.parse` throws on
 * one, and a BOM is what most Windows tooling writes. PURE.
 */
const trimLead = (text) => String(text ?? "").replace(/^[\s\uFEFF]+/, "");

/**
 * Peel ONE layer off the connector's answer: an MCP `{content:[{type:"text",
 * text}]}` envelope, or a payload handed back as a JSON string. Exactly one - a
 * second envelope is left for `detectShape` to reject loudly rather than
 * chased, because "keep unwrapping until something looks right" is how a script
 * ends up parsing an error page as a calendar. Never quotes the text it failed
 * on: that text is the raw calendar. PURE.
 */
export function unwrap(raw) {
  const bad = (message) => ({ value: null, error: message });
  const parse = (text, what) => {
    try {
      return { value: JSON.parse(trimLead(text)), error: null };
    } catch {
      return bad(`${what} is not valid JSON (${String(text).length} characters)`);
    }
  };
  if (typeof raw === "string") return parse(raw, "the payload string");
  if (isPlainObject(raw) && Array.isArray(raw.content)) {
    const part = raw.content.find((p) => isPlainObject(p) && typeof p.text === "string");
    if (!part) return bad("the connector envelope has no text part");
    return parse(part.text, "the connector envelope text");
  }
  return { value: raw, error: null };
}

// ---------------------------------------------------------- shape detection

/**
 * `{events:[...]}` is BOTH the live connector's shape and the hand-transcribed
 * one, so the entries decide: an API event carries an OBJECT `start`
 * (`{dateTime}` / `{date}`), a hand-typed one a string `start` and a `title`.
 * The connector is the default for anything else, since that is the route a
 * scheduled run actually takes. PURE.
 */
function shapeOfEntries(entries) {
  const first = entries.find(isPlainObject);
  if (!first || isPlainObject(first.start)) return "api";
  if (typeof first.start === "string" || typeof first.title === "string") return "simple";
  return "api";
}

/**
 * The unwrapped payload -> `{shape, events, keys}`. `shape` is null when this
 * is not a calendar listing at all, and `keys` is then the sorted TOP-LEVEL KEY
 * NAMES - names only, so an "unauthorized" body reports `detail, error` and not
 * whose token expired. PURE.
 */
export function detectShape(value) {
  if (Array.isArray(value)) return { shape: "api", events: value, keys: [] };
  if (!isPlainObject(value)) return { shape: null, events: [], keys: [] };
  const keys = Object.keys(value).sort();
  if (Array.isArray(value.items)) return { shape: "api", events: value.items, keys };
  if (Array.isArray(value.events)) return { shape: shapeOfEntries(value.events), events: value.events, keys };
  return { shape: null, events: [], keys };
}

// ------------------------------------------------------------------- output

/** The contract document. PURE. */
export function buildOutput({ now, tz, window, feeds, events }) {
  return {
    v: OUTPUT_VERSION,
    generatedAt: now.toISOString(),
    tz,
    window: { from: window.from, to: window.to },
    feeds,
    events,
  };
}

/** The line a runbook greps. PURE. */
export function summaryLine(output) {
  const feed = output.feeds[0] ?? {};
  return (
    `${LOG} feed=${feed.id ?? "?"} source=${feed.source ?? "?"} events=${output.events.length} ` +
    `skippedOwn=${feed.skippedOwn ?? 0} warnings=${(feed.warnings ?? []).length} ` +
    `window=${output.window.from}..${output.window.to}`
  );
}

/**
 * What the previous output still knows about one feed, but only while it is
 * inside the 48-hour tolerance. Returns null when there is nothing usable.
 *
 * A NEGATIVE age means the clock stepped backwards between runs (an NTP
 * correction, a `--now` used for diagnosis, a VM resumed from a snapshot). That
 * is data from the future, not data that is too old, so it is clamped to fresh
 * rather than thrown away - discarding it would blank the user's meetings for
 * exactly the reason stale tolerance exists. PURE.
 */
export function staleEventsFor(previous, feedId, nowMs, window) {
  if (!previous || typeof previous !== "object") return null;
  const entry = (Array.isArray(previous.feeds) ? previous.feeds : []).find((f) => f && f.id === feedId);
  const fetchedAt = typeof entry?.fetchedAt === "string" ? Date.parse(entry.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAt)) return null;
  const age = Math.max(0, nowMs - fetchedAt);
  if (age > STALE_MAX_MS) return null;
  const events = (Array.isArray(previous.events) ? previous.events : []).filter(
    (e) => e && e.feed === feedId && inWindow(e, window),
  );
  return { events, fetchedAt: entry.fetchedAt, ageHours: Math.round(age / 3600000) };
}

/**
 * Write the output whole. A partial file is worse than an old one, so it goes
 * to a sibling temp name and is renamed into place; a failure at any point
 * leaves the previous file exactly as it was.
 */
function writeOutput(path, output) {
  const tmp = `${path}.tmp`;
  try {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(output, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file is already gone, or the directory is unwritable too */
    }
    throw new Error(`could not write ${path} (${scrub(e.message)})`);
  }
}

/** The previous output, or null. A file we cannot read is simply "no history". */
function readPrevious(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * The `--in` file -> the unwrapped payload. Every failure is an `IngestError`
 * whose message quotes NOTHING from the file.
 */
function readPayload(path) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    throw new IngestError(`the --in file could not be read (${scrub(e.message)})`);
  }
  let raw;
  try {
    raw = JSON.parse(trimLead(text));
  } catch {
    throw new IngestError(`the --in file is not valid JSON (${text.length} characters)`);
  }
  const { value, error } = unwrap(raw);
  if (error) throw new IngestError(error);
  return value;
}

/** The previous run's entry for one feed, if the file still holds one. PURE. */
function previousFeedEntry(previous, feedId) {
  const feeds = Array.isArray(previous?.feeds) ? previous.feeds : [];
  return feeds.find((f) => isPlainObject(f) && f.id === feedId) ?? null;
}

// -------------------------------------------------------------------- run

/** Write (unless --dry-run), print the warnings and the summary, return the code. */
function publish(args, output, okCode) {
  if (!args.dryRun) {
    try {
      writeOutput(args.outPath, output);
    } catch (e) {
      console.error(`${LOG} error: ${scrub(e.message)}`);
      return EXIT.error;
    }
  }
  for (const entry of output.feeds) {
    for (const w of entry.warnings) console.log(`${LOG} ${entry.id}: ${scrub(w)}`);
  }
  console.log(summaryLine(output));
  return okCode;
}

/**
 * The `--in` file was unusable. Stale tolerance: keep the previous events while
 * they are younger than 48 hours, so a connector outage does not blank the
 * user's meetings at 07:03. Exit 3 either way.
 */
function publishFailure(args, ctx, base, reason) {
  console.log(`${LOG} feed ${base.id} could not be ingested: ${reason}`);
  const previous = readPrevious(args.outPath);
  const kept = staleEventsFor(previous, base.id, args.now.getTime(), ctx.window);
  if (!kept) {
    const failed = { ...base, status: "failed", events: 0, error: reason };
    return publish(args, buildOutput({ ...ctx, now: args.now, feeds: [failed], events: [] }), EXIT.partial);
  }
  // The events being shipped are the PREVIOUS run's, so the provenance that
  // goes with them is too. Re-stamping them as this run's would describe a run
  // that never happened.
  const was = previousFeedEntry(previous, base.id);
  const feed = {
    ...base,
    status: "stale",
    source: typeof was?.source === "string" && was.source ? was.source : base.source,
    fetchedAt: kept.fetchedAt, // the ORIGINAL time, so the age stays honest
    events: kept.events.length,
    skippedOwn: Number.isFinite(was?.skippedOwn) ? was.skippedOwn : 0,
    error: `${reason}; showing data from ${kept.ageHours}h ago`,
  };
  return publish(args, buildOutput({ ...ctx, now: args.now, feeds: [feed], events: kept.events }), EXIT.partial);
}

/** A recognized payload -> the contract document on disk. Returns an exit code. */
function publishIngested(args, ctx, base, shape) {
  const source = shape.shape === "api" ? SOURCE_CONNECTOR : SOURCE_TRANSCRIBED;
  const normalize = shape.shape === "api" ? normalizeApi : normalizeSimple;
  let built;
  try {
    built = normalize(shape.events, {
      feedId: args.feedId,
      label: args.label,
      window: ctx.window,
      tz: ctx.tz,
      guards: ctx.guards,
    });
  } catch (e) {
    console.error(`${LOG} error: internal error while normalizing (${scrub(e.message)})`);
    return EXIT.error;
  }
  const { events, warnings: capWarnings } = collate(built.events, ctx.cap);
  const feed = {
    ...base,
    source,
    events: events.length,
    skippedOwn: built.skippedOwn,
    warnings: [...built.warnings, ...capWarnings],
  };
  return publish(args, buildOutput({ ...ctx, now: args.now, feeds: [feed], events }), EXIT.ok);
}

/**
 * Everything the run needs out of `config.json`. Absent or half-written config
 * still produces a usable context: this route is opt-in, and a user who has not
 * filled it in yet gets the defaults rather than a crash.
 */
export function contextFromConfig(cfg, derived) {
  const block = cfg?.calendars?.gcal ?? {};
  const ns = derived?.ns ?? cfg?.namespace ?? "agenda";
  return {
    tz: typeof cfg?.timezone === "string" && cfg.timezone ? cfg.timezone : "UTC",
    feedId: feedIdError(block.feed) === null ? block.feed : DEFAULT_FEED_ID,
    label: typeof block.label === "string" && block.label ? String(block.label).slice(0, MAX_LABEL) : null,
    cap: Number.isFinite(block.maxEvents) && block.maxEvents > 0 ? Math.floor(block.maxEvents) : EVENT_CAP,
    guards: {
      // The default narrows the ICS sink's own UID domain to THIS agenda's
      // namespace, so two agendas sharing one calendar do not eat each other's
      // meetings. A user may override it, including with "" to switch it off.
      skipUidSuffix: typeof block.skipUidSuffix === "string" ? block.skipUidSuffix : `@${ns}.agenda.local`,
      ...(typeof block.skipDescriptionMarker === "string"
        ? { skipDescriptionMarker: block.skipDescriptionMarker }
        : {}),
    },
  };
}

/**
 * The whole run. Returns an exit code; the only thing it throws is a bug, and
 * `main()` catches that too.
 */
export function run(argv, env = {}) {
  const root = env.root ?? process.cwd();
  let cfg = null;
  let derived = null;
  try {
    cfg = loadConfig(null, { argv, warn: () => {} });
    derived = derive(cfg);
  } catch {
    // A missing or unreadable config is not fatal here. This route is opt-in
    // and everything it needs has a default, so a half-written config gets the
    // defaults rather than a crash before the user has finished setup.
    cfg = null;
    derived = null;
  }
  const ctxBase = contextFromConfig(cfg, derived);
  const enabled = cfg?.calendars?.gcal?.enabled === true;
  const data = resolveDataDir(argv, root);
  const args = parseArgs(argv, {
    feedId: ctxBase.feedId,
    label: ctxBase.label,
    outPath: join(data, OUT_NAME),
  });
  // Help wins over an argv mistake: someone typing --help is asking what the
  // right arguments ARE, and telling them off first helps nobody.
  if (args.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (args.error) {
    console.error(`${LOG} error: ${scrub(args.error)}`);
    return EXIT.error;
  }
  // The switch, read AFTER the arguments so a typo is still a typo. A step that
  // fires while the route is off - a scheduled task left behind, a runbook
  // copied whole, a user who turned it off this morning - writes nothing and
  // costs nothing. `render.mjs` reads the same key and would ignore the file
  // anyway; not writing it is what keeps the two from ever disagreeing.
  if (!enabled) {
    console.log(
      `${LOG} skipped=disabled - calendars.gcal.enabled is not true in config.json; ` +
        "nothing was read and nothing was written",
    );
    return EXIT.ok;
  }

  const window = windowFor(args.now, ctxBase.tz);
  const ctx = { tz: ctxBase.tz, window, guards: ctxBase.guards, cap: ctxBase.cap };
  const base = {
    id: args.feedId,
    label: args.label,
    status: "ok",
    source: SOURCE_CONNECTOR,
    fetchedAt: args.now.toISOString(),
    events: 0,
    skippedOwn: 0,
    warnings: [],
    error: null,
  };

  let payload;
  try {
    payload = readPayload(args.inPath);
  } catch (e) {
    if (!(e instanceof IngestError)) {
      console.error(`${LOG} error: internal error reading the --in file (${scrub(e.message)})`);
      return EXIT.error;
    }
    return publishFailure(args, ctx, base, scrub(e.message));
  }

  const shape = detectShape(payload);
  if (!shape.shape) {
    // Names only. The VALUES are the calendar, and an "unauthorized" body would
    // otherwise put the account it was rejected for into the run log.
    console.error(
      `${LOG} error: ${args.inPath} is not a calendar listing - top-level keys: ${shape.keys.join(", ") || "(none)"}`,
    );
    return EXIT.error;
  }
  return publishIngested(args, ctx, base, shape);
}

/** Never throw uncaught: an unhandled error here would be exit 1 with a stack. */
function main() {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(`${LOG} error: ${scrub(e?.stack ?? e?.message ?? e)}`);
    process.exitCode = EXIT.error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export default run;
