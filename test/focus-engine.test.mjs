// node --test test/focus-engine.test.mjs   (run from the repository root)
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFocus,
  extractReassessment,
  collectSittings,
  sittingAttendance,
  classMeetings,
  meetingBusySpans,
  MEETING_MAX_DAYS,
  MINUTES_PER_DAY,
  wakeFloor,
  allocateMinutes,
  enforceBlockMinutes,
  pinnedBlocks,
  learnedPreferences,
  cutMinute,
  keptBlocks,
  closedSessionBuckets,
  LEARN_ALPHA,
  LEARN_MIN_SAMPLES,
  minutesOfClock,
  clockOf,
  localDayKey,
  localMinuteOfDay,
  dayDiff,
  addDays,
  HARD_DAY_START,
  HARD_DAY_END,
  MIN_BLOCK_MINUTES,
  MAX_BLOCK_MINUTES,
  MAX_BLOCKS_PER_DAY,
  DEFAULT_SIDE_BUCKET,
  DEFAULT_TUNING,
  resolveTuning,
} from "../src/focus-engine.mjs";

const TZ = "America/New_York";
// The course config.standardsPlan governs in this fixture term. The engine's
// whole sitting subsystem is dormant until a plan names one.
const STANDARDS_COURSE = "PHYS 221";
// 2026-08-31 09:00 local (EDT, UTC-4) = 13:00Z. Monday.
const NOW = new Date("2026-08-31T13:00:00.000Z");

const WEIGHTS = { "PHYS 221": 5, "CHEM 115": 5, "MATH 210": 4, "HIST 140": 3, "ART 101": 1, "SEM 100": 0 };
const LEAD = { exam: 7, project: 5, lab: 5, homework: 3, quiz: 2, default: 3 };
const BUDGET = { weekday: 240, weekend: 300, weekdayWindow: ["16:00", "22:30"], weekendWindow: ["10:00", "21:00"] };

const item = (o) => ({ s: false, src: ["test"], cid: 0, ...o });

/**
 * Every timing invariant the payload contract promises, in one place.
 *
 * `pinnedExempt` skips the ENGINE's own rules (the 30-150 band, the 08:00-23:00
 * clamp, no overlaps) for blocks the user pinned themselves - the engine takes
 * those verbatim from the drag. The day's minute budget still counts every
 * block, pinned ones included, because pinned minutes are spent minutes.
 */
function assertTimingInvariants(focus, { windows = BUDGET, pinnedExempt = false } = {}) {
  for (const day of focus) {
    const graded = pinnedExempt ? day.blocks.filter((b) => !b.pinned) : day.blocks;
    const timed = graded.filter((b) => typeof b.t === "string");
    for (const b of graded) {
      assert.ok(Number.isInteger(b.mins), `mins must be an integer (${day.d} ${b.c})`);
      assert.ok(b.mins >= MIN_BLOCK_MINUTES, `mins >= ${MIN_BLOCK_MINUTES} (${day.d} ${b.c} = ${b.mins})`);
      assert.ok(b.mins <= MAX_BLOCK_MINUTES, `mins <= ${MAX_BLOCK_MINUTES} (${day.d} ${b.c} = ${b.mins})`);
      assert.equal(b.mins % 15, 0, `mins on a 15-minute grid (${day.d} ${b.c} = ${b.mins})`);
      if (typeof b.t === "string") assert.match(b.t, /^\d{2}:\d{2}$/, "t is HH:MM");
    }
    const spans = timed
      .map((b) => [minutesOfClock(b.t), minutesOfClock(b.t) + b.mins])
      .sort((a, b) => a[0] - b[0]);
    for (const [s, e] of spans) {
      assert.ok(s >= HARD_DAY_START, `${day.d}: start ${clockOf(s)} not before 08:00`);
      assert.ok(e <= HARD_DAY_END, `${day.d}: end ${clockOf(e)} not after 23:00`);
    }
    for (let i = 1; i < spans.length; i++) {
      assert.ok(spans[i][0] >= spans[i - 1][1], `${day.d}: blocks must not overlap`);
    }
    const budget = ["Sat", "Sun"].includes(new Date(day.d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" }))
      ? windows.weekend
      : windows.weekday;
    const used = day.blocks.reduce((n, b) => n + b.mins, 0);
    assert.ok(used <= budget, `${day.d}: ${used} min allocated must fit the ${budget} min budget`);
  }
}

test("local day bucketing uses the configured timezone, not UTC", () => {
  // 2026-09-01T03:59:59Z is Aug 31 11:59:59 PM in Indiana.
  assert.equal(localDayKey("2026-09-01T03:59:59.000Z", TZ), "2026-08-31");
  assert.equal(dayDiff("2026-08-31", "2026-09-02"), 2);
  assert.equal(addDays("2026-08-31", 6), "2026-09-06");
  assert.equal(localMinuteOfDay("2026-09-01T03:59:59.000Z", TZ), 23 * 60 + 59);
  assert.equal(localMinuteOfDay("2026-09-18T00:00:00.000Z", TZ), 20 * 60);
});

test("clock helpers round-trip 24h and 12h forms", () => {
  assert.equal(minutesOfClock("16:00"), 960);
  assert.equal(minutesOfClock("7:30 PM"), 1170);
  assert.equal(minutesOfClock("7:30 pm"), 1170);
  assert.equal(minutesOfClock("12:15 AM"), 15);
  assert.equal(minutesOfClock("nonsense"), null);
  assert.equal(minutesOfClock(null), null);
  assert.equal(clockOf(1170), "19:30");
  assert.equal(clockOf(960), "16:00");
});

test("returns exactly `days` entries starting at today (local)", () => {
  const focus = computeFocus({ items: [], weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD });
  assert.equal(focus.length, 7);
  assert.equal(focus[0].d, "2026-08-31");
  assert.equal(focus[6].d, "2026-09-06");
  for (const day of focus) {
    assert.ok(Array.isArray(day.blocks), "blocks must always be an array");
    assert.equal(day.blocks.length, 0, "no items means no blocks");
  }
});

test("empty / malformed input never throws and never leaks NaN or undefined", () => {
  const focus = computeFocus({
    items: [null, {}, item({ c: "ART 101", t: "No due date", ty: "homework" })],
    weights: {},
    standardsPlan: null,
    now: NOW,
    tz: TZ,
  });
  assert.equal(focus.length, 7);
  const json = JSON.stringify(focus);
  assert.ok(!json.includes("NaN"), "no NaN in output");
  assert.ok(!json.includes("undefined"), "no undefined in output");
  assert.ok(!json.includes("null"), "no null placeholders in output");
});

test("exam proximity dominates lighter work due sooner", () => {
  const items = [
    item({ k: "a", c: "PHYS 221", t: "Evening Exam 1", d: "2026-09-02T23:30:00.000Z", ty: "exam", s: null }),
    item({ k: "b", c: "ART 101", t: "Homework 2", d: "2026-09-01T03:59:59.000Z", ty: "homework" }),
    item({ k: "c", c: "ART 101", t: "Asynchronous Quiz 3", d: "2026-09-07T03:59:00.000Z", ty: "quiz" }),
  ];
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });

  // Today, tomorrow and exam day should all lead with the exam course.
  for (const i of [0, 1, 2]) {
    assert.ok(focus[i].blocks.length > 0, `day ${i} should have blocks`);
    assert.equal(focus[i].blocks[0].c, "PHYS 221", `day ${i} should lead with PHYS 221`);
  }
  // The DEPT homework due tonight still earns a block today, just not the top one.
  assert.ok(focus[0].blocks.some((b) => b.c === "ART 101"), "DEPT work still shows up");
  assert.match(focus[0].blocks[0].why, /exam in 2 days/);
  assertTimingInvariants(focus);
});

test("submitted items are excluded entirely", () => {
  const done = item({ k: "d", c: "MATH 210", t: "HW 1", d: "2026-09-01T03:59:00.000Z", ty: "homework", s: true });
  const open = item({ k: "e", c: "MATH 210", t: "HW 2", d: "2026-09-01T03:59:00.000Z", ty: "homework", s: false });

  const withDoneOnly = computeFocus({ items: [done], weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD });
  assert.deepEqual(withDoneOnly[0].blocks, [], "a submitted item produces no block");

  const both = computeFocus({ items: [done, open], weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD });
  const text = JSON.stringify(both);
  assert.ok(text.includes("HW 2"), "the open item is planned");
  assert.ok(!text.includes("HW 1"), "the submitted item is never named");
});

test("a course weighted 0 never appears (SEM 100 seminar)", () => {
  const items = [
    item({ k: "f", c: "SEM 100", t: "Seminar attendance", d: "2026-09-01T20:00:00.000Z", ty: "other" }),
    item({ k: "g", c: "SEM 100", t: "Seminar reflection", d: "2026-09-03T20:00:00.000Z", ty: "homework" }),
  ];
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD });
  const blocks = focus.flatMap((day) => day.blocks);
  assert.equal(blocks.length, 0);
  assert.ok(!JSON.stringify(focus).includes("SEM 100"));
});

test("overdue unsubmitted work nags on today only", () => {
  const items = [item({ k: "h", c: "ART 101", t: "Homework 1", d: "2026-08-25T03:59:59.000Z", ty: "homework" })];
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  assert.equal(focus[0].blocks.length, 1);
  assert.match(focus[0].blocks[0].why, /overdue by 7 days/);
  for (let i = 1; i < 7; i++) assert.equal(focus[i].blocks.length, 0, `day ${i} must be clean`);
  assertTimingInvariants(focus);
});

test("at most 3 blocks per day, one per course", () => {
  const items = [];
  for (const c of ["PHYS 221", "MATH 210", "CHEM 115", "HIST 140", "ART 101"]) {
    for (let n = 1; n <= 3; n++) {
      items.push(item({ k: `${c}${n}`, c, t: `Task ${n}`, d: "2026-09-01T20:00:00.000Z", ty: "homework" }));
    }
  }
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  for (const day of focus) {
    assert.ok(day.blocks.length <= 3, "never more than 3 blocks");
    const courses = day.blocks.map((b) => b.c);
    assert.equal(new Set(courses).size, courses.length, "one block per course");
  }
  assertTimingInvariants(focus);
});

test("output is deterministic for the same inputs", () => {
  const items = [
    item({ k: "i", c: "MATH 210", t: "HW 1", d: "2026-09-05T03:59:00.000Z", ty: "homework", a: true }),
    item({ k: "j", c: "ART 101", t: "Movie Worksheet 2", d: "2026-09-03T03:59:59.000Z", ty: "other" }),
  ];
  const a = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  const b = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  assert.deepEqual(a, b);
});

test("extractReassessment reads the weekly sitting out of the plan note", () => {
  const note =
    "Entry points, topics already lectured. Do both practice problems for each. " +
    "First reassessment Wed Sep 2, 7:30 pm, PHYS 114 (C1 only - signup survey closed Sun 11:59 pm).";
  const r = extractReassessment(note, "2026-08-31");
  assert.equal(r.date, "2026-09-02");
  assert.equal(r.time, "7:30 PM");
  assert.equal(r.room, "PHYS 114");
  assert.deepEqual(r.standards, ["C1"]);
  assert.equal(r.kind, "reassessment");
  assert.ok(!("attending" in r), "no sittings[] record means attendance stays unknown");

  assert.equal(extractReassessment("no sitting mentioned here", "2026-08-31"), null);
  assert.equal(extractReassessment(undefined, "2026-08-31"), null);
  // A date far outside the week is rejected rather than trusted.
  assert.equal(extractReassessment("reassessment Wed Dec 2, 7:30 pm", "2026-08-31"), null);
});

test("the attending flag in sittings[] overrides whatever the week note says", () => {
  const note = "First reassessment Wed Sep 2, 7:30 pm, PHYS 114 (C1 only - signup survey closed Sun 11:59 pm).";
  const sittings = [
    { date: "2026-09-02", label: "Reassessment Sitting", kind: "reassessment", attending: false, targets: ["C1"] },
  ];
  const r = extractReassessment(note, "2026-08-31", sittings);
  assert.equal(r.attending, false, "the parsed sitting inherits the user's own record");
  assert.equal(sittingAttendance(r), "no");
});

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

test("sittingAttendance: absent means yes for exams, unknown for reassessments", () => {
  assert.equal(sittingAttendance({ kind: "exam" }), "yes");
  assert.equal(sittingAttendance({ kind: "reassessment" }), "unknown");
  assert.equal(sittingAttendance({ kind: "reassessment", attending: true }), "yes");
  assert.equal(sittingAttendance({ kind: "exam", attending: false }), "no");
  assert.equal(sittingAttendance(null), "unknown");
});

