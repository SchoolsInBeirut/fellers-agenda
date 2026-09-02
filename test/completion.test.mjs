// node --test test/completion.test.mjs
//
// Fabricated fixtures only -- no mail client, no Gradescope credentials, no
// network, and nothing read out of data/. Covers all three completion channels:
// sent-reply matching (src/connectors/mail-outlook.mjs matchReplies), Gradescope
// submission cross-matching (applyGradescopeStatus), and the user's own
// declaration (applyUserCompletions + the --done matcher).

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyGradescopeStatus,
  applyMark,
  applyUserCompletions,
  assignmentSignature,
  clearMark,
  clearedMap,
  completionCandidates,
  completionsMap,
  courseMatches,
  decodeCompletionEnvelope,
  focusPlanDays,
  fuzzyTitleMatch,
  gradescopeMatches,
  isPipelineVia,
  isSessionKey,
  loadCompletionStore,
  loadFocusPlan,
  loadUserCompletions,
  markCancelled,
  markState,
  completionLedger,
  markStatus,
  markSubmitted,
  markTransition,
  matchCompletionQuery,
  mergeCompletionDocs,
  mergeCompletions,
  normCourseCode,
  normSubject,
  parseCompletionQuery,
  parseSessionKey,
  readItem,
  resolveMarks,
  resolveSession,
  saveUserCompletions,
  sessionKeyFor,
  stripReplyPrefix,
  subjectsMatchThread,
} from "../src/completion.mjs";
import { pack } from "../src/lib/envelope.mjs";
import { matchReplies } from "../src/connectors/mail-outlook.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mailMentor = {
  from: "Dr. A. Mentor",
  addr: "a.mentor@example.edu",
  subj: "Re: Prototype Updates After Student Feedback",
  recv: "2026-08-24T15:50:17.073Z",
  tag: "research",
  gist: "She offered Friday or next Tuesday to see the rebuilt prototype.",
  ask: "Confirm a Tuesday time and demo the new grading flow.",
  replyBy: "2026-09-01T21:00:00.000Z",
};

const mailRecords = {
  from: "Records Office (Registrar)",
  addr: "records@example.edu",
  subj: "Re: Itinerary",
  recv: "2026-08-26T20:02:36.938Z",
  tag: "research",
  gist: "Waiting on J. Peer's itinerary and wire form.",
  ask: "Chase the wire if it has not landed.",
  replyBy: null,
};

const itemMentor = {
  k: "0::email::prototype demo meeting with dr mentor",
  c: "Research",
  cid: 0,
  t: "Prototype demo + meeting with Dr. Mentor",
  d: "2026-09-01T21:00:00.000Z",
  ty: "email",
  s: null,
  a: true,
  src: ["outlook"],
  u: null,
};

const itemCdf = {
  k: "0::task::cs 180 course description form cdf",
  c: "Research",
  cid: 0,
  t: "CS 180 Course Description Form (CDF) due",
  d: "2026-09-12T03:59:00.000Z",
  ty: "task",
  s: null,
  src: ["outlook"],
};

const itemHw1 = {
  k: "110004::homework::hw1",
  c: "HIST 140",
  cid: 110004,
  t: "HW1",
  d: "2026-09-07T03:59:00.000Z",
  ty: "homework",
  s: null,
  src: ["outlook"],
};

const sentReplyToMentor = (sentAt) => ({
  entryId: "FIXTURE-REPLY-MENTOR",
  to: ["a.mentor@example.edu", "j.peer@example.edu"],
  toNames: "A. Mentor; J. Peer",
  subj: "RE: Prototype Updates After Student Feedback",
  sentAt,
});

// ---------------------------------------------------------------------------
// Subject / title normalization
// ---------------------------------------------------------------------------

test("stripReplyPrefix removes stacked reply and forward markers", () => {
  assert.equal(stripReplyPrefix("Re: Itinerary"), "Itinerary");
  assert.equal(stripReplyPrefix("RE: FW: Re: Status Stipend Funds"), "Status Stipend Funds");
  assert.equal(stripReplyPrefix("Fwd: [dept-ugrad] CS 180"), "[dept-ugrad] CS 180");
  assert.equal(stripReplyPrefix("Itinerary"), "Itinerary");
});

test("normSubject folds a thread to one key regardless of reply depth", () => {
  assert.equal(normSubject("Re: Prototype Updates After Student Feedback"), normSubject("Prototype Updates After Student Feedback"));
  assert.notEqual(normSubject("Re: Itinerary"), normSubject("Re: Status Stipend Funds"));
});

test("subjectsMatchThread ignores prefixes but not different threads", () => {
  assert.equal(subjectsMatchThread("RE: Itinerary", "Itinerary"), true);
  assert.equal(subjectsMatchThread("Re: Status Stipend Funds", "Status Stipend Funds"), true);
  assert.equal(subjectsMatchThread("Re: Itinerary", "Re: Status Stipend Funds"), false);
});

// ---------------------------------------------------------------------------
// Fuzzy deliverable matching
// ---------------------------------------------------------------------------

test("assignmentSignature canonicalizes numbered deliverables", () => {
  assert.equal(assignmentSignature("HW1"), "hw#1");
  assert.equal(assignmentSignature("Homework 1"), "hw#1");
  assert.equal(assignmentSignature("HW #1"), "hw#1");
  assert.equal(assignmentSignature("Problem Set 3"), "hw#3");
  assert.equal(assignmentSignature("Asynchronous Quiz 2"), "quiz#2");
  assert.equal(assignmentSignature("CHEM 115 Homework 1"), "hw#1", "a course code is not the deliverable number");
  assert.equal(assignmentSignature("Reassessment Sitting"), null);
});

test("fuzzyTitleMatch links the email name to the Gradescope name", () => {
  assert.equal(fuzzyTitleMatch("HW1", "Homework 1"), true);
  assert.equal(fuzzyTitleMatch("Hw1", "HIST 140 Homework 1"), true);
  assert.equal(fuzzyTitleMatch("Homework 1", "Homework 1"), true);
});

test("fuzzyTitleMatch refuses near-miss numbers", () => {
  assert.equal(fuzzyTitleMatch("HW1", "Homework 2"), false);
  assert.equal(fuzzyTitleMatch("HW 1", "HW 11"), false, "containment must not beat the number");
  assert.equal(fuzzyTitleMatch("Quiz 1", "Homework 1"), false, "same number, different kind");
  assert.equal(fuzzyTitleMatch("Homework 1", ""), false);
});

test("normCourseCode and courseMatches fold Gradescope's 5-digit codes", () => {
  assert.equal(normCourseCode("CHEM 11500"), "CHEM115");
  assert.equal(normCourseCode("CHEM-115"), "CHEM115");
  assert.equal(normCourseCode("ART 101"), "ART101");
  assert.equal(courseMatches("HIST 140", "HIST 14000"), true);
  assert.equal(courseMatches("HIST 140", "CHEM 115"), false);
  assert.equal(courseMatches("Research", "Research"), false, "a bucket name is not a course");
  assert.equal(courseMatches("", "CHEM 115"), false);
});

// ---------------------------------------------------------------------------
// Shape tolerance
// ---------------------------------------------------------------------------

