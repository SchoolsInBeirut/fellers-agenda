/* `src/lib/ics-parse.mjs`: RFC 5545 text in, flat instance entries out. PURE, so
 * every test here is a function call - no temp directory, no subprocess, no
 * socket. The connector around it is `test/gcal-sync.test.mjs`'s problem.
 *
 * The instances this module yields are in the hand-transcribed shape
 * `gcal-normalize.mjs` already normalizes, so the assertions below are about
 * `start`/`end`/`allDay` and never about `k`, `s`, `e` or the 300-character
 * description trim - those belong to the normalizer and are pinned in
 * `test/gcal-normalize.test.mjs` once, for both inbound routes.
 *
 * The DST case is the one that would be silently wrong without a test: a weekly
 * 13:30 America/New_York meeting is 17:30Z in October and 18:30Z in November.
 * Anything that adds seven times 86,400,000 ms passes every other test in this
 * file and gets that one wrong by an hour, twice a year, for six months.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { dayNumOf } from "../src/lib/civil-time.mjs";
import {
  buildInstances,
  parseComponents,
  parseDateValue,
  parseDuration,
  parseFeed,
  parseLine,
  unescapeText,
  unfoldLines,
  untilLimit,
} from "../src/lib/ics-parse.mjs";
import { parseRRule } from "../src/lib/ics-rrule.mjs";

const CRLF = "\r\n";
const ics = (...lines) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", ...lines.flat(), "END:VCALENDAR"].join(CRLF) + CRLF;
const vevent = (...lines) => ["BEGIN:VEVENT", ...lines.flat(), "END:VEVENT"];

const TZ = "America/New_York";
const FROM = "2026-09-01";
const TO = "2026-09-30";

const build = (text, o = {}) => parseFeed(text, { tz: TZ, from: FROM, to: TO, ...o });
const startsOf = (text, o = {}) => build(text, o).instances.map((e) => e.start);
const daysOf = (text, o = {}) => startsOf(text, o).map((s) => s.slice(0, 10));

// ============================================================= line syntax

test("unfolds continuation lines that start with a space, in a CRLF file", () => {
  // RFC 5545 3.1: the fold character itself is removed and NOTHING else, so
  // "  planning" contributes " planning" and " the" contributes "the".
  const lines = unfoldLines("SUMMARY:Sprint\r\n  planning with\r\n  the team\r\nUID:a\r\n");
  assert.equal(lines[0], "SUMMARY:Sprint planning with the team");
  assert.equal(lines[1], "UID:a");
  assert.equal(unfoldLines("A:one\r\n two\r\n")[0], "A:onetwo");
});

test("unfolds tab continuations, and reads an LF-only file", () => {
  const lines = unfoldLines("DESCRIPTION:one\n\ttwo\nUID:b\n");
  assert.equal(lines[0], "DESCRIPTION:onetwo");
  assert.equal(lines[1], "UID:b");
});

test("parseLine splits name, parameters and value, and keeps a colon in the value", () => {
  const p = parseLine("DTSTART;TZID=America/New_York;VALUE=DATE-TIME:20260904T130000");
  assert.equal(p.name, "DTSTART");
  assert.equal(p.params.TZID, "America/New_York");
  assert.equal(p.params.VALUE, "DATE-TIME");
  assert.equal(p.value, "20260904T130000");
  assert.equal(parseLine("URL:https://example.test/a?b=1").value, "https://example.test/a?b=1");
  // a quoted parameter value may itself contain the separators
  const q = parseLine('ATTENDEE;CN="Doe; Jane: chair":mailto:jane@example.test');
  assert.equal(q.params.CN, "Doe; Jane: chair");
  assert.equal(q.value, "mailto:jane@example.test");
  assert.equal(parseLine("no-colon-here"), null);
  assert.equal(parseLine(""), null);
});

test("text escapes: backslash-comma, -semicolon, -n, -N and -backslash", () => {
  assert.equal(unescapeText("a\\, b\\; c\\nd\\Ne\\\\f"), "a, b; c\nd\ne\\f");
  assert.equal(unescapeText(""), "");
  assert.equal(unescapeText("trailing\\"), "trailing\\");
});

test("SUMMARY and LOCATION are flattened - no raw newline reaches a record", () => {
  const [e] = build(
    ics(
      vevent(
        "UID:flat@t",
        "DTSTART:20260907T140000Z",
        "SUMMARY:Design review\\, part 2\\; bring the deck\\n",
        " and the \\\\budget\\\\ notes",
        "LOCATION:Room 9\\nSecond floor",
      ),
    ),
  ).instances;
  assert.equal(e.title, "Design review, part 2; bring the deck and the \\budget\\ notes");
  assert.equal(e.location, "Room 9 Second floor");
  assert.equal(/[\r\n]/.test(e.title), false, "no raw newline may reach a meeting title");
  assert.equal(/[\r\n]/.test(e.location), false, "nor a location");
});

// ================================================================== zones

test("VTIMEZONE blocks give up their TZID name and nothing else", () => {
  const text = ics(
    ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:DAYLIGHT", "TZNAME:EDT", "TZOFFSETTO:-0400", "END:DAYLIGHT", "END:VTIMEZONE"],
    vevent("UID:a@t", "DTSTART;TZID=America/New_York:20260904T130000", "SUMMARY:X"),
  );
  const { vevents, tzids } = parseComponents(text);
  assert.deepEqual(tzids, ["America/New_York"]);
  assert.equal(vevents.length, 1);
});

test("an unknown TZID falls back to the declared pipeline zone and says so", () => {
  const { instances, warnings } = build(ics(vevent("UID:tz@t", "DTSTART;TZID=Mars/Olympus:20260904T130000", "SUMMARY:X")));
  assert.equal(instances.length, 1);
  assert.equal(instances[0].start, "2026-09-04T17:00:00.000Z", "13:00 in the pipeline zone (EDT) is 17:00Z");
  assert.ok(
    warnings.some((w) => w.includes("Mars/Olympus") && w.includes(TZ)),
    `expected a TZID warning, got ${JSON.stringify(warnings)}`,
  );
});

test("DST: a weekly 13:30 TZID meeting is 17:30Z on 2026-10-29 and 18:30Z on 2026-11-03", () => {
  const text = ics(
    vevent(
      "UID:dst@t",
      "DTSTART;TZID=America/New_York:20261027T133000",
      "DTEND;TZID=America/New_York:20261027T143000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU,TH",
      "SUMMARY:Standup",
    ),
  );
  const { instances } = build(text, { from: "2026-10-26", to: "2026-11-05" });
  const starts = instances.map((e) => e.start);
  assert.ok(starts.includes("2026-10-29T17:30:00.000Z"), `EDT instance missing: ${JSON.stringify(starts)}`);
  assert.ok(starts.includes("2026-11-03T18:30:00.000Z"), `EST instance missing: ${JSON.stringify(starts)}`);
  const nov = instances.find((e) => e.start === "2026-11-03T18:30:00.000Z");
  assert.equal(nov.end, "2026-11-03T19:30:00.000Z", "and the duration survives the transition");
});

test("a UTC DTSTART is taken as written, and a floating one is read in the pipeline zone", () => {
  const utc = build(ics(vevent("UID:z@t", "DTSTART:20260904T190000Z", "DTEND:20260904T200000Z", "SUMMARY:X"))).instances[0];
  assert.equal(utc.start, "2026-09-04T19:00:00.000Z");
  assert.equal(utc.end, "2026-09-04T20:00:00.000Z");
  const floating = build(ics(vevent("UID:f@t", "DTSTART:20260904T130000", "DTEND:20260904T140000", "SUMMARY:X"))).instances[0];
  assert.equal(floating.start, "2026-09-04T17:00:00.000Z");
});

test("parseDateValue reads the DATE, UTC and TZID forms and refuses anything else", () => {
  assert.deepEqual(parseDateValue("20260910"), { allDay: true, dayNum: dayNumOf(2026, 9, 10), day: "2026-09-10" });
  // an 8-digit value is a DATE whether or not VALUE=DATE was written out
  assert.equal(parseDateValue("20260910", { VALUE: "DATE-TIME" }).allDay, true);
  assert.equal(parseDateValue("20260904T190000Z").ms, Date.parse("2026-09-04T19:00:00Z"));
  assert.equal(parseDateValue("20260904T130000", { TZID: TZ }).ms, Date.parse("2026-09-04T17:00:00Z"));
  assert.equal(parseDateValue("20260904T130000", { TZID: "Mars/Olympus" }, TZ).unknownTzid, "Mars/Olympus");
  assert.equal(parseDateValue("not-a-date"), null);
  assert.equal(parseDateValue(""), null);
});

// =============================================================== durations

test("VALUE=DATE is all-day and DTEND is EXCLUSIVE", () => {
  const [e] = build(
    ics(vevent("UID:ad@t", "DTSTART;VALUE=DATE:20260910", "DTEND;VALUE=DATE:20260912", "SUMMARY:Investor offsite")),
  ).instances;
  assert.equal(e.allDay, true);
  assert.equal(e.start, "2026-09-10");
  assert.equal(e.end, "2026-09-12");
});

test("a one-day all-day event with no DTEND still ends on the next day", () => {
  const [e] = build(ics(vevent("UID:ad1@t", "DTSTART;VALUE=DATE:20260910", "SUMMARY:Holiday"))).instances;
  assert.equal(e.start, "2026-09-10");
  assert.equal(e.end, "2026-09-11", "an exclusive end defaulted to the start would be a zero-length day");
});

test("DURATION replaces DTEND, for timed (PT1H30M) and all-day (P2D) alike", () => {
  assert.equal(parseDuration("PT1H30M"), 90 * 60000);
  assert.equal(parseDuration("P1D"), 1440 * 60000);
  assert.equal(parseDuration("P1W"), 7 * 1440 * 60000);
  assert.equal(parseDuration("nonsense"), null);
  assert.equal(parseDuration("P"), null);
  const timed = build(ics(vevent("UID:d1@t", "DTSTART:20260904T190000Z", "DURATION:PT1H30M", "SUMMARY:X"))).instances[0];
  assert.equal(timed.end, "2026-09-04T20:30:00.000Z");
  const allDay = build(ics(vevent("UID:d2@t", "DTSTART;VALUE=DATE:20260910", "DURATION:P2D", "SUMMARY:X"))).instances[0];
  assert.equal(allDay.start, "2026-09-10");
  assert.equal(allDay.end, "2026-09-12");
});

test("no DTEND and no DURATION: 60 minutes for a timed event", () => {
  assert.equal(build(ics(vevent("UID:nd@t", "DTSTART:20260904T190000Z", "SUMMARY:X"))).instances[0].end, "2026-09-04T20:00:00.000Z");
});

// ============================================================== recurrence

test("RRULE COUNT, INTERVAL and BYDAY reach the expander intact", () => {
  assert.deepEqual(daysOf(ics(vevent("UID:r1@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:X"))), [
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
  ]);
  assert.deepEqual(
    daysOf(
      ics(
        vevent(
          "UID:r2@t",
          "DTSTART:20260907T140000Z",
          "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;UNTIL=20260924T000000Z",
          "SUMMARY:X",
        ),
      ),
    ),
    ["2026-09-07", "2026-09-09", "2026-09-21", "2026-09-23"],
  );
});

test("an unsupported RRULE part keeps the FIRST instance only and warns with the UID prefix", () => {
  const { instances, warnings } = build(
    ics(vevent("UID:abcdef0123456789@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=DAILY;BYSETPOS=1", "SUMMARY:X")),
  );
  assert.equal(instances.length, 1);
  assert.equal(instances[0].start.slice(0, 10), "2026-09-07");
  const w = warnings.find((x) => x.includes("BYSETPOS"));
  assert.ok(w, `expected a BYSETPOS warning, got ${JSON.stringify(warnings)}`);
  assert.ok(w.includes("abcdef01"), `the warning should name the uid prefix: ${w}`);
  assert.equal(w.includes("abcdef012"), false, `and must not spill past 8 uid characters: ${w}`);
});

test("stopping on the candidate bound is reported, never silent", () => {
  const { warnings } = build(ics(vevent("UID:bounded1@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=32", "SUMMARY:X")));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("candidate bound"), warnings[0]);
});

test("UNTIL on a TIMED series is an instant, not a calendar day", () => {
  // Exporters write UNTIL as a UTC timestamp derived from the LOCAL end of day,
  // so comparing by UTC date emits one phantom instance the day after the series
  // ends - and a phantom meeting becomes phantom busy time in the planner.
  assert.deepEqual(
    daysOf(ics(vevent("UID:u1@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=DAILY;UNTIL=20260909T100000Z", "SUMMARY:X"))),
    ["2026-09-07", "2026-09-08"],
    "Sep 9 at 14:00Z is after UNTIL 10:00Z",
  );
  assert.deepEqual(
    startsOf(
      ics(
        vevent("UID:u2@t", "DTSTART;TZID=America/New_York:20261005T110000", "RRULE:FREQ=DAILY;UNTIL=20261006T035959Z", "SUMMARY:X"),
      ),
      { from: "2026-10-01", to: "2026-10-31" },
    ),
    ["2026-10-05T15:00:00.000Z"],
    "the shape a real exporter ships",
  );
  assert.deepEqual(untilLimit(parseRRule("FREQ=DAILY;UNTIL=20260909"), "UTC"), { dayNum: dayNumOf(2026, 9, 9), ms: null });
});

test("an all-day series still compares UNTIL by day, inclusively", () => {
  assert.deepEqual(
    startsOf(ics(vevent("UID:u3@t", "DTSTART;VALUE=DATE:20260907", "RRULE:FREQ=DAILY;UNTIL=20260909", "SUMMARY:X"))),
    ["2026-09-07", "2026-09-08", "2026-09-09"],
  );
});

test("EXDATE removes instances - many lines, many values, TZID and DATE forms", () => {
  assert.deepEqual(
    daysOf(
      ics(
        vevent(
          "UID:ex1@t",
          "DTSTART;TZID=America/New_York:20260907T100000",
          "RRULE:FREQ=DAILY;COUNT=5",
          "EXDATE;TZID=America/New_York:20260908T100000,20260909T100000",
          "EXDATE;TZID=America/New_York:20260910T100000",
          "SUMMARY:X",
        ),
      ),
    ),
    ["2026-09-07", "2026-09-11"],
  );
  assert.deepEqual(
    startsOf(
      ics(
        vevent("UID:ex2@t", "DTSTART;VALUE=DATE:20260907", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;VALUE=DATE:20260908", "SUMMARY:X"),
      ),
    ),
    ["2026-09-07", "2026-09-09"],
  );
});

test("RDATE adds an instance outside the rule, and UNTIL does not silence it", () => {
  assert.deepEqual(
    daysOf(
      ics(vevent("UID:rd@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=WEEKLY;COUNT=2", "RDATE:20260910T140000Z", "SUMMARY:X")),
    ),
    ["2026-09-07", "2026-09-10", "2026-09-14"],
  );
  // RFC 5545: UNTIL bounds the RULE, not the dates the organiser added by hand.
  assert.deepEqual(
    daysOf(
      ics(
        vevent(
          "UID:u4@t",
          "DTSTART:20260907T140000Z",
          "RRULE:FREQ=DAILY;UNTIL=20260908T100000Z",
          "RDATE:20260915T140000Z",
          "SUMMARY:X",
        ),
      ),
    ),
    ["2026-09-07", "2026-09-15"],
  );
});

test("RECURRENCE-ID replaces one instance of the master (moved and renamed)", () => {
  const { instances } = build(
    ics(
      vevent("UID:ri@t", "DTSTART:20260907T140000Z", "DTEND:20260907T150000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Standup"),
      vevent(
        "UID:ri@t",
        "RECURRENCE-ID:20260908T140000Z",
        "DTSTART:20260908T170000Z",
        "DTEND:20260908T180000Z",
        "SUMMARY:Standup (moved)",
      ),
    ),
  );
  assert.equal(instances.length, 3);
  assert.equal(instances.find((e) => e.title.includes("moved")).start, "2026-09-08T17:00:00.000Z");
  assert.equal(instances.filter((e) => e.start === "2026-09-08T14:00:00.000Z").length, 0);
});

test("RANGE=THISANDFUTURE moves only the named instance, and says so out loud", () => {
  const { instances, warnings } = build(
    ics(
      vevent("UID:tafuture@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=DAILY;COUNT=4", "SUMMARY:Standup"),
      vevent("UID:tafuture@t", "RECURRENCE-ID;RANGE=THISANDFUTURE:20260908T140000Z", "DTSTART:20260908T160000Z", "SUMMARY:Standup MOVED"),
    ),
  );
  assert.equal(instances.length, 4, "the series is intact");
  assert.equal(instances.filter((e) => e.title.includes("MOVED")).length, 1);
  assert.ok(
    warnings.some((w) => w.includes("RANGE=THISANDFUTURE") && w.includes("tafuture")),
    `expected a RANGE warning, got ${JSON.stringify(warnings)}`,
  );
});

test("a cancelled RECURRENCE-ID removes that instance; CANCELLED on the master removes the series", () => {
  assert.deepEqual(
    daysOf(
      ics(
        vevent("UID:rc@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Standup"),
        vevent("UID:rc@t", "RECURRENCE-ID:20260908T140000Z", "DTSTART:20260908T140000Z", "STATUS:CANCELLED", "SUMMARY:Standup"),
      ),
    ),
    ["2026-09-07", "2026-09-09"],
  );
  const { instances } = build(
    ics(
      vevent("UID:c1@t", "DTSTART:20260907T140000Z", "RRULE:FREQ=DAILY;COUNT=5", "STATUS:CANCELLED", "SUMMARY:Gone"),
      vevent("UID:c2@t", "DTSTART:20260907T160000Z", "SUMMARY:Kept"),
    ),
  );
  assert.deepEqual(
    instances.map((e) => e.title),
    ["Kept"],
  );
});

// ================================================== fields, guards, refusals

test("TRANSP:TRANSPARENT marks the event free, and everything else is busy", () => {
  const { instances } = build(
    ics(
      vevent("UID:tr@t", "DTSTART:20260907T140000Z", "TRANSP:TRANSPARENT", "SUMMARY:Out of office"),
      vevent("UID:op@t", "DTSTART:20260907T160000Z", "TRANSP:OPAQUE", "SUMMARY:Real meeting"),
    ),
  );
  assert.equal(instances.find((e) => e.title === "Out of office").free, true);
  assert.equal(instances.find((e) => e.title === "Real meeting").free, false);
});

test("a bare VEVENT gets the documented defaults, and a full one keeps its fields", () => {
  const { instances } = build(
    ics(
      vevent("UID:s1@t", "DTSTART:20260907T140000Z"),
      vevent(
        "UID:s2@t",
        "DTSTART:20260907T150000Z",
        "SUMMARY:Sprint\\, planning",
        "LOCATION:Google Meet\\; room 2",
        "DESCRIPTION:line one\\nline two",
        "URL:https://meet.example.test/abc",
      ),
    ),
  );
  const bare = instances.find((e) => e.id === "s1@t");
  assert.equal(bare.title, "(untitled)");
  assert.equal(bare.location, null);
  assert.equal(bare.description, null);
  assert.equal(bare.url, null);
  assert.equal(bare.free, false);
  const full = instances.find((e) => e.id === "s2@t");
  assert.equal(full.title, "Sprint, planning");
  assert.equal(full.location, "Google Meet; room 2");
  assert.equal(full.description, "line one line two");
  assert.equal(full.url, "https://meet.example.test/abc");
});

test("the loop guard is INJECTED, and a description-only skip is counted out loud", () => {
  // Both rules live in gcal-normalize.mjs so the two inbound routes ask the same
  // question. This module only has to apply the answer - per VEVENT, so a
  // recurring event of ours counts ONCE rather than once per instance.
  const text = ics(
    vevent("UID:mine-1@agenda.local", "DTSTART:20260907T140000Z", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Problem set due"),
    vevent("UID:theirs@t", "DTSTART:20260907T160000Z", "DESCRIPTION:Auto-created by the agenda.", "SUMMARY:Looks like ours"),
    vevent("UID:real@t", "DTSTART:20260907T180000Z", "SUMMARY:Sprint planning"),
  );
  const ownRule = (uid, description) => {
    if (uid.endsWith("@agenda.local")) return "uid";
    if (String(description ?? "").includes("Auto-created by the agenda.")) return "description";
    return null;
  };
  const { instances, skippedOwn, warnings } = build(text, { ownRule });
  assert.deepEqual(
    instances.map((e) => e.title),
    ["Sprint planning"],
  );
  assert.equal(skippedOwn, 2, "a five-instance series of ours is ONE skipped event");
  assert.ok(
    warnings.some((w) => w.includes("description marker only")),
    `a description-only skip can be wrong, so it is never silent: ${JSON.stringify(warnings)}`,
  );
  // and with no guard at all, nothing is skipped
  assert.equal(build(text).skippedOwn, 0);
});

test("a VEVENT with no UID or an unreadable DTSTART is dropped with a warning, not a throw", () => {
  const { instances, warnings } = build(
    ics(
      vevent("DTSTART:20260907T140000Z", "SUMMARY:No uid"),
      vevent("UID:bad@t", "DTSTART:not-a-date", "SUMMARY:Bad start"),
      vevent("UID:nostart@t", "SUMMARY:No DTSTART"),
      vevent("UID:ok@t", "DTSTART:20260907T160000Z", "SUMMARY:Fine"),
    ),
  );
  assert.deepEqual(
    instances.map((e) => e.title),
    ["Fine"],
  );
  assert.equal(warnings.length, 3);
});

test("VTODO, VJOURNAL, VFREEBUSY and VALARM are ignored silently", () => {
  const { instances, warnings } = build(
    ics(
      ["BEGIN:VTODO", "UID:todo@t", "DTSTART:20260907T140000Z", "SUMMARY:A task", "END:VTODO"],
      ["BEGIN:VJOURNAL", "UID:j@t", "SUMMARY:A note", "END:VJOURNAL"],
      ["BEGIN:VFREEBUSY", "UID:fb@t", "END:VFREEBUSY"],
      vevent("UID:ev@t", "DTSTART:20260907T140000Z", "SUMMARY:Real", "BEGIN:VALARM", "TRIGGER:-PT10M", "SUMMARY:Alarm noise", "END:VALARM"),
    ),
  );
  assert.deepEqual(
    instances.map((e) => e.title),
    ["Real"],
  );
  assert.deepEqual(warnings, []);
});

test("a window that is not a window is refused rather than expanded against", () => {
  const out = buildInstances({ vevents: [], tz: TZ, from: "not-a-day", to: TO });
  assert.deepEqual(out.instances, []);
  assert.equal(out.skippedOwn, 0);
  assert.ok(out.warnings[0].includes("bad window"), out.warnings[0]);
});

test("a body that is not a calendar at all yields nothing, quietly", () => {
  const { instances, warnings } = build("<html>sign in to continue</html>");
  assert.deepEqual(instances, []);
  assert.deepEqual(warnings, [], "deciding that this is an outage belongs to the connector, not to the parser");
});
