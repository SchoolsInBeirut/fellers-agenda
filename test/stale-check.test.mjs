// node --test test/stale-check.test.mjs   (run from the repository root)
//
// The watchdog's failure modes are asymmetric and both are bad, so every rule
// here gets its positive case AND the negative that matters:
//
//   too quiet - the incident repeats, the user gets no digest, and nothing
//               anywhere says why. This is the one the file exists for.
//   too loud  - a rescue run at 03:00, or three of them stacked on one
//               laptop-open, each sending mail and a push. That is how a user
//               disables a watchdog, and then it protects nothing at all.
//
// 2.0.0 has ONE lane. The suite carries two extra jobs because of that: the
// 1.x `SYNC ` lines still sitting in everybody's run log must read as noise and
// never as a run, and the quiet window now has a CEILING as well as a floor.
//
// Every instant is built LOCAL and converted to the UTC `...Z` form the run log
// actually stores, so the suite says the same thing in any timezone.
//
// Nothing here reads or writes the live repo: the pure core takes runlog TEXT,
// and the CLI tests each get their own mkdtemp repo with a fake schtasks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideStale,
  parseRunlog,
  parseInstant,
  sameLocalDay,
  firesTodayFor,
  readState,
  readStateFile,
  writeStateFile,
  appendLine,
  staleLine,
  boundaryToday,
  minuteOfDay,
  isoSeconds,
  parseArgs,
  cliMain,
  laneTasks,
  rulesFrom,
  parseClock,
  DAILY,
  DEFAULT_RULES,
  EXIT,
  GRACE_MIN,
  DEBOUNCE_MIN,
  QUIET_UNTIL_MIN,
  QUIET_FROM_MIN,
  DAILY_CAP,
} from "../src/stale-check.mjs";
import { derive } from "../src/lib/config.mjs";

/** The lane -> task-name map for the default namespace, derived exactly the way
 *  the CLI derives it. Nothing in the suite spells a task name out by hand. */
const TASKS = laneTasks({});

// --- fixtures -------------------------------------------------------------

/** A LOCAL wall-clock instant. Tuesday 2026-09-01 is the incident's date. */
const local = (day, h, m = 0) => new Date(2026, 8, day, h, m, 0, 0);
/** ...rendered the way every lane of data/runlog.txt stamps its lines. */
const zulu = (d) => isoSeconds(d);

const dailyLine = (d, tail = "run=daily scrape=ok(81) render=ok drive=ok(7KB;rclone;verified)") =>
  `${zulu(d)} ${tail}`;
/** A 1.x line. The lane is gone; the lines are not, and never will be. */
const syncLine = (d, tail = "run=sync fcmd=applied=0 render=ok drive=ok(doc-replaced)") =>
  `SYNC ${zulu(d)} ${tail}`;
const staleLineFixture = (d, which = "daily", why = "missed-daily") =>
  `STALE ${zulu(d)} fired=${which} reason=${why}`;

/** 2026-08-31 10:42 local - the newest real daily line before the miss. */
const YESTERDAY = new Date(2026, 7, 31, 10, 42, 0, 0);

