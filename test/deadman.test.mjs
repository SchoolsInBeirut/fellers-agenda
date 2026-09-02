// node --test test/deadman.test.mjs   (run from the repository root)
//
// A calendar sink cannot be unit-tested - it needs a real mailbox - so
// everything AROUND it is, with the sink injected as a mock runner. The tests
// that matter are the ordering ones: the replacement is created and verified
// BEFORE the old event is deleted, and every failure path leaves the previous
// watchdog exactly where it was. A watchdog that deletes itself and then fails
// to re-arm is worse than no watchdog, because the user believes it is watching.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  planArm,
  readState,
  nextState,
  armWithRunner,
  statusWithRunner,
  cliMain,
  localLabel,
  ascii,
  resolveCalendarSink,
  runnerFromSink,
  watchdogSubject,
  categoryOf,
  WATCHDOG_SUBJECT,
  DEFAULT_CATEGORY,
  DEFAULT_HOURS,
  DURATION_MINUTES,
  REMINDER_MINUTES,
  EXIT,
} from "../src/deadman.mjs";

const NOW = new Date("2026-09-01T18:00:00.000Z");
const OLD_ID = "000000AAOLD";
const NEW_ID = "000000BBNEW";

const armedState = (ids = [OLD_ID]) => ({
  armedAt: "2026-08-31T18:00:00.000Z",
  events: ids.map((id, i) => ({
    entryId: id,
    subject: WATCHDOG_SUBJECT,
    start: new Date(NOW.getTime() + (i + 1) * 3600000).toISOString(),
    armedAt: "2026-08-31T18:00:00.000Z",
  })),
});

/** A mock calendar bridge that records every batch it was handed, in order. */
function mockRunner(handlers = {}) {
  const calls = [];
  const runner = (ops) => {
    calls.push(ops);
    return {
      mode: 1,
      results: ops.map((op) => {
        const handler = handlers[op.action];
        if (typeof handler === "function") return handler(op);
        if (op.action === "create-verified") return { id: op.id, action: "created", ok: true, entryId: NEW_ID, exists: true };
        if (op.action === "delete") return { id: op.id, action: "deleted", ok: true };
        return { id: op.id, action: "checked", ok: true, exists: true, subject: WATCHDOG_SUBJECT };
      }),
    };
  };
  runner.calls = calls;
  return runner;
}

// ------------------------------------------------------------------- parsing

test("parseArgs reads the two modes and guards the horizon", () => {
  assert.equal(parseArgs(["--arm"]).arm, true);
  assert.equal(parseArgs(["--arm"]).hours, DEFAULT_HOURS);
  assert.equal(parseArgs(["--status"]).status, true);
  assert.equal(parseArgs(["--arm", "--hours", "48"]).hours, 48);
  assert.match(parseArgs(["--arm", "--hours", "0"]).error, /bad --hours value/);
  assert.match(parseArgs(["--arm", "--hours", "999"]).error, /bad --hours value/);
  assert.match(parseArgs(["--arm", "--hours", "soon"]).error, /bad --hours value/);
});

test("readState survives a junk or empty state file", () => {
  assert.deepEqual(readState(null), { armedAt: null, events: [] });
  assert.deepEqual(readState({ events: "nope" }), { armedAt: null, events: [] });
  assert.deepEqual(readState({ events: [{ nope: 1 }, { entryId: "" }] }).events, []);
  assert.equal(readState(armedState()).events.length, 1);
});

// ------------------------------------------------------------------ planning

test("planArm puts the event ~26h out with the reminder ON the event", () => {
  const plan = planArm(armedState(), NOW);
  assert.equal(plan.create.subject, WATCHDOG_SUBJECT);
  assert.equal(plan.create.start, new Date(NOW.getTime() + DEFAULT_HOURS * 3600000).toISOString());
  assert.equal(
    new Date(plan.create.end) - new Date(plan.create.start),
    DURATION_MINUTES * 60000,
  );
  assert.equal(plan.create.reminder, REMINDER_MINUTES);
  assert.equal(plan.create.busy, 0, "a watchdog must not book the user's time as busy");
  assert.deepEqual(plan.deleteIds, [OLD_ID]);
  assert.match(plan.create.body, /has not completed a run since/);
  assert.match(plan.create.body, /runlog\.txt/);
  assert.equal(plan.create.body, ascii(plan.create.body), "the body crosses into Outlook, so it is ASCII");
});

