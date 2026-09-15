// node --test test/auth-retry.test.mjs
//
// The auth lane's failure modes are asymmetric and both are expensive:
//
//   too quiet - a session expires overnight, the one re-auth the daily run is
//               allowed dies, and nothing on the machine asks again until
//               tomorrow's run. A whole day of stale agenda with no lane whose
//               job it was to notice.
//   too loud  - either two dozen pointless headless logins a day on a machine
//               where nothing is wrong, or - far worse - repeated attempts
//               against a password the school has already rejected, which locks
//               the account. The BAD-CREDS tests below are the important ones in
//               this file; nothing else here can cost the user their account.
//
// The THIRD failure mode is the second factor itself. Where the school uses
// NUMBER MATCHING rather than an approve/deny push, a number the user never sees
// is an unanswerable prompt, so a relay that arrives after the login finished is
// worth exactly nothing. The streaming test at the bottom is what defends that:
// it proves the number reaches the relay WHILE the child is still running, not
// when it exits.
//
// Nothing reads or writes the live repo: the pure core takes plain data, and the
// CLI tests each get their own mkdtemp repo, their own fake home holding a fake
// session file, and a fake re-auth that never launches a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideAuthRetry,
  applyOutcome,
  authRetrySettings,
  heavyTasks,
  HEAVY_LANES,
  laneTask,
  sessionFileFor,
  readSession,
  readAuthFailureAt,
  readRetryState,
  readLock,
  classifyExit,
  epochMs,
  newestMs,
  parseInstant,
  isoSeconds,
  authLine,
  nextAction,
  lockRecord,
  lastLine,
  extractMfaNumber,
  mfaMessage,
  screenAlert,
  pushHookPath,
  relayMfaNumber,
  runReauth,
  MFA_TTL_SEC,
  acquireInflight,
  releaseInflight,
  appendLine,
  parseArgs,
  cliMain,
  MIN_INTERVAL_MIN,
  LOCK_STALE_MIN,
  BAD_CREDS_CODE,
  TOKENS,
  EXIT,
} from "../src/auth-retry.mjs";
import { parseRunlog } from "../src/stale-check.mjs";
import { DEFAULTS } from "../src/lib/config.mjs";

// --- fixtures -------------------------------------------------------------

/** A LOCAL wall-clock instant. */
const local = (day, h, m = 0) => new Date(2026, 8, day, h, m, 0, 0);
const zulu = (d) => isoSeconds(d);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** The shipped defaults, which is what a repo with no `authRetry` block gets. */
const CFG = DEFAULTS;

/** A session that is alive for another `mins` minutes. */
const liveSession = (now, mins = 45) => ({
  exists: true,
  createdAt: now.getTime() - 15 * MIN,
  expiresAt: now.getTime() + mins * MIN,
  mtimeMs: now.getTime() - 15 * MIN,
});

/** A session minted `agoMin` ago and long since expired - the ordinary resting
 *  state of a perfectly healthy machine between daily runs. */
const expiredSession = (now, agoMin = 120) => ({
  exists: true,
  createdAt: now.getTime() - agoMin * MIN,
  expiresAt: now.getTime() - (agoMin - 60) * MIN,
  mtimeMs: now.getTime() - agoMin * MIN,
});

const NO_SESSION = { exists: false, createdAt: null, expiresAt: null, mtimeMs: null };

