/* The CLI half of the inbound calendar route: arguments, unwrapping, shape
 * detection, the output document, stale tolerance and the exit codes a runbook
 * branches on.
 *
 * The pure normalization is `test/gcal-normalize.test.mjs`'s problem. Every
 * test here runs the real script as a subprocess against a `mkdtemp` directory,
 * because the exit code IS the contract and only a real process has one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EXIT,
  buildOutput,
  contextFromConfig,
  detectShape,
  inWindow,
  parseArgs,
  scrub,
  staleEventsFor,
  summaryLine,
  unwrap,
  windowFor,
} from "../src/connectors/gcal-ingest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "src", "connectors", "gcal-ingest.mjs");
const FIXTURES = join(ROOT, "fixtures", "gcal");
const NOW = "2026-09-03T18:00:00.000Z";
const TZ = "America/New_York";

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "agenda-gcal-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      namespace: "agenda",
      timezone: TZ,
      calendars: { gcal: { enabled: true, feed: "work", label: "Work" } },
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, args, extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--config", join(dir, "config.json"), "--data", dir, "--now", NOW, ...args, ...extra],
    { encoding: "utf-8" },
  );
}

const outputOf = (dir) => JSON.parse(readFileSync(join(dir, "gcal-items.json"), "utf8"));

/* ------------------------------------------------------------------- argv */

test("parseArgs refuses an unknown flag rather than doing the default thing", () => {
  assert.match(parseArgs(["--in", "x", "--wat"]).error, /unknown argument: --wat/);
});

test("--in is required, and a feed id is validated before anything is read", () => {
  assert.match(parseArgs([]).error, /--in is required/);
  assert.match(parseArgs(["--in", "x", "--feed", "Work Calendar"]).error, /bad feed id/);
  assert.equal(parseArgs(["--in", "x", "--feed", "work-2"]).error, null);
});

test('--feed fb is refused: "fb|" is the session key space, not a feed', () => {
  // A meeting key is `<feed>|<uid>|<start>`; a session key is
  // `fb|<day>|<bucket>` and `isSessKey()` is a three-character prefix test.
  // `--feed fb` would mint meeting keys that every consumer reads as sessions.
  const bad = parseArgs(["--in", "x", "--feed", "fb"]);
  assert.match(bad.error, /reserved/);
  assert.match(bad.error, /session/, "the message names the key space it would collide with");
  assert.equal(parseArgs(["--in", "x", "--feed", "fbx"]).error, null, "only the exact id is reserved");
});

test("--feed fb exits 1 rather than writing keys nothing can tell from a session", (t) => {
  const dir = workspace(t);
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json"), "--feed", "fb"]);
  assert.equal(r.status, EXIT.error);
  assert.match(r.stderr, /reserved/);
  assert.equal(existsSync(join(dir, "gcal-items.json")), false);
});

test("a reserved feed id in the config falls back rather than minting session keys", () => {
  // loadConfig refuses this outright; contextFromConfig is the second line, for
  // a caller that built a config object by hand.
  assert.equal(contextFromConfig({ calendars: { gcal: { feed: "fb" } } }, null).feedId, "calendar");
  assert.equal(contextFromConfig({ calendars: { gcal: { feed: "work" } } }, null).feedId, "work");
});

test("--label defaults to the feed id and is clipped", () => {
  assert.equal(parseArgs(["--in", "x", "--feed", "work"]).label, "work");
  assert.equal(parseArgs(["--in", "x", "--label", "y".repeat(60)]).label.length, 24);
});

test("--config and --data pass through without being read as unknown flags", () => {
  const a = parseArgs(["--config", "/tmp/c.json", "--data", "/tmp/d", "--in", "x"]);
  assert.equal(a.error, null);
  assert.equal(a.inPath, "x");
  const b = parseArgs(["--config=/tmp/c.json", "--data=/tmp/d", "--in=x"]);
  assert.equal(b.error, null);
  assert.equal(b.inPath, "x");
});

test("a bad --now is refused: a diagnosis run must not silently use the real clock", () => {
  assert.match(parseArgs(["--in", "x", "--now", "lunchtime"]).error, /bad --now value/);
});

/* -------------------------------------------------------------- unwrapping */

test("one layer is peeled - an MCP envelope or a JSON string - and never two", () => {
  assert.deepEqual(unwrap({ events: [] }).value, { events: [] });
  assert.deepEqual(unwrap('{"events":[]}').value, { events: [] });
  assert.deepEqual(unwrap({ content: [{ type: "text", text: '{"events":[]}' }] }).value, { events: [] });
  // a doubly-wrapped payload is left to detectShape to refuse loudly
  const twice = unwrap({ content: [{ type: "text", text: JSON.stringify({ content: [{ type: "text", text: "{}" }] }) }] });
  assert.deepEqual(Object.keys(twice.value), ["content"]);
});

