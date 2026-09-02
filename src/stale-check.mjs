#!/usr/bin/env node
// stale-check.mjs - the stale-RUN watchdog for the agenda.
//
// deadman.mjs answers "did the pipeline die?" from OUTSIDE the PC, hours later,
// by ringing an Exchange reminder. This file answers a smaller and more urgent
// question from INSIDE the PC, seconds after the laptop becomes usable again:
// "was a run supposed to have happened by now, and did it not?" If so it starts
// the run that was skipped, once, and gets out of the way.
//
// THE INCIDENT THIS EXISTS FOR
//   The morning task's last run was recorded as the PREVIOUS day's 07:03, and
//   its next run as the day AFTER tomorrow's. Today's 07:03 was never
//   attempted. StartWhenAvailable=true was already set, and it still did not
//   fire - that setting only rescues a run whose window the scheduler itself
//   decided to defer, not one the machine slept clean through. The user got no
//   digest and nothing anywhere said why.
//
// ---------------------------------------------------------------------------
// WHAT IT READS  (nothing else; no network, no Brightspace, no Drive)
//
//   data/runlog.txt      four lanes share this file and this file is the only
//                        durable record of what actually ran:
//                          heavy lane - line STARTS with an ISO timestamp
//                          sync  lane - line starts with the token `SYNC `
//                          stale lane - line starts with the token `STALE `
//                          auth  lane - line starts with the token `AUTH `
//                        The heavy question is answered ONLY by the heavy lane.
//                        A `SYNC ` line means the light loop ran, which is not a
//                        digest; a `STALE ` line is this file's own voice; and an
//                        `AUTH ` line (src/auth-retry.mjs) is a LOGIN attempt,
//                        not a run - it deliberately does not start with a bare
//                        ISO stamp, so parseRunlog treats it as noise and it can
//                        never be mistaken for a completed run. Counting any of
//                        the three as a heavy run is how a missed morning digest
//                        silently marks itself delivered.
//   data/stale-check.json  {"lastFiredAt":ISO,"lastFired":"morning|evening|
//                        sync","lastCheckAt":ISO} - the debounce memory.
//
// Timestamps in the log are written UTC (`...Z`); every BOUNDARY below is LOCAL
// wall-clock time, because 07:03 means the user's 07:03. Both sides become Date
// objects before anything is compared, so the timezone never enters the maths.
//
// ---------------------------------------------------------------------------
// THE DECISION  (decideStale() - pure, no clock of its own, no I/O)
//
//   Every number below is a DEFAULT that `config.scheduler` may override, and
//   the resolved set is passed in as `rules` - the decision never reads config
//   itself. The defaults are the ones this section describes.
//
//   boundaries      morning 07:03, evening 18:07, grace 20 min
//   heavy stale     now >= boundary + grace  AND  last heavy run < that boundary
//                   TODAY. Nothing older than today is ever considered: a run
//                   missed yesterday is water under the bridge, and the next
//                   boundary re-asks the question anyway.
//   both stale      only the LATEST boundary fires. At 19:00 with nothing since
//                   yesterday, one evening run rebuilds the same state two runs
//                   would have; the morning digest's moment has passed.
//   quiet hours     the heavy lane NEVER fires between 00:00 and 07:23 local.
//                   A `claude -p` session at 03:00 wakes fans, sends email and
//                   may push. So the 18:07 miss the user comes home to at 02:00
//                   is deliberately left alone: by 07:23 the morning boundary is
//                   stale too, and that one fire catches everything up.
//   sync stale      inside 09:00-23:00 local (the hours the Sync task itself
//                   covers), and no heavy AND no sync completion in the last 3h
//                   -> the light lane has gone quiet. Only ever considered when
//                   the heavy lane has nothing to say - a heavy run does the
//                   sync's whole job and more.
//   daily cap       at most TWO rescues per lane per LOCAL day, counted off the
//                   `STALE ` lines already in the run log. The trigger for
//                   "morning was missed" is "no heavy line dated after 07:03
//                   today", and a `claude -p` session that dies BEFORE writing
//                   its section-10 line leaves that true forever - which would
//                   re-fire every 25 minutes until 18:07. Two attempts is
//                   generous (the first covers a transient, the second covers a
//                   machine that was still waking up); a third is a loop, not a
//                   rescue. The cap is per lane and independent: two morning
//                   rescues do not spend the evening's. A capped lane does NOT
//                   fall through to a smaller one - same principle as Running.
//                   The ledger is the run log itself, so there is no new state
//                   file to keep in sync and the count survives anything.
//   already running the target task's state is Running -> do not fire, and do
//                   not fall through to a smaller lane either. Something is
//                   already working. An UNKNOWN state (the query failed) counts
//                   as not-running: MultipleInstancesPolicy=IgnoreNew is the
//                   real dedupe, and a watchdog that goes silent because it
//                   could not read a status is worse than one extra no-op run.
//   debounce        nothing fires within 25 min of the last fire, whatever lane
//                   it was. Logon + unlock + resume can all land inside one
//                   minute; without this the machine opening once would queue
//                   three runs. A lastFiredAt more than 25 min in the FUTURE is
//                   treated as a corrupt clock and ignored, so a bad stamp can
//                   never wedge the watchdog permanently.
//
// Firing is always `schtasks /Run /TN "<task name>"`, never scripts/run-heavy.cmd
// or scripts/run-sync.cmd directly. Going through the scheduler is what makes
// MultipleInstancesPolicy=IgnoreNew the arbiter, gives the run the same
// environment every other fire gets, and keeps LastRunTime honest. The task
// names come from `config.scheduler.taskPrefix` by way of `derive()`, so
// nothing in this file spells one out.
//
// `schtasks` is a Windows program. On any other platform this watchdog is a
// clean no-op that says so: the scheduled-task lane it rescues does not exist
// there, and `docs/SCHEDULING.md` covers launchd and cron instead.
//
// ---------------------------------------------------------------------------
// WHAT IT WRITES
//
//   data/stale-check.json  EVERY check, always - `lastCheckAt` is the only
//                          proof the watchdog itself is alive, and it is the
//                          first thing to look at when a run goes missing again.
//   data/runlog.txt        ONE line, ONLY when it actually fired:
//                            STALE <ISO> fired=<which> reason=<why>
//                          Quiet checks add nothing. This file runs every 30
//                          minutes; a heartbeat in the run log would bury both
//                          other lanes within a day. That line is also the
//                          daily cap's ledger - the watchdog reads its OWN
//                          lane back to learn how many rescues today has
//                          already had, per lane.
//   Nothing else, ever. It does not scrape, render, email, push, or touch any
//   other file in data/.
//
// A fire that schtasks REJECTS writes no STALE line and no lastFiredAt, so the
// next check retries. Only a fire that was actually accepted is remembered.
//
// ---------------------------------------------------------------------------
// CLI
//   node src/stale-check.mjs                    the scheduled behaviour
//   node src/stale-check.mjs --dry-run          decide and print, fire nothing,
//                                               write nothing at all
//   node src/stale-check.mjs --now <ISO>        pretend "now" is this instant
//   node src/stale-check.mjs --verbose          also print what it read
//   node src/stale-check.mjs --config <path>    use another config file
//   node src/stale-check.mjs --data <dir>       use another data directory
//
// Exit codes:
//   0  a decision was reached - INCLUDING "fired nothing" and including a fire
//      that schtasks refused. None of those are errors in this script.
//   1  the script itself broke (bad argument, unreadable/unwritable state file).
//      Exit 1 means "the watchdog is down", which is worth an eyebrow.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { derive, loadConfig } from "./lib/config.mjs";
import { argFlag, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";

// --- defaults -------------------------------------------------------------
//
// Each of these is what `config.scheduler` starts from. They are exported so a
// test can pin the contract's numbers, and so nothing has to guess what an
// unset key means.

/** Local wall-clock boundary of each heavy run, as the scheduler plants them. */
export const MORNING = { h: 7, m: 3 };
export const EVENING = { h: 18, m: 7 };

/** A run that starts at 07:03 is not late at 07:04. 20 min is the slack the
 *  scheduler itself needs (StartWhenAvailable defers, the agent session takes
 *  a moment to write its log line) before "late" means anything. */
export const GRACE_MIN = 20;

/** No heavy fire before this local minute-of-day. 07:23 = morning + grace, so
 *  the guard costs nothing on the morning path and blocks the whole night. */
export const QUIET_UNTIL_MIN = 7 * 60 + 23;

/** The hours the sync task covers (09:00..23:00, both ends inclusive). */
export const SYNC_WINDOW = { fromMin: 9 * 60, toMin: 23 * 60 };

/** Two sync fires are 2h apart; 3h means at least one was missed outright. */
export const SYNC_GAP_MIN = 180;

/** Longer than any plausible logon/unlock/resume burst, shorter than the 30-min
 *  repetition, so a genuinely stale machine still gets rechecked promptly. */
export const DEBOUNCE_MIN = 25;

/** Rescues per lane per LOCAL day. The debounce is a floor between fires, not a
 *  ceiling on them: a run that dies before writing its final log line leaves
 *  "that boundary was missed" true forever, and without this the lane would
 *  re-fire every 25 minutes until the next boundary. Two is the point where
 *  "retry" stops being a rescue and starts being a loop. */
export const DAILY_CAP = 2;

/** The resolved rule set `decideStale` works from when nothing overrides it. */
export const DEFAULT_RULES = Object.freeze({
  morning: MORNING,
  evening: EVENING,
  graceMin: GRACE_MIN,
  quietUntilMin: QUIET_UNTIL_MIN,
  syncWindow: SYNC_WINDOW,
  syncGapMin: SYNC_GAP_MIN,
  debounceMin: DEBOUNCE_MIN,
  dailyCap: DAILY_CAP,
});

export const EXIT = Object.freeze({ ok: 0, broken: 1 });

/** "07:03" -> {h:7,m:3}. Anything unparseable falls back, rather than throwing:
 *  a typo in one config key must not take the watchdog down. */
export function parseClock(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return { h, m: min };
}

const clockToMin = (hm) => hm.h * 60 + hm.m;
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Turn a `config.scheduler` block into the rule set `decideStale` takes.
 * PURE, and every field independently defaulted - a config that sets only
 * `graceMinutes` keeps every other default exactly as documented above.
 */
export function rulesFrom(scheduler = {}) {
  const s = scheduler && typeof scheduler === "object" ? scheduler : {};
  const window = Array.isArray(s.syncWindow) ? s.syncWindow : [];
  const from = parseClock(window[0], { h: 9, m: 0 });
  const to = parseClock(window[1], { h: 23, m: 0 });
  return {
    morning: parseClock(s.morningAt, MORNING),
    evening: parseClock(s.eveningAt, EVENING),
    graceMin: num(s.graceMinutes, GRACE_MIN),
    quietUntilMin: clockToMin(parseClock(s.quietUntil, { h: 7, m: 23 })),
    syncWindow: { fromMin: clockToMin(from), toMin: clockToMin(to) },
    syncGapMin: num(s.syncGapHours, 3) * 60,
    debounceMin: num(s.debounceMinutes, DEBOUNCE_MIN),
    dailyCap: num(s.maxRescuesPerLane, DAILY_CAP),
  };
}

/**
 * lane -> the scheduled task that owns it, derived from
 * `config.scheduler.taskPrefix`. Nothing else in this repo may name these.
 */
export function laneTasks(cfg) {
  const t = derive(cfg).taskNames;
  return Object.freeze({ morning: t.morning, evening: t.evening, sync: t.sync });
}

const MIN = 60 * 1000;

// An ISO instant as any of the lanes writes one: `2026-09-01T13:40:00Z`, with
// optional fractional seconds and an optional explicit offset.
const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`;
const HEAVY_RE = new RegExp(`^(${ISO})(?=\\s|$)`);
const SYNC_RE = new RegExp(`^SYNC\\s+(${ISO})(?=\\s|$)`);
// `STALE <ISO> fired=<lane> reason=<why>` - this script's own past decisions,
// read back so the daily cap needs no state file of its own.
const STALE_RE = new RegExp(`^STALE\\s+(${ISO})\\s+fired=(\\S+)`);

// --- pure core ------------------------------------------------------------

/** `new Date(s)` that returns null instead of an Invalid Date. */
export function parseInstant(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Split data/runlog.txt into its lanes and report the newest instant in each.
 *
 * `max` rather than `last line` on purpose: the two lanes interleave by arrival
 * and a run that finishes late can append a line whose timestamp predates the
 * one above it. The question is "when did a heavy run last complete", not "what
 * does the bottom of the file say".
 */
export function parseRunlog(text) {
  const out = {
    lastHeavyAt: null,
    lastSyncAt: null,
    staleFires: [],
    heavy: 0,
    sync: 0,
    stale: 0,
    lines: 0,
  };
  if (typeof text !== "string" || text.length === 0) return out;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    out.lines++;

    if (line.startsWith("STALE ") || line === "STALE") {
      // This script's own voice - never evidence that a RUN happened, but it is
      // evidence that a rescue was ATTEMPTED, which is what the cap counts.
      out.stale++;
      const stale = STALE_RE.exec(line);
      const at = stale ? parseInstant(stale[1]) : null;
      // A line whose stamp or lane will not parse cannot be attributed to a
      // lane or a day, so it is deliberately not counted against any cap.
      if (at) out.staleFires.push({ at, fired: stale[2] });
      continue;
    }

    const sync = SYNC_RE.exec(line);
    if (sync) {
      out.sync++;
      const at = parseInstant(sync[1]);
      if (at && (!out.lastSyncAt || at > out.lastSyncAt)) out.lastSyncAt = at;
      continue;
    }
    if (line.startsWith("SYNC")) {
      out.sync++;
      continue; // a SYNC line whose stamp will not parse: counted, not trusted
    }

    const heavy = HEAVY_RE.exec(line);
    if (!heavy) continue; // anything else is noise and stays noise
    const at = parseInstant(heavy[1]);
    if (!at) continue;
    out.heavy++;
    if (!out.lastHeavyAt || at > out.lastHeavyAt) out.lastHeavyAt = at;
  }
  return out;
}

/** Today's local wall-clock instant for `{h,m}`. */
export function boundaryToday(now, hm) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hm.h, hm.m, 0, 0);
}

/** Local minute-of-day, 0..1439. */
export function minuteOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

/** Same LOCAL calendar day. The log stamps UTC; "today" means the user's today,
 *  so a 22:00Z line is yesterday's rescue on an EDT machine and must not count
 *  against this morning's cap. */
export function sameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** How many rescues this lane has already had on `now`'s local day.
 *  Exported and pure so the cap can be reasoned about on its own. */
export function firesTodayFor(staleFires, now, lane) {
  if (!Array.isArray(staleFires)) return 0;
  return staleFires.filter((f) => f?.fired === lane && f?.at && sameLocalDay(f.at, now)).length;
}

/** UTC ISO to the second, matching how every other lane stamps its lines. */
export function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Normalise whatever came out of stale-check.json into the shape we rely on. */
export function readState(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    lastFiredAt: typeof o.lastFiredAt === "string" ? o.lastFiredAt : null,
    lastFired: ["morning", "evening", "sync"].includes(o.lastFired) ? o.lastFired : null,
    lastCheckAt: typeof o.lastCheckAt === "string" ? o.lastCheckAt : null,
  };
}

/**
 * The whole decision, as one pure function.
 *
 * @param {object}  input
 * @param {Date}    input.now         local "now"
 * @param {string}  input.runlog      raw contents of data/runlog.txt
 * @param {object}  [input.taskStates] lane -> "Ready"|"Running"|"Disabled"|
 *                                     "unknown". Missing lanes are unknown.
 * @param {object}  [input.state]     parsed data/stale-check.json
 * @param {object}  [input.rules]     the resolved boundary set (rulesFrom()).
 *                                    Defaults to DEFAULT_RULES so a caller that
 *                                    does not care about config need not build
 *                                    one. This function never reads config, a
 *                                    clock or the filesystem itself.
 * @returns {{fire: ("morning"|"evening"|"sync"|null), reason: string, detail: object}}
 *          `reason` is one of the three contract tokens when `fire` is set
 *          (missed-morning / missed-evening / sync-gap), and a diagnostic
 *          otherwise. `detail` is for humans and logs; nothing branches on it.
 */
export function decideStale({ now, runlog = "", taskStates = {}, state = {}, rules = DEFAULT_RULES } = {}) {
  const r = { ...DEFAULT_RULES, ...(rules ?? {}) };
  const log = parseRunlog(runlog);
  const st = readState(state);
  const nowMin = minuteOfDay(now);

  const morningAt = boundaryToday(now, r.morning);
  const eveningAt = boundaryToday(now, r.evening);
  const heavyAt = log.lastHeavyAt;
  const syncAt = log.lastSyncAt;
  const lastAny = heavyAt && syncAt ? (heavyAt > syncAt ? heavyAt : syncAt) : heavyAt || syncAt;

  const detail = {
    now: isoSeconds(now),
    lastHeavyAt: heavyAt ? isoSeconds(heavyAt) : null,
    lastSyncAt: syncAt ? isoSeconds(syncAt) : null,
    lanes: { heavy: log.heavy, sync: log.sync, stale: log.stale },
    quietHours: nowMin < r.quietUntilMin,
  };

  // --- 1. pick the candidate lane, ignoring debounce and task state ---------
  let fire = null;
  let reason = "";

  const past = (boundary) => now.getTime() >= boundary.getTime() + r.graceMin * MIN;
  const missing = (boundary) => !heavyAt || heavyAt.getTime() < boundary.getTime();

  if (!detail.quietHours) {
    // Latest boundary first: when both are stale only the evening one fires.
    if (past(eveningAt) && missing(eveningAt)) {
      fire = "evening";
      reason = "missed-evening";
    } else if (past(morningAt) && missing(morningAt)) {
      fire = "morning";
      reason = "missed-morning";
    }
  }

  if (!fire) {
    const inWindow = nowMin >= r.syncWindow.fromMin && nowMin <= r.syncWindow.toMin;
    const gapMin = lastAny ? (now.getTime() - lastAny.getTime()) / MIN : Infinity;
    detail.gapMin = Number.isFinite(gapMin) ? Math.round(gapMin) : null;
    if (inWindow && gapMin >= r.syncGapMin) {
      fire = "sync";
      reason = "sync-gap";
    } else if (detail.quietHours) {
      reason = "quiet-hours";
    } else if (!inWindow) {
      reason = "outside-sync-window";
    } else {
      reason = "nothing-stale";
    }
  }

  if (!fire) return { fire: null, reason, detail };

  // --- 2. gates that can only ever say no ----------------------------------
  // The cap goes first because it is the most permanent answer: a debounce
  // clears in 25 minutes, a cap holds until local midnight, and "capped" is the
  // more useful thing to read in a log. Like the Running gate, a capped lane
  // does NOT fall through to a smaller one - the answer is "no rescue", not
  // "some other rescue".
  const firedToday = firesTodayFor(log.staleFires, now, fire);
  detail.firedToday = firedToday;
  detail.dailyCap = r.dailyCap;
  if (firedToday >= r.dailyCap) {
    detail.wouldFire = fire;
    detail.wouldReason = reason;
    return { fire: null, reason: `capped-${fire}`, detail };
  }

  const firedAt = parseInstant(st.lastFiredAt);
  if (firedAt) {
    const sinceMin = (now.getTime() - firedAt.getTime()) / MIN;
    // Negative = the stamp is in the future. A small skew still debounces; a
    // wild one is corruption and must not silence the watchdog forever.
    const debounced = sinceMin >= 0 ? sinceMin < r.debounceMin : -sinceMin <= r.debounceMin;
    if (debounced) {
      detail.wouldFire = fire;
      detail.wouldReason = reason;
      return {
        fire: null,
        reason: `debounced(${st.lastFired ?? "?"},${Math.round(Math.abs(sinceMin))}m)`,
        detail,
      };
    }
  }

  const taskState = taskStates?.[fire] ?? "unknown";
  detail.taskState = taskState;
  if (String(taskState).toLowerCase() === "running") {
    detail.wouldFire = fire;
    detail.wouldReason = reason;
    return { fire: null, reason: `already-running(${fire})`, detail };
  }

  return { fire, reason, detail };
}

/** The one line this script is allowed to add to data/runlog.txt. */
export function staleLine(now, fire, reason) {
  return `STALE ${isoSeconds(now)} fired=${fire} reason=${reason}`;
}

// --- file helpers (path in, nothing global) -------------------------------

export function readTextFile(file) {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

export function readStateFile(file) {
  try {
    return readState(JSON.parse(readTextFile(file) || "{}"));
  } catch {
    return readState({}); // a corrupt debounce memory means "no memory", not a crash
  }
}

export function writeStateFile(file, state) {
  const out = {
    lastFiredAt: state.lastFiredAt ?? null,
    lastFired: state.lastFired ?? null,
    lastCheckAt: state.lastCheckAt ?? null,
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/** Append one line, repairing a missing trailing newline rather than joining
 *  onto somebody else's line. Never rewrites or trims - other lanes own that. */
export function appendLine(file, line) {
  const existing = readTextFile(file);
  const lead = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${lead}${line}\n`);
}