const decide = (now, runlog, over = {}) =>
  decideStale({ now, runlog, taskStates: over.taskStates ?? {}, state: over.state ?? {}, rules: over.rules });

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "stale-check-"));
  mkdirSync(join(dir, "data"));
  try {
    return fn({
      dir,
      runlogFile: join(dir, "data", "runlog.txt"),
      stateFile: join(dir, "data", "stale-check.json"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fake schtasks that records what it was asked to start. */
function recorder(ok = true, detail = "SUCCESS") {
  const calls = [];
  return {
    calls,
    run(taskName) {
      calls.push(taskName);
      return { ok, detail };
    },
  };
}

// --- lane parsing ---------------------------------------------------------

test("parseRunlog: empty, blank and absent input never throws", () => {
  for (const input of ["", "   \n\n  \r\n", undefined, null, 12, {}]) {
    const got = parseRunlog(input);
    assert.equal(got.lastDailyAt, null);
    assert.equal(got.lastSyncAt, null);
  }
});

test("parseRunlog: the lanes are separated by their prefixes", () => {
  const text = [
    dailyLine(local(1, 10, 42)),
    syncLine(local(1, 11, 0)),
    staleLineFixture(local(1, 12, 0)),
    dailyLine(local(1, 5, 0)),
  ].join("\n");
  const got = parseRunlog(text);
  assert.equal(got.daily, 2);
  assert.equal(got.sync, 1);
  assert.equal(got.stale, 1);
  // newest daily wins even though an older daily line came last
  assert.equal(zulu(got.lastDailyAt), zulu(local(1, 10, 42)));
  assert.equal(zulu(got.lastSyncAt), zulu(local(1, 11, 0)));
});

test("a legacy SYNC line is noise, never a run", () => {
  // The sync lane is retired, but 1.x lines live in the run log forever. If one
  // ever counted, "today's digest never went out" becomes invisible - which is
  // exactly the silent failure this file exists to catch.
  const text = [dailyLine(YESTERDAY), syncLine(local(1, 11, 0)), staleLineFixture(local(1, 7, 30))].join("\n");
  const got = parseRunlog(text);
  assert.equal(zulu(got.lastDailyAt), zulu(YESTERDAY), "the newest SYNC line must not move the daily lane");

  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "daily");
  assert.equal(d.reason, "missed-daily");
});

test("an AUTH line is noise too - a login is not a run", () => {
  const text = [
    dailyLine(YESTERDAY),
    `AUTH ${zulu(local(1, 12, 0))} fire=reauth reason=no-session result=ok exit=0 next=quiet`,
  ].join("\n");
  assert.equal(zulu(parseRunlog(text).lastDailyAt), zulu(YESTERDAY));
  assert.equal(decide(local(1, 13, 0), text).fire, "daily");
});

test("parseRunlog: malformed lines are skipped, never fatal", () => {
  const text = [
    "not a timestamp at all",
    "2026-02-30T25:61:00Z run=impossible",
    "SYNC not-a-date run=sync",
    "STALE",
    "",
    dailyLine(local(1, 10, 42)),
    "\u0000\u0001 binary garbage",
  ].join("\n");
  const got = parseRunlog(text);
  assert.equal(zulu(got.lastDailyAt), zulu(local(1, 10, 42)));
  assert.equal(got.lastSyncAt, null);
});

test("parseInstant / readState reject junk without throwing", () => {
  assert.equal(parseInstant("nope"), null);
  assert.equal(parseInstant(""), null);
  assert.equal(parseInstant(undefined), null);
  assert.deepEqual(readState(null), { lastFiredAt: null, lastFired: null, lastCheckAt: null });
  assert.deepEqual(readState({ lastFired: "brunch" }).lastFired, null);
  // A state file written by 1.x names a lane that no longer exists. Reading it
  // as "no memory" can only ever DELAY a rescue by one debounce.
  assert.equal(readState({ lastFired: "morning" }).lastFired, null);
  assert.equal(readState({ lastFired: "daily" }).lastFired, "daily");
});

// --- the one boundary -----------------------------------------------------

test("a missed day fires the daily lane", () => {
  const d = decide(local(1, 13, 16), dailyLine(YESTERDAY));
  assert.equal(d.fire, "daily");
  assert.equal(d.reason, "missed-daily");
});

test("a run today at 10:35 satisfies the boundary for the rest of the day", () => {
  const text = dailyLine(local(1, 10, 35));
  for (const [h, m] of [[11, 0], [13, 0], [17, 30], [22, 59]]) {
    const d = decide(local(1, h, m), text);
    assert.equal(d.fire, null, `${h}:${m} must stay quiet, got ${d.fire}`);
    assert.equal(d.reason, "nothing-stale");
  }
});

test("yesterday's miss is water under the bridge - only TODAY's boundary is asked about", () => {
  // A run happened today at 10:35; the two days before it are blank. Nothing is
  // stale, because tomorrow's boundary re-asks the question anyway.
  const text = dailyLine(local(1, 10, 35));
  assert.equal(decide(local(1, 20, 0), text).fire, null);
});

test("the grace period is respected", () => {
  const missed = dailyLine(YESTERDAY);
  // 10:30 + 20 = 10:50. One minute early is not late yet.
  assert.equal(decide(local(1, 10, 49), missed).fire, null);
  assert.equal(decide(local(1, 10, 50), missed).fire, "daily");
  assert.equal(GRACE_MIN, 20);
});

test("the quiet FLOOR closes the whole night", () => {
  // Laptop opened at 02:00 with yesterday's run the newest thing in the log.
  const text = dailyLine(new Date(2026, 7, 30, 10, 42, 0, 0)); // two days stale
  for (const [h, m] of [[0, 1], [2, 0], [5, 30], [9, 0], [10, 22]]) {
    const d = decide(local(1, h, m), text);
    assert.equal(d.fire, null, `${h}:${m} must stay silent, got ${d.fire}`);
    assert.equal(d.reason, "quiet-hours");
  }
  // ...and the same staleness DOES fire once quiet hours end and grace is up.
  assert.equal(decide(local(1, 10, 50), text).fire, "daily");
  assert.equal(QUIET_UNTIL_MIN, 10 * 60 + 23);
});

test("the quiet CEILING abandons a miss found after 23:00", () => {
  // Coming home at 23:40 to a day that never ran. Tomorrow's 10:30 rebuilds the
  // same state a midnight rescue would have, without waking anybody.
  const text = dailyLine(YESTERDAY);
  const late = decide(local(1, 23, 40), text);
  assert.equal(late.fire, null);
  assert.equal(late.reason, "quiet-hours");
  assert.equal(decide(local(1, 23, 0), text).reason, "quiet-hours", "the ceiling is inclusive of its own minute");
  // one minute earlier is still inside the working day
  assert.equal(decide(local(1, 22, 59), text).fire, "daily");
  assert.equal(QUIET_FROM_MIN, 23 * 60);
});

// --- gates ----------------------------------------------------------------

test("nothing fires twice inside the 25-minute debounce", () => {
  const text = dailyLine(YESTERDAY);
  const now = local(1, 13, 0);
  const firedAgo = (min) => ({
    state: { lastFiredAt: zulu(new Date(now.getTime() - min * 60000)), lastFired: "daily" },
  });

  const hot = decide(now, text, firedAgo(10));
  assert.equal(hot.fire, null);
  assert.match(hot.reason, /^debounced\(daily,10m\)$/);
  assert.equal(hot.detail.wouldFire, "daily"); // the decision is recorded, just not acted on

  assert.equal(decide(now, text, firedAgo(24)).fire, null);
  assert.equal(decide(now, text, firedAgo(DEBOUNCE_MIN)).fire, "daily");
  assert.equal(decide(now, text, firedAgo(45)).fire, "daily");
});

test("a corrupt future lastFiredAt cannot wedge the watchdog shut", () => {
  const text = dailyLine(YESTERDAY);
  const now = local(1, 13, 0);
  const ahead = (min) => ({
    state: { lastFiredAt: zulu(new Date(now.getTime() + min * 60000)), lastFired: "daily" },
  });
  // small forward skew: still a debounce, that is a clock nudge not corruption
  assert.equal(decide(now, text, ahead(5)).fire, null);
  // a stamp hours in the future is garbage and must be ignored
  assert.equal(decide(now, text, ahead(600)).fire, "daily");
  // so is an unparseable one
  assert.equal(decide(now, text, { state: { lastFiredAt: "soon" } }).fire, "daily");
});

test("two rescues is the whole day's ration", () => {
  const missed = dailyLine(YESTERDAY);
  const now = local(1, 13, 0);
  const withStale = (...lines) => [missed, ...lines].join("\n");

  // The failure this cap exists for: a run that dies BEFORE writing its daily
  // line leaves "today was missed" true forever, so without a cap the lane
  // re-fires every 25 minutes until 23:00.
  assert.equal(decide(now, missed).fire, "daily", "0 rescues so far");
  assert.equal(
    decide(now, withStale(staleLineFixture(local(1, 11, 0)))).fire,
    "daily",
    "1 rescue so far - the second attempt is still allowed",
  );

  const capped = decide(now, withStale(staleLineFixture(local(1, 11, 0)), staleLineFixture(local(1, 11, 30))));
  assert.equal(capped.fire, null, "exactly 2 is where it stops");
  assert.equal(capped.reason, "capped-daily");
  assert.equal(capped.detail.firedToday, 2);
  assert.equal(capped.detail.wouldFire, "daily"); // the verdict is recorded, just not acted on

  // ...and it stays capped however many more pile up.
  const many = decide(
    now,
    withStale(staleLineFixture(local(1, 11, 0)), staleLineFixture(local(1, 11, 30)), staleLineFixture(local(1, 12, 0))),
  );
  assert.equal(many.fire, null);
  assert.equal(many.reason, "capped-daily");
  assert.equal(DAILY_CAP, 2);
});

test("the cap counts LOCAL days - yesterday's rescues do not spend today's", () => {
  const text = [
    dailyLine(YESTERDAY),
    staleLineFixture(new Date(2026, 7, 31, 11, 0, 0, 0)),
    staleLineFixture(new Date(2026, 7, 31, 12, 0, 0, 0)),
  ].join("\n");
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "daily");
  assert.equal(d.detail.firedToday, 0);

  // A 22:00Z stamp is the PREVIOUS local day west of Greenwich and the SAME one
  // east of it; either way the comparison is done on local calendar dates, so
  // the fixture is built from a local instant and the answer is stable.
  const lateYesterday = new Date(2026, 7, 31, 23, 30, 0, 0);
  const edge = decide(
    local(1, 13, 0),
    [dailyLine(YESTERDAY), staleLineFixture(lateYesterday), staleLineFixture(lateYesterday)].join("\n"),
  );
  assert.equal(edge.fire, "daily");
});

test("a STALE line left by a retired 1.x lane spends nothing", () => {
  // `fired=morning` cannot be attributed to a lane that exists, so it is not
  // counted - which is the safe direction: it can only allow a rescue, never
  // suppress one.
  const text = [
    dailyLine(YESTERDAY),
    staleLineFixture(local(1, 7, 30), "morning", "missed-morning"),
    staleLineFixture(local(1, 8, 0), "evening", "missed-evening"),
  ].join("\n");
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "daily");
  assert.equal(d.detail.firedToday, 0);
  assert.equal(parseRunlog(text).stale, 2, "they are still counted as lines, just not against this lane");
});

test("a STALE line that cannot be attributed counts against nothing", () => {
  const text = [
    dailyLine(YESTERDAY),
    "STALE",
    "STALE not-a-date fired=daily reason=missed-daily",
    `STALE ${zulu(local(1, 11, 0))} no-fired-field-at-all`,
    staleLineFixture(local(1, 11, 30)),
  ].join("\n");
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "daily");
  assert.equal(d.detail.firedToday, 1, "only the one well-formed line counts");
  assert.equal(parseRunlog(text).stale, 4);
});