test("a sitting flagged attending:false produces no urgency and no Wednesday cram", () => {
  const standardsPlan = {
    course: STANDARDS_COURSE,
    week: {
      start: "2026-08-31",
      focus: ["C1", "C3"],
      // The note still describes the sitting - the flag has to win anyway.
      note: "Skipped the reassessment Wed Sep 2, 7:30 pm, PHYS 114 (C1 only - survey closed Sun 11:59 pm).",
    },
    standards: { C1: { name: "Isentropic", status: "todo" }, C3: { name: "Fanno", status: "todo" } },
    sittings: [
      { date: "2026-09-02", label: "Reassessment Sitting", kind: "reassessment", attending: false, targets: ["C1"] },
      { date: "2026-09-17", label: "Evening Exam 1", kind: "exam", targets: ["C1", "C2", "C3", "C4", "J1"] },
    ],
    reassessment: {
      date: "2026-09-02", time: "7:30 PM", room: "PHYS 114", standards: ["C1"],
      label: "Reassessment sitting", kind: "reassessment", attending: false,
    },
  };
  const items = [
    item({ k: "hw115", c: "CHEM 115", t: "Homework 1", d: "2026-09-05T03:59:00.000Z", ty: "homework", s: null }),
    item({ k: "hw210", c: "MATH 210", t: "HW 1", d: "2026-09-05T03:59:00.000Z", ty: "homework", s: null }),
  ];
  const focus = computeFocus({ items, weights: WEIGHTS, standardsPlan, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  const json = JSON.stringify(focus);

  assert.ok(!/sitting in \d+ day/.test(json), "a skipped sitting never counts down");
  assert.ok(!json.includes("sitting today"), "a skipped sitting is never 'today'");
  assert.ok(!json.includes("PHYS 114"), "a skipped sitting's room is never surfaced");
  assert.ok(!json.includes("signed up"), "a confirmed skip is not nagged about either");

  // Every 221 block is ordinary standards practice against Evening Exam 1.
  for (const day of focus) {
    for (const b of day.blocks.filter((x) => x.c === "PHYS 221")) {
      assert.equal(b.why, "standards plan for this week");
      assert.match(b.what, /Practice C1, C3/);
    }
  }

  // Wednesday (index 2) is led by real deliverables, not by 221 cramming.
  const wed = focus[2];
  assert.equal(wed.d, "2026-09-02");
  assert.notEqual(wed.blocks[0].c, "PHYS 221", "Wednesday must not be sitting-dominated");
  assertTimingInvariants(focus);
});

test("an unknown-attendance reassessment is mentioned gently and never dominates", () => {
  const standardsPlan = {
    course: STANDARDS_COURSE,
    week: { start: "2026-08-31", focus: ["C1", "C3"], note: "" },
    standards: { C1: { name: "Isentropic", status: "todo" }, C3: { name: "Fanno", status: "todo" } },
    // No sittings[] record for Sep 2 at all: attendance is genuinely unknown.
    sittings: [{ date: "2026-09-17", label: "Evening Exam 1", kind: "exam", targets: ["C1"] }],
    reassessment: {
      date: "2026-09-02", time: "7:30 PM", room: "PHYS 114", standards: ["C1"],
      label: "Reassessment sitting", kind: "reassessment",
    },
  };
  const items = [
    item({ k: "hw115", c: "CHEM 115", t: "Homework 1", d: "2026-09-05T03:59:00.000Z", ty: "homework", s: null }),
  ];
  const focus = computeFocus({ items, weights: WEIGHTS, standardsPlan, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });

  const mon = focus[0].blocks.find((b) => b.c === "PHYS 221");
  assert.ok(mon, "221 still gets its practice block");
  assert.equal(mon.why, "standards plan for this week", "unknown attendance gives no urgency");
  assert.match(mon.what, /only if you signed up/, "one gentle clause, that is all");

  // Wednesday: the mention is still gentle, and the block is scored as practice.
  const wed = focus[2].blocks.find((b) => b.c === "PHYS 221");
  assert.equal(wed.why, "standards plan for this week");

  // Beyond the mention window the clause disappears entirely.
  const sat = focus[5].blocks.find((b) => b.c === "PHYS 221");
  assert.ok(!sat.what.includes("signed up"), "no perpetual nagging");

  // And an unknown sitting never outranks a real deliverable with a deadline.
  const scores = focus[2].blocks.map((b) => b.c);
  assert.equal(scores[0], "CHEM 115", "Wednesday still leads with the graded homework");
  assertTimingInvariants(focus);
});

test("a sitting the user DID sign up for still drives urgency and blocks out its slot", () => {
  const standardsPlan = {
    course: STANDARDS_COURSE,
    week: {
      start: "2026-08-31",
      focus: ["C1", "C3"],
      note: "First reassessment Wed Sep 2, 7:30 pm, PHYS 114 (C1 only).",
    },
    standards: { C1: { name: "Isentropic", status: "todo" }, C3: { name: "Fanno", status: "todo" } },
    sittings: [{ date: "2026-09-17", label: "Evening Exam 1", kind: "exam", targets: ["C1", "C2"] }],
    reassessment: {
      date: "2026-09-02", time: "7:30 PM", room: "PHYS 114", standards: ["C1"],
      label: "Reassessment sitting", kind: "reassessment", attending: true,
    },
  };
  const focus = computeFocus({ items: [], weights: WEIGHTS, standardsPlan, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });

  assert.equal(focus[0].blocks[0].c, "PHYS 221");
  assert.match(focus[0].blocks[0].what, /C1, C3/);
  assert.match(focus[0].blocks[0].why, /sitting in 2 days/);
  assert.match(focus[1].blocks[0].why, /sitting in 1 day/);
  assert.match(focus[2].blocks[0].why, /sitting today/);
  assert.match(focus[2].blocks[0].what, /PHYS 114/);

  // The sitting itself (7:30-9:00 PM) is a fixed commitment: the review block
  // must be finished before it starts.
  const wed = focus[2].blocks.find((b) => b.c === "PHYS 221");
  assert.ok(wed.t, "the review block is timed");
  assert.ok(minutesOfClock(wed.t) + wed.mins <= minutesOfClock("7:30 PM"), "review finishes before the sitting");
  assertTimingInvariants(focus);
});

test("standards already met drop out of the practice block", () => {
  const standardsPlan = {
    course: STANDARDS_COURSE,
    week: { start: "2026-08-31", focus: ["C1", "C3"], note: "" },
    standards: { C1: { name: "Isentropic", status: "met" }, C3: { name: "Fanno", status: "todo" } },
    sittings: [],
  };
  const focus = computeFocus({ items: [], weights: WEIGHTS, standardsPlan, now: NOW, tz: TZ, leadTimeDays: LEAD });
  assert.match(focus[0].blocks[0].what, /C3/);
  assert.ok(!focus[0].blocks[0].what.includes("C1"), "a met standard is not practiced again");
});

test("collectSittings merges plan sittings with PHYS 221 exam items", () => {
  const items = [item({ c: "PHYS 221", t: "Evening Exam 1", d: "2026-09-18T00:00:00.000Z", ty: "exam", s: null })];
  const sittings = collectSittings(
    {
      course: STANDARDS_COURSE,
      sittings: [{ date: "2026-10-28", label: "Evening Exam 2", targets: ["C5"] }],
      reassessment: { date: "2026-09-02", label: "Reassessment sitting", standards: ["C1"] },
    },
    items,
    TZ,
  );
  assert.deepEqual(sittings.map((s) => s.date), ["2026-09-02", "2026-09-17", "2026-10-28"]);
});

test("collectSittings keeps the plan's targets, kind and attending while taking the item's time", () => {
  const items = [item({ c: "PHYS 221", t: "Evening Exam 1", d: "2026-09-18T00:00:00.000Z", ty: "exam", s: null })];
  const sittings = collectSittings(
    {
      course: STANDARDS_COURSE,
      sittings: [
        { date: "2026-09-02", label: "Reassessment Sitting", kind: "reassessment", attending: false, targets: ["C1"] },
        { date: "2026-09-17", label: "Evening Exam 1", kind: "exam", targets: ["C1", "C2", "C3", "C4", "J1"] },
      ],
      reassessment: { date: "2026-09-02", time: "7:30 PM", room: "PHYS 114", standards: ["C1"], kind: "reassessment" },
    },
    items,
    TZ,
  );
  const skipped = sittings.find((s) => s.date === "2026-09-02");
  assert.equal(skipped.attending, false, "the plan's flag survives the merge with the parsed note");
  assert.equal(skipped.kind, "reassessment");
  assert.equal(skipped.room, "PHYS 114", "the note still supplies the room");
  assert.equal(sittingAttendance(skipped), "no");

  const exam = sittings.find((s) => s.date === "2026-09-17");
  assert.deepEqual(exam.standards, ["C1", "C2", "C3", "C4", "J1"], "the plan's targets beat the item's empty list");
  assert.equal(exam.time, "8:00 PM", "the item supplies the time the plan lacks");
  assert.equal(sittingAttendance(exam), "yes", "a whole-class exam is attended by default");
});

test("evening-exam proximity still boosts 221 as it approaches", () => {
  const standardsPlan = {
    course: STANDARDS_COURSE,
    weeks: [
      { start: "2026-09-07", focus: ["C2", "C4"], note: "" },
      { start: "2026-09-14", focus: ["J1"], note: "" },
    ],
    standards: { C2: { name: "Shocks", status: "todo" }, C4: { name: "Rayleigh", status: "todo" }, J1: { name: "Predict", status: "todo" } },
    sittings: [{ date: "2026-09-17", label: "Evening Exam 1", kind: "exam", targets: ["C1", "C2", "C3", "C4", "J1"] }],
  };
  // Start the week of Sep 14 so the Thursday exam is inside the 7-day lead.
  const focus = computeFocus({
    items: [],
    weights: WEIGHTS,
    standardsPlan,
    now: new Date("2026-09-14T13:00:00.000Z"),
    tz: TZ,
    leadTimeDays: LEAD,
    studyMinutes: BUDGET,
  });
  assert.equal(focus[0].d, "2026-09-14");
  assert.match(focus[0].blocks[0].why, /sitting in 3 days/);
  assert.match(focus[3].blocks[0].why, /sitting today/);
  // Urgency climbs, so the allocation grows toward the exam.
  const mon = focus[0].blocks.find((b) => b.c === "PHYS 221");
  const wed = focus[2].blocks.find((b) => b.c === "PHYS 221");
  assert.ok(wed.mins >= mon.mins, "minutes do not shrink as the exam approaches");
  assertTimingInvariants(focus);
});

// ---------------------------------------------------------------------------
// Timed blocks
// ---------------------------------------------------------------------------

test("allocateMinutes splits proportionally on a 15-minute grid inside the budget", () => {
  assert.deepEqual(allocateMinutes([], 240), []);
  assert.deepEqual(allocateMinutes([1], 240), [MAX_BLOCK_MINUTES]); // one block cannot eat the evening
  const three = allocateMinutes([9, 7.2, 5], 240);
  assert.equal(three.reduce((a, b) => a + b, 0) <= 240, true);
  assert.ok(three[0] > three[1] && three[1] > three[2], "more need means more minutes");
  for (const v of three) assert.equal(v % 15, 0);
  // A tiny budget still never emits a sub-30-minute block.
  for (const v of allocateMinutes([5, 1], 45)) assert.ok(v >= MIN_BLOCK_MINUTES);
});

test("every block carries mins and a start time, and the day never overlaps itself", () => {
  const items = [
    item({ k: "115", c: "CHEM 115", t: "Homework 1", d: "2026-09-01T03:59:00.000Z", ty: "homework" }),
    item({ k: "210", c: "MATH 210", t: "HW 1", d: "2026-09-01T03:59:00.000Z", ty: "homework" }),
    item({ k: "dept", c: "ART 101", t: "Movie Worksheet 2", d: "2026-09-01T03:59:59.000Z", ty: "other" }),
  ];
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  assert.equal(focus[0].blocks.length, 3);
  for (const b of focus[0].blocks) {
    assert.ok(typeof b.t === "string", `${b.c} must be timed`);
    assert.ok(typeof b.mins === "number");
  }
  // Weekday window is 16:00-22:30.
  for (const b of focus[0].blocks) assert.ok(minutesOfClock(b.t) >= minutesOfClock("16:00"));
  assertTimingInvariants(focus);
});

test("harder + more urgent work gets more minutes than easy work", () => {
  const items = [
    item({ k: "115", c: "CHEM 115", t: "Homework 1", d: "2026-09-01T03:59:00.000Z", ty: "homework" }),
    item({ k: "dept", c: "ART 101", t: "Movie Worksheet 2", d: "2026-09-01T03:59:59.000Z", ty: "other" }),
  ];
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  const hard = focus[0].blocks.find((b) => b.c === "CHEM 115");
  const easy = focus[0].blocks.find((b) => b.c === "ART 101");
  assert.ok(hard.mins > easy.mins, `CHEM 115 (${hard.mins}) should outweigh ART 101 (${easy.mins})`);
});

test("a block finishes before the deadline of the work it is for", () => {
  const items = [
    // Due 4:30 PM local on the day itself - the block has to land before that.
    item({ k: "early", c: "MATH 210", t: "Quiz window closes", d: "2026-08-31T20:30:00.000Z", ty: "homework" }),
    item({ k: "late", c: "CHEM 115", t: "Homework 1", d: "2026-09-01T03:59:00.000Z", ty: "homework" }),
  ];
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET });
  const early = focus[0].blocks.find((b) => b.c === "MATH 210");
  assert.ok(early.t, "timed");
  assert.ok(
    minutesOfClock(early.t) + early.mins <= 16 * 60 + 30,
    `block ${early.t} +${early.mins} must end by 16:30`,
  );
  assertTimingInvariants(focus);
});

