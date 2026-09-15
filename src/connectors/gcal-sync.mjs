#!/usr/bin/env node
/**
 * gcal-sync.mjs - the inbound calendar, ROUTE A: secret ICS feed addresses in,
 * `<data>/gcal-items.json` out.
 *
 * WHY THERE ARE TWO ROUTES
 *
 * `gcal-ingest.mjs` is route B: an AGENT calls a calendar connector the user
 * authorized in their own Claude account, saves the answer verbatim, and hands
 * the file over. That works beautifully in a chat and not at all on a schedule -
 * the daily run has no connector to call, and paying a language model to copy
 * fifteen thousand characters of calendar JSON once a day was the single largest
 * line in this project's token bill.
 *
 * So route A does the fetch in a script. What it reads is the calendar's own
 * "Secret address in iCal format" (Settings -> the calendar -> Integrate
 * calendar): a private URL that returns RFC 5545 text and is READ-ONLY by
 * construction. Adding a second calendar is one more entry in a JSON file.
 * Both routes write the SAME document, in the same shape, so `src/render.mjs`
 * and `src/focus-engine.mjs` cannot tell which one ran.
 *
 * DIRECTION IS STRICTLY INBOUND. This script fetches. It never writes to
 * anybody's calendar, never calls a calendar connector, and holds no OAuth
 * credential of any kind - an ICS address cannot write, which makes that a
 * property rather than a promise.
 *
 * ---------------------------------------------------------------------------
 * THE FEED URL IS A BEARER SECRET
 *
 * Anyone holding it can read that calendar forever. So it lives in exactly one
 * place - `<data>/gcal-feeds.json`, which the USER maintains - and this script
 * never puts it in argv, in a log line, in an error message, in the output file,
 * or in the Drive mirror (`drive-bundle.mjs` refuses to mirror the feeds file,
 * with its own test). A feed is identified everywhere by its id, its HOST, and
 * `sha256(url).slice(0,8)`. Every error string is scrubbed of anything
 * URL-shaped before it is printed or stored.
 *
 * ---------------------------------------------------------------------------
 * <data>/gcal-feeds.json  (see fixtures/gcal/feeds.example.json)
 *
 *   {"v":1,"feeds":[{"id":"work","label":"Work","url":"https://...","skipUidSuffix":"@agenda"}]}
 *
 *   id             [a-z0-9-]{1,24}, unique, and not a reserved key-space prefix
 *                  (`feedIdError` in src/lib/config.mjs refuses `fb`). It
 *                  prefixes every meeting key.
 *   label          shown on the page, 24 characters or fewer (longer is trimmed).
 *                  Absent -> `calendars.gcal.label` for the matching feed id,
 *                  else the id itself.
 *   url            https ONLY. An empty url is "not filled in yet": a clean skip.
 *   skipUidSuffix  optional, per feed. Overrides `calendars.gcal.skipUidSuffix`;
 *                  `""` switches the uid loop guard off for that feed.
 *
 * Everything else - the feed cap, the description loop guard, the window, the
 * zone - comes from `calendars.gcal` and `timezone` through
 * `contextFromConfig()`, which route B reads too, so the two cannot disagree.
 *
 * ---------------------------------------------------------------------------
 * STALE TOLERANCE - an outage must not blank the meetings at 10:30
 *
 * When a feed fails and the previous `gcal-items.json` still holds that feed's
 * events with a `fetchedAt` newer than 48 hours, those events are kept and the
 * feed is marked `status:"stale"` with the ORIGINAL `fetchedAt`, so the age
 * stays honest. Older than that, or no previous data at all, and the feed is
 * `status:"failed"` with zero events. Either way the file is written and the
 * run exits 3, so the page shows the truth rather than yesterday's guess.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *   node src/connectors/gcal-sync.mjs                 fetch every feed, write the file
 *   node src/connectors/gcal-sync.mjs --validate      print feed ids and hosts, exit 0/1
 *   node src/connectors/gcal-sync.mjs --dry-run       print the summary, write nothing
 *   node src/connectors/gcal-sync.mjs --now <ISO>     diagnostics; NEVER in a scheduled step
 *   node src/connectors/gcal-sync.mjs --from-file <id>=<a.ics>   offline: read a feed from disk
 *   --config <path> / --data <dir> / --feeds <path> / --out <path>
 *
 * `--validate` is the one flag that runs BEFORE the switch and before the strict
 * read of the feeds file: it writes nothing and fetches nothing, so it is what a
 * user runs when a run has just said `gcal=FAILED`. It lists every entry it can
 * read AND every problem it found, says so if the route is off, and exits 1 only
 * when there was a problem.
 *
 * EXIT CODES (src/pipeline.mjs phase 1 step 7 keys off these)
 *   0  every feed ok - or the route is off, or `--dry-run`, or a clean `--validate`.
 *   2  no feeds configured. The output file is REWRITTEN with `feeds:[]` and
 *      `events:[]`, so render sees an honest empty rather than last week's
 *      meetings from a calendar the user has since removed.
 *   3  at least one feed is stale or failed; the file is written with whatever
 *      we have.
 *   1  hard failure - the feeds file is malformed, the output is unwritable, or
 *      a bad argument. The previous file is left exactly as it was.
 *
 * THE LAST STDOUT LINE IS ALWAYS THE PIPELINE'S TOKEN, and nothing else:
 *   gcal=ok(7-events;1-feeds) / gcal=PARTIAL(0-events;1-feeds;stale=1,failed=0)
 *   gcal=SKIPPED(no-feeds) / gcal=SKIPPED(disabled) / gcal=FAILED(<reason>)
 *   gcal=ok(validate;2-feeds) / gcal=FAILED(validate;<reason>)
 * The human-readable `[gcal-sync] feeds=... window=...` summary is the line
 * before it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_FEED_LABEL, derive, feedIdError, loadConfig } from "../lib/config.mjs";
import { parseFeed } from "../lib/ics-parse.mjs";
import { repoRoot, dataDir as resolveDataDir } from "../lib/paths.mjs";
import { OUT_NAME, STALE_MAX_MS, buildOutput, contextFromConfig, scrub, staleEventsFor, windowFor } from "./gcal-ingest.mjs";
import { capEvents, normalizeSimple, ownEventRule } from "./gcal-normalize.mjs";

export { STALE_MAX_MS, scrub, staleEventsFor, windowFor };

export const LOG = "[gcal-sync]";
export const EXIT = { ok: 0, error: 1, noFeeds: 2, partial: 3 };

/** Where the user keeps the secret addresses, relative to the data directory. */
export const FEEDS_NAME = "gcal-feeds.json";
/** What `feeds[].source` says, next to route B's `connector` / `transcribed`. */
export const SOURCE_FEED = "ics";
/** How long one feed gets before it is abandoned. */
export const FETCH_TIMEOUT_MS = 20000;
export const USER_AGENT = "agenda gcal-sync/2";