test("readItem reads both item shapes", () => {
  const payload = readItem(itemHw1);
  assert.equal(payload.course, "HIST 140");
  assert.equal(payload.title, "HW1");
  assert.equal(payload.type, "homework");
  assert.equal(payload.submitted, null);

  const snapshot = readItem({ courseId: 110003, course: "CHEM 115", title: "Homework 1", due: "2026-09-05T03:59:00.000Z", type: "homework", submitted: false, sources: ["gradescope"] });
  assert.equal(snapshot.course, "CHEM 115");
  assert.equal(snapshot.title, "Homework 1");
  assert.equal(snapshot.submitted, false);
  assert.equal(snapshot.key, "110003::homework::homework 1", "snapshot keys come from merge.mjs itemKey");
});

test("markSubmitted writes the flag in the item's own shape", () => {
  assert.equal(markSubmitted(itemHw1).s, true);
  assert.equal(markSubmitted({ courseId: 1, course: "CHEM 115", title: "x", due: "d", type: "homework", submitted: null }).submitted, true);
  assert.equal(itemHw1.s, null, "input is never mutated");
});

// ---------------------------------------------------------------------------
// Gradescope cross-matching
// ---------------------------------------------------------------------------

const gsAssignments = [
  { courseCode: "HIST 140", name: "Homework 1", due: "2026-09-07T03:59:00.000Z", submitted: true, status: "submitted", url: "https://www.gradescope.com/courses/1" },
  { courseCode: "CHEM 115", name: "Homework 1", due: "2026-09-05T03:59:00.000Z", submitted: false, status: "no submission", url: "https://www.gradescope.com/courses/2" },
  { courseCode: "CHEM 115", name: "Homework 2", due: "2026-09-12T03:59:00.000Z", submitted: true, status: "submitted", url: "https://www.gradescope.com/courses/2" },
];

test("applyGradescopeStatus closes an EMAIL-born item from a Gradescope submission", () => {
  const items = [itemHw1, itemCdf];
  const out = applyGradescopeStatus(items, gsAssignments);
  assert.equal(out[0].s, true, "HIST 140 HW1 (born from Prof. Lang's email) is submitted on Gradescope");
  assert.equal(out[1].s, null, "a research task is untouched");
  assert.equal(items[0].s, null, "input items are not mutated");
  assert.notEqual(out, items, "a NEW array is returned");
  assert.equal(out[0].desc, itemHw1.desc, "every other field is carried through");
});

test("applyGradescopeStatus does not close unsubmitted or mismatched work", () => {
  const item115 = { ...itemHw1, k: "110003::homework::homework 1", c: "CHEM 115", cid: 110003, t: "Homework 1" };
  const out = applyGradescopeStatus([item115], gsAssignments);
  assert.equal(out[0].s, null, "CHEM 115 HW1 is 'no submission' on Gradescope");

  const wrongCourse = applyGradescopeStatus([{ ...itemHw1, c: "PHYS 221", cid: 110001 }], gsAssignments);
  assert.equal(wrongCourse[0].s, null, "a title match in the wrong course must not close it");
});

test("applyGradescopeStatus writes snapshot-shaped items with `submitted`", () => {
  const snapshot = { courseId: 110004, course: "HIST 140", title: "HW1", due: "2026-09-07T03:59:00.000Z", type: "homework", sources: ["outlook"], submitted: null };
  const out = applyGradescopeStatus([snapshot], gsAssignments);
  assert.equal(out[0].submitted, true);
  assert.equal(out[0].s, undefined, "no payload key is grafted onto a snapshot item");
});

test("applyGradescopeStatus is a no-op with no Gradescope data (dormant adapter)", () => {
  for (const empty of [[], null, undefined]) {
    const out = applyGradescopeStatus([itemHw1, itemCdf], empty);
    assert.deepEqual(out, [itemHw1, itemCdf]);
  }
  assert.deepEqual(applyGradescopeStatus(null, gsAssignments), []);
});

test("gradescopeMatches reports what it closed and why", () => {
  const report = gradescopeMatches([itemHw1], gsAssignments);
  assert.equal(report.length, 1);
  assert.equal(report[0].key, "110004::homework::hw1");
  assert.equal(report[0].gsName, "Homework 1");
  assert.equal(report[0].gsCourse, "HIST 140");
});

// ---------------------------------------------------------------------------
// Sent-reply matching
// ---------------------------------------------------------------------------

test("matchReplies closes a mail ask answered by a later reply", () => {
  const out = matchReplies([sentReplyToMentor("2026-08-25T14:00:00.000Z")], [itemMentor], [mailMentor, mailRecords]);
  assert.equal(out.answeredMail.length, 1);
  assert.equal(out.answeredMail[0].addr, "a.mentor@example.edu");
  assert.equal(out.answeredMail[0].hadAsk, true);
  assert.equal(out.answeredItems.length, 1);
  assert.equal(out.answeredItems[0].k, itemMentor.k);
  assert.equal(out.answeredItems[0].via, "replyBy", "the item is linked to its mail by the reply-by instant");
  assert.equal(out.items[0].s, true);
  assert.equal(itemMentor.s, null, "input items are not mutated");
});

test("matchReplies refuses a reply sent BEFORE the message it would answer", () => {
  // The real 2026-08-31 case: a reply to Dr. Mentor exists (sent Aug 23) but her open
  // message arrived Aug 24, so nothing is answered.
  const out = matchReplies([sentReplyToMentor("2026-08-23T17:53:18.277Z")], [itemMentor], [mailMentor]);
  assert.equal(out.answeredMail.length, 0);
  assert.equal(out.answeredItems.length, 0);
  assert.equal(out.items[0].s, null);
  assert.equal(out.candidates.length, 1, "it is still surfaced as a candidate for triage");
  assert.equal(out.candidates[0].to[0], "a.mentor@example.edu");
});

test("matchReplies requires recipient overlap and a matching thread", () => {
  const wrongPerson = {
    entryId: "FIXTURE-WRONG-PERSON",
    to: ["j.peer@example.edu"],
    toNames: "J. Peer",
    subj: "RE: Prototype Updates After Student Feedback",
    sentAt: "2026-08-25T14:00:00.000Z",
  };
  assert.equal(matchReplies([wrongPerson], [itemMentor], [mailMentor]).answeredMail.length, 0);

  const wrongThread = { ...sentReplyToMentor("2026-08-25T14:00:00.000Z"), entryId: "FIXTURE-WRONG-THREAD", subj: "RE: Lab access badge" };
  assert.equal(matchReplies([wrongThread], [itemMentor], [mailMentor]).answeredMail.length, 0);
});

test("matchReplies falls back to display names only when no address resolved", () => {
  const nameOnly = {
    entryId: "FIXTURE-NAME-ONLY",
    to: [],
    toNames: "Records Office; J. Peer",
    subj: "RE: Itinerary",
    sentAt: "2026-08-27T14:00:00.000Z",
  };
  assert.equal(matchReplies([nameOnly], [], [mailRecords]).answeredMail.length, 1);

  const addressedElsewhere = { ...nameOnly, entryId: "FIXTURE-ELSEWHERE", to: ["someone.else@example.edu"] };
  assert.equal(
    matchReplies([addressedElsewhere], [], [mailRecords]).answeredMail.length,
    0,
    "a resolved address that does not match must veto the name fallback",
  );
});

