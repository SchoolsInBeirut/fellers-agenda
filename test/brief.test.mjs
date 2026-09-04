/* The plain-text brief that rides after the payload envelope.
 *
 * `renderBrief` is pure, so every test here is a call with a fixed clock. What
 * it pins is the part a phone depends on and no other test can reach:
 *
 *  * the SHAPE - the two markers, the four sections, and what an empty one says;
 *  * the BUDGET - the caps add up, so the closing marker can never be the line
 *    that gets dropped on the busiest day of the term;
 *  * the KEYS - a row the user can act on carries its item key WHOLE or not at
 *    all. A truncated key is worse than none: the phone quotes it verbatim, the
 *    completions bus never matches it, and the user is told work is done that
 *    the pipeline still shows as overdue;
 *  * pure ASCII, on every line, whatever went in.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSE_MARK,
  DUE_CAP,
  MAX_COLS,
  MAX_LINES,
  MEETINGS_CAP,
  OPEN_MARK,
  OVERDUE_CAP,
  PLAN_CAP,
  SECTION_OVERHEAD,
  briefBudget,
  byCode,
  clip,
  closedKeys,
  finishLine,
  fitsKey,
  keyOf,
  renderBrief,
  stampOf,
  tieItemFor,
  tieWords,
  toAscii,
  truncate,
} from "../src/brief.mjs";

const TZ = "America/New_York";
const NOW = new Date("2026-09-03T18:10:00.000Z"); // Thu 2:10 PM EDT
const TODAY = "2026-09-03";
const TOMORROW = "2026-09-04";

const item = (o = {}) => ({
  k: "110002::homework::hw 1",
  c: "MATH 210",
  cid: 110002,
  t: "HW 1",
  d: "2026-09-04T03:59:00.000Z",
  ty: "homework",
  s: null,
  src: ["lms"],
  ...o,
});

const payload = (o = {}) => ({
  v: 4,
  scrapedAt: "2026-09-03T18:05:00.000Z",
  tz: TZ,
  weights: {},
  schedule: [],
  board: [],
  done: [],
  items: [],
  announcements: [],
  mail: [],
  focus: [],
  meetings: [],
  errors: [],
  ...o,
});

const lines = (text) => text.split("\n");
const sectionOf = (text, title) => {
  const all = lines(text);
  const at = all.indexOf(title);
  assert.ok(at >= 0, `no section titled ${title}\n${text}`);
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => /^[A-Z-]/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
};

/* -------------------------------------------------------------- the shape */

test("an empty week still produces a complete brief, and every section says (none)", () => {
  const out = renderBrief(payload(), NOW, TZ, { title: "Weekly Agenda" });
  const all = lines(out);
  assert.equal(all[0], OPEN_MARK);
  assert.equal(all[all.length - 1], CLOSE_MARK);
  assert.match(all[1], /^Weekly Agenda brief - Thu Sep 3, 2026 2:10 PM ED?S?T \(scraped 2026-09-03T18:05Z\)$/);
  for (const title of ["TODAY'S PLAN", "DUE IN 48H", "OVERDUE", "MEETINGS TOMORROW"]) {
    assert.deepEqual(sectionOf(out, title), ["  (none)"]);
  }
});

test("the title comes from the caller, never from a constant in the file", () => {
  assert.match(renderBrief(payload(), NOW, TZ, { title: "Term Plan" }), /^.*\nTerm Plan brief - /);
  // and a caller that says nothing gets a generic word, not a project name
  assert.match(renderBrief(payload(), NOW, TZ), /\nAgenda brief - /);
});

test("a missing scrapedAt simply drops the parenthetical rather than printing null", () => {
  const out = renderBrief(payload({ scrapedAt: null }), NOW, TZ, { title: "A" });
  assert.equal(lines(out)[1].includes("scraped"), false);
  assert.equal(lines(out)[1].includes("null"), false);
});

