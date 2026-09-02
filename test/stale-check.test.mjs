// node --test test/stale-check.test.mjs   (run from the repository root)
//
// The watchdog's failure modes are asymmetric and both are bad, so every rule
// here gets its positive case AND the negative that matters:
//
//   too quiet - the 2026-09-01 incident repeats, the user gets no digest, and
//               nothing anywhere says why. This is the one the file exists for.
//   too loud  - a `claude -p` session at 03:00, or three of them stacked on one
//               laptop-open, each sending mail and a push. That is how a user
//               disables a watchdog, and then it protects nothing at all.
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
  DEFAULT_RULES,
  EXIT,
  GRACE_MIN,
  DEBOUNCE_MIN,
  SYNC_GAP_MIN,
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

const heavyLine =(d, tail = "run=scheduled items=81 drive=ok(doc-replaced)") =>
  `${zulu(d)} ${tail}`;
const syncLine = (d, tail = "run=sync fcmd=applied=0 render=ok drive=ok(doc-replaced)") =>
  `SYNC ${zulu(d)} ${tail}`;
const staleLineFixture = (d, which = "morning", why = "missed-morning") =>
  `STALE ${zulu(d)} fired=${which} reason=${why}`;

/** 2026-08-31 18:12 local - the newest real heavy line in the live log. */
const YESTERDAY_EVENING = new Date(2026, 7, 31, 18, 12, 0, 0);

const decide = (now, runlog, over = {}) =>
  decideStale({ now, runlog, taskStates: over.taskStates ?? {}, state: over.state ?? {} });

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
    assert.equal(got.lastHeavyAt, null);
    assert.equal(got.lastSyncAt, null);
  }
});

test("parseRunlog: the three lanes are separated by their prefixes", () => {
  const text = [
    heavyLine(local(1, 6, 10)),
    syncLine(local(1, 11, 0)),
    staleLineFixture(local(1, 12, 0)),
    heavyLine(local(1, 5, 0)),
  ].join("\n");
  const got = parseRunlog(text);
  assert.equal(got.heavy, 2);
  assert.equal(got.sync, 1);
  assert.equal(got.stale, 1);
  // newest heavy wins even though an older heavy line came last
  assert.equal(zulu(got.lastHeavyAt), zulu(local(1, 6, 10)));
  assert.equal(zulu(got.lastSyncAt), zulu(local(1, 11, 0)));
});

test("parseRunlog: SYNC and STALE lines are NOT evidence of a heavy run", () => {
  // If either lane counted, "the morning digest never went out" becomes
  // invisible - which is exactly the silent failure this file exists to catch.
  const text = [
    heavyLine(YESTERDAY_EVENING),
    syncLine(local(1, 11, 0)),
    staleLineFixture(local(1, 7, 30)),
  ].join("\n");
  const got = parseRunlog(text);
  assert.equal(zulu(got.lastHeavyAt), zulu(YESTERDAY_EVENING));

  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "morning");
  assert.equal(d.reason, "missed-morning");
});

test("parseRunlog: malformed lines are skipped, never fatal", () => {
  const text = [
    "not a timestamp at all",
    "2026-02-30T25:61:00Z run=impossible",
    "SYNC not-a-date run=sync",
    "STALE",
    "",
    heavyLine(local(1, 6, 10)),
    "\u0000\u0001 binary garbage",
  ].join("\n");
  const got = parseRunlog(text);
  assert.equal(zulu(got.lastHeavyAt), zulu(local(1, 6, 10)));
  assert.equal(got.lastSyncAt, null);
});

test("parseInstant / readState reject junk without throwing", () => {
  assert.equal(parseInstant("nope"), null);
  assert.equal(parseInstant(""), null);
  assert.equal(parseInstant(undefined), null);
  assert.deepEqual(readState(null), { lastFiredAt: null, lastFired: null, lastCheckAt: null });
  assert.deepEqual(readState({ lastFired: "brunch" }).lastFired, null);
});