test("one early deadline does not drag the rest of the day into the morning", () => {
  const items = [
    // Due 5:00 PM local today - too late to fit a full block after 16:00.
    item({ k: "early", c: "Research", t: "Hoot demo", d: "2026-08-31T21:00:00.000Z", ty: "email" }),
    item({ k: "hw115", c: "CHEM 115", t: "Homework 1", d: "2026-09-04T03:59:00.000Z", ty: "homework" }),
    item({ k: "hw210", c: "MATH 210", t: "HW 1", d: "2026-09-04T03:59:00.000Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items,
    weights: { ...WEIGHTS, Research: 3 },
    now: NOW,
    tz: TZ,
    leadTimeDays: { ...LEAD, email: 2 },
    studyMinutes: BUDGET,
  });
  const day = focus[0];
  const early = day.blocks.find((b) => b.c === "Research");
  assert.ok(early.t, "the deadline-constrained block is timed");
  assert.ok(minutesOfClock(early.t) + early.mins <= 17 * 60, "it finishes by the 5:00 PM deadline");
  assert.ok(minutesOfClock(early.t) >= HARD_DAY_START, "and not before 08:00");
  // Everything else stays in the evening window where it belongs.
  for (const b of day.blocks.filter((x) => x.c !== "Research")) {
    assert.ok(
      minutesOfClock(b.t) >= minutesOfClock("16:00"),
      `${b.c} at ${b.t} should stay in the 16:00-22:30 window`,
    );
  }
  assertTimingInvariants(focus);
});

test("no study block is scheduled on top of an exam the user sits", () => {
  const items = [
    // Evening Exam 1: 2026-09-18T00:00Z = Sep 17, 8:00 PM local.
    item({ k: "ex", c: "PHYS 221", t: "Evening Exam 1", d: "2026-09-18T00:00:00.000Z", ty: "exam", s: null }),
    item({ k: "hw", c: "CHEM 115", t: "Homework 3", d: "2026-09-18T03:59:00.000Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items,
    weights: WEIGHTS,
    now: new Date("2026-09-17T13:00:00.000Z"),
    tz: TZ,
    leadTimeDays: LEAD,
    studyMinutes: BUDGET,
  });
  const day = focus[0];
  assert.equal(day.d, "2026-09-17");
  for (const b of day.blocks.filter((x) => x.t)) {
    const s = minutesOfClock(b.t);
    const e = s + b.mins;
    assert.ok(e <= 20 * 60 || s >= 22 * 60, `${b.c} ${b.t}+${b.mins} collides with the 20:00-22:00 exam`);
  }
  assertTimingInvariants(focus);
});

test("weekends use the weekend budget and window", () => {
  const items = [];
  for (const c of ["PHYS 221", "CHEM 115", "MATH 210"]) {
    items.push(item({ k: c, c, t: "Problem set", d: "2026-09-07T03:59:00.000Z", ty: "homework" }));
  }
  // Saturday 2026-09-05.
  const focus = computeFocus({
    items,
    weights: WEIGHTS,
    now: new Date("2026-09-05T13:00:00.000Z"),
    tz: TZ,
    leadTimeDays: LEAD,
    studyMinutes: BUDGET,
  });
  const sat = focus[0];
  assert.equal(sat.d, "2026-09-05");
  const used = sat.blocks.reduce((n, b) => n + b.mins, 0);
  assert.ok(used > 240, `weekend budget should exceed the weekday one (got ${used})`);
  assert.ok(used <= 300);
  for (const b of sat.blocks) {
    assert.ok(minutesOfClock(b.t) >= minutesOfClock("10:00"), "weekends start mid-morning");
    assert.ok(minutesOfClock(b.t) + b.mins <= minutesOfClock("21:00"), "weekends wrap by 21:00");
  }
  assertTimingInvariants(focus);
});

test("a custom budget is respected, including windows outside the defaults", () => {
  const tight = { weekday: 90, weekend: 90, weekdayWindow: ["06:00", "23:59"], weekendWindow: ["06:00", "23:59"] };
  const items = [];
  for (const c of ["PHYS 221", "CHEM 115", "MATH 210"]) {
    items.push(item({ k: c, c, t: "Problem set", d: "2026-09-01T03:59:00.000Z", ty: "homework" }));
  }
  const focus = computeFocus({ items, weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: tight });
  const day = focus[0];
  assert.ok(day.blocks.length <= 3);
  assert.ok(day.blocks.reduce((n, b) => n + b.mins, 0) <= 90, "the tight budget is not exceeded");
  for (const b of day.blocks) {
    // Windows are clamped to 08:00-23:00 whatever the config says.
    assert.ok(minutesOfClock(b.t) >= HARD_DAY_START);
    assert.ok(minutesOfClock(b.t) + b.mins <= HARD_DAY_END);
  }
});

test("agent notes attach to the matching local day only", () => {
  const focus = computeFocus({
    items: [],
    weights: WEIGHTS,
    now: NOW,
    tz: TZ,
    notes: { "2026-08-31": "Front-load 221 today.", "2026-12-25": "stale" },
  });
  assert.equal(focus[0].note, "Front-load 221 today.");
  for (let i = 1; i < 7; i++) assert.ok(!("note" in focus[i]));
});

// ---------------------------------------------------------------------------
// study-model weights, the wake floor, the real timetable, and the side project
// ---------------------------------------------------------------------------

const SCHEDULE = {
  "PHYS 221": {
    room: "HALL 101", attend: false, from: "2026-08-25", until: "2026-12-10",
    meets: [{ days: ["Tue", "Thu"], start: "09:00", end: "10:15" }],
  },
  "HIST 140": {
    room: "HALL 202", attend: false, from: "2026-08-25", until: "2026-12-10",
    meets: [{ days: ["Tue", "Thu"], start: "10:30", end: "11:45" }],
  },
  "MATH 210": {
    room: "LAB 110", attend: true, from: "2026-08-25", until: "2026-12-10",
    meets: [{ days: ["Tue", "Thu"], start: "13:30", end: "14:45" }],
  },
  "CHEM 115": {
    room: "LAB 110", attend: true, from: "2026-08-24", until: "2026-12-09",
    meets: [{ days: ["Mon", "Wed"], start: "16:30", end: "17:45" }],
  },
};
const ALL_DAY = { weekday: 240, weekend: 300, weekdayWindow: ["10:00", "23:00"], weekendWindow: ["10:00", "22:00"] };
// config.sideProject.label, as it reaches the engine.
const SIDE_BUCKET = "Side Project";
const SIDE_CFG = { minDailyMinutes: 60, maxDailyMinutes: 180 };
const board = (n) =>
  Array.from({ length: n }, (_, i) => ({ repo: "example-api", n: 300 + i, t: `Board item ${i}`, kind: "issue" }));

const spanOf = (b) => [minutesOfClock(b.t), minutesOfClock(b.t) + b.mins];

// --- allocWeights ----------------------------------------------------------

test("allocWeights from the study model override config.difficulty", () => {
  const items = [
    item({ k: "a", c: "ART 101", t: "Quiz 3", d: "2026-09-01T03:59:00Z", ty: "quiz" }),
    item({ k: "b", c: "HIST 140", t: "Problem Set 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  const base = { items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ };
  const prior = computeFocus(base);
  const modelled = computeFocus({ ...base, allocWeights: { "ART 101": 5, "HIST 140": 0.5 } });

  const minsOf = (focus, c) => focus[0].blocks.find((b) => b.c === c)?.mins ?? 0;
  assert.ok(minsOf(prior, "HIST 140") > minsOf(prior, "ART 101"), "priors favour 140");
  assert.ok(minsOf(modelled, "ART 101") > minsOf(modelled, "HIST 140"), "the model flips it");
});

test("an alloc of 0 mutes a course exactly like a difficulty of 0", () => {
  const items = [item({ k: "a", c: "ART 101", t: "Quiz 3", d: "2026-09-01T03:59:00Z", ty: "quiz" })];
  const focus = computeFocus({
    items, weights: WEIGHTS, allocWeights: { "ART 101": 0 },
    now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
  });
  assert.equal(focus.flatMap((d) => d.blocks).filter((b) => b.c === "ART 101").length, 0);
});

test("a bucket the model has not scored falls back to the config prior", () => {
  const items = [item({ k: "a", c: "CHEM 115", t: "Reading", d: "2026-09-01T03:59:00Z", ty: "homework" })];
  const focus = computeFocus({
    items, weights: WEIGHTS, allocWeights: { "ART 101": 4.2 },
    now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
  });
  assert.ok(focus[0].blocks.some((b) => b.c === "CHEM 115"), "115 still has its weight of 5");
});

// --- the wake floor --------------------------------------------------------

test("no block starts before config.wakeTime, whatever the window says", () => {
  const items = [
    item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-08-31T14:00:00Z", ty: "homework" }), // due 10:00 local
    item({ k: "b", c: "CHEM 115", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, tz: TZ,
    studyMinutes: { ...ALL_DAY, weekdayWindow: ["08:00", "23:00"] },
    wakeTime: "10:00",
  });
  const floor = minutesOfClock("10:00");
  for (const day of focus) {
    for (const b of day.blocks.filter((x) => x.t)) {
      assert.ok(minutesOfClock(b.t) >= floor, `${day.d} ${b.c} starts at ${b.t}, before wakeTime`);
    }
  }
});

test("the wake floor holds even for work whose deadline is earlier than it", () => {
  // Due 09:30 local: the honest answer is "as early as you are awake", never 08:00.
  const items = [item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-08-31T13:30:00Z", ty: "homework" })];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, tz: TZ,
    studyMinutes: { ...ALL_DAY, weekdayWindow: ["16:00", "22:30"] },
    wakeTime: "10:00",
  });
  const block = focus[0].blocks.find((b) => b.c === "MATH 210");
  assert.ok(block, "the work still gets a block");
  if (block.t) assert.ok(minutesOfClock(block.t) >= minutesOfClock("10:00"));
});

test("wakeFloor clamps to the 08:00 hard floor and ignores junk", () => {
  assert.equal(wakeFloor("10:00"), 10 * 60);
  assert.equal(wakeFloor("06:00"), HARD_DAY_START, "earlier than 08:00 is still 08:00");
  assert.equal(wakeFloor(null), HARD_DAY_START);
  assert.equal(wakeFloor("nonsense"), HARD_DAY_START);
});

// --- the class timetable ---------------------------------------------------

test("classMeetings reads config.schedule for one local day", () => {
  const tue = classMeetings(SCHEDULE, "2026-09-01");
  assert.deepEqual(tue.map((m) => m.c), ["PHYS 221", "HIST 140", "MATH 210"]);
  assert.equal(tue[0].attend, false);
  assert.equal(tue[2].attend, true);
  assert.equal(tue[2].start, 13 * 60 + 30);
  assert.deepEqual(classMeetings(SCHEDULE, "2026-09-05").map((m) => m.c), [], "Saturday has no classes");
  assert.deepEqual(classMeetings(SCHEDULE, "2027-01-05").map((m) => m.c), [], "the timetable stops at `until`");
  assert.deepEqual(classMeetings(null, "2026-09-01"), []);
});

test("study blocks never overlap a class the user attends", () => {
  const items = [
    item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-09-04T03:59:00Z", ty: "homework" }),
    item({ k: "b", c: "CHEM 115", t: "HW 1", d: "2026-09-03T03:59:00Z", ty: "homework" }),
    item({ k: "c", c: "HIST 140", t: "PS 1", d: "2026-09-02T03:59:00Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: ALL_DAY, tz: TZ,
    wakeTime: "10:00", schedule: SCHEDULE,
  });
  for (const day of focus) {
    for (const meeting of classMeetings(SCHEDULE, day.d).filter((m) => m.attend)) {
      for (const b of day.blocks.filter((x) => x.t)) {
        const [s, e] = spanOf(b);
        assert.ok(
          e <= meeting.start || s >= meeting.end,
          `${day.d}: ${b.c} ${b.t}+${b.mins} collides with ${meeting.c} ${meeting.start}-${meeting.end}`,
        );
      }
    }
  }
});

test("a class the user does NOT attend is free study time, not busy time", () => {
  // PHYS 221 "meets" Tue 09:00-10:15 but attend:false. With a wake floor of
  // 10:00 the only hour that could collide is 10:00-10:15, and 140 (10:30) is
  // the real test: both are self-study, so the packer may use those hours.
  const items = [item({ k: "a", c: "HIST 140", t: "PS 1", d: "2026-09-02T03:59:00Z", ty: "homework" })];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, tz: TZ,
    studyMinutes: { ...ALL_DAY, weekdayWindow: ["10:00", "23:00"] },
    wakeTime: "10:00", schedule: SCHEDULE,
  });
  const tuesday = focus.find((d) => d.d === "2026-09-01");
  const block = tuesday.blocks.find((b) => b.c === "HIST 140");
  assert.ok(block?.t, "the self-study course still gets a timed block on its own lecture day");
  assert.ok(minutesOfClock(block.t) < 12 * 60, `expected the free morning, got ${block.t}`);
});

// --- completed work --------------------------------------------------------

test("an item the user declared done generates no blocks", () => {
  const items = [
    item({ k: "110002::homework::hw 2", c: "MATH 210", t: "HW 2", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "other", c: "CHEM 115", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
    completions: { "110002::homework::hw 2": { at: "2026-08-31T18:00:00Z", via: "user" } },
  });
  const named = focus.flatMap((d) => d.blocks).map((b) => b.what).join(" ");
  assert.ok(!/HW 2/.test(named), "finished work must disappear from the focus strip");
  assert.ok(/HW 1/.test(named), "and everything else must stay");
});

// --- the side-project bucket ------------------------------------------------

test("open board work puts a side-project block on every day, inside its min/max band", () => {
  const items = [item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-09-04T03:59:00Z", ty: "homework" })];
  const focus = computeFocus({
    items, weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 }, now: NOW, leadTimeDays: LEAD, studyMinutes: ALL_DAY, tz: TZ,
    wakeTime: "10:00", schedule: SCHEDULE, board: board(15), sideProject: SIDE_CFG,
  });
  for (const day of focus) {
    const sideProject = day.blocks.filter((b) => b.c === "Side Project");
    assert.equal(sideProject.length, 1, `${day.d} must carry exactly one side-project block`);
    assert.ok(sideProject[0].mins >= SIDE_CFG.minDailyMinutes, `${day.d}: ${sideProject[0].mins} min is under the daily floor`);
    assert.ok(sideProject[0].mins <= Math.min(SIDE_CFG.maxDailyMinutes, MAX_BLOCK_MINUTES), `${day.d}: over the daily ceiling`);
  }
});

test("the side-project block is funded from the same budget, never on top of it", () => {
  const items = [
    item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "b", c: "CHEM 115", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "c", c: "HIST 140", t: "PS 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items, weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 }, now: NOW, leadTimeDays: LEAD, studyMinutes: ALL_DAY, tz: TZ,
    wakeTime: "10:00", board: board(4), sideProject: SIDE_CFG,
  });
  assertTimingInvariants(focus, { windows: ALL_DAY });
  const today = focus[0];
  assert.ok(today.blocks.some((b) => b.c === "Side Project"));
  assert.ok(today.blocks.reduce((n, b) => n + b.mins, 0) <= ALL_DAY.weekday);
});

test("no side-project work means no side-project block at all", () => {
  const items = [item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-09-04T03:59:00Z", ty: "homework" })];
  const focus = computeFocus({
    items, weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 }, now: NOW, leadTimeDays: LEAD, studyMinutes: ALL_DAY, tz: TZ,
    board: [], sideProject: SIDE_CFG,
  });
  assert.equal(focus.flatMap((d) => d.blocks).filter((b) => b.c === "Side Project").length, 0);
});

test("a dated side-project item is a normal deadline, not a board nudge", () => {
  const items = [
    item({ k: "sideProject-demo", c: "Side Project", t: "Demo prep for investor call", d: "2026-09-01T21:00:00Z", ty: "task" }),
  ];
  const focus = computeFocus({
    items, weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 }, now: NOW, leadTimeDays: { ...LEAD, task: 2 },
    studyMinutes: ALL_DAY, tz: TZ, wakeTime: "10:00", board: [], sideProject: SIDE_CFG,
  });
  const named = focus.flatMap((d) => d.blocks).filter((b) => b.c === "Side Project");
  assert.ok(named.length > 0, "dated side-project work counts as open side-project work");
  assert.ok(named.some((b) => /Demo prep/.test(b.what)), "and the block names the deliverable");
});

test("enforceBlockMinutes lifts a block to its floor by shaving the least-needed one", () => {
  const mins = [120, 90, 30];
  const needs = [5, 3, 1];
  const out = enforceBlockMinutes(mins, needs, 2, 60, 180, 240);
  assert.equal(out[2], 60, "the floor is met");
  assert.equal(out.reduce((s, v) => s + v, 0), 240, "the budget is unchanged");
  assert.ok(out[1] < 90, "the least-needed block paid for it");
  assert.equal(out[0], 120, "the most-needed block was not touched");
});

test("enforceBlockMinutes caps a greedy block and hands the minutes back", () => {
  const out = enforceBlockMinutes([150, 60, 30], [1, 5, 3], 0, 60, 90, 240);
  assert.equal(out[0], 90, "capped at the ceiling");
  assert.equal(out[1], 120, "the most-needed block took the surplus");
  assert.ok(out.reduce((s, v) => s + v, 0) <= 240);
});

test("enforceBlockMinutes honours the budget over the floor when the day is tiny", () => {
  const out = enforceBlockMinutes([30, 30], [5, 1], 0, 120, 180, 60);
  assert.equal(out.reduce((s, v) => s + v, 0), 60, "never spend more than the budget");
  assert.ok(out.every((v) => v >= MIN_BLOCK_MINUTES));
});

test("every optional input really is optional - a bare call still produces a day", () => {
  const items = [item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-09-01T03:59:00Z", ty: "homework" })];
  const before = computeFocus({ items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ });
  const after = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
    allocWeights: null, wakeTime: null, schedule: null, board: [], sideProject: null, completions: null,
  });
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// The user's own block edits - APPLY (pinning) and LEARN (preferences)
// ---------------------------------------------------------------------------

/** Four courses, all due 11:59 PM tonight - a full, contested Monday. */
const CONTESTED = ["CHEM 115", "MATH 210", "HIST 140", "ART 101"].map((c) =>
  item({ k: c, c, t: `${c} problem set`, d: "2026-09-01T03:59:00Z", ty: "homework" }),
);
const MONDAY = "2026-08-31";

const edit = (o) => ({ at: "2026-08-31T12:00:00Z", via: "page", ...o });
const editsOf = (...edits) => ({ v: 1, updated: "2026-08-31T12:00:00Z", edits, history: [] });
/** n identical history entries for one bucket, one day apart so `at` is total. */
const historyOf = (c, prev, next, n) => ({
  v: 1,
  updated: "2026-08-31T12:00:00Z",
  edits: [],
  history: Array.from({ length: n }, (_, i) => ({
    day: "2026-08-24",
    c,
    t: next.t,
    mins: next.mins,
    prev,
    at: `2026-08-${String(20 + i).padStart(2, "0")}T12:00:00Z`,
  })),
});

const base = { weights: WEIGHTS, now: NOW, tz: TZ, leadTimeDays: LEAD, studyMinutes: BUDGET };
const pinnedIn = (day) => day.blocks.filter((b) => b.pinned);

// --- APPLY -----------------------------------------------------------------

test("a pinned block sits exactly where the user dropped it and the day packs around it", () => {
  const blockEdits = editsOf(
    edit({ day: MONDAY, c: "MATH 210", t: "20:15", mins: 90, prev: { t: "18:00", mins: 60 } }),
  );
  const focus = computeFocus({ ...base, items: CONTESTED, blockEdits });
  const today = focus[0];

  const pin = today.blocks[0];
  assert.equal(pin.c, "MATH 210", "the pin leads the day - the user chose it herself");
  assert.equal(pin.pinned, true);
  assert.equal(pin.t, "20:15", "verbatim start");
  assert.equal(pin.mins, 90, "verbatim duration");
  assert.match(pin.what, /problem set/, "it keeps the work the engine had planned for that course");

  // Everything else routes around it, exactly as it routes around a class.
  const others = today.blocks.filter((b) => !b.pinned);
  assert.ok(others.length >= 1, "the rest of the day survives");
  for (const b of others) {
    const [s, e] = spanOf(b);
    assert.ok(e <= 20 * 60 + 15 || s >= 21 * 60 + 45, `${b.c} ${b.t}+${b.mins} collides with the pin`);
    assert.ok(s >= minutesOfClock("16:00"), `${b.c} stays inside the study window`);
  }
  assertTimingInvariants(focus);
});

test("pinning a course the engine gave no block synthesizes a self-study one", () => {
  const items = [item({ k: "a", c: "CHEM 115", t: "Homework 1", d: "2026-09-01T03:59:00Z", ty: "homework" })];
  const focus = computeFocus({
    ...base,
    items,
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "19:00", mins: 60 })),
  });
  const pin = pinnedIn(focus[0])[0];
  assert.ok(pin, "the pin exists even though MATH 210 had nothing due");
  assert.equal(pin.c, "MATH 210");
  assert.equal(pin.what, "Self-study MATH 210");
  assert.equal(pin.why, "you put this block here");
  assert.equal(pin.t, "19:00");
  assert.equal(pin.mins, 60);
  assertTimingInvariants(focus);
});

test("pinning a course that lost the 3-block cut promotes its real candidate, not a stub", () => {
  // ART 101 is the weakest of the four and never makes the cut on its own.
  const unpinned = computeFocus({ ...base, items: CONTESTED });
  assert.ok(!unpinned[0].blocks.some((b) => b.c === "ART 101"), "ART 101 is cut without a pin");

  const focus = computeFocus({
    ...base,
    items: CONTESTED,
    blockEdits: editsOf(edit({ day: MONDAY, c: "ART 101", t: "21:00", mins: 45 })),
  });
  const pin = pinnedIn(focus[0])[0];
  assert.equal(pin.c, "ART 101");
  assert.match(pin.what, /Submit ART 101 problem set/, "it is the block the engine would have written");
  assert.notEqual(pin.why, "you put this block here", "a real candidate keeps its real reason");
  assertTimingInvariants(focus);
});

test("pinned minutes come out of the day's budget, not on top of it", () => {
  const without = computeFocus({ ...base, items: CONTESTED });
  const withPin = computeFocus({
    ...base,
    items: CONTESTED,
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "20:15", mins: 90 })),
  });
  const sum = (blocks) => blocks.reduce((n, b) => n + b.mins, 0);

  assert.equal(sum(without[0].blocks), 240, "the unpinned day already spends the whole weekday budget");
  assert.equal(sum(withPin[0].blocks), 240, "and the pinned day spends exactly the same");
  assert.equal(
    sum(withPin[0].blocks.filter((b) => !b.pinned)),
    240 - 90,
    "the un-pinned blocks share only what the pin left",
  );
  const before = without[0].blocks.find((b) => b.c === "CHEM 115").mins;
  const after = withPin[0].blocks.find((b) => b.c === "CHEM 115").mins;
  assert.ok(after < before, `CHEM 115 should shrink to pay for the pin (${before} -> ${after})`);
  assertTimingInvariants(withPin);
});