test("renderBrief refuses a non-object and an unreadable clock rather than guessing", () => {
  assert.throws(() => renderBrief(null, NOW, TZ), TypeError);
  assert.throws(() => renderBrief([], NOW, TZ), TypeError);
  assert.throws(() => renderBrief(payload(), "lunchtime", TZ), RangeError);
});

/* --------------------------------------------------------- today's plan */

test("the plan merges study blocks, attended classes and meetings in clock order", () => {
  const out = renderBrief(
    payload({
      focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Finish HW 1", t: "16:00", mins: 90 }] }],
      schedule: [
        { c: "MATH 210", attend: true, room: "LAB 110", days: ["Thu"], start: "13:30", end: "14:45", from: null, until: null },
        { c: "PHYS 221", attend: false, room: "HALL 101", days: ["Thu"], start: "09:00", end: "10:15", from: null, until: null },
      ],
      meetings: [
        { k: "cal|a|1", feed: "cal", lbl: "Work", t: "Sprint planning", s: "2026-09-03T19:00:00.000Z", e: "2026-09-03T20:00:00.000Z", ad: false, loc: "Room 4B", free: false },
      ],
    }),
    NOW,
    TZ,
    { title: "A" },
  );
  const plan = sectionOf(out, "TODAY'S PLAN");
  assert.equal(plan.length, 3, plan.join("\n"));
  assert.match(plan[0], /^ {2}13:30-14:45 {2}MATH 210 {3}class, LAB 110$/);
  assert.match(plan[1], /^ {2}15:00-16:00 {2}Work {7}MEETING Sprint planning \(Room 4B\)$/);
  assert.match(plan[2], /^ {2}16:00-17:30 {2}MATH 210 {3}Finish HW 1/);
  assert.ok(!out.includes("PHYS 221"), "a lecture the user does not attend is not a commitment");
});