test("a BOM does not degrade a perfectly good listing", () => {
  assert.deepEqual(unwrap('﻿{"events":[]}').value, { events: [] });
});

test("an unparseable body is reported by LENGTH, never by quoting the calendar", () => {
  const secret = '{"summary":"lunch with dr.private@example.com" ';
  const { value, error } = unwrap(secret);
  assert.equal(value, null);
  assert.match(error, /is not valid JSON \(\d+ characters\)/);
  assert.ok(!error.includes("private@example.com"));
});

test("an envelope with no text part says so", () => {
  assert.match(unwrap({ content: [{ type: "image" }] }).error, /no text part/);
});

/* --------------------------------------------------------- shape detection */

test("the API shape, the transcribed shape and a bare array are told apart", () => {
  assert.equal(detectShape({ events: [{ id: "a", start: { dateTime: "x" } }] }).shape, "api");
  assert.equal(detectShape({ items: [{ id: "a" }] }).shape, "api");
  assert.equal(detectShape([{ id: "a" }]).shape, "api");
  assert.equal(detectShape({ events: [{ id: "a", title: "T", start: "2026-09-04T10:00:00Z" }] }).shape, "simple");
});

test("anything that is not a listing reports its KEY NAMES and no values", () => {
  const s = detectShape({ error: "unauthorized", detail: "token expired for user@example.com" });
  assert.equal(s.shape, null);
  assert.deepEqual(s.keys, ["detail", "error"]);
  assert.equal(detectShape("nope").shape, null);
  assert.equal(detectShape(null).shape, null);
});

/* ------------------------------------------------------------------ window */

test("the window is local days [today-1, today+21]", () => {
  assert.deepEqual(windowFor(new Date(NOW), TZ), { from: "2026-09-02", to: "2026-09-24" });
  // 20:00 in New York on the 3rd is the 4th in UTC - the local day is what counts
  assert.deepEqual(windowFor(new Date("2026-09-04T00:30:00Z"), TZ), { from: "2026-09-02", to: "2026-09-24" });
});

test("inWindow is the coarse test used only on inherited records", () => {
  const w = { from: "2026-09-02", to: "2026-09-24" };
  assert.equal(inWindow({ ad: false, s: "2026-09-10T12:00:00Z", e: "2026-09-10T13:00:00Z" }, w), true);
  assert.equal(inWindow({ ad: false, s: "2026-08-01T12:00:00Z", e: "2026-08-01T13:00:00Z" }, w), false);
  assert.equal(inWindow({ ad: true, s: "2026-09-08", e: "2026-09-09" }, w), true);
  assert.equal(inWindow({ ad: true, s: "2026-09-24", e: "2026-09-25" }, w), true);
  assert.equal(inWindow(null, w), false);
});

/* ---------------------------------------------------------------- hygiene */

test("scrub removes anything url-shaped before it can reach a log", () => {
  assert.equal(scrub("failed to fetch https://calendar.example.com/x?secret=1 twice"), "failed to fetch <url> twice");
});

/* -------------------------------------------------------- the run, for real */

test("the connector fixture is ingested, and the summary line says what happened", (t) => {
  const dir = workspace(t);
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json")]);
  assert.equal(r.status, EXIT.ok, r.stderr);
  const last = r.stdout.trim().split("\n").pop();
  assert.equal(last, "[gcal-ingest] feed=work source=connector events=5 skippedOwn=2 warnings=3 window=2026-09-02..2026-09-24");

  const out = outputOf(dir);
  assert.equal(out.v, 1);
  assert.equal(out.tz, TZ);
  assert.deepEqual(out.window, { from: "2026-09-02", to: "2026-09-24" });
  assert.equal(out.feeds.length, 1);
  assert.equal(out.feeds[0].id, "work");
  assert.equal(out.feeds[0].label, "Work");
  assert.equal(out.feeds[0].status, "ok");
  assert.equal(out.feeds[0].source, "connector");
  assert.equal(out.feeds[0].error, null);
  assert.equal(out.events.length, 5);
});

test("nothing from the raw file reaches stdout, stderr or the output document", (t) => {
  const dir = workspace(t);
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json")]);
  const all = r.stdout + r.stderr + readFileSync(join(dir, "gcal-items.json"), "utf8");
  for (const secret of ["colleague@example.com", "someone.else@example.com", "abc-defg-hij"]) {
    assert.ok(!all.includes(secret), `${secret} escaped`);
  }
});