test("when the pin eats the budget the weakest block drops - and never the pin", () => {
  const items = [
    item({ k: "a", c: "CHEM 115", t: "Homework 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "b", c: "MATH 210", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "c", c: "ART 101", t: "Worksheet", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  // 195 of the 240 weekday minutes are spoken for: room for exactly one more.
  const tight = computeFocus({
    ...base,
    items,
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "16:00", mins: 195 })),
  });
  const today = tight[0];
  assert.equal(today.blocks.length, 2, "the pin plus the single block the leftovers can fund");
  assert.equal(today.blocks[0].c, "MATH 210");
  assert.equal(today.blocks[0].mins, 195, "the pin is never shaved");
  assert.equal(today.blocks[1].c, "CHEM 115", "the strongest, neediest survivor keeps its block");
  assert.ok(!today.blocks.some((b) => b.c === "ART 101"), "the weakest, least-needed block is the one that goes");
  assert.equal(today.blocks.reduce((n, b) => n + b.mins, 0), 240, "and the budget still holds exactly");

  // A pin that spends the entire day leaves the pin, alone, untouched.
  const total = computeFocus({
    ...base,
    items,
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "16:00", mins: 240 })),
  });
  assert.equal(total[0].blocks.length, 1);
  assert.deepEqual(total[0].blocks[0], {
    c: "MATH 210",
    what: "Submit HW 1",
    why: "due tonight 11:59 PM",
    t: "16:00",
    mins: 240,
    pinned: true,
  });
  assertTimingInvariants(tight, { pinnedExempt: true });
  assertTimingInvariants(total, { pinnedExempt: true });
});

test("a pin outranks the engine's own wake floor and window - the user was explicit", () => {
  const focus = computeFocus({
    ...base,
    items: CONTESTED,
    wakeTime: "10:00",
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "08:30", mins: 45 })),
  });
  const pin = pinnedIn(focus[0])[0];
  assert.equal(pin.t, "08:30", "the wake floor is a guess about the user; a drag is the user");
  assert.equal(pin.mins, 45);
  for (const b of focus[0].blocks.filter((x) => !x.pinned)) {
    assert.ok(minutesOfClock(b.t) >= minutesOfClock("16:00"), "everything else still obeys the window");
  }
});

test("an edit for another day never leaks into today", () => {
  const items = ["CHEM 115", "MATH 210"].map((c) =>
    item({ k: c, c, t: `${c} set`, d: "2026-09-04T03:59:00Z", ty: "homework" }),
  );
  const focus = computeFocus({
    ...base,
    items,
    blockEdits: editsOf(
      edit({ day: "2026-09-03", c: "MATH 210", t: "20:15", mins: 90 }),
      edit({ day: "2025-01-01", c: "CHEM 115", t: "20:15", mins: 90 }), // long pruned, harmless
      edit({ day: "2026-12-25", c: "CHEM 115", t: "20:15", mins: 90 }), // beyond the horizon
    ),
  });
  for (const day of focus) {
    assert.equal(pinnedIn(day).length, day.d === "2026-09-03" ? 1 : 0, `${day.d} pin count`);
  }
  assertTimingInvariants(focus);
});

test("two pins on one day are both honoured, in start order, whatever order they arrived", () => {
  const blockEdits = editsOf(
    edit({ day: MONDAY, c: "ART 101", t: "21:00", mins: 45 }),
    edit({ day: MONDAY, c: "MATH 210", t: "16:30", mins: 60 }),
  );
  const focus = computeFocus({ ...base, items: CONTESTED, blockEdits });
  const pins = pinnedIn(focus[0]);
  assert.deepEqual(pins.map((b) => b.c), ["MATH 210", "ART 101"]);
  assert.deepEqual(pins.map((b) => b.t), ["16:30", "21:00"]);
  assertTimingInvariants(focus);
});

test("pinnedBlocks: latest wins per (day, course), junk is dropped, order is stable", () => {
  const pins = pinnedBlocks({
    edits: [
      { day: MONDAY, c: "MATH 210", t: "18:00", mins: 60 },
      { day: MONDAY, c: "MATH 210", t: "20:15", mins: 90 }, // supersedes the line above
      { day: MONDAY, c: "CHEM 115", t: "16:00", mins: 999 }, // clamped to the pin ceiling
      { day: "nonsense", c: "CHEM 115", t: "16:00", mins: 60 },
      { day: MONDAY, c: "CHEM 115", t: "25:00", mins: 60 },
      { day: MONDAY, c: "", t: "16:00", mins: 60 },
      { day: MONDAY, c: "HIST 140", t: "16:00", mins: 0 },
      null,
      "junk",
    ],
  });
  assert.deepEqual([...pins.keys()], [MONDAY]);
  assert.deepEqual([...pins.get(MONDAY).keys()], ["CHEM 115", "MATH 210"], "courses are re-keyed in code order, so a day with two pins is deterministic");
  assert.deepEqual(pins.get(MONDAY).get("MATH 210"), { start: 20 * 60 + 15, mins: 90 });
  assert.equal(pins.get(MONDAY).get("CHEM 115").mins, 240, "a hand-edited monster is clamped, not trusted");
  assert.equal(pinnedBlocks(null).size, 0);
  assert.equal(pinnedBlocks({}).size, 0);
  assert.equal(pinnedBlocks({ edits: "nope" }).size, 0);
});

