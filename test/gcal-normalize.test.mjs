/* The pure half of the inbound calendar route.
 *
 * Everything here is a total function, so every test is a call: no temp
 * directories, no subprocesses, no clock. The CLI, the file I/O and the exit
 * codes are `test/gcal-ingest.test.mjs`'s problem.
 *
 * The window used throughout is 2026-09-02..2026-09-24 in America/New_York -
 * the same window `windowFor(2026-09-03)` produces, so a record that passes
 * here passes there.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_SKIP_DESC_MARKER,
  DESC_MAX,
  MAX_INPUT_EVENTS,
  collate,
  decodeGoogleUid,
  inWindowExact,
  instantOf,
  isOwnEvent,
  normalizeApi,
  normalizeSimple,
  ownEventRule,
  parsePoint,
  uidOfApiEvent,
  windowBounds,
} from "../src/connectors/gcal-normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "America/New_York";
const WINDOW = { from: "2026-09-02", to: "2026-09-24" };
const CTX = { feedId: "work", label: "Work", window: WINDOW, tz: TZ, guards: { skipUidSuffix: "@agenda.agenda.local" } };

const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "fixtures", "gcal", name), "utf8"));

const byKey = (events) => Object.fromEntries(events.map((e) => [e.k, e]));
const titles = (events) => events.map((e) => e.t).sort();

/* ------------------------------------------------------------ provider ids */

test("a provider id that is not base32hex-wrapped IS the uid", () => {
  assert.equal(decodeGoogleUid("ev-timed-1"), "ev-timed-1");
  assert.equal(decodeGoogleUid(""), "");
  assert.equal(decodeGoogleUid(null), "");
});

test("an imported event still carries its original UID inside its id", () => {
  // The fixture's own id, so the encoder and this expectation cannot drift.
  const raw = fixture("connector-result.json");
  const imported = raw.events.find((e) => e.id.startsWith("_"));
  assert.equal(decodeGoogleUid(imported.id), "8f2c9d1a4b6e7f012345-main@agenda.agenda.local");
});

test("a base32hex id that decodes to junk is kept verbatim, never guessed at", () => {
  // "vvvvvvvv" decodes to bytes that are not clean text.
  const id = "_vvvvvvvv";
  assert.equal(decodeGoogleUid(id), id);
});

test("iCalUID wins, then the series id, then the event id", () => {
  assert.equal(uidOfApiEvent({ iCalUID: " abc@example.com ", id: "x" }), "abc@example.com");
  assert.equal(uidOfApiEvent({ recurringEventId: "series-1", id: "series-1_2026" }), "series-1");
  assert.equal(uidOfApiEvent({ id: "plain-id" }), "plain-id");
});

/* --------------------------------------------------------- the loop guards */

test("the uid rule is proof and the description rule is a heuristic - and they are told apart", () => {
  const guards = { skipUidSuffix: "@agenda.agenda.local" };
  assert.equal(ownEventRule({}, "x-main@agenda.agenda.local", guards), "uid");
  assert.equal(ownEventRule({ description: `x\n${DEFAULT_SKIP_DESC_MARKER} more` }, "someone-else", guards), "description");
  assert.equal(ownEventRule({ description: "an ordinary meeting" }, "someone-else", guards), null);
  assert.equal(isOwnEvent({}, "x-main@agenda.agenda.local", guards), true);
});

test("an empty uid suffix switches the uid rule off without switching the marker off", () => {
  const guards = { skipUidSuffix: "" };
  assert.equal(ownEventRule({}, "x@agenda.agenda.local", guards), null);
  assert.equal(ownEventRule({ description: DEFAULT_SKIP_DESC_MARKER }, "x", guards), "description");
});

test("a description-only skip is counted and warned about, because it can be wrong", () => {
  const events = [
    {
      id: "real-meeting",
      summary: "Talking about the agenda",
      description: `A colleague pasted an invite: ${DEFAULT_SKIP_DESC_MARKER}`,
      start: { dateTime: "2026-09-04T15:00:00-04:00" },
      end: { dateTime: "2026-09-04T16:00:00-04:00" },
    },
  ];
  const out = normalizeApi(events, CTX);
  assert.equal(out.events.length, 0);
  assert.equal(out.skippedOwn, 1);
  assert.ok(
    out.warnings.some((w) => /skipped by description marker only/.test(w)),
    "a heuristic skip is never silent",
  );
});