test("matchReplies never closes non-email items", () => {
  const taskFromMentorThread = { ...itemCdf, d: mailMentor.replyBy };
  const out = matchReplies([sentReplyToMentor("2026-08-25T14:00:00.000Z")], [taskFromMentorThread], [mailMentor]);
  assert.equal(out.answeredItems.length, 0, "a reply does not fill in a registration form");
  assert.equal(out.items[0].s, null);
});

test("matchReplies is inert with no sent evidence", () => {
  for (const empty of [[], null, undefined]) {
    const out = matchReplies(empty, [itemMentor], [mailMentor]);
    assert.equal(out.answeredMail.length, 0);
    assert.equal(out.answeredItems.length, 0);
    assert.deepEqual(out.items, [itemMentor]);
    assert.equal(out.checked.sent, 0);
  }
});

test("matchReplies reports items it could not link to any mail", () => {
  const orphan = { ...itemMentor, k: "0::email::orphan thread", t: "Orphan thread", d: "2026-10-01T12:00:00.000Z" };
  const out = matchReplies([], [orphan], []);
  assert.equal(out.unlinkedItems.length, 1);
  assert.equal(out.unlinkedItems[0].k, orphan.k);
});

// ---------------------------------------------------------------------------
// Channel 3: user-declared completion ("I finished X")
// ---------------------------------------------------------------------------
//
// The invariant that matters most here is ONE-WAY. A completion may only ever
// add "done"; nothing in this file, in a scheduled run, or on the page may take
// it back. The agenda is allowed to be wrong about work being finished; it is
// not allowed to tell the user they have not done something they have.

const snapshotItem = (o) => ({
  courseId: 110002,
  course: "MATH 210",
  title: "Homework 2",
  due: "2026-09-04T03:59:00.000Z",
  type: "homework",
  submitted: null,
  sources: ["dropbox"],
  ...o,
});

const KEY_HW2 = "110002::homework::homework 2";
const doneMap = (k = KEY_HW2) => ({ completions: { [k]: { at: "2026-08-31T18:20:00Z", via: "user" } } });

test("applyUserCompletions closes a snapshot-shaped item and records the channel", () => {
  const out = applyUserCompletions([snapshotItem()], doneMap());
  assert.equal(out[0].submitted, true);
  assert.deepEqual(out[0].sources, ["dropbox", "user"]);
});

test("applyUserCompletions closes a payload-shaped item in its own shape", () => {
  const out = applyUserCompletions([{ ...itemHw1, s: null }], doneMap(itemHw1.k));
  assert.equal(out[0].s, true);
  assert.deepEqual(out[0].src, ["outlook", "user"]);
  assert.equal(out[0].submitted, undefined, "payload items must not grow a snapshot field");
});

test("completions are ONE-WAY: an absent entry never un-finishes anything", () => {
  const finished = snapshotItem({ title: "Homework 1", submitted: true, sources: ["dropbox", "grade"] });
  const out = applyUserCompletions([finished], doneMap());
  assert.equal(out[0].submitted, true, "an unrelated completion must not clear this flag");
  assert.deepEqual(out[0].sources, ["dropbox", "grade"], "and must not touch its sources");
  assert.equal(out[0], finished, "untouched items are returned by identity");
});

test("applyUserCompletions never mutates its inputs", () => {
  const items = [snapshotItem()];
  const map = doneMap();
  const out = applyUserCompletions(items, map);
  assert.equal(items[0].submitted, null);
  assert.deepEqual(items[0].sources, ["dropbox"]);
  assert.notEqual(out[0], items[0]);
});

test("applyUserCompletions tolerates an empty, bare, or missing map", () => {
  const items = [snapshotItem()];
  assert.deepEqual(applyUserCompletions(items, null), items);
  assert.deepEqual(applyUserCompletions(items, {}), items);
  assert.deepEqual(applyUserCompletions(items, { completions: {} }), items);
  // A bare map (no wrapper) is the shape the page write-back bus decodes.
  assert.equal(applyUserCompletions(items, { [KEY_HW2]: { at: "x", via: "page" } })[0].submitted, true);
});

test('"user" is added once, however many times the item is re-applied', () => {
  const once = applyUserCompletions([snapshotItem()], doneMap());
  const twice = applyUserCompletions(once, doneMap());
  assert.deepEqual(twice[0].sources, ["dropbox", "user"]);
});

test("mergeCompletions adds entries and never removes or rewrites one", () => {
  const first = mergeCompletions({}, { a: { at: "2026-08-01T00:00:00Z", via: "user" } });
  const second = mergeCompletions(first, {
    a: { at: "2026-08-09T00:00:00Z", via: "page" }, // a later sighting of the same finish
    b: { at: "2026-08-09T00:00:00Z", via: "page" },
  });
  assert.equal(second.a.at, "2026-08-01T00:00:00Z", "the first recording is the true one");
  assert.equal(second.a.via, "user");
  assert.equal(second.b.via, "page");
  assert.equal(Object.keys(second).length, 2);
  assert.equal(Object.keys(first).length, 1, "the input map is untouched");
});

test("completionsMap accepts the wrapper, a bare map, and junk", () => {
  assert.deepEqual(completionsMap(null), {});
  assert.deepEqual(completionsMap({ completions: { a: { at: "x" } } }), { a: { at: "x" } });
  assert.deepEqual(completionsMap({ a: { at: "x" } }), { a: { at: "x" } });
  assert.deepEqual(completionsMap({ a: "2026-08-01T00:00:00Z" }), { a: { at: "2026-08-01T00:00:00Z", via: "user" } });
});

// ---------------------------------------------------------------------------
// `--done "<query>"`: the chat channel's fuzzy matcher
// ---------------------------------------------------------------------------

const snapshot = [
  snapshotItem({ title: "Homework 1", due: "2026-08-28T03:59:00.000Z" }),
  snapshotItem({ title: "Homework 2", due: "2026-09-04T03:59:00.000Z" }),
  snapshotItem({ title: "Homework 2", due: "2026-09-11T03:59:00.000Z" }), // the same key, twice
  snapshotItem({ courseId: 110005, course: "ART 101", title: "Homework 2", due: "2026-09-05T03:59:00.000Z" }),
  snapshotItem({ courseId: 110001, course: "PHYS 221", title: "Sitting 1", type: "exam", due: "2026-09-17T23:30:00.000Z" }),
];

test("completionCandidates collapses repeated rows to one key", () => {
  const keys = completionCandidates(snapshot).map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "one candidate per itemKey");
  assert.equal(keys.length, 4);
});

test("an exact itemKey always resolves to exactly one item", () => {
  const { matches, via } = matchCompletionQuery(KEY_HW2, snapshot);
  assert.equal(via, "key");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].key, KEY_HW2);
});

test("a title that names one deliverable resolves unambiguously", () => {
  const { matches } = matchCompletionQuery("homework 1", snapshot);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, "Homework 1");
});

test("a title shared by two courses is AMBIGUOUS, never guessed", () => {
  const { matches } = matchCompletionQuery("homework 2", snapshot);
  assert.equal(matches.length, 2, "MATH 210 HW2 and ART 101 HW2 both match");
  assert.ok(matches.every((m) => m.key.includes("homework 2")));
});