// --- LEARN -----------------------------------------------------------------

test("learnedPreferences folds prev-carrying history into an EMA, in `at` order", () => {
  // Two edits, deliberately stored out of order: +60 then +30, x1.5 then x1.0.
  const prefs = learnedPreferences({
    history: [
      { c: "MATH 210", t: "16:30", mins: 60, prev: { t: "16:00", mins: 60 }, at: "2026-08-26T12:00:00Z" },
      { c: "MATH 210", t: "17:00", mins: 90, prev: { t: "16:00", mins: 60 }, at: "2026-08-25T12:00:00Z" },
      { c: "MATH 210", t: "19:00", mins: 90, at: "2026-08-27T12:00:00Z" }, // no prev: teaches nothing
      { c: "CHEM 115", t: "20:00", mins: 60, prev: { t: "16:00", mins: 60 }, at: "2026-08-25T12:00:00Z" },
    ],
  });
  const p = prefs.get("MATH 210");
  // seed 60, then 0.3*30 + 0.7*60 = 51.   seed 1.5, then 0.3*1.0 + 0.7*1.5 = 1.35.
  assert.equal(p.n, 2, "the prev-less entry does not count");
  assert.ok(Math.abs(p.startShift - 51) < 1e-9, `startShift ${p.startShift} should be 51`);
  assert.ok(Math.abs(p.sizeRatio - 1.35) < 1e-9, `sizeRatio ${p.sizeRatio} should be 1.35`);
  assert.equal(LEARN_ALPHA, 0.3);

  const q = prefs.get("CHEM 115");
  assert.equal(q.n, 1, "a single edit is recorded...");
  assert.equal(q.startShift, 240, "...seeded with its own observation, unsmoothed");
  assert.equal(q.sizeRatio, 1);

  // Raw and unclamped - the caller decides what authority to give it.
  const wild = learnedPreferences({
    history: [
      { c: "MATH 210", t: "22:00", mins: 15, prev: { t: "12:00", mins: 150 }, at: "2026-08-25T12:00:00Z" },
      { c: "MATH 210", t: "22:00", mins: 15, prev: { t: "12:00", mins: 150 }, at: "2026-08-26T12:00:00Z" },
    ],
  }).get("MATH 210");
  assert.equal(wild.startShift, 600);
  assert.ok(Math.abs(wild.sizeRatio - 0.1) < 1e-9);

  assert.equal(learnedPreferences(null).size, 0);
  assert.equal(learnedPreferences({ edits: [{ day: MONDAY, c: "MATH 210", t: "20:15", mins: 90 }] }).size, 0,
    "live overrides are not a learning corpus - only history[] is");
});

test("one edit teaches nothing; the second one starts shaping the day", () => {
  const items = [
    item({ k: "a", c: "MATH 210", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "b", c: "ART 101", t: "Worksheet", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  // Every recorded edit halved the block: 120 minutes cut down to 60.
  const halve = (n) => historyOf("MATH 210", { t: "16:00", mins: 120 }, { t: "16:00", mins: 60 }, n);
  const minsOf = (focus) => focus[0].blocks.find((b) => b.c === "MATH 210").mins;

  assert.equal(LEARN_MIN_SAMPLES, 2);
  assert.equal(minsOf(computeFocus({ ...base, items })), 150, "the engine's own answer is the 150-minute cap");
  assert.equal(minsOf(computeFocus({ ...base, items, blockEdits: halve(1) })), 150, "one drag changes nothing");
  assert.equal(minsOf(computeFocus({ ...base, items, blockEdits: halve(2) })), 90, "two drags halve the share");
  assert.equal(minsOf(computeFocus({ ...base, items, blockEdits: halve(5) })), 90, "and it settles there");
  assertTimingInvariants(computeFocus({ ...base, items, blockEdits: halve(2) }));
});

test("a learned size ratio is clamped to [0.5, 1.5] before anything is rounded", () => {
  const items = [item({ k: "a", c: "MATH 210", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" })];
  // The user cut a 150-minute block to 15 every time: a raw ratio of 0.1.
  const brutal = historyOf("MATH 210", { t: "16:00", mins: 150 }, { t: "16:00", mins: 15 }, 3);
  const block = computeFocus({ ...base, items, blockEdits: brutal })[0].blocks[0];
  assert.equal(block.mins, 120, "0.1 is clamped to 0.5 of the 240-minute share, not obeyed literally");
  assert.ok(block.mins > MIN_BLOCK_MINUTES, "an unclamped 0.1 would have collapsed it to the floor");
});

test("a learned start shift is clamped to +/-180 minutes and stays inside the window", () => {
  const items = [item({ k: "a", c: "MATH 210", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" })];
  const allDay = { ...BUDGET, weekdayWindow: ["08:00", "23:00"] };
  // Ten hours later, every time. The engine will move three, and no more.
  const wild = historyOf("MATH 210", { t: "08:00", mins: 60 }, { t: "18:00", mins: 60 }, 4);

  // Today opens at the clock, not at the window - NOW is 09:00 local, so
  // an 08:00 start is an hour in the past and the engine no longer offers it.
  const plain = computeFocus({ ...base, items, studyMinutes: allDay })[0].blocks[0];
  assert.equal(plain.t, "09:00", "left alone the engine opens the REMAINING window with it");

  const learned = computeFocus({ ...base, items, studyMinutes: allDay, blockEdits: wild })[0].blocks[0];
  assert.equal(learned.t, "12:00", "09:00 + the clamped 180 minutes, not 09:00 + 600");
  assertTimingInvariants([{ d: MONDAY, blocks: [learned] }], { windows: allDay });
});

test("a learned hour is a target, not a permission: the deadline still wins", () => {
  // Due 12:00 noon local. The learned preference is three hours later.
  const items = [item({ k: "a", c: "MATH 210", t: "HW 1", d: "2026-08-31T16:00:00Z", ty: "homework" })];
  const allDay = { ...BUDGET, weekdayWindow: ["08:00", "23:00"] };
  const later = historyOf("MATH 210", { t: "08:00", mins: 60 }, { t: "11:00", mins: 60 }, 3);
  const block = computeFocus({ ...base, items, studyMinutes: allDay, blockEdits: later })[0].blocks[0];

  assert.ok(minutesOfClock(block.t) > minutesOfClock("08:00"), "it moved toward the learned hour");
  assert.ok(
    minutesOfClock(block.t) + block.mins <= 12 * 60,
    `${block.t}+${block.mins} must still finish by the noon deadline`,
  );
  assert.equal(block.t, "09:30", "as late as the deadline allows, which is what the preference asked for");
});

test("a learned hour also yields to a class the user attends", () => {
  const items = [item({ k: "a", c: "CHEM 115", t: "Homework 1", d: "2026-09-03T03:59:00Z", ty: "homework" })];
  const later = historyOf("CHEM 115", { t: "10:00", mins: 60 }, { t: "13:00", mins: 60 }, 3);
  const focus = computeFocus({
    ...base,
    items,
    studyMinutes: ALL_DAY,
    wakeTime: "10:00",
    schedule: SCHEDULE,
    blockEdits: later,
  });
  const tuesday = focus.find((d) => d.d === "2026-09-01");
  const block = tuesday.blocks.find((b) => b.c === "CHEM 115");
  // MATH 210 meets 13:30-14:45 on Tuesday and the user attends it. The learned
  // 13:00 target lands inside that hour, so the block goes to the far side.
  assert.equal(block.t, "14:45", "pushed past the class rather than scheduled on top of it");
  for (const meeting of classMeetings(SCHEDULE, tuesday.d).filter((m) => m.attend)) {
    const [s, e] = spanOf(block);
    assert.ok(e <= meeting.start || s >= meeting.end, `collides with ${meeting.c}`);
  }
});

test("a pinned block ignores everything the engine has learned about that course", () => {
  // Due tomorrow night, so both today (pinned) and tomorrow (not) carry a block.
  const items = [
    item({ k: "a", c: "MATH 210", t: "HW 1", d: "2026-09-02T03:59:00Z", ty: "homework" }),
    item({ k: "b", c: "ART 101", t: "Worksheet", d: "2026-09-02T03:59:00Z", ty: "homework" }),
  ];
  const learned = historyOf("MATH 210", { t: "16:00", mins: 120 }, { t: "21:00", mins: 60 }, 4);
  const blockEdits = {
    ...learned,
    edits: [edit({ day: MONDAY, c: "MATH 210", t: "17:00", mins: 105, prev: { t: "16:00", mins: 150 } })],
  };
  const focus = computeFocus({ ...base, items, blockEdits });
  const pin = pinnedIn(focus[0])[0];
  assert.equal(pin.t, "17:00", "the pin says 17:00; the learned +300 shift has nothing to add");
  assert.equal(pin.mins, 105, "and the learned 0.5 ratio does not resize it either");

  // The preference is real - it is only the pinned day that ignores it. Tuesday
  // has no pin, so MATH 210 there is both moved and shrunk.
  const tuesday = focus[1].blocks.find((b) => b.c === "MATH 210");
  assert.ok(!tuesday.pinned);
  assert.ok(tuesday.mins < 150, "an un-pinned day still learns the smaller size");
});

// --- compatibility + determinism -------------------------------------------

test("without block edits the engine plans exactly as it does with none of them", () => {
  const rich = {
    ...base,
    items: [
      ...CONTESTED,
      item({ k: "sideProject-demo", c: "Side Project", t: "Demo prep", d: "2026-09-03T21:00:00Z", ty: "task" }),
    ],
    allocWeights: { "ART 101": 2.5 },
    weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 },
    studyMinutes: ALL_DAY,
    wakeTime: "10:00",
    schedule: SCHEDULE,
    board: board(6),
    sideProject: SIDE_CFG,
    notes: { [MONDAY]: "Front-load 221 today." },
  };
  const golden = computeFocus(rich);
  const json = JSON.stringify(golden);
  assert.ok(!json.includes("pinned"), "no `pinned` key ever appears without an edit");

  for (const blockEdits of [
    null,
    undefined,
    {},
    { v: 1, edits: [], history: [] },
    "nonsense",
    42,
    { edits: "not an array", history: null },
    { edits: [null, {}, { day: "2026-08-31" }, { c: "MATH 210" }], history: [null, {}, { c: "MATH 210" }] },
  ]) {
    const out = computeFocus({ ...rich, blockEdits });
    assert.equal(JSON.stringify(out), json, `blockEdits ${JSON.stringify(blockEdits)} must change nothing`);
  }
  assertTimingInvariants(golden, { windows: ALL_DAY });
});

test("pins and learned preferences are deterministic - same input, same output", () => {
  const blockEdits = {
    v: 1,
    edits: [
      edit({ day: MONDAY, c: "MATH 210", t: "20:15", mins: 90, prev: { t: "18:00", mins: 60 } }),
      edit({ day: "2026-09-02", c: "ART 101", t: "19:00", mins: 45 }),
    ],
    history: [
      { c: "CHEM 115", t: "20:00", mins: 90, prev: { t: "16:00", mins: 60 }, at: "2026-08-26T12:00:00Z" },
      { c: "CHEM 115", t: "19:00", mins: 75, prev: { t: "16:00", mins: 60 }, at: "2026-08-25T12:00:00Z" },
      { c: "MATH 210", t: "21:00", mins: 60, prev: { t: "18:00", mins: 120 }, at: "2026-08-27T12:00:00Z" },
      { c: "MATH 210", t: "20:00", mins: 60, prev: { t: "18:00", mins: 120 }, at: "2026-08-28T12:00:00Z" },
    ],
  };
  const args = {
    ...base,
    items: CONTESTED,
    studyMinutes: ALL_DAY,
    wakeTime: "10:00",
    schedule: SCHEDULE,
    blockEdits,
  };
  const a = computeFocus(args);
  const b = computeFocus(args);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(pinnedIn(a[0]).length, 1);
  assert.equal(pinnedIn(a[2]).length, 1);
  assertTimingInvariants(a, { windows: ALL_DAY });
});

// ---------------------------------------------------------------------------
// Cancelled work leaves the plan, and an unchecked mark brings it back
// ---------------------------------------------------------------------------
//
// "Items completed never generate blocks" (docs/PROTOCOL.md section Focus) now reads
// "items CLOSED never generate blocks", where closed means done OR cancelled.
// Cancelled is not done - nothing here claims the work happened - but the user
// has decided not to do it, so planning time for it is noise.

test("a cancelled item generates no blocks, exactly like a finished one", () => {
  const items = [
    item({ k: "110002::homework::hw 2", c: "MATH 210", t: "HW 2", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "other", c: "CHEM 115", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
    completions: { "110002::homework::hw 2": { at: "2026-08-31T18:00:00Z", via: "page", state: "cancelled" } },
  });
  const named = focus.flatMap((d) => d.blocks).map((b) => b.what).join(" ");
  assert.ok(!/HW 2/.test(named), "work the user cancelled must disappear from the focus strip");
  assert.ok(/HW 1/.test(named), "and everything else must stay");
});

test("an item already flagged cancelled:true in the payload generates no blocks", () => {
  // render.mjs applies the mark before the engine sees the item, so the flag on
  // the item is the second, independent path to the same exclusion.
  const items = [
    item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-09-01T03:59:00Z", ty: "homework", cancelled: true }),
    item({ k: "b", c: "CHEM 115", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
  });
  const named = focus.flatMap((d) => d.blocks).map((b) => b.what).join(" ");
  assert.ok(!/HW 2/.test(named));
  assert.ok(/HW 1/.test(named));
});

test("a mark the user took back stops closing its item - the work comes back", () => {
  const items = [item({ k: "a", c: "MATH 210", t: "HW 2", d: "2026-09-01T03:59:00Z", ty: "homework" })];
  const store = {
    v: 2,
    completions: { a: { at: "2026-08-31T18:00:00Z", via: "page" } },
    cleared: { a: { at: "2026-08-31T19:00:00Z", via: "user" } }, // newer tombstone wins
  };
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ, completions: store,
  });
  assert.ok(focus.flatMap((d) => d.blocks).some((b) => /HW 2/.test(b.what)), "unchecked work is open work again");

  // The mirror image, which is what proves the engine reads the store rather
  // than shrugging at a shape it does not understand: a mark NEWER than its
  // tombstone still closes the item.
  const remarked = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
    completions: {
      v: 2,
      completions: { a: { at: "2026-08-31T20:00:00Z", via: "page" } },
      cleared: { a: { at: "2026-08-31T19:00:00Z", via: "user" } },
    },
  });
  assert.ok(!remarked.flatMap((d) => d.blocks).some((b) => /HW 2/.test(b.what)), "re-marked work is closed again");
});

test("a session mark never removes its deliverable's blocks", () => {
  // The rule, from the engine's side: finishing tonight's block must not
  // make tomorrow's block (or the deliverable) disappear.
  const items = [item({ k: "a", c: "CHEM 115", t: "HW 1", d: "2026-09-03T03:59:00Z", ty: "homework" })];
  const focus = computeFocus({
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ,
    completions: { "fb|2026-08-31|CHEM 115": { at: "2026-08-31T18:00:00Z", via: "page" } },
  });
  assert.ok(focus.flatMap((d) => d.blocks).some((b) => /HW 1/.test(b.what)), "the deliverable still needs work");
});

test("cancelled side-project work leaves the board dormant", () => {
  const items = [
    item({ k: "sideProject-demo", c: "Side Project", t: "Demo prep for investor call", d: "2026-09-01T21:00:00Z", ty: "task" }),
  ];
  const focus = computeFocus({
    items, weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 }, now: NOW, leadTimeDays: { ...LEAD, task: 2 },
    studyMinutes: ALL_DAY, tz: TZ, wakeTime: "10:00", board: [], sideProject: SIDE_CFG,
    completions: { "sideProject-demo": { at: "2026-08-31T18:00:00Z", via: "user", state: "cancelled" } },
  });
  assert.equal(
    focus.flatMap((d) => d.blocks).filter((b) => b.c === "Side Project").length,
    0,
    "the only open side-project work was cancelled, so there is nothing to push",
  );
});

// ---------------------------------------------------------------------------
// Completing work frees its time, and today knows what time it is
// ---------------------------------------------------------------------------
//
// Three promises, in the order the contract makes them.
//   A. Closing a goal LIBERATES the blocks it had ahead of it, and those minutes
//      become budget the remaining courses absorb.
//   B. A session the user has already closed today is never offered again today.
//   C. Today is re-packed from the CLOCK, keeping the blocks that have already
//      started as the record of the day.

/** Local h:mm on Monday 2026-08-31, which is EDT (UTC-4) in Indiana. */
const localAt = (h, m = 0) => new Date(Date.UTC(2026, 7, 31, h + 4, m));
/** A window wide enough that the clock, not the window, is what moves things. */
const OPEN_DAY = {
  weekday: 240,
  weekend: 240,
  weekdayWindow: ["09:00", "22:00"],
  weekendWindow: ["09:00", "22:00"],
};
const clockBase = { weights: WEIGHTS, tz: TZ, leadTimeDays: LEAD, studyMinutes: OPEN_DAY, wakeTime: "09:00" };
const TUESDAY = "2026-09-01";
const weekPlan = (day, blocks) => [{ d: day, blocks }];
const blocksOn = (focus, day) => focus.find((d) => d.d === day)?.blocks ?? [];
const minutesOn = (focus, day, c) =>
  blocksOn(focus, day).filter((b) => b.c === c).reduce((n, b) => n + b.mins, 0);
const sessionOf = (day, bucket, o = {}) => ({
  [`fb|${day}|${bucket}`]: { at: "2026-08-31T12:00:00Z", via: "page", ...o },
});

/** A homework planned across four days, and two rivals for the same hours. */
const WEEK_WORK = [
  item({ k: "hw115", c: "CHEM 115", t: "HW 1", d: "2026-09-04T03:59:00Z", ty: "homework" }), // due Thu
  item({ k: "hw210", c: "MATH 210", t: "HW 2", d: "2026-09-03T03:59:00Z", ty: "homework" }), // due Wed
  item({ k: "q101", c: "ART 101", t: "Quiz 3", d: "2026-09-02T03:59:00Z", ty: "quiz" }), // due Tue
];
const CLOSED_115 = { hw115: { at: "2026-08-31T18:00:00Z", via: "page" } };

// --- A. liberation across the week -----------------------------------------

test("closing a multi-day deliverable frees every block it still had ahead", () => {
  const before = computeFocus({ ...clockBase, items: WEEK_WORK, now: localAt(14) });
  const after = computeFocus({ ...clockBase, items: WEEK_WORK, now: localAt(14), completions: CLOSED_115 });

  const days115 = before.filter((d) => d.blocks.some((b) => b.c === "CHEM 115")).map((d) => d.d);
  assert.ok(days115.length >= 3, `the HW is planned across the week (${days115.join(", ")})`);
  assert.equal(
    after.flatMap((d) => d.blocks).filter((b) => b.c === "CHEM 115").length,
    0,
    "one mark, and every block tied to that goal is gone from the whole week",
  );
});

test("the freed minutes are not lost - another course's allocation grows that day", () => {
  const now = localAt(14);
  const before = computeFocus({ ...clockBase, items: WEEK_WORK, now });
  const after = computeFocus({ ...clockBase, items: WEEK_WORK, now, completions: CLOSED_115 });

  assert.ok(minutesOn(before, TUESDAY, "CHEM 115") > 0, "115 had Tuesday time to give back");
  assert.ok(
    minutesOn(after, TUESDAY, "MATH 210") > minutesOn(before, TUESDAY, "MATH 210"),
    "210 absorbs the freed minutes on Tuesday " +
      `(${minutesOn(before, TUESDAY, "MATH 210")} -> ${minutesOn(after, TUESDAY, "MATH 210")})`,
  );
  assertTimingInvariants(after, { windows: OPEN_DAY });
});

test("liberation reaches the REST OF TODAY, not just tomorrow", () => {
  // The mid-day case this whole round exists for: it is 14:00, the user has just
  // finished the 115 homework, and the hours she has left must be re-shared.
  const now = localAt(14);
  const before = computeFocus({ ...clockBase, items: WEEK_WORK, now });
  const after = computeFocus({ ...clockBase, items: WEEK_WORK, now, completions: CLOSED_115 });
  assert.ok(minutesOn(before, MONDAY, "CHEM 115") > 0, "115 owned part of this afternoon");
  assert.ok(
    minutesOn(after, MONDAY, "MATH 210") > minutesOn(before, MONDAY, "MATH 210"),
    "and this afternoon is re-shared, not left with a hole in it",
  );
});

// --- B. a session the user closed today is not re-offered today -------------

test("a session marked done today gets no new block today, and tomorrow is untouched", () => {
  const now = localAt(14);
  const plain = computeFocus({ ...clockBase, items: WEEK_WORK, now });
  const closed = computeFocus({ ...clockBase, items: WEEK_WORK, now, completions: sessionOf(MONDAY, "CHEM 115") });

  assert.ok(blocksOn(plain, MONDAY).some((b) => b.c === "CHEM 115"), "the block existed before she ticked it");
  assert.equal(blocksOn(closed, MONDAY).filter((b) => b.c === "CHEM 115").length, 0, "and is not offered again");
  assert.ok(blocksOn(closed, TUESDAY).some((b) => b.c === "CHEM 115"), "tomorrow is a different session");
  assert.ok(
    closed.flatMap((d) => d.blocks).some((b) => /HW 1/.test(b.what)),
    "and the deliverable itself is still work - a session mark never closes a goal",
  );
});

test("a cancelled session is the same answer as a finished one", () => {
  const closed = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(14),
    completions: sessionOf(MONDAY, "CHEM 115", { state: "cancelled" }),
  });
  assert.equal(blocksOn(closed, MONDAY).filter((b) => b.c === "CHEM 115").length, 0, "declined is also answered");
});

test("unchecking the session brings today's block straight back", () => {
  const back = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(14),
    completions: {
      v: 2,
      completions: sessionOf(MONDAY, "CHEM 115"),
      cleared: { [`fb|${MONDAY}|CHEM 115`]: { at: "2026-08-31T13:00:00Z", via: "user" } }, // newer
    },
  });
  assert.ok(blocksOn(back, MONDAY).some((b) => b.c === "CHEM 115"), "a revoked session mark stops answering");
});

test("a closed session outranks a pin - a finished block is not re-offered because she once dragged it", () => {
  const now = localAt(14);
  const blockEdits = editsOf(edit({ day: MONDAY, c: "MATH 210", t: "20:00", mins: 60 }));
  const pinnedOnly = computeFocus({ ...clockBase, items: WEEK_WORK, now, blockEdits });
  assert.deepEqual(pinnedIn(pinnedOnly[0]).map((b) => b.c), ["MATH 210"], "the pin lands when the session is open");

  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now,
    blockEdits,
    completions: sessionOf(MONDAY, "MATH 210"),
  });
  assert.deepEqual(pinnedIn(focus[0]), [], "a done session is not a slot to be pinned into");
  assert.equal(blocksOn(focus, MONDAY).filter((b) => b.c === "MATH 210").length, 0, "in any form");
  assert.ok(blocksOn(focus, MONDAY).length > 0, "and the rest of the day still happens");
});