test("a uid-rule skip is silent - it is proof, not a guess", () => {
  const events = [
    {
      id: "_71j34oppcgom2d326pijephg64p36d1l5lmm2qbe81gmepbechgisob7cln68o9edhnm6obc",
      summary: "PHYS 221: Problem Set 3 due",
      start: { dateTime: "2026-09-04T23:29:00-04:00" },
      end: { dateTime: "2026-09-04T23:59:00-04:00" },
    },
  ];
  const out = normalizeApi(events, CTX);
  assert.equal(out.skippedOwn, 1);
  assert.deepEqual(out.warnings, []);
});

/* ------------------------------------------------------------------- time */

test("a time with an offset names its own instant", () => {
  assert.equal(instantOf("2026-09-04T15:00:00-04:00", TZ), Date.parse("2026-09-04T19:00:00Z"));
  assert.equal(instantOf("2026-09-04T19:00:00Z", TZ), Date.parse("2026-09-04T19:00:00Z"));
});

test("an offset-less time resolves in the DECLARED zone, never the machine's", () => {
  // 09:30 in New York on 2026-09-05 is 13:30Z (EDT, -4).
  assert.equal(instantOf("2026-09-05T09:30:00", TZ), Date.parse("2026-09-05T13:30:00Z"));
  // The same wall clock in another zone is a different instant, which is the
  // whole point: nothing here may depend on where the machine happens to be.
  assert.equal(instantOf("2026-09-05T09:30:00", "UTC"), Date.parse("2026-09-05T09:30:00Z"));
});

test("parsePoint carries the instant and the zone that resolved it, and refuses a non-date", () => {
  // The instant is the ONE truth about when an event is. A wall clock derived
  // back from it used to ride along in the record; nothing ever read it, and a
  // second spelling of the same fact is a second thing to keep in step.
  const p = parsePoint({ dateTime: "2026-09-05T09:30:00", timeZone: TZ }, "UTC");
  assert.equal(p.allDay, false);
  assert.equal(p.zone, TZ);
  assert.equal(p.ms, Date.parse("2026-09-05T13:30:00Z"));
  assert.deepEqual(Object.keys(p).sort(), ["allDay", "ms", "zone"]);
  assert.equal(parsePoint({ dateTime: "2026-09-05T13:30:00Z" }, null).zone, null, "an offset needed no zone");
  assert.deepEqual(parsePoint({ date: "2026-09-08" }, TZ), { allDay: true, day: "2026-09-08" });
  assert.equal(parsePoint({ date: "not-a-day" }, TZ), null);
  assert.equal(parsePoint({}, TZ), null);
  assert.equal(parsePoint(null, TZ), null);
});

test("an unusable declared zone falls back rather than throwing", () => {
  const p = parsePoint({ dateTime: "2026-09-05T09:30:00", timeZone: "Mars/Olympus" }, TZ);
  assert.equal(p.ms, Date.parse("2026-09-05T13:30:00Z"), "the pipeline zone answered instead");
  // A value carrying a newline is refused on shape before it is asked about.
  const q = parsePoint({ dateTime: "2026-09-05T09:30:00", timeZone: "America/New_York\r\nX:1" }, TZ);
  assert.equal(q.ms, Date.parse("2026-09-05T13:30:00Z"));
});

/* -------------------------------------------------------------- windowing */

test("windowBounds refuses a window that is not two day keys", () => {
  assert.equal(windowBounds({ from: "nope", to: "2026-09-24" }, TZ), null);
  assert.equal(windowBounds(null, TZ), null);
  const b = windowBounds(WINDOW, TZ);
  assert.equal(b.startMs, Date.parse("2026-09-02T04:00:00Z"), "local midnight, in the declared zone");
});

test("a timed record is kept when it OVERLAPS; an all-day one when a day falls in", () => {
  const b = windowBounds(WINDOW, TZ);
  const timed = (s, e) => ({ ad: false, s, e });
  assert.equal(inWindowExact(timed("2026-09-10T12:00:00Z", "2026-09-10T13:00:00Z"), b), true);
  assert.equal(inWindowExact(timed("2026-08-01T12:00:00Z", "2026-08-01T13:00:00Z"), b), false);
  // straddling the front edge counts
  assert.equal(inWindowExact(timed("2026-09-01T20:00:00Z", "2026-09-02T06:00:00Z"), b), true);
  // all-day `e` is EXCLUSIVE
  assert.equal(inWindowExact({ ad: true, s: "2026-09-01", e: "2026-09-02" }, b), false);
  assert.equal(inWindowExact({ ad: true, s: "2026-09-01", e: "2026-09-03" }, b), true);
  assert.equal(inWindowExact({ ad: true, s: "bad", e: "2026-09-03" }, b), false);
});

test("a bad window yields no events and says so, rather than throwing", () => {
  const out = normalizeApi([{ id: "x", start: { date: "2026-09-08" } }], { ...CTX, window: { from: "x", to: "y" } });
  assert.deepEqual(out.events, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /bad window/);
});