test("a course code in the query disambiguates it", () => {
  const { matches } = matchCompletionQuery("math 210 homework 2", snapshot);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].course, "MATH 210");

  // 5-digit Brightspace-style codes fold the same way.
  assert.equal(matchCompletionQuery("ART10100 hw 2", snapshot).matches[0].course, "ART 101");
});

test("a bare course code offers that course's work rather than guessing", () => {
  const { matches, via } = matchCompletionQuery("MATH 210", snapshot);
  assert.equal(via, "course");
  assert.equal(matches.length, 2, "both MATH 210 keys - the repeated HW2 row is one candidate");
});

test("near-miss numbers do not match (hw 1 is not hw 11)", () => {
  const withEleven = [...snapshot, snapshotItem({ title: "Homework 11", due: "2026-11-04T03:59:00.000Z" })];
  const { matches } = matchCompletionQuery("math 210 homework 11", withEleven);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, "Homework 11");
});

test("nothing matching is nothing matched - no fallback to the first item", () => {
  assert.deepEqual(matchCompletionQuery("quantum entanglement lab", snapshot).matches, []);
  assert.deepEqual(matchCompletionQuery("", snapshot).matches, []);
  assert.deepEqual(matchCompletionQuery(null, snapshot).matches, []);
});

test("the CLI contract: one match writes, many print, none fails", () => {
  // The CLI is a thin shell over these two calls; this pins the branch each
  // query lands in so the documented exit codes (0 / 4 / 5) stay meaningful.
  assert.equal(matchCompletionQuery(KEY_HW2, snapshot).matches.length, 1); // exit 0
  assert.ok(matchCompletionQuery("homework 2", snapshot).matches.length > 1); // exit 4
  assert.equal(matchCompletionQuery("nope", snapshot).matches.length, 0); // exit 5
});

// ---------------------------------------------------------------------------
// Three states, tombstones, and the session key space
// ---------------------------------------------------------------------------
//
// docs/PROTOCOL.md. Two invariants are load-bearing here:
//
//   1. A SESSION key ("fb|<day>|<bucket>") is a study block, not a deliverable.
//      Nothing keyed on a session may ever touch an item - a session mark that
//      closes the whole deliverable is the bug this key space exists to kill.
//   2. Only a TOMBSTONE removes a mark. An absent key still means nothing, so a
//      doc that has not heard about a mark can never undo it.

const AT1 = "2026-09-01T10:00:00.000Z";
const AT2 = "2026-09-01T11:00:00.000Z";
const AT3 = "2026-09-01T12:00:00.000Z";
const SKEY = "fb|2026-09-01|CHEM 115";

const storeOf = (completions = {}, cleared = {}) => ({ v: 2, completions, cleared });

test("session keys and item keys are two key spaces that never collide", () => {
  assert.equal(isSessionKey(SKEY), true);
  assert.equal(isSessionKey(KEY_HW2), false);
  assert.equal(isSessionKey(null), false);
  assert.equal(sessionKeyFor("2026-09-01", "CHEM 115"), SKEY);
  assert.deepEqual(parseSessionKey(SKEY), { day: "2026-09-01", bucket: "CHEM 115" });
  assert.equal(parseSessionKey(KEY_HW2), null);
  assert.equal(parseSessionKey("fb|nonsense"), null);
  // A bucket may contain spaces; the day is fixed-width, so a 3-field split is safe.
  assert.equal(sessionKeyFor("2026-09-01", "Side Project"), "fb|2026-09-01|Side Project");
  assert.deepEqual(parseSessionKey("fb|2026-09-01|Side Project"), {
    day: "2026-09-01",
    bucket: "Side Project",
  });
});

test("markState defaults to done, so a bare timestamp keeps its meaning", () => {
  assert.equal(markState({ at: AT1, via: "user" }), "done");
  assert.equal(markState({ at: AT1, state: "done" }), "done");
  assert.equal(markState({ at: AT1, state: "cancelled" }), "cancelled");
  assert.equal(markState({ at: AT1, state: "nonsense" }), "done", "junk is not a third state");
  assert.equal(markState(null), "done");
});

test("clearedMap reads the tombstone map and shrugs at anything else", () => {
  assert.deepEqual(clearedMap(null), {});
  assert.deepEqual(clearedMap({ completions: { a: { at: AT1 } } }), {});
  assert.deepEqual(clearedMap(storeOf({}, { a: { at: AT1, via: "user" } })), { a: { at: AT1, via: "user" } });
  assert.deepEqual(clearedMap({ cleared: { a: AT1 } }), { a: { at: AT1, via: "user" } });
});

test("resolveMarks: the newest `at` wins, and a tie goes to the mark", () => {
  // tombstone newer -> the mark is revoked
  assert.deepEqual(resolveMarks(storeOf({ a: { at: AT1 } }, { a: { at: AT2 } })), {});
  // mark newer -> the tombstone is history
  assert.equal(resolveMarks(storeOf({ a: { at: AT2 } }, { a: { at: AT1 } })).a.at, AT2);
  // exact tie -> the mark beats the tombstone
  assert.equal(resolveMarks(storeOf({ a: { at: AT1 } }, { a: { at: AT1 } })).a.at, AT1);
});

test("resolveMarks reads a wrapped map, a bare map and a full store the same way", () => {
  const wrapped = { completions: { [KEY_HW2]: { at: AT1, via: "page" } } };
  assert.deepEqual(resolveMarks(wrapped)[KEY_HW2], { at: AT1, via: "page", state: "done" });
  assert.equal(resolveMarks({ [KEY_HW2]: { at: AT1, via: "page" } })[KEY_HW2].state, "done");
  assert.deepEqual(resolveMarks({ [KEY_HW2]: AT1 })[KEY_HW2], { at: AT1, via: "user", state: "done" });
  assert.deepEqual(resolveMarks(null), {});
  // idempotent: resolving an already-resolved map changes nothing
  const once = resolveMarks(storeOf({ a: { at: AT2, state: "cancelled" } }, { b: { at: AT1 } }));
  assert.deepEqual(resolveMarks(once), once);
});

test("resolveMarks keeps cancelled marks - they are marks, not absences", () => {
  const out = resolveMarks(storeOf({ a: { at: AT1, via: "page", state: "cancelled" } }));
  assert.equal(out.a.state, "cancelled");
});

// --- applying marks to items ----------------------------------------------

test("a cancelled mark sets cancelled:true and never claims the work was done", () => {
  const payload = applyUserCompletions(
    [{ ...itemHw1, s: null }],
    storeOf({ [itemHw1.k]: { at: AT1, via: "page", state: "cancelled" } }),
  );
  assert.equal(payload[0].cancelled, true);
  assert.equal(payload[0].s, null, "cancelled is NOT done - the submitted flag must not move");
  assert.deepEqual(payload[0].src, ["outlook", "user"]);

  const snapshot = applyUserCompletions([snapshotItem()], storeOf({ [KEY_HW2]: { at: AT1, via: "user", state: "cancelled" } }));
  assert.equal(snapshot[0].cancelled, true);
  assert.equal(snapshot[0].submitted, null);
  assert.deepEqual(snapshot[0].sources, ["dropbox", "user"]);
});

test("markCancelled writes one field, both shapes, and never mutates", () => {
  const before = snapshotItem();
  const out = markCancelled(before);
  assert.equal(out.cancelled, true);
  assert.equal(before.cancelled, undefined);
  assert.equal(markCancelled(out), out, "already cancelled comes back by identity");
});