test("the side project's daily floor respects a closed session too", () => {
  const sideArgs = {
    ...clockBase,
    weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 },
    items: WEEK_WORK,
    now: localAt(14),
    board: board(2),
    sideProject: SIDE_CFG,
  };
  assert.ok(blocksOn(computeFocus(sideArgs), MONDAY).some((b) => b.c === "Side Project"), "the board normally guarantees one");

  const focus = computeFocus({ ...sideArgs, completions: sessionOf(MONDAY, "Side Project") });
  assert.equal(blocksOn(focus, MONDAY).filter((b) => b.c === "Side Project").length, 0, "not on a day she has closed it");
  assert.ok(blocksOn(focus, TUESDAY).some((b) => b.c === "Side Project"), "the commitment resumes tomorrow");
});

test("a session mark is scoped to its own day, and takes effect the morning that day is today", () => {
  const marked = { ...clockBase, items: WEEK_WORK, completions: sessionOf(TUESDAY, "CHEM 115") };
  const monday = computeFocus({ ...marked, now: localAt(14) });
  assert.ok(blocksOn(monday, MONDAY).some((b) => b.c === "CHEM 115"), "today is today - tomorrow's mark is not today's");
  // Section B is written for `fb|<today>|<bucket>`, so a mark on a day that has
  // not arrived is the page's business (it strikes that block) and stays out of
  // the plan for it. It becomes the engine's the moment that day IS today:
  assert.ok(blocksOn(monday, TUESDAY).some((b) => b.c === "CHEM 115"), "still planned while it is the future");
  const tuesday = computeFocus({ ...marked, now: new Date(Date.UTC(2026, 8, 1, 18, 0)) }); // Tue 14:00 local
  assert.equal(blocksOn(tuesday, TUESDAY).filter((b) => b.c === "CHEM 115").length, 0, "and answered once it is now");
});

// --- C. today is re-packed from the clock ----------------------------------

test("cutMinute rounds the clock UP to the next quarter hour, never below the floor", () => {
  assert.equal(cutMinute(localAt(14, 1), TZ, 540), 14 * 60 + 15, "14:01 -> 14:15");
  assert.equal(cutMinute(localAt(14, 15), TZ, 540), 14 * 60 + 15, "an exact quarter stays put");
  assert.equal(cutMinute(localAt(7, 3), TZ, 540), 540, "before the floor IS the floor");
  assert.equal(cutMinute(new Date("nonsense"), TZ, 540), 540, "and an unreadable clock is the floor too");
  // `new Date(null)` is the epoch, which is a perfectly valid instant and would
  // otherwise cut the day at whatever o'clock 1970 was here - an answer that
  // looks like an answer. Nothing is a clock reading, so nothing is the floor.
  assert.equal(cutMinute(null, TZ, 540), 540, "null is not a time");
  assert.equal(cutMinute(undefined, TZ, 540), 540, "and neither is undefined");
});

test("no new block is planned into an hour that has already passed", () => {
  const focus = computeFocus({ ...clockBase, items: WEEK_WORK, now: localAt(14, 1) });
  for (const b of blocksOn(focus, MONDAY)) {
    assert.ok(minutesOfClock(b.t) >= 14 * 60 + 15, `${b.c} at ${b.t} must start at or after the 14:15 cut`);
  }
  assert.ok(
    blocksOn(focus, TUESDAY).some((b) => minutesOfClock(b.t) < 14 * 60),
    "and every other day still opens with its window, not with today's clock",
  );
});

test("a block that has already started is kept verbatim, and stamped", () => {
  const morning = { c: "CHEM 115", what: "Start HW 1", why: "due Thursday 11:59 PM", t: "10:00", mins: 90 };
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(14),
    previousFocus: weekPlan(MONDAY, [morning]),
  });
  assert.deepEqual(blocksOn(focus, MONDAY)[0], { ...morning, kept: true }, "same course, words, hour and minutes");
  assert.equal(
    blocksOn(focus, MONDAY).filter((b) => b.c === "CHEM 115").length,
    1,
    "one block per (day, bucket): the kept one is not packed a second time",
  );
});

