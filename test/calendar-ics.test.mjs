// The ICS calendar sink - the one every Mac and Linux user actually gets.
//
// A calendar file is a wire format read by other people's software, so the
// things that matter are the things a human eye slides over: CRLF line endings,
// 75-octet folding, escaped semicolons, and UIDs that do not move between runs.
// Get the last one wrong and every import duplicates every event, which is how
// a user ends up deleting the calendar and the feature with it.
//
// It also has to agree with the Outlook sink about WHICH items deserve an event
// and WHEN the alarm fires, because a user may run both. Both sinks read those
// answers from src/lib/calendar-items.mjs and the tests below check the outcome
// rather than the plumbing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, derive } from "../src/lib/config.mjs";
import { REMINDER_MINUTES } from "../src/lib/calendar-items.mjs";
import * as ics from "../src/connectors/calendar-ics.mjs";

const NOW = new Date("2026-09-14T13:00:00.000Z");

const cfg = {
  ...DEFAULTS,
  timezone: "America/New_York",
  title: "Weekly Agenda",
  institution: { ...DEFAULTS.institution, name: "Example University" },
  courses: [
    { id: 110001, code: "PHYS 221" },
    { id: 110002, code: "MATH 210" },
    { id: 110006, code: "SEM 100", skip: true },
  ],
  artifact: { url: "https://claude.ai/public/artifacts/example" },
  connectors: {
    ...DEFAULTS.connectors,
    calendar: { ...DEFAULTS.connectors.calendar, ics: { enabled: true, path: "data/agenda.ics" } },
  },
};

const item = (over = {}) => ({
  courseId: 110002,
  course: "MATH 210",
  title: "Homework 3",
  due: "2026-09-16T03:59:00.000Z",
  type: "homework",
  submitted: null,
  approx: false,
  sources: ["canvas"],
  url: "https://canvas.example.edu/courses/110002/assignments/900101",
  ...over,
});