test("a SESSION mark never touches an item (the bug this key space kills, pinned)", () => {
  const items = [snapshotItem(), { ...itemHw1, s: null }];
  const out = applyUserCompletions(items, storeOf({ [SKEY]: { at: AT1, via: "page", state: "done" } }));
  assert.deepEqual(out, items, "a study session is not a deliverable");
  assert.equal(out[0], items[0], "and untouched items come back by identity");
});

test("a tombstoned mark no longer closes its item", () => {
  const store = storeOf({ [KEY_HW2]: { at: AT1, via: "page" } }, { [KEY_HW2]: { at: AT2, via: "user" } });
  const out = applyUserCompletions([snapshotItem()], store);
  assert.equal(out[0].submitted, null, "the user took the mark back");
});

// --- the AGC1 bus ----------------------------------------------------------
//
// The page writes its marks into a Google Doc as one AGC1 line. A Doc is not a
// file: it wraps long lines and can pick up stray whitespace, so the envelope
// carries a prefix and a `.END` terminator and every reader strips whitespace
// before decoding. Anything that does not decode cleanly is SKIPPED, never
// guessed at - a half-read doc would be trashed by the run that half-read it.

const agc1 = (o) => pack("completions", o);

test("decodeCompletionEnvelope reads a well-formed AGC1 doc", () => {
  const doc = decodeCompletionEnvelope(
    agc1({
      v: 2,
      marks: { [SKEY]: { at: AT2, via: "page", state: "cancelled" } },
      cleared: { a: { at: AT1, via: "page" } },
    }),
  );
  assert.equal(doc.v, 2);
  assert.equal(doc.marks[SKEY].state, "cancelled");
  assert.equal(doc.cleared.a.at, AT1);
});

// The page is the only writer on this bus, and it stamps `v: 1` (web/page-template.html,
// compForWrite). The `v` this reader RETURNS is a shape flag, not that number: 2 means
// "a full {marks, cleared} document was read", 1 means "a bare marks map was read". The
// two are unrelated, which is exactly why it is worth pinning - reading the page's own
// envelope as a bare map would silently discard every tombstone in it, and a discarded
// tombstone re-publishes work the user already cancelled.
test("the envelope the page actually writes (v: 1) is read as a full doc, tombstones intact", () => {
  const doc = decodeCompletionEnvelope(
    agc1({
      v: 1,
      marks: { [KEY_HW2]: { at: AT1, via: "page" }, [SKEY]: { at: AT2, via: "page", state: "cancelled" } },
      cleared: { a: { at: AT3, via: "page" } },
    }),
  );
  assert.equal(doc.v, 2, "a document carrying marks/cleared is a full doc whatever its own v says");
  assert.equal(doc.marks[KEY_HW2].at, AT1);
  assert.equal(doc.marks[SKEY].state, "cancelled");
  assert.equal(doc.cleared.a.at, AT3, "the tombstone survives");
});

test("AGC1 round-trips through pack() exactly, marks and tombstones alike", () => {
  const body = {
    v: 2,
    marks: { [KEY_HW2]: { at: AT1, via: "page" }, [SKEY]: { at: AT2, via: "page", state: "cancelled" } },
    cleared: { z: { at: AT3, via: "page" } },
  };
  const text = agc1(body);
  assert.ok(text.startsWith("AGC1."), "the completions bus is never compressed");
  assert.ok(text.endsWith(".END"));
  const doc = decodeCompletionEnvelope(text);
  assert.deepEqual(Object.keys(doc.marks).sort(), [KEY_HW2, SKEY].sort());
  assert.equal(doc.marks[KEY_HW2].at, AT1);
  assert.equal(doc.cleared.z.at, AT3);
});

test("a Doc's soft line breaks do not stop an AGC1 body decoding", () => {
  const text = agc1({ v: 2, marks: { [KEY_HW2]: { at: AT1, via: "page" } }, cleared: {} });
  const wrapped = text.replace(/(.{1,80})/g, "$1\n"); // what a Doc does to a long line
  assert.notEqual(wrapped, text, "the fixture really is wrapped");
  assert.equal(decodeCompletionEnvelope(wrapped).marks[KEY_HW2].at, AT1);
  assert.equal(decodeCompletionEnvelope(`  ${text}\n`).marks[KEY_HW2].at, AT1, "and surrounding space is ignored");
});

test("a corrupted AGC1 body is REFUSED, never silently half-read", () => {
  const text = agc1({ v: 2, marks: { [KEY_HW2]: { at: AT1, via: "page" } }, cleared: {} });
  // Flip one character in the middle of the base64 body.
  const at = Math.floor(text.length / 2);
  const flipped = text.slice(0, at) + (text[at] === "A" ? "B" : "A") + text.slice(at + 1);
  assert.equal(decodeCompletionEnvelope(flipped), null, "corruption is a refusal, not a partial parse");
  // Truncation is the other realistic transcription failure.
  assert.equal(decodeCompletionEnvelope(text.slice(0, -40)), null, "no .END means the doc was cut short");
});

test("decodeCompletionEnvelope refuses junk, empty bodies and unknown prefixes", () => {
  assert.equal(decodeCompletionEnvelope("not an envelope"), null);
  assert.equal(decodeCompletionEnvelope("AGC1..END"), null, "an empty body says nothing");
  assert.equal(decodeCompletionEnvelope("AGZ1." + Buffer.from("{}", "utf8").toString("base64") + ".END"), null);
  assert.equal(decodeCompletionEnvelope("AGC1." + Buffer.from("{oops", "utf8").toString("base64") + ".END"), null);
  assert.equal(decodeCompletionEnvelope(null), null);
  assert.equal(decodeCompletionEnvelope(""), null);
});

test("a payload envelope handed to the completions reader is refused by KIND", () => {
  // AGD is the payload bus. Kinds are not interchangeable: a doc of the wrong
  // kind read as marks would write nonsense keys into the user's own record.
  const payload = pack("data", { v: 4, items: [] }, { compress: false });
  assert.ok(payload.startsWith("AGD1."));
  assert.equal(decodeCompletionEnvelope(payload), null);
  assert.equal(decodeCompletionEnvelope(pack("commands", { v: 1, ops: [] })), null, "nor the command bus");
});

test("a bare marks map carries no tombstones, so it can never revoke anything", () => {
  const current = storeOf({ a: { at: AT1 } }, { a: { at: AT2 } });
  const out = mergeCompletionDocs(current, [{ a: { at: AT1, via: "page" } }]);
  assert.deepEqual(out.completions, {}, "the tombstone still wins");
  assert.equal(out.cleared.a.at, AT2);
});

test("mergeCompletionDocs merges many docs by newest-at, mark beats tombstone on a tie", () => {
  const current = storeOf({ a: { at: AT1, via: "user" } });
  const out = mergeCompletionDocs(current, [
    { v: 2, marks: {}, cleared: { a: { at: AT2, via: "page" } } }, // uncheck
    { v: 2, marks: { b: { at: AT2, via: "page", state: "cancelled" } }, cleared: {} },
    { v: 2, marks: { c: { at: AT3, via: "page" } }, cleared: { c: { at: AT3, via: "page" } } }, // tie
  ]);
  assert.equal(out.v, 2);
  assert.deepEqual(Object.keys(out.completions).sort(), ["b", "c"]);
  assert.equal(out.completions.b.state, "cancelled");
  assert.deepEqual(Object.keys(out.cleared), ["a"], "the revoked key keeps its tombstone");
});