test("kept minutes are spent minutes - they come off today's budget", () => {
  const morning = { c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "10:00", mins: 90 };
  const now = localAt(14);
  const fresh = computeFocus({ ...clockBase, items: WEEK_WORK, now });
  const withRecord = computeFocus({ ...clockBase, items: WEEK_WORK, now, previousFocus: weekPlan(MONDAY, [morning]) });

  const total = (focus) => blocksOn(focus, MONDAY).reduce((n, b) => n + b.mins, 0);
  assert.ok(total(withRecord) <= OPEN_DAY.weekday, `${total(withRecord)} minutes must fit the 240 the day has`);
  const packed = blocksOn(withRecord, MONDAY).filter((b) => !b.kept).reduce((n, b) => n + b.mins, 0);
  assert.ok(packed <= OPEN_DAY.weekday - 90, "the afternoon may only spend what the morning left");
  assert.ok(total(fresh) > packed, "which is less than a day with nothing behind it gets");
  assertTimingInvariants(withRecord, { windows: OPEN_DAY });
});

test("a kept block is busy time - the re-pack routes around it, cut or no cut", () => {
  // The cut lands INSIDE the block: it started at 13:30 and runs to 15:00. A
  // block that STARTED before the cut is kept whole, and its whole span is busy.
  const running = { c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "13:30", mins: 90 };
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(14),
    previousFocus: weekPlan(MONDAY, [running]),
  });
  const day = blocksOn(focus, MONDAY);
  assert.deepEqual(day[0], { ...running, kept: true }, "kept whole, not truncated at the cut");
  for (const b of day.slice(1)) {
    assert.ok(minutesOfClock(b.t) >= 15 * 60, `${b.c} at ${b.t} must wait for the running block to finish`);
  }
});

test("a kept block whose goal has since closed is still the record of the day", () => {
  const morning = { c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "10:00", mins: 90 };
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(14),
    previousFocus: weekPlan(MONDAY, [morning]),
    completions: CLOSED_115,
  });
  assert.deepEqual(blocksOn(focus, MONDAY)[0], { ...morning, kept: true }, "she really did spend that hour and a half");
  assert.equal(
    focus.slice(1).flatMap((d) => d.blocks).filter((b) => b.c === "CHEM 115").length,
    0,
    "but nothing ahead of her is still planned for it",
  );
});

test("an absent, empty or stale previous plan keeps nothing and packs from the cut", () => {
  const now = localAt(14);
  const expected = computeFocus({ ...clockBase, items: WEEK_WORK, now });
  for (const previousFocus of [
    undefined,
    null,
    [],
    "junk",
    weekPlan("2026-08-24", [{ c: "CHEM 115", what: "old", why: "old", t: "10:00", mins: 90 }]), // last week
    weekPlan(MONDAY, [{ c: "CHEM 115", what: "no hour", why: "untimed", mins: 90 }]), // never started
    weekPlan(MONDAY, [{ c: "CHEM 115", what: "junk", why: "junk", t: "half nine", mins: "lots" }]),
    weekPlan(MONDAY, [null, 7]),
  ]) {
    assert.deepEqual(
      computeFocus({ ...clockBase, items: WEEK_WORK, now, previousFocus }),
      expected,
      `no usable record means today is planned from the clock (${JSON.stringify(previousFocus)})`,
    );
  }
});

test("the whole {v, focus} file is accepted, not just the array inside it", () => {
  const morning = { c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "10:00", mins: 90 };
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(14),
    previousFocus: { v: 1, generatedAt: "2026-08-31T11:00:00Z", tz: TZ, focus: weekPlan(MONDAY, [morning]) },
  });
  assert.equal(blocksOn(focus, MONDAY)[0].kept, true);
});

test("keptBlocks: one block per bucket, earliest first, junk dropped", () => {
  const kept = keptBlocks(
    weekPlan(MONDAY, [
      { c: "MATH 210", what: "b", why: "b", t: "11:00", mins: 60 },
      { c: "CHEM 115", what: "a", why: "a", t: "09:00", mins: 60, pinned: true },
      { c: "CHEM 115", what: "duplicate", why: "d", t: "10:00", mins: 60 },
      { c: "HIST 140", what: "still ahead", why: "f", t: "20:00", mins: 60 },
      { c: "", what: "nameless", why: "n", t: "09:30", mins: 60 },
      { c: "PHYS 221", what: "zero", why: "z", t: "09:30", mins: 0 },
    ]),
    MONDAY,
    14 * 60,
  );
  assert.deepEqual(kept.map((b) => b.c), ["CHEM 115", "MATH 210"]);
  assert.equal(kept[0].what, "a", "the earliest block wins the bucket");
  assert.equal(kept[0].pinned, true, "every field the previous render wrote survives");
  assert.equal(kept[0].kept, true);
  assert.deepEqual(keptBlocks(null, MONDAY, 14 * 60), []);
  assert.deepEqual(keptBlocks(weekPlan(MONDAY, []), "not-a-day", 14 * 60), []);
});

test("closedSessionBuckets reads only this day's session keys", () => {
  const closed = closedSessionBuckets(
    {
      ...sessionOf(MONDAY, "CHEM 115"),
      ...sessionOf(MONDAY, "Side Project", { state: "cancelled" }),
      ...sessionOf(TUESDAY, "MATH 210"),
      "110002::homework::hw 2": { at: "2026-08-31T12:00:00Z", via: "page" },
    },
    MONDAY,
  );
  assert.deepEqual([...closed].sort(), ["CHEM 115", "Side Project"], "both states, this day, sessions only");
});

test("when the window has run out, today is its record and nothing more", () => {
  const evening = [
    { c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "10:00", mins: 90 },
    { c: "MATH 210", what: "Push HW 2", why: "due Wednesday", t: "20:00", mins: 60 },
  ];
  // 21:50 -> the cut is 22:00 and the window closes at 22:00: no room for a block.
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(21, 50),
    previousFocus: weekPlan(MONDAY, evening),
  });
  assert.deepEqual(blocksOn(focus, MONDAY), evening.map((b) => ({ ...b, kept: true })));
  assert.ok(blocksOn(focus, TUESDAY).length > 0, "the work is not lost, it is tomorrow's");
});

test("past the window's close the evening is still kept - the record is not clamped away", () => {
  const evening = [{ c: "MATH 210", what: "Push HW 2", why: "due Wednesday", t: "21:00", mins: 60 }];
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(22, 40), // after the 22:00 window close
    previousFocus: weekPlan(MONDAY, evening),
  });
  assert.deepEqual(blocksOn(focus, MONDAY), evening.map((b) => ({ ...b, kept: true })));
});

test("with nothing behind it and nothing ahead, a spent day is simply empty", () => {
  const focus = computeFocus({ ...clockBase, items: WEEK_WORK, now: localAt(21, 50) });
  assert.deepEqual(blocksOn(focus, MONDAY), [], "no record, no room: today has nothing honest to say");
  assert.equal(focus.length, 7, "the day itself is still in the plan");
  assert.equal(focus[0].d, MONDAY);
});

// --- C. pins, and the pre-dawn run -----------------------------------------

test("a pin at or after the cut still places; a pin behind it is history", () => {
  const now = localAt(14);
  const ahead = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now,
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "16:00", mins: 60 })),
  });
  assert.deepEqual(pinnedIn(ahead[0]).map((b) => b.t), ["16:00"], "the evening she asked for is still ahead of her");

  const behind = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now,
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "10:00", mins: 60 })),
  });
  assert.deepEqual(pinnedIn(behind[0]), [], "10:00 has been and gone; re-pinning it is a lie about the day");
  assert.ok(
    blocksOn(behind, MONDAY).some((b) => b.c === "MATH 210"),
    "the course is free to earn an ordinary block in the hours that are left",
  );
});

test("a pin behind the clock is history even after the window has closed", () => {
  // The clamp trap: at 23:20 the packing cut is pinned to the 22:00 window
  // close, so a 23:00 pin is NOT before it - and testing against the clamped
  // value would republish it as a live block twenty minutes in the past. The
  // question is "has this happened?", and only the unclamped clock can answer.
  const now = localAt(23, 20);
  const blockEdits = editsOf(edit({ day: MONDAY, c: "Side Project", t: "23:00", mins: 45 }));
  const focus = computeFocus({
    ...clockBase,
    weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 },
    items: WEEK_WORK,
    now,
    blockEdits,
    board: board(2),
    sideProject: SIDE_CFG,
  });
  assert.deepEqual(pinnedIn(focus[0]), [], "23:00 has been and gone");
  assert.deepEqual(blocksOn(focus, MONDAY), [], "and the day is over, so it says nothing rather than something false");

  // The same pin, an hour earlier, is still ahead of her and still hers.
  const ahead = computeFocus({
    ...clockBase,
    weights: { ...WEIGHTS, [SIDE_BUCKET]: 3 },
    items: WEEK_WORK,
    now: localAt(22, 30),
    blockEdits,
    board: board(2),
    sideProject: SIDE_CFG,
  });
  assert.deepEqual(pinnedIn(ahead[0]).map((b) => b.t), ["23:00"], "a pin outside the window is still a pin");
});

test("a pin the previous render honoured comes back as the record, not as a second block", () => {
  const pin = { c: "MATH 210", what: "Push HW 2", why: "you put this block here", t: "10:00", mins: 60, pinned: true };
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(14),
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "10:00", mins: 60 })),
    previousFocus: weekPlan(MONDAY, [pin]),
  });
  assert.deepEqual(
    blocksOn(focus, MONDAY).filter((b) => b.c === "MATH 210"),
    [{ ...pin, kept: true }],
    "exactly once, exactly as it was published",
  );
});

test("the pre-dawn run is byte-for-byte the run it always was", () => {
  // 07:03, the morning heavy run. The wake floor is 09:00, so nothing has
  // started - not even the 08:30 block a pin put outside the floor - and
  // yesterday evening's plan for today must change nothing at all.
  const yesterdaysPlan = weekPlan(MONDAY, [
    { c: "MATH 210", what: "Push HW 2", why: "due Wednesday", t: "08:30", mins: 60, pinned: true },
    { c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "16:00", mins: 90 },
  ]);
  const args = {
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(7, 3),
    blockEdits: editsOf(edit({ day: MONDAY, c: "MATH 210", t: "08:30", mins: 60 })),
  };
  const asBefore = computeFocus(args);
  assert.deepEqual(computeFocus({ ...args, previousFocus: yesterdaysPlan }), asBefore, "the record changes nothing");
  assert.equal(asBefore.flatMap((d) => d.blocks).filter((b) => b.kept).length, 0, "and nothing is stamped kept");
  assert.deepEqual(pinnedIn(asBefore[0]).map((b) => b.t), ["08:30"], "the pin is still the user's, not history");
});

test("same clock, same record, same plan - twice", () => {
  const args = {
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(18, 7),
    previousFocus: weekPlan(MONDAY, [{ c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "10:00", mins: 90 }]),
    blockEdits: editsOf(edit({ day: MONDAY, c: "ART 101", t: "19:00", mins: 45 })),
    completions: sessionOf(MONDAY, "MATH 210"),
    board: board(2),
    sideProject: SIDE_CFG,
  };
  assert.deepEqual(computeFocus(args), computeFocus(args));
  // And the same quarter hour is the same day: 18:07 and 18:14 both cut at
  // 18:15, so a run that starts a few minutes late does not reshuffle anything.
  assert.deepEqual(computeFocus({ ...args, now: localAt(18, 14) }), computeFocus(args));
});

test("the evening re-render keeps the morning and re-plans only what is left", () => {
  // End to end, the way the 18:07 heavy run actually calls it: this morning's
  // published plan goes in, and what comes back is that morning plus an evening.
  const mornings = [
    { c: "CHEM 115", what: "Start HW 1", why: "due Thursday", t: "10:00", mins: 75 },
    { c: "MATH 210", what: "Push HW 2", why: "due Wednesday", t: "11:30", mins: 45 },
  ];
  const focus = computeFocus({
    ...clockBase,
    items: WEEK_WORK,
    now: localAt(18, 7),
    previousFocus: weekPlan(MONDAY, mornings),
  });
  const day = blocksOn(focus, MONDAY);
  assert.deepEqual(day.filter((b) => b.kept), mornings.map((b) => ({ ...b, kept: true })), "the morning is the record");
  const evening = day.filter((b) => !b.kept);
  for (const b of evening) {
    assert.ok(minutesOfClock(b.t) >= 18 * 60 + 15, `${b.c} at ${b.t} is in the evening that is left`);
    assert.ok(!["CHEM 115", "MATH 210"].includes(b.c), "and is not a bucket the day has already spent");
  }
  assert.ok(day.reduce((n, b) => n + b.mins, 0) <= OPEN_DAY.weekday, "the day still fits the day");
  assertTimingInvariants(focus, { windows: OPEN_DAY });
});

// ---------------------------------------------------------------------------
// Configuration: the zone, the bucket name, the standards course, the tuning.
//
// None of these are constants in the engine any more. They arrive from config,
// which means each of them has a "not configured" state that has to behave.
// ---------------------------------------------------------------------------

test("computeFocus refuses to run without a timezone", () => {
  const args = { items: [], weights: WEIGHTS, now: NOW, leadTimeDays: LEAD };
  // Bucketing UTC dues by the machine own clock would produce a plausible plan
  // for the wrong day, which is worse than no plan at all.
  assert.throws(() => computeFocus({ ...args }), /needs a tz/);
  assert.throws(() => computeFocus({ ...args, tz: "" }), /needs a tz/);
  assert.throws(() => computeFocus({ ...args, tz: "   " }), /needs a tz/);
  assert.throws(() => computeFocus({ ...args, tz: null }), /needs a tz/);
  assert.throws(() => computeFocus(), /needs a tz/);
  assert.doesNotThrow(() => computeFocus({ ...args, tz: TZ }));
});