// --- heavy lane -----------------------------------------------------------

test("missed morning fires morning", () => {
  // The live 2026-09-01 state: nothing since yesterday evening, now 13:16.
  const text = heavyLine(YESTERDAY_EVENING);
  const d = decide(local(1, 13, 16), text);
  assert.equal(d.fire, "morning");
  assert.equal(d.reason, "missed-morning");
});

test("missed evening fires evening", () => {
  // The morning run DID happen, the evening one did not.
  const text = heavyLine(local(1, 7, 5));
  const d = decide(local(1, 19, 0), text);
  assert.equal(d.fire, "evening");
  assert.equal(d.reason, "missed-evening");
});

test("both boundaries missed fires ONLY the evening one", () => {
  const text = heavyLine(YESTERDAY_EVENING);
  const d = decide(local(1, 19, 0), text);
  assert.equal(d.fire, "evening");
  assert.equal(d.reason, "missed-evening");
});

test("nothing missed fires nothing", () => {
  const text = [heavyLine(local(1, 7, 5)), syncLine(local(1, 11, 0))].join("\n");
  const d = decide(local(1, 11, 30), text);
  assert.equal(d.fire, null);
  assert.equal(d.reason, "nothing-stale");
});

test("the grace period is respected on both boundaries", () => {
  const morningMissed = heavyLine(YESTERDAY_EVENING);
  // 07:03 + 20 = 07:23. One minute early is not late yet.
  assert.equal(decide(local(1, 7, 22), morningMissed).fire, null);
  assert.equal(decide(local(1, 7, 23), morningMissed).fire, "morning");

  // 18:07 + 20 = 18:27. The 18:00 SYNC line is there to keep the sync lane out
  // of this test: without it the 11h heavy gap fires sync at 18:26 instead.
  const eveningMissed = [heavyLine(local(1, 7, 5)), syncLine(local(1, 18, 0))].join("\n");
  assert.equal(decide(local(1, 18, 26), eveningMissed).fire, null);
  assert.equal(decide(local(1, 18, 27), eveningMissed).fire, "evening");
  assert.equal(GRACE_MIN, 20);
});

test("the heavy lane never fires between 00:00 and 07:23", () => {
  // Laptop opened at 02:00 with the 18:07 run missed and nothing since.
  const text = heavyLine(new Date(2026, 7, 30, 18, 12, 0, 0)); // two days stale
  for (const [h, m] of [[0, 1], [2, 0], [5, 30], [7, 0], [7, 22]]) {
    const d = decide(local(1, h, m), text);
    assert.equal(d.fire, null, `${h}:${m} must stay silent, got ${d.fire}`);
  }
  // ...and the same staleness DOES fire the moment quiet hours end.
  assert.equal(decide(local(1, 7, 23), text).fire, "morning");
});

test("a heavy run today at 07:05 satisfies the morning boundary all day", () => {
  const text = heavyLine(local(1, 7, 5));
  assert.equal(decide(local(1, 8, 0), text).fire, null);
  assert.equal(decide(local(1, 12, 0), text).fire, "sync"); // sync gap, not heavy
});

// --- sync lane ------------------------------------------------------------

test("sync-gap fires sync inside 09:00-23:00 when nothing ran for 3h", () => {
  const text = heavyLine(local(1, 7, 5));
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "sync");
  assert.equal(d.reason, "sync-gap");
  assert.ok(d.detail.gapMin >= SYNC_GAP_MIN);
});

test("sync-gap does NOT fire outside 09:00-23:00", () => {
  // 19:00 heavy run clears both heavy boundaries; the gap is real but late.
  const text = heavyLine(local(1, 19, 0));
  const late = decide(local(1, 23, 45), text);
  assert.equal(late.fire, null);
  assert.equal(late.reason, "outside-sync-window");
  // the same gap 60 minutes earlier, still inside the window, does fire
  assert.equal(decide(local(1, 22, 45), text).fire, "sync");
});