test("firesTodayFor is defensive about junk", () => {
  const now = local(1, 13, 0);
  assert.equal(firesTodayFor(undefined, now, "daily"), 0);
  assert.equal(firesTodayFor([null, {}, { fired: "daily" }], now, "daily"), 0);
  assert.equal(sameLocalDay(local(1, 0, 1), local(1, 23, 59)), true);
  assert.equal(sameLocalDay(local(1, 0, 1), local(2, 0, 1)), false);
});

test("the cap outranks the debounce in the reason it reports", () => {
  // Both apply; "capped" holds until midnight and "debounced" clears in 25 min,
  // so the log should say the one that will still be true in an hour.
  const now = local(1, 13, 0);
  const text = [dailyLine(YESTERDAY), staleLineFixture(local(1, 11, 0)), staleLineFixture(local(1, 12, 55))].join("\n");
  const d = decide(now, text, { state: { lastFiredAt: zulu(local(1, 12, 55)), lastFired: "daily" } });
  assert.equal(d.fire, null);
  assert.equal(d.reason, "capped-daily");
});

test("a Running target task suppresses the fire", () => {
  const text = dailyLine(YESTERDAY);
  const now = local(1, 13, 0);
  const running = decide(now, text, { taskStates: { daily: "Running" } });
  assert.equal(running.fire, null);
  assert.equal(running.reason, "already-running(daily)");
  assert.equal(running.detail.wouldFire, "daily");

  assert.equal(decide(now, text, { taskStates: { daily: "Ready" } }).fire, "daily");
  // an unreadable status must not silence the watchdog: IgnoreNew is the dedupe
  assert.equal(decide(now, text, { taskStates: { daily: "unknown" } }).fire, "daily");
  assert.equal(decide(now, text, { taskStates: {} }).fire, "daily");
  // ...and a retired lane's state is not this lane's state
  assert.equal(decide(now, text, { taskStates: { sync: "Running" } }).fire, "daily");
});

