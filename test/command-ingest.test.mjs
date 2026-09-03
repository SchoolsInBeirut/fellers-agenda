// node --test  (run from the repository root)
//
// This bus is the one place where something outside the pipeline gets to change
// state, so the tests are mostly about what it REFUSES. Every refusal path has a
// case: a bad version, a stale document, an unknown op, a replayed document, a
// defer that would move a date earlier, an exam defer, an add with no date, a
// note that will not fit, an unknown study bucket, a sitting that does not exist,
// and `done`, which is refused on principle rather than on syntax.
//
// The atomicity guarantee gets its own test: one bad command in a document means
// NONE of the good ones apply.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateDoc,
  validateDefer,
  validateAdd,
  validateNote,
  validateLogstudy,
  validateAttending,
  validateSnooze,
  validateBlock,
  applyPlan,
  applyAttending,
  appendLog,
  blockEdits,
  focusBuckets,
  phoneItem,
  loadState,
  overridesMap,
  cliMain,
  ascii,
  isDayKey,
  parseClock,
  formatClock,
  snapMinutes,
  localDayKey,
  shiftDayKey,
  EXIT,
  STALE_HOURS,
  MAX_COMMANDS,
  COMMAND_LOG_CAP,
  BLOCK_HISTORY_CAP,
  DEFAULT_SIDE_BUCKET,
  readDoc,
} from "../src/command-ingest.mjs";
import { pack } from "../src/lib/envelope.mjs";

const NOW = new Date("2026-09-01T18:00:00.000Z");
const ISSUED = "2026-09-01T17:30:00.000Z";

// SEM 100 is difficulty 0 - "never appears in the focus strip" - and it is here so
// the block guard for that case is tested against a realistic shape.
const CONFIG = {
  difficulty: { "PHYS 221": 5, "MATH 210": 4, "ART 101": 1, "SEM 100": 0, "Side Project": 3 },
};

const LATEST = {
  scrapedAt: ISSUED,
  items: [
    {
      courseId: 110005,
      course: "ART 101",
      title: "Homework 2",
      due: "2026-09-01T03:59:59.000Z",
      type: "homework",
      submitted: null,
      sources: ["content"],
    },
    {
      courseId: 110001,
      course: "PHYS 221",
      title: "Evening Exam 1",
      due: "2026-09-17T23:30:00.000Z",
      type: "exam",
      submitted: null,
      sources: ["calendar"],
    },
  ],
};

const PLAN = {
  course: "PHYS 221",
  standards: { C1: { status: "todo" } },
  sittings: [
    { date: "2026-09-09", label: "Reassessment Sitting", kind: "reassessment", targets: ["C1"] },
    { date: "2026-09-17", label: "Evening Exam 1", kind: "exam", targets: ["C1"] },
  ],
  weeks: [{ start: "2026-08-31", focus: ["C1"], note: "" }],
};

const HW_KEY = "110005::homework::homework 2";
const EXAM_KEY = "110001::exam::evening exam 1";

/** A throwaway data dir seeded with the fixtures, cleaned up by the caller. */
function sandbox(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-cmd-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(LATEST));
  fs.writeFileSync(path.join(dir, "study-plan.json"), JSON.stringify(PLAN, null, 2));
  fs.writeFileSync(path.join(dir, "focus-note.txt"), "# one line per day\n");
  for (const [name, value] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}

const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const doc = (commands, over = {}) => ({ v: 1, issuedAt: ISSUED, commands, ...over });

