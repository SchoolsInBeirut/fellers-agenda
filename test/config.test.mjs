// The configuration loader, and the one rule it exists to enforce.
//
// Every user-visible string and every wire identifier in this repository comes
// from `config.namespace`, derived once, here. The Drive document titles, the
// browser storage keys, the calendar category, the scheduled-task names and the
// log prefix all fall out of it. The moment two modules spell a document title
// differently, a run writes a document nobody reads and a mark the user made is
// lost in a document that is never consumed - silently, with no error anywhere.
// So `derive()` is pure, it is tested here, and nothing else in the repository
// may rebuild one of those names by hand.
//
// The other thing this suite pins down is that `config.example.json` and the
// loader's own DEFAULTS agree key for key. They are written by different hands
// and read by different people; if they drift, a user who edits the file they
// were given gets behaviour the code does not have.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  DEFAULTS,
  NOT_SET,
  assertConfigured,
  derive,
  loadConfig,
  pageConfig,
  standardsCourse,
} from "../src/lib/config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { warn: () => {} };

function withConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), "agenda-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  return { dir, path };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("an absent config file yields the pure defaults, which is what a first run should see", () => {
  const cfg = loadConfig(join(tmpdir(), "definitely-not-a-config-file.json"), quiet);
  assert.equal(cfg.namespace, "agenda");
  assert.equal(cfg.title, "Weekly Agenda");
  assert.equal(cfg.timezone, null);
  assert.equal(cfg.wakeTime, "10:00");
  assert.equal(cfg.drive.maxEmitChars, 12000);
});

test("an empty object gets every default", () => {
  const { dir, path } = withConfig({});
  const cfg = loadConfig(path, quiet);
  assert.deepEqual(cfg.leadTimeDays, DEFAULTS.leadTimeDays);
  assert.deepEqual(cfg.focus.tuning, DEFAULTS.focus.tuning);
  assert.deepEqual(cfg.scheduler, DEFAULTS.scheduler);
  assert.equal(cfg.connectors.lms.brightspace.enabled, true);
  assert.equal(cfg.connectors.mail.outlook.enabled, false);
  rmSync(dir, { recursive: true, force: true });
});

test("a user value overrides one default without erasing its siblings", () => {
  const { dir, path } = withConfig({ scheduler: { taskPrefix: "Homework" } });
  const cfg = loadConfig(path, quiet);
  assert.equal(cfg.scheduler.taskPrefix, "Homework");
  assert.equal(cfg.scheduler.morningAt, "07:03", "the other scheduler keys survive");
  rmSync(dir, { recursive: true, force: true });
});

