#!/usr/bin/env node
// auth-retry.mjs - the hourly "can we still log in?" watchdog.
//
// TWO WATCHDOGS, TWO DIFFERENT QUESTIONS
//
// `src/stale-check.mjs` asks "was a run supposed to have happened by now?".
// This file asks the smaller question that one runs into the moment a session
// expires overnight: "can this machine still talk to the LMS at all, and if
// not, has anything tried since it broke?"
//
// They are genuinely different. A run that fires on time, scrapes, hits a dead
// session and exits 2 has HAPPENED - so the stale-run watchdog is correct to
// stay silent, and no amount of tuning it would catch this. Meanwhile the daily
// run tries to re-authenticate exactly once, by rule, which on the shipped
// schedule means the retry interval for a failed login is twenty-four hours.
// Nobody owned the question in between, so this file does.
//
// ---------------------------------------------------------------------------
// WHAT IT READS  (four small files; no network of its own, no LMS calls, no MCP
// server, no browser - reading is always free)
//
//   <home>/<connector session file>  the minted token. Only `expiresAt`,
//                          `createdAt` and the file's mtime are read; whatever
//                          else the file holds is never touched and never
//                          logged. The candidate paths come from
//                          `authRetry.sessionFiles`, not from this file.
//   data/auth-failure.json  src/scrape.mjs writes this the moment a source
//                          comes back 401/expired. Its `at` is the timestamp of
//                          the last KNOWN auth break.
//   data/auth-retry.json   this lane's own memory (below).
//   data/auth-locked.json  the bad-credentials tombstone. Its mere EXISTENCE
//                          means "stop retrying, a human must act". See THE ONE
//                          STATE WE NEVER RETRY.
//
// ---------------------------------------------------------------------------
// THE DECISION  (decideAuthRetry() - pure, no clock of its own, no I/O)
//
//   lane disabled  authRetry.enabled is false -> the user turned this off.
//   locked out     data/auth-locked.json exists -> never fire, whatever else is
//                  true. Nothing in this file can clear it; only a SUCCESSFUL
//                  login (or `--clear-lock` by hand) does.
//   no source      the configured connector exposes no session file this lane
//                  can read. Without one, "expired" is unknowable and the lane
//                  would fire hourly forever, so it opts OUT rather than
//                  falling through. See authRetry.sessionFiles in docs/CONFIG.md.
//   session valid  `expiresAt` is more than a minute away -> a live token is
//                  proof, and proof beats every other signal including a stale
//                  failure record. Silent no-op.
//   no session     the session file is absent entirely -> nothing to be
//                  authorised with. Unhealthy.
//   failure after  the newest failure evidence is NEWER than the newest success
//   success        evidence -> the break has not been repaired. Unhealthy.
//                  This is the whole health test, and it is why a HEALTHY
//                  machine costs nothing: an LMS token lives about an hour, so
//                  an expired session is the pipeline's normal resting state
//                  between daily runs. Firing on "expired" alone would mean two
//                  dozen pointless headless logins a day. Firing on "expired
//                  AND the last thing that happened was a failure" fires only
//                  when something is actually wrong.
//   too soon       nothing fires within authRetry.minIntervalMinutes of the
//                  previous ATTEMPT. The task ticks hourly, so this never blocks
//                  the intended cadence; it blocks a burst (a manual run next to
//                  a scheduled one, or the catch-up fire after a lid opens).
//   run in flight  the daily task is Running -> skip. That run does its own
//                  re-auth, and two headless browsers on one persistent profile
//                  is a collision that crashes both. UNKNOWN counts as
//                  not-running: a watchdog that goes quiet because a status
//                  query failed is worse than one skipped hour.
//
// THE SECOND FACTOR MAY BE NUMBER MATCHING, WHICH CHANGES WHAT "RETRY" MEANS
//   Some identity providers do not send an approve/deny push. They render a
//   short number on the sign-in page and the user must TYPE that number into an
//   authenticator app within about 60-90 seconds. Headless, nobody can see that
//   page - so a login fired into an empty room is not "a push the user missed",
//   it is a prompt that was never answerable at all. Retrying it hourly without
//   relaying the number would repeat the same unanswerable prompt forever.
//
//   So the login flow prints `MFA-NUMBER: <n>` the instant the element renders
//   (see vendor/brightspace-mcp-server/entra-duo-sso.patch), this file reads the
//   child's output LINE BY LINE AS IT ARRIVES - never buffered, the number is
//   worthless after ~90 s - and relayMfaNumber() puts it in front of the user
//   immediately. Each retry produces a FRESH number and a fresh relay, which is
//   exactly what makes hourly retrying useful here rather than merely noisy.
//
// THE ONE STATE WE NEVER RETRY
//   exit 5 / BAD-CREDS means the school REJECTED the password. Institutions lock
//   accounts after a handful of bad attempts, so retrying that hourly would take
//   the user from "the agenda is stale" to "cannot log in to anything, call the
//   help desk". So exit 5 writes data/auth-locked.json and the lane stops dead.
//   Every OTHER outcome - an unanswered prompt (6), a crashed CLI (1), missing
//   credentials (2), a bad command line (4), a missing package (7) - is retried,
//   because none of them is an attempt against the school's password check.
//   classifyExit maps every unknown code to FAILED and never to BAD-CREDS, so
//   nothing can fall into the stop state by accident.
//
// ---------------------------------------------------------------------------
// WHAT IT WRITES
//
//   data/auth-retry.json   EVERY check, always. `lastCheckAt` is the only proof
//                          this lane is alive.
//   data/runlog.txt        ONE line, ONLY when it actually fired:
//                            AUTH <ISO> fire=reauth reason=<why> result=<token>
//                            exit=<n> [mfa=<n>] next=<what happens now>
//                          Quiet checks add nothing - this runs 24x a day and a
//                          heartbeat here would bury the daily lane in a
//                          fortnight. The `AUTH ` prefix is inert to
//                          stale-check.mjs's parser (it is not a bare ISO stamp,
//                          not `SYNC `, not `STALE `), so this lane can never be
//                          mistaken for a completed run - which would silently
//                          mark a missed digest as delivered.
//   data/auth-mfa.json     the number-matching digits, the moment they appear,
//                          with the ~90 s window they are good for. Overwritten
//                          each time; stale once `expiresAboutAt` passes.
//   data/auth-locked.json  created on exit 5, deleted on exit 0. Nothing else.
//   data/auth-retry.lock   an in-flight marker, removed on the way out. Stale
//                          after 10 min so a killed run cannot wedge the lane.
//
//   It never writes latest.json, never renders, never emails, never pushes a
//   digest, and never touches another lane's state.
//
// ---------------------------------------------------------------------------
// CLI
//   node src/auth-retry.mjs                the scheduled behaviour
//   node src/auth-retry.mjs --dry-run      decide and print; fire nothing, write nothing
//   node src/auth-retry.mjs --status       print what it can see, decide nothing
//   node src/auth-retry.mjs --now <ISO>    pretend "now" is this instant (diagnosis)
//   node src/auth-retry.mjs --clear-lock   remove the bad-credentials tombstone
//                                          after `scripts/reauth.mjs --setup`
//   node src/auth-retry.mjs --verbose      also print what it read
//   node src/auth-retry.mjs --config <path> --data <dir> --home <dir>
//
// Exit codes:
//   0  a decision was reached - INCLUDING "fired and the login failed". A failed
//      login is this lane working, not this lane broken.
//   1  the script itself broke (bad argument, unwritable state file, or a
//      config.json that will not load). A bad config prints ONE line naming the
//      key and one naming `scripts/validate-setup.mjs` - never a stack - fires
//      no login and writes no AUTH line, and still stamps `lastCheckAt` so the
//      doctor can see the lane ran and why it stopped.