test("sync-gap does not fire before the window opens", () => {
  const text = [heavyLine(local(1, 7, 5)), syncLine(new Date(2026, 7, 31, 23, 0, 0, 0))].join("\n");
  const early = decide(local(1, 8, 30), text);
  assert.equal(early.fire, null);
  assert.notEqual(early.reason, "sync-gap");
});

test("a fresh SYNC line closes the gap", () => {
  const base = heavyLine(local(1, 7, 5));
  const fresh = [base, syncLine(local(1, 12, 30))].join("\n");
  assert.equal(decide(local(1, 13, 0), fresh).fire, null);

  const stale = [base, syncLine(local(1, 9, 0))].join("\n");
  assert.equal(decide(local(1, 13, 0), stale).fire, "sync");
});

test("a pending heavy fire always wins over the sync lane", () => {
  // Nothing since yesterday: the sync gap is ~19h AND the morning run is
  // missed. Only the heavy lane may fire - it does the sync's job too.
  const text = heavyLine(YESTERDAY_EVENING);
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "morning");
});

// --- gates ----------------------------------------------------------------

test("nothing fires twice inside the 25-minute debounce", () => {
  const text = heavyLine(YESTERDAY_EVENING);
  const now = local(1, 13, 0);
  const firedAgo = (min) => ({
    state: { lastFiredAt: zulu(new Date(now.getTime() - min * 60000)), lastFired: "morning" },
  });

  const hot = decide(now, text, firedAgo(10));
  assert.equal(hot.fire, null);
  assert.match(hot.reason, /^debounced\(morning,10m\)$/);
  assert.equal(hot.detail.wouldFire, "morning"); // the decision is recorded, just not acted on

  assert.equal(decide(now, text, firedAgo(24)).fire, null);
  assert.equal(decide(now, text, firedAgo(DEBOUNCE_MIN)).fire, "morning");
  assert.equal(decide(now, text, firedAgo(45)).fire, "morning");
});