const decide = (now, over = {}) =>
  decideAuthRetry({
    now,
    session: over.session ?? expiredSession(now),
    authFailureAtMs: over.authFailureAtMs ?? null,
    state: over.state ?? {},
    locked: over.locked ?? null,
    taskStates: over.taskStates ?? {},
    enabled: over.enabled ?? true,
    hasSessionSource: over.hasSessionSource ?? true,
    minIntervalMin: over.minIntervalMin ?? MIN_INTERVAL_MIN,
  });

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auth-retry-"));
  const home = join(dir, "home");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(home, ".brightspace-mcp"), { recursive: true });
  mkdirSync(join(home, ".d2l-session"), { recursive: true });
  try {
    return await fn({
      dir,
      home,
      data,
      runlogFile: join(data, "runlog.txt"),
      stateFile: join(data, "auth-retry.json"),
      lockFile: join(data, "auth-locked.json"),
      inflightFile: join(data, "auth-retry.lock"),
      authFailureFile: join(data, "auth-failure.json"),
      sessionFile: join(home, ".brightspace-mcp", "session.json"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every seam a CLI test must inject so nothing reaches a browser, a scheduler
 *  or the user's real config. */
const wire = (t, over = {}) => ({
  dir: t.dir,
  dataDir: t.data,
  home: t.home,
  cfg: CFG,
  queryTaskState: () => "Ready",
  log: () => {},
  ...over,
});

/** A fake re-auth that records every call and never spawns anything. */
function fakeReauth(...outcomes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    run(arg) {
      calls.push(arg);
      const o = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      return typeof o === "number" ? { code: o, output: `[reauth] exit=${o}` } : o;
    },
  };
}

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean) : []);

// --- small pure helpers ---------------------------------------------------

test("classifyExit mirrors scripts/reauth.mjs's exit contract exactly", () => {
  assert.equal(classifyExit(0), "ok");
  assert.equal(classifyExit(2), "NO-CREDS");
  assert.equal(classifyExit(4), "USAGE");
  assert.equal(classifyExit(5), "BAD-CREDS");
  assert.equal(classifyExit(6), "MFA-PENDING");
  assert.equal(classifyExit(7), "NO-PACKAGE");
  assert.deepEqual(Object.keys(TOKENS).map(Number).sort((a, b) => a - b), [0, 2, 4, 5, 6, 7]);
  // Everything unmapped is a generic failure - and a generic failure is retried,
  // so nothing unknown may ever fall into the BAD-CREDS bucket by accident.
  for (const c of [1, 3, 8, -1, 137, null, undefined]) {
    assert.equal(classifyExit(c), "FAILED");
    assert.notEqual(classifyExit(c), "BAD-CREDS");
  }
});

test("epochMs rejects everything that is not a real positive timestamp", () => {
  assert.equal(epochMs(1788304080553), 1788304080553);
  for (const bad of [null, undefined, 0, -5, NaN, Infinity, "1788304080553", {}, []]) assert.equal(epochMs(bad), null);
});

test("newestMs picks the largest non-null and survives an all-null list", () => {
  assert.equal(newestMs([null, 100, undefined, 900, 400]), 900);
  assert.equal(newestMs([null, undefined, NaN, 0]), null);
  assert.equal(newestMs([]), null);
});

test("parseInstant returns null instead of an Invalid Date", () => {
  assert.equal(parseInstant("nope"), null);
  assert.equal(parseInstant(""), null);
  assert.equal(parseInstant(null), null);
  assert.equal(zulu(parseInstant("2026-09-02T11:37:54.491Z")), "2026-09-02T11:37:54Z");
});

test("lastLine takes the final meaningful line and caps its length", () => {
  assert.equal(lastLine("a\n\n  b  \n\n"), "b");
  assert.equal(lastLine(""), "");
  assert.equal(lastLine(null), "");
  assert.equal(lastLine("x".repeat(500)).length, 200);
});

// --- config ---------------------------------------------------------------

test("authRetrySettings defaults every key independently", () => {
  const d = authRetrySettings(CFG);
  assert.equal(d.enabled, true);
  assert.equal(d.minIntervalMin, 50);
  assert.equal(d.pushHook, null);
  assert.deepEqual(d.sessionFiles, DEFAULTS.authRetry.sessionFiles);

  // One key set, every other default intact.
  const one = authRetrySettings({ authRetry: { minIntervalMinutes: 15 } });
  assert.equal(one.minIntervalMin, 15);
  assert.equal(one.enabled, true);
  assert.deepEqual(one.sessionFiles, DEFAULTS.authRetry.sessionFiles);

  // Junk falls back rather than throwing or producing NaN.
  const junk = authRetrySettings({ authRetry: { minIntervalMinutes: "soon", sessionFiles: "nope", pushHook: "  " } });
  assert.equal(junk.minIntervalMin, MIN_INTERVAL_MIN);
  assert.deepEqual(junk.sessionFiles, DEFAULTS.authRetry.sessionFiles);
  assert.equal(junk.pushHook, null);
  assert.deepEqual(authRetrySettings(null), authRetrySettings({}));
});

test("the lane's task names come from scheduler.taskPrefix and nowhere else", () => {
  assert.deepEqual(heavyTasks(CFG), { daily: "Agenda Daily" });
  assert.equal(laneTask(CFG), "Agenda AuthRetry");
  const renamed = { ...CFG, scheduler: { ...CFG.scheduler, taskPrefix: "Study" } };
  assert.equal(laneTask(renamed), "Study AuthRetry");
  assert.deepEqual(heavyTasks(renamed), { daily: "Study Daily" });
  // 2.0.0 runs the pipeline once a day, so there is exactly one task that can
  // be holding the browser profile. The two watchdog tasks never authenticate,
  // so neither can collide with us and neither is consulted.
  assert.deepEqual(Object.keys(heavyTasks(CFG)), [...HEAVY_LANES]);
  for (const gone of ["morning", "evening", "sync"]) assert.equal(gone in heavyTasks(CFG), false);
});

test("sessionFileFor prefers a file that exists and opts out on an empty list", async () => {
  await withTempRepo(async ({ home }) => {
    // Nothing on disk yet: the FIRST candidate is still named, so "absent" has a
    // path to report rather than becoming an opt-out by accident.
    assert.equal(sessionFileFor(home, DEFAULTS.authRetry.sessionFiles), join(home, ".brightspace-mcp", "session.json"));

    writeFileSync(join(home, ".d2l-session", "session.json"), "{}");
    assert.equal(sessionFileFor(home, DEFAULTS.authRetry.sessionFiles), join(home, ".d2l-session", "session.json"));

    // The opt-out. A connector that keeps no session file gives this lane no way
    // to tell "expired" from "never logged in".
    assert.equal(sessionFileFor(home, []), null);
    assert.equal(sessionFileFor(home, null), null);
  });
});

// --- readers --------------------------------------------------------------

test("readSession: absent, corrupt and valid files all produce a usable shape", async () => {
  await withTempRepo(async ({ sessionFile }) => {
    assert.deepEqual(readSession(sessionFile), NO_SESSION);
    assert.deepEqual(readSession(null), NO_SESSION);

    writeFileSync(sessionFile, "{not json");
    const corrupt = readSession(sessionFile);
    assert.equal(corrupt.exists, true);
    assert.equal(corrupt.createdAt, null);
    assert.equal(corrupt.expiresAt, null);
    assert.ok(corrupt.mtimeMs > 0, "mtime still readable when the JSON is not");

    writeFileSync(
      sessionFile,
      JSON.stringify({ version: 1, createdAt: 1788300482620, expiresAt: 1788304080553, encrypted: { data: "SECRET" } }),
    );
    const good = readSession(sessionFile);
    assert.equal(good.createdAt, 1788300482620);
    assert.equal(good.expiresAt, 1788304080553);
    // The encrypted payload must never be carried out of the reader.
    assert.equal(JSON.stringify(good).includes("SECRET"), false);
    assert.deepEqual(Object.keys(good).sort(), ["createdAt", "exists", "expiresAt", "mtimeMs"]);
  });
});

test("readAuthFailureAt reads src/scrape.mjs's marker and shrugs at a broken one", async () => {
  await withTempRepo(async ({ authFailureFile }) => {
    assert.equal(readAuthFailureAt(authFailureFile), null);
    // The exact shape src/scrape.mjs writes on an auth failure.
    writeFileSync(authFailureFile, JSON.stringify({ at: "2026-09-02T11:37:54.491Z", connector: "lms-brightspace", error: "401" }));
    assert.equal(readAuthFailureAt(authFailureFile), Date.parse("2026-09-02T11:37:54.491Z"));
    writeFileSync(authFailureFile, "{{{");
    assert.equal(readAuthFailureAt(authFailureFile), null);
    writeFileSync(authFailureFile, JSON.stringify({ at: 12345 }));
    assert.equal(readAuthFailureAt(authFailureFile), null);
  });
});

test("readRetryState normalises junk rather than trusting it", () => {
  const st = readRetryState({
    lastCheckAt: "not-a-date",
    lastAttemptAt: "2026-09-02T12:00:00Z",
    lastToken: 7,
    lastCode: "5",
    consecutiveFailures: -3,
  });
  assert.equal(st.lastCheckAt, null);
  assert.equal(st.lastAttemptAt, "2026-09-02T12:00:00Z");
  assert.equal(st.lastToken, null);
  assert.equal(st.lastCode, null, "a string code must not masquerade as exit 5");
  assert.equal(st.consecutiveFailures, 0);
  assert.deepEqual(readRetryState(null), readRetryState({}));
});

test("readLock treats an unreadable tombstone as STILL LOCKED", async () => {
  await withTempRepo(async ({ lockFile }) => {
    assert.equal(readLock(lockFile), null);
    writeFileSync(lockFile, "corrupted beyond repair");
    const l = readLock(lockFile);
    assert.ok(l, "a lock file we cannot parse must never read as 'no lock'");
    assert.equal(l.token, "BAD-CREDS");
  });
});

// --- the decide table -----------------------------------------------------

test("locked out: nothing ever fires, however broken auth looks", () => {
  const now = local(2, 14);
  const locked = { at: "2026-09-02T09:00:00Z", token: "BAD-CREDS", detail: "rejected" };
  for (const session of [NO_SESSION, expiredSession(now), liveSession(now)]) {
    const got = decide(now, { session, locked, authFailureAtMs: now.getTime() - 5 * MIN });
    assert.equal(got.fire, false);
    assert.equal(got.reason, "locked-bad-creds");
  }
});

test("a lane the user switched off has no opinions at all", () => {
  const now = local(2, 14);
  const got = decide(now, { enabled: false, session: NO_SESSION, authFailureAtMs: now.getTime() - 5 * MIN });
  assert.equal(got.fire, false);
  assert.equal(got.reason, "lane-disabled");
});

test("a connector with no readable session file OPTS OUT rather than firing forever", () => {
  // Without a session file, "expired" is indistinguishable from "never logged
  // in", so this lane would land on no-session every single hour. Falling
  // through would be wrong for that connector in the most expensive direction.
  const now = local(2, 14);
  const got = decide(now, { hasSessionSource: false, session: NO_SESSION, authFailureAtMs: now.getTime() - 5 * MIN });
  assert.equal(got.fire, false);
  assert.equal(got.reason, "no-session-source");
  // ...and it never becomes a fire, whatever else is true.
  for (let h = 1; h <= 240; h *= 4) {
    const later = new Date(now.getTime() + h * HOUR);
    assert.equal(decide(later, { hasSessionSource: false, session: NO_SESSION }).fire, false);
  }
});

test("a live token is proof: quiet even with an outstanding failure record", () => {
  const now = local(2, 14);
  const got = decide(now, {
    session: liveSession(now),
    authFailureAtMs: now.getTime() - 5 * MIN,
    state: { lastFailureAt: zulu(new Date(now.getTime() - 5 * MIN)) },
  });
  assert.equal(got.fire, false);
  assert.equal(got.reason, "session-valid");
});

test("a token expiring within the skew window is NOT proof", () => {
  const now = local(2, 14);
  const session = { exists: true, createdAt: now.getTime() - HOUR, expiresAt: now.getTime() + 20 * 1000, mtimeMs: now.getTime() - HOUR };
  const got = decide(now, { session, authFailureAtMs: now.getTime() - 5 * MIN });
  assert.equal(got.fire, true);
  assert.equal(got.reason, "failure-after-success");
});

test("THE GOOD-DAY NO-OP: an expired session with no failure since is left alone", () => {
  // An LMS token lives about an hour, so between one daily run and the next the
  // session is expired almost all day on a machine where nothing is wrong.
  // Firing here would mean two dozen pointless SSO logins a day.
  const now = local(2, 14);
  const got = decide(now, { session: expiredSession(now, 300), authFailureAtMs: null });
  assert.equal(got.fire, false);
  assert.equal(got.reason, "no-failure-outstanding");
});

test("THE OUTAGE: a failure newer than the last success fires", () => {
  // Session minted the previous evening, a scrape recorded an auth failure the
  // next morning, and nothing succeeded in between.
  const now = local(2, 14);
  const session = { exists: true, createdAt: local(1, 18, 8).getTime(), expiresAt: local(1, 19, 8).getTime(), mtimeMs: local(1, 18, 8).getTime() };
  const got = decide(now, { session, authFailureAtMs: local(2, 7, 37).getTime() });
  assert.equal(got.fire, true);
  assert.equal(got.reason, "failure-after-success");
  assert.equal(got.detail.lastFailureAt, zulu(local(2, 7, 37)));
});

test("a success AFTER the failure closes the incident", () => {
  const now = local(2, 14);
  const session = { exists: true, createdAt: local(2, 13, 0).getTime(), expiresAt: local(2, 14, 0).getTime() - 1, mtimeMs: local(2, 13, 0).getTime() };
  const got = decide(now, { session, authFailureAtMs: local(2, 7, 37).getTime() });
  assert.equal(got.fire, false);
  assert.equal(got.reason, "no-failure-outstanding");
});

test("our own recorded failure keeps the lane hot with no auth-failure.json at all", () => {
  // The unanswered-prompt loop: scrape.mjs never runs again, so its marker never
  // moves. Only this lane's own memory keeps `failure-after-success` true.
  const now = local(2, 14);
  const got = decide(now, {
    session: expiredSession(now, 1200),
    authFailureAtMs: null,
    state: { lastFailureAt: zulu(local(2, 13, 0)), lastAttemptAt: zulu(local(2, 13, 0)), lastToken: "MFA-PENDING" },
  });
  assert.equal(got.fire, true);
  assert.equal(got.reason, "failure-after-success");
});

test("mtime is only a fallback: a real createdAt always wins", () => {
  const now = local(2, 14);
  // A session file that says it was minted before the failure, but whose mtime
  // was moved afterwards by something else. The file's own stamp is the truth.
  const session = { exists: true, createdAt: local(1, 18, 8).getTime(), expiresAt: local(1, 19, 8).getTime(), mtimeMs: now.getTime() - MIN };
  const got = decide(now, { session, authFailureAtMs: local(2, 7, 37).getTime() });
  assert.equal(got.fire, true);
  assert.equal(got.detail.lastSuccessAt, zulu(local(1, 18, 8)));

  // ...but with no parseable createdAt, mtime is all we have and is used.
  const noStamp = { exists: true, createdAt: null, expiresAt: null, mtimeMs: local(2, 13, 0).getTime() };
  assert.equal(decide(now, { session: noStamp, authFailureAtMs: local(2, 7, 37).getTime() }).fire, false);
});

test("no session file at all is unhealthy on its own", () => {
  const now = local(2, 14);
  const got = decide(now, { session: NO_SESSION });
  assert.equal(got.fire, true);
  assert.equal(got.reason, "no-session");
});

test("a bare machine with no evidence whatsoever never fires blind", () => {
  const now = local(2, 14);
  assert.equal(decide(now, { session: expiredSession(now), authFailureAtMs: null, state: {} }).fire, false);
});

test("throttle: a second attempt inside the floor is refused, at the floor it is allowed", () => {
  const now = local(2, 14);
  const tooSoon = decide(now, {
    session: NO_SESSION,
    state: { lastAttemptAt: zulu(new Date(now.getTime() - (MIN_INTERVAL_MIN - 1) * MIN)) },
  });
  assert.equal(tooSoon.fire, false);
  assert.match(tooSoon.reason, /^too-soon\(\d+m\)$/);
  assert.equal(tooSoon.detail.wouldFire, "no-session");

  const due = decide(now, { session: NO_SESSION, state: { lastAttemptAt: zulu(new Date(now.getTime() - MIN_INTERVAL_MIN * MIN)) } });
  assert.equal(due.fire, true);
});

test("the floor is configurable, and the hourly cadence is never self-blocked", () => {
  const now = local(2, 14);
  const at = (mins) => ({ session: NO_SESSION, state: { lastAttemptAt: zulu(new Date(now.getTime() - mins * MIN)) } });
  assert.equal(decide(now, { ...at(60) }).fire, true, "60 min > the 50 min floor, so every scheduled tick gets through");
  assert.equal(decide(now, { ...at(20), minIntervalMin: 15 }).fire, true);
  assert.equal(decide(now, { ...at(20), minIntervalMin: 30 }).fire, false);
  assert.equal(decide(now, { ...at(0), minIntervalMin: 0 }).fire, true, "a zero floor disables the throttle entirely");
});

test("a wildly future lastAttemptAt is corruption, not a permanent gag", () => {
  const now = local(2, 14);
  assert.equal(decide(now, { session: NO_SESSION, state: { lastAttemptAt: zulu(new Date(now.getTime() + 10 * HOUR)) } }).fire, true);
});

test("a daily run in progress defers rather than racing it for the browser", () => {
  const now = local(2, 14);
  for (const lane of HEAVY_LANES) {
    const got = decide(now, { session: NO_SESSION, taskStates: { [lane]: "Running" } });
    assert.equal(got.fire, false);
    assert.equal(got.reason, `heavy-run-in-progress(${lane})`);
    assert.equal(got.detail.wouldFire, "no-session");
    assert.equal(got.detail.busyLane, lane);
  }
  // A watchdog that goes quiet because a status query failed is worse than one
  // skipped hour, so `unknown` counts as not running.
  for (const state of ["Ready", "Disabled", "unknown", undefined]) {
    assert.equal(decide(now, { session: NO_SESSION, taskStates: { daily: state } }).fire, true, `${state} must not silence the lane`);
  }
  // A retired 1.x task cannot suppress anything, whatever its status still says.
  assert.equal(decide(now, { session: NO_SESSION, taskStates: { morning: "Running", evening: "Running" } }).fire, true);
});

// --- outcome folding ------------------------------------------------------

test("applyOutcome: success clears the failure marker and the counter", () => {
  const now = local(2, 14);
  const before = { lastFailureAt: zulu(local(2, 7, 37)), consecutiveFailures: 4, lastSuccessAt: zulu(local(1, 18, 8)) };
  const after = applyOutcome(before, { now, code: 0, token: "ok" });
  assert.equal(after.lastFailureAt, null);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.lastSuccessAt, zulu(now));
  assert.equal(after.lastToken, "ok");
  // ...and the machine now reads as healthy.
  assert.equal(decide(new Date(now.getTime() + HOUR), { session: expiredSession(now), state: after }).fire, false);
});

