/* RFC 5545 recurrence, on its own: `src/lib/ics-rrule.mjs` knows nothing about
 * iCalendar text or time zones, so it is tested by calling it with day numbers
 * and reading day numbers back.
 *
 * The three cases that matter are not the happy ones. An endless rule, an
 * unsatisfiable rule and a huge COUNT are each a way for somebody else's file to
 * wedge or silently empty a scheduled run, and each has its own block below.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { dayNumOf } from "../src/lib/civil-time.mjs";
import { MAX_CANDIDATES, expandRule, expandRuleDetailed, parseRRule, weekdayOf } from "../src/lib/ics-rrule.mjs";

const D = dayNumOf;
/** Expand between two calendar dates and read the days back as YYYY-MM-DD. */
const daysOf = (text, start, from, to, extra = {}) =>
  expandRule(parseRRule(text), start, { fromDay: D(...from), toDay: D(...to), ...extra }).map((n) =>
    new Date(n * 86400000).toISOString().slice(0, 10),
  );

// ------------------------------------------------------------------ parsing

test("parseRRule reads every part this module honours", () => {
  const rule = parseRRule("FREQ=WEEKLY;BYDAY=MO,2TU,-1FR;INTERVAL=2;COUNT=10;UNTIL=20260924T000000Z;WKST=SU;BYMONTH=9,10");
  assert.equal(rule.freq, "WEEKLY");
  assert.equal(rule.interval, 2);
  assert.equal(rule.count, 10);
  assert.equal(rule.until, "20260924T000000Z");
  assert.equal(rule.wkst, "SU");
  assert.deepEqual(rule.bymonth, [9, 10]);
  assert.deepEqual(rule.byday, [
    { ord: null, day: "MO" },
    { ord: 2, day: "TU" },
    { ord: -1, day: "FR" },
  ]);
  assert.deepEqual(rule.unsupported, []);
});

test("a part this module cannot honour is COLLECTED, never guessed at", () => {
  // The collection is what turns such a rule into one instance plus a warning.
  // Guessing at BYSETPOS would put phantom meetings on somebody's week, and a
  // phantom meeting becomes phantom busy time in the planner.
  assert.deepEqual(parseRRule("FREQ=DAILY;BYSETPOS=1").unsupported, ["BYSETPOS"]);
  assert.deepEqual(parseRRule("FREQ=SECONDLY;INTERVAL=1").unsupported, ["FREQ=SECONDLY"]);
  assert.deepEqual(parseRRule("").unsupported, ["FREQ="]);
  assert.deepEqual(parseRRule("FREQ=DAILY;NONSENSE").unsupported, ["NONSENSE"]);
  const byday = parseRRule("FREQ=WEEKLY;BYDAY=MO,XX");
  assert.ok(byday.unsupported.includes("BYDAY"));
  assert.deepEqual(byday.byday, [{ ord: null, day: "MO" }], "the readable half is kept for the record");
});

test("a nonsensical INTERVAL or COUNT falls back rather than producing NaN", () => {
  assert.equal(parseRRule("FREQ=DAILY;INTERVAL=0").interval, 1);
  assert.equal(parseRRule("FREQ=DAILY;INTERVAL=x").interval, 1);
  assert.equal(parseRRule("FREQ=DAILY;COUNT=0").count, null);
  assert.equal(parseRRule("FREQ=DAILY;COUNT=x").count, null);
});

test("weekdayOf names the day of the week a day number falls on", () => {
  assert.equal(weekdayOf(D(2026, 9, 7)), "MO");
  assert.equal(weekdayOf(D(2026, 9, 13)), "SU");
});

// ---------------------------------------------------------------- expansion

test("DAILY with COUNT stops at COUNT, counting DTSTART as the first", () => {
  assert.deepEqual(daysOf("FREQ=DAILY;COUNT=3", { year: 2026, month: 9, day: 7 }, [2026, 9, 1], [2026, 9, 30]), [
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
  ]);
});

test("WEEKLY;BYDAY=MO,WE;INTERVAL=2 honours the interval and the UNTIL day", () => {
  assert.deepEqual(
    daysOf("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2", { year: 2026, month: 9, day: 7 }, [2026, 9, 1], [2026, 9, 30], {
      until: { dayNum: D(2026, 9, 24), ms: null },
    }),
    ["2026-09-07", "2026-09-09", "2026-09-21", "2026-09-23"],
  );
});

test("MONTHLY;BYDAY=2TU picks the ordinal weekday, and -1FR the last one", () => {
  assert.deepEqual(daysOf("FREQ=MONTHLY;BYDAY=2TU", { year: 2026, month: 9, day: 8 }, [2026, 9, 1], [2026, 12, 31]), [
    "2026-09-08",
    "2026-10-13",
    "2026-11-10",
    "2026-12-08",
  ]);
  assert.deepEqual(daysOf("FREQ=MONTHLY;BYDAY=-1FR", { year: 2026, month: 9, day: 25 }, [2026, 9, 1], [2026, 11, 30]), [
    "2026-09-25",
    "2026-10-30",
    "2026-11-27",
  ]);
});

test("MONTHLY;BYMONTHDAY with an INTERVAL, and YEARLY;BYMONTH", () => {
  assert.deepEqual(
    daysOf("FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=2", { year: 2026, month: 9, day: 15 }, [2026, 9, 1], [2027, 2, 28]),
    ["2026-09-15", "2026-11-15", "2027-01-15"],
  );
  assert.deepEqual(
    daysOf("FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=12", { year: 2026, month: 9, day: 12 }, [2026, 1, 1], [2028, 12, 31]),
    ["2026-09-12", "2027-09-12", "2028-09-12"],
  );
});