test("the transcribed shape is recorded as such, so provenance is never invented", (t) => {
  const dir = workspace(t);
  const r = run(dir, ["--in", join(FIXTURES, "transcribed.json")]);
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.equal(outputOf(dir).feeds[0].source, "transcribed");
});

test("an MCP envelope and a bare JSON string both ingest identically", (t) => {
  const dir = workspace(t);
  const raw = readFileSync(join(FIXTURES, "connector-result.json"), "utf8");
  const plain = run(dir, ["--in", join(FIXTURES, "connector-result.json")]);
  const wrapped = join(dir, "wrapped.json");
  writeFileSync(wrapped, JSON.stringify({ content: [{ type: "text", text: raw }] }));
  const a = outputOf(dir);
  const r = run(dir, ["--in", wrapped]);
  assert.equal(plain.status, EXIT.ok);
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.deepEqual(outputOf(dir).events, a.events);
});

test("--dry-run prints the summary and writes nothing", (t) => {
  const dir = workspace(t);
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json"), "--dry-run"]);
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.match(r.stdout, /events=5/);
  assert.equal(existsSync(join(dir, "gcal-items.json")), false);
});

test("--help wins over an argv mistake and exits 0", (t) => {
  const dir = workspace(t);
  const r = run(dir, ["--help", "--wat"]);
  assert.equal(r.status, EXIT.ok);
  assert.match(r.stdout, /exit codes: 0 ingested/);
});

test("a missing --in file exits 3 and, with nothing to inherit, writes an honest failure", (t) => {
  const dir = workspace(t);
  const r = run(dir, ["--in", join(dir, "nope.json")]);
  assert.equal(r.status, EXIT.partial);
  const out = outputOf(dir);
  assert.equal(out.feeds[0].status, "failed");
  assert.equal(out.feeds[0].events, 0);
  assert.deepEqual(out.events, [], "a failed fetch never leaves last week's meetings on the grid");
  assert.match(out.feeds[0].error, /could not be read/);
});

test("a missing --in file keeps a previous run's events for 48 hours, as stale", (t) => {
  const dir = workspace(t);
  assert.equal(run(dir, ["--in", join(FIXTURES, "connector-result.json")]).status, EXIT.ok);

  const r = run(dir, ["--in", join(dir, "nope.json")], ["--now", "2026-09-04T18:00:00.000Z"]);
  assert.equal(r.status, EXIT.partial);
  const out = outputOf(dir);
  assert.equal(out.feeds[0].status, "stale");
  assert.equal(out.feeds[0].events, 5);
  assert.equal(out.feeds[0].fetchedAt, NOW, "the ORIGINAL fetch time, so the age stays honest");
  assert.equal(out.feeds[0].source, "connector", "the provenance travels with the events");
  assert.match(out.feeds[0].error, /showing data from 24h ago/);
});

test("past 48 hours the stale events are dropped rather than shown as today's", (t) => {
  const dir = workspace(t);
  assert.equal(run(dir, ["--in", join(FIXTURES, "connector-result.json")]).status, EXIT.ok);
  const r = run(dir, ["--in", join(dir, "nope.json")], ["--now", "2026-09-06T18:00:00.000Z"]);
  assert.equal(r.status, EXIT.partial);
  assert.equal(outputOf(dir).feeds[0].status, "failed");
  assert.deepEqual(outputOf(dir).events, []);
});

test("a payload that is not a calendar listing exits 1, names only its keys, and writes nothing", (t) => {
  const dir = workspace(t);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ error: "unauthorized", detail: "token expired for user@example.com" }));
  const r = run(dir, ["--in", bad]);
  assert.equal(r.status, EXIT.error);
  assert.match(r.stderr, /top-level keys: detail, error/);
  assert.ok(!r.stderr.includes("user@example.com"));
  assert.equal(existsSync(join(dir, "gcal-items.json")), false);
});

test("a malformed --in file is a partial, not a crash, and quotes nothing", (t) => {
  const dir = workspace(t);
  const bad = join(dir, "half.json");
  writeFileSync(bad, '{"events":[{"summary":"lunch with dr.private@example.com"');
  const r = run(dir, ["--in", bad]);
  assert.equal(r.status, EXIT.partial);
  assert.ok(!(r.stdout + r.stderr).includes("private@example.com"));
  assert.match(outputOf(dir).feeds[0].error, /not valid JSON \(\d+ characters\)/);
});