test("the decision is pure - same inputs, same answer", () => {
  const text = [dailyLine(YESTERDAY), syncLine(local(1, 9, 0))].join("\n");
  const a = decide(local(1, 13, 0), text);
  const b = decide(local(1, 13, 0), text);
  assert.deepEqual(a, b);
});

test("an empty or missing run log reads as very stale, and never throws", () => {
  assert.equal(decide(local(1, 13, 0), "").fire, "daily");
  assert.equal(decide(local(1, 13, 0), "garbage\n???\n").fire, "daily");
  // ...but quiet hours still hold over a blank log
  assert.equal(decide(local(1, 3, 0), "").fire, null);
  assert.equal(decideStale({ now: local(1, 13, 0) }).fire, "daily");
});

// --- line + file helpers --------------------------------------------------

test("staleLine has exactly the contract shape", () => {
  const line = staleLine(local(1, 13, 40), "daily", "missed-daily");
  assert.match(line, /^STALE \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z fired=daily reason=missed-daily$/);
  // and it must be invisible to the daily lane when read back
  assert.equal(parseRunlog(line).lastDailyAt, null);
  assert.equal(parseRunlog(line).stale, 1);
});

test("boundaryToday / minuteOfDay work in local wall-clock terms", () => {
  const b = boundaryToday(local(1, 22, 0), DAILY);
  assert.equal(b.getHours(), 10);
  assert.equal(b.getMinutes(), 30);
  assert.equal(b.getDate(), 1);
  assert.equal(minuteOfDay(local(1, 10, 23)), 623);
});