/** Swallow the CLI's stdout so the test output stays readable, and return it. */
function capture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const code = fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function withSandbox(fn, extra = {}) {
  const dir = sandbox(extra);
  try {
    return fn(dir, loadState(dir, dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------- doc envelope

test("v must be 1: a document from a future protocol is refused, not guessed at", () => {
  withSandbox((dir, state) => {
    const v = validateDoc(doc([{ op: "snooze", hours: 2 }], { v: 2 }), state, NOW);
    assert.equal(v.status, "refused");
    assert.match(v.refusals[0].reason, /unsupported document version 2/);
    assert.deepEqual(v.plan, []);
  });
});

test("an unreadable issuedAt is refused", () => {
  withSandbox((dir, state) => {
    for (const bad of [undefined, "", "yesterday", 17]) {
      const v = validateDoc(doc([{ op: "snooze", hours: 2 }], { issuedAt: bad }), state, NOW);
      assert.equal(v.status, "refused");
      assert.match(v.refusals[0].reason, /issuedAt is missing or unreadable/);
    }
  });
});

test("a document older than 72h is STALE and applies nothing", () => {
  withSandbox((dir, state) => {
    const old = new Date(NOW.getTime() - (STALE_HOURS + 1) * 3600000).toISOString();
    const v = validateDoc(doc([{ op: "snooze", hours: 2 }], { issuedAt: old }), state, NOW);
    assert.equal(v.status, "stale");
    assert.deepEqual(v.plan, []);
    assert.match(v.refusals[0].reason, /73h old \(limit 72h\)/);
  });
});

test("a document 71h old still applies - the cutoff is a cliff, not a slope", () => {
  withSandbox((dir, state) => {
    const old = new Date(NOW.getTime() - 71 * 3600000).toISOString();
    assert.equal(validateDoc(doc([{ op: "snooze", hours: 2 }], { issuedAt: old }), state, NOW).status, "ok");
  });
});

test("ANY unknown op refuses the WHOLE document - a good command next to a bad one does not land", () => {
  withSandbox((dir, state) => {
    const v = validateDoc(
      doc([
        { op: "snooze", hours: 2, why: "driving" },
        { op: "delete", k: HW_KEY },
      ]),
      state,
      NOW,
    );
    assert.equal(v.status, "refused");
    assert.deepEqual(v.plan, [], "fail closed: nothing is planned when anything is wrong");
    assert.equal(v.refusals.length, 1);
    assert.equal(v.refusals[0].index, 1);
    assert.equal(v.refusals[0].op, "delete");
    assert.match(v.refusals[0].reason, /unknown op "delete"/);
  });
});

test("op:done is refused by name, with a pointer to the completion bus", () => {
  withSandbox((dir, state) => {
    const v = validateDoc(doc([{ op: "done", k: HW_KEY }]), state, NOW);
    assert.equal(v.status, "refused");
    assert.match(v.refusals[0].reason, /completion is not expressible from the phone bus/);
    assert.match(v.refusals[0].reason, /AGC1/);
    assert.match(v.refusals[0].reason, /completion\.mjs --done/);
  });
});

test("a document that has already been applied is refused rather than replayed", () => {
  withSandbox(
    (dir, state) => {
      const v = validateDoc(doc([{ op: "note", day: "2026-09-02", text: "again" }]), state, NOW);
      assert.equal(v.status, "refused");
      assert.match(v.refusals[0].reason, /already been applied/);
    },
    { "command-log.json": { entries: [{ at: ISSUED, op: "note", args: {}, result: "", doc: ISSUED }] } },
  );
});

test("a runaway document is refused, and a malformed commands list is too", () => {
  withSandbox((dir, state) => {
    const many = Array.from({ length: MAX_COMMANDS + 1 }, () => ({ op: "snooze", hours: 1 }));
    assert.match(validateDoc(doc(many), state, NOW).refusals[0].reason, /26 commands in one document/);
    assert.match(validateDoc(doc("nope"), state, NOW).refusals[0].reason, /`commands` must be an array/);
    assert.match(validateDoc(doc([42]), state, NOW).refusals[0].reason, /command is not an object/);
    assert.equal(validateDoc(null, state, NOW).status, "refused");
  });
});

test("an empty command list is valid and does nothing", () => {
  withSandbox((dir, state) => {
    const v = validateDoc(doc([]), state, NOW);
    assert.equal(v.status, "ok");
    assert.deepEqual(v.plan, []);
  });
});

// -------------------------------------------------------------------- defer

test("defer records a later date and describes the move", () => {
  withSandbox((dir, state) => {
    const r = validateDefer({ k: HW_KEY, to: "2026-09-04T03:59:00.000Z", why: "sick" }, state);
    assert.ok(r.ok);
    assert.equal(r.args.to, "2026-09-04T03:59:00.000Z");
    assert.equal(r.args.why, "sick");
    assert.match(r.describe, /defer ART 101 Homework 2/);
  });
});

test("defer refuses to move a date earlier, or to the same instant", () => {
  withSandbox((dir, state) => {
    assert.match(validateDefer({ k: HW_KEY, to: "2026-08-30T00:00:00Z" }, state).reason, /only ever moves a date later/);
    assert.match(validateDefer({ k: HW_KEY, to: "2026-09-01T03:59:59.000Z" }, state).reason, /not later than/);
  });
});

test("defer refuses an exam outright - that date belongs to the university", () => {
  withSandbox((dir, state) => {
    const r = validateDefer({ k: EXAM_KEY, to: "2026-10-01T00:00:00Z" }, state);
    assert.equal(r.ok, false);
    assert.match(r.reason, /is an exam/);
  });
});

test("defer refuses an item the pipeline has never heard of, and needs a real date", () => {
  withSandbox((dir, state) => {
    assert.match(validateDefer({ k: "9::hw::ghost", to: "2026-10-01T00:00:00Z" }, state).reason, /no item with key/);
    assert.match(validateDefer({ k: HW_KEY, to: "next week" }, state).reason, /real ISO datetime/);
    assert.match(validateDefer({ to: "2026-10-01T00:00:00Z" }, state).reason, /needs `k`/);
  });
});

test("an existing override is the baseline a second defer must beat", () => {
  withSandbox(
    (dir, state) => {
      assert.match(validateDefer({ k: HW_KEY, to: "2026-09-05T00:00:00Z" }, state).reason, /not later than/);
      assert.ok(validateDefer({ k: HW_KEY, to: "2026-09-20T00:00:00Z" }, state).ok);
    },
    { "overrides.json": { [HW_KEY]: { deferTo: "2026-09-10T00:00:00.000Z", why: "", at: ISSUED } } },
  );
});

// ---------------------------------------------------------------------- add

test("add builds a v2 item with cid 0, src phone and the contract's key", () => {
  withSandbox((dir, state) => {
    const r = validateAdd({ c: "Side Project", t: "Ship the webhook fix", d: "2026-09-05T20:00:00Z", desc: "PR 41" }, state);
    assert.ok(r.ok);
    assert.equal(r.args.k, "0::task::ship the webhook fix");
    const item = phoneItem(r.args, NOW);
    assert.equal(item.cid, 0);
    assert.equal(item.ty, "task");
    assert.equal(item.s, null);
    assert.deepEqual(item.src, ["phone"]);
    assert.equal(item.desc, "PR 41");
    assert.equal(item.d, "2026-09-05T20:00:00.000Z");
  });
});

test("add without a real ISO date is refused - docs/PROTOCOL.md has no undated items", () => {
  withSandbox((dir, state) => {
    assert.match(validateAdd({ c: "Side Project", t: "Something" }, state).reason, /needs a real ISO `d`/);
    assert.match(validateAdd({ c: "Side Project", t: "Something", d: "soon" }, state).reason, /needs a real ISO `d`/);
    assert.match(validateAdd({ c: "Side Project", d: "2026-09-05T20:00:00Z" }, state).reason, /needs `t`/);
    assert.match(validateAdd({ t: "Something", d: "2026-09-05T20:00:00Z" }, state).reason, /needs `c`/);
  });
});

test("add refuses a graded type and refuses to twin an item that already exists", () => {
  withSandbox((dir, state) => {
    assert.match(
      validateAdd({ c: "MATH 210", t: "Homework 3", d: "2026-09-05T20:00:00Z", ty: "homework" }, state).reason,
      /ty must be "task"/,
    );
    const first = validateAdd({ c: "Side Project", t: "Ship it", d: "2026-09-05T20:00:00Z" }, state);
    state.itemsByKey.set(first.args.k, { key: first.args.k, title: "Ship it" });
    assert.match(validateAdd({ c: "Side Project", t: "ship it", d: "2026-09-06T20:00:00Z" }, state).reason, /already exists/);
  });
});

// --------------------------------------------------------------------- note

test("note is one short line keyed to a real day", () => {
  const r = validateNote({ day: "2026-09-02", text: "iClicker location on before 4:30" });
  assert.ok(r.ok);
  assert.equal(r.describe, "note 2026-09-02: iClicker location on before 4:30");
  assert.match(validateNote({ day: "2026-09-31", text: "x" }).reason, /YYYY-MM-DD/);
  assert.match(validateNote({ day: "tomorrow", text: "x" }).reason, /YYYY-MM-DD/);
  assert.match(validateNote({ day: "2026-09-02", text: "" }).reason, /needs `text`/);
  assert.match(validateNote({ day: "2026-09-02", text: "x".repeat(91) }).reason, /91 characters, the focus strip fits 90/);
});

test("isDayKey rejects a date that does not exist", () => {
  assert.ok(isDayKey("2026-02-28"));
  assert.ok(!isDayKey("2026-02-30"));
  assert.ok(!isDayKey("2026-13-01"));
  assert.ok(!isDayKey("26-01-01"));
});

// ----------------------------------------------------------------- logstudy

test("logstudy validates the bucket before anything is spawned", () => {
  withSandbox((dir, state) => {
    assert.ok(validateLogstudy({ c: "MATH 210", mins: 120, note: "root locus" }, state).ok);
    const bad = validateLogstudy({ c: "ZZZ 999", mins: 120 }, state);
    assert.match(bad.reason, /not a known bucket/);
    // logstudy accepts every bucket the config names, difficulty 0 included: you
    // may spend an hour on a course you never plan time for. Only focus BLOCKS
    // are restricted to difficulty > 0.
    assert.match(bad.reason, /ART 101, MATH 210, PHYS 221, SEM 100, Side Project/);
    assert.match(validateLogstudy({ c: "MATH 210", mins: 0 }, state).reason, /whole number of minutes/);
    assert.match(validateLogstudy({ c: "MATH 210", mins: 1441 }, state).reason, /whole number of minutes/);
    assert.match(validateLogstudy({ c: "MATH 210", mins: 90.5 }, state).reason, /whole number of minutes/);
    assert.match(validateLogstudy({ c: "MATH 210", mins: "ninety" }, state).reason, /whole number of minutes/);
    // A doc typed by thumb may quote the number; that is a format, not an error.
    assert.equal(validateLogstudy({ c: "MATH 210", mins: "90" }, state).args.mins, 90);
  });
});

test("logstudy routes through study-model.mjs and never writes the study log itself", () => {
  withSandbox((dir, state) => {
    const calls = [];
    const runner = (args) => {
      calls.push(args);
      return { status: 0, output: "logged 120 min on MATH 210 (1 entries)" };
    };
    const { applied, failed } = applyPlan(
      validateDoc(doc([{ op: "logstudy", c: "MATH 210", mins: 120, note: "root locus" }]), state, NOW).plan,
      { dataDir: dir, rootDir: dir, now: NOW, runner },
    );
    assert.deepEqual(failed, []);
    assert.deepEqual(calls, [["MATH 210", "120", "root locus"]]);
    assert.match(applied[0].result, /study-model\.mjs --log: logged 120 min/);
    assert.equal(exists(dir, "study-log.json"), false, "the log belongs to study-model.mjs alone");
  });
});

test("a failing study-model child is an ERROR, not a silent success", () => {
  withSandbox((dir, state) => {
    const { applied, failed } = applyPlan(
      validateDoc(doc([{ op: "logstudy", c: "MATH 210", mins: 30 }]), state, NOW).plan,
      { dataDir: dir, rootDir: dir, now: NOW, runner: () => ({ status: 4, output: "unknown bucket" }) },
    );
    assert.deepEqual(applied, []);
    assert.match(failed[0].reason, /exited 4/);
  });
});

// ---------------------------------------------------------------- attending

test("attending needs a sitting that actually exists and a literal boolean", () => {
  withSandbox((dir, state) => {
    assert.ok(validateAttending({ date: "2026-09-09", value: true }, state).ok);
    assert.match(validateAttending({ date: "2026-09-08", value: true }, state).reason, /no sitting on 2026-09-08/);
    assert.match(validateAttending({ date: "2026-09-09", value: "yes" }, state).reason, /literal true or false/);
  });
});

test("applyAttending flags only the matching sittings and never mutates the plan", () => {
  const before = JSON.stringify(PLAN);
  const { plan: next, touched } = applyAttending(PLAN, "2026-09-09", true);
  assert.equal(touched, 1);
  assert.equal(next.sittings[0].attending, true);
  assert.equal(next.sittings[1].attending, undefined);
  assert.equal(JSON.stringify(PLAN), before);
  assert.equal(next.standards, PLAN.standards, "untouched branches are shared, not rebuilt");
});

// ------------------------------------------------------------------- snooze

test("snooze accepts 1-72 hours and nothing else", () => {
  assert.ok(validateSnooze({ hours: 8, why: "flight" }).ok);
  assert.match(validateSnooze({ hours: 0 }).reason, /must be 1-72/);
  assert.match(validateSnooze({ hours: 73 }).reason, /must be 1-72/);
  assert.match(validateSnooze({}).reason, /must be 1-72/);
});

// -------------------------------------------------------------------- block
//
// The page snaps to 15 minutes before it sends anything. These tests assume it did
// NOT: a browser tab left open across a deploy is running last week's javascript,
// and the ingester's snap is what makes that harmless.

const TODAY = localDayKey(NOW);
const DAY = (n) => shiftDayKey(TODAY, n);

const block = (over = {}) => ({ op: "block", day: DAY(2), c: "MATH 210", t: "20:15", mins: 90, ...over });

/** The args a validated block command carries, or the refusal reason. */
function checkBlock(over, state) {
  const r = validateBlock(block(over), state, NOW);
  return r.ok ? r.args : r.reason;
}

test("clock helpers round to the nearest 15 and never invent a time of day", () => {
  assert.equal(parseClock("20:15"), 1215);
  assert.equal(parseClock("8:05"), 485);
  assert.equal(parseClock("00:00"), 0);
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("20:60"), null);
  assert.equal(parseClock("8am"), null);
  assert.equal(parseClock(""), null);
  assert.equal(parseClock(null), null);
  assert.equal(formatClock(1215), "20:15");
  assert.equal(formatClock(0), "00:00");
  assert.equal(snapMinutes(1222), 1215, "22 past the hour rounds down");
  assert.equal(snapMinutes(1223), 1230, "23 past the hour rounds up");
  assert.equal(snapMinutes(7), 0);
  assert.equal(snapMinutes(8), 15);
  assert.equal(shiftDayKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDayKey("2026-12-31", 1), "2027-01-01");
});

test("block snaps t and mins to the 15-minute grid before it judges them", () => {
  withSandbox((dir, state) => {
    assert.deepEqual(checkBlock({ t: "20:22", mins: 97 }, state), { day: DAY(2), c: "MATH 210", t: "20:15", mins: 90 });
    assert.deepEqual(checkBlock({ t: "20:23", mins: 98 }, state), { day: DAY(2), c: "MATH 210", t: "20:30", mins: 105 });
    // 241 snaps DOWN to the cap and lands; the range check reads the snapped value.
    assert.equal(checkBlock({ t: "09:00", mins: 241 }, state).mins, 240);
    // prev is snapped on the same grid, because it is the other half of the sample.
    assert.deepEqual(checkBlock({ prev: { t: "18:07", mins: 62 } }, state).prev, { t: "18:00", mins: 60 });
  });
});

test("block refuses a bucket the focus strip would never show", () => {
  withSandbox((dir, state) => {
    assert.deepEqual(focusBuckets(state), new Set(["PHYS 221", "MATH 210", "ART 101", "Side Project"]));
    assert.ok(validateBlock(block({ c: "Side Project" }), state, NOW).ok);
    assert.match(checkBlock({ c: "SEM 100" }, state), /"SEM 100" is not a focus bucket/);
    assert.match(checkBlock({ c: "ZZZ 999" }, state), /not a focus bucket/);
    assert.match(checkBlock({ c: "ZZZ 999" }, state), /ART 101, MATH 210, PHYS 221, Side Project/);
    assert.match(checkBlock({ c: "" }, state), /needs `c`/);
  });
});

test("block refuses a day outside [today-1, today+7] local", () => {
  withSandbox((dir, state) => {
    assert.ok(validateBlock(block({ day: DAY(-1) }), state, NOW).ok, "yesterday is still editable");
    assert.ok(validateBlock(block({ day: TODAY }), state, NOW).ok);
    assert.ok(validateBlock(block({ day: DAY(7) }), state, NOW).ok, "the far edge is inclusive");
    assert.match(checkBlock({ day: DAY(-2) }, state), /outside the editable window/);
    assert.match(checkBlock({ day: DAY(8) }, state), /outside the editable window/);
    assert.match(checkBlock({ day: "2026-02-30" }, state), /YYYY-MM-DD/);
    assert.match(checkBlock({ day: "tomorrow" }, state), /YYYY-MM-DD/);
    assert.match(checkBlock({ day: 20260903 }, state), /YYYY-MM-DD/);
  });
});

test("block refuses a duration outside 15-240 AFTER snapping", () => {
  withSandbox((dir, state) => {
    assert.equal(checkBlock({ mins: 15 }, state).mins, 15);
    assert.equal(checkBlock({ t: "09:00", mins: 240 }, state).mins, 240);
    assert.match(checkBlock({ mins: 7 }, state), /0 min after 15-min snapping/);
    assert.match(checkBlock({ mins: 0 }, state), /after 15-min snapping/);
    assert.match(checkBlock({ mins: -60 }, state), /after 15-min snapping/);
    assert.match(checkBlock({ t: "09:00", mins: 250 }, state), /255 min after 15-min snapping/);
    assert.match(checkBlock({ mins: "ninety" }, state), /needs `mins` as a number/);
    assert.match(checkBlock({ mins: null }, state), /needs `mins` as a number/);
  });
});

test("block must fit inside 08:00-23:59 - the window is wider than the packer's on purpose", () => {
  withSandbox((dir, state) => {
    assert.ok(validateBlock(block({ t: "08:00", mins: 15 }), state, NOW).ok);
    assert.ok(validateBlock(block({ t: "23:00", mins: 60 }), state, NOW).ok, "a block may end the day");
    assert.match(checkBlock({ t: "07:50" }, state), /does not fit inside 08:00-23:59/);
    assert.match(checkBlock({ t: "00:30" }, state), /does not fit inside 08:00-23:59/);
    assert.match(checkBlock({ t: "23:30", mins: 60 }, state), /does not fit inside 08:00-23:59/);
    assert.match(checkBlock({ t: "23:58", mins: 15 }, state), /does not fit inside 08:00-23:59/);
    assert.match(checkBlock({ t: "8am" }, state), /needs `t` as a 24h "HH:MM"/);
    assert.match(checkBlock({ t: 2015 }, state), /needs `t` as a 24h "HH:MM"/);
  });
});

test("prev is optional, and malformed when it is present but unusable", () => {
  withSandbox((dir, state) => {
    assert.equal(checkBlock({}, state).prev, undefined, "no prev key at all when none was sent");
    assert.equal(checkBlock({ prev: null }, state).prev, undefined, "an explicit null is 'no sample'");
    assert.match(checkBlock({ prev: "18:00" }, state), /`prev` must be an object/);
    assert.match(checkBlock({ prev: { mins: 60 } }, state), /`prev\.t` must be a 24h/);
    assert.match(checkBlock({ prev: { t: "18:00" } }, state), /`prev\.mins` must be a number/);
    // A zero-minute "before" would make the learning ratio infinite.
    assert.match(checkBlock({ prev: { t: "18:00", mins: 0 } }, state), /learning sample/);
    assert.match(checkBlock({ prev: { t: "18:00", mins: 600 } }, state), /learning sample/);
  });
});

test("a block edit lands in block-edits.json, creating the file when it is absent", () => {
  withSandbox((dir, state) => {
    const verdict = validateDoc(doc([block({ prev: { t: "18:00", mins: 60 } })]), state, NOW);
    assert.equal(verdict.status, "ok");
    assert.equal(exists(dir, "block-edits.json"), false);
    const { applied, failed } = applyPlan(verdict.plan, { dataDir: dir, rootDir: dir, now: NOW, issuedAt: ISSUED });
    assert.deepEqual(failed, []);

    const file = readJson(dir, "block-edits.json");
    assert.equal(file.v, 1);
    assert.equal(file.updated, NOW.toISOString());
    assert.deepEqual(file.edits, [
      { day: DAY(2), c: "MATH 210", t: "20:15", mins: 90, prev: { t: "18:00", mins: 60 }, at: ISSUED, via: "page" },
    ]);
    assert.deepEqual(file.history, [
      { day: DAY(2), c: "MATH 210", t: "20:15", mins: 90, prev: { t: "18:00", mins: 60 }, at: ISSUED },
    ]);
    assert.equal("via" in file.history[0], false, "via belongs to the live override, not to the record");
    assert.match(applied[0].result, /block-edits\.json: MATH 210/);

    // Nothing else moved: a block is a plan for an hour, not a fact about one.
    for (const name of ["overrides.json", "phone-items.json", "study-log.json", "user-completions.json"]) {
      assert.equal(exists(dir, name), false, `${name} must not be touched by a block`);
    }
    assert.deepEqual(readJson(dir, "latest.json"), LATEST);
  });
});

test("`at` is the doc's issuedAt, canonicalised, and falls back to ingest time", () => {
  withSandbox((dir, state) => {
    const plan = validateDoc(doc([block()]), state, NOW).plan;
    applyPlan(plan, { dataDir: dir, rootDir: dir, now: NOW, issuedAt: "2026-09-01T19:30:00+02:00" });
    assert.equal(readJson(dir, "block-edits.json").history[0].at, "2026-09-01T17:30:00.000Z");
  });
  withSandbox((dir, state) => {
    const plan = validateDoc(doc([block()]), state, NOW).plan;
    applyPlan(plan, { dataDir: dir, rootDir: dir, now: NOW });
    assert.equal(readJson(dir, "block-edits.json").history[0].at, NOW.toISOString());
  });
});

test("the latest edit for a (day,c) REPLACES the previous one, and only that one", () => {
  const seed = {
    v: 1,
    edits: [
      { day: DAY(2), c: "MATH 210", t: "18:00", mins: 60, at: "2026-08-31T10:00:00.000Z", via: "page" },
      { day: DAY(2), c: "PHYS 221", t: "10:00", mins: 45, at: "2026-08-31T10:00:00.000Z", via: "page" },
      { day: DAY(3), c: "MATH 210", t: "09:00", mins: 30, at: "2026-08-31T10:00:00.000Z", via: "page" },
    ],
    history: [],
  };
  const entry = { day: DAY(2), c: "MATH 210", t: "20:15", mins: 90, at: ISSUED };
  const next = blockEdits(seed, entry, TODAY, NOW);
  assert.equal(next.edits.length, 3);
  assert.deepEqual(
    next.edits.map((e) => `${e.day} ${e.c} ${e.t}`),
    [`${DAY(2)} MATH 210 20:15`, `${DAY(2)} PHYS 221 10:00`, `${DAY(3)} MATH 210 09:00`],
    "sorted by (day, c), with the replaced entry carrying the new time",
  );
  assert.equal(next.edits.find((e) => e.c === "MATH 210" && e.day === DAY(2)).via, "page");
  assert.deepEqual(seed.edits.find((e) => e.c === "MATH 210" && e.day === DAY(2)).t, "18:00", "the input is untouched");
});

test("edits older than today-1 are pruned on every write; history is not", () => {
  const stale = [
    { day: DAY(-9), c: "MATH 210", t: "18:00", mins: 60, at: "2026-08-20T10:00:00.000Z", via: "page" },
    { day: DAY(-2), c: "Side Project", t: "18:00", mins: 60, at: "2026-08-30T10:00:00.000Z", via: "page" },
    { day: DAY(-1), c: "PHYS 221", t: "18:00", mins: 60, at: "2026-08-31T10:00:00.000Z", via: "page" },
    { day: "not-a-day", c: "PHYS 221", t: "18:00", mins: 60, at: "2026-08-31T10:00:00.000Z", via: "page" },
    null,
  ];
  const seed = { v: 1, edits: stale, history: stale.slice(0, 3).map(({ via, ...rest }) => rest) };
  const next = blockEdits(seed, { day: TODAY, c: "MATH 210", t: "20:15", mins: 90, at: ISSUED }, TODAY, NOW);
  assert.deepEqual(
    next.edits.map((e) => `${e.day} ${e.c}`),
    [`${DAY(-1)} PHYS 221`, `${TODAY} MATH 210`],
    "yesterday survives, the day before does not, and junk entries are dropped",
  );
  assert.equal(next.history.length, 4, "pruning the overrides never shortens the corpus");
});

test("history is arrival-ordered and capped at the newest 200", () => {
  const seed = {
    v: 1,
    edits: [],
    history: Array.from({ length: BLOCK_HISTORY_CAP }, (_, i) => ({ day: TODAY, c: "MATH 210", t: "09:00", mins: 30, at: String(i) })),
  };
  const next = blockEdits(seed, { day: TODAY, c: "Side Project", t: "20:15", mins: 90, at: ISSUED }, TODAY, NOW);
  assert.equal(next.history.length, BLOCK_HISTORY_CAP);
  assert.equal(next.history.at(-1).c, "Side Project", "the newest edit is last");
  assert.equal(next.history[0].at, "1", "the oldest fell off the front");
  assert.deepEqual(blockEdits(null, { day: TODAY, c: "Side Project", t: "20:15", mins: 90, at: ISSUED }, TODAY, NOW).history.length, 1);
});

test("a cross-day drag with no prev is a first-class edit, not a broken one", () => {
  withSandbox((dir, state) => {
    // The engine gave MATH 210 nothing on DAY(4); the user dragged one in from DAY(3).
    const verdict = validateDoc(doc([block({ day: DAY(4), t: "13:00", mins: 60 })]), state, NOW);
    assert.equal(verdict.status, "ok");
    applyPlan(verdict.plan, { dataDir: dir, rootDir: dir, now: NOW, issuedAt: ISSUED });
    const file = readJson(dir, "block-edits.json");
    assert.deepEqual(file.edits, [{ day: DAY(4), c: "MATH 210", t: "13:00", mins: 60, at: ISSUED, via: "page" }]);
    assert.equal("prev" in file.edits[0], false, "no prev key rather than a null one");
  });
});

test("two edits for the same (day,c) in ONE doc: last wins live, both are learned from", () => {
  withSandbox((dir, state) => {
    const verdict = validateDoc(
      doc([
        block({ t: "19:00", mins: 60, prev: { t: "18:00", mins: 60 } }),
        block({ t: "20:15", mins: 90, prev: { t: "19:00", mins: 60 } }),
      ]),
      state,
      NOW,
    );
    assert.equal(verdict.status, "ok");
    applyPlan(verdict.plan, { dataDir: dir, rootDir: dir, now: NOW, issuedAt: ISSUED });
    const file = readJson(dir, "block-edits.json");
    assert.equal(file.edits.length, 1);
    assert.equal(file.edits[0].t, "20:15");
    assert.deepEqual(file.history.map((h) => h.t), ["19:00", "20:15"]);
  });
});

test("a block rides in the same doc as a defer, and one bad block refuses both", () => {
  withSandbox((dir, state) => {
    const good = validateDoc(
      doc([
        { op: "defer", k: HW_KEY, to: "2026-09-04T03:59:00.000Z", why: "sick" },
        block(),
      ]),
      state,
      NOW,
    );
    assert.equal(good.status, "ok");
    const { applied, failed } = applyPlan(good.plan, { dataDir: dir, rootDir: dir, now: NOW, issuedAt: ISSUED });
    assert.deepEqual(failed, []);
    assert.equal(applied.length, 2);
    assert.equal(readJson(dir, "overrides.json")[HW_KEY].deferTo, "2026-09-04T03:59:00.000Z");
    assert.equal(readJson(dir, "block-edits.json").edits.length, 1);
  });

  withSandbox((dir, state) => {
    const verdict = validateDoc(
      doc([
        { op: "defer", k: HW_KEY, to: "2026-09-04T03:59:00.000Z", why: "sick" },
        block({ c: "SEM 100" }),
      ]),
      state,
      NOW,
    );
    assert.equal(verdict.status, "refused");
    assert.deepEqual(verdict.plan, [], "one bad block refuses the WHOLE document, like every other op");
    assert.equal(verdict.refusals.length, 1);
    assert.equal(verdict.refusals[0].index, 1);
    assert.equal(verdict.refusals[0].op, "block");
  });
});

test("a stale document carrying a block is still stale - blocks get no exemption", () => {
  withSandbox((dir, state) => {
    const old = new Date(NOW.getTime() - (STALE_HOURS + 1) * 3600000).toISOString();
    const v = validateDoc(doc([block()], { issuedAt: old }), state, NOW);
    assert.equal(v.status, "stale");
    assert.deepEqual(v.plan, []);
    assert.equal(exists(dir, "block-edits.json"), false);
  });
});

// -------------------------------------------------------------- apply phase

test("applying a full document writes exactly the files it promises", () => {
  withSandbox((dir, state) => {
    const commands = [
      { op: "defer", k: HW_KEY, to: "2026-09-04T03:59:00.000Z", why: "sick" },
      { op: "add", c: "Side Project", t: "Ship the webhook fix", d: "2026-09-05T20:00:00Z" },
      { op: "note", day: "2026-09-02", text: "iClicker on before 4:30" },
      { op: "attending", date: "2026-09-09", value: true },
      { op: "snooze", hours: 6, why: "driving" },
    ];
    const verdict = validateDoc(doc(commands), state, NOW);
    assert.equal(verdict.status, "ok");
    const { applied, failed } = applyPlan(verdict.plan, { dataDir: dir, rootDir: dir, now: NOW });
    assert.deepEqual(failed, []);
    assert.equal(applied.length, 5);

    assert.equal(readJson(dir, "overrides.json")[HW_KEY].deferTo, "2026-09-04T03:59:00.000Z");
    assert.equal(readJson(dir, "overrides.json")[HW_KEY].why, "sick");
    assert.equal(readJson(dir, "phone-items.json").items[0].k, "0::task::ship the webhook fix");
    assert.match(fs.readFileSync(path.join(dir, "focus-note.txt"), "utf8"), /\n2026-09-02: iClicker on before 4:30\n$/);
    assert.equal(readJson(dir, "study-plan.json").sittings[0].attending, true);
    assert.equal(readJson(dir, "snooze.json").until, "2026-09-02T00:00:00.000Z");
    assert.equal(readJson(dir, "snooze.json").why, "driving");

    // The scraped truth is untouched: a defer is a layer, never a rewrite.
    assert.deepEqual(readJson(dir, "latest.json"), LATEST);
  });
});

test("appendLog keeps the newest entries and caps the trail", () => {
  const seed = { entries: Array.from({ length: COMMAND_LOG_CAP }, (_, i) => ({ at: String(i) })) };
  const out = appendLog(seed, [{ at: "new" }]);
  assert.equal(out.entries.length, COMMAND_LOG_CAP);
  assert.equal(out.entries.at(-1).at, "new");
  assert.equal(out.entries[0].at, "1");
  assert.deepEqual(appendLog(null, [{ at: "x" }]).entries, [{ at: "x" }]);
});

test("overridesMap tolerates both shapes", () => {
  assert.deepEqual(overridesMap({ a: { deferTo: "x" } }), { a: { deferTo: "x" } });
  assert.deepEqual(overridesMap({ overrides: { a: { deferTo: "x" } } }), { a: { deferTo: "x" } });
  assert.deepEqual(overridesMap("nope"), {});
});

test("ascii folds smart punctuation instead of deleting it", () => {
  assert.equal(ascii(String.fromCharCode(0x2018) + "hi" + String.fromCharCode(0x2019)), "'hi'");
  assert.equal(ascii("a " + String.fromCharCode(0x2014) + " b"), "a - b");
  assert.equal(ascii("caf" + String.fromCharCode(0xe9)), "caf");
});

// ---------------------------------------------------------------------- CLI

test("--validate is a true dry run: exit 0 and not one byte written", () => {
  const dir = sandbox();
  const file = path.join(dir, "cmd.json");
  fs.writeFileSync(file, JSON.stringify(doc([{ op: "note", day: "2026-09-02", text: "hello" }])));
  const noteBefore = fs.readFileSync(path.join(dir, "focus-note.txt"), "utf8");
  const { code, out } = capture(() => cliMain(["--validate", file, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW }));
  assert.equal(code, EXIT.ok);
  assert.match(out, /VALID: 1 command\(s\) would apply/);
  assert.equal(fs.readFileSync(path.join(dir, "focus-note.txt"), "utf8"), noteBefore);
  assert.equal(exists(dir, "command-log.json"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--apply records every applied command in data/command-log.json", () => {
  const dir = sandbox();
  const file = path.join(dir, "cmd.json");
  fs.writeFileSync(file, JSON.stringify(doc([{ op: "snooze", hours: 3, why: "driving" }])));
  const { code, out } = capture(() => cliMain(["--apply", file, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW }));
  assert.equal(code, EXIT.ok);
  assert.match(out, /APPLIED 1\/1 command\(s\)/);
  const entries = readJson(dir, "command-log.json").entries;
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]), ["at", "op", "args", "result", "doc"]);
  assert.equal(entries[0].op, "snooze");
  assert.equal(entries[0].doc, ISSUED);
  assert.equal(entries[0].at, NOW.toISOString());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the CLI exit codes are the contract: 5 refused, 4 stale, 1 unreadable, 2 usage", () => {
  const dir = sandbox();
  const write = (name, value) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
    return p;
  };
  const refused = write("bad.json", doc([{ op: "teleport" }]));
  const stale = write("old.json", doc([{ op: "snooze", hours: 2 }], { issuedAt: "2026-08-01T00:00:00Z" }));
  const broken = write("broken.json", "{not json");

  assert.equal(capture(() => cliMain(["--apply", refused, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW })).code, EXIT.refused);
  assert.equal(capture(() => cliMain(["--apply", stale, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW })).code, EXIT.stale);
  assert.equal(capture(() => cliMain(["--apply", broken, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW })).code, EXIT.error);
  assert.equal(capture(() => cliMain(["--apply", path.join(dir, "nope.json"), "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW })).code, EXIT.error);
  assert.equal(capture(() => cliMain([], { now: NOW })).code, EXIT.usage);
  assert.equal(capture(() => cliMain(["--apply"], { now: NOW })).code, EXIT.usage);
  assert.equal(exists(dir, "command-log.json"), false, "a refused or stale document leaves no trace on disk");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--apply writes a block edit and logs it like any other command", () => {
  const dir = sandbox();
  const file = path.join(dir, "cmd.json");
  fs.writeFileSync(
    file,
    JSON.stringify(doc([{ op: "block", day: DAY(1), c: "MATH 210", t: "20:22", mins: 97, prev: { t: "18:00", mins: 60 } }])),
  );
  const { code, out } = capture(() => cliMain(["--apply", file, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW }));
  assert.equal(code, EXIT.ok);
  assert.match(out, /APPLIED 1\/1 command\(s\)/);
  assert.match(out, /block MATH 210 on \d{4}-\d{2}-\d{2}: 20:15 for 90m \(was 18:00 for 60m\)/);
  const edits = readJson(dir, "block-edits.json").edits;
  assert.deepEqual(edits, [
    { day: DAY(1), c: "MATH 210", t: "20:15", mins: 90, prev: { t: "18:00", mins: 60 }, at: ISSUED, via: "page" },
  ]);
  assert.equal(readJson(dir, "command-log.json").entries[0].op, "block");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a refused document changes nothing even when most of it was fine", () => {
  const dir = sandbox();
  const file = path.join(dir, "cmd.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      doc([
        { op: "note", day: "2026-09-02", text: "this one is fine" },
        { op: "defer", k: EXAM_KEY, to: "2026-12-01T00:00:00Z" },
      ]),
    ),
  );
  const before = fs.readFileSync(path.join(dir, "focus-note.txt"), "utf8");
  const { code, out } = capture(() => cliMain(["--apply", file, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW }));
  assert.equal(code, EXIT.refused);
  assert.match(out, /REFUSED: nothing was applied/);
  assert.match(out, /is an exam/);
  assert.equal(fs.readFileSync(path.join(dir, "focus-note.txt"), "utf8"), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- the AGQ1 bus
//
// The page writes an envelope, not a JSON file, so the reader has to accept one -
// and has to refuse a DIFFERENT envelope loudly. Pasting the payload doc into the
// command file is a plausible mistake; parsing it hopefully is not a plausible
// response.

test("readDoc accepts the AGQ1 envelope the page writes", () => {
  const document = doc([{ op: "snooze", hours: 2, why: "driving" }]);
  const { doc: back, error } = readDoc(pack("commands", document));
  assert.equal(error, undefined);
  assert.deepEqual(back, document);
});

test("readDoc still accepts the bare JSON inside the envelope", () => {
  const document = doc([{ op: "snooze", hours: 2 }]);
  assert.deepEqual(readDoc(JSON.stringify(document)).doc, document);
  assert.deepEqual(readDoc(`\n  ${JSON.stringify(document)}\n`).doc, document);
});

test("a Google Doc's soft line breaks do not stop an envelope decoding", () => {
  const document = doc([{ op: "note", day: "2026-09-02", text: "wrapped" }]);
  const wrapped = pack("commands", document).replace(/(.{40})/g, "$1\n");
  assert.deepEqual(readDoc(wrapped).doc, document);
});

test("readDoc refuses a corrupted, truncated or foreign envelope by name", () => {
  const good = pack("commands", doc([{ op: "snooze", hours: 2 }]));

  const flipped = good.slice(0, 12) + (good[12] === "A" ? "B" : "A") + good.slice(13);
  assert.ok(readDoc(flipped).error, "one wrong character is not a document");

  assert.match(readDoc(good.slice(0, good.length - 40)).error, /\.END/);
  assert.match(readDoc("").error, /empty/);
  assert.match(readDoc("BAK1.zzz.END").error, /prefix/);

  const foreign = pack("data", { v: 4, items: [] });
  assert.match(readDoc(foreign).error, /"data" envelope, not a command document/);
});

test("--apply reads an AGQ1 envelope file straight off disk", () => {
  const dir = sandbox();
  const file = path.join(dir, "cmd.txt");
  fs.writeFileSync(file, pack("commands", doc([{ op: "snooze", hours: 3, why: "driving" }])));
  const { code, out } = capture(() =>
    cliMain(["--apply", file, "--data", dir, "--config", path.join(dir, "config.json")], { now: NOW }),
  );
  assert.equal(code, EXIT.ok);
  assert.match(out, /APPLIED 1\/1 command\(s\)/);
  assert.equal(readJson(dir, "command-log.json").entries[0].op, "snooze");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------- the bucket comes from config

test("the side-project bucket is whatever config calls it, not a hardcoded name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-cmd-label-"));
  try {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ difficulty: { "MATH 210": 4 }, sideProject: { label: "Weekend Build" } }),
    );
    const state = loadState(dir, dir);
    assert.equal(state.sideBucket, "Weekend Build");
    assert.deepEqual(focusBuckets(state), new Set(["MATH 210", "Weekend Build"]));
    assert.ok(
      validateBlock({ c: "Weekend Build", day: localDayKey(NOW), t: "20:00", mins: 60 }, state, NOW).ok,
      "a block may be dragged onto the renamed bucket",
    );
    assert.match(
      validateBlock({ c: "Side Project", day: localDayKey(NOW), t: "20:00", mins: 60 }, state, NOW).reason,
      /not a focus bucket/,
      "and the default name is no longer special once it has been renamed",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("focusBuckets falls back to the default label when no config loaded", () => {
  assert.deepEqual(focusBuckets({}), new Set([DEFAULT_SIDE_BUCKET]));
  assert.equal(DEFAULT_SIDE_BUCKET, "Side Project");
});

// ------------------------------------------------- the page's own add (v5.2)

// The EXACT object web/page-template.html's addCommandOf() puts into an AGQ1
// document - op/c/t/d/ty/desc and nothing else, with `d` already an instant
// converted from 23:59 local in the build's configured timezone. It is pinned
// here as a fixture rather than built, because the point of the case is that the
// page and the bus agree on a shape neither of them can see the other computing:
// the page ports normTitle from merge.mjs, so the key it reserved for its
// pending-sync overlay has to be the key this validator derives - otherwise the
// add lands as a second item and the page's entry never reconciles away.
const PAGE_ADD = {
  op: "add",
  c: "Side Project",
  t: "Ship the demo deck",
  d: "2026-09-05T03:59:00.000Z",
  ty: "task",
  desc: "PR 305 first",
};

test("v5.2 T9: the add the PAGE emits is accepted, and refused once its key exists", () => {
  withSandbox((dir, state) => {
    const k = "0::task::ship the demo deck";
    assert.equal(state.itemsByKey.has(k), false, "nothing in the agenda answers to it yet");

    const r = validateAdd(PAGE_ADD, state);
    assert.ok(r.ok, r.reason);
    assert.equal(r.args.k, k, "the page's normTitle and merge.mjs's are one function");
    assert.equal(r.args.c, "Side Project");
    assert.equal(r.args.t, "Ship the demo deck");
    assert.equal(r.args.ty, "task");
    assert.equal(r.args.d, "2026-09-05T03:59:00.000Z", "the instant survives the round trip");
    assert.equal(r.args.desc, "PR 305 first");

    const item = phoneItem(r.args, NOW);
    assert.equal(item.k, k);
    assert.equal(item.cid, 0);
    assert.equal(item.ty, "task");
    assert.deepEqual(item.src, ["phone"]);

    // a whole document of it applies, which is what the page actually writes
    assert.equal(validateDoc(doc([PAGE_ADD]), state, NOW).status, "ok");

    // and once the item is real the same command is a twin: the page stops
    // sending it (its overlay entry is retired by the payload), and if a stale
    // document turns up anyway the bus refuses the whole of it.
    state.itemsByKey.set(k, { key: k, title: PAGE_ADD.t });
    assert.match(validateAdd(PAGE_ADD, state).reason, /already exists/);
    const v = validateDoc(doc([PAGE_ADD]), state, NOW);
    assert.equal(v.status, "refused");
    assert.deepEqual(v.plan, []);
  });
});