test("the debounce is global - a sync fire also holds off a heavy one", () => {
  const text = heavyLine(YESTERDAY_EVENING);
  const now = local(1, 13, 0);
  const d = decide(now, text, {
    state: { lastFiredAt: zulu(new Date(now.getTime() - 5 * 60000)), lastFired: "sync" },
  });
  assert.equal(d.fire, null);
  assert.match(d.reason, /^debounced\(sync,/);
});

test("a corrupt future lastFiredAt cannot wedge the watchdog shut", () => {
  const text = heavyLine(YESTERDAY_EVENING);
  const now = local(1, 13, 0);
  const ahead = (min) => ({
    state: { lastFiredAt: zulu(new Date(now.getTime() + min * 60000)), lastFired: "morning" },
  });
  // small forward skew: still a debounce, that is a clock nudge not corruption
  assert.equal(decide(now, text, ahead(5)).fire, null);
  // a stamp hours in the future is garbage and must be ignored
  assert.equal(decide(now, text, ahead(600)).fire, "morning");
  // so is an unparseable one
  assert.equal(decide(now, text, { state: { lastFiredAt: "soon" } }).fire, "morning");
});

test("two rescues on a lane is the whole day's ration", () => {
  const missedMorning = heavyLine(YESTERDAY_EVENING);
  const now = local(1, 13, 0);
  const withStale = (...lines) => [missedMorning, ...lines].join("\n");

  // The failure this cap exists for: a run that dies BEFORE writing its
  // section-10 line leaves "morning was missed" true forever, so without a cap
  // the lane re-fires every 25 minutes until 18:07.
  assert.equal(decide(now, missedMorning).fire, "morning", "0 rescues so far");
  assert.equal(
    decide(now, withStale(staleLineFixture(local(1, 7, 30)))).fire,
    "morning",
    "1 rescue so far - the second attempt is still allowed"
  );

  const capped = decide(
    now,
    withStale(staleLineFixture(local(1, 7, 30)), staleLineFixture(local(1, 8, 0)))
  );
  assert.equal(capped.fire, null, "exactly 2 is where it stops");
  assert.equal(capped.reason, "capped-morning");
  assert.equal(capped.detail.firedToday, 2);
  assert.equal(capped.detail.wouldFire, "morning"); // the verdict is recorded, just not acted on

  // ...and it stays capped however many more pile up.
  const many = decide(
    now,
    withStale(
      staleLineFixture(local(1, 7, 30)),
      staleLineFixture(local(1, 8, 0)),
      staleLineFixture(local(1, 8, 30))
    )
  );
  assert.equal(many.fire, null);
  assert.equal(many.reason, "capped-morning");
  assert.equal(DAILY_CAP, 2);
});

test("the cap is per lane - a spent morning does not spend the evening", () => {
  // Two morning rescues already today, and now the 18:07 run is missed too.
  const text = [
    heavyLine(YESTERDAY_EVENING),
    staleLineFixture(local(1, 7, 30), "morning", "missed-morning"),
    staleLineFixture(local(1, 8, 0), "morning", "missed-morning"),
  ].join("\n");
  const d = decide(local(1, 19, 0), text);
  assert.equal(d.fire, "evening");
  assert.equal(d.detail.firedToday, 0);

  // The sync lane is its own ration too.
  const syncText = [
    heavyLine(local(1, 7, 5)),
    staleLineFixture(local(1, 11, 0), "sync", "sync-gap"),
    staleLineFixture(local(1, 12, 0), "sync", "sync-gap"),
  ].join("\n");
  const s = decide(local(1, 13, 0), syncText);
  assert.equal(s.fire, null);
  assert.equal(s.reason, "capped-sync");
  // ...while the heavy lanes are untouched by it
  assert.equal(decide(local(1, 19, 0), syncText).fire, "evening");
});

test("the cap counts LOCAL days - yesterday's rescues do not spend today's", () => {
  const text = [
    heavyLine(YESTERDAY_EVENING),
    staleLineFixture(new Date(2026, 7, 31, 7, 30, 0, 0)),
    staleLineFixture(new Date(2026, 7, 31, 8, 0, 0, 0)),
    staleLineFixture(new Date(2026, 7, 31, 19, 0, 0, 0), "evening", "missed-evening"),
  ].join("\n");
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "morning");
  assert.equal(d.detail.firedToday, 0);

  // A 22:00Z stamp is the PREVIOUS local day west of Greenwich and the SAME one
  // east of it; either way the comparison is done on local calendar dates, so
  // the fixture is built from a local instant and the answer is stable.
  const lateYesterday = new Date(2026, 7, 31, 23, 30, 0, 0);
  const edge = decide(
    local(1, 13, 0),
    [heavyLine(YESTERDAY_EVENING), staleLineFixture(lateYesterday), staleLineFixture(lateYesterday)].join("\n")
  );
  assert.equal(edge.fire, "morning");
});

test("a capped lane does not fall through to a different lane", () => {
  // Morning capped, and the sync gap is ~19h wide - it must still stay quiet.
  const text = [
    heavyLine(YESTERDAY_EVENING),
    staleLineFixture(local(1, 7, 30)),
    staleLineFixture(local(1, 8, 0)),
  ].join("\n");
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, null);
  assert.equal(d.reason, "capped-morning");
});

test("a STALE line that cannot be attributed counts against nothing", () => {
  const text = [
    heavyLine(YESTERDAY_EVENING),
    "STALE",
    "STALE not-a-date fired=morning reason=missed-morning",
    `STALE ${zulu(local(1, 7, 30))} no-fired-field-at-all`,
    staleLineFixture(local(1, 8, 0)),
  ].join("\n");
  const d = decide(local(1, 13, 0), text);
  assert.equal(d.fire, "morning");
  assert.equal(d.detail.firedToday, 1, "only the one well-formed line counts");
  assert.equal(parseRunlog(text).stale, 4);
});

