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
  EMAIL_DIGEST_SINKS,
  LEGACY_EMAIL_DIGEST,
  LEGACY_SCHEDULER_KEYS,
  LLM_EFFORTS,
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
  assert.equal(cfg.scheduler.dailyAt, "10:30", "the other scheduler keys survive");
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
// scheduler - one boundary, and the 1.x keys that no longer name one
//
// 2.0.0 retired the two heavy runs and the 2-hourly sync lane. A config written
// against 1.x still has their keys in it, and the two ways of getting this
// wrong are both bad: throw, and somebody's week stops being drawn over a key
// nothing reads; say nothing, and they keep editing `morningAt` and wondering
// why the run still happens at 10:30.
// ---------------------------------------------------------------------------

test("the shipped scheduler has one boundary and no 1.x keys", () => {
  assert.equal(DEFAULTS.scheduler.dailyAt, "10:30");
  assert.equal(DEFAULTS.scheduler.quietUntil, "10:23");
  assert.equal(DEFAULTS.scheduler.quietFrom, "23:00");
  for (const k of LEGACY_SCHEDULER_KEYS) {
    assert.ok(!(k in DEFAULTS.scheduler), `scheduler.${k} is retired and must not be a default`);
  }
});

test("a config still carrying the 1.x scheduler keys is accepted, with ONE warning naming dailyAt", () => {
  const { dir, path } = withConfig({
    timezone: "UTC",
    scheduler: { morningAt: "07:03", eveningAt: "18:07", syncWindow: ["09:00", "23:00"], syncGapHours: 3 },
  });
  const warnings = [];
  const cfg = loadConfig(path, { warn: (m) => warnings.push(m) });

  assert.equal(cfg.scheduler.dailyAt, "10:30", "the run still happens, at the one boundary there is");
  assert.equal(warnings.length, 1, `exactly one warning, got:\n${warnings.join("\n")}`);
  assert.match(warnings[0], /scheduler\.dailyAt/);
  assert.match(warnings[0], /morningAt, eveningAt, syncWindow, syncGapHours/);
  assert.match(warnings[0], /docs\/CONFIG\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test("a scheduler with none of the 1.x keys says nothing at all", () => {
  const { dir, path } = withConfig({ timezone: "UTC", scheduler: { dailyAt: "11:15" } });
  const warnings = [];
  assert.equal(loadConfig(path, { warn: (m) => warnings.push(m) }).scheduler.dailyAt, "11:15");
  assert.deepEqual(warnings, []);
  rmSync(dir, { recursive: true, force: true });
});

test("the three scheduler clocks must be HH:MM, and the error names the key", () => {
  // `install-tasks.cmd` hands `dailyAt` straight to `-Daily -At`, while
  // stale-check's parseClock falls back silently. A typo therefore registers a
  // task at one time and a watchdog that believes the boundary is somewhere
  // else - two disagreeing clocks and no error anywhere.
  // `null` is deliberately absent: it means "I have not chosen one", and the
  // merge rule answers that with the documented default, exactly as it does for
  // the namespace. Every value below is a value somebody MEANT.
  const bad = ["10.30", "1030", "24:00", "10:60", "10:5", "half past ten", "", 7, true];
  for (const key of ["dailyAt", "quietUntil", "quietFrom"]) {
    for (const value of bad) {
      const { dir, path } = withConfig({ timezone: "UTC", scheduler: { [key]: value } });
      assert.throws(
        () => loadConfig(path, quiet),
        (e) => e instanceof ConfigError && e.key === `scheduler.${key}`,
        `scheduler.${key} = ${JSON.stringify(value)} should be refused`,
      );
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("every legal HH:MM spelling is accepted, including a bare hour", () => {
  for (const value of ["00:00", "9:05", "09:05", "23:59"]) {
    const { dir, path } = withConfig({
      timezone: "UTC",
      scheduler: { dailyAt: value, quietUntil: "00:00", quietFrom: "23:59" },
    });
    assert.equal(loadConfig(path, quiet).scheduler.dailyAt, value);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dailyAt the watchdog could never rescue warns, and still loads", () => {
  // 22:50 + the 20-minute grace is 23:10, which is already inside the 23:00
  // quiet ceiling: decideStale can never call the day missed. The RUN is fine,
  // so this is a warning - refusing to load would cost the whole agenda to
  // save the watchdog.
  const { dir, path } = withConfig({ timezone: "UTC", scheduler: { dailyAt: "22:50" } });
  const warnings = [];
  const cfg = loadConfig(path, { warn: (m) => warnings.push(m) });

  assert.equal(cfg.scheduler.dailyAt, "22:50", "the run still happens where it was asked to");
  assert.equal(warnings.length, 1, warnings.join("\n"));
  for (const key of ["scheduler.dailyAt", "scheduler.quietUntil", "scheduler.quietFrom"]) {
    assert.ok(warnings[0].includes(key), `the warning must name ${key}:\n${warnings[0]}`);
  }
  assert.match(warnings[0], /watchdog can never rescue/);
  rmSync(dir, { recursive: true, force: true });
});

test("a boundary before the quiet floor warns for the same reason", () => {
  // 06:00 + 20 = 06:20, which is before the 10:23 floor. Symmetrical failure,
  // same sentence.
  const { dir, path } = withConfig({ timezone: "UTC", scheduler: { dailyAt: "06:00" } });
  const warnings = [];
  loadConfig(path, { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /watchdog can never rescue/);
  rmSync(dir, { recursive: true, force: true });

  // ...and moving the floor with it is the fix, which must go quiet again.
  const ok = withConfig({ timezone: "UTC", scheduler: { dailyAt: "06:00", quietUntil: "05:55" } });
  const quietWarnings = [];
  loadConfig(ok.path, { warn: (m) => quietWarnings.push(m) });
  assert.deepEqual(quietWarnings, []);
  rmSync(ok.dir, { recursive: true, force: true });
});

test("the shipped defaults leave the watchdog able to do its job", () => {
  // 10:30 + 20 = 10:50, inside [10:23, 23:00). If this ever stops being true,
  // the default install has a watchdog that cannot fire.
  const warnings = [];
  loadConfig(join(tmpdir(), "definitely-not-a-config-file.json"), { warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// llm - the model window's budget
//
// Every value here becomes a command-line argument, and two of them are the
// only thing between a wedged run and a fortnight of usage.
// ---------------------------------------------------------------------------

test("the shipped llm block is the documented one", () => {
  assert.deepEqual(DEFAULTS.llm, {
    enabled: true,
    model: "claude-sonnet-5",
    effort: "medium",
    maxTurns: 20,
    maxBudgetUsd: 1,
    timeoutMinutes: 45,
  });
  assert.deepEqual([...LLM_EFFORTS], ["low", "medium", "high"]);
});

const badLlm = [
  [{ enabled: "true" }, "llm.enabled", "a truthy string reads as ON to everything but a === true"],
  [{ model: "" }, "llm.model", "an empty model name would reach the CLI as a bare --model"],
  [{ model: 7 }, "llm.model", "and a number is not a model"],
  [{ effort: "maximum" }, "llm.effort", "the flag takes three values"],
  [{ maxTurns: 0 }, "llm.maxTurns", "zero turns is not a cap, it is an outage"],
  [{ maxTurns: 2.5 }, "llm.maxTurns", "a count is a whole number"],
  [{ maxTurns: 10000 }, "llm.maxTurns", "past the ceiling is a typo, not an ambition"],
  [{ maxBudgetUsd: 0 }, "llm.maxBudgetUsd", "a zero budget refuses every run"],
  [{ maxBudgetUsd: -1 }, "llm.maxBudgetUsd", "negative is nonsense"],
  [{ maxBudgetUsd: "1" }, "llm.maxBudgetUsd", "a string dollar amount is not a number"],
  [{ timeoutMinutes: 0 }, "llm.timeoutMinutes", "a zero timeout kills the window it opened"],
  [{ timeoutMinutes: 1000 }, "llm.timeoutMinutes", "longer than the task's own limit is meaningless"],
];

test("every llm value is checked, and the error names the key", () => {
  for (const [llm, key, why] of badLlm) {
    const { dir, path } = withConfig({ timezone: "UTC", llm });
    assert.throws(
      () => loadConfig(path, quiet),
      (e) => e instanceof ConfigError && e.key === key,
      `${JSON.stringify(llm)}: ${why}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fractional budget is fine - it is dollars, not turns", () => {
  const { dir, path } = withConfig({ timezone: "UTC", llm: { maxBudgetUsd: 0.25 } });
  assert.equal(loadConfig(path, quiet).llm.maxBudgetUsd, 0.25);
  rmSync(dir, { recursive: true, force: true });
});

test("llm.enabled false is a legal, documented state - the page still updates without a model", () => {
  const { dir, path } = withConfig({ timezone: "UTC", llm: { enabled: false } });
  const cfg = loadConfig(path, quiet);
  assert.equal(cfg.llm.enabled, false);
  assert.equal(cfg.llm.model, "claude-sonnet-5", "the rest of the block survives being switched off");
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown key under llm warns, the way an unknown top-level key does", () => {
  const { dir, path } = withConfig({ timezone: "UTC", llm: { maxTokens: 100 } });
  const warnings = [];
  loadConfig(path, { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /llm\.maxTokens/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// notifications.emailDigest - a sink, not a switch
// ---------------------------------------------------------------------------

test("emailDigest names one of the sinks that exist, or nothing gets sent", () => {
  assert.deepEqual([...EMAIL_DIGEST_SINKS], ["off", "outlook"]);
  for (const bad of ["gmail", "on", "", 1, 0, []]) {
    const { dir, path } = withConfig({ timezone: "UTC", notifications: { emailDigest: bad } });
    assert.throws(
      () => loadConfig(path, quiet),
      (e) => e instanceof ConfigError && e.key === "notifications.emailDigest",
      `emailDigest ${JSON.stringify(bad)} should be refused`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
  for (const good of EMAIL_DIGEST_SINKS) {
    const { dir, path } = withConfig({ timezone: "UTC", notifications: { emailDigest: good } });
    assert.equal(loadConfig(path, quiet).notifications.emailDigest, good);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A 1.x config with the digest switched ON is the upgrade path that matters
// most, and it is the one that used to throw. A ConfigError here is not one
// broken feature: `loadConfig` is the first thing the launcher, the pipeline,
// the stale-run watchdog AND the auth lane each call, so the agenda would go
// dark with nothing anywhere able to say why.
test("every 1.x emailDigest value still loads, mapped, with ONE warning naming the key", () => {
  const cases = [
    ["morning-only", "outlook", "1.x asked WHEN; there is only one run now, so the question is WHERE"],
    ["every-run", "outlook", "same"],
    [true, "outlook", "a boolean named no sink, and read as ON to every truthiness test"],
    [false, "off", "...and its opposite is plainly off"],
  ];
  for (const [was, becomes, why] of cases) {
    const { dir, path } = withConfig({ timezone: "UTC", notifications: { emailDigest: was } });
    const warnings = [];
    const cfg = loadConfig(path, { warn: (m) => warnings.push(m) });

    assert.equal(cfg.notifications.emailDigest, becomes, `${JSON.stringify(was)}: ${why}`);
    assert.equal(warnings.length, 1, `exactly one warning for ${JSON.stringify(was)}:\n${warnings.join("\n")}`);
    assert.match(warnings[0], /notifications\.emailDigest/);
    assert.match(warnings[0], /"off" and "outlook"/, "the warning must name the values that work now");
    assert.ok(warnings[0].includes(JSON.stringify(was)), "and the value it found");
    assert.match(warnings[0], /docs\/CONFIG\.md/);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual([...LEGACY_EMAIL_DIGEST.keys()], ["morning-only", "every-run", true, false]);
});

test("the mapped value is what reaches the digest gate, not the 1.x spelling", () => {
  // send-digest.mjs and the pipeline's digest step both compare against
  // "outlook" exactly. Normalising in the loader is what keeps that one
  // comparison, in two places, from having to know any history.
  const { dir, path } = withConfig({ timezone: "UTC", notifications: { emailDigest: "every-run" } });
  const cfg = loadConfig(path, quiet);
  assert.ok(EMAIL_DIGEST_SINKS.includes(cfg.notifications.emailDigest));
  assert.equal(cfg.notifications.digestTo, null, "the rest of the block is untouched");
  rmSync(dir, { recursive: true, force: true });
});

test("an explicit null is 'unset' here too, and falls back to the shipped answer", () => {
  // The same rule the namespace follows: null and [NOT SET] both say "I have
  // not chosen one", and the answer to both is the documented default rather
  // than a refusal to load. It is the only reason these two are not in the
  // refused list above.
  const { dir, path } = withConfig({ timezone: "UTC", notifications: { emailDigest: null }, llm: { model: NOT_SET } });
  const cfg = loadConfig(path, quiet);
  assert.equal(cfg.notifications.emailDigest, "off");
  assert.equal(cfg.llm.model, "claude-sonnet-5");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// drive - the page reads through a connector, the pipeline runs rclone
// ---------------------------------------------------------------------------

test("drive carries the rclone transport's two keys", () => {
  const cfg = loadConfig(join(tmpdir(), "definitely-not-a-config-file.json"), quiet);
  assert.equal(cfg.drive.rcloneRemote, "agenda");
  assert.equal(cfg.drive.rcloneExe, null, "[NOT SET] means find it on PATH");
  assert.equal(cfg.drive.connectorName, "Google Drive", "the page still names a connector");
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
    daily: "Agenda Daily",
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
  assert.equal(d.taskNames.daily, "Study Daily");
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