/** A scratch data directory holding one snapshot, plus the ctx a sink receives. */
function withData(items) {
  const dir = mkdtempSync(join(tmpdir(), "agenda-ics-"));
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "latest.json"), JSON.stringify({ scrapedAt: NOW.toISOString(), items, errors: [] }));
  const out = join(dir, "out", "agenda.ics");
  const scoped = {
    ...cfg,
    connectors: { ...cfg.connectors, calendar: { ...cfg.connectors.calendar, ics: { enabled: true, path: out } } },
  };
  const logs = [];
  return {
    dir,
    out,
    ctx: {
      cfg: scoped,
      derived: derive(scoped),
      now: NOW,
      root: dir,
      dataDir: dir,
      deadline: Date.now() + 60000,
      log: (level, msg) => logs.push(msg),
    },
    logs,
    read: () => readFileSync(out, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// The syntax pieces
// ---------------------------------------------------------------------------

test("escapeText escapes exactly what RFC 5545 requires, backslash first", () => {
  assert.equal(ics.escapeText("a;b,c\\d"), "a\\;b\\,c\\\\d");
  assert.equal(ics.escapeText("line one\nline two"), "line one\\nline two");
  assert.equal(ics.escapeText("curly ’ quote"), "curly ' quote");
});

test("foldLine folds at 75 octets and continues with one leading space", () => {
  const long = `DESCRIPTION:${"x".repeat(200)}`;
  const folded = ics.foldLine(long).split("\r\n");
  assert.equal(folded[0].length, 75);
  for (const cont of folded.slice(1)) {
    assert.ok(cont.startsWith(" "), "a continuation line must begin with a space");
    assert.ok(cont.length <= 75);
  }
  assert.equal(folded.join("\r\n").replace(/\r\n /g, ""), long, "unfolding must give the original line back");
  assert.equal(ics.foldLine("SHORT:line"), "SHORT:line");
});

test("icsDate writes UTC basic format, so no VTIMEZONE has to ship", () => {
  assert.equal(ics.icsDate("2026-09-16T03:59:00.000Z"), "20260916T035900Z");
});

test("uidFor is deterministic, namespaced, and leaks no course code", () => {
  const a = ics.uidFor("110002::homework::homework 3", "main", "agenda");
  assert.equal(a, ics.uidFor("110002::homework::homework 3", "main", "agenda"));
  assert.notEqual(a, ics.uidFor("110002::homework::homework 3", "prep", "agenda"));
  assert.notEqual(a, ics.uidFor("110002::homework::homework 4", "main", "agenda"));
  assert.match(a, /^[0-9a-f]{20}-main@agenda\.agenda\.local$/);
  assert.ok(!/math|homework/i.test(a));
});

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

test("publish writes one well-formed VCALENDAR", async () => {
  const t = withData([item()]);
  const r = await ics.publish(t.ctx);
  const text = t.read();
  assert.deepEqual({ written: r.written, updated: r.updated, removed: r.removed, errors: r.errors }, {
    written: 1,
    updated: 0,
    removed: 0,
    errors: [],
  });
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(text.trimEnd().endsWith("END:VCALENDAR"));
  assert.match(text, /VERSION:2\.0/);
  assert.match(text, /PRODID:-\/\/agenda\/\/agenda\/\/EN/);
  assert.match(text, /X-WR-CALNAME:Weekly Agenda - Example University/);
  assert.match(text, /X-WR-TIMEZONE:America\/New_York/);
  assert.equal(text.split("\n").every((l) => l === "" || l.endsWith("\r")), true, "every line ends CRLF");
  t.cleanup();
});

test("the file is pure ASCII, so no client has to guess an encoding", async () => {
  const t = withData([item({ title: "Café — “read” ch. 3" })]);
  await ics.publish(t.ctx);
  const text = t.read();
  assert.ok([...text].every((c) => c.charCodeAt(0) < 128));
  assert.match(text, /SUMMARY:MATH 210: Caf - "read" ch\. 3 due/);
  t.cleanup();
});

test("a deadline item ends at the due time and carries the documented reminder", async () => {
  const t = withData([item()]);
  await ics.publish(t.ctx);
  const text = t.read();
  assert.match(text, /DTEND:20260916T035900Z/);
  assert.match(text, /DTSTART:20260916T032900Z/, "a 30-minute block that ENDS at the deadline");
  assert.match(text, new RegExp(`TRIGGER:-PT${REMINDER_MINUTES.homework}M`));
  assert.match(text, /TRANSP:TRANSPARENT/, "a deadline does not make you busy");
  t.cleanup();
});

test("an exam starts at the exam time, blocks the slot, and gets the 3-days-out study nudge", async () => {
  const t = withData([item({ title: "Midterm Exam 1", type: "exam", due: "2026-09-24T18:30:00.000Z", courseId: 110001, course: "PHYS 221" })]);
  const r = await ics.publish(t.ctx);
  const text = t.read();
  assert.equal(r.written, 2, "the exam and its prep block");
  assert.match(text, /DTSTART:20260924T183000Z/);
  assert.match(text, /TRANSP:OPAQUE/);
  assert.match(text, new RegExp(`TRIGGER:-PT${REMINDER_MINUTES.exam}M`));
  assert.match(text, /SUMMARY:PHYS 221: study for Midterm Exam 1 \(3 days out\)/);
  assert.match(text, /DTSTART:20260921T183000Z/, "72 hours before");
  t.cleanup();
});

test("an exam whose prep window has already passed gets no orphan study block", async () => {
  const t = withData([item({ title: "Midterm Exam 1", type: "exam", due: "2026-09-15T18:30:00.000Z" })]);
  const r = await ics.publish(t.ctx);
  assert.equal(r.written, 1);
  assert.ok(!t.read().includes("study for"));
  t.cleanup();
});

test("submitted, past, skipped and far-future items are all left out", async () => {
  const t = withData([
    item({ title: "Done already", submitted: true }),
    item({ title: "Yesterday", due: "2026-09-13T03:59:00.000Z" }),
    item({ title: "Seminar chore", courseId: 110006, course: "SEM 100" }),
    item({ title: "Next term", due: "2026-11-30T03:59:00.000Z" }),
    item({ title: "Homework 3" }),
  ]);
  const r = await ics.publish(t.ctx);
  const text = t.read();
  assert.equal(r.written, 1);
  assert.match(text, /SUMMARY:MATH 210: Homework 3 due/);
  for (const gone of ["Done already", "Yesterday", "Seminar chore", "Next term"]) {
    assert.ok(!text.includes(gone), `${gone} must not reach the calendar`);
  }
  t.cleanup();
});

test("the description carries the link, the agenda url and the source, escaped", async () => {
  const t = withData([item()]);
  await ics.publish(t.ctx);
  const unfolded = t.read().replace(/\r\n /g, "");
  assert.match(unfolded, /DESCRIPTION:MATH 210 - Homework 3\\nDue: /);
  assert.match(unfolded, /Type: homework \| Source: canvas/);
  assert.match(unfolded, /Agenda: https:\/\/claude\.ai\/public\/artifacts\/example/);
  t.cleanup();
});

test("two runs over the same data produce the same UIDs, so a re-import updates", async () => {
  const t = withData([item()]);
  await ics.publish(t.ctx);
  const first = t.read();
  const second = await ics.publish(t.ctx);
  assert.deepEqual({ w: second.written, u: second.updated, r: second.removed }, { w: 0, u: 0, r: 0 });
  assert.equal(t.read(), first, "an unchanged calendar is not rewritten");
  t.cleanup();
});

test("a changed deadline updates the same UID instead of adding a second event", async () => {
  const t = withData([item()]);
  await ics.publish(t.ctx);
  const before = ics.uidsIn(t.read());
  writeFileSync(
    join(t.dir, "latest.json"),
    JSON.stringify({ items: [item({ due: "2026-09-17T03:59:00.000Z" })] }),
  );
  const r = await ics.publish(t.ctx);
  assert.deepEqual({ w: r.written, u: r.updated, r: r.removed }, { w: 0, u: 1, r: 0 });
  assert.deepEqual([...ics.uidsIn(t.read())], [...before]);
  assert.match(t.read(), /DTEND:20260917T035900Z/);
  t.cleanup();
});

test("an item that disappears is reported as removed and leaves no event behind", async () => {
  const t = withData([item(), item({ title: "Homework 4", due: "2026-09-18T03:59:00.000Z" })]);
  await ics.publish(t.ctx);
  writeFileSync(join(t.dir, "latest.json"), JSON.stringify({ items: [item()] }));
  const r = await ics.publish(t.ctx);
  assert.equal(r.removed, 1);
  assert.ok(!t.read().includes("Homework 4"));
  t.cleanup();
});

test("several rows for one deadline collapse to the earliest, exactly as the Outlook sink does", async () => {
  const t = withData([
    item({ due: "2026-09-16T03:59:00.000Z" }),
    item({ due: "2026-09-18T03:59:00.000Z", sources: ["canvas", "calendar"] }),
  ]);
  const r = await ics.publish(t.ctx);
  assert.equal(r.written, 1, "one item is one event");
  assert.match(t.read(), /DTEND:20260916T035900Z/);
  t.cleanup();
});

test("a missing snapshot is one errors[] line, never a thrown run", async () => {
  const t = withData([item()]);
  rmSync(join(t.dir, "latest.json"));
  const r = await ics.publish(t.ctx);
  assert.equal(r.written, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /calendar-ics: items file not found/);
  t.cleanup();
});

test("the runaway guard refuses to write a calendar nobody asked for", async () => {
  const many = Array.from({ length: ics.DEFAULTS.maxEvents + 1 }, (_, i) =>
    item({ title: `Task ${i}`, due: "2026-09-16T03:59:00.000Z" }),
  );
  const t = withData(many);
  const r = await ics.publish(t.ctx);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /refusing to write/);
  t.cleanup();
});

test("healthCheck says what will happen and never writes the calendar", async () => {
  const t = withData([item()]);
  const r = await ics.healthCheck(t.ctx);
  assert.equal(r.ok, true);
  assert.match(r.detail, /will be created/);
  t.cleanup();
});

test("healthCheck refuses to pretend it is ready before the first scrape", async () => {
  const t = withData([item()]);
  rmSync(join(t.dir, "latest.json"));
  const r = await ics.healthCheck(t.ctx);
  assert.equal(r.ok, false);
  assert.match(r.fix, /scrape\.mjs/);
  t.cleanup();
});

test("settingsOf falls back to the documented default path", () => {
  const s = ics.settingsOf({ ...cfg, connectors: { ...cfg.connectors, calendar: { ics: {} } } });
  assert.equal(s.path, "data/agenda.ics");
  const root = mkdtempSync(join(tmpdir(), "agenda-ics-root-"));
  assert.equal(ics.resolveIcsPath("data/agenda.ics", root), join(root, "data", "agenda.ics"));
  assert.equal(ics.resolveIcsPath(join(root, "elsewhere.ics"), root), join(root, "elsewhere.ics"));
  rmSync(root, { recursive: true, force: true });
});