test("appendLine never joins onto an unterminated last line", () =>
  withTempRepo(({ runlogFile }) => {
    writeFileSync(runlogFile, `${dailyLine(YESTERDAY)}`); // no trailing \n
    appendLine(runlogFile, staleLine(local(1, 13, 40), "daily", "missed-daily"));
    const lines = readFileSync(runlogFile, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith("STALE "));
    assert.equal(parseRunlog(readFileSync(runlogFile, "utf8")).daily, 1);
  }));

test("a corrupt stale-check.json degrades to an empty memory", () =>
  withTempRepo(({ stateFile }) => {
    writeFileSync(stateFile, "{not json at all");
    assert.deepEqual(readStateFile(stateFile), {
      lastFiredAt: null,
      lastFired: null,
      lastCheckAt: null,
    });
    writeStateFile(stateFile, { lastCheckAt: "2026-09-01T17:40:00Z" });
    assert.equal(readStateFile(stateFile).lastCheckAt, "2026-09-01T17:40:00Z");
  }));

// --- CLI shell ------------------------------------------------------------

test("parseArgs accepts the documented flags and rejects the rest", () => {
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--verbose"]).verbose, true);
  assert.equal(zulu(parseArgs(["--now", "2026-09-01T17:00:00Z"]).now), "2026-09-01T17:00:00Z");
  assert.match(parseArgs(["--now"]).error, /bad --now/);
  assert.match(parseArgs(["--wat"]).error, /unknown argument/);
  // --config / --data belong to src/lib/paths.mjs and must not read as unknown
  assert.equal(parseArgs(["--config", "x.json", "--data", "d"]).error, null);
  assert.equal(parseArgs(["--config=x.json", "--data=d"]).error, null);
});

test("CLI: a missed day fires the Daily TASK and logs one STALE line", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    writeFileSync(runlogFile, `${dailyLine(YESTERDAY)}\n`);
    const sched = recorder();
    const now = local(1, 13, 16);
    const code = cliMain([], {
      dir,
      now,
      runTask: sched.run,
      queryTaskState: () => "Ready",
      log: () => {},
    });

    assert.equal(code, EXIT.ok);
    assert.deepEqual(sched.calls, [TASKS.daily]); // never run-daily.cmd, never twice
    const lines = readFileSync(runlogFile, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(lines[1], `STALE ${zulu(now)} fired=daily reason=missed-daily`);

    const state = readStateFile(stateFile);
    assert.equal(state.lastFired, "daily");
    assert.equal(state.lastFiredAt, zulu(now));
    assert.equal(state.lastCheckAt, zulu(now));
  }));

test("CLI: a quiet check writes lastCheckAt and touches nothing else", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    const before = `${dailyLine(local(1, 10, 35))}\n`;
    writeFileSync(runlogFile, before);
    const sched = recorder();
    const now = local(1, 13, 0);
    const code = cliMain([], { dir, now, runTask: sched.run, queryTaskState: () => "Ready", log: () => {} });

    assert.equal(code, EXIT.ok);
    assert.deepEqual(sched.calls, []);
    assert.equal(readFileSync(runlogFile, "utf8"), before); // byte-for-byte
    const state = readStateFile(stateFile);
    assert.equal(state.lastCheckAt, zulu(now));
    assert.equal(state.lastFiredAt, null);
  }));

test("CLI: a schtasks refusal logs nothing and leaves the retry open", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    const before = `${dailyLine(YESTERDAY)}\n`;
    writeFileSync(runlogFile, before);
    const sched = recorder(false, "ERROR: The system cannot find the file specified.");
    const code = cliMain([], {
      dir,
      now: local(1, 13, 16),
      runTask: sched.run,
      queryTaskState: () => "Ready",
      log: () => {},
    });

    assert.equal(code, EXIT.ok); // a scheduler refusal is not this script breaking
    assert.deepEqual(sched.calls, [TASKS.daily]);
    assert.equal(readFileSync(runlogFile, "utf8"), before); // no STALE line for a fire that did not happen
    assert.equal(readStateFile(stateFile).lastFiredAt, null); // so the next check tries again
  }));