test("firesTodayFor is defensive about junk", () => {
  const now = local(1, 13, 0);
  assert.equal(firesTodayFor(undefined, now, "morning"), 0);
  assert.equal(firesTodayFor([null, {}, { fired: "morning" }], now, "morning"), 0);
  assert.equal(sameLocalDay(local(1, 0, 1), local(1, 23, 59)), true);
  assert.equal(sameLocalDay(local(1, 0, 1), local(2, 0, 1)), false);
});

test("the cap outranks the debounce in the reason it reports", () => {
  // Both apply; "capped" holds until midnight and "debounced" clears in 25 min,
  // so the log should say the one that will still be true in an hour.
  const now = local(1, 13, 0);
  const text = [
    heavyLine(YESTERDAY_EVENING),
    staleLineFixture(local(1, 7, 30)),
    staleLineFixture(local(1, 12, 55)),
  ].join("\n");
  const d = decide(now, text, {
    state: { lastFiredAt: zulu(local(1, 12, 55)), lastFired: "morning" },
  });
  assert.equal(d.fire, null);
  assert.equal(d.reason, "capped-morning");
});

test("a Running target task suppresses the fire", () => {
  const text = heavyLine(YESTERDAY_EVENING);
  const now = local(1, 13, 0);
  const running = decide(now, text, { taskStates: { morning: "Running" } });
  assert.equal(running.fire, null);
  assert.equal(running.reason, "already-running(morning)");
  assert.equal(running.detail.wouldFire, "morning");

  assert.equal(decide(now, text, { taskStates: { morning: "Ready" } }).fire, "morning");
  // an unreadable status must not silence the watchdog: IgnoreNew is the dedupe
  assert.equal(decide(now, text, { taskStates: { morning: "unknown" } }).fire, "morning");
  assert.equal(decide(now, text, { taskStates: {} }).fire, "morning");
  // ...and only the TARGET lane's state matters
  assert.equal(decide(now, text, { taskStates: { sync: "Running" } }).fire, "morning");
});

test("a Running heavy task does not fall through to the sync lane", () => {
  const text = heavyLine(YESTERDAY_EVENING);
  const d = decide(local(1, 13, 0), text, { taskStates: { morning: "Running" } });
  assert.equal(d.fire, null);
  assert.equal(d.reason, "already-running(morning)");
});

test("a Running Sync task suppresses a sync-gap fire", () => {
  const text = heavyLine(local(1, 7, 5));
  const d = decide(local(1, 13, 0), text, { taskStates: { sync: "Running" } });
  assert.equal(d.fire, null);
  assert.equal(d.reason, "already-running(sync)");
});

test("the decision is pure - same inputs, same answer", () => {
  const text = [heavyLine(YESTERDAY_EVENING), syncLine(local(1, 9, 0))].join("\n");
  const a = decide(local(1, 13, 0), text);
  const b = decide(local(1, 13, 0), text);
  assert.deepEqual(a, b);
});

test("an empty or missing run log reads as very stale, and never throws", () => {
  assert.equal(decide(local(1, 13, 0), "").fire, "morning");
  assert.equal(decide(local(1, 13, 0), "garbage\n???\n").fire, "morning");
  // ...but quiet hours and the sync window still hold over a blank log
  assert.equal(decide(local(1, 3, 0), "").fire, null);
  assert.equal(decideStale({ now: local(1, 13, 0) }).fire, "morning");
});

// --- line + file helpers --------------------------------------------------