test("the side-project bucket takes its name from config, and defaults sensibly", () => {
  assert.equal(DEFAULT_SIDE_BUCKET, "Side Project");
  const base = {
    items: [],
    weights: { ...WEIGHTS },
    now: NOW,
    leadTimeDays: LEAD,
    studyMinutes: ALL_DAY,
    tz: TZ,
    wakeTime: "10:00",
    board: board(4),
    sideProject: SIDE_CFG,
  };

  const byDefault = computeFocus(base).flatMap((d) => d.blocks).filter((b) => b.c === DEFAULT_SIDE_BUCKET);
  assert.ok(byDefault.length > 0, "with no sideBucket given, the default label is used end to end");

  const renamed = computeFocus({ ...base, sideBucket: "Freelance" });
  const blocks = renamed.flatMap((d) => d.blocks);
  assert.ok(blocks.some((b) => b.c === "Freelance"), "a configured label reaches the block bucket");
  assert.ok(!blocks.some((b) => b.c === DEFAULT_SIDE_BUCKET), "and the default label is gone entirely");

  // The weight lookup follows the label too: muting the renamed bucket must
  // mute it, which only works if the engine asks about the configured name.
  const muted = computeFocus({
    ...base,
    sideBucket: "Freelance",
    weights: { ...WEIGHTS, Freelance: 0 },
  });
  assert.ok(!muted.flatMap((d) => d.blocks).some((b) => b.c === "Freelance"), "a 0 weight mutes it under its own name");
});

test("a self-study pin on the side-project bucket names it, whatever it is called", () => {
  const focus = computeFocus({
    items: [],
    weights: { ...WEIGHTS },
    now: NOW,
    leadTimeDays: LEAD,
    studyMinutes: ALL_DAY,
    tz: TZ,
    wakeTime: "10:00",
    sideBucket: "Freelance",
    blockEdits: { edits: [{ day: MONDAY, c: "Freelance", t: "14:00", mins: 60 }] },
  });
  const pinned = blocksOn(focus, MONDAY).find((b) => b.pinned);
  assert.equal(pinned.c, "Freelance");
  assert.match(pinned.what, /Freelance board/, "the synthesized block uses the configured label");
});

test("no configured standards course makes the whole sitting subsystem a no-op", () => {
  const plan = {
    // deliberately no `course`
    weeks: [{ start: "2026-08-31", focus: ["C1", "C2"], note: "" }],
    standards: { C1: { status: "open", name: "Kinematics" }, C2: { status: "open", name: "Energy" } },
    sittings: [{ date: "2026-09-02", label: "Evening Exam 1", kind: "exam", targets: ["C1"] }],
  };
  const items = [item({ k: "e", c: "PHYS 221", t: "Evening Exam 1", d: "2026-09-03T00:00:00Z", ty: "exam", s: null })];
  const args = { items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: BUDGET, tz: TZ };

  // The plan's OWN records are course-independent and still merge; what a
  // missing course costs is step 3, where an exam ITEM lends its time to the
  // sitting the plan only knows the date of.
  const blind = collectSittings(plan, items, TZ);
  assert.deepEqual(blind.map((s) => s.date), ["2026-09-02"]);
  assert.equal(blind[0].time, null, "with no course named, no item is matched and no time is learned");
  const sighted = collectSittings({ ...plan, course: "PHYS 221" }, items, TZ);
  assert.ok(sighted[0].time, "naming the course lets the exam item supply the hour");

  const dormant = computeFocus({ ...args, standardsPlan: plan });
  const named = dormant.flatMap((d) => d.blocks).map((b) => b.what).join(" ");
  assert.ok(!/Practice C1/.test(named), "no synthetic standards practice is produced");
  assert.ok(!/sitting/i.test(named), "and nothing mentions a sitting");
  // The exam item itself is ordinary work and still earns its block.
  assert.ok(/Exam 1/.test(named), "the exam is still a normal deadline");

  // Naming the course lights the same plan up.
  const live = computeFocus({ ...args, standardsPlan: { ...plan, course: "PHYS 221" } });
  assert.ok(
    live.flatMap((d) => d.blocks).some((b) => /C1|C2|sitting/i.test(b.what)),
    "with a course configured the standards practice appears",
  );
  assertTimingInvariants(dormant);
});

test("resolveTuning fills gaps, rejects nonsense, and cannot invert a bound", () => {
  const d = resolveTuning(null);
  assert.equal(d.maxBlocksPerDay, DEFAULT_TUNING.maxBlocksPerDay);
  assert.equal(d.step, DEFAULT_TUNING.blockStepMinutes);
  assert.equal(d.minBlock, MIN_BLOCK_MINUTES);
  assert.equal(d.maxBlock, MAX_BLOCK_MINUTES);
  assert.equal(d.dayStart, HARD_DAY_START);
  assert.equal(d.dayEnd, HARD_DAY_END);

  const partial = resolveTuning({ maxBlocksPerDay: 1 });
  assert.equal(partial.maxBlocksPerDay, 1, "a partial override merges over the defaults");
  assert.equal(partial.step, DEFAULT_TUNING.blockStepMinutes, "and leaves everything else alone");

  const junk = resolveTuning({ maxBlocksPerDay: 0, minBlockMinutes: -5, dayEnd: "banana" });
  assert.equal(junk.maxBlocksPerDay, DEFAULT_TUNING.maxBlocksPerDay, "a hand-edited zero is not trusted");
  assert.equal(junk.minBlock, MIN_BLOCK_MINUTES);
  assert.equal(junk.dayEnd, HARD_DAY_END, "an unreadable clock falls back rather than throwing");

  // An inverted band would turn the packer shave loop into an infinite one.
  const inverted = resolveTuning({ minBlockMinutes: 200, maxBlockMinutes: 60, dayStart: "22:00", dayEnd: "09:00" });
  assert.ok(inverted.maxBlock >= inverted.minBlock, "a minimum can never exceed the maximum");
  assert.ok(inverted.dayEnd >= inverted.dayStart + inverted.minBlock, "the day always holds one block");

  assert.equal(resolveTuning({ breakMinutes: 0 }).breakMinutes, 0, "zero is a legal break");
});

test("tuning.maxBlocksPerDay caps the day, and the minutes go to the survivors", () => {
  const items = [
    item({ k: "a", c: "PHYS 221", t: "HW 1", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "b", c: "CHEM 115", t: "HW 2", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "c", c: "MATH 210", t: "HW 3", d: "2026-09-01T03:59:00Z", ty: "homework" }),
    item({ k: "d", c: "HIST 140", t: "HW 4", d: "2026-09-01T03:59:00Z", ty: "homework" }),
  ];
  const args = {
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: ALL_DAY, tz: TZ, wakeTime: "10:00",
  };
  const normal = blocksOn(computeFocus(args), MONDAY);
  assert.equal(normal.length, MAX_BLOCKS_PER_DAY, "the shipped default is three blocks a day");

  const capped = blocksOn(computeFocus({ ...args, tuning: { maxBlocksPerDay: 1 } }), MONDAY);
  assert.equal(capped.length, 1, "the cap is honoured");
  assert.equal(capped[0].c, normal[0].c, "and it keeps the highest-scoring block");
  assert.ok(
    capped[0].mins >= normal[0].mins,
    `the freed minutes go to the block that is left (${normal[0].mins} -> ${capped[0].mins})`,
  );
  assertTimingInvariants(computeFocus({ ...args, tuning: { maxBlocksPerDay: 1 } }), { windows: ALL_DAY });
});

test("tuning moves the block band, the grid and the day bounds", () => {
  const items = [
    item({ k: "a", c: "PHYS 221", t: "HW 1", d: "2026-09-02T03:59:00Z", ty: "homework" }),
    item({ k: "b", c: "CHEM 115", t: "HW 2", d: "2026-09-02T03:59:00Z", ty: "homework" }),
  ];
  const args = {
    items, weights: WEIGHTS, now: NOW, leadTimeDays: LEAD, studyMinutes: ALL_DAY, tz: TZ, wakeTime: "10:00",
  };

  // A 20-minute grid with a 40-minute floor and a 60-minute ceiling.
  const tight = blocksOn(
    computeFocus({ ...args, tuning: { blockStepMinutes: 20, minBlockMinutes: 40, maxBlockMinutes: 60 } }),
    MONDAY,
  );
  assert.ok(tight.length > 0, "there is still a plan");
  for (const b of tight) {
    assert.equal(b.mins % 20, 0, `${b.c}: ${b.mins} must sit on the configured grid`);
    assert.ok(b.mins >= 40 && b.mins <= 60, `${b.c}: ${b.mins} must sit inside the configured band`);
  }

  // A day that opens late and shuts early bounds every start and every end.
  const short = blocksOn(computeFocus({ ...args, tuning: { dayStart: "12:00", dayEnd: "18:00" } }), MONDAY);
  for (const b of short.filter((x) => typeof x.t === "string")) {
    const [s, e] = spanOf(b);
    assert.ok(s >= 12 * 60, `${b.c} starts at ${b.t}, not before the configured day start`);
    assert.ok(e <= 18 * 60, `${b.c} ends at ${clockOf(e)}, not after the configured day end`);
  }
});


// ---------------------------------------------------------------------------
// meetingBusySpans - the user's own calendar as fixed commitments
// ---------------------------------------------------------------------------

const TZ_NY = "America/New_York";
const timed = (s2, e, o = {}) => ({ k: "cal|x|" + s2, s: s2, e, ad: false, free: false, ...o });

test("a timed meeting becomes one busy span, in local minutes", () => {
  const spans = meetingBusySpans([timed("2026-09-04T19:00:00Z", "2026-09-04T20:30:00Z")], TZ_NY);
  assert.deepEqual(spans, [{ day: "2026-09-04", start: 15 * 60, end: 16 * 60 + 30 }]);
});

test("an all-day meeting is NOT busy: a conference day is a label, not four blank hours", () => {
  assert.deepEqual(meetingBusySpans([{ k: "a", s: "2026-09-08", e: "2026-09-09", ad: true }], TZ_NY), []);
});

test("a `free` meeting is NOT busy: the user marked themselves available", () => {
  assert.deepEqual(meetingBusySpans([timed("2026-09-04T19:00:00Z", "2026-09-04T20:00:00Z", { free: true })], TZ_NY), []);
});

test("a meeting crossing local midnight is busy on BOTH days, clipped at the wall", () => {
  // 22:00 to 01:30 local
  const spans = meetingBusySpans([timed("2026-09-05T02:00:00Z", "2026-09-05T05:30:00Z")], TZ_NY);
  assert.deepEqual(spans, [
    { day: "2026-09-04", start: 22 * 60, end: MINUTES_PER_DAY },
    { day: "2026-09-05", start: 0, end: 90 },
  ]);
});

test("a malformed or backwards meeting is skipped rather than trusted", () => {
  assert.deepEqual(meetingBusySpans([timed("nope", "also nope")], TZ_NY), []);
  assert.deepEqual(meetingBusySpans([timed("2026-09-04T20:00:00Z", "2026-09-04T19:00:00Z")], TZ_NY), []);
  assert.deepEqual(meetingBusySpans([null, "x", {}], TZ_NY), []);
  assert.deepEqual(meetingBusySpans(null, TZ_NY), []);
});

test("an absurdly long meeting is clipped rather than looped over forever", () => {
  const spans = meetingBusySpans([timed("2026-01-01T05:00:00Z", "2027-01-01T05:00:00Z")], TZ_NY);
  // A year of busy time is a malformed event, not a commitment. It is clipped
  // to MEETING_MAX_DAYS + the head day, and the last day contributes nothing
  // when the end lands exactly on a midnight.
  assert.ok(spans.length > 0 && spans.length <= MEETING_MAX_DAYS + 1, `got ${spans.length} spans`);
  assert.equal(spans[0].day, "2026-01-01");
});

test("meetings and the timetable land in the SAME busy array, so one packer honours both", () => {
  const base = {
    items: [],
    weights: { "MATH 210": 4 },
    now: new Date("2026-09-04T13:00:00Z"), // 09:00 local, a Friday
    days: 2,
    studyMinutes: { weekday: 240, weekend: 240, weekdayWindow: ["10:00", "22:00"], weekendWindow: ["10:00", "22:00"] },
    wakeTime: "08:00",
    tz: TZ_NY,
  };
  const item = {
    k: "1::homework::hw", c: "MATH 210", cid: 1, t: "HW", ty: "homework",
    d: "2026-09-08T03:59:00.000Z", s: null, src: ["lms"],
  };
  const withItem = { ...base, items: [item] };
  const plain = computeFocus(withItem);
  const blocked = computeFocus({
    ...withItem,
    // the whole of today's study window, in local time
    meetings: [timed("2026-09-04T14:00:00Z", "2026-09-05T02:00:00Z")],
  });
  const today = (plan) => plan.find((d) => d.d === "2026-09-04").blocks.filter((b) => b.t);
  assert.ok(today(plain).length > 0, "the day had study in it to begin with");
  assert.equal(today(blocked).length, 0, "and a meeting over the whole window leaves nowhere to put it");
});

test("an empty or absent meetings list reproduces the plan exactly", () => {
  const args = {
    items: [{ k: "1::homework::hw", c: "MATH 210", cid: 1, t: "HW", ty: "homework", d: "2026-09-08T03:59:00.000Z", s: null, src: ["lms"] }],
    weights: { "MATH 210": 4 },
    now: new Date("2026-09-04T13:00:00Z"),
    days: 3,
    tz: TZ_NY,
  };
  assert.deepEqual(computeFocus({ ...args, meetings: [] }), computeFocus(args));
});