test("CLI: the debounce survives a round trip through the state file", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    writeFileSync(runlogFile, `${dailyLine(YESTERDAY)}\n`);
    const sched = recorder();
    const opts = { dir, runTask: sched.run, queryTaskState: () => "Ready", log: () => {} };

    cliMain([], { ...opts, now: local(1, 13, 0) });
    cliMain([], { ...opts, now: local(1, 13, 5) }); // logon + unlock seconds apart
    cliMain([], { ...opts, now: local(1, 13, 20) });
    assert.deepEqual(sched.calls, [TASKS.daily], "one open laptop must not queue three runs");

    cliMain([], { ...opts, now: local(1, 13, 40) }); // past the debounce, still stale
    assert.deepEqual(sched.calls, [TASKS.daily, TASKS.daily]);
    assert.equal(readStateFile(stateFile).lastFiredAt, zulu(local(1, 13, 40)));
    assert.equal(readFileSync(runlogFile, "utf8").split("\n").filter((l) => l.startsWith("STALE ")).length, 2);
  }));

test("CLI: --dry-run decides but writes and fires nothing", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    const before = `${dailyLine(YESTERDAY)}\n`;
    writeFileSync(runlogFile, before);
    const sched = recorder();
    const said = [];
    const code = cliMain(["--dry-run", "--verbose"], {
      dir,
      now: local(1, 13, 16),
      runTask: sched.run,
      queryTaskState: () => "Ready",
      log: (m) => said.push(m),
    });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(sched.calls, []);
    assert.equal(readFileSync(runlogFile, "utf8"), before);
    assert.equal(existsSync(stateFile), false);
    assert.match(said.join(" "), /fire=daily reason=missed-daily/);
    assert.match(said.join(" "), /rescuesToday=0\/2/, "/agenda-doctor reads this line");
  }));

test("CLI: an absent run log and an absent state file still produce a decision", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    const sched = recorder();
    const code = cliMain([], {
      dir,
      now: local(1, 13, 16),
      runTask: sched.run,
      queryTaskState: () => "Ready",
      log: () => {},
    });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(sched.calls, [TASKS.daily]);
    assert.ok(existsSync(runlogFile));
    assert.ok(existsSync(stateFile));
  }));

test("CLI: a Running Daily task means the check stays quiet", () =>
  withTempRepo(({ dir, runlogFile }) => {
    const before = `${dailyLine(YESTERDAY)}\n`;
    writeFileSync(runlogFile, before);
    const sched = recorder();
    const code = cliMain([], {
      dir,
      now: local(1, 13, 16),
      runTask: sched.run,
      queryTaskState: () => "Running",
      log: () => {},
    });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(sched.calls, []);
    assert.equal(readFileSync(runlogFile, "utf8"), before);
  }));

test("CLI: a capped lane fires nothing, logs nothing, and still stamps lastCheckAt", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    const before = [
      dailyLine(YESTERDAY),
      staleLineFixture(local(1, 11, 0)),
      staleLineFixture(local(1, 11, 30)),
      "",
    ].join("\n");
    writeFileSync(runlogFile, before);
    const sched = recorder();
    const now = local(1, 13, 16);
    const code = cliMain([], { dir, now, runTask: sched.run, queryTaskState: () => "Ready", log: () => {} });

    assert.equal(code, EXIT.ok);
    assert.deepEqual(sched.calls, [], "the ration for the day is spent");
    assert.equal(readFileSync(runlogFile, "utf8"), before); // byte-for-byte
    const state = readStateFile(stateFile);
    assert.equal(state.lastCheckAt, zulu(now)); // the watchdog is still alive
    assert.equal(state.lastFiredAt, null);
  }));

test("CLI: the cap holds across real fires, not just pre-seeded lines", () =>
  withTempRepo(({ dir, runlogFile }) => {
    writeFileSync(runlogFile, `${dailyLine(YESTERDAY)}\n`);
    const sched = recorder();
    const opts = { dir, runTask: sched.run, queryTaskState: () => "Ready", log: () => {} };

    cliMain([], { ...opts, now: local(1, 11, 0) }); // rescue 1
    cliMain([], { ...opts, now: local(1, 12, 0) }); // rescue 2
    cliMain([], { ...opts, now: local(1, 13, 0) }); // capped
    cliMain([], { ...opts, now: local(1, 17, 0) }); // still capped, hours later
    assert.deepEqual(sched.calls, [TASKS.daily, TASKS.daily]);
    assert.equal(readFileSync(runlogFile, "utf8").split("\n").filter((l) => l.startsWith("STALE ")).length, 2);
  }));

test("CLI: a bad argument is the one thing that exits non-zero", () =>
  withTempRepo(({ dir }) => {
    const code = cliMain(["--fire-everything"], { dir, log: () => {} });
    assert.equal(code, EXIT.broken);
  }));