test("applyOutcome: any failure moves the marker forward and keeps the lane hot", () => {
  const now = local(2, 14);
  const after = applyOutcome({ consecutiveFailures: 1 }, { now, code: 6, token: "MFA-PENDING" });
  assert.equal(after.lastFailureAt, zulu(now));
  assert.equal(after.consecutiveFailures, 2);
  const later = new Date(now.getTime() + 61 * MIN);
  assert.equal(decide(later, { session: expiredSession(later, 1200), state: after }).fire, true);
});

test("applyOutcome never mutates the state it was handed", () => {
  const before = Object.freeze({ consecutiveFailures: 2, lastFailureAt: zulu(local(2, 7)) });
  const after = applyOutcome(before, { now: local(2, 14), code: 0, token: "ok" });
  assert.equal(before.consecutiveFailures, 2);
  assert.equal(before.lastFailureAt, zulu(local(2, 7)));
  assert.notEqual(after, before);
});

// --- log line + tombstone -------------------------------------------------

test("nextAction says retry for everything except success and bad creds", () => {
  assert.equal(nextAction(0), "authenticated");
  assert.equal(nextAction(BAD_CREDS_CODE), "STOPPED-bad-creds-see-data/auth-locked.json");
  for (const c of [1, 2, 4, 6, 7, 42]) assert.equal(nextAction(c), "retry-1h");
});