import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { ConfigError, derive, loadConfig, DEFAULTS } from "./lib/config.mjs";
import { argFlag, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";

// --- constants ------------------------------------------------------------

/** A token expiring inside this window is already useless in practice: the
 *  scrape that would use it takes minutes. */
export const SESSION_SKEW_MS = 60 * 1000;

/** Default floor between two ATTEMPTS, overridable with
 *  `authRetry.minIntervalMinutes`. The task ticks every 60 min, so 50 leaves the
 *  intended cadence untouched while collapsing a burst into one fire. */
export const MIN_INTERVAL_MIN = 50;

/** An abandoned in-flight marker older than this is debris, not a running peer.
 *  reauth.mjs caps its own child at 5 min, so 10 cannot cut a live one. */
export const LOCK_STALE_MIN = 10;

/** Our ceiling on the child. reauth.mjs's internal cap is 5 min; this is the
 *  outer one, and the scheduled task's own limit is longer again. */
export const REAUTH_TIMEOUT_MS = 7 * 60 * 1000;

/** `scripts/reauth.mjs`'s exit-code contract, mirrored. Keep in step with the
 *  header of that file and with the exit-code table in AGENTS.md. */
export const TOKENS = Object.freeze({
  0: "ok",
  2: "NO-CREDS",
  4: "USAGE",
  5: "BAD-CREDS",
  6: "MFA-PENDING",
  7: "NO-PACKAGE",
});

/** The single exit code that must never be retried. */
export const BAD_CREDS_CODE = 5;

export const EXIT = Object.freeze({ ok: 0, broken: 1 });

const MIN = 60 * 1000;

// --- tiny helpers ---------------------------------------------------------

/** `new Date(s)` that returns null instead of an Invalid Date. */
export function parseInstant(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** UTC ISO to the second, matching how every other lane stamps its lines. */
export function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A finite positive epoch-ms number, or null. Guards against `null`, `"soon"`,
 *  `NaN` and 0 all arriving from a hand-edited or half-written JSON file. */
export function epochMs(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** The newest of a list of nullable epoch-ms values. */
export function newestMs(values) {
  let best = null;
  for (const v of values) {
    const n = epochMs(v);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

const msOfIso = (s) => {
  const d = parseInstant(s);
  return d ? d.getTime() : null;
};

/** Map a reauth.mjs exit code onto its contract token. */
export function classifyExit(code) {
  return TOKENS[code] ?? "FAILED";
}

// --- config -----------------------------------------------------------------

/**
 * Everything this lane takes from `config.authRetry`, defaulted key by key so a
 * config that sets only one of them keeps every other documented default.
 *
 * `sessionFiles` is the opt-out: a connector that exposes no readable session
 * file gives this lane no way to tell "expired" from "never logged in", so an
 * EMPTY list means "this lane does not apply here" rather than "fire forever".
 */
export function authRetrySettings(cfg) {
  const a = cfg?.authRetry && typeof cfg.authRetry === "object" ? cfg.authRetry : {};
  const files = Array.isArray(a.sessionFiles)
    ? a.sessionFiles.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim())
    : DEFAULTS.authRetry.sessionFiles;
  const min = Number(a.minIntervalMinutes);
  return {
    enabled: a.enabled !== false,
    sessionFiles: files,
    minIntervalMin: Number.isFinite(min) && min >= 0 ? min : MIN_INTERVAL_MIN,
    pushHook: typeof a.pushHook === "string" && a.pushHook.trim() ? a.pushHook.trim() : null,
  };
}

/**
 * The lanes whose runs do their OWN re-auth, and therefore the ones this lane
 * must not start a second headless browser alongside. 2.0.0 runs the pipeline
 * once a day, so this is the whole list: `<prefix> Daily` is the only task that
 * can be holding the persistent browser profile when we want it. The two
 * watchdog tasks never authenticate, so neither can ever collide with us.
 *
 * Derived from `config.scheduler.taskPrefix`; nothing in this file spells a
 * task name out.
 */
export function heavyTasks(cfg) {
  const t = derive(cfg).taskNames;
  return Object.freeze({ daily: t.daily });
}

/** The lane keys `heavyTasks` produces, for the pure decision - which has no
 *  config to derive them from. Keep the two in step. */
export const HEAVY_LANES = Object.freeze(["daily"]);

/** This lane's own scheduled task, for `--status` and the installer's table. */
export function laneTask(cfg) {
  return derive(cfg).taskNames.authRetry;
}

/**
 * The first candidate session file that exists under `home`, else the first
 * candidate at all (so "absent" still has a path to name), else null when the
 * connector opted out.
 */
export function sessionFileFor(home, candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) return null;
  for (const rel of list) {
    const p = join(home, ...String(rel).split("/"));
    if (existsSync(p)) return p;
  }
  return join(home, ...String(list[0]).split("/"));
}

// --- readers (path in, plain data out) ------------------------------------

export function readTextFile(file) {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    const text = readTextFile(file);
    if (!text) return null;
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null; // a corrupt file means "no information", never a crash
  }
}

/**
 * What we are allowed to know about a session file.
 * Deliberately narrow: three numbers and a boolean. Whatever else the file
 * holds - and on every connector shipped here that includes an encrypted token
 * blob - is never read, so no part of it can ever reach a log or a fixture.
 */
export function readSession(file) {
  if (!file || !existsSync(file)) return { exists: false, createdAt: null, expiresAt: null, mtimeMs: null };
  const j = readJson(file) ?? {};
  let mtimeMs = null;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  return {
    exists: true,
    createdAt: epochMs(j.createdAt),
    expiresAt: epochMs(j.expiresAt),
    mtimeMs: epochMs(mtimeMs),
  };
}

/** The instant of scrape.mjs's last recorded auth break, in epoch ms. */
export function readAuthFailureAt(file) {
  const j = readJson(file);
  return j ? msOfIso(typeof j.at === "string" ? j.at : null) : null;
}

/** Normalise whatever came out of data/auth-retry.json into the shape we use. */
export function readRetryState(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const iso = (v) => (typeof v === "string" && parseInstant(v) ? v : null);
  return {
    lastCheckAt: iso(o.lastCheckAt),
    lastAttemptAt: iso(o.lastAttemptAt),
    lastSuccessAt: iso(o.lastSuccessAt),
    lastFailureAt: iso(o.lastFailureAt),
    lastToken: typeof o.lastToken === "string" ? o.lastToken : null,
    lastCode: typeof o.lastCode === "number" ? o.lastCode : null,
    consecutiveFailures:
      typeof o.consecutiveFailures === "number" && o.consecutiveFailures >= 0
        ? Math.floor(o.consecutiveFailures)
        : 0,
  };
}

/** The bad-credentials tombstone, or null when the lane is free to fire. */
export function readLock(file) {
  const j = readJson(file);
  if (!j) return existsSync(file) ? { at: null, token: "BAD-CREDS", detail: "unreadable lock file" } : null;
  return { at: typeof j.at === "string" ? j.at : null, token: j.token ?? "BAD-CREDS", detail: j.detail ?? "" };
}

// --- pure core ------------------------------------------------------------

/**
 * The whole decision, as one pure function.
 *
 * @param {object}  input
 * @param {Date}    input.now              "now"
 * @param {object}  input.session          shape of readSession()
 * @param {?number} input.authFailureAtMs  epoch ms from data/auth-failure.json
 * @param {object}  [input.state]          parsed data/auth-retry.json
 * @param {?object} [input.locked]         parsed data/auth-locked.json, or null
 * @param {object}  [input.taskStates]     lane -> "Ready"|"Running"|"unknown"
 * @param {boolean} [input.enabled]        authRetry.enabled
 * @param {boolean} [input.hasSessionSource] false when the connector opted out
 * @param {number}  [input.minIntervalMin] the attempt floor, in minutes
 * @returns {{fire: boolean, reason: string, detail: object}}
 *          `reason` when firing is one of the health tokens (no-session /
 *          failure-after-success); otherwise it says why we stayed quiet.
 */
export function decideAuthRetry({
  now,
  session = {},
  authFailureAtMs = null,
  state = {},
  locked = null,
  taskStates = {},
  enabled = true,
  hasSessionSource = true,
  minIntervalMin = MIN_INTERVAL_MIN,
} = {}) {
  const st = readRetryState(state);
  const detail = { now: isoSeconds(now) };

  // --- 0. the three states that need no evidence at all --------------------
  if (enabled === false) return { fire: false, reason: "lane-disabled", detail };
  if (locked) {
    detail.lockedAt = locked.at ?? null;
    detail.lockedToken = locked.token ?? "BAD-CREDS";
    return { fire: false, reason: "locked-bad-creds", detail };
  }
  // A connector with no readable session file cannot distinguish "expired" from
  // "never logged in", so it would land on `no-session` every hour, forever.
  // Opting out is the only honest answer; docs/CONFIG.md says so too.
  if (hasSessionSource === false) return { fire: false, reason: "no-session-source", detail };

  // --- 1. is auth actually working right now? ------------------------------
  const expiresAt = epochMs(session.expiresAt);
  const sessionValid = expiresAt !== null && expiresAt > now.getTime() + SESSION_SKEW_MS;
  const exists = session.exists === true;

  // A session file only ever gets rewritten by a login that worked, so its
  // `createdAt` is success evidence even for a login this lane never made (a
  // daily run's own re-auth, or the user running `scripts/reauth.mjs` by hand).
  // mtime is the FALLBACK ONLY, for a session file whose JSON will not parse: it
  // is a far weaker signal (any tool that rewrites the file moves it) and must
  // never outrank the stamp the file itself carries.
  const sessionSuccessMs = epochMs(session.createdAt) ?? (exists ? epochMs(session.mtimeMs) : null);
  const successMs = newestMs([sessionSuccessMs, msOfIso(st.lastSuccessAt)]);
  const failureMs = newestMs([authFailureAtMs, msOfIso(st.lastFailureAt)]);

  Object.assign(detail, {
    sessionExists: exists,
    sessionValid,
    expiresAt: expiresAt ? isoSeconds(new Date(expiresAt)) : null,
    lastSuccessAt: successMs ? isoSeconds(new Date(successMs)) : null,
    lastFailureAt: failureMs ? isoSeconds(new Date(failureMs)) : null,
    consecutiveFailures: st.consecutiveFailures,
    lastToken: st.lastToken,
  });

  let unhealthy;
  let reason;
  if (sessionValid) {
    unhealthy = false;
    reason = "session-valid";
  } else if (!exists) {
    unhealthy = true;
    reason = "no-session";
  } else if (failureMs !== null && (successMs === null || successMs < failureMs)) {
    unhealthy = true;
    reason = "failure-after-success";
  } else {
    // Expired but nothing has failed since the last good login: the ordinary
    // resting state between daily runs. Not our business.
    unhealthy = false;
    reason = "no-failure-outstanding";
  }

  if (!unhealthy) return { fire: false, reason, detail };

  // --- 2. gates that can only ever say no ----------------------------------
  const floor = Number.isFinite(minIntervalMin) && minIntervalMin >= 0 ? minIntervalMin : MIN_INTERVAL_MIN;
  const lastAttemptMs = msOfIso(st.lastAttemptAt);
  if (lastAttemptMs !== null && floor > 0) {
    const sinceMin = (now.getTime() - lastAttemptMs) / MIN;
    // Negative = the stamp is in the future. A small skew still throttles; a
    // wild one is corruption and must not silence the lane forever.
    const tooSoon = sinceMin >= 0 ? sinceMin < floor : -sinceMin <= floor;
    if (tooSoon) {
      detail.wouldFire = reason;
      return { fire: false, reason: `too-soon(${Math.round(Math.abs(sinceMin))}m)`, detail };
    }
  }

  for (const lane of HEAVY_LANES) {
    const s = String(taskStates?.[lane] ?? "unknown").toLowerCase();
    if (s === "running") {
      detail.wouldFire = reason;
      detail.busyLane = lane;
      return { fire: false, reason: `heavy-run-in-progress(${lane})`, detail };
    }
  }

  return { fire: true, reason, detail };
}

/**
 * Fold one attempt's outcome into the next state, immutably.
 * Success clears the failure marker AND the consecutive counter; every other
 * outcome moves the failure marker forward, which is precisely what keeps
 * `failure-after-success` true and the lane retrying next hour.
 *
 * Exit 4 (USAGE) rides this path like any other failure on purpose. It means
 * this lane called reauth.mjs wrongly - a bug in us, not a login problem - and
 * retrying it is harmless (no push, no network, instant) but will never fix
 * itself. Letting `consecutiveFailures` climb is what lets a digest say "the
 * auth lane has failed twelve times with USAGE" instead of hiding a code bug.
 */
export function applyOutcome(state, { now, code, token }) {
  const st = readRetryState(state);
  const at = isoSeconds(now);
  const ok = code === 0;
  return {
    ...st,
    lastCheckAt: at,
    lastAttemptAt: at,
    lastToken: token,
    lastCode: code,
    lastSuccessAt: ok ? at : st.lastSuccessAt,
    lastFailureAt: ok ? null : at,
    consecutiveFailures: ok ? 0 : st.consecutiveFailures + 1,
  };
}

/** The one line this script is allowed to add to data/runlog.txt. `mfa=` appears
 *  only when a number-matching prompt was actually raised and relayed. */
export function authLine(now, { reason, token, code, next, mfa = null }) {
  const tail = mfa ? ` mfa=${mfa}` : "";
  return `AUTH ${isoSeconds(now)} fire=reauth reason=${reason} result=${token} exit=${code}${tail} next=${next}`;
}

/** What happens after this outcome - the human-readable half of the log line. */
export function nextAction(code) {
  if (code === 0) return "authenticated";
  if (code === BAD_CREDS_CODE) return "STOPPED-bad-creds-see-data/auth-locked.json";
  return "retry-1h";
}

/** The tombstone's contents. Never contains a password or any part of one. */
export function lockRecord(now, { code, token, detail }) {
  return {
    at: isoSeconds(now),
    code,
    token,
    detail: String(detail ?? "").slice(0, 300),
    why:
      "The school rejected the stored password. Retrying would lock the account, " +
      "so the hourly auth lane has STOPPED until a human fixes the credentials.",
    fix: "node scripts/reauth.mjs --setup   then   node src/auth-retry.mjs --clear-lock",
  };
}

// --- file helpers ---------------------------------------------------------

export function writeJsonFile(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Append one line, repairing a missing trailing newline rather than joining
 *  onto somebody else's line. Never rewrites or trims - other lanes own that. */
export function appendLine(file, line) {
  const existing = readTextFile(file);
  const lead = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${lead}${line}\n`);
}

/**
 * Take the in-flight marker, or report who holds it.
 * `wx` makes the create atomic, so two copies racing on one machine cannot both
 * win. A marker older than LOCK_STALE_MIN is debris from a killed run and is
 * stolen rather than obeyed.
 */
export function acquireInflight(file, now, pid = process.pid) {
  const body = JSON.stringify({ pid, startedAt: isoSeconds(now) }) + "\n";
  try {
    writeFileSync(file, body, { flag: "wx" });
    return { ok: true };
  } catch (err) {
    if (err?.code !== "EEXIST") return { ok: false, held: `unwritable: ${err?.message ?? err}` };
    const held = readJson(file) ?? {};
    const startedMs = msOfIso(typeof held.startedAt === "string" ? held.startedAt : null);
    const ageMin = startedMs === null ? Infinity : (now.getTime() - startedMs) / MIN;
    if (ageMin < LOCK_STALE_MIN) return { ok: false, held: `pid ${held.pid ?? "?"} started ${held.startedAt ?? "?"}` };
    try {
      writeFileSync(file, body); // steal: the previous holder is long gone
      return { ok: true, stolen: true };
    } catch (e2) {
      return { ok: false, held: `unwritable: ${e2?.message ?? e2}` };
    }
  }
}

export function releaseInflight(file) {
  try {
    unlinkSync(file);
  } catch {
    // Already gone, or never ours. Either way there is nothing to repair.
  }
}

// --- scheduler bridge -----------------------------------------------------
//
// Windows only, and checked rather than assumed - the same shape
// src/stale-check.mjs uses. On launchd and cron there is no per-task state to
// query, so "unknown" is the honest answer and the in-flight marker is the
// guard that actually matters there.

export const isWindows = () => process.platform === "win32";

/** "Ready" / "Running" / "Disabled" / "unknown". `/FO CSV /NH` gives one row per
 *  pending fire, so ANY row saying Running wins. */
export function queryTaskState(taskName) {
  if (!isWindows()) return "unknown";
  try {
    const out = execFileSync("schtasks.exe", ["/Query", "/TN", taskName, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

// --- number matching ------------------------------------------------------
//
// Where the school's second factor is NUMBER MATCHING rather than an
// approve/deny push, the sign-in page renders a short number and the user must
// type it into their authenticator app within about 60-90 seconds. Headless,
// nobody can see that number, so a fired login is unanswerable by definition
// unless we relay it. Everything below exists to get that number in front of the
// user inside seconds.

/** The two shapes the shipped login flow promises: `MFA-NUMBER: <n>` for Entra
 *  number matching, and `SECOND-FACTOR CODE: <n>` for a verified push. Same
 *  idea, same handling, both still reachable on different tenants. */
export const MFA_NUMBER_RE = /\b(?:MFA-NUMBER|SECOND-FACTOR CODE)\s*:\s*(\d{1,3})\b/;

/**
 * Pull the matching number out of ONE line of child output, or null.
 *
 * The 1-3 digit anchor is not decoration. Relaying a WRONG number is worse than
 * relaying none, because the user types it - so anything that is not purely
 * digits is discarded rather than guessed at.
 */
export function extractMfaNumber(line) {
  const m = MFA_NUMBER_RE.exec(String(line ?? ""));
  return m ? m[1] : null;
}

/** The wording the user sees, wherever it is delivered. Short on purpose: this
 *  has to be readable on a lock screen at a glance. */
export function mfaMessage(number) {
  return `Agenda login: enter ${number} in your authenticator app`;
}

/** How long the prompt is worth acting on. Number matching gives ~60-90 s. */
export const MFA_TTL_SEC = 90;

/**
 * The on-screen alert for this platform, as a plain {command, args} pair, or
 * null where there is no desktop notifier we can rely on.
 *
 * Pure so a test can pin all three without a desktop. The number is a validated
 * 1-3 digit string by the time it reaches here, so there is nothing to escape.
 */
export function screenAlert(number, platform = process.platform) {
  const body = `Enter ${number} in your authenticator app to finish the agenda login.`;
  const title = "Agenda - LMS login";
  if (platform === "win32") {
    // WScript.Shell.Popup: present on every Windows, needs nothing installed,
    // auto-dismisses, and 0x40040 = topmost + information icon.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `(New-Object -ComObject WScript.Shell).Popup('${body}',${MFA_TTL_SEC},'${title}',0x40040)`,
      ],
    };
  }
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", `display notification "${body}" with title "${title}"`] };
  }
  if (platform === "linux") {
    return { command: "notify-send", args: ["-u", "critical", "-t", String(MFA_TTL_SEC * 1000), title, body] };
  }
  return null;
}

/**
 * Where the optional push hook lives: `authRetry.pushHook` when set (relative
 * paths resolve against the repo root), else the platform's conventional name
 * under data/. Nothing is created here - the hook exists only if the user wrote
 * one, and docs/CONFIG.md carries a working example.
 */
export function pushHookPath(root, { pushHook = null, platform = process.platform } = {}) {
  if (pushHook) return isAbsolute(pushHook) ? pushHook : join(root, pushHook);
  return join(root, "data", platform === "win32" ? "push-hook.cmd" : "push-hook.sh");
}

/**
 * Get `number` in front of the user NOW. Every channel here is fire-and-forget:
 * the login is sitting in a 90-second window and nothing in this function may
 * block it, so no channel is awaited and no failure propagates.
 *
 *   1. data/auth-mfa.json  - durable, instant, and what a supervising session,
 *                            a digest or `--status` reads. Written FIRST because
 *                            it is the only channel that cannot fail.
 *   2. an on-screen alert  - a detached, auto-dismissing notification on the
 *                            machine itself. Needs no network and no
 *                            configuration, and the common case is a user
 *                            sitting right there. Platform-dispatched; see
 *                            screenAlert().
 *   3. the push hook       - OPTIONAL, and the seam where a real PHONE push
 *                            belongs. If the file exists it is run fire-and-forget
 *                            (unref'd, and NEVER `detached` - see FIX 2 below) with
 *                            the message as argv[1] and the number as argv[2]. A
 *                            Windows .cmd/.bat hook is invoked through cmd.exe
 *                            (FIX 1); a POSIX shell hook is spawned directly.
 *                            docs/CONFIG.md ships a one-line `curl` to ntfy.sh as
 *                            the worked example; Pushover, Telegram or any webhook
 *                            drop in the same way, with no provider hard-coded here.
 */
export function relayMfaNumber(
  number,
  { dir, root = dir, now = new Date(), log = () => {}, spawnFn = spawn, platform = process.platform, pushHook = null } = {},
) {
  const message = mfaMessage(number);
  const delivered = [];

  try {
    writeJsonFile(join(dir, "auth-mfa.json"), {
      number,
      message,
      at: isoSeconds(now),
      expiresAboutAt: isoSeconds(new Date(now.getTime() + MFA_TTL_SEC * 1000)),
      note: "Number matching. Type this number into your authenticator app. Stale after about 90s.",
    });
    delivered.push("file");
  } catch {
    // Nothing to repair: the alert below is the channel that matters most.
  }

  const detached = { detached: true, stdio: "ignore", windowsHide: true };
  const alert = screenAlert(number, platform);
  if (alert) {
    try {
      spawnFn(alert.command, alert.args, detached).unref();
      delivered.push("screen");
    } catch {
      // no dialog; the file and the hook remain
    }
  }

  // The push hook is the only channel that reaches a PHONE, and on Windows it is
  // almost always a curl to a notification service. Two Windows traps, both found
  // in a live cold-login test, decide how it is spawned - and neither is the way
  // the on-screen popup above is spawned:
  //
  //   FIX 1 - a .cmd/.bat hook CANNOT be spawned directly. Since Node's
  //     CVE-2024-27980 hardening, spawn("hook.cmd", ...) throws EINVAL, so a
  //     Windows batch hook must go through cmd.exe /d /c. A POSIX shell hook is
  //     still run directly, as before.
  //   FIX 2 - the push child must NOT be `detached`. A detached, console-less
  //     Windows child is reaped before curl finishes its network write, so the
  //     push is silently lost (the popup tolerates detachment; a network write
  //     does not). So it is fire-and-forget via stdio:"ignore" + windowsHide +
  //     .unref(), and deliberately without `detached`.
  const hook = pushHookPath(root, { pushHook, platform });
  if (existsSync(hook)) {
    try {
      const winBatch = platform === "win32" && /\.(?:cmd|bat)$/i.test(hook);
      const command = winBatch ? "cmd.exe" : hook;
      const args = winBatch ? ["/d", "/c", hook, message, String(number)] : [message, String(number)];
      spawnFn(command, args, { stdio: "ignore", windowsHide: true, cwd: root }).unref();
      delivered.push("push-hook");
    } catch {
      // an optional channel that failed is still optional
    }
  }

  log(`MFA NUMBER ${number} -> ${delivered.join("+") || "nowhere"} :: ${message}`);
  return { number, message, delivered };
}

// --- the fire -------------------------------------------------------------

/**
 * Run `scripts/reauth.mjs --silent` once and report its contract exit code.
 * We add NOTHING to the login itself: no password, no prompt, no browser flags.
 *
 * STREAMED, not buffered, and that is the whole point: `onLine` is called for
 * every line the moment it arrives, so a number-matching prompt reaches the user
 * while it is still live. Waiting for the child to exit would deliver the digits
 * minutes after they stopped working, which is the same as not delivering them.
 *
 * windowsHide keeps the headless child from flashing a console at a user who is
 * sitting in front of the screen.
 */
export function runReauth({ dir, home = null, config = null, data = null, onLine = () => {} } = {}) {
  const args = [join(dir, "scripts", "reauth.mjs"), "--silent"];
  if (home) args.push("--home", home);
  if (config) args.push("--config", config);
  if (data) args.push("--data", data);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 1, output: `[auth-retry] could not start the login: ${err?.message ?? err}` });
      return;
    }
    let output = "";
    let pending = "";
    let done = false;
    const finish = (code, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve({ code, output: output + extra });
    };
    const feed = (chunk) => {
      const text = chunk.toString();
      output += text;
      pending += text;
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i).replace(/\r$/, "");
        pending = pending.slice(i + 1);
        // A throwing relay must never kill a login that is otherwise fine.
        try {
          onLine(line);
        } catch {
          /* keep reading */
        }
      }
    };
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // Killed by our outer cap. Not a credential rejection, so never a 5.
      finish(1, `\n[auth-retry] timed out after ${REAUTH_TIMEOUT_MS / 60000} min`);
    }, REAUTH_TIMEOUT_MS);
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (err) => finish(1, `\n[auth-retry] ${err?.message ?? err}`));
    child.on("close", (code) => {
      if (pending.trim()) {
        try {
          onLine(pending.trim());
        } catch {
          /* last line only */
        }
      }
      finish(typeof code === "number" ? code : 1);
    });
  });
}

/** The last non-empty line of the child's output, for the log. Never a secret:
 *  reauth.mjs scrubs before anything reaches its stdout, and the full transcript
 *  it keeps in data/reauth-last-output.txt is scrubbed the same way. */
export function lastLine(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : "";
}

// --- CLI ------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, status: false, clearLock: false, now: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--status") args.status = true;
    else if (a === "--clear-lock") args.clearLock = true;
    else if (a === "--now") {
      const at = parseInstant(argv[++i]);
      if (!at) args.error = `bad --now value: ${argv[i] ?? "(missing)"}`;
      else args.now = at;
    } else if (a === "--config" || a === "--data" || a === "--home") {
      i++; // resolved by src/lib/paths.mjs and below, which read argv themselves
    } else if (a.startsWith("--config=") || a.startsWith("--data=") || a.startsWith("--home=")) {
      /* same, in the `--flag=value` form */
    } else args.error = `unknown argument: ${a}`;
  }
  return args;
}

export const USAGE =
  "usage: node src/auth-retry.mjs [--dry-run] [--status] [--clear-lock] [--now <ISO>]\n" +
  "                              [--verbose] [--config <path>] [--data <dir>] [--home <dir>]";

/**
 * @param {string[]} argv
 * @param {object} [opts] injection seams for the tests: `dir` (repo root),
 *        `dataDir`, `home`, `cfg`, `now`, `runReauth`, `queryTaskState`,
 *        `relayMfaNumber`, `log`, `logErr`.
 */
export async function cliMain(argv, opts = {}) {
  const say = opts.log ?? ((m) => console.log(`[auth-retry] ${m}`));
  const sayErr = opts.logErr ?? ((m) => console.error(`[auth-retry] ${m}`));
  const args = parseArgs(argv);
  if (args.error) {
    say(args.error);
    say(USAGE);
    return EXIT.broken;
  }

  const root = opts.dir ?? repoRoot();
  const dir = opts.dataDir ?? resolveDataDir(argv, root);
  const home = opts.home ?? argFlag(argv, "home") ?? homedir();
  const now = args.now ?? opts.now ?? new Date();
  const files = {
    runlog: join(dir, "runlog.txt"),
    state: join(dir, "auth-retry.json"),
    lock: join(dir, "auth-locked.json"),
    inflight: join(dir, "auth-retry.lock"),
    authFailure: join(dir, "auth-failure.json"),
  };

  // Loaded after the data directory is known, and inside a try, for the same
  // reason `stale-check.mjs` does it: the two watchdogs are the only things on
  // the machine that can report the run is gone, and a `config.json` with a
  // trailing comma would otherwise kill the run AND both of them on the same
  // line. A bad config is one line and exit 1 - no stack, no login, no AUTH
  // line - and the heartbeat is still stamped so the doctor can see the lane
  // ran and stopped.
  let cfg;
  if (opts.cfg) {
    cfg = opts.cfg;
  } else {
    try {
      cfg = loadConfig(argFlag(argv, "config") ?? null, { argv, warn: () => {} });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      // `err.message` already opens with "config: " - do not say it twice.
      sayErr(`config: ${String(err.message).split("\n")[0].replace(/^config:\s*/, "")}`);
      sayErr("fix: node scripts/validate-setup.mjs");
      try {
        writeJsonFile(files.state, readRetryState({ ...(readJson(files.state) ?? {}), lastCheckAt: isoSeconds(now) }));
      } catch {
        /* an unwritable data dir is already the louder problem; exit 1 says so */
      }
      return EXIT.broken;
    }
  }

  const settings = authRetrySettings(cfg);
  const tasks = heavyTasks(cfg);
  const sessionFile = sessionFileFor(home, settings.sessionFiles);
  const fire = opts.runReauth ?? runReauth;
  const query = opts.queryTaskState ?? queryTaskState;

  if (args.clearLock) {
    if (!existsSync(files.lock)) {
      say("no bad-credentials lock to clear.");
      return EXIT.ok;
    }
    try {
      unlinkSync(files.lock);
    } catch (err) {
      say(`could not remove ${files.lock}: ${err?.message ?? err}`);
      return EXIT.broken;
    }
    say("bad-credentials lock cleared - the hourly lane will retry from the next tick.");
    return EXIT.ok;
  }

  const session = readSession(sessionFile);
  const authFailureAtMs = readAuthFailureAt(files.authFailure);
  const state = readRetryState(readJson(files.state) ?? {});
  const locked = readLock(files.lock);
  const base = {
    now,
    session,
    authFailureAtMs,
    state,
    locked,
    enabled: settings.enabled,
    hasSessionSource: sessionFile !== null,
    minIntervalMin: settings.minIntervalMin,
  };

  // Two passes so a quiet check costs zero scheduler spawns: only ask about the
  // daily task when we are otherwise about to fire. decideAuthRetry is pure, so
  // the second call - with the states filled in - is the authoritative one.
  let decision = decideAuthRetry({ ...base, taskStates: {} });
  if (decision.fire) {
    const taskStates = {};
    for (const [lane, taskName] of Object.entries(tasks)) taskStates[lane] = query(taskName);
    decision = decideAuthRetry({ ...base, taskStates });
  }

  if (args.status || args.verbose) {
    say(
      `session file=${sessionFile ?? "(none configured)"} exists=${session.exists} ` +
        `valid=${decision.detail.sessionValid ?? false} expires=${decision.detail.expiresAt ?? "n/a"}`,
    );
    say(
      `lastSuccess=${decision.detail.lastSuccessAt ?? "none"} lastFailure=${decision.detail.lastFailureAt ?? "none"} ` +
        `lock=${locked ? `BAD-CREDS since ${locked.at ?? "?"}` : "none"} fails=${state.consecutiveFailures}`,
    );
  }
  if (args.status) {
    say(`status: would ${decision.fire ? "FIRE" : "stay quiet"} (${decision.reason})`);
    return EXIT.ok;
  }
  if (args.dryRun) {
    say(`dry-run: fire=${decision.fire} reason=${decision.reason}`);
    return EXIT.ok;
  }

  if (!decision.fire) {
    say(`quiet: ${decision.reason}`);
    return writeState(files.state, { ...state, lastCheckAt: isoSeconds(now) }, say) ? EXIT.ok : EXIT.broken;
  }

  // Nothing below may run twice at once: the login drives a persistent browser
  // profile that a second copy would corrupt.
  const inflight = acquireInflight(files.inflight, now);
  if (!inflight.ok) {
    say(`another auth attempt is in flight (${inflight.held}); leaving it alone.`);
    return writeState(files.state, { ...state, lastCheckAt: isoSeconds(now) }, say) ? EXIT.ok : EXIT.broken;
  }

  // The number-matching relay. This runs INSIDE the login, on the very line that
  // carries the digits, because the prompt is only worth answering for ~90 s.
  // Only the FIRST number is relayed: a resend would overwrite a number the user
  // is halfway through typing.
  const relay = opts.relayMfaNumber ?? relayMfaNumber;
  let mfaNumber = null;
  const onLine = (line) => {
    if (mfaNumber !== null) return; // one prompt, one relay
    const n = extractMfaNumber(line);
    if (n === null) return;
    mfaNumber = n;
    relay(n, { dir, root, now: new Date(), log: say, pushHook: settings.pushHook });
  };

  let result;
  try {
    say(`firing scripts/reauth.mjs --silent (reason=${decision.reason})`);
    result = await fire({
      dir: root,
      home: opts.home ?? argFlag(argv, "home") ?? null,
      config: argFlag(argv, "config"),
      data: argFlag(argv, "data"),
      onLine,
    });
  } finally {
    releaseInflight(files.inflight);
  }

  const code = typeof result?.code === "number" ? result.code : 1;
  const token = classifyExit(code);
  const detail = lastLine(result?.output);
  const next = nextAction(code);
  const after = applyOutcome(state, { now, code, token });

  if (code === BAD_CREDS_CODE) {
    // Stop dead and leave the loud note. Written BEFORE the state file so a
    // crash in between can only ever fail safe - locked, not looping.
    try {
      writeJsonFile(files.lock, lockRecord(now, { code, token, detail }));
    } catch (err) {
      say(`could not write the bad-credentials lock: ${err?.message ?? err}`);
      return EXIT.broken;
    }
    say("BAD-CREDS: the school rejected the stored password. Lane STOPPED; run --setup, then --clear-lock.");
  } else if (code === 0 && existsSync(files.lock)) {
    // Any successful login proves the credentials are good again.
    try {
      unlinkSync(files.lock);
      say("cleared the bad-credentials lock after a successful login.");
    } catch (err) {
      say(`could not clear ${files.lock}: ${err?.message ?? err}`);
    }
  }

  say(`result=${token} exit=${code} next=${next}${mfaNumber ? ` mfa=${mfaNumber}` : ""}${detail ? " :: " + detail : ""}`);
  try {
    appendLine(files.runlog, authLine(now, { reason: decision.reason, token, code, next, mfa: mfaNumber }));
  } catch (err) {
    say(`could not append the AUTH line: ${err?.message ?? err}`);
    return EXIT.broken;
  }
  return writeState(files.state, after, say) ? EXIT.ok : EXIT.broken;
}

function writeState(file, state, say) {
  try {
    writeJsonFile(file, readRetryState(state));
    return true;
  } catch (err) {
    say(`could not write ${file}: ${err?.message ?? err}`);
    return false;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let code = EXIT.broken;
  try {
    code = await cliMain(process.argv.slice(2));
  } catch (err) {
    console.log(`[auth-retry] BROKEN: ${err?.stack ?? err}`);
  }
  process.exit(code);
}