// --- schtasks bridge ------------------------------------------------------
//
// Windows only, and checked rather than assumed. On any other platform the
// lanes this watchdog rescues are not scheduled tasks at all, so querying and
// firing both become honest no-ops instead of a spawn that fails with a
// confusing ENOENT.

export const isWindows = () => process.platform === "win32";

function schtasks(args) {
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * "Ready" / "Running" / "Disabled" / "unknown".
 * `/FO CSV /NH` gives `"\Name","Next Run Time","Status"` - one row per pending
 * fire for a repeating task, so ANY row saying Running wins.
 */
export function queryTaskState(taskName) {
  if (!isWindows()) return "unknown";
  try {
    const out = schtasks(["/Query", "/TN", taskName, "/FO", "CSV", "/NH"]);
    const states = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const cols = l.match(/"([^"]*)"/g);
        return cols && cols.length ? cols[cols.length - 1].replace(/"/g, "").trim() : "";
      })
      .filter(Boolean);
    if (states.length === 0) return "unknown";
    if (states.some((s) => s.toLowerCase() === "running")) return "Running";
    return states[0];
  } catch {
    return "unknown";
  }
}

/** Fire a lane. Returns {ok, detail}; a refusal is data, not an exception. */
export function runTask(taskName) {
  if (!isWindows()) {
    return { ok: false, detail: `schtasks is Windows-only; see docs/SCHEDULING.md for ${process.platform}` };
  }
  try {
    const out = schtasks(["/Run", "/TN", taskName]);
    return { ok: true, detail: out.trim().split(/\r?\n/).filter(Boolean).pop() ?? "started" };
  } catch (err) {
    const text = `${err?.stderr ?? ""}${err?.stdout ?? ""}`.trim() || err?.message || "unknown error";
    return { ok: false, detail: text.split(/\r?\n/).filter(Boolean)[0] ?? "unknown error" };
  }
}