test("an array replaces wholesale - two courses means two, not two plus the examples", () => {
  const { dir, path } = withConfig({ courses: [{ id: 1, code: "AB 100" }] });
  assert.equal(loadConfig(path, quiet).courses.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("config.example.json and DEFAULTS agree key for key", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config.example.json"), "utf-8"));
  const walk = (a, b, path = "") => {
    // The example ships a sample term and two sample noise lists. Those are
    // content, not defaults: shipping somebody else's course codes or mail
    // domains as built-in behaviour would be worse than shipping nothing.
    const skip = new Set([
      "courses",
      "difficulty",
      "schedule",
      "connectors.mail.outlook.noiseDomains",
      "connectors.mail.outlook.noiseLocalParts",
    ]);
    for (const key of Object.keys(a)) {
      if (key.startsWith("_") || key.startsWith("//")) continue;
      const where = path ? `${path}.${key}` : key;
      assert.ok(key in b, `config.example.json has "${where}" but DEFAULTS does not`);
      if (skip.has(where)) continue;
      const av = a[key];
      const bv = b[key];
      if (av !== null && typeof av === "object" && !Array.isArray(av)) {
        walk(av, bv, where);
      } else if (av === NOT_SET) {
        assert.equal(bv, null, `"${where}" is [NOT SET] in the example, so DEFAULTS must be null`);
      } else {
        assert.deepEqual(bv, av, `"${where}" differs between config.example.json and DEFAULTS`);
      }
    }
    for (const key of Object.keys(b)) {
      const where = path ? `${path}.${key}` : key;
      assert.ok(key in a, `DEFAULTS has "${where}" but config.example.json does not`);
    }
  };
  walk(example, DEFAULTS);
});

// ---------------------------------------------------------------------------
// [NOT SET] and notes
// ---------------------------------------------------------------------------

test("[NOT SET] is treated as absent at every depth", () => {
  const { dir, path } = withConfig({
    timezone: NOT_SET,
    institution: { name: NOT_SET, lmsHost: "lms.example.edu" },
    standardsPlan: { enabled: false, course: NOT_SET },
  });
  const cfg = loadConfig(path, quiet);
  assert.equal(cfg.timezone, null);
  assert.equal(cfg.institution.name, null);
  assert.equal(cfg.institution.lmsHost, "lms.example.edu");
  assert.equal(cfg.standardsPlan.course, null);
  rmSync(dir, { recursive: true, force: true });
});

test("keys beginning with // or _ are ignored, so a user may leave themselves notes", () => {
  const { dir, path } = withConfig({
    "// why my timezone is odd": "I am on exchange",
    _note: "remember to re-run setup in January",
    timezone: "America/New_York",
    institution: { _comment: "the LMS host is the one in the browser bar", name: "Example University" },
  });
  const cfg = loadConfig(path, quiet);
  assert.equal(cfg.timezone, "America/New_York");
  assert.ok(!("_note" in cfg));
  assert.ok(!("// why my timezone is odd" in cfg));
  assert.ok(!("_comment" in cfg.institution));
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown top-level key warns but does not throw", () => {
  const { dir, path } = withConfig({ timezone: "UTC", kitchenSink: true });
  const warnings = [];
  const cfg = loadConfig(path, { warn: (m) => warnings.push(m) });
  assert.equal(cfg.timezone, "UTC");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /kitchenSink/);
  assert.match(warnings[0], /docs\/CONFIG\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test("invalid JSON is a ConfigError naming the file, not a stack trace", () => {
  const { dir, path } = withConfig("{ not json");
  assert.throws(() => loadConfig(path, quiet), (e) => e instanceof ConfigError && /not valid JSON/.test(e.message));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// namespace validation
// ---------------------------------------------------------------------------

test("the namespace charset is enforced", () => {
  for (const bad of ["", "ab", "Agenda", "my agenda", "my_agenda", "x".repeat(25), 7]) {
    const { dir, path } = withConfig({ namespace: bad });
    assert.throws(
      () => loadConfig(path, quiet),
      (e) => e instanceof ConfigError && e.key === "namespace",
      `namespace ${JSON.stringify(bad)} should be refused`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legal custom namespace is accepted", () => {
  const { dir, path } = withConfig({ namespace: "my-agenda-2" });
  assert.equal(loadConfig(path, quiet).namespace, "my-agenda-2");
  rmSync(dir, { recursive: true, force: true });
});

test("an explicit null namespace means 'unset' and falls back to the default", () => {
  // Null and [NOT SET] are the same statement - "I have not chosen one" - and
  // the answer to both is the documented default, not a crash.
  const { dir, path } = withConfig({ namespace: null });
  assert.equal(loadConfig(path, quiet).namespace, "agenda");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// calendars.gcal - the inbound calendar block
//
// Every value here reaches a different subsystem: `enabled` is the ONLY switch
// the render reads, `feed` becomes the prefix of every meeting key on the wire,
// and `maxEvents` bounds a file. A wrong type in any of them used to load
// silently and then behave as though the key had been left out.
// ---------------------------------------------------------------------------

const gcalConfig = (gcal) => ({ timezone: "UTC", calendars: { gcal } });

/** Every value that must be refused, with the key the error has to name. */
const badGcal = [
  [{ enabled: "true" }, "calendars.gcal.enabled", "a string is not a boolean, and a truthy one reads as ON"],
  [{ enabled: 1 }, "calendars.gcal.enabled", "nor is a number"],
  [{ feed: "Work Calendar" }, "calendars.gcal.feed", "a feed id is [a-z0-9-]{1,24}"],
  [{ feed: "" }, "calendars.gcal.feed", "and it cannot be empty"],
  [{ feed: "x".repeat(25) }, "calendars.gcal.feed", "nor longer than 24"],
  [{ feed: 7 }, "calendars.gcal.feed", "nor a number"],
  [{ maxEvents: 0 }, "calendars.gcal.maxEvents", "zero events is not a cap, it is an outage"],
  [{ maxEvents: -1 }, "calendars.gcal.maxEvents", "negative is nonsense"],
  [{ maxEvents: 1.5 }, "calendars.gcal.maxEvents", "a count is a whole number"],
  [{ maxEvents: 999999 }, "calendars.gcal.maxEvents", "past the ceiling is a typo, not an ambition"],
  [{ label: "y".repeat(25) }, "calendars.gcal.label", "the page has a column, not a paragraph"],
  [{ label: 7 }, "calendars.gcal.label", "and it is text"],
  [{ skipUidSuffix: 7 }, "calendars.gcal.skipUidSuffix", "the loop guard is text or null"],
  [{ skipDescriptionMarker: [] }, "calendars.gcal.skipDescriptionMarker", "so is the other one"],
];

test("every calendars.gcal value is checked, and the error names the key", () => {
  for (const [gcal, key, why] of badGcal) {
    const { dir, path } = withConfig(gcalConfig(gcal));
    assert.throws(() => loadConfig(path, quiet), (e) => e instanceof ConfigError && e.key === key, `${JSON.stringify(gcal)}: ${why}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a feed id may not be "fb": that is the session key space', () => {
  // A meeting key is `<feed>|<uid>|<start>` and a session key is
  // `fb|<day>|<bucket>`. Nothing downstream re-checks which it is holding, so
  // the two key spaces are kept apart HERE, by refusing the prefix.
  const { dir, path } = withConfig(gcalConfig({ feed: "fb" }));
  assert.throws(
    () => loadConfig(path, quiet),
    (e) => e instanceof ConfigError && e.key === "calendars.gcal.feed" && /reserved/.test(e.message) && /session/.test(e.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a complete, legal calendars.gcal block loads unchanged", () => {
  const gcal = { enabled: true, calendarId: "primary", feed: "work-2", label: "Work", maxEvents: 50, skipUidSuffix: "", skipDescriptionMarker: "x" };
  const { dir, path } = withConfig(gcalConfig(gcal));
  assert.deepEqual(loadConfig(path, quiet).calendars.gcal, gcal);
  rmSync(dir, { recursive: true, force: true });
});

test("an absent calendars block is dormant, not an error", () => {
  const { dir, path } = withConfig({ timezone: "UTC" });
  assert.equal(loadConfig(path, quiet).calendars.gcal.enabled, false);
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown key under calendars.gcal warns, the way an unknown top-level key does", () => {
  const { dir, path } = withConfig(gcalConfig({ enabled: true, calenderId: "primary" }));
  const warnings = [];
  assert.equal(loadConfig(path, { warn: (m) => warnings.push(m) }).calendars.gcal.enabled, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /calendars\.gcal/);
  assert.match(warnings[0], /calenderId/);
  rmSync(dir, { recursive: true, force: true });
});

test("calendars, and gcal inside it, must be objects", () => {
  for (const [raw, key] of [
    [{ timezone: "UTC", calendars: true }, "calendars"],
    [{ timezone: "UTC", calendars: { gcal: "on" } }, "calendars.gcal"],
  ]) {
    const { dir, path } = withConfig(raw);
    assert.throws(() => loadConfig(path, quiet), (e) => e instanceof ConfigError && e.key === key);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// derive() - the names nothing else may rebuild
// ---------------------------------------------------------------------------

test("derive: the default namespace produces the documented names", () => {
  const d = derive(DEFAULTS);
  assert.deepEqual(d.docTitles, {
    data: "agenda-data",
    mirror: "agenda-mirror",
    completions: "agenda-completions",
    commands: "agenda-commands",
  });
  assert.deepEqual(d.storageKeys, { marks: "agenda.marks.v1", blocks: "agenda.blocks.v1" });
  assert.deepEqual(d.taskNames, {
    morning: "Agenda Morning",
    evening: "Agenda Evening",
    sync: "Agenda Sync",
    staleCheck: "Agenda StaleCheck",
    authRetry: "Agenda AuthRetry",
  });
  assert.equal(d.logPrefix, "[agenda]");
  assert.equal(d.sideBucket, "Side Project");
  assert.equal(d.category, "Agenda");
});

test("derive: a custom namespace and task prefix move every name together", () => {
  const d = derive({ ...DEFAULTS, namespace: "study", scheduler: { ...DEFAULTS.scheduler, taskPrefix: "Study" } });
  assert.equal(d.docTitles.data, "study-data");
  assert.equal(d.docTitles.completions, "study-completions");
  assert.equal(d.storageKeys.marks, "study.marks.v1");
  assert.equal(d.taskNames.sync, "Study Sync");
  assert.equal(d.logPrefix, "[study]");
});

test("derive: the project name never leaks into a wire identifier", () => {
  const all = Object.values(derive(DEFAULTS).docTitles)
    .concat(Object.values(derive(DEFAULTS).storageKeys))
    .concat(Object.values(derive(DEFAULTS).taskNames))
    .join(" ");
  assert.ok(!/feller/i.test(all), "the repository's own name is not an identifier");
});

test("derive: the skip sets come from courses[].skip", () => {
  const d = derive({
    ...DEFAULTS,
    courses: [
      { id: 110001, code: "PHYS 221" },
      { id: 110006, code: "SEM 100", skip: true },
      { id: 110007, code: "ZZZ 999", skip: false },
    ],
  });
  assert.deepEqual([...d.skipCodes], ["SEM 100"]);
  assert.deepEqual([...d.skipIds], [110006]);
  assert.equal(d.courseByCode.get("PHYS 221").id, 110001);
  assert.equal(d.courseById.get(110006).code, "SEM 100");
});

test("derive: it is pure - the same config twice gives equal answers and mutates nothing", () => {
  const cfg = { ...DEFAULTS, namespace: "abc" };
  const frozen = JSON.stringify(cfg);
  const a = derive(cfg);
  const b = derive(cfg);
  assert.deepEqual(a.docTitles, b.docTitles);
  assert.equal(JSON.stringify(cfg), frozen);
});

test("derive: a custom side-project label becomes the bucket name", () => {
  assert.equal(derive({ ...DEFAULTS, sideProject: { label: "Band" } }).sideBucket, "Band");
});

// ---------------------------------------------------------------------------
// assertConfigured - the sentence a confused new user will paste into a search
// ---------------------------------------------------------------------------

test("assertConfigured: an unset key names itself and says exactly what to do", () => {
  assert.throws(
    () => assertConfigured(loadConfig(join(tmpdir(), "nope.json"), quiet), ["timezone"]),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.key, "timezone");
      assert.match(e.message, /config: "timezone" is not set yet\./);
      assert.match(e.message, /say "hey"/);
      assert.match(e.message, /docs\/CONFIG\.md/);
      return true;
    },
  );
});

test("assertConfigured: a set key passes, and a dotted path is understood", () => {
  const { dir, path } = withConfig({ timezone: "UTC", institution: { name: "Example University" } });
  const cfg = loadConfig(path, quiet);
  assert.equal(assertConfigured(cfg, ["timezone", "institution.name"]), cfg);
  assert.throws(() => assertConfigured(cfg, "institution.lmsHost"), (e) => e.key === "institution.lmsHost");
  rmSync(dir, { recursive: true, force: true });
});

test("assertConfigured: an empty or whitespace string counts as unset", () => {
  const { dir, path } = withConfig({ timezone: "   " });
  assert.throws(() => assertConfigured(loadConfig(path, quiet), "timezone"), (e) => e instanceof ConfigError);
  rmSync(dir, { recursive: true, force: true });
});

test("an unset key belonging to a disabled feature never blocks anything", () => {
  // This is the rule that keeps the template usable: a fresh checkout has an
  // unset standards course, an unset side-project org and an unset materials
  // root, and every one of those features is off. Nothing should notice.
  const cfg = loadConfig(join(tmpdir(), "nope.json"), quiet);
  assert.equal(standardsCourse(cfg), null);
  assert.equal(cfg.sideProject.enabled, false);
  assert.equal(cfg.connectors.materials.enabled, false);
  assert.doesNotThrow(() => derive(cfg));
  assert.doesNotThrow(() => pageConfig(cfg));
});

// ---------------------------------------------------------------------------
// pageConfig - the object baked into a page that can never read config again
// ---------------------------------------------------------------------------

test("pageConfig: the shape matches the page contract key for key", () => {
  const pc = pageConfig({ ...DEFAULTS, timezone: "America/New_York" });
  assert.deepEqual(Object.keys(pc).sort(), [
    "buckets",
    "docTitles",
    "driveConnector",
    "leadTimeDays",
    "maxWeight",
    "ns",
    "standardsPlan",
    "storageKeys",
    "timezone",
    "title",
    "wakeTime",
  ]);
  assert.deepEqual(Object.keys(pc.docTitles).sort(), ["commands", "completions", "data"]);
  assert.deepEqual(Object.keys(pc.storageKeys).sort(), ["blocks", "marks"]);
  assert.deepEqual(Object.keys(pc.buckets).sort(), ["mail", "research", "side"]);
  assert.deepEqual(Object.keys(pc.standardsPlan).sort(), ["course", "enabled", "label"]);
  assert.equal(pc.maxWeight, 5);
  assert.equal(pc.driveConnector, "Google Drive");
  assert.equal(pc.timezone, "America/New_York");
});

test("pageConfig: the mirror title is deliberately absent - the page never reads it", () => {
  assert.ok(!("mirror" in pageConfig(DEFAULTS).docTitles));
});

test("pageConfig: the standards card is off unless a course is actually configured", () => {
  assert.equal(pageConfig(DEFAULTS).standardsPlan.enabled, false);
  assert.equal(pageConfig({ ...DEFAULTS, standardsPlan: { enabled: true, course: null } }).standardsPlan.enabled, false);
  const on = pageConfig({ ...DEFAULTS, standardsPlan: { enabled: true, course: "PHYS 221", label: "Standards" } });
  assert.equal(on.standardsPlan.enabled, true);
  assert.equal(on.standardsPlan.course, "PHYS 221");
});

test("pageConfig: it is JSON-serialisable, because it is substituted into the page as JSON", () => {
  const pc = pageConfig({ ...DEFAULTS, timezone: "UTC" });
  assert.deepEqual(JSON.parse(JSON.stringify(pc)), pc);
});

test("pageConfig: the demo term configures a complete page with no [NOT SET] anywhere", () => {
  const cfg = loadConfig(join(ROOT, "fixtures", "demo", "config.demo.json"), quiet);
  const pc = pageConfig(cfg);
  assert.equal(pc.timezone, "America/New_York");
  assert.equal(pc.standardsPlan.enabled, true);
  assert.equal(pc.buckets.side, "Side Project");
  assert.ok(!JSON.stringify(cfg).includes(NOT_SET), "the demo config must be fully populated");
});