/** The feeds file is unusable in a way only a human can fix. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** One feed could not be read. Recoverable: stale tolerance takes over. */
export class FeedError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedError";
  }
}

/**
 * Both loop guards OFF for the normalizer. They have already been applied, per
 * VEVENT, inside `ics-parse.mjs` - a recurring event of ours must count ONCE in
 * `skippedOwn`, not once per instance - so asking `normalizeSimple` to apply
 * them a second time would double the number and warn twice.
 */
const GUARDS_ALREADY_APPLIED = Object.freeze({ skipUidSuffix: "", skipDescriptionMarker: "" });

// ------------------------------------------------------------- url hygiene

/** The host of a feed url, or `"?"`. Safe to log. PURE. */
export function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return "?";
  }
}

/** A stable 8-hex handle for a url that reveals nothing about it. PURE. */
export function feedFingerprint(url) {
  return createHash("sha256").update(String(url ?? ""), "utf8").digest("hex").slice(0, 8);
}

/** How a feed is named in a log line: id, host, fingerprint. Never the url. PURE. */
const feedTag = (feed) => `${feed.id} (${feedOrigin(feed)})`;
const feedOrigin = (feed) => `host=${hostOf(feed.url)} fp=${feedFingerprint(feed.url)}`;

/**
 * The directory every relative path hangs off: `repoRoot()`, exactly as every
 * other CLI in this repo resolves it, and NEVER `process.cwd()`.
 *
 * The difference is invisible from the pipeline, which spawns each step with
 * `cwd` already at the repo root - and that is what makes it worth a function
 * and a test. `cd src/connectors && node gcal-sync.mjs` would otherwise read
 * `src/connectors/data/gcal-feeds.json`, find nothing, write
 * `src/connectors/data/gcal-items.json`, and report a perfectly successful run
 * into a directory nothing else in the repo will ever look at.
 *
 * `env.root` stays injectable so a test can point the whole run at a `mkdtemp`
 * directory without a `--data` flag. PURE.
 */