test("the AUTH line is one line and is INERT to stale-check's parser", () => {
  const now = local(2, 14);
  const line = authLine(now, { reason: "failure-after-success", token: "MFA-PENDING", code: 6, next: "retry-1h" });
  assert.equal(line.includes("\n"), false);
  assert.match(line, /^AUTH 2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z fire=reauth reason=\S+ result=\S+ exit=\d+ next=\S+$/);
  // If stale-check ever counted this as a run, a missed digest would silently
  // mark itself delivered. This is the coupling that matters.
  const got = parseRunlog([line, `${zulu(local(2, 10, 35))} run=daily items=80`].join("\n"));
  assert.equal(got.daily, 1);
  assert.equal(got.sync, 0);
  assert.equal(got.stale, 0);
  assert.equal(zulu(got.lastDailyAt), zulu(local(2, 10, 35)));
});

test("the tombstone explains itself and carries no secret", () => {
  const rec = lockRecord(local(2, 14), { code: 5, token: "BAD-CREDS", detail: "reauth=FAILED(BAD-CREDS) exit 5" });
  assert.equal(rec.code, 5);
  assert.match(rec.why, /lock the account/i);
  assert.match(rec.fix, /--setup/);
  assert.match(rec.fix, /--clear-lock/);
  assert.equal(lockRecord(local(2, 14), { code: 5, token: "BAD-CREDS", detail: "x".repeat(1000) }).detail.length, 300);
});

// --- the in-flight marker -------------------------------------------------

test("acquireInflight: taken once, refused while fresh, stolen when stale", async () => {
  await withTempRepo(async ({ inflightFile }) => {
    const now = local(2, 14);
    assert.equal(acquireInflight(inflightFile, now, 111).ok, true);
    const second = acquireInflight(inflightFile, new Date(now.getTime() + MIN), 222);
    assert.equal(second.ok, false);
    assert.match(second.held, /pid 111/);

    const later = new Date(now.getTime() + (LOCK_STALE_MIN + 1) * MIN);
    const stolen = acquireInflight(inflightFile, later, 333);
    assert.equal(stolen.ok, true);
    assert.equal(stolen.stolen, true);

    releaseInflight(inflightFile);
    assert.equal(existsSync(inflightFile), false);
    releaseInflight(inflightFile); // releasing twice is not an error
  });
});

test("appendLine repairs a missing trailing newline instead of joining lines", async () => {
  await withTempRepo(async ({ runlogFile }) => {
    writeFileSync(runlogFile, "SYNC 2026-09-02T17:03:21Z run=sync"); // no trailing \n
    appendLine(runlogFile, "AUTH 2026-09-02T18:03:00Z fire=reauth");
    assert.equal(lines(runlogFile).length, 2);
  });
});

