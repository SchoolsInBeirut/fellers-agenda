// node --test test/merge.test.mjs
//
// Regression guard for the "finished work shown as overdue" incident: a scrape
// read submission fields the LMS never sends, so every quiz and dropbox row was
// stamped submitted:false. The gradebook is the authoritative completion signal,
// and absence of evidence must stay null.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGrades,
  collapseCalendarTwins,
  dedupe,
  gradeIndex,
  itemKey,
  mergeSubmitted,
  normTitle,
} from "../src/merge.mjs";

const COURSE_ID = 110005;
const item = (o) => ({ courseId: COURSE_ID, sources: ["quiz"], submitted: null, approx: false, url: null, ...o });

// A gradebook of the shape that produced the incident, category rollups included.
const COURSE_GRADES = [
  { name: "Asynchronous Quizzes", displayGrade: "7.5 %", pointsNumerator: 18, pointsDenominator: 240 },
  { name: "Asynchronous Quiz 1", displayGrade: "100 %", pointsNumerator: 10, pointsDenominator: 10 },
  { name: "Asynchronous Quiz 2", displayGrade: "80 %", pointsNumerator: 8, pointsDenominator: 10 },
  { name: "Homeworks", displayGrade: "8.3 %", pointsNumerator: 10, pointsDenominator: 120 },
  { name: "Homework 1", displayGrade: "100 %", pointsNumerator: 10, pointsDenominator: 10 },
  { name: "Exams", displayGrade: "0 %", pointsNumerator: 0, pointsDenominator: 320 },
];
const idx = () => new Map([[COURSE_ID, gradeIndex(COURSE_GRADES)]]);

test("a posted grade with points earned marks the item submitted", () => {
  const out = applyGrades([item({ title: "Homework 1", submitted: null })], idx());
  assert.equal(out[0].submitted, true);
  assert.equal(out[0].grade, "100 %");
  assert.deepEqual(out[0].sources, ["quiz", "grade"]);
});

test("a grade overrides a stale not-submitted flag, never the other way round", () => {
  const out = applyGrades([item({ title: "Asynchronous Quiz 2", submitted: false })], idx());
  assert.equal(out[0].submitted, true, "gradebook truth must win over quiz-endpoint silence");
});

test("grade matching is exact: Homework 1 must not claim Homework 10", () => {
  const out = applyGrades(
    [item({ title: "Homework 10" }), item({ title: "Homework 11" })],
    idx(),
  );
  assert.equal(out[0].submitted, null);
  assert.equal(out[1].submitted, null);
});

test("category rollups never match an individual item", () => {
  const out = applyGrades(
    [item({ title: "Asynchronous Quiz 3" }), item({ title: "Exam 1" })],
    idx(),
  );
  assert.equal(out[0].submitted, null, "'Asynchronous Quizzes' rollup is not quiz 3");
  assert.equal(out[1].submitted, null, "'Exams' rollup is not exam 1");
});

test("a zero-point grade is ambiguous and leaves the item alone", () => {
  const zero = new Map([[COURSE_ID, gradeIndex([{ name: "Homework 4", pointsNumerator: 0, pointsDenominator: 10 }])]]);
  assert.equal(applyGrades([item({ title: "Homework 4" })], zero)[0].submitted, null);
});

test("grades do not leak across courses", () => {
  const out = applyGrades([item({ courseId: 110001, title: "Homework 1" })], idx());
  assert.equal(out[0].submitted, null);
});

test("mergeSubmitted ranks proof over accusation over silence", () => {
  assert.equal(mergeSubmitted(false, true), true);
  assert.equal(mergeSubmitted(true, false), true);
  assert.equal(mergeSubmitted(false, null), false);
  assert.equal(mergeSubmitted(null, null), null);
});

test("dedupe keeps a submitted:true no matter which source arrives first", () => {
  const due = "2026-08-25T03:59:59.000Z";
  const a = dedupe([
    item({ title: "Homework 1", due, submitted: false }),
    item({ title: "Homework 1", due, submitted: true, sources: ["grade"] }),
  ]);
  const b = dedupe([
    item({ title: "Homework 1", due, submitted: true, sources: ["grade"] }),
    item({ title: "Homework 1", due, submitted: false }),
  ]);
  assert.equal(a.length, 1);
  assert.equal(a[0].submitted, true);
  assert.equal(b[0].submitted, true);
});

test("exam twin collapse keeps the completion signal", () => {
  const out = collapseCalendarTwins([
    item({ title: "Exam 1", type: "exam", due: "2026-09-16T13:00:00.000Z", sources: ["calendar"], submitted: null }),
    item({ title: "Exam 1", type: "exam", due: "2026-09-17T03:59:00.000Z", sources: ["content"], submitted: true }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].due, "2026-09-16T13:00:00.000Z", "the sitting date wins");
  assert.equal(out[0].submitted, true);
});

test("normTitle lines gradebook names up with item titles", () => {
  assert.equal(normTitle("Asynchronous Quiz 1"), normTitle("asynchronous  quiz  1!"));
  assert.notEqual(normTitle("Homework 1"), normTitle("Homework 10"));
});

// ---------------------------------------------------------------------------
// itemKey is the identity every channel writes against
// ---------------------------------------------------------------------------
//
// data/user-completions.json, data/calendar-map.json, data/descriptions.json and
// the payload's done[] are all keyed by itemKey. If the key drifts, a completion
// the user recorded last week silently stops matching its item - and the agenda
// starts nagging about finished work again. These pin the shape.

test("itemKey is stable across the cosmetic noise an LMS adds to titles", () => {
  const base = { courseId: 110002, type: "homework", title: "Homework 2" };
  assert.equal(itemKey(base), "110002::homework::homework 2");
  assert.equal(itemKey({ ...base, title: "Homework 2 (due)" }), itemKey(base));
  assert.equal(itemKey({ ...base, title: "  HOMEWORK   2  " }), itemKey(base));
  assert.equal(itemKey({ ...base, title: "Homework 2 - Dropbox" }), itemKey(base));
});

test("itemKey separates work that only looks alike", () => {
  const hw2 = { courseId: 110002, type: "homework", title: "Homework 2" };
  assert.notEqual(itemKey(hw2), itemKey({ ...hw2, title: "Homework 20" }));
  assert.notEqual(itemKey(hw2), itemKey({ ...hw2, courseId: 110005 }), "same title, different course");
  assert.notEqual(itemKey(hw2), itemKey({ ...hw2, type: "quiz" }));
});

test("a key survives the due date moving, which is why completions key on it", () => {
  const item = { courseId: 110001, type: "exam", title: "Sitting 1", due: "2026-09-02T23:30:00Z" };
  const moved = { ...item, due: "2026-09-17T23:30:00Z" };
  assert.equal(itemKey(moved), itemKey(item));
});