test("--hours moves the horizon and nothing else", () => {
  const plan = planArm(armedState(), NOW, 4);
  assert.equal(plan.create.start, new Date(NOW.getTime() + 4 * 3600000).toISOString());
  assert.equal(plan.create.subject, WATCHDOG_SUBJECT);
});

test("nextState never mutates the state it was handed", () => {
  const state = armedState();
  const before = JSON.stringify(state);
  const next = nextState(state, { entryId: NEW_ID, subject: WATCHDOG_SUBJECT, start: "2026-09-02T20:00:00.000Z" }, [], NOW);
  assert.equal(JSON.stringify(state), before);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].entryId, NEW_ID);
  assert.equal(next.armedAt, NOW.toISOString());
});

// ----------------------------------------------------------------- arming

test("arming creates the replacement BEFORE deleting the old one", () => {
  const runner = mockRunner();
  const result = armWithRunner(armedState(), { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(runner.calls.length, 2, "two batches: create, then delete");
  assert.equal(runner.calls[0][0].action, "create-verified");
  assert.deepEqual(
    runner.calls[1].map((op) => op.action),
    ["delete"],
  );
  assert.equal(runner.calls[1][0].entryId, OLD_ID);
  assert.equal(result.state.events.length, 1);
  assert.equal(result.state.events[0].entryId, NEW_ID);
  assert.match(result.lines[0], /^armed: /);
});

test("the very first arm has nothing to delete and makes only one COM call", () => {
  const runner = mockRunner();
  const result = armWithRunner({ events: [] }, { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(runner.calls.length, 1);
  assert.equal(result.state.events.length, 1);
});

test("a failed create leaves the old event in place and never deletes anything", () => {
  const runner = mockRunner({
    "create-verified": (op) => ({ id: op.id, action: "create-unverified", ok: false, error: "saved but not readable back by EntryID" }),
  });
  const state = armedState();
  const result = armWithRunner(state, { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.failed);
  assert.equal(runner.calls.length, 1, "no delete batch may follow a failed create");
  assert.deepEqual(result.state, readState(state), "state unchanged: still armed on the old timer");
  assert.match(result.lines.join(" "), /left in place/);
});

test("a create that verifies but returns no EntryID is treated as a failure", () => {
  const runner = mockRunner({ "create-verified": (op) => ({ id: op.id, ok: true, entryId: null }) });
  const result = armWithRunner(armedState(), { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.failed);
  assert.equal(runner.calls.length, 1);
});

test("the calendar backend being unavailable is exit 2, not a failure of the run", () => {
  const runner = () => {
    const e = new Error("outlook COM unavailable: server execution failed");
    e.comUnavailable = true;
    throw e;
  };
  const state = armedState();
  const result = armWithRunner(state, { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.com);
  assert.deepEqual(result.state, readState(state));
  assert.match(result.lines.join(" "), /could not reach the calendar/);
});

test("a delete that fails keeps its id for the next run, and the run still succeeds", () => {
  const runner = mockRunner({
    delete: (op) => ({ id: op.id, action: "skipped", ok: false, reason: "category guard: not a Agenda event" }),
  });
  const result = armWithRunner(armedState([OLD_ID, "000000CCOLD2"]), { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.ok, "we are armed; litter is not a failure");
  assert.equal(result.state.events.length, 3, "the new event plus the two that would not delete");
  assert.equal(result.state.events[0].entryId, NEW_ID);
  assert.match(result.lines.join(" "), /removed 0\/2/);
  assert.match(result.lines.join(" "), /stale id\(s\) kept/);
});

test("the calendar dying between the create and the delete still counts as armed", () => {
  let call = 0;
  const runner = (ops) => {
    call += 1;
    if (call === 1) return { mode: 1, results: [{ id: ops[0].id, ok: true, entryId: NEW_ID }] };
    throw new Error("RPC server is unavailable");
  };
  const result = armWithRunner(armedState(), { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.state.events.length, 2);
  assert.match(result.lines.join(" "), /will retry next run/);
});

// ------------------------------------------------------------------ status

test("status reports a live future event as ARMED", () => {
  const runner = mockRunner();
  const result = statusWithRunner(armedState(), { now: NOW, runner });
  assert.equal(result.exitCode, EXIT.ok);
  assert.equal(result.live.length, 1);
  assert.match(result.lines[0], /^ARMED: 1 future watchdog event/);
});

test("status calls a vanished or expired event what it is", () => {
  const gone = statusWithRunner(armedState(), { now: NOW, runner: mockRunner({ check: (op) => ({ id: op.id, ok: true, exists: false }) }) });
  assert.equal(gone.exitCode, EXIT.failed);
  assert.match(gone.lines.join(" "), /MISSING/);

  const later = new Date(NOW.getTime() + 48 * 3600000);
  const expired = statusWithRunner(armedState(), { now: later, runner: mockRunner() });
  assert.equal(expired.exitCode, EXIT.failed);
  assert.match(expired.lines.join(" "), /expired/);
});

test("status with an empty state file says NOT ARMED without touching the calendar", () => {
  let called = false;
  const result = statusWithRunner({ events: [] }, {
    now: NOW,
    runner: () => {
      called = true;
      return { results: [] };
    },
  });
  assert.equal(result.exitCode, EXIT.failed);
  assert.equal(called, false);
  assert.match(result.lines[0], /NOT ARMED/);
});

test("status still prints what it tracks when the calendar cannot be reached", () => {
  const result = statusWithRunner(armedState(), {
    now: NOW,
    runner: () => {
      const e = new Error("outlook COM unavailable");
      e.comUnavailable = true;
      throw e;
    },
  });
  assert.equal(result.exitCode, EXIT.com);
  assert.match(result.lines.join(" "), /unverified/);
});

// --------------------------------------------------------------------- misc

test("localLabel is ASCII and readable, and shrugs at junk", () => {
  const label = localLabel("2026-09-02T20:00:00.000Z");
  assert.equal(label, ascii(label));
  // The zone abbreviation is part of the label: "8:00 PM" alone is ambiguous
  // to a user reading it on a phone in another timezone.
  assert.match(label, /\b(EST|EDT)$/);
  assert.equal(localLabel("nope"), "unknown time");
});

test("localLabel renders in the timezone it is given, not a built-in one", () => {
  const at = "2026-09-02T20:00:00.000Z";
  const newYork = localLabel(at, "America/New_York");
  const tokyo = localLabel(at, "Asia/Tokyo");
  assert.notEqual(newYork, tokyo);
  assert.match(tokyo, /Sep 3/);
  // An unusable timezone must not stop the watchdog being planted.
  assert.equal(localLabel(at, "Not/AZone"), newYork);
});

// ------------------------------------------------------- config-driven names

test("the category and the watchdog subject come from config", () => {
  assert.equal(categoryOf({}), DEFAULT_CATEGORY);
  assert.equal(watchdogSubject(DEFAULT_CATEGORY), WATCHDOG_SUBJECT);

  const cfg = { connectors: { calendar: { outlook: { category: "Coursework" } } } };
  assert.equal(categoryOf(cfg), "Coursework");
  assert.equal(
    watchdogSubject(categoryOf(cfg)),
    "Coursework watchdog - the agenda has not run, check this computer",
  );
});

test("planArm carries the configured subject and timezone into the event", () => {
  const plan = planArm(armedState(), NOW, DEFAULT_HOURS, {
    subject: "Coursework watchdog - the agenda has not run, check this computer",
    tz: "Asia/Tokyo",
  });
  assert.equal(plan.create.subject, "Coursework watchdog - the agenda has not run, check this computer");
  // NOW is 18:00Z, which is the following morning in Tokyo. The body's own
  // timestamp has to be in the user's timezone or the "about 26 hours ago"
  // sentence reads as nonsense to the person holding the phone.
  assert.match(plan.create.body, /Sep 2, 3:00 AM GMT\+9/);
});

// -------------------------------------------------------- the calendar sink

/** A fake calendar sink: the three synchronous calls deadman needs. */
function fakeSink(overrides = {}) {
  const calls = [];
  const sink = {
    meta: { id: "calendar-fake", kind: "calendar-sink" },
    createEvent(event) {
      calls.push(["createEvent", event]);
      return overrides.createEvent
        ? overrides.createEvent(event)
        : { ok: true, entryId: NEW_ID, subject: event.subject, start: event.start };
    },
    findEvent(id) {
      calls.push(["findEvent", id]);
      return overrides.findEvent ? overrides.findEvent(id) : { ok: true, exists: true, subject: WATCHDOG_SUBJECT };
    },
    deleteEvent(id) {
      calls.push(["deleteEvent", id]);
      return overrides.deleteEvent ? overrides.deleteEvent(id) : { ok: true, action: "deleted" };
    },
  };
  sink.calls = calls;
  return sink;
}

test("runnerFromSink preserves create-then-delete ordering through a sink", () => {
  const sink = fakeSink();
  const result = armWithRunner(armedState(), { now: NOW, runner: runnerFromSink(sink) });
  assert.equal(result.exitCode, EXIT.ok);
  assert.deepEqual(
    sink.calls.map((c) => c[0]),
    ["createEvent", "deleteEvent"],
    "the replacement is created before anything is removed",
  );
  assert.equal(sink.calls[1][1], OLD_ID);
  assert.equal(result.state.events[0].entryId, NEW_ID);
});

test("a sink whose create fails never reaches deleteEvent", () => {
  const sink = fakeSink({ createEvent: () => ({ ok: false, error: "calendar refused the event" }) });
  const result = armWithRunner(armedState(), { now: NOW, runner: runnerFromSink(sink) });
  assert.equal(result.exitCode, EXIT.failed);
  assert.deepEqual(sink.calls.map((c) => c[0]), ["createEvent"]);
  assert.match(result.lines.join(" "), /calendar refused the event/);
});

test("a sink missing one of the three calls says so instead of half-arming", () => {
  const sink = { meta: { id: "calendar-partial" }, createEvent: () => ({ ok: true, entryId: NEW_ID }) };
  const result = armWithRunner(armedState(), { now: NOW, runner: runnerFromSink(sink) });
  // The create succeeded, so we are armed; only the cleanup could not run.
  assert.equal(result.exitCode, EXIT.ok);
  assert.match(result.lines.join(" "), /does not implement deleteEvent/);
  assert.equal(result.state.events.length, 2, "the id it could not delete is kept for next time");
});

test("an asynchronous sink is refused with an explanation, not a silent no-op", () => {
  const sink = { meta: { id: "calendar-async" }, createEvent: async () => ({ ok: true, entryId: NEW_ID }) };
  assert.throws(() => runnerFromSink(sink)([{ id: "arm", action: "create-verified" }]), /synchronous calendar sink/);
});

test("resolveCalendarSink reports no-calendar-sink when none is enabled", async () => {
  assert.deepEqual(await resolveCalendarSink({}, { sinks: [] }), { sink: null, reason: "no-calendar-sink" });
  const sink = fakeSink();
  assert.deepEqual(await resolveCalendarSink({}, { sinks: [sink] }), { sink, reason: null });
});

// --------------------------------------------------------------------- CLI

test("no enabled calendar sink is exit 0 and one honest line", async () => {
  const lines = [];
  const boom = () => {
    throw new Error("the CLI must not touch a calendar when no sink is enabled");
  };
  const code = await cliMain(["--arm"], { now: NOW, sinks: [], log: (m) => lines.push(m), runner: undefined, cfg: {} });
  assert.equal(code, EXIT.ok, "an optional feature nobody turned on is not a failure");
  assert.deepEqual(lines, ["deadman=SKIPPED(no-calendar-sink)"]);
  void boom;
});

test("the CLI refuses a bad horizon and prints usage, without touching the calendar", async () => {
  const lines = [];
  const boom = () => {
    throw new Error("the CLI must not reach the calendar on a usage error");
  };
  const log = (m) => lines.push(m);
  assert.equal(await cliMain(["--arm", "--hours", "0"], { now: NOW, runner: boom, log, cfg: {} }), EXIT.failed);
  assert.equal(await cliMain([], { now: NOW, runner: boom, log, cfg: {} }), EXIT.failed);
  assert.match(lines.join("\n"), /usage: node src\/deadman\.mjs --arm/);
});