test("an untimed block says anytime and sits after everything with a clock", () => {
  const out = renderBrief(
    payload({ focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Read chapter 3", mins: 45 }, { c: "CHEM 115", what: "Lab prep", t: "16:00", mins: 60 }] }] }),
    NOW, TZ, { title: "A" },
  );
  const plan = sectionOf(out, "TODAY'S PLAN");
  assert.match(plan[0], /^ {2}16:00-17:00/);
  assert.match(plan[1], /^ {2}anytime {5}/);
});

test("an all-day meeting leads the day and a timed one is placed by its start", () => {
  const out = renderBrief(
    payload({
      meetings: [
        { k: "cal|t|1", feed: "cal", lbl: "Work", t: "Standup", s: "2026-09-03T13:15:00.000Z", e: "2026-09-03T13:30:00.000Z", ad: false, free: false },
        { k: "cal|a|1", feed: "cal", lbl: "Work", t: "Reading day", s: TODAY, e: TOMORROW, ad: true, free: false },
      ],
    }),
    NOW, TZ, { title: "A" },
  );
  const plan = sectionOf(out, "TODAY'S PLAN");
  assert.match(plan[0], /^ {2}all day {6}Work {7}MEETING Reading day$/);
  assert.match(plan[1], /^ {2}09:15-09:30 {2}Work {7}MEETING Standup$/);
});

test("a meeting with no usable end shows its start rather than claiming the evening", () => {
  const out = renderBrief(
    payload({ meetings: [{ k: "cal|t|1", feed: "cal", lbl: "Work", t: "Open ended", s: "2026-09-03T18:00:00.000Z", e: null, ad: false, free: false }] }),
    NOW, TZ, { title: "A" },
  );
  const plan = sectionOf(out, "TODAY'S PLAN");
  assert.match(plan[0], /^ {2}14:00 {8}Work {7}MEETING Open ended$/, plan[0]);
});

test("an all-day meeting with no end still stands on its own day - `e` is EXCLUSIVE", () => {
  // `s <= day < e`, so a missing end read as `s` gives an empty span and the
  // meeting silently disappears. One day is the only reading that shows it.
  const out = renderBrief(
    payload({ meetings: [{ k: "cal|a|1", feed: "cal", lbl: "Work", t: "Conference", s: TODAY, ad: true, free: false }] }),
    NOW, TZ, { title: "A" },
  );
  assert.match(sectionOf(out, "TODAY'S PLAN")[0], /^ {2}all day {6}Work {7}MEETING Conference$/);
});

/* --------------------------------------------- the key lead-in is unique --
   docs/PHONE.md tells the phone the key is everything after the LAST " #" on a
   row. That rule is only safe while the KEY is the only thing that can put a
   " #" on one - and titles, block text and locations are all written by other
   people. A phantom key is worse than a missing one: the phone quotes it back,
   the completions bus matches nothing, and the user is told work is done. */

test("a ' #' inside untrusted text never becomes a phantom key", () => {
  const out = renderBrief(
    payload({
      items: [item({ k: "110002::homework::hw 3", t: "Homework #3", d: "2026-09-04T03:59:00.000Z" })],
      focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Review Homework #3 notes", t: "16:00", mins: 90 }] }],
      meetings: [
        { k: "cal|a|1", feed: "cal", lbl: "Work", t: "Standup #4", s: "2026-09-03T13:15:00.000Z", e: "2026-09-03T13:30:00.000Z", ad: false, loc: "Room #2", free: false },
      ],
    }),
    NOW, TZ, { title: "A" },
  );
  for (const line of out.split("\n")) {
    const hits = line.split(" #").length - 1;
    assert.ok(hits <= 1, `more than one " #" on: ${line}`);
    // The one that survives is a real key, whole: the phone copies to the end
    // of the line, so whatever follows it has to BE the key.
    if (hits === 1) assert.match(line, / #110002::homework::hw 3$/, line);
  }
  // The keyless rows keep their text and simply lose the lead-in.
  const plan = sectionOf(out, "TODAY'S PLAN");
  assert.ok(plan.some((l) => /Standup No\.4/.test(l) && !l.includes(" #")), plan.join("\n"));
});

test("a keyless row carrying a ' #' has no ' #' left at all", () => {
  const out = renderBrief(
    payload({
      // A block that serves no single deliverable gets no key, so nothing on
      // this row may look like one.
      focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Read chapter #3", t: "16:00", mins: 45 }] }],
    }),
    NOW, TZ, { title: "A" },
  );
  const plan = sectionOf(out, "TODAY'S PLAN");
  assert.equal(plan.length, 1);
  assert.equal(plan[0].includes(" #"), false, plan[0]);
  assert.match(plan[0], /Read chapter No\.3$/);
});

test("a key the ASCII pass would change is not printed - no key beats a wrong key", () => {
  // `normTitle` cannot mint one today, so this is the guard rather than a case
  // in the wild: whatever the phone quotes has to be what the bus holds.
  assert.equal(keyOf({ k: "0::task::ship the #1 deck" }, 26), "");
  assert.equal(keyOf({ k: "0::task::ship the deck" }, 26), " #0::task::ship the deck");
});

test("toAscii is where the lead-in is spent, so every caller inherits the guarantee", () => {
  assert.equal(toAscii("Homework #3"), "Homework No.3");
  assert.equal(toAscii("#3 only"), "No.3 only", "a leading one becomes ' #' the moment a row puts furniture in front");
  assert.equal(toAscii("C# and F#"), "C# and F#", "a sharp with no space in front of it is not a lead-in");
});

test("a class outside its own from/until range is not on today's plan", () => {
  const base = { c: "MATH 210", attend: true, room: "LAB 110", days: ["Thu"], start: "13:30", end: "14:45" };
  const after = renderBrief(payload({ schedule: [{ ...base, from: null, until: "2026-08-30" }] }), NOW, TZ, { title: "A" });
  const before = renderBrief(payload({ schedule: [{ ...base, from: "2026-10-01", until: null }] }), NOW, TZ, { title: "A" });
  assert.deepEqual(sectionOf(after, "TODAY'S PLAN"), ["  (none)"]);
  assert.deepEqual(sectionOf(before, "TODAY'S PLAN"), ["  (none)"]);
});

/* ------------------------------------------------------------- deadlines */

test("DUE IN 48H holds only what is ahead and inside the window, oldest first", () => {
  const out = renderBrief(
    payload({
      items: [
        item({ k: "1::homework::soon", t: "Soon", d: "2026-09-04T03:59:00.000Z" }),
        item({ k: "1::homework::later", t: "Later", d: "2026-09-06T03:59:00.000Z" }),
        item({ k: "1::homework::past", t: "Past", d: "2026-09-01T03:59:00.000Z" }),
      ],
    }),
    NOW, TZ, { title: "A" },
  );
  const due = sectionOf(out, "DUE IN 48H");
  assert.equal(due.length, 1);
  assert.match(due[0], /Soon/);
  const overdue = sectionOf(out, "OVERDUE");
  assert.equal(overdue.length, 1);
  assert.match(overdue[0], /Past/);
});

test("`(not confirmed)` marks a deadline nothing has proven submitted, and only there", () => {
  const due = sectionOf(
    renderBrief(payload({ items: [item({ s: null }), item({ k: "1::homework::b", t: "HW 2", s: false })] }), NOW, TZ, { title: "A" }),
    "DUE IN 48H",
  );
  assert.equal(due.length, 2);
  for (const l of due) assert.match(l, /\(not confirmed\)/);
  // the overdue section never carries the marker: nothing there is confirmable
  const od = sectionOf(
    renderBrief(payload({ items: [item({ d: "2026-09-01T03:59:00.000Z" })] }), NOW, TZ, { title: "A" }),
    "OVERDUE",
  );
  assert.equal(od[0].includes("(not confirmed)"), false);
});

test("a submitted item, a done mark and a cancellation all leave the brief", () => {
  const marked = payload({
    items: [item({ k: "a", t: "Marked" }), item({ k: "b", t: "Cancelled" }), item({ k: "c", t: "Submitted", s: true })],
    done: [
      { k: "a", at: "2026-09-03T12:00:00.000Z", via: "user", state: "done" },
      { k: "b", at: "2026-09-03T12:00:00.000Z", via: "user", state: "cancelled" },
    ],
  });
  const out = renderBrief(marked, NOW, TZ, { title: "A" });
  assert.deepEqual(sectionOf(out, "DUE IN 48H"), ["  (none)"]);
});

test("a `cleared` entry is a revocation, so the item comes back", () => {
  const out = renderBrief(
    payload({
      items: [item({ k: "a", t: "Back again" })],
      done: [{ k: "a", at: "2026-09-03T12:00:00.000Z", via: "user", state: "cleared" }],
    }),
    NOW, TZ, { title: "A" },
  );
  assert.match(sectionOf(out, "DUE IN 48H")[0], /Back again/);
});

test("an item with an unreadable due date is in neither deadline section", () => {
  const out = renderBrief(payload({ items: [item({ d: "sometime" })] }), NOW, TZ, { title: "A" });
  assert.deepEqual(sectionOf(out, "DUE IN 48H"), ["  (none)"]);
  assert.deepEqual(sectionOf(out, "OVERDUE"), ["  (none)"]);
});

/* -------------------------------------------------- meetings tomorrow */

test("MEETINGS TOMORROW carries tomorrow's, in clock order, with no MEETING prefix", () => {
  const out = renderBrief(
    payload({
      meetings: [
        { k: "cal|b|1", feed: "cal", lbl: "Work", t: "Late one", s: "2026-09-04T21:00:00.000Z", e: "2026-09-04T22:00:00.000Z", ad: false, free: false },
        { k: "cal|a|1", feed: "cal", lbl: "Work", t: "Early one", s: "2026-09-04T13:00:00.000Z", e: "2026-09-04T14:00:00.000Z", ad: false, free: false },
      ],
    }),
    NOW, TZ, { title: "A" },
  );
  const m = sectionOf(out, "MEETINGS TOMORROW");
  assert.equal(m.length, 2);
  assert.match(m[0], /Early one/);
  assert.match(m[1], /Late one/);
  assert.equal(m[0].includes("MEETING"), false, "the section title already said so");
});

/* ------------------------------------------------------------ the note */

test("the note is today's focus note and nothing else", () => {
  const out = renderBrief(
    payload({ focus: [{ d: TODAY, blocks: [], note: "Start 210 tonight." }, { d: TOMORROW, blocks: [], note: "Not this one." }] }),
    NOW, TZ, { title: "A" },
  );
  assert.ok(out.includes("NOTE  Start 210 tonight."));
  assert.equal(out.includes("Not this one."), false);
});

/* ------------------------------------------------------------- the keys */

test("an actionable row carries its item key inline, after the LAST ' #'", () => {
  const out = renderBrief(payload({ items: [item()] }), NOW, TZ, { title: "A" });
  const row = sectionOf(out, "DUE IN 48H")[0];
  const at = row.lastIndexOf(" #");
  assert.ok(at > 0, row);
  assert.equal(row.slice(at + 2), "110002::homework::hw 1");
});

test("a key that would not fit WHOLE is dropped, never truncated", () => {
  const long = "1".repeat(60) + "::homework::" + "x".repeat(60);
  const out = renderBrief(payload({ items: [item({ k: long })] }), NOW, TZ, { title: "A" });
  const row = sectionOf(out, "DUE IN 48H")[0];
  assert.equal(row.includes(" #"), false, `a truncated key would be worse than none:\n${row}`);
  assert.ok(row.length <= MAX_COLS);
});

test("fitsKey and keyOf are the one place that decision is made", () => {
  assert.equal(fitsKey(" #abc", MAX_COLS - 5), true);
  assert.equal(fitsKey(" #abc", MAX_COLS - 3), false);
  assert.equal(keyOf({ k: "abc" }, 10), " #abc");
  assert.equal(keyOf({ k: "x".repeat(200) }, 10), "");
  assert.equal(keyOf(null, 10), "");
  assert.equal(keyOf({}, 10), "");
});

test("a study block carries the key of the ONE deliverable it serves, or none", () => {
  const hw = item({ k: "110002::homework::hw 1", t: "HW 1" });
  const one = renderBrief(
    payload({ items: [hw], focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Finish HW 1", t: "16:00", mins: 90 }] }] }),
    NOW, TZ, { title: "A" },
  );
  assert.match(sectionOf(one, "TODAY'S PLAN")[0], / #110002::homework::hw 1$/);

  // two candidates is not a tie, it is a guess - and a wrong key marks the
  // wrong item done from a phone
  const two = renderBrief(
    payload({
      items: [hw, item({ k: "110002::homework::hw 1 redo", t: "HW 1" })],
      focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Finish HW 1", t: "16:00", mins: 90 }] }],
    }),
    NOW, TZ, { title: "A" },
  );
  assert.equal(sectionOf(two, "TODAY'S PLAN")[0].includes(" #"), false);
});

test("neither a class nor a meeting ever carries a key - there is nothing to mark", () => {
  const out = renderBrief(
    payload({
      schedule: [{ c: "MATH 210", attend: true, room: "LAB 110", days: ["Thu"], start: "13:30", end: "14:45", from: null, until: null }],
      meetings: [{ k: "cal|a|1", feed: "cal", lbl: "Work", t: "Sprint planning", s: "2026-09-03T19:00:00.000Z", e: "2026-09-03T20:00:00.000Z", ad: false, free: false }],
    }),
    NOW, TZ, { title: "A" },
  );
  for (const row of sectionOf(out, "TODAY'S PLAN")) assert.equal(row.includes(" #"), false, row);
});

test("tieItemFor expands the usual abbreviations and refuses an ambiguous match", () => {
  assert.deepEqual(tieWords("HW 1"), ["homework", "1"]);
  assert.deepEqual(tieWords("pset 3"), ["problem", "set", "3"]);
  const items = [item({ k: "a", t: "Problem Set 3", c: "MATH 210" })];
  const hit = tieItemFor({ c: "MATH 210", what: "Work through problem set 3", why: "" }, TODAY, items, TZ);
  assert.equal(hit.k, "a");
  assert.equal(tieItemFor({ c: "CHEM 115", what: "Work through problem set 3" }, TODAY, items, TZ), null);
  assert.equal(tieItemFor(null, TODAY, items, TZ), null);
});

/* ---------------------------------------------------------- the budget */

test("the caps add up to the line budget, so nothing can be silently cut", () => {
  assert.equal(PLAN_CAP + DUE_CAP + OVERDUE_CAP + MEETINGS_CAP + SECTION_OVERHEAD, briefBudget());
  assert.ok(briefBudget() <= MAX_LINES, `${briefBudget()} lines can be produced but only ${MAX_LINES} survive`);
});

test("a section past its cap says how many it dropped rather than dropping them silently", () => {
  const many = Array.from({ length: DUE_CAP + 5 }, (_, i) =>
    item({ k: `1::homework::hw${i}`, t: `HW ${i}`, d: new Date(NOW.getTime() + (i + 1) * 60000).toISOString() }),
  );
  const out = renderBrief(payload({ items: many }), NOW, TZ, { title: "A" });
  const due = sectionOf(out, "DUE IN 48H");
  assert.equal(due.length, DUE_CAP + 1);
  assert.equal(due[DUE_CAP], "  ... and 5 more");
});

test("the busiest possible day still ends with the closing marker", () => {
  const soon = (n) => new Date(NOW.getTime() + n * 60000).toISOString();
  const past = (n) => new Date(NOW.getTime() - n * 3600000).toISOString();
  const out = renderBrief(
    payload({
      items: [
        ...Array.from({ length: 40 }, (_, i) => item({ k: `1::homework::a${i}`, t: `Due ${i}`, d: soon(i + 1) })),
        ...Array.from({ length: 40 }, (_, i) => item({ k: `1::homework::b${i}`, t: `Late ${i}`, d: past(i + 1) })),
      ],
      focus: [{
        d: TODAY,
        note: "a note on the busiest day there is",
        blocks: Array.from({ length: 30 }, (_, i) => ({ c: "MATH 210", what: `Block ${i}`, t: "16:00", mins: 30 })),
      }],
      meetings: Array.from({ length: 30 }, (_, i) => ({
        k: `cal|m${i}|1`, feed: "cal", lbl: "Work", t: `Meeting ${i}`,
        s: `2026-09-04T${String(9 + (i % 12)).padStart(2, "0")}:00:00.000Z`,
        e: `2026-09-04T${String(10 + (i % 12)).padStart(2, "0")}:00:00.000Z`,
        ad: false, free: false,
      })),
    }),
    NOW, TZ, { title: "A" },
  );
  const all = lines(out);
  assert.ok(all.length <= MAX_LINES, `${all.length} lines`);
  assert.equal(all[all.length - 1], CLOSE_MARK, "the phone must always be able to tell it has the whole brief");
  assert.ok(out.includes("NOTE  a note on the busiest day there is"));
});

test("every line is at most MAX_COLS columns, on the busiest day and the emptiest", () => {
  const long = "x".repeat(400);
  const out = renderBrief(
    payload({
      items: [item({ t: long })],
      focus: [{ d: TODAY, blocks: [{ c: long, what: long, why: long, t: "16:00", mins: 60 }], note: long }],
      meetings: [{ k: "cal|a|1", feed: "cal", lbl: long, t: long, loc: long, s: "2026-09-03T19:00:00.000Z", e: "2026-09-03T20:00:00.000Z", ad: false, free: false }],
    }),
    NOW, TZ, { title: long },
  );
  for (const l of lines(out)) assert.ok(l.length <= MAX_COLS, `${l.length}: ${l}`);
});

/* ------------------------------------------------------------- ASCII */

test("whatever goes in, every byte that comes out is printable ASCII", () => {
  const nasty = "Problème — “résumé” … → 🚀\ttab\nnewline";
  const out = renderBrief(
    payload({
      items: [item({ t: nasty, c: nasty })],
      focus: [{ d: TODAY, blocks: [{ c: nasty, what: nasty, t: "16:00", mins: 60 }], note: nasty }],
      meetings: [{ k: "cal|a|1", feed: "cal", lbl: nasty, t: nasty, loc: nasty, s: "2026-09-03T19:00:00.000Z", e: "2026-09-03T20:00:00.000Z", ad: false, free: false }],
      scrapedAt: "2026-09-03T18:05:00.000Z",
    }),
    NOW, TZ, { title: nasty },
  );
  for (const ch of out) {
    if (ch === "\n") continue;
    const code = ch.codePointAt(0);
    assert.ok(code >= 0x20 && code <= 0x7e, `non-ASCII ${JSON.stringify(ch)} survived`);
  }
  // The map covers the characters with an OBVIOUS ASCII spelling - curly quotes,
  // the dash family, the ellipsis. An accented letter has no such spelling, so it
  // is dropped rather than guessed at: "resume" and "resume" are different words
  // and a transliteration that invents one is worse than a gap.
  assert.ok(out.includes('"rsum"'), `curly quotes became straight ones:
${out}`);
  assert.ok(out.includes("Problme -"), "the em dash became a hyphen");
});

test("toAscii, truncate, clip and finishLine do exactly one job each", () => {
  assert.equal(toAscii("  a—b  \n c "), "a-b c");
  assert.equal(toAscii(null), "");
  assert.equal(truncate("abcdef", 4), "a...");
  assert.equal(truncate("abcdef", 3), "abc", "under four columns there is no room for an ellipsis");
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("abc", 0), "");
  assert.equal(clip("a—b", 2), "a-");
  // finishLine keeps padding - by then the spaces ARE the layout
  assert.equal(finishLine("a    b"), "a    b");
  assert.equal(finishLine("ab\nc"), "abc");
  assert.equal(finishLine("x".repeat(200)).length, MAX_COLS);
});

test("byCode orders by codepoint, never by the host's collation", () => {
  assert.equal(byCode("A", "a"), -1);
  assert.equal(byCode("a", "a"), 0);
  assert.equal(byCode("b", "a"), 1);
});

test("closedKeys reads state, never via, so a malformed entry cannot do harm", () => {
  const k = closedKeys([
    { k: "a", state: "done" },
    { k: "b", state: "cancelled" },
    { k: "c", state: "cleared" },
    { k: "d" },
    null,
    { state: "done" },
  ]);
  assert.deepEqual([...k].sort(), ["a", "b", "d"]);
  assert.deepEqual([...closedKeys(null)], []);
});

test("stampOf falls back to a UTC instant rather than throwing on an unusable zone", () => {
  assert.match(stampOf(NOW, "Mars/Olympus"), /^2026-09-03 18:10 UTC$/);
});

/* ------------------------------------------------------ reproducibility */

test("the same payload and the same clock produce byte-identical briefs", () => {
  const p = payload({
    items: [item(), item({ k: "1::quiz::q", t: "Quiz 1", ty: "quiz" })],
    focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Finish HW 1", t: "16:00", mins: 90 }] }],
  });
  assert.equal(renderBrief(p, NOW, TZ, { title: "A" }), renderBrief(p, NOW, TZ, { title: "A" }));
});

test("renderBrief never mutates the payload it was handed", () => {
  const p = payload({ items: [item()], focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "x", t: "16:00", mins: 60 }] }] });
  const before = JSON.stringify(p);
  renderBrief(p, NOW, TZ, { title: "A" });
  assert.equal(JSON.stringify(p), before);
});