test("mergeCompletionDocs accepts raw envelope strings as well as decoded docs", () => {
  const out = mergeCompletionDocs({}, [
    agc1({ v: 2, marks: { [KEY_HW2]: { at: AT1, via: "page" } }, cleared: {} }),
    { v: 2, marks: { b: { at: AT2, via: "page" } }, cleared: {} },
  ]);
  assert.equal(out.completions[KEY_HW2].at, AT1, "the envelope string was decoded");
  assert.equal(out.completions.b.at, AT2, "and the decoded doc alongside it");
});

test("an undecodable doc is skipped without disturbing the ones beside it", () => {
  const good = agc1({ v: 2, marks: { [KEY_HW2]: { at: AT1, via: "page" } }, cleared: {} });
  const out = mergeCompletionDocs(storeOf({ a: { at: AT1, via: "user" } }), ["AGC1.@@@@.END", good]);
  assert.equal(out.completions[KEY_HW2].at, AT1, "the readable doc still applied");
  assert.equal(out.completions.a.at, AT1, "and what was already recorded survived");
});

test("mergeCompletionDocs is pure, order-stable and idempotent", () => {
  const current = storeOf({ a: { at: AT1, via: "user" } });
  const docs = [{ v: 2, marks: { b: { at: AT2, via: "page" } }, cleared: { a: { at: AT3, via: "page" } } }];
  const once = mergeCompletionDocs(current, docs);
  const twice = mergeCompletionDocs(once, docs);
  assert.deepEqual(twice, once);
  assert.deepEqual(current, storeOf({ a: { at: AT1, via: "user" } }), "the input store is untouched");
  assert.deepEqual(docs[0].marks, { b: { at: AT2, via: "page" } }, "and so are the docs");
});

test("mergeCompletionDocs survives junk docs without losing what it had", () => {
  const current = storeOf({ a: { at: AT1, via: "user" } });
  const out = mergeCompletionDocs(current, [null, "nonsense", 42, { marks: null }]);
  assert.equal(out.completions.a.at, AT1);
});

// --- the three-state machine ----------------------------------------------

test("markStatus reads the effective state of one key", () => {
  const store = storeOf(
    { a: { at: AT1, via: "user" }, b: { at: AT1, via: "page", state: "cancelled" } },
    { c: { at: AT2, via: "user" } },
  );
  assert.equal(markStatus(store, "a").state, "done");
  assert.equal(markStatus(store, "b").state, "cancelled");
  assert.equal(markStatus(store, "c").state, "none", "a tombstoned key is a clean slate");
  assert.equal(markStatus(store, "nope").state, "none");
});

test("applyMark and clearMark are pure store transitions", () => {
  const empty = storeOf();
  const done = applyMark(empty, "a", { at: AT1, via: "user" });
  assert.equal(done.completions.a.state, "done");
  assert.deepEqual(empty.completions, {}, "input untouched");

  const cleared = clearMark(done, "a", { at: AT2, via: "user" });
  assert.deepEqual(cleared.completions, {}, "the losing mark is dropped, the tombstone is the record");
  assert.equal(cleared.cleared.a.at, AT2);
  assert.equal(markStatus(cleared, "a").state, "none");

  const again = applyMark(cleared, "a", { at: AT3, via: "user", state: "cancelled" });
  assert.equal(markStatus(again, "a").state, "cancelled");
  assert.deepEqual(again.cleared, {}, "a fresh mark clears its own tombstone");
});

test("markTransition: the three-state machine, including every refusal", () => {
  const none = storeOf();
  const done = applyMark(none, "a", { at: AT1, via: "user" });
  const cancelled = applyMark(none, "a", { at: AT1, via: "user", state: "cancelled" });

  assert.equal(markTransition(none, "a", "done").op, "mark");
  assert.equal(markTransition(done, "a", "done").op, "noop");
  assert.equal(markTransition(cancelled, "a", "done").op, "mark", "cancelled -> done is one honest step");

  assert.equal(markTransition(none, "a", "cancel").op, "mark");
  assert.equal(markTransition(cancelled, "a", "cancel").op, "noop");
  assert.equal(markTransition(done, "a", "cancel").op, "refuse", "no direct done -> cancelled: it is a deliberate two-step");

  assert.equal(markTransition(done, "a", "clear").op, "clear");
  assert.equal(markTransition(cancelled, "a", "clear").op, "clear", "un-cancel is the same operation");
  assert.equal(markTransition(none, "a", "clear").op, "noop");
});

test("markTransition: a pipeline-origin completion can never be cleared or cancelled", () => {
  const none = storeOf();
  assert.equal(markTransition(none, "a", "clear", { submitted: true }).op, "refuse");
  assert.equal(markTransition(none, "a", "cancel", { submitted: true }).op, "refuse");
  // ... but the user is still allowed to say she did it, as she always was.
  assert.equal(markTransition(none, "a", "done", { submitted: true }).op, "mark");
  // A mark the USER made is hers to take back, even on a submitted item.
  const done = applyMark(none, "a", { at: AT1, via: "page" });
  assert.equal(markTransition(done, "a", "clear", { submitted: true }).op, "clear");
});

// --- the query grammar -----------------------------------------------------

test("a leading session verb means THE SESSION, not the deliverable", () => {
  for (const q of [
    "start hw 1 115",
    "Start HW 1",
    "continue hw 1",
    "finish hw 1",
    "keep working on hw 1",
    "catch up on hw 1",
    "catchup hw 1",
    "start on hw 1",
  ]) {
    assert.equal(parseCompletionQuery(q).scope, "session", '"' + q + '" is a session');
  }
  assert.equal(parseCompletionQuery("start hw 1 115").query, "hw 1 115");
  assert.equal(parseCompletionQuery("keep working on hw 1").query, "hw 1");
});

test("a bare query keeps today's deliverable behavior", () => {
  for (const q of ["hw 1 115", "math 210 homework 2", "start-up survey", "started hw 1", "finished hw 1", ""]) {
    assert.equal(parseCompletionQuery(q).scope, "item", '"' + q + '" is a deliverable');
  }
  // The past tense is deliberately NOT a session verb: "I finished HW 1" in chat
  // means the deliverable, and the block labels are imperatives.
  assert.equal(parseCompletionQuery("finished hw 1").query, "finished hw 1");
});

// --- resolving a session from the focus plan on disk ------------------------

const PLAN = {
  v: 1,
  generatedAt: "2026-09-01T11:00:00.000Z",
  tz: "America/New_York",
  focus: [
    { d: "2026-09-01", blocks: [{ c: "MATH 210", what: "Submit HW 2", t: "16:00", mins: 60 }] },
    { d: "2026-09-02", blocks: [{ c: "CHEM 115", what: "Start HW 1", t: "18:00", mins: 90 }] },
    { d: "2026-09-03", blocks: [{ c: "CHEM 115", what: "Keep working on HW 1", t: "18:00", mins: 60 }] },
  ],
};