test("staleLine has exactly the contract shape", () => {
  const line = staleLine(local(1, 13, 40), "morning", "missed-morning");
  assert.match(line, /^STALE \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z fired=morning reason=missed-morning$/);
  // and it must be invisible to the heavy lane when read back
  assert.equal(parseRunlog(line).lastHeavyAt, null);
  assert.equal(parseRunlog(line).stale, 1);
});

test("boundaryToday / minuteOfDay work in local wall-clock terms", () => {
  const b = boundaryToday(local(1, 22, 0), { h: 7, m: 3 });
  assert.equal(b.getHours(), 7);
  assert.equal(b.getMinutes(), 3);
  assert.equal(b.getDate(), 1);
  assert.equal(minuteOfDay(local(1, 7, 23)), 443);
});

test("appendLine never joins onto an unterminated last line", () =>
  withTempRepo(({ runlogFile }) => {
    writeFileSync(runlogFile, `${heavyLine(YESTERDAY_EVENING)}`); // no trailing \n
    appendLine(runlogFile, staleLine(local(1, 13, 40), "morning", "missed-morning"));
    const lines = readFileSync(runlogFile, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith("STALE "));
    assert.equal(parseRunlog(readFileSync(runlogFile, "utf8")).heavy, 1);
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
});

test("CLI: a missed morning fires the Morning TASK and logs one STALE line", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    writeFileSync(runlogFile, `${heavyLine(YESTERDAY_EVENING)}\n`);
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
    assert.deepEqual(sched.calls, [TASKS.morning]); // never run-agent.cmd, never twice
    const lines = readFileSync(runlogFile, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(lines[1], `STALE ${zulu(now)} fired=morning reason=missed-morning`);

    const state = readStateFile(stateFile);
    assert.equal(state.lastFired, "morning");
    assert.equal(state.lastFiredAt, zulu(now));
    assert.equal(state.lastCheckAt, zulu(now));
  }));

test("CLI: a quiet check writes lastCheckAt and touches nothing else", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    const before = `${heavyLine(local(1, 7, 5))}\n${syncLine(local(1, 12, 30))}\n`;
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
    const before = `${heavyLine(YESTERDAY_EVENING)}\n`;
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
    assert.deepEqual(sched.calls, [TASKS.morning]);
    assert.equal(readFileSync(runlogFile, "utf8"), before); // no STALE line for a fire that did not happen
    assert.equal(readStateFile(stateFile).lastFiredAt, null); // so the next check tries again
  }));

test("CLI: the debounce survives a round trip through the state file", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    writeFileSync(runlogFile, `${heavyLine(YESTERDAY_EVENING)}\n`);
    const sched = recorder();
    const opts = { dir, runTask: sched.run, queryTaskState: () => "Ready", log: () => {} };

    cliMain([], { ...opts, now: local(1, 13, 0) });
    cliMain([], { ...opts, now: local(1, 13, 5) }); // logon + unlock seconds apart
    cliMain([], { ...opts, now: local(1, 13, 20) });
    assert.deepEqual(sched.calls, [TASKS.morning], "one open laptop must not queue three runs");

    cliMain([], { ...opts, now: local(1, 13, 40) }); // past the debounce, still stale
    assert.deepEqual(sched.calls, [TASKS.morning, TASKS.morning]);
    assert.equal(readStateFile(stateFile).lastFiredAt, zulu(local(1, 13, 40)));
    assert.equal(readFileSync(runlogFile, "utf8").split("\n").filter((l) => l.startsWith("STALE ")).length, 2);
  }));