// --- a config.json that will not load -------------------------------------
//
// This watchdog is the only thing on the machine that notices the run is gone.
// A `config.json` with a trailing comma used to take down the run AND the thing
// that reports the run is missing, on the same line, leaving a Node stack in
// runlog-stdout.txt and nothing else anywhere.

/** A config file this loader refuses, with the reason it refuses it. */
const BAD_CONFIGS = [
  ["{ trailing, comma", "not valid JSON"],
  [JSON.stringify({ namespace: "NOPE" }), "namespace"],
  [JSON.stringify({ scheduler: { dailyAt: "10.30" } }), "scheduler.dailyAt"],
  [JSON.stringify({ llm: { effort: "maximum" } }), "llm.effort"],
];

test("CLI: a config that will not load is one line and exit 1, never a stack", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    for (const [body, names] of BAD_CONFIGS) {
      const cfgPath = join(dir, "bad-config.json");
      writeFileSync(cfgPath, body);
      const sched = recorder();
      const out = [];
      const errs = [];

      const code = cliMain(["--config", cfgPath], {
        dir,
        dataDir: join(dir, "data"),
        now: local(1, 13, 16),
        runTask: sched.run,
        queryTaskState: () => "Ready",
        log: (m) => out.push(m),
        logErr: (m) => errs.push(m),
      });

      assert.equal(code, EXIT.broken, `${names}: a config it cannot read means the watchdog is down`);
      assert.equal(errs.length, 2, `${names}: exactly two lines, got ${JSON.stringify(errs)}`);
      assert.ok(errs[0].startsWith("config: "), errs[0]);
      assert.ok(errs[0].includes(names), `${names} must be named: ${errs[0]}`);
      assert.equal(errs[0].includes("\n"), false, "one line, so Task Scheduler's log stays readable");
      assert.ok(!/\bat \S+:\d+:\d+/.test(errs.join("\n")), `a stack reached the user:\n${errs.join("\n")}`);
      assert.ok(!errs.join("\n").includes("ConfigError"), "the class name means nothing to a user");
      assert.equal(errs[1], "fix: node scripts/validate-setup.mjs");

      // Nothing was fired and nothing was logged - the run log is the ledger
      // for the daily cap, and a rescue that never happened must not appear.
      assert.deepEqual(sched.calls, []);
      assert.equal(existsSync(runlogFile), false);

      // ...but the heartbeat IS stamped, so /agenda-doctor can see the lane ran
      // and stopped rather than guessing it never fired at all.
      assert.equal(readStateFile(stateFile).lastCheckAt, zulu(local(1, 13, 16)));
      assert.equal(readStateFile(stateFile).lastFiredAt, null);
      rmSync(stateFile, { force: true });
    }
  }));

test("CLI: a config error does not disturb a run log that is already there", () =>
  withTempRepo(({ dir, runlogFile }) => {
    const before = `${dailyLine(YESTERDAY)}\n${staleLineFixture(local(1, 11, 0))}\n`;
    writeFileSync(runlogFile, before);
    writeFileSync(join(dir, "bad-config.json"), "{ nope");
    const sched = recorder();

    const code = cliMain(["--config", join(dir, "bad-config.json")], {
      dir,
      dataDir: join(dir, "data"),
      now: local(1, 13, 16),
      runTask: sched.run,
      queryTaskState: () => "Ready",
      log: () => {},
      logErr: () => {},
    });

    assert.equal(code, EXIT.broken);
    assert.deepEqual(sched.calls, []);
    assert.equal(readFileSync(runlogFile, "utf8"), before, "byte-for-byte");
  }));

test("CLI: --now overrides the clock so a decision can be reproduced", () =>
  withTempRepo(({ dir, runlogFile }) => {
    writeFileSync(runlogFile, `${dailyLine(YESTERDAY)}\n`);
    const said = [];
    cliMain(["--dry-run", "--now", zulu(local(1, 3, 0))], {
      dir,
      runTask: recorder().run,
      queryTaskState: () => "Ready",
      log: (m) => said.push(m),
    });
    assert.match(said.join(" "), /fire=none reason=quiet-hours/);
  }));

// Guard against a silent drift in the constants the contract fixes.
test("the contract's numbers are the ones in the file", () => {
  assert.deepEqual(DAILY, { h: 10, m: 30 });
  assert.equal(GRACE_MIN, 20);
  assert.equal(DEBOUNCE_MIN, 25);
  assert.equal(DAILY_CAP, 2);
  assert.deepEqual(TASKS, { daily: "Agenda Daily" });
});

// --- config-driven names and boundaries -----------------------------------

