/* The pure arithmetic underneath every calendar-shaped module.
 *
 * Most of `civil-time.mjs` is exercised through its callers - the inbound
 * calendar, the planner, the brief. What no caller pins is the pair of choices
 * the module makes at a daylight-saving boundary, where both answers look
 * plausible and only one is what the code does. The docstring on `localToUtc`
 * describes those choices; this file is what stops the two drifting apart.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { dayKeyOf, dayNumOf, dayNumOfKey, localToUtc, zoneOffsetMinutes } from "../src/lib/civil-time.mjs";

const NY = "America/New_York";

test("day numbers are integers, so 'the day after' is a + 1 across a DST boundary", () => {
  // 2026-03-08 is the short day in New York. Counting in milliseconds would put
  // the next day an hour early; counting in day numbers cannot.
  const spring = dayNumOfKey("2026-03-08");
  assert.equal(dayKeyOf(spring + 1), "2026-03-09");
  assert.equal(dayNumOf(2026, 3, 8), spring);
  assert.equal(dayNumOfKey("not a day"), null);
});

test("an ambiguous wall clock - the hour repeated at fall-back - takes the FIRST occurrence", () => {
  // 2026-11-01 01:30 happens twice in New York: once at -4 (05:30Z) and again
  // at -5 (06:30Z). The earlier one is what every calendar client shows.
  assert.equal(localToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY), Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(zoneOffsetMinutes(Date.parse("2026-11-01T05:30:00Z"), NY), -240);
});

test("a non-existent wall clock resolves one offset EARLIER than the gap, not later", () => {
  // 2026-03-08 02:30 does not exist in New York - the clocks go 01:59 -> 03:00.
  // The correction pass settles on the offset in force AFTER the transition,
  // which puts the instant BEFORE the gap: 06:30Z reads back as 01:30 EST. A
  // client that shifted the gap forward would answer 07:30Z instead. The point
  // of this test is not that one is right; it is that the docstring and the
  // code say the same thing.
  const ms = localToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
  assert.equal(ms, Date.parse("2026-03-08T06:30:00Z"));
  assert.equal(zoneOffsetMinutes(ms, NY), -300, "the instant lands in EST, before the jump");
});

test("a wall clock nowhere near a transition is simply itself", () => {
  assert.equal(localToUtc({ year: 2026, month: 9, day: 5, hour: 9, minute: 30 }, NY), Date.parse("2026-09-05T13:30:00Z"));
  assert.equal(localToUtc({ year: 2026, month: 9, day: 5, hour: 9, minute: 30 }, "UTC"), Date.parse("2026-09-05T09:30:00Z"));
});