export const rootOf = (env = {}) => env.root ?? repoRoot();

/**
 * Any message -> one space-free token fragment. The runlog line is parsed by
 * position, so a token that contains a space or a bracket splits a field in two
 * and every consumer downstream reads the wrong thing. PURE.
 */
export function tokenText(text) {
  const flat = scrub(text)
    .replace(/[\s()]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return flat || "error";
}

// ------------------------------------------------------------------- CLI

/**
 * argv (without node and the script) -> the run's shape. `error` is set rather
 * than thrown, so `run()` owns every exit. PURE.
 */
export function parseArgs(argv, defaults = {}) {
  const out = {
    dryRun: false,
    validate: false,
    help: false,
    now: new Date(),
    fromFile: new Map(),
    feedsPath: defaults.feedsPath ?? null,
    outPath: defaults.outPath ?? null,
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
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--validate") out.validate = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    // --config and --data are read by lib/paths.mjs before this runs; skipping
    // them here is what lets both live on the same command line.
    else if (arg === "--config" || arg === "--data") i++;
    else if (arg.startsWith("--config=") || arg.startsWith("--data=")) continue;
    else if (arg === "--now" || arg.startsWith("--now=")) {
      const raw = inline("--now=");
      const at = new Date(String(raw ?? ""));
      if (!raw || Number.isNaN(at.getTime())) return fail(`bad --now value: ${raw ?? "(missing)"} - expected an ISO instant`);
      out.now = at;
    } else if (arg === "--from-file" || arg.startsWith("--from-file=")) {
      const raw = String(inline("--from-file=") ?? "");
      const eq = raw.indexOf("=");
      if (eq <= 0 || eq === raw.length - 1) return fail("bad --from-file value: expected <feedId>=<path.ics>");
      out.fromFile.set(raw.slice(0, eq), raw.slice(eq + 1));
    } else if (arg === "--feeds" || arg.startsWith("--feeds=")) {
      const raw = inline("--feeds=");
      if (!raw) return fail("--feeds needs a path");
      out.feedsPath = String(raw);
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const raw = inline("--out=");
      if (!raw) return fail("--out needs a path");
      out.outPath = String(raw);
    } else return fail(`unknown argument: ${arg}`);
  }
  return out;
}

export const USAGE = [
  "gcal-sync.mjs - fetch the user's own calendars over their secret iCal",
  "addresses and write <data>/gcal-items.json. Reads one JSON file, fetches,",
  "writes one JSON file. It cannot write to a calendar.",
  "",
  "usage:",
  "  node src/connectors/gcal-sync.mjs [--validate] [--dry-run] [--now <ISO>]",
  "                                    [--from-file <id>=<path.ics>]",
  "                                    [--feeds <path>] [--out <path>]",
  "                                    [--config <path>] [--data <dir>]",
  "",
  `  --validate      list the feeds in <data>/${FEEDS_NAME} - ids and hosts, never`,
  "                  a url - and every problem with the file. Writes nothing,",
  "                  fetches nothing, and works while the route is off. Exit 1",
  "                  only if there was a problem",
  "  --dry-run       print the summary, write nothing",
  "  --now <ISO>     diagnostics only; NEVER in a scheduled step",
  "  --from-file     read one feed off disk instead of fetching it (offline)",
  "  --help, -h      this text",
  "",
  "The route is off unless calendars.gcal.enabled is true in config.json.",
  "",
  "exit codes: 0 every feed ok (or off, or --dry-run). 2 no feeds configured -",
  "the output file is rewritten empty. 3 a feed is stale or failed; the file is",
  "written with whatever we have. 1 hard failure; the previous file is untouched.",
].join("\n");

// -------------------------------------------------------------- feeds file

/**
 * EVERY entry the file names, and EVERY problem with it - it does not stop at
 * the first one. That is what `--validate` needs: a user whose run just failed
 * is told to run it, and a diagnostic that answers "there is a problem" and then
 * refuses to say which feeds it could read is no better than the failure.
 *
 * An entry with a fatal problem is reported and NOT listed, because it is not a
 * feed. An entry with an EMPTY url is listed - the user has not filled it in yet
 * and seeing the gap is the whole point - and `normalizeFeeds` drops it after.
 * No message ever contains a url. PURE.
 *
 * @returns {{feeds: Array, problems: string[]}}
 */
export function inspectFeeds(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { feeds: [], problems: ["feeds file is not an object"] };
  }
  if (raw.feeds !== undefined && !Array.isArray(raw.feeds)) {
    return { feeds: [], problems: ["feeds file: `feeds` is not an array"] };
  }
  const feeds = [];
  const problems = [];
  const seen = new Set();
  const entries = raw.feeds ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`feeds file: entry ${i} is not an object`);
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const why = feedIdError(id);
    if (why) {
      problems.push(`feeds file: entry ${i} has a bad feed id - ${why}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`feeds file: duplicate feed id ${JSON.stringify(id)}`);
      continue;
    }
    seen.add(id);
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (url && !/^https:\/\//i.test(url)) {
      problems.push(`feeds file: feed ${JSON.stringify(id)} url must be https`);
      continue;
    }
    feeds.push({
      id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.slice(0, MAX_FEED_LABEL) : null,
      url,
      skipUidSuffix: typeof entry.skipUidSuffix === "string" ? entry.skipUidSuffix : null,
    });
  }
  return { feeds, problems };
}

/**
 * The parsed feeds file -> `{feeds, error}`, for the RUN. A feed with an EMPTY
 * url is DROPPED - that is a skip, not a failure: the user has not filled it in
 * yet. A feed that is actively wrong - a bad or reserved id, a duplicate id, a
 * non-https url - is an ERROR that stops the whole run, because silently
 * ignoring it would hide a calendar the user believes is connected, and an empty
 * grid looks exactly like a free week.
 *
 * `label` and `skipUidSuffix` come back as null when the entry did not set
 * them, so the caller can tell "not set" from `""` and fall back to config. PURE.
 */
export function normalizeFeeds(raw) {
  const { feeds, problems } = inspectFeeds(raw);
  if (problems.length) return { feeds: [], error: problems[0] };
  return { feeds: feeds.filter((f) => f.url), error: null };
}

/**
 * The feeds file as JSON, or why it could not be read. Never throws, and never
 * quotes the file: a JSON syntax error from Node includes the offending text,
 * and the offending text here may be half a secret address.
 */
function readFeedsJson(path) {
  if (!existsSync(path)) return { raw: null, error: null, missing: true };
  try {
    return { raw: JSON.parse(readFileSync(path, "utf-8")), error: null, missing: false };
  } catch (e) {
    return { raw: null, error: `feeds file is not valid JSON (${scrub(e.message)})`, missing: false };
  }
}

/** Read and normalize the feeds file for a RUN. Missing = no feeds, which is a SKIP. */
function readFeeds(path) {
  const file = readFeedsJson(path);
  if (file.error) throw new ConfigError(file.error);
  if (file.missing) return { feeds: [], error: null, missing: true };
  const norm = normalizeFeeds(file.raw);
  if (norm.error) throw new ConfigError(norm.error);
  return { ...norm, missing: false };
}

/**
 * One feeds-file entry plus `calendars.gcal` -> everything the fetch and the
 * normalizer need. `calendars.gcal.label` and `.skipUidSuffix` apply to the feed
 * whose id matches `calendars.gcal.feed`, which is the single-calendar case
 * almost everybody is in; a second feed names itself. PURE.
 */
export function resolveFeed(feed, ctx) {
  const isConfigured = feed.id === ctx.feedId;
  const label = feed.label ?? (isConfigured && ctx.label ? ctx.label : null) ?? feed.id;
  const guards =
    feed.skipUidSuffix === null ? ctx.guards : { ...ctx.guards, skipUidSuffix: feed.skipUidSuffix };
  return { ...feed, label: String(label).slice(0, MAX_FEED_LABEL), guards };
}

// ------------------------------------------------------------------- fetch

/**
 * Fetch one iCalendar document. Every failure comes back as a `FeedError` with a
 * SCRUBBED message - never a raw network error, whose text may carry the url.
 *
 * The fetcher is INJECTED rather than reached for: the CLI passes Node's global
 * `fetch`, and a test passes a function, which is what lets the whole transport
 * be covered without a socket, a port, or a fixture server.
 */
export async function fetchIcsText(url, { fetchImpl, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new FeedError("no fetcher available");
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT },
    });
  } catch (e) {
    throw new FeedError(`request failed (${scrub(e?.message ?? e)})`);
  }
  if (!res || typeof res !== "object") throw new FeedError("the fetcher returned nothing");
  if (!res.ok) throw new FeedError(`HTTP ${res.status}`);
  const ctype = res.headers?.get?.("content-type") ?? "";
  if (ctype && !/text\/|calendar/i.test(ctype)) throw new FeedError(`unexpected content-type ${scrub(ctype)}`);
  try {
    return await res.text();
  } catch (e) {
    throw new FeedError(`body could not be read (${scrub(e?.message ?? e)})`);
  }
}

/**
 * One feed's iCalendar text. `--from-file` short-circuits the transport
 * entirely, which is how the offline end-to-end check and the exit-code tests
 * run without a network.
 */
async function readFeedText(feed, { fromFile, fetchImpl }) {
  const path = fromFile.get(feed.id);
  if (path === undefined) return fetchIcsText(feed.url, { fetchImpl });
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    throw new FeedError(`could not read the --from-file fixture (${scrub(e.message)})`);
  }
}

/**
 * A feed's text -> the SAME records route B produces. `ics-parse.mjs` decides
 * what the text says; `normalizeSimple` decides what a record looks like. Throws
 * `FeedError` on a body that is not a calendar at all - an expired address
 * returns a sign-in page with a cheerful 200. PURE.
 */
export function eventsFromText(text, feed, ctx) {
  if (!String(text ?? "").includes("BEGIN:VCALENDAR")) throw new FeedError("body does not contain BEGIN:VCALENDAR");
  const parsed = parseFeed(text, {
    tz: ctx.tz,
    from: ctx.window.from,
    to: ctx.window.to,
    ownRule: (uid, description) => ownEventRule({ description }, uid, feed.guards),
  });
  const built = normalizeSimple(parsed.instances, {
    feedId: feed.id,
    label: feed.label,
    window: ctx.window,
    tz: ctx.tz,
    guards: GUARDS_ALREADY_APPLIED,
  });
  return {
    events: built.events,
    warnings: [...parsed.warnings, ...built.warnings],
    skippedOwn: parsed.skippedOwn + built.skippedOwn,
  };
}

// ---------------------------------------------------------------- one feed

/** One feed entry, whatever happened to it: ok, stale, or failed. */
async function syncOneFeed(feed, { args, previous, ctx, fetchedAt, fetchImpl }) {
  const base = {
    id: feed.id,
    label: feed.label,
    status: "ok",
    source: SOURCE_FEED,
    fetchedAt,
    events: 0,
    skippedOwn: 0,
    warnings: [],
    error: null,
  };
  try {
    const text = await readFeedText(feed, { fromFile: args.fromFile, fetchImpl });
    const { events, warnings, skippedOwn } = eventsFromText(text, feed, ctx);
    return { entry: { ...base, events: events.length, skippedOwn, warnings }, events };
  } catch (e) {
    const reason = scrub(e instanceof FeedError ? e.message : `internal error: ${e?.message ?? e}`);
    console.log(`${LOG} feed ${feedTag(feed)} failed: ${reason}`);
    const kept = staleEventsFor(previous, feed.id, args.now.getTime(), ctx.window);
    if (!kept) return { entry: { ...base, status: "failed", error: reason }, events: [] };
    return {
      entry: {
        ...base,
        status: "stale",
        fetchedAt: kept.fetchedAt, // the ORIGINAL time, so the age stays honest
        events: kept.events.length,
        error: `${reason}; showing data from ${kept.ageHours}h ago`,
      },
      events: kept.events,
    };
  }
}

/**
 * Dedupe by key (a duplicate keeps the LAST), sort, cap, and tell every feed
 * what it ACTUALLY shipped. `feedEntries` is rebuilt rather than mutated. PURE.
 */
export function collateFeeds(feedEntries, collected, cap) {
  const byKey = new Map();
  for (const event of collected) byKey.set(event.k, event);
  const { events, dropped } = capEvents([...byKey.values()], cap);
  const lost = new Map();
  for (const d of dropped) lost.set(d.feed, (lost.get(d.feed) ?? 0) + 1);
  const feeds = feedEntries.map((entry) => {
    const n = lost.get(entry.id);
    return {
      ...entry,
      // Post-cap, for EVERY status: a stale feed that lost events to the cap
      // would otherwise keep reporting the count it had before the cap ran.
      events: events.filter((e) => e.feed === entry.id).length,
      warnings: n ? [...entry.warnings, `dropped ${n} event(s) over the ${cap}-event cap`] : entry.warnings,
    };
  });
  return { feeds, events };
}

// ------------------------------------------------------------------ output

/** The human-readable line, for the runlog's stdout file and for a person. PURE. */
export function summaryLine(output) {
  const counts = { ok: 0, stale: 0, failed: 0 };
  let skippedOwn = 0;
  let warnings = 0;
  for (const f of output.feeds) {
    if (counts[f.status] !== undefined) counts[f.status]++;
    skippedOwn += f.skippedOwn ?? 0;
    warnings += (f.warnings ?? []).length;
  }
  return (
    `${LOG} feeds=${output.feeds.length} ok=${counts.ok} stale=${counts.stale} failed=${counts.failed} ` +
    `events=${output.events.length} skippedOwn=${skippedOwn} warnings=${warnings} ` +
    `window=${output.window.from}..${output.window.to}`
  );
}

/** The one token `src/pipeline.mjs` reads off the last stdout line. PURE. */
export function tokenLine(output) {
  const stale = output.feeds.filter((f) => f.status === "stale").length;
  const failed = output.feeds.filter((f) => f.status === "failed").length;
  const shape = `${output.events.length}-events;${output.feeds.length}-feeds`;
  if (stale || failed) return `gcal=PARTIAL(${shape};stale=${stale},failed=${failed})`;
  return `gcal=ok(${shape})`;
}

/**
 * Write the output whole. A partial file is worse than an old one, so it goes to
 * a sibling temp name and is renamed into place; a failure at any point leaves
 * the previous file exactly as it was.
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
    throw new ConfigError(`could not write ${path} (${scrub(e.message)})`);
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

/** Write (unless `--dry-run`), print the warnings, the summary and the token. */
function publish(args, output) {
  if (!args.dryRun) {
    try {
      writeOutput(args.outPath, output);
    } catch (e) {
      return fail(scrub(e.message));
    }
  }
  for (const entry of output.feeds) {
    for (const w of entry.warnings) console.log(`${LOG} ${entry.id}: ${scrub(w)}`);
  }
  console.log(summaryLine(output));
  console.log(tokenLine(output));
  return output.feeds.some((f) => f.status !== "ok") ? EXIT.partial : EXIT.ok;
}

/** One `[gcal-sync] error:` line on stderr, one FAILED token on stdout, exit 1. */
function fail(reason) {
  console.error(`${LOG} error: ${scrub(reason)}`);
  console.log(`gcal=FAILED(${tokenText(reason)})`);
  return EXIT.error;
}

/** One line that is only a token: nothing ran, and nothing is on disk to explain. */
function skip(reason, detail) {
  console.log(`${LOG} ${detail}`);
  console.log(`gcal=SKIPPED(${reason})`);
  return EXIT.ok;
}

// -------------------------------------------------------------------- run

/**
 * `--validate`: what is in the feeds file, and what is wrong with it, without
 * ever showing a url. Writes nothing and fetches nothing, which is what makes it
 * the safe thing to ask a user to run and paste.
 *
 * IT RUNS BEFORE EVERYTHING ELSE, and that is the whole point. This is the
 * command a user reaches for when a run has just said `gcal=FAILED`, and the
 * commonest cause of that token is the feeds file itself. A diagnostic that
 * refused the same way the run did - and printed no feed list while it was at it
 * - would leave them with exactly the information they already had. So it reads
 * the file leniently (`inspectFeeds`), prints every entry it COULD read, and
 * prints every problem beside them.
 *
 * It also runs while the route is OFF. Turning `calendars.gcal.enabled` on is
 * step one and filling the file in is step two, and a user doing them in the
 * other order should be able to check their work.
 */
function reportFeeds(args, enabled) {
  const file = readFeedsJson(args.feedsPath);
  const scan = file.raw === null ? { feeds: [], problems: file.error ? [file.error] : [] } : inspectFeeds(file.raw);

  if (file.missing) console.log(`${LOG} validate: no feeds file at ${args.feedsPath} - route A is not set up`);
  for (const feed of scan.feeds) {
    const origin = feed.url ? feedOrigin(feed) : "no url yet - this feed is skipped";
    console.log(`${LOG} feed ${feed.id} "${feed.label ?? feed.id}" ${origin}`);
  }
  for (const problem of scan.problems) console.error(`${LOG} error: ${scrub(problem)}`);
  if (!enabled) {
    console.log(`${LOG} validate: the route is OFF - calendars.gcal.enabled is not true, so nothing fetches these feeds`);
  }

  const usable = scan.feeds.filter((f) => f.url).length;
  if (scan.problems.length) {
    console.log(`${LOG} validate FAILED: ${scan.problems.length} problem(s), ${usable} usable feed(s) in ${args.feedsPath}`);
    console.log(`gcal=FAILED(validate;${tokenText(scan.problems[0])})`);
    return EXIT.error;
  }
  console.log(`${LOG} validate ok: ${usable} feed(s) in ${args.feedsPath}`);
  console.log(`gcal=ok(validate;${usable}-feeds)`);
  return EXIT.ok;
}

/**
 * No feeds at all. Rewriting the file with an honest empty is the POINT: a stale
 * `gcal-items.json` would keep putting last week's meetings on the grid long
 * after the user removed the calendar.
 */
function runNoFeeds(args, ctx) {
  console.log(`${LOG} no feeds configured (${args.feedsPath})`);
  const output = buildOutput({ now: args.now, tz: ctx.tz, window: ctx.window, feeds: [], events: [] });
  if (!args.dryRun) {
    try {
      writeOutput(args.outPath, output);
    } catch (e) {
      return fail(scrub(e.message));
    }
  }
  console.log(summaryLine(output));
  console.log("gcal=SKIPPED(no-feeds)");
  return args.dryRun ? EXIT.ok : EXIT.noFeeds;
}

/**
 * The whole run. Returns an exit code; the only thing it throws is a bug, and
 * `main()` catches that too.
 *
 * @param {string[]} argv
 * @param {{root?: string, fetchImpl?: Function}} env  `fetchImpl` is the
 *   transport. The CLI hands it Node's global `fetch`; a test hands it a
 *   function, and no test in this repo ever opens a socket. `root` is a test
 *   seam; see `rootOf`.
 */
export async function run(argv, env = {}) {
  const root = rootOf(env);
  let cfg = null;
  let derived = null;
  try {
    cfg = loadConfig(null, { argv, warn: () => {} });
    derived = derive(cfg);
  } catch {
    // A missing or unreadable config is not fatal here. This route is opt-in and
    // everything it needs has a default, so a half-written config gets the
    // defaults rather than a crash before the user has finished setup.
    cfg = null;
    derived = null;
  }
  const ctxBase = contextFromConfig(cfg, derived);
  const data = resolveDataDir(argv, root);
  const args = parseArgs(argv, { feedsPath: join(data, FEEDS_NAME), outPath: join(data, OUT_NAME) });
  // Help wins over an argv mistake: somebody typing --help is asking what the
  // right arguments ARE, and telling them off first helps nobody.
  if (args.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (args.error) return fail(args.error);
  const enabled = cfg?.calendars?.gcal?.enabled === true;
  // --validate comes FIRST, before both the switch and the strict read. It
  // writes nothing and fetches nothing, so there is no state for either gate to
  // protect - and it is the command a user runs when one of them has just gone
  // wrong. See `reportFeeds`.
  if (args.validate) return reportFeeds(args, enabled);
  // The switch, read AFTER the arguments so a typo is still a typo. `render.mjs`
  // gates on the same key and would ignore the file anyway; not writing it is
  // what keeps the two from ever disagreeing.
  if (!enabled) {
    return skip("disabled", "skipped - calendars.gcal.enabled is not true in config.json; nothing was read or written");
  }

  let config;
  try {
    config = readFeeds(args.feedsPath);
  } catch (e) {
    return fail(e.message);
  }

  const window = windowFor(args.now, ctxBase.tz);
  const ctx = { tz: ctxBase.tz, window, feedId: ctxBase.feedId, label: ctxBase.label, guards: ctxBase.guards };
  if (!config.feeds.length) return runNoFeeds(args, ctx);

  // ONE clock for the whole run, the same one `generatedAt` uses. Two clocks in
  // one file make the age of the data unanswerable, and the age is the only
  // thing stale tolerance has to reason with.
  const fetchedAt = args.now.toISOString();
  const previous = readPrevious(args.outPath);
  const entries = [];
  const collected = [];
  for (const raw of config.feeds) {
    const feed = resolveFeed(raw, ctx);
    const { entry, events } = await syncOneFeed(feed, { args, previous, ctx, fetchedAt, fetchImpl: env.fetchImpl });
    entries.push(entry);
    collected.push(...events);
  }

  const { feeds, events } = collateFeeds(entries, collected, ctxBase.cap);
  return publish(args, buildOutput({ now: args.now, tz: ctx.tz, window, feeds, events }));
}

/** Never throw uncaught: an unhandled rejection here would be exit 1 with a stack. */
async function main() {
  try {
    process.exitCode = await run(process.argv.slice(2), { fetchImpl: globalThis.fetch });
  } catch (e) {
    process.exitCode = fail(e?.stack ?? e?.message ?? String(e));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export default run;