/* ----------------------------------------------------- the connector shape */

test("the connector fixture normalizes to exactly the meetings a human would list", () => {
  const out = normalizeApi(fixture("connector-result.json").events, CTX);
  assert.deepEqual(titles(out.events), ["Dentist", "Gym (optional)", "Sprint planning", "Standup", "Team offsite"]);
  assert.equal(out.skippedOwn, 2, "one by uid, one by description marker");
});

test("every field of a timed event lands where the payload expects it", () => {
  const out = normalizeApi(fixture("connector-result.json").events, CTX);
  const m = byKey(out.events)["work|ev-timed-1|2026-09-04T19:00:00.000Z"];
  assert.deepEqual(m, {
    k: "work|ev-timed-1|2026-09-04T19:00:00.000Z",
    feed: "work",
    lbl: "Work",
    t: "Sprint planning",
    s: "2026-09-04T19:00:00.000Z",
    e: "2026-09-04T20:00:00.000Z",
    ad: false,
    loc: "Room 4B",
    desc: "Bring the burndown chart.",
    free: false,
    url: "https://calendar.example.com/event?eid=ev-timed-1",
  });
});

test("attendees, organizers and conference data are NEVER copied", () => {
  const out = normalizeApi(fixture("connector-result.json").events, CTX);
  const json = JSON.stringify(out);
  for (const secret of ["colleague@example.com", "someone.else@example.com", "organizer@example.com", "abc-defg-hij"]) {
    assert.ok(!json.includes(secret), `${secret} reached the output`);
  }
  for (const key of ["attendees", "organizer", "creator", "conferenceData"]) {
    assert.ok(!json.includes(key), `${key} reached the output`);
  }
});

test("all-day events keep the provider's EXCLUSIVE end, and a one-day event gets s+1", () => {
  const out = normalizeApi(fixture("connector-result.json").events, CTX);
  const run = byKey(out.events)["work|ev-allday|2026-09-08"];
  assert.equal(run.ad, true);
  assert.equal(run.s, "2026-09-08");
  assert.equal(run.e, "2026-09-10");
  const one = normalizeApi([{ id: "solo", summary: "Holiday", start: { date: "2026-09-08" } }], CTX);
  assert.equal(one.events[0].e, "2026-09-09");
});

test("transparent means free, cancelled means gone, and an unusable start warns", () => {
  const out = normalizeApi(fixture("connector-result.json").events, CTX);
  assert.equal(byKey(out.events)["work|ev-free|2026-09-06T22:00:00.000Z"].free, true);
  assert.ok(!titles(out.events).includes("Cancelled sync"));
  assert.ok(out.warnings.some((w) => /ev-no-st has no usable start/.test(w)));
});

test("a recurring INSTANCE is keyed by its series, and a recurring MASTER is refused loudly", () => {
  const out = normalizeApi(fixture("connector-result.json").events, CTX);
  const inst = out.events.find((e) => e.t === "Standup");
  assert.equal(inst.k, "work|ev-series|2026-09-07T13:15:00.000Z", "the series id keys every instance");
  assert.ok(!titles(out.events).includes("Weekly review"));
  assert.ok(
    out.warnings.some((w) => /recurring master/.test(w) && /single instances/.test(w)),
    "a master is never silently dropped - the fetch step is told what to ask for",
  );
});

test("an event outside the window never reaches the output", () => {
  const out = normalizeApi(fixture("connector-result.json").events, CTX);
  assert.ok(!titles(out.events).includes("Next quarter kickoff"));
});

test("a warning names an event by eight characters of its id and nothing else", () => {
  const out = normalizeApi(
    [{ id: "abcdefghijklmnop", summary: "A very private title", description: "secret" }],
    CTX,
  );
  const w = out.warnings.join(" ");
  assert.ok(w.includes("abcdefgh"));
  assert.ok(!w.includes("abcdefghi"));
  assert.ok(!w.includes("A very private title"));
  assert.ok(!w.includes("secret"));
});

test("a missing or backwards end becomes the default hour; a missing summary becomes (untitled)", () => {
  const out = normalizeApi(
    [
      { id: "a", start: { dateTime: "2026-09-04T15:00:00-04:00" } },
      { id: "b", summary: "Backwards", start: { dateTime: "2026-09-04T15:00:00-04:00" }, end: { dateTime: "2026-09-04T14:00:00-04:00" } },
    ],
    CTX,
  );
  const m = byKey(out.events);
  assert.equal(m["work|a|2026-09-04T19:00:00.000Z"].t, "(untitled)");
  assert.equal(m["work|a|2026-09-04T19:00:00.000Z"].e, "2026-09-04T20:00:00.000Z");
  assert.equal(m["work|b|2026-09-04T19:00:00.000Z"].e, "2026-09-04T20:00:00.000Z");
});

