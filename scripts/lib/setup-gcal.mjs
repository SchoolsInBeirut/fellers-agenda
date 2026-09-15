// ===========================================================================
//  setup-gcal.mjs - the preflight's line for the inbound calendar
// ===========================================================================
//
//  WHY THIS EXISTS AT ALL
//  ----------------------
//  `calendars.gcal` was the one config block with no line in the preflight
//  table, and it is also the one whose failure mode is silence: it ships OFF,
//  an agenda that never enables it behaves exactly as before, and an agenda
//  that enabled it and then broke its connector gets an empty `meetings[]` -
//  which looks precisely like a calendar with nothing on it. So the preflight
//  has to say, out loud, which of those two a user is in.
//
//  IT REPORTS. IT DOES NOT VALIDATE.
//  ---------------------------------
//  Every shape rule for this block - `enabled` a real boolean, `feed` inside
//  `[a-z0-9-]{1,24}` and not the reserved `fb`, `maxEvents` a whole number in
//  range, the two guards strings-or-null - belongs to `validateCalendars()` in
//  `src/lib/config.mjs`, runs inside `loadConfig`, and is already reported by
//  the preflight's "Config validation" row with the offending key named. A
//  second copy of those rules here would be a second, wrong source of truth the
//  first time either moved. So this answers only the three questions a loader
//  cannot: is it on, WHICH ROUTE is it on, and has a run actually written
//  `data/gcal-items.json` yet.
//
//  THE TWO ROUTES
//  --------------
//  Route A is `src/connectors/gcal-sync.mjs`: the feeds file holds one secret
//  iCal address per calendar and a script does the fetch, which is the only
//  route a scheduled run can take. Route B is `src/connectors/gcal-ingest.mjs`:
//  an agent calls a calendar connector interactively and saves the answer. They
//  write the same document, so which one is live is invisible everywhere EXCEPT
//  here - and a user who put their addresses in the wrong place would otherwise
//  see a healthy-looking row above an empty calendar.
//
//  PURE. The caller reads both files and passes what it found, so a test needs
//  no temp directory.
// ===========================================================================

import { DEFAULTS } from "../../src/lib/config.mjs";

/** Where either route writes, relative to the repo root. */
export const GCAL_FILE = "data/gcal-items.json";

/** Where route A reads the secret addresses, relative to the repo root. */
export const GCAL_FEEDS_FILE = "data/gcal-feeds.json";

/**
 * The feed id `src/lib/config.mjs` defaults to when none is set - taken from
 * the loader's own DEFAULTS rather than copied, so changing it there cannot
 * leave this row naming a feed nothing uses.
 */
export const GCAL_DEFAULT_FEED = DEFAULTS.calendars.gcal.feed;

const NOTE = "NOTE";
const PASS = "PASS";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One preflight row for `calendars.gcal`.
 *
 * @param {object} cfg   a config that has already loaded - so its shape is
 *   whatever `src/lib/config.mjs` accepted, and a malformed one never gets here
 * @param {{exists?:boolean, status?:string|null}} file  what the caller found at
 *   `data/gcal-items.json`. `status` is the `feeds[0].status` whichever route
 *   ran wrote there: `"ok"`, `"stale"` or `"failed"`.
 * @param {{exists?:boolean, count?:number}} [feeds]  what the caller found at
 *   `data/gcal-feeds.json`: whether it is there, and how many feeds it names.
 *   Omit it entirely - as a caller that has not been taught about route A does -
 *   and the row simply says nothing about which route is live, rather than
 *   guessing that there is none.
 * @returns {{level:"NOTE"|"PASS", detail:string, fix:null}}
 */
export function checkGcal(cfg, file = {}, feeds = undefined) {
  const gcal = cfg?.calendars?.gcal;
  if (!isPlain(gcal) || gcal.enabled !== true) {
    return row(NOTE, "inbound calendar: off (opt-in, docs/CONFIG.md)");
  }
  const parts = [`on, feed "${gcalFeed(cfg)}"`, routeNote(feeds), fileNote(file)].filter(Boolean);
  return row(PASS, parts.join(" - "));
}

/**
 * Which route the user has actually set up. A count of zero is worth saying out
 * loud: a feeds file whose entries all have an empty url is the shape of a setup
 * half-finished, and route A treats it as no feeds at all.
 */
function routeNote(feeds) {
  if (!isPlain(feeds)) return null;
  if (!feeds.exists) return `route B: the connector route (no ${GCAL_FEEDS_FILE})`;
  const n = Number.isFinite(feeds.count) ? feeds.count : 0;
  return `route A: feeds file present, ${n} feed${n === 1 ? "" : "s"}`;
}

/** `calendars.gcal.feed`, or the shipped default when it is not set. */
export function gcalFeed(cfg) {
  const feed = cfg?.calendars?.gcal?.feed;
  return typeof feed === "string" && feed.trim() ? feed.trim() : GCAL_DEFAULT_FEED;
}

/** What `data/gcal-items.json` says, in one clause. */
function fileNote(file) {
  if (!file?.exists) return `${GCAL_FILE} not written yet - the next daily run creates it`;
  const status = typeof file.status === "string" && file.status ? file.status : "unknown";
  return `${GCAL_FILE} present, status "${status}"`;
}

const row = (level, detail) => Object.freeze({ level, detail, fix: null });