test("a negative BYMONTHDAY counts back from the end of the month", () => {
  assert.deepEqual(daysOf("FREQ=MONTHLY;BYMONTHDAY=-1", { year: 2026, month: 9, day: 30 }, [2026, 9, 1], [2026, 11, 30]), [
    "2026-09-30",
    "2026-10-31",
    "2026-11-30",
  ]);
});

test("DTSTART is always an instance of its own rule, even when no BY* matches it", () => {
  // RFC 5545 3.8.5.3. A Tuesday DTSTART under BYDAY=MO is still an instance.
  const days = daysOf("FREQ=WEEKLY;BYDAY=MO", { year: 2026, month: 9, day: 8 }, [2026, 9, 1], [2026, 9, 20]);
  assert.ok(days.includes("2026-09-08"), `DTSTART is missing: ${JSON.stringify(days)}`);
});

// ------------------------------------------------------------------- bounds

test("an endless rule is bounded by the window, not by patience", () => {
  assert.deepEqual(daysOf("FREQ=DAILY", { year: 2020, month: 1, day: 1 }, [2026, 9, 1], [2026, 9, 5]), [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
    "2026-09-05",
  ]);
  // and with no window worth the name, the candidate bound is what stops it
  const wide = expandRule(parseRRule("FREQ=DAILY"), { year: 2020, month: 1, day: 1 }, {
    fromDay: D(2020, 1, 1),
    toDay: D(2099, 12, 31),
  });
  assert.equal(MAX_CANDIDATES, 2000);
  assert.ok(wide.length <= MAX_CANDIDATES, `the expander produced ${wide.length} instances`);
});

test("an UNSATISFIABLE rule terminates, keeps DTSTART, and says it was bounded", () => {
  // Every one of these yields ZERO candidates in every period, so nothing
  // advances and nothing is ever "past" the window. Without counting an EMPTY
  // period against the bound the loop runs forever: the run never finishes and
  // the only thing that notices is the stale-run watchdog.
  for (const text of [
    "FREQ=MONTHLY;BYMONTHDAY=32",
    "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=DAILY;BYMONTHDAY=32",
    "FREQ=WEEKLY;BYMONTH=13",
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
  ]) {
    const detailed = expandRuleDetailed(parseRRule(text), { year: 2026, month: 9, day: 7 }, {
      fromDay: D(2026, 9, 1),
      toDay: D(2026, 9, 30),
    });
    assert.equal(detailed.truncated, true, `${text} should report that it stopped on the bound`);
    assert.deepEqual(detailed.days, [D(2026, 9, 7)], `${text} keeps DTSTART and nothing else`);
  }
});

test("a long COUNT series from years ago is FOUND, not silently dropped", () => {
  // Walking `COUNT=5000` from 2019 day by day exhausts the bound years before
  // today and returns NOTHING, with no warning: a recurring meeting vanishes and
  // the run reports perfect health.
  const days = daysOf("FREQ=DAILY;COUNT=5000", { year: 2019, month: 1, day: 7 }, [2026, 10, 4], [2026, 10, 26]);
  assert.equal(days.length, 23);
  assert.equal(days[0], "2026-10-04");
  assert.equal(days[days.length - 1], "2026-10-26");
});

test("a COUNT that ran out before the window produces nothing at all", () => {
  assert.deepEqual(daysOf("FREQ=DAILY;COUNT=10", { year: 2019, month: 1, day: 7 }, [2026, 10, 4], [2026, 10, 26]), []);
});

test("fast-forwarding a COUNT series gives the same answer as walking it", () => {
  // The whole risk in fast-forwarding a COUNT rule is MIS-COUNTING the instances
  // it skipped, which ends the series in the wrong place. So the fast path is
  // checked against the slow one directly, rule by rule.
  const bounds = { fromDay: D(2026, 10, 1), toDay: D(2026, 10, 31) };
  const start = { year: 2026, month: 1, day: 7 }; // a Wednesday
  for (const text of [
    "FREQ=DAILY;COUNT=400",
    "FREQ=DAILY;COUNT=300;INTERVAL=1",
    "FREQ=DAILY;COUNT=150;INTERVAL=2",
    "FREQ=DAILY;COUNT=280",
    "FREQ=WEEKLY;COUNT=60;BYDAY=MO,WE,FR",
    "FREQ=WEEKLY;COUNT=41;BYDAY=WE",
    "FREQ=WEEKLY;COUNT=100;BYDAY=TU,TH;INTERVAL=2",
    "FREQ=WEEKLY;COUNT=30",
  ]) {
    const rule = parseRRule(text);
    const fast = expandRuleDetailed(rule, start, bounds);
    const slow = expandRuleDetailed(rule, start, { ...bounds, noFastForward: true });
    assert.equal(fast.truncated, false, `${text}: the fast path should not hit the bound`);
    assert.equal(slow.truncated, false, `${text}: the walked path should not hit the bound either`);
    assert.deepEqual(fast.days, slow.days, `${text}: fast-forward changed the answer`);
  }
});

test("a rule whose FREQ this module does not support expands to DTSTART alone", () => {
  const detailed = expandRuleDetailed(parseRRule("FREQ=SECONDLY"), { year: 2026, month: 9, day: 7 }, {
    fromDay: D(2026, 9, 1),
    toDay: D(2026, 9, 30),
  });
  assert.deepEqual(detailed.days, [D(2026, 9, 7)]);
  assert.equal(detailed.truncated, false);
});