// --- CLI ------------------------------------------------------------------

test("parseArgs accepts the documented flags and rejects anything else", () => {
  assert.equal(parseArgs(["--dry-run", "-v"]).dryRun, true);
  assert.equal(parseArgs(["--status"]).status, true);
  assert.equal(parseArgs(["--clear-lock"]).clearLock, true);
  assert.equal(zulu(parseArgs(["--now", "2026-09-02T18:00:00Z"]).now), "2026-09-02T18:00:00Z");
  assert.equal(parseArgs(["--config", "x.json", "--data", "d", "--home", "h"]).error, null);
  assert.equal(parseArgs(["--config=x.json", "--data=d"]).error, null);
  assert.match(parseArgs(["--now", "banana"]).error, /bad --now/);
  assert.match(parseArgs(["--wat"]).error, /unknown argument/);
});

test("cliMain: a bad argument is the script being broken, exit 1", async () => {
  await withTempRepo(async (t) => {
    assert.equal(await cliMain(["--nope"], wire(t)), EXIT.broken);
  });
});

// --- a config.json that will not load -------------------------------------
//
// This lane and the stale-run watchdog are the only things that can report a
// dead pipeline. A `config.json` with a trailing comma used to kill the run and
// BOTH of them on the same line, leaving a Node stack in runlog-stdout.txt and
// nothing anywhere a human would look.
test("cliMain: a config that will not load is one line and exit 1, never a stack", async () => {
  const bad = [
    ["{ trailing, comma", "not valid JSON"],
    [JSON.stringify({ namespace: "NOPE" }), "namespace"],
    [JSON.stringify({ notifications: { emailDigest: "gmail" } }), "notifications.emailDigest"],
  ];
  for (const [body, names] of bad) {
    await withTempRepo(async (t) => {
      const now = local(2, 14);
      const cfgPath = join(t.dir, "bad-config.json");
      writeFileSync(cfgPath, body);
      const reauth = fakeReauth(0);
      const errs = [];

      // `cfg` is deliberately NOT injected here: this is the one test that
      // exercises the real loader through the real CLI.
      const code = await cliMain(["--config", cfgPath], {
        dir: t.dir,
        dataDir: t.data,
        home: t.home,
        now,
        runReauth: reauth.run,
        queryTaskState: () => "Ready",
        log: () => {},
        logErr: (m) => errs.push(m),
      });

      assert.equal(code, EXIT.broken, `${names}: a config it cannot read means the lane is down`);
      assert.equal(errs.length, 2, `${names}: exactly two lines, got ${JSON.stringify(errs)}`);
      assert.ok(errs[0].startsWith("config: "), errs[0]);
      assert.ok(errs[0].includes(names), `${names} must be named: ${errs[0]}`);
      assert.equal(errs[0].includes("\n"), false, "one line, so Task Scheduler's log stays readable");
      assert.ok(!/\bat \S+:\d+:\d+/.test(errs.join("\n")), `a stack reached the user:\n${errs.join("\n")}`);
      assert.ok(!errs.join("\n").includes("ConfigError"), "the class name means nothing to a user");
      assert.equal(errs[1], "fix: node scripts/validate-setup.mjs");

      // No browser, no AUTH line - a login that never happened must not appear
      // in the one record this lane keeps of what it did.
      assert.equal(reauth.calls.length, 0);
      assert.equal(existsSync(t.runlogFile), false);
      assert.equal(existsSync(t.lockFile), false, "and nothing may look like a lockout");

      // ...but the heartbeat IS stamped, so /agenda-doctor can see the lane ran
      // and stopped rather than guessing it never fired at all.
      assert.equal(readJson(t.stateFile).lastCheckAt, zulu(now));
      assert.equal(readJson(t.stateFile).lastAttemptAt, null);
    });
  }
});

test("cliMain: a healthy machine writes only a heartbeat and never fires", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    writeFileSync(t.sessionFile, JSON.stringify({ createdAt: now.getTime() - 10 * MIN, expiresAt: now.getTime() + 50 * MIN }));
    const reauth = fakeReauth(0);
    assert.equal(await cliMain([], wire(t, { now, runReauth: reauth.run })), EXIT.ok);
    assert.equal(reauth.calls.length, 0, "a healthy machine must never launch a browser");
    assert.equal(readJson(t.stateFile).lastCheckAt, zulu(now));
    assert.equal(readJson(t.stateFile).lastAttemptAt, null);
    assert.equal(existsSync(t.runlogFile), false, "a quiet check adds nothing to the run log");
  });
});

test("cliMain: --dry-run and --status decide but write absolutely nothing", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    const reauth = fakeReauth(0);
    for (const flag of ["--dry-run", "--status"]) {
      const said = [];
      assert.equal(await cliMain([flag], wire(t, { now, runReauth: reauth.run, log: (m) => said.push(m) })), EXIT.ok);
      assert.equal(existsSync(t.stateFile), false);
      assert.equal(existsSync(t.runlogFile), false);
      assert.equal(reauth.calls.length, 0);
      assert.ok(said.join(" ").includes("no-session"));
    }
  });
});

test("cliMain: a connector with no session file is a quiet, permanent no-op", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    const reauth = fakeReauth(0);
    const said = [];
    const cfg = { ...CFG, authRetry: { ...CFG.authRetry, sessionFiles: [] } };
    assert.equal(await cliMain([], wire(t, { cfg, now, runReauth: reauth.run, log: (m) => said.push(m) })), EXIT.ok);
    assert.equal(reauth.calls.length, 0);
    assert.equal(existsSync(t.runlogFile), false);
    assert.ok(said.join(" ").includes("no-session-source"));
    assert.equal(readJson(t.stateFile).lastCheckAt, zulu(now), "the heartbeat still advances");
  });
});

test("cliMain: authRetry.enabled=false switches the lane off without touching anything", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    const reauth = fakeReauth(0);
    const said = [];
    const cfg = { ...CFG, authRetry: { ...CFG.authRetry, enabled: false } };
    assert.equal(await cliMain([], wire(t, { cfg, now, runReauth: reauth.run, log: (m) => said.push(m) })), EXIT.ok);
    assert.equal(reauth.calls.length, 0);
    assert.ok(said.join(" ").includes("lane-disabled"));
  });
});