test("resolveSession prefers today, then the nearest day with a block", () => {
  const days = focusPlanDays(PLAN);
  assert.equal(resolveSession(days, "MATH 210", "2026-09-01").key, "fb|2026-09-01|MATH 210");
  assert.equal(resolveSession(days, "CHEM 115", "2026-09-01").key, "fb|2026-09-02|CHEM 115", "nearest day forward");
  assert.equal(resolveSession(days, "CHEM 115", "2026-09-03").key, "fb|2026-09-03|CHEM 115", "today wins outright");
  assert.equal(resolveSession(days, "CHEM 115", "2026-09-09").key, "fb|2026-09-03|CHEM 115", "nearest day back");
  assert.equal(resolveSession(days, "ART 101", "2026-09-01"), null, "no block, no session - never guess");
  assert.equal(resolveSession(focusPlanDays(null), "CHEM 115", "2026-09-01"), null);
});

test("focusPlanDays tolerates the payload array, the wrapper, and junk", () => {
  assert.equal(focusPlanDays(PLAN).length, 3);
  assert.equal(focusPlanDays(PLAN.focus).length, 3);
  assert.deepEqual(focusPlanDays(null), []);
  assert.deepEqual(focusPlanDays({ focus: "nope" }), []);
  assert.deepEqual(focusPlanDays([{ d: 5, blocks: [] }]), [], "a day needs a day key");
});

// --- the files on disk (temp dirs only - never data/) ------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenda-completion-"));
}