test("a custom taskPrefix renames all three scheduled tasks together", () => {
  const cfg = { scheduler: { taskPrefix: "Weekly" } };
  assert.deepEqual(derive(cfg).taskNames, {
    daily: "Weekly Daily",
    staleCheck: "Weekly StaleCheck",
    authRetry: "Weekly AuthRetry",
  });
  assert.deepEqual(laneTasks(cfg), { daily: "Weekly Daily" });
});

test("the CLI fires the task name the config asks for, not a built-in one", () =>
  withTempRepo(({ dir, runlogFile }) => {
    writeFileSync(runlogFile, `${dailyLine(YESTERDAY)}\n`);
    const sched = recorder();
    cliMain([], {
      dir,
      cfg: { scheduler: { taskPrefix: "Weekly" } },
      now: local(1, 11, 0),
      runTask: sched.run,
      queryTaskState: () => "Ready",
      log: () => {},
    });
    assert.deepEqual(sched.calls, ["Weekly Daily"]);
  }));

test("parseClock takes HH:MM and falls back rather than throwing on junk", () => {
  assert.deepEqual(parseClock("10:30", null), { h: 10, m: 30 });
  assert.deepEqual(parseClock("23:59", null), { h: 23, m: 59 });
  assert.deepEqual(parseClock("24:00", { h: 9, m: 0 }), { h: 9, m: 0 });
  assert.deepEqual(parseClock("7am", { h: 9, m: 0 }), { h: 9, m: 0 });
  assert.deepEqual(parseClock(undefined, { h: 9, m: 0 }), { h: 9, m: 0 });
});

test("rulesFrom({}) reproduces the documented defaults exactly", () => {
  assert.deepEqual(rulesFrom({}), DEFAULT_RULES);
  assert.deepEqual(rulesFrom(undefined), DEFAULT_RULES);
  assert.deepEqual(Object.keys(DEFAULT_RULES).sort(), [
    "dailyCap",
    "daily",
    "debounceMin",
    "graceMin",
    "quietFromMin",
    "quietUntilMin",
  ].sort());
});

test("rulesFrom lifts every boundary out of config.scheduler", () => {
  const r = rulesFrom({
    dailyAt: "06:30",
    quietUntil: "06:00",
    quietFrom: "21:30",
    graceMinutes: 5,
    debounceMinutes: 10,
    maxRescuesPerLane: 1,
  });
  assert.deepEqual(r.daily, { h: 6, m: 30 });
  assert.equal(r.quietUntilMin, 6 * 60);
  assert.equal(r.quietFromMin, 21 * 60 + 30);
  assert.equal(r.graceMin, 5);
  assert.equal(r.debounceMin, 10);
  assert.equal(r.dailyCap, 1);
});

test("the retired 1.x keys are not read, whatever they say", () => {
  // The loader warns about them once. This function simply does not look, so a
  // config that still says `morningAt: 07:03` still runs at 10:30.
  const r = rulesFrom({ morningAt: "07:03", eveningAt: "18:07", syncWindow: ["09:00", "23:00"], syncGapHours: 3 });
  assert.deepEqual(r, DEFAULT_RULES);
});

test("one overridden key leaves every other default alone", () => {
  const r = rulesFrom({ graceMinutes: 45 });
  assert.equal(r.graceMin, 45);
  assert.deepEqual(r.daily, DEFAULT_RULES.daily);
  assert.equal(r.debounceMin, DEFAULT_RULES.debounceMin);
  assert.equal(r.dailyCap, DEFAULT_RULES.dailyCap);
});

test("a configured boundary moves what counts as stale", () => {
  const runlog = `${dailyLine(YESTERDAY)}\n`;
  // 06:40 local is inside the default quiet floor, so nothing is stale...
  assert.equal(decideStale({ now: local(1, 6, 40), runlog }).fire, null);
  // ...but with a 05:00 boundary, a 5-minute grace and the floor moved, it is.
  const rules = rulesFrom({ dailyAt: "05:00", quietUntil: "05:05", graceMinutes: 5 });
  const decision = decideStale({ now: local(1, 6, 40), runlog, rules });
  assert.equal(decision.fire, "daily");
  assert.equal(decision.reason, "missed-daily");
});

test("a configured daily cap of 1 stops the second rescue", () => {
  const runlog = [dailyLine(YESTERDAY), staleLineFixture(local(1, 11, 0))].join("\n");
  const rules = rulesFrom({ maxRescuesPerLane: 1 });
  const decision = decideStale({ now: local(1, 11, 30), runlog, rules });
  assert.equal(decision.fire, null);
  assert.equal(decision.reason, "capped-daily");
  // The same log with the default cap of 2 still has one rescue left.
  assert.equal(decideStale({ now: local(1, 11, 30), runlog }).fire, "daily");
});