// --- CLI ------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, now: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--now") {
      const at = parseInstant(argv[++i]);
      if (!at) args.error = `bad --now value: ${argv[i] ?? "(missing)"}`;
      else args.now = at;
    } else if (a === "--config" || a === "--data") {
      i++; // resolved by src/lib/paths.mjs, which reads argv itself
    } else if (a.startsWith("--config=") || a.startsWith("--data=")) {
      /* same, in the `--flag=value` form */
    } else args.error = `unknown argument: ${a}`;
  }
  return args;
}

/**
 * @param {string[]} argv
 * @param {object} [opts] injection seams for the tests: `dir` (repo root),
 *        `dataDir`, `cfg`, `now`, `runTask`, `queryTaskState`, `log`.
 */
export function cliMain(argv, opts = {}) {
  const say = opts.log ?? ((m) => console.log(`[stale-check] ${m}`));
  const args = parseArgs(argv);
  if (args.error) {
    say(args.error);
    say("usage: node src/stale-check.mjs [--dry-run] [--now <ISO>] [--verbose] [--config <path>] [--data <dir>]");
    return EXIT.broken;
  }

  const root = opts.dir ?? repoRoot();
  const cfg = opts.cfg ?? loadConfig(argFlag(argv, "config") ?? null, { argv, warn: () => {} });
  const rules = rulesFrom(cfg.scheduler);
  const tasks = laneTasks(cfg);
  const dir = opts.dataDir ?? resolveDataDir(argv, root);
  const runlogFile = join(dir, "runlog.txt");
  const stateFile = join(dir, "stale-check.json");
  const fire = opts.runTask ?? runTask;
  const query = opts.queryTaskState ?? queryTaskState;
  const now = args.now ?? opts.now ?? new Date();

  const runlog = readTextFile(runlogFile);
  const state = readStateFile(stateFile);

  // Two passes so a quiet check costs zero schtasks spawns: only the lane that
  // is actually about to fire is worth asking about. decideStale is pure, so
  // the second call with the state filled in is the authoritative one.
  let decision = decideStale({ now, runlog, state, rules, taskStates: {} });
  if (decision.fire) {
    const lane = decision.fire;
    decision = decideStale({ now, runlog, state, rules, taskStates: { [lane]: query(tasks[lane]) } });
  }

  if (args.verbose) {
    const used = decision.detail.firedToday;
    const cap = used === undefined ? "n/a" : `${used}/${rules.dailyCap}`;
    say(`read heavy=${decision.detail.lastHeavyAt ?? "none"} sync=${decision.detail.lastSyncAt ?? "none"} lanes=${JSON.stringify(decision.detail.lanes)} rescuesToday=${cap}`);
  }

  if (args.dryRun) {
    say(`dry-run: fire=${decision.fire ?? "none"} reason=${decision.reason}`);
    return EXIT.ok;
  }

  const next = { ...state, lastCheckAt: isoSeconds(now) };

  if (!decision.fire) {
    say(`quiet: ${decision.reason}`);
    if (!writeState(stateFile, next, say)) return EXIT.broken;
    return EXIT.ok;
  }

  const taskName = tasks[decision.fire];
  const result = fire(taskName);
  if (!result.ok) {
    // Not this script's failure: no STALE line, no lastFiredAt, retry next check.
    say(`FAILED to start "${taskName}": ${result.detail}`);
    if (!writeState(stateFile, next, say)) return EXIT.broken;
    return EXIT.ok;
  }

  say(`fired ${decision.fire} ("${taskName}") reason=${decision.reason}`);
  next.lastFiredAt = isoSeconds(now);
  next.lastFired = decision.fire;
  try {
    appendLine(runlogFile, staleLine(now, decision.fire, decision.reason));
  } catch (err) {
    say(`could not append the STALE line: ${err?.message ?? err}`);
    return EXIT.broken;
  }
  if (!writeState(stateFile, next, say)) return EXIT.broken;
  return EXIT.ok;
}

function writeState(file, state, say) {
  try {
    writeStateFile(file, state);
    return true;
  } catch (err) {
    say(`could not write ${file}: ${err?.message ?? err}`);
    return false;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let code = EXIT.broken;
  try {
    code = cliMain(process.argv.slice(2));
  } catch (err) {
    console.log(`[stale-check] BROKEN: ${err?.stack ?? err}`);
  }
  process.exit(code);
}