test("cliMain: the outage path fires, logs one AUTH line and records success", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    writeFileSync(t.sessionFile, JSON.stringify({ createdAt: local(1, 18, 8).getTime(), expiresAt: local(1, 19, 8).getTime() }));
    writeFileSync(t.authFailureFile, JSON.stringify({ at: zulu(local(2, 7, 37)), connector: "lms-brightspace", error: "401" }));
    writeFileSync(t.runlogFile, `${zulu(local(2, 7, 3))} run=scheduled items=80\n`);

    const reauth = fakeReauth({ code: 0, output: "reauth=OK the session was refreshed" });
    assert.equal(await cliMain([], wire(t, { now, runReauth: reauth.run })), EXIT.ok);

    assert.equal(reauth.calls.length, 1);
    assert.equal(reauth.calls[0].dir, t.dir);
    const log = lines(t.runlogFile);
    assert.equal(log.length, 2);
    assert.match(log[1], /^AUTH .* result=ok exit=0 next=authenticated$/);
    const st = readJson(t.stateFile);
    assert.equal(st.lastSuccessAt, zulu(now));
    assert.equal(st.lastFailureAt, null);
    assert.equal(st.consecutiveFailures, 0);
    assert.equal(existsSync(t.inflightFile), false, "the in-flight marker is always released");
  });
});

test("cliMain: an unanswered two-factor prompt is retried - state stays hot, no lock", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    writeFileSync(t.sessionFile, JSON.stringify({ createdAt: local(1, 18, 8).getTime(), expiresAt: local(1, 19, 8).getTime() }));
    writeFileSync(t.authFailureFile, JSON.stringify({ at: zulu(local(2, 7, 37)) }));

    const reauth = fakeReauth({ code: 6, output: "reauth=FAILED(MFA-PENDING) exit 6" });
    assert.equal(await cliMain([], wire(t, { now, runReauth: reauth.run })), EXIT.ok);

    assert.equal(existsSync(t.lockFile), false, "an unanswered prompt must NEVER stop the lane");
    assert.match(lines(t.runlogFile).pop(), /result=MFA-PENDING exit=6 next=retry-1h$/);
    assert.equal(readJson(t.stateFile).lastFailureAt, zulu(now));
    assert.equal(readJson(t.stateFile).consecutiveFailures, 1);

    // ...and an hour later it fires again, which is the entire point: each retry
    // raises a FRESH prompt, so retrying is useful rather than merely noisy.
    const later = new Date(now.getTime() + 60 * MIN);
    const again = fakeReauth({ code: 6, output: "again" });
    await cliMain([], wire(t, { now: later, runReauth: again.run }));
    assert.equal(again.calls.length, 1);
    assert.equal(readJson(t.stateFile).consecutiveFailures, 2);
  });
});

test("cliMain: a crashed wrapper (exit 1) is retried just like a lost prompt", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    const reauth = fakeReauth({ code: 1, output: "reauth=FAILED(CRASH) exit 1\nNode.js v24.12.0" });
    await cliMain([], wire(t, { now, runReauth: reauth.run }));
    assert.equal(existsSync(t.lockFile), false);
    assert.equal(readJson(t.stateFile).lastToken, "FAILED");
    const later = new Date(now.getTime() + 60 * MIN);
    const again = fakeReauth({ code: 1, output: "same crash" });
    await cliMain([], wire(t, { now: later, runReauth: again.run }));
    assert.equal(again.calls.length, 1);
  });
});

test("cliMain: exit 4 (USAGE) retries but is never locked - it is OUR bug, not a login failure", async () => {
  // Retrying is harmless here (no push, no network, instant) and will never fix
  // itself, so the value is the climbing counter: a digest can then say "the
  // auth lane has failed twelve times with USAGE" instead of hiding a code bug.
  await withTempRepo(async (t) => {
    let now = local(2, 14);
    for (let i = 1; i <= 3; i++) {
      const reauth = fakeReauth({ code: 4, output: "reauth=FAILED(USAGE) unexpected argument" });
      assert.equal(await cliMain([], wire(t, { now, runReauth: reauth.run })), EXIT.ok);
      assert.equal(reauth.calls.length, 1, `did not retry on attempt ${i}`);
      assert.equal(existsSync(t.lockFile), false, "USAGE must never write a lock file");
      assert.equal(readJson(t.stateFile).consecutiveFailures, i);
      assert.equal(readJson(t.stateFile).lastToken, "USAGE");
      now = new Date(now.getTime() + HOUR);
    }
    assert.equal(lines(t.runlogFile).filter((l) => l.includes("result=USAGE")).length, 3);
  });
});

test("BAD CREDS: exit 5 locks the lane dead and it never fires again", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    const reauth = fakeReauth({ code: 5, output: "reauth=FAILED(BAD-CREDS) exit 5" });
    assert.equal(await cliMain([], wire(t, { now, runReauth: reauth.run })), EXIT.ok);

    assert.equal(existsSync(t.lockFile), true);
    assert.equal(readJson(t.lockFile).code, 5);
    assert.match(lines(t.runlogFile).pop(), /result=BAD-CREDS exit=5 next=STOPPED-bad-creds/);

    // Every later tick, for the rest of time, must be a no-op. This is the
    // account-lockout test and it is the most valuable one in this file.
    for (const h of [1, 2, 24, 240]) {
      const later = new Date(now.getTime() + h * HOUR);
      const again = fakeReauth({ code: 0, output: "must not happen" });
      const said = [];
      assert.equal(await cliMain([], wire(t, { now: later, runReauth: again.run, log: (m) => said.push(m) })), EXIT.ok);
      assert.equal(again.calls.length, 0, `fired ${h}h after a credential rejection`);
      assert.ok(said.join(" ").includes("locked-bad-creds"));
    }
    assert.equal(lines(t.runlogFile).filter((l) => l.startsWith("AUTH ")).length, 1, "a locked lane adds no further AUTH lines");
    assert.equal(readJson(t.stateFile).lastCode, 5);
  });
});

test("BAD CREDS: --clear-lock releases the lane, and a success clears it too", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    await cliMain([], wire(t, { now, runReauth: fakeReauth({ code: 5, output: "rejected" }).run }));
    assert.equal(existsSync(t.lockFile), true);

    assert.equal(await cliMain(["--clear-lock"], wire(t, { now })), EXIT.ok);
    assert.equal(existsSync(t.lockFile), false);
    assert.equal(await cliMain(["--clear-lock"], wire(t, { now })), EXIT.ok, "clearing twice is harmless");

    // Re-lock, then prove a successful login is also a valid way out.
    const later = new Date(now.getTime() + 2 * HOUR);
    await cliMain([], wire(t, { now: later, runReauth: fakeReauth({ code: 5, output: "again" }).run }));
    assert.equal(existsSync(t.lockFile), true);
    await cliMain(["--clear-lock"], wire(t, { now: later }));
    const ok = fakeReauth({ code: 0, output: "reauth=OK the session was refreshed" });
    await cliMain([], wire(t, { now: new Date(later.getTime() + 2 * HOUR), runReauth: ok.run }));
    assert.equal(ok.calls.length, 1);
    assert.equal(existsSync(t.lockFile), false);
  });
});