test("a description is flattened to one line and clipped to DESC_MAX", () => {
  const long = "x".repeat(DESC_MAX + 50);
  const out = normalizeApi(
    [{ id: "a", summary: "T\nwo", location: " a \n b ", description: `line one\nline two ${long}`, start: { dateTime: "2026-09-04T15:00:00-04:00" } }],
    CTX,
  );
  const m = out.events[0];
  assert.equal(m.t, "T wo");
  assert.equal(m.loc, "a b");
  assert.equal(m.desc.length, DESC_MAX);
  assert.ok(!m.desc.includes("\n"));
});

test("a non-object entry is warned about and skipped, and the rest still normalize", () => {
  const out = normalizeApi(
    [null, "nope", { id: "a", summary: "Real", start: { dateTime: "2026-09-04T15:00:00-04:00" } }],
    CTX,
  );
  assert.equal(out.events.length, 1);
  assert.equal(out.warnings.filter((w) => /is not an event object/.test(w)).length, 2);
});

test("input past MAX_INPUT_EVENTS is bounded, with one warning", () => {
  const many = Array.from({ length: MAX_INPUT_EVENTS + 5 }, (_, i) => ({
    id: `e${i}`,
    summary: "x",
    start: { dateTime: "2026-09-04T15:00:00-04:00" },
  }));
  const out = normalizeApi(many, CTX);
  assert.ok(out.warnings.some((w) => /over the 5000-entry input limit/.test(w)));
});

/* -------------------------------------------------- the transcribed shape */

test("the hand-transcribed fixture produces the same record shape", () => {
  const out = normalizeSimple(fixture("transcribed.json").events, CTX);
  assert.deepEqual(titles(out.events), ["Advisor meeting", "No end given", "Optional talk", "Reading day"]);
  const advisor = out.events.find((e) => e.t === "Advisor meeting");
  assert.equal(advisor.k, "work|hand-1|2026-09-04T18:00:00.000Z");
  assert.equal(advisor.loc, "Office 210");
  assert.equal(advisor.url, "https://calendar.example.com/event?eid=hand-1");
  assert.equal(out.events.find((e) => e.t === "Reading day").ad, true);
  assert.equal(out.events.find((e) => e.t === "Optional talk").free, true);
});

test("a transcribed offset-less time means PIPELINE-zone local", () => {
  const out = normalizeSimple([{ id: "a", title: "T", start: "2026-09-05T09:30:00" }], CTX);
  assert.equal(out.events[0].s, "2026-09-05T13:30:00.000Z");
});

test("a transcribed entry with no id, or an unreadable start, is warned about and dropped", () => {
  const out = normalizeSimple(
    [{ title: "no id", start: "2026-09-05T09:30:00" }, { id: "b", title: "bad", start: "yesterday" }],
    CTX,
  );
  assert.deepEqual(out.events, []);
  assert.ok(out.warnings.some((w) => /entry 0 has no id/.test(w)));
  assert.ok(out.warnings.some((w) => /entry 1 \(b\) has an unreadable start/.test(w)));
});

/* ----------------------------------------------------------------- collate */

test("collate dedupes by key keeping the LAST, sorts by start, and reports the cap", () => {
  const rec = (k, s) => ({ k, s, ad: false });
  const { events, warnings } = collate(
    [rec("b", "2026-09-05T00:00:00Z"), rec("a", "2026-09-04T00:00:00Z"), { ...rec("b", "2026-09-05T00:00:00Z"), t: "second" }],
    10,
  );
  assert.deepEqual(events.map((e) => e.k), ["a", "b"]);
  assert.equal(events[1].t, "second", "a duplicate key keeps the last one seen");
  assert.deepEqual(warnings, []);

  const over = collate([rec("a", "1"), rec("b", "2"), rec("c", "3")], 2);
  assert.equal(over.events.length, 2);
  assert.match(over.warnings[0], /dropped 1 event\(s\) over the 2-event cap/);
});

test("normalizing the same input twice gives byte-identical output", () => {
  const raw = fixture("connector-result.json").events;
  assert.equal(JSON.stringify(normalizeApi(raw, CTX)), JSON.stringify(normalizeApi(raw, CTX)));
});

test("normalizing never mutates the input it was handed", () => {
  const raw = fixture("connector-result.json").events;
  const before = JSON.stringify(raw);
  normalizeApi(raw, CTX);
  assert.equal(JSON.stringify(raw), before);
});