test("CLI: --dry-run decides but writes and fires nothing", () =>
  withTempRepo(({ dir, runlogFile, stateFile }) => {
    const before = `${heavyLine(YESTERDAY_EVENING)}\n`;
    writeFileSync(runlogFile, before);
    const sched = recorder();
    const said = [];
    const code = cliMain(["--dry-run"], {
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
    assert.match(said.join(" "), /fire=morning reason=missed-morning/);
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
    assert.deepEqual(sched.calls, [TASKS.morning]);
    assert.ok(existsSync(runlogFile));
    assert.ok(existsSync(stateFile));
  }));

test("CLI: a Running Morning task means the check stays quiet", () =>
  withTempRepo(({ dir, runlogFile }) => {
    const before = `${heavyLine(YESTERDAY_EVENING)}\n`;
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
      heavyLine(YESTERDAY_EVENING),
      staleLineFixture(local(1, 7, 30)),
      staleLineFixture(local(1, 8, 0)),
      "",
    ].join("\n");
    writeFileSync(runlogFile, before);
    const sched = recorder();
    const now = local(1, 13, 16);
    const code = cliMain([], { dir, now, runTask: sched.run, queryTaskState: () => "Ready", log: () => {} });

    assert.equal(code, EXIT.ok);
    assert.deepEqual(sched.calls, [], "the ration for this lane is spent");
    assert.equal(readFileSync(runlogFile, "utf8"), before); // byte-for-byte
    const state = readStateFile(stateFile);
    assert.equal(state.lastCheckAt, zulu(now)); // the watchdog is still alive
    assert.equal(state.lastFiredAt, null);
  }));

test("CLI: the cap holds across real fires, not just pre-seeded lines", () =>
  withTempRepo(({ dir, runlogFile }) => {
    writeFileSync(runlogFile, `${heavyLine(YESTERDAY_EVENING)}\n`);
    const sched = recorder();
    const opts = { dir, runTask: sched.run, queryTaskState: () => "Ready", log: () => {} };

    cliMain([], { ...opts, now: local(1, 8, 0) });  // rescue 1
    cliMain([], { ...opts, now: local(1, 9, 0) });  // rescue 2
    cliMain([], { ...opts, now: local(1, 10, 0) }); // capped
    cliMain([], { ...opts, now: local(1, 17, 0) }); // still capped, hours later
    assert.deepEqual(sched.calls, [TASKS.morning, TASKS.morning]);
    assert.equal(
      readFileSync(runlogFile, "utf8").split("\n").filter((l) => l.startsWith("STALE ")).length,
      2
    );

    // The evening lane's own ration is untouched by all of that.
    cliMain([], { ...opts, now: local(1, 19, 0) });
    assert.deepEqual(sched.calls, [TASKS.morning, TASKS.morning, TASKS.evening]);
  }));

test("CLI: a bad argument is the one thing that exits non-zero", () =>
  withTempRepo(({ dir }) => {
    const code = cliMain(["--fire-everything"], { dir, log: () => {} });
    assert.equal(code, EXIT.broken);
  }));

test("CLI: --now overrides the clock so a decision can be reproduced", () =>
  withTempRepo(({ dir, runlogFile }) => {
    writeFileSync(runlogFile, `${heavyLine(YESTERDAY_EVENING)}\n`);
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
  assert.equal(GRACE_MIN, 20);
  assert.equal(DEBOUNCE_MIN, 25);
  assert.equal(SYNC_GAP_MIN, 180);
  assert.equal(DAILY_CAP, 2);
  assert.deepEqual(TASKS, {
    morning: "Agenda Morning",
    evening: "Agenda Evening",
    sync: "Agenda Sync",
  });
});

// --- config-driven names and boundaries -----------------------------------

test("a custom taskPrefix renames all four scheduled tasks together", () => {
  const cfg = { scheduler: { taskPrefix: "Weekly" } };
  assert.deepEqual(derive(cfg).taskNames, {
    morning: "Weekly Morning",
    evening: "Weekly Evening",
    sync: "Weekly Sync",
    staleCheck: "Weekly StaleCheck",
  });
  assert.deepEqual(laneTasks(cfg), {
    morning: "Weekly Morning",
    evening: "Weekly Evening",
    sync: "Weekly Sync",
  });
});

test("the CLI fires the task name the config asks for, not a built-in one", () =>
  withTempRepo(({ dir, runlogFile }) => {
    writeFileSync(runlogFile, `${heavyLine(YESTERDAY_EVENING)}\n`);
    const sched = recorder();
    cliMain([], {
      dir,
      cfg: { scheduler: { taskPrefix: "Weekly" } },
      now: local(1, 8, 0),
      runTask: sched.run,
      queryTaskState: () => "Ready",
      log: () => {},
    });
    assert.deepEqual(sched.calls, ["Weekly Morning"]);
  }));

test("parseClock takes HH:MM and falls back rather than throwing on junk", () => {
  assert.deepEqual(parseClock("07:03", null), { h: 7, m: 3 });
  assert.deepEqual(parseClock("23:59", null), { h: 23, m: 59 });
  assert.deepEqual(parseClock("24:00", { h: 9, m: 0 }), { h: 9, m: 0 });
  assert.deepEqual(parseClock("7am", { h: 9, m: 0 }), { h: 9, m: 0 });
  assert.deepEqual(parseClock(undefined, { h: 9, m: 0 }), { h: 9, m: 0 });
});

test("rulesFrom({}) reproduces the documented defaults exactly", () => {
  assert.deepEqual(rulesFrom({}), DEFAULT_RULES);
  assert.deepEqual(rulesFrom(undefined), DEFAULT_RULES);
});

test("rulesFrom lifts every boundary out of config.scheduler", () => {
  const r = rulesFrom({
    morningAt: "06:30",
    eveningAt: "20:15",
    quietUntil: "06:45",
    syncWindow: ["08:00", "22:00"],
    syncGapHours: 4,
    graceMinutes: 5,
    debounceMinutes: 10,
    maxRescuesPerLane: 1,
  });
  assert.deepEqual(r.morning, { h: 6, m: 30 });
  assert.deepEqual(r.evening, { h: 20, m: 15 });
  assert.equal(r.quietUntilMin, 6 * 60 + 45);
  assert.deepEqual(r.syncWindow, { fromMin: 8 * 60, toMin: 22 * 60 });
  assert.equal(r.syncGapMin, 240);
  assert.equal(r.graceMin, 5);
  assert.equal(r.debounceMin, 10);
  assert.equal(r.dailyCap, 1);
});

test("one overridden key leaves every other default alone", () => {
  const r = rulesFrom({ graceMinutes: 45 });
  assert.equal(r.graceMin, 45);
  assert.deepEqual(r.morning, DEFAULT_RULES.morning);
  assert.equal(r.debounceMin, DEFAULT_RULES.debounceMin);
  assert.equal(r.dailyCap, DEFAULT_RULES.dailyCap);
});

test("a configured boundary moves what counts as stale", () => {
  const runlog = `${heavyLine(YESTERDAY_EVENING)}\n`;
  // 06:40 local is before the default 07:03 boundary, so nothing is stale...
  assert.equal(decideStale({ now: local(1, 6, 40), runlog }).fire, null);
  // ...but with a 05:00 morning and a 5-minute grace it plainly is.
  const rules = rulesFrom({ morningAt: "05:00", quietUntil: "05:05", graceMinutes: 5 });
  const decision = decideStale({ now: local(1, 6, 40), runlog, rules });
  assert.equal(decision.fire, "morning");
  assert.equal(decision.reason, "missed-morning");
});

test("a configured daily cap of 1 stops the second rescue", () => {
  const runlog = [heavyLine(YESTERDAY_EVENING), staleLineFixture(local(1, 7, 30))].join("\n");
  const rules = rulesFrom({ maxRescuesPerLane: 1 });
  const decision = decideStale({ now: local(1, 8, 30), runlog, rules });
  assert.equal(decision.fire, null);
  assert.equal(decision.reason, "capped-morning");
  // The same log with the default cap of 2 still has one rescue left.
  assert.equal(decideStale({ now: local(1, 8, 30), runlog }).fire, "morning");
});