test("cliMain: a running daily task defers instead of racing it for the browser", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    const reauth = fakeReauth(0);
    const asked = [];
    const code = await cliMain(
      [],
      wire(t, {
        now,
        runReauth: reauth.run,
        queryTaskState: (name) => {
          asked.push(name);
          return name === "Agenda Daily" ? "Running" : "Ready";
        },
      }),
    );
    assert.equal(code, EXIT.ok);
    assert.equal(reauth.calls.length, 0);
    assert.equal(existsSync(t.runlogFile), false);
    assert.equal(readJson(t.stateFile).lastCheckAt, zulu(now));
    assert.ok(asked.includes("Agenda Daily"));
  });
});

test("cliMain: a fresh in-flight marker stops a second copy logging in twice", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    writeFileSync(t.inflightFile, JSON.stringify({ pid: 4242, startedAt: zulu(new Date(now.getTime() - MIN)) }));
    const reauth = fakeReauth(0);
    const said = [];
    assert.equal(await cliMain([], wire(t, { now, runReauth: reauth.run, log: (m) => said.push(m) })), EXIT.ok);
    assert.equal(reauth.calls.length, 0);
    assert.equal(existsSync(t.runlogFile), false);
    assert.ok(said.join(" ").includes("in flight"));
    assert.equal(readJson(t.stateFile).lastCheckAt, zulu(now), "the heartbeat still advances");
    assert.equal(existsSync(t.inflightFile), true, "someone else's marker is left alone");
  });
});

test("cliMain: the in-flight marker is released even when the login throws", async () => {
  await withTempRepo(async (t) => {
    const boom = () => {
      throw new Error("spawn ENOENT");
    };
    await assert.rejects(() => cliMain([], wire(t, { now: local(2, 14), runReauth: boom })));
    assert.equal(existsSync(t.inflightFile), false);
  });
});

test("cliMain: a fire never touches latest.json or any other lane's file", async () => {
  await withTempRepo(async (t) => {
    const latest = join(t.data, "latest.json");
    const staleState = join(t.data, "stale-check.json");
    writeFileSync(latest, '{"items":[]}');
    writeFileSync(staleState, '{"lastFiredAt":"2026-09-02T11:35:02Z"}');
    await cliMain([], wire(t, { now: local(2, 14), runReauth: fakeReauth(0).run }));
    assert.equal(readFileSync(latest, "utf8"), '{"items":[]}');
    assert.equal(readFileSync(staleState, "utf8"), '{"lastFiredAt":"2026-09-02T11:35:02Z"}');
  });
});

// --- number matching ------------------------------------------------------

test("extractMfaNumber finds the number the login flow prints, and only that", () => {
  assert.equal(extractMfaNumber("[WARN] MFA-NUMBER: 42 - enter this number in your authenticator app"), "42");
  assert.equal(extractMfaNumber("MFA-NUMBER:7"), "7");
  assert.equal(extractMfaNumber("  [WARN] SECOND-FACTOR CODE: 13 - match this on your phone"), "13");
  // Anything that is not the promised shape must not produce a number: relaying
  // a WRONG number is worse than relaying none, because the user types it.
  for (const noise of [
    "Discovered API versions: LP 1.63, LE 1.97",
    "[INFO] Restored 30 cookies from storage state",
    "reauth=OK the session was refreshed",
    "MFA-NUMBER: abc",
    "",
    null,
    undefined,
  ]) {
    assert.equal(extractMfaNumber(noise), null, `matched noise: ${noise}`);
  }
});

test("the relayed wording is short enough to read on a lock screen", () => {
  assert.equal(mfaMessage("42"), "Agenda login: enter 42 in your authenticator app");
  assert.ok(mfaMessage("42").length < 60);
});

test("screenAlert dispatches per platform and never invents a notifier", () => {
  const win = screenAlert("42", "win32");
  assert.match(win.command, /powershell/i);
  assert.ok(win.args.join(" ").includes("42"));
  const mac = screenAlert("42", "darwin");
  assert.equal(mac.command, "osascript");
  assert.ok(mac.args.join(" ").includes("42"));
  const linux = screenAlert("42", "linux");
  assert.equal(linux.command, "notify-send");
  assert.ok(linux.args.join(" ").includes("42"));
  // Nothing we can rely on: the file channel and the hook still deliver.
  assert.equal(screenAlert("42", "aix"), null);
});

test("pushHookPath follows the platform, and config overrides both", () => {
  assert.equal(pushHookPath("/repo", { platform: "win32" }), join("/repo", "data", "push-hook.cmd"));
  assert.equal(pushHookPath("/repo", { platform: "linux" }), join("/repo", "data", "push-hook.sh"));
  assert.equal(pushHookPath("/repo", { pushHook: "bin/notify.sh" }), join("/repo", "bin/notify.sh"));
  const abs = process.platform === "win32" ? "C:\\tools\\notify.cmd" : "/tools/notify.sh";
  assert.equal(pushHookPath("/repo", { pushHook: abs }), abs);
});

test("relayMfaNumber writes the file first and fires every channel it has", async () => {
  await withTempRepo(async ({ dir, data }) => {
    const spawned = [];
    const spawnFn = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { unref() {} };
    };
    const now = local(2, 14);
    const got = relayMfaNumber("42", { dir: data, root: dir, now, spawnFn, platform: "win32", log: () => {} });

    assert.equal(got.number, "42");
    assert.ok(got.delivered.includes("file"));
    assert.ok(got.delivered.includes("screen"));

    const rec = readJson(join(data, "auth-mfa.json"));
    assert.equal(rec.number, "42");
    assert.equal(rec.at, zulu(now));
    assert.equal(rec.expiresAboutAt, zulu(new Date(now.getTime() + MFA_TTL_SEC * 1000)));
    assert.match(rec.message, /enter 42 in your authenticator app/);

    // With no push hook on disk, only the on-screen alert spawns. The desktop
    // popup is a NON-network channel and stays detached, or it would hold the
    // login open past the ninety-second window.
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, "powershell.exe");
    assert.equal(spawned[0].opts.detached, true);
  });
});