test("loadCompletionStore normalizes a bare marks file and tolerates absence", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(loadCompletionStore(dir), { v: 2, completions: {}, cleared: {} });
    fs.writeFileSync(
      path.join(dir, "user-completions.json"),
      JSON.stringify({ completions: { [KEY_HW2]: { at: AT1, via: "page" } } }),
    );
    const store = loadCompletionStore(dir);
    assert.equal(store.completions[KEY_HW2].at, AT1);
    assert.deepEqual(store.cleared, {});
    assert.equal(loadUserCompletions(dir)[KEY_HW2].state, "done");

    fs.writeFileSync(path.join(dir, "user-completions.json"), "{ not json");
    assert.deepEqual(loadCompletionStore(dir), { v: 2, completions: {}, cleared: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveUserCompletions writes the wrapper shape, key-sorted, and reads back identically", () => {
  const dir = tmpDir();
  try {
    const store = applyMark(clearMark(storeOf({ z: { at: AT1 } }), "z", { at: AT2 }), "a", {
      at: AT3,
      state: "cancelled",
    });
    saveUserCompletions(dir, store);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "user-completions.json"), "utf8"));
    assert.equal(raw.v, 2);
    assert.deepEqual(Object.keys(raw.completions), ["a"]);
    assert.deepEqual(Object.keys(raw.cleared), ["z"]);
    assert.deepEqual(loadCompletionStore(dir), store);
    // A bare marks map still writes - no caller has to know which it holds.
    saveUserCompletions(dir, { b: { at: AT1, via: "user" } });
    assert.equal(loadCompletionStore(dir).completions.b.at, AT1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFocusPlan reads data/focus-plan.json and shrugs when it is not there", () => {
  const dir = tmpDir();
  try {
    assert.equal(loadFocusPlan(dir), null);
    fs.writeFileSync(path.join(dir, "focus-plan.json"), JSON.stringify(PLAN));
    assert.equal(focusPlanDays(loadFocusPlan(dir)).length, 3);
    fs.writeFileSync(path.join(dir, "focus-plan.json"), "{ not json");
    assert.equal(loadFocusPlan(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// --- the payload ledger: what render.mjs publishes as done[] ----------------
//
// docs/PROTOCOL.md. done[] is the completion LEDGER, not a done list:
// it carries marks (done / cancelled) AND the tombstones of the last 14 days.
// Without the tombstones there is no pipeline -> page revocation channel at
// all, and a mark revoked in chat is resurrected forever by whatever the
// browser happens to have in localStorage.

const CUT = "2026-08-18T00:00:00.000Z"; // 14 days before AT1..AT3

test("completionLedger publishes a plain completion with no extra fields", () => {
  const out = completionLedger({ completions: { [KEY_HW2]: { at: AT1, via: "page" } } }, { since: CUT });
  assert.deepEqual(out, [{ k: KEY_HW2, at: AT1, via: "page" }]);
  assert.equal("state" in out[0], false, "done is the absent-field default, so the common case carries no state");
});

test("completionLedger states: cancelled marks and cleared tombstones both travel", () => {
  const out = completionLedger(
    storeOf({ a: { at: AT2, via: "user", state: "cancelled" } }, { b: { at: AT1, via: "page" } }),
    { since: CUT },
  );
  assert.deepEqual(out, [
    { k: "a", at: AT2, via: "user", state: "cancelled" },
    { k: "b", at: AT1, via: "page", state: "cleared" },
  ]);
});

test("completionLedger publishes only WINNING tombstones", () => {
  // The mark is newer, so the key is done and its dead tombstone says nothing.
  const out = completionLedger(storeOf({ a: { at: AT3, via: "user" } }, { a: { at: AT1, via: "page" } }), {
    since: CUT,
  });
  assert.deepEqual(out, [{ k: "a", at: AT3, via: "user" }]);

  // The other way round: the tombstone wins, and the revocation is what ships.
  const revoked = completionLedger(storeOf({ a: { at: AT1, via: "page" } }, { a: { at: AT3, via: "user" } }), {
    since: CUT,
  });
  assert.deepEqual(revoked, [{ k: "a", at: AT3, via: "user", state: "cleared" }]);
});

test("completionLedger applies ONE window rule to marks and tombstones alike", () => {
  const old = "2026-08-01T00:00:00.000Z";
  const out = completionLedger(storeOf({ a: { at: old } }, { b: { at: old }, c: { at: AT1 } }), { since: CUT });
  assert.deepEqual(out.map((e) => e.k), ["c"], "only what is inside the window ships");
  assert.equal(completionLedger(storeOf({ a: { at: old } })).length, 1, "no window = everything");
});

test("completionLedger sorts newest first, drops undated entries, and is pure", () => {
  const store = storeOf({ a: { at: AT1 }, b: { at: AT3 }, c: {} }, { d: { at: AT2 } });
  const out = completionLedger(store, { since: CUT });
  assert.deepEqual(out.map((e) => e.k), ["b", "d", "a"]);
  assert.deepEqual(store.completions.c, {}, "the input store is untouched");
});

test("completionLedger carries session keys, which is how a block stays ticked", () => {
  const out = completionLedger(storeOf({ [SKEY]: { at: AT1, via: "page" } }, { "fb|2026-09-02|Board": { at: AT2 } }), {
    since: CUT,
  });
  assert.deepEqual(out.map((e) => [e.k, e.state ?? "done"]), [
    ["fb|2026-09-02|Board", "cleared"],
    [SKEY, "done"],
  ]);
});


// --- resolution compares INSTANTS, not strings -----------------------------
//
// The page resolves with Date.parse(). If this file compared raw strings, the
// same instant written two ways would order differently on the two sides of the
// bus, and one side would show a mark the other had revoked.

const AT1_OFFSET = "2026-09-01T07:00:00-04:00"; // == 11:00Z, one hour AFTER AT1

test("a tombstone in offset form still beats an earlier mark in Z form", () => {
  const out = resolveMarks(storeOf({ a: { at: AT1 } }, { a: { at: AT1_OFFSET } }));
  assert.deepEqual(out, {}, "11:00-in-another-notation is still later than 10:00");
  // ... and the same instant written two ways is a TIE, which the mark wins.
  const tie = resolveMarks(storeOf({ a: { at: AT1 } }, { a: { at: "2026-09-01T06:00:00-04:00" } }));
  assert.equal(tie.a.at, AT1);
});

test("an unplaceable stamp loses to a real one, and two of them tie to the mark", () => {
  assert.deepEqual(resolveMarks(storeOf({ a: { at: "whenever" } }, { a: { at: AT1 } })), {});
  assert.equal(resolveMarks(storeOf({ a: { at: AT1 } }, { a: { at: "whenever" } })).a.at, AT1);
  assert.equal(resolveMarks(storeOf({ a: { at: "nonsense" } }, { a: { at: "junk" } })).a.at, "nonsense");
});

test("mergeCompletionDocs and the ledger read the clock the same way", () => {
  const merged = mergeCompletionDocs(storeOf({ a: { at: AT1, via: "page" } }), [
    { v: 2, marks: {}, cleared: { a: { at: AT1_OFFSET, via: "page" } } },
  ]);
  assert.deepEqual(merged.completions, {}, "the offset-form tombstone is newer and wins here too");

  const ledger = completionLedger(storeOf({ a: { at: AT1_OFFSET, via: "page" } }, { b: { at: AT1, via: "user" } }), {
    since: "2026-08-18T00:00:00.000Z",
  });
  assert.deepEqual(ledger.map((e) => e.k), ["a", "b"], "sorted by instant, newest first");
});

// --- session keys are built verbatim ---------------------------------------

test("sessionKeyFor never normalizes the bucket - the page does not either", () => {
  assert.equal(sessionKeyFor("2026-09-01", " CHEM 115 "), "fb|2026-09-01| CHEM 115 ");
  assert.deepEqual(parseSessionKey("fb|2026-09-01| CHEM 115 "), { day: "2026-09-01", bucket: " CHEM 115 " });
  assert.equal(sessionKeyFor("2026-09-01", ""), null);
});

test("resolveSession keys off the PLAN's own bucket string", () => {
  const days = focusPlanDays({ focus: [{ d: "2026-09-01", blocks: [{ c: "CHEM 115", what: "Start HW 1" }] }] });
  assert.equal(resolveSession(days, "CHEM 115", "2026-09-01").key, "fb|2026-09-01|CHEM 115");
  assert.equal(resolveSession(days, " CHEM 115", "2026-09-01"), null, "a bucket that is not the plan's does not resolve");
});

// --- the origin rule, enforced structurally on the bus ---------------------

test("mergeCompletionDocs REFUSES a tombstone against a pipeline-origin mark", () => {
  // A grade is not the user's to take back. markTransition refuses this at the
  // CLI and the page refuses it too; the bus must not be the way around both.
  const current = storeOf({ a: { at: AT1, via: "grade" } });
  const out = mergeCompletionDocs(current, [{ v: 2, marks: {}, cleared: { a: { at: AT3, via: "page" } } }]);
  assert.equal(out.completions.a.at, AT1, "the completion stands");
  assert.deepEqual(out.cleared, {});
  assert.equal(out.refusedTombstones, 1, "and the refusal is counted, not hidden");
});

test("the refusal holds whichever order the entries arrive in", () => {
  const current = storeOf({}, { a: { at: AT3, via: "page" } }); // tombstone first, and newer
  const out = mergeCompletionDocs(current, [{ v: 2, marks: { a: { at: AT1, via: "gradescope" } }, cleared: {} }]);
  assert.equal(out.completions.a.at, AT1);
  assert.deepEqual(out.cleared, {});
  assert.equal(out.refusedTombstones, 1);
});

test("a mark of the USER's own stays revocable, and nothing is counted", () => {
  for (const via of ["user", "page"]) {
    const out = mergeCompletionDocs(storeOf({ a: { at: AT1, via } }), [
      { v: 2, marks: {}, cleared: { a: { at: AT3, via: "page" } } },
    ]);
    assert.deepEqual(out.completions, {}, `a ${via} mark is hers to clear`);
    assert.equal(out.cleared.a.at, AT3);
    assert.equal(out.refusedTombstones, 0);
  }
});

test("refusedTombstones is a report, not part of the store", () => {
  const out = mergeCompletionDocs(storeOf({ a: { at: AT1, via: "grade" } }), [
    { v: 2, marks: {}, cleared: { a: { at: AT3, via: "page" } } },
  ]);
  const dir = tmpDir();
  try {
    saveUserCompletions(dir, out);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "user-completions.json"), "utf8"));
    assert.deepEqual(Object.keys(raw), ["v", "completions", "cleared"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// --- origin survives the round trip, so the guard is not decorative ---------

test("a pipeline channel is preserved verbatim; an absent one is the user's", () => {
  assert.equal(resolveMarks(storeOf({ a: { at: AT1, via: "grade" } })).a.via, "grade");
  assert.equal(resolveMarks(storeOf({ a: { at: AT1 } })).a.via, "user");
  assert.equal(resolveMarks(storeOf({ a: AT1 })).a.via, "user", "a bare timestamp can only be hers");
  assert.equal(isPipelineVia("grade"), true);
  assert.equal(isPipelineVia("gradescope"), true);
  assert.equal(isPipelineVia("user"), false);
  assert.equal(isPipelineVia("page"), false);
  assert.equal(isPipelineVia(undefined), false);
});

test("the origin guard survives a round trip through the store", () => {
  // Run 1: a doc smuggles in a pipeline-origin mark.
  const afterRun1 = mergeCompletionDocs({}, [{ v: 2, marks: { a: { at: AT1, via: "grade" } }, cleared: {} }]);
  assert.equal(afterRun1.completions.a.via, "grade", "folding this to 'user' is what made the guard decorative");
  // Run 2: a later doc tries to revoke it. Still refused, a whole run later.
  const afterRun2 = mergeCompletionDocs(afterRun1, [{ v: 2, marks: {}, cleared: { a: { at: AT3, via: "page" } } }]);
  assert.equal(afterRun2.completions.a.at, AT1);
  assert.equal(afterRun2.refusedTombstones, 1);
});

test("markTransition refuses to clear or cancel a STANDING pipeline mark", () => {
  const store = storeOf({ a: { at: AT1, via: "grade" } });
  assert.equal(markTransition(store, "a", "clear").op, "refuse");
  assert.equal(markTransition(store, "a", "cancel").op, "refuse");
  assert.match(markTransition(store, "a", "clear").why, /not yours to clear/);
  // Hers, on an item the pipeline also reports: still hers to take back.
  const mine = storeOf({ a: { at: AT1, via: "page" } });
  assert.equal(markTransition(mine, "a", "clear", { submitted: true }).op, "clear");
  // And "cancel" on her own done mark still asks for the two-step, not this.
  assert.match(markTransition(mine, "a", "cancel").why, /clear that first/);
});

test("the ledger tells the page which completions are not the user's", () => {
  const out = completionLedger(storeOf({ a: { at: AT1, via: "grade" } }), { since: CUT });
  assert.deepEqual(out, [{ k: "a", at: AT1, via: "grade" }], "via is evidence, not decoration");
});