test("an unknown flag exits 1 and leaves any previous file exactly as it was", (t) => {
  const dir = workspace(t);
  assert.equal(run(dir, ["--in", join(FIXTURES, "connector-result.json")]).status, EXIT.ok);
  const before = readFileSync(join(dir, "gcal-items.json"), "utf8");
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json"), "--wat"]);
  assert.equal(r.status, EXIT.error);
  assert.match(r.stderr, /unknown argument/);
  assert.equal(readFileSync(join(dir, "gcal-items.json"), "utf8"), before);
});

test("an enabled config that names nothing else gets the default feed id", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agenda-gcal-bare-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ calendars: { gcal: { enabled: true } } }));
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json")]);
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.match(r.stdout, /feed=calendar/, "the default feed id");
});

/* ------------------------------------------------------------ the switch --
   `calendars.gcal.enabled` is the ONE switch for this route, and the script
   reads it too. A runbook step that fires when the block is off - a leftover
   scheduled task, a copied runbook, a user who turned it off this morning -
   must not write a file the render would then have to be told to ignore. */

test("the ingest is a no-op when calendars.gcal.enabled is not true", (t) => {
  for (const gcal of [{ enabled: false }, {}, undefined]) {
    const dir = mkdtempSync(join(tmpdir(), "agenda-gcal-off-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "config.json"), JSON.stringify(gcal ? { calendars: { gcal } } : { timezone: TZ }));
    const r = run(dir, ["--in", join(FIXTURES, "connector-result.json")]);
    assert.equal(r.status, EXIT.ok, `${JSON.stringify(gcal)} must not fail a run: ${r.stderr}`);
    assert.match(r.stdout, /skipped=disabled/, r.stdout);
    assert.match(r.stdout, /calendars\.gcal\.enabled/, "it says which key to set");
    assert.equal(existsSync(join(dir, "gcal-items.json")), false, "nothing is written while the route is off");
  }
});

test("a disabled route with no config at all is dormant rather than a crash", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agenda-gcal-noconfig-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--config", join(dir, "absent.json"), "--data", dir, "--now", NOW, "--in", join(FIXTURES, "connector-result.json")],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.match(r.stdout, /skipped=disabled/);
  assert.equal(existsSync(join(dir, "gcal-items.json")), false);
});

test("an argument mistake still beats the switch: a bad flag is exit 1, not a quiet skip", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agenda-gcal-offbad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ calendars: { gcal: { enabled: false } } }));
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json"), "--wat"]);
  assert.equal(r.status, EXIT.error);
  assert.match(r.stderr, /unknown argument: --wat/);
});

test("the config's loop guard is derived from the namespace, so two agendas do not eat each other", (t) => {
  const dir = workspace(t);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ namespace: "other", timezone: TZ, calendars: { gcal: { enabled: true, feed: "work", label: "Work" } } }),
  );
  const r = run(dir, ["--in", join(FIXTURES, "connector-result.json")]);
  assert.equal(r.status, EXIT.ok, r.stderr);
  // The fixture's own event carries `@agenda.agenda.local`; under namespace
  // "other" it is somebody else's deadline and is drawn like any meeting.
  assert.equal(outputOf(dir).feeds[0].skippedOwn, 1, "only the description-marker rule still fires");
  assert.ok(outputOf(dir).events.some((e) => e.t === "PHYS 221: Problem Set 3 due"));
});

/* ------------------------------------------------------------ pure helpers */

test("staleEventsFor clamps a backwards clock to fresh rather than discarding the data", () => {
  const previous = {
    feeds: [{ id: "work", fetchedAt: "2026-09-03T18:00:00.000Z", source: "connector" }],
    events: [{ feed: "work", ad: false, s: "2026-09-10T12:00:00Z", e: "2026-09-10T13:00:00Z" }],
  };
  const w = { from: "2026-09-02", to: "2026-09-24" };
  const back = staleEventsFor(previous, "work", Date.parse("2026-09-03T12:00:00Z"), w);
  assert.equal(back.ageHours, 0);
  assert.equal(back.events.length, 1);
  assert.equal(staleEventsFor(previous, "other", Date.now(), w), null);
  assert.equal(staleEventsFor(null, "work", Date.now(), w), null);
});

test("buildOutput and summaryLine are pure and agree with each other", () => {
  const out = buildOutput({
    now: new Date(NOW),
    tz: TZ,
    window: { from: "2026-09-02", to: "2026-09-24" },
    feeds: [{ id: "work", source: "connector", skippedOwn: 3, warnings: ["a", "b"] }],
    events: [{ k: "x" }],
  });
  assert.equal(out.generatedAt, NOW);
  assert.equal(
    summaryLine(out),
    "[gcal-ingest] feed=work source=connector events=1 skippedOwn=3 warnings=2 window=2026-09-02..2026-09-24",
  );
});