test("relayMfaNumber runs a POSIX push hook directly and NEVER detached (FIX 2)", async () => {
  await withTempRepo(async ({ dir, data }) => {
    const hook = join(data, "push-hook.sh");
    writeFileSync(hook, "#!/bin/sh\n");
    const spawned = [];
    const spawnFn = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { unref() {} };
    };
    const got = relayMfaNumber("7", { dir: data, root: dir, now: local(2, 14), spawnFn, platform: "linux", log: () => {} });
    assert.ok(got.delivered.includes("push-hook"));
    const hookCall = spawned.find((c) => c.cmd === hook);
    assert.ok(hookCall, "the hook was not invoked");
    assert.equal(hookCall.args[0], mfaMessage("7"));
    assert.equal(hookCall.args[1], "7");
    // A POSIX shell hook is spawned directly - never wrapped in cmd.exe...
    assert.notEqual(hookCall.cmd, "cmd.exe");
    // ...and, crucially, a network push child must NOT be detached: a detached,
    // console-less child is reaped before curl finishes its write, so the push is
    // silently lost. Fire-and-forget is stdio:"ignore" + unref, never `detached`.
    assert.notEqual(hookCall.opts.detached, true);
    assert.equal(hookCall.opts.stdio, "ignore");
  });
});

test("relayMfaNumber invokes a Windows .cmd push hook THROUGH cmd.exe, undetached (FIX 1)", async () => {
  await withTempRepo(async ({ dir, data }) => {
    // A .cmd/.bat cannot be spawned directly on modern Node - spawn("x.cmd", ...)
    // throws EINVAL (the CVE-2024-27980 hardening). It must go through cmd.exe.
    const hook = join(data, "push-hook.cmd");
    writeFileSync(hook, "@echo off\r\n");
    const spawned = [];
    const spawnFn = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { unref() {} };
    };
    const got = relayMfaNumber("42", { dir: data, root: dir, now: local(2, 14), spawnFn, platform: "win32", log: () => {} });
    assert.ok(got.delivered.includes("push-hook"));

    const hookCall = spawned.find((c) => c.cmd === "cmd.exe");
    assert.ok(hookCall, "a .cmd hook must be spawned through cmd.exe, never directly");
    assert.deepEqual(hookCall.args, ["/d", "/c", hook, mfaMessage("42"), "42"]);
    // Never detached - see FIX 2 - and hidden, fire-and-forget.
    assert.notEqual(hookCall.opts.detached, true);
    assert.equal(hookCall.opts.stdio, "ignore");
    assert.equal(hookCall.opts.windowsHide, true);
    // The raw .cmd path must never itself be the spawn command (that is the EINVAL).
    assert.equal(spawned.some((c) => c.cmd === hook), false);
  });
});

test("a relay channel that throws never takes the login down with it", async () => {
  await withTempRepo(async ({ dir, data }) => {
    const boom = () => {
      throw new Error("no shell for you");
    };
    const got = relayMfaNumber("42", { dir: data, root: dir, now: local(2, 14), spawnFn: boom, log: () => {} });
    // The file channel cannot fail and is written first, so it still delivered.
    assert.deepEqual(got.delivered, ["file"]);
    assert.equal(readJson(join(data, "auth-mfa.json")).number, "42");
  });
});

test("the AUTH line carries mfa= only when a number was actually raised", () => {
  const now = local(2, 14);
  const withNum = authLine(now, { reason: "failure-after-success", token: "MFA-PENDING", code: 6, next: "retry-1h", mfa: "42" });
  assert.match(withNum, / exit=6 mfa=42 next=retry-1h$/);
  const without = authLine(now, { reason: "no-session", token: "ok", code: 0, next: "authenticated" });
  assert.equal(without.includes("mfa="), false);
  // Still one line, still inert to the run-log parser.
  const got = parseRunlog(withNum);
  assert.equal(got.daily + got.sync + got.stale, 0);
});

test("cliMain relays the number exactly once and records it on the AUTH line", async () => {
  await withTempRepo(async (t) => {
    const now = local(2, 14);
    const relayed = [];
    // A login that raises the prompt twice (a resend) must still relay once: the
    // second number would overwrite one the user is halfway through typing.
    const reauth = {
      run({ onLine }) {
        onLine("[INFO] Navigating to the identity provider");
        onLine("[WARN] MFA-NUMBER: 42 - enter this number in your authenticator app");
        onLine("[WARN] MFA-NUMBER: 99 - enter this number in your authenticator app");
        return { code: 6, output: "MFA-TIMEOUT: the authenticator number was never entered within 120 seconds" };
      },
    };
    assert.equal(await cliMain([], wire(t, { now, runReauth: reauth.run, relayMfaNumber: (n) => relayed.push(n) })), EXIT.ok);
    assert.deepEqual(relayed, ["42"]);
    assert.match(lines(t.runlogFile).pop(), /result=MFA-PENDING exit=6 mfa=42 next=retry-1h$/);
  });
});

test("STREAMING: the number reaches the relay while the login is still running", async () => {
  // The whole point. A number-matching prompt expires in ~60-90 s, so a relay
  // that waits for the child to exit is a relay that always arrives too late.
  // This drives the REAL runReauth against a real child process; if anybody
  // "simplifies" it back to a buffered execFileSync, this test fails.
  await withTempRepo(async ({ dir }) => {
    writeFileSync(
      join(dir, "scripts", "reauth.mjs"),
      [
        "console.log('[INFO] Starting browser authentication');",
        "console.log('[WARN] MFA-NUMBER: 42 - enter this number in your authenticator app');",
        "setTimeout(() => process.exit(6), 1200);",
      ].join("\n"),
    );

    const seen = [];
    let sawNumberAt = null;
    const started = Date.now();
    const result = await runReauth({
      dir,
      onLine: (line) => {
        seen.push(line);
        if (extractMfaNumber(line) && sawNumberAt === null) sawNumberAt = Date.now();
      },
    });
    const finishedAt = Date.now();

    assert.equal(result.code, 6);
    assert.equal(seen[0], "[INFO] Starting browser authentication");
    assert.equal(extractMfaNumber(seen[1]), "42");
    assert.ok(sawNumberAt !== null, "the number never reached onLine");
    assert.ok(
      finishedAt - sawNumberAt > 800,
      `the number arrived only ${finishedAt - sawNumberAt}ms before exit - that is buffering, not streaming`,
    );
    // Generous, because `node --test` runs files in parallel and a cold child
    // start under load is not a streaming failure. The assertion above is the
    // one that proves streaming; this only catches a truly wedged relay.
    assert.ok(sawNumberAt - started < 15000, "the number took absurdly long to arrive");
    // The full transcript is still available for the log line afterwards.
    assert.match(result.output, /MFA-NUMBER: 42/);
  });
});

test("runReauth reports a child that cannot start as a retryable failure, never 5", async () => {
  await withTempRepo(async ({ dir }) => {
    // No scripts/reauth.mjs in this temp repo at all.
    const result = await runReauth({ dir });
    assert.notEqual(result.code, 0);
    assert.notEqual(result.code, BAD_CREDS_CODE);
    assert.equal(nextAction(result.code), "retry-1h");
  });
});
