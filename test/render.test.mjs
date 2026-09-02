// render.mjs is a script, not a module: it reads a config and a data directory
// and writes the payload, the page and focus-plan.json. So these tests point the
// real file at a throwaway directory with `--config` and `--data` and run it as
// a subprocess. That is the whole reason those two flags exist.
//
// NOTHING HERE EVER TOUCHES data/. Every path below is inside a mkdtemp
// directory that is removed again in the same test.
//
// What it pins is the part of the render no unit test can reach:
//
//  * how `done[]` is assembled - a three-pass ledger with an origin rule
//    threaded through it. Getting the order wrong tells the user they have not
//    done work they have, which is the exact failure this design exists to
//    prevent;
//  * that one clock is threaded through the whole run, so a mid-day render
//    keeps the morning it already published instead of re-deriving a day that
//    is half over;
//  * that what lands in the envelope is byte-identical to what lands in the
//    page. Those two copies travel by completely different routes - one is
//    gzipped, checksummed and typed into a document by an agent, the other is
//    baked into the HTML - and nothing else in the repository compares them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { itemKey } from "../src/merge.mjs";
import { cutMinute, localDayKey, localMinuteOfDay, wakeFloor } from "../src/focus-engine.mjs";
import { crc32, unpack } from "../src/lib/envelope.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = path.join(ROOT, "src", "render.mjs");

// A stub template, so these tests do not depend on the published page. The two
// markers are the whole substitution contract: a quoted payload string and a
// bare config object.
const TEMPLATE =
  '<html><body><script>var EMBEDDED="__PAYLOAD__";var CFG=__PAGE_CONFIG__;</script></body></html>';

const TZ = "America/New_York";
const BUDGET = 12000;

const CONFIG = {
  namespace: "agenda",
  timezone: TZ,
  wakeTime: "10:00",
  courses: [
    { id: 110002, code: "MATH 210", name: "Linear Algebra" },
    { id: 110003, code: "CHEM 115", name: "General Chemistry" },
    { id: 110005, code: "ART 101", name: "Intro to Design" },
    { id: 110006, code: "SEM 100", name: "Department Seminar", skip: true },
  ],
  difficulty: { "MATH 210": 4, "CHEM 115": 5, "ART 101": 1 },
  leadTimeDays: { exam: 7, project: 5, lab: 5, homework: 3, quiz: 2, default: 3 },
  studyMinutes: { weekday: 240, weekend: 300, weekdayWindow: ["16:00", "22:30"], weekendWindow: ["10:00", "21:00"] },
  schedule: {},
  drive: { maxEmitChars: BUDGET },
};

const NOW = Date.now();
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SCRAPED_AT = iso(-5 * 60 * 1000); // five minutes ago

/** A snapshot-shaped item. `submitted: null` is what most real items carry. */
const snapItem = (o = {}) => ({
  courseId: 110002,
  course: "MATH 210",
  title: "Homework 2",
  due: iso(2 * DAY),
  type: "homework",
  submitted: null,
  sources: ["dropbox"],
  ...o,
});

const keyOf = (it) => itemKey({ courseId: it.courseId, type: it.type, title: it.title });

/**
 * A complete, self-contained run in a temp directory. Only `latest` is
 * required; every other data file is optional exactly as it is in real life.
 */
function sandbox({
  items = [],
  completions = null,
  diff = null,
  scrapedAt = SCRAPED_AT,
  focusPlan = null,
  announcements = [],
  errors = [],
  config = CONFIG,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-render-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, "template.html"), TEMPLATE);
  fs.mkdirSync(path.join(dir, "data"));
  const write = (name, value) => fs.writeFileSync(path.join(dir, "data", name), JSON.stringify(value, null, 1));
  write("latest.json", { scrapedAt, items, announcements, errors });
  if (completions) write("user-completions.json", completions);
  if (diff) write("diff.json", diff);
  // The plan the PREVIOUS run published. render.mjs has to read this before it
  // overwrites it, so a mid-day re-render keeps the morning it already told the
  // user about instead of re-deriving a day that is half over.
  if (focusPlan) write("focus-plan.json", focusPlan);
  return dir;
}

const runRender = (dir, args = []) =>
  spawnSync(
    process.execPath,
    [
      RENDER,
      "--config",
      path.join(dir, "config.json"),
      "--data",
      path.join(dir, "data"),
      "--out",
      path.join(dir, "agenda.html"),
      "--template",
      path.join(dir, "template.html"),
      ...args,
    ],
    { encoding: "utf8" },
  );

/** Run the real render.mjs against a sandbox and decode what it published. */
function render(dir, args = []) {
  const run = runRender(dir, args);
  assert.equal(run.status, 0, `render.mjs failed:\n${run.stderr}${run.stdout}`);
  const envelope = fs.readFileSync(path.join(dir, "data", "payload.b64.txt"), "utf8");
  const out = unpack(envelope);
  return { payload: out.data, envelope, stdout: run.stdout, html: fs.readFileSync(path.join(dir, "agenda.html"), "utf8") };
}

/** Run one case and clean up after it, whatever happens. */
function withRender(options, body) {
  const { args = [], ...rest } = options;
  const dir = sandbox(rest);
  try {
    const r = render(dir, args);
    body(r.payload, dir, r.stdout, r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The envelope, and the two copies of the payload
// ---------------------------------------------------------------------------

test("the uploaded envelope is AGD2, and its checksum verifies", () => {
  withRender({ items: [snapItem()] }, (payload, dir, stdout, r) => {
    assert.match(r.envelope, /^AGD2\.[0-9a-f]{8}\..+\.END$/, "the upload contract is AGD2.<crc32>.<base64 gzip>.END");
    const [, sum, body] = r.envelope.slice(0, -4).split(".");
    assert.equal(crc32(Buffer.from(body, "base64")), sum, "the checksum is over the gzip bytes, before base64");
  });
});

test("the envelope and the copy embedded in the page carry the identical payload", () => {
  // Two copies, two completely different routes: one is gzipped, checksummed
  // and typed into a document by an agent; the other is baked into the HTML for
  // the first paint. Nothing else in the repository compares them.
  withRender({ items: [snapItem(), snapItem({ title: "Homework 3" })] }, (payload, dir, stdout, r) => {
    const embedded = r.html.match(/var EMBEDDED="(AGD1\.[^"]+)"/);
    assert.ok(embedded, "the page must carry a plain AGD1 copy for its first paint");
    assert.deepEqual(unpack(embedded[1]).data, payload);

    const [, , body] = r.envelope.slice(0, -4).split(".");
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(body, "base64")).toString("utf-8")), payload);
  });
});

test("the upload fits its budget, and the run says which tier it needed", () => {
  withRender({ items: [snapItem()] }, (payload, dir, stdout, r) => {
    assert.ok(r.envelope.length <= BUDGET, `envelope was ${r.envelope.length} chars, budget ${BUDGET}`);
    assert.match(stdout, new RegExp(`upload: ${r.envelope.length} chars \\(budget ${BUDGET}, tier 0\\)`));
  });
});

test("an impossible budget writes the oversize file, warns, and never truncates", () => {
  const many = Array.from({ length: 30 }, (_, i) => snapItem({ title: `Homework ${i + 20}` }));
  const dir = sandbox({ items: many, config: { ...CONFIG, drive: { maxEmitChars: 200 } } });
  try {
    const run = runRender(dir);
    assert.equal(run.status, 0, "an oversize payload is a warning, not a failed run");
    assert.match(run.stderr + run.stdout, /over the 200-character budget/);
    assert.equal(fs.existsSync(path.join(dir, "data", "payload.b64.txt")), false, "no truncated upload is published");
    const oversize = fs.readFileSync(path.join(dir, "data", "payload.oversize.txt"), "utf8");
    assert.equal(unpack(oversize).data.items.length, many.length, "and the oversize copy is complete");
    // The page still gets everything: the budget only ever applies to the copy
    // that has to travel through a document.
    const html = fs.readFileSync(path.join(dir, "agenda.html"), "utf8");
    assert.equal(unpack(html.match(/var EMBEDDED="(AGD1\.[^"]+)"/)[1]).data.items.length, many.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the page config is substituted, and it is the shape the page reads", () => {
  withRender({ items: [snapItem()] }, (payload, dir, stdout, r) => {
    const m = r.html.match(/var CFG=(\{.*?\});/);
    assert.ok(m, "__PAGE_CONFIG__ must be replaced by a bare object");
    const cfg = JSON.parse(m[1]);
    assert.equal(cfg.ns, "agenda");
    assert.equal(cfg.timezone, TZ);
    assert.deepEqual(cfg.docTitles, {
      data: "agenda-data",
      completions: "agenda-completions",
      commands: "agenda-commands",
    });
    assert.deepEqual(cfg.storageKeys, { marks: "agenda.marks.v1", blocks: "agenda.blocks.v1" });
    assert.equal(cfg.buckets.side, "Side Project");
    assert.equal(cfg.standardsPlan.enabled, false, "the standards card stays hidden unless configured");
  });
});

test("the payload declares version 4 and carries every top-level key the page reads", () => {
  withRender({ items: [snapItem()] }, (payload) => {
    assert.equal(payload.v, 4);
    for (const key of [
      "scrapedAt",
      "tz",
      "weights",
      "schedule",
      "board",
      "done",
      "items",
      "announcements",
      "mail",
      "focus",
      "errors",
    ]) {
      assert.ok(key in payload, `payload is missing "${key}"`);
    }
    assert.equal(payload.tz, TZ);
    assert.ok(Array.isArray(payload.board));
    assert.ok(!("standardsPlan" in payload), "the standards key is absent entirely when the feature is off");
  });
});

test("errors about a skipped course are filtered out; everything else survives", () => {
  // Noise is how a real error gets ignored. The sweep still happened - only the
  // report is filtered, and only for courses the user asked us to skip.
  withRender(
    {
      items: [snapItem()],
      errors: ["SEM 100 content: 403 Forbidden", "MATH 210 grades: timed out"],
    },
    (payload) => {
      assert.deepEqual(payload.errors, ["MATH 210 grades: timed out"]);
    },
  );
});

// ---------------------------------------------------------------------------
// done[] - the three-pass ledger
// ---------------------------------------------------------------------------

test("a plain mark publishes exactly one done entry and no extra fields", () => {
  const it = snapItem();
  const k = keyOf(it);
  const at = iso(-2 * HOUR);
  withRender({ items: [it], completions: { completions: { [k]: { at, via: "page" } } } }, (payload) => {
    assert.deepEqual(payload.done, [{ k, at, via: "page" }]);
    assert.equal("state" in payload.done[0], false, "done is the absent-field default");
    const item = payload.items.find((i) => i.k === k);
    assert.equal(item.s, true, "and the mark still closes its item");
    assert.ok(item.src.includes("user"));
    assert.equal(item.cancelled, undefined);
  });
});

test("done[] is built in three passes: the marks, then the scrape, then the revocations", () => {
  const mine = snapItem({ title: "Homework 2" });
  const scraped = snapItem({ title: "Homework 3", submitted: true });
  const revoked = snapItem({ title: "Homework 4" });
  const kMine = keyOf(mine);
  const kScraped = keyOf(scraped);
  const kRevoked = keyOf(revoked);
  const atMine = iso(-3 * HOUR);
  withRender(
    {
      items: [mine, scraped, revoked],
      diff: { nowSubmitted: [scraped] },
      completions: {
        v: 2,
        completions: { [kMine]: { at: atMine, via: "page" } },
        cleared: { [kRevoked]: { at: iso(-1 * HOUR), via: "user" } },
      },
    },
    (payload) => {
      const by = new Map(payload.done.map((d) => [d.k, d]));
      assert.deepEqual(by.get(kMine), { k: kMine, at: atMine, via: "page" }, "the user's timestamp is the exact one");
      assert.deepEqual(by.get(kScraped), { k: kScraped, at: SCRAPED_AT, via: "grade" }, "the scrape stamps its own");
      assert.equal(by.get(kRevoked).state, "cleared", "and the revocation travels to the page");
      // Newest first, whatever pass wrote it: the scrape ran five minutes ago,
      // the uncheck was an hour ago, the mark was three hours ago.
      assert.deepEqual(payload.done.map((d) => d.k), [kScraped, kRevoked, kMine]);
    },
  );
});

test("a completion from an EARLIER run still refuses a tombstone over it", () => {
  // The item was submitted weeks ago: `s: true` in the snapshot, long gone from
  // diff.json. Seeding the pipeline's claim set from this run's diff alone would
  // publish the tombstone against a graded item - and the digest would then tell
  // the user they have NOT done something they have.
  const graded = snapItem({ title: "Homework 7", submitted: true, sources: ["dropbox"] });
  const k = keyOf(graded);
  withRender(
    {
      items: [graded],
      diff: { nowSubmitted: [] },
      completions: {
        v: 2,
        completions: { [k]: { at: iso(-5 * HOUR), via: "page" } },
        cleared: { [k]: { at: iso(-1 * HOUR), via: "user" } }, // newer: they unchecked it
      },
    },
    (payload) => {
      const entry = payload.done.find((d) => d.k === k);
      assert.ok(entry, "the key still has to say something to the page");
      assert.notEqual(entry.state, "cleared", "a pipeline completion is not the user's to take back");
      assert.deepEqual(entry, { k, at: SCRAPED_AT, via: "grade" });
    },
  );
});

test("a mark that is only the user's own stays revocable", () => {
  // Same shape as the case above, except the pipeline never claimed this key:
  // its `s` is null in the snapshot and only the user's mark ever set it.
  // Seeding the claim set from the APPLIED items[] instead of the raw ones would
  // swallow this revocation too, and unchecking would silently stop working.
  const hers = snapItem({ title: "Homework 8" });
  const k = keyOf(hers);
  withRender(
    {
      items: [hers],
      completions: {
        v: 2,
        completions: { [k]: { at: iso(-5 * HOUR), via: "page" } },
        cleared: { [k]: { at: iso(-1 * HOUR), via: "user" } },
      },
    },
    (payload) => {
      assert.equal(payload.done.find((d) => d.k === k).state, "cleared");
      assert.equal(payload.items.find((i) => i.k === k).s, null, "and the item is open work again");
    },
  );
});

test("a cancelled mark reaches the payload as a state AND an item flag", () => {
  const it = snapItem({ title: "Homework 9" });
  const k = keyOf(it);
  const at = iso(-2 * HOUR);
  withRender(
    { items: [it], completions: { v: 2, completions: { [k]: { at, via: "user", state: "cancelled" } }, cleared: {} } },
    (payload) => {
      assert.deepEqual(payload.done.find((d) => d.k === k), { k, at, via: "user", state: "cancelled" });
      const item = payload.items.find((i) => i.k === k);
      assert.equal(item.cancelled, true);
      assert.equal(item.s, null, "cancelled is not done - the submitted flag must not move");
      assert.equal(
        payload.focus.flatMap((d) => d.blocks).filter((b) => /Homework 9|HW 9/.test(b.what)).length,
        0,
        "and cancelled work draws no study time",
      );
    },
  );
});

test("a session mark travels in done[] and touches no item at all", () => {
  const it = snapItem({ title: "Homework 10" });
  const k = keyOf(it);
  const sessionKey = `fb|${localDayKey(new Date(NOW), TZ)}|MATH 210`;
  const at = iso(-1 * HOUR);
  withRender(
    { items: [it], completions: { v: 2, completions: { [sessionKey]: { at, via: "page" } }, cleared: {} } },
    (payload) => {
      assert.deepEqual(payload.done, [{ k: sessionKey, at, via: "page" }]);
      const item = payload.items.find((i) => i.k === k);
      assert.equal(item.s, null, "the deliverable is untouched");
      assert.equal(item.cancelled, undefined);
      assert.ok(
        payload.focus.flatMap((d) => d.blocks).some((b) => b.c === "MATH 210"),
        "and its blocks are all still there",
      );
    },
  );
});

test("render writes focus-plan.json into the data directory, and it is the payload's own plan", () => {
  withRender({ items: [snapItem()] }, (payload, dir) => {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, "data", "focus-plan.json"), "utf8"));
    assert.equal(plan.v, 1);
    assert.equal(plan.tz, payload.tz);
    assert.match(plan.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(plan.focus, payload.focus, "the chat channel and the page must see one plan");
    assert.equal(plan.focus.length, 7);
    for (const day of plan.focus) assert.match(day.d, /^\d{4}-\d{2}-\d{2}$/);
  });
});

test("an absent user-completions.json is the normal case and publishes nothing", () => {
  withRender({ items: [snapItem()] }, (payload) => {
    assert.deepEqual(payload.done, []);
  });
});

// ---------------------------------------------------------------------------
// The clock: the previous plan, and the session channel
//
// The engine's own suite proves the semantics. What can only be tested here is
// that render.mjs actually THREADS them: the plan it is about to overwrite, and
// one `now` for the whole run. These tests run against the real wall clock (the
// render derives its own `now`), so where the answer depends on the time of day
// they derive the same cut the render did, from the timestamp it wrote.
// ---------------------------------------------------------------------------

/** A block early enough to be behind ANY cut, once the day has started at all. */
const SENTINEL = { c: "CHEM 115", what: "MORNING SENTINEL", why: "the record of the day", t: "08:00", mins: 45 };
/** The instant at which the local clock reads `mins` minutes past midnight today. */
const todayAtLocal = (mins) => new Date(NOW + (mins - localMinuteOfDay(new Date(NOW), TZ)) * 60000);
/**
 * A previous plan written TODAY. The date matters as much as the contents: the
 * render only trusts a plan `generatedAt` today's local day, because a seven-day
 * plan from yesterday also has an entry for today and it is a guess, not a
 * record. Fixtures that want to be believed must be stamped today.
 */
const planWrittenToday = (blocks, day = localDayKey(new Date(NOW), TZ)) => ({
  v: 1,
  generatedAt: todayAtLocal(7 * 60 + 3).toISOString(), // the morning heavy run
  tz: TZ,
  focus: [{ d: day, blocks }],
});

test("the plan on disk is read BEFORE it is overwritten, and today's past is kept", () => {
  withRender(
    {
      items: [snapItem({ course: "CHEM 115", courseId: 110003, title: "Homework 1", due: iso(2 * DAY) })],
      focusPlan: planWrittenToday([SENTINEL]),
    },
    (payload, dir) => {
      const plan = JSON.parse(fs.readFileSync(path.join(dir, "data", "focus-plan.json"), "utf8"));
      const floor = wakeFloor(CONFIG.wakeTime);
      const started = cutMinute(new Date(plan.generatedAt), TZ, floor) > floor;
      const kept = payload.focus[0].blocks.filter((b) => b.kept);

      if (started) {
        assert.deepEqual(kept, [{ ...SENTINEL, kept: true }], "the morning survives the evening render, verbatim");
        assert.equal(payload.focus[0].blocks[0].what, SENTINEL.what, "and leads the day it belongs to");
      } else {
        assert.deepEqual(kept, [], `before the ${CONFIG.wakeTime} wake floor nothing has started yet`);
      }
      assert.deepEqual(plan.focus, payload.focus, "the mirror still matches what the page was given");
      assert.equal(
        payload.focus.slice(1).flatMap((d) => d.blocks).filter((b) => b.kept).length,
        0,
        "only today can have a past",
      );
    },
  );
});

test("the run logs the clock it planned against and what it inherited", () => {
  const today = localDayKey(new Date(NOW), TZ);
  withRender({ items: [snapItem()] }, (payload, dir, stdout) => {
    assert.match(stdout, new RegExp(`today ${today} planned at .+ local: 0 block\\(s\\) kept`));
    assert.match(stdout, /\(no previous plan on disk\)/, "a first run says so rather than looking like an empty day");
  });
  withRender(
    {
      items: [snapItem({ course: "CHEM 115", courseId: 110003, title: "Homework 1", due: iso(2 * DAY) })],
      focusPlan: planWrittenToday([SENTINEL]),
    },
    (payload, dir, stdout) => {
      const kept = payload.focus[0].blocks.filter((b) => b.kept).length;
      const packed = payload.focus[0].blocks.length - kept;
      assert.match(stdout, new RegExp(`${kept} block\\(s\\) kept from the previous plan, ${packed} packed`));
      assert.doesNotMatch(stdout, /no previous plan on disk|previous plan is stale/, "today's plan is not stale");
    },
  );
});

test("a session the user closed today is not re-offered today by the real render", () => {
  const today = localDayKey(new Date(NOW), TZ);
  const it = snapItem({ course: "MATH 210", title: "Homework 11", due: iso(2 * DAY) });
  withRender(
    {
      items: [it],
      completions: { v: 2, completions: { [`fb|${today}|MATH 210`]: { at: iso(-1 * HOUR), via: "page" } }, cleared: {} },
    },
    (payload) => {
      assert.deepEqual(payload.focus[0].blocks.filter((b) => b.c === "MATH 210"), [], "not again today");
      assert.ok(payload.focus[1].blocks.some((b) => b.c === "MATH 210"), "tomorrow is a different session");
      assert.equal(payload.items.find((i) => i.k === keyOf(it)).s, null, "and the deliverable is untouched");
    },
  );
});

// --- with the clock pinned, the whole of the kept-block path is testable ----

const THREE_COURSES = [
  snapItem({ course: "CHEM 115", courseId: 110003, title: "Homework 1", due: iso(2 * DAY) }),
  snapItem({ course: "MATH 210", courseId: 110002, title: "Homework 2", due: iso(2 * DAY) }),
  snapItem({ course: "ART 101", courseId: 110005, title: "Homework 3", due: iso(2 * DAY) }),
];

test("the evening run keeps the morning it published and re-packs only what is left", () => {
  const morning = { c: "CHEM 115", what: "Start Homework 1", why: "due Thursday", t: "08:00", mins: 45 };
  const midday = { c: "MATH 210", what: "Push Homework 2", why: "due Wednesday", t: "12:00", mins: 60 };
  const later = { c: "ART 101", what: "Read chapter 3", why: "due Friday", t: "20:00", mins: 30 };
  withRender(
    {
      items: THREE_COURSES,
      focusPlan: planWrittenToday([morning, midday, later]),
      args: ["--now", todayAtLocal(18 * 60 + 7).toISOString()],
    },
    (payload, dir, stdout) => {
      const day = payload.focus[0].blocks;
      assert.deepEqual(
        day.filter((b) => b.kept),
        [{ ...morning, kept: true }, { ...midday, kept: true }],
        "the two blocks that had started are the record of the day, verbatim and in order",
      );
      assert.ok(!day.some((b) => b.what === later.what), "a block that had NOT started is re-planned, not kept");
      for (const b of day.filter((b) => !b.kept)) {
        assert.ok(b.t >= "18:15", `${b.c} at ${b.t} must sit in the evening that is left (cut 18:15)`);
        assert.ok(!["CHEM 115", "MATH 210"].includes(b.c), "and a kept bucket is never packed twice");
      }
      assert.match(stdout, /2 block\(s\) kept from the previous plan/);
      assert.match(stdout, /planned at 6:07 PM local/);
    },
  );
});

test("the pre-dawn run is the run it always was, previous plan or no previous plan", () => {
  const items = [snapItem({ course: "CHEM 115", courseId: 110003, title: "Homework 1", due: iso(2 * DAY) })];
  const at0703 = ["--now", todayAtLocal(7 * 60 + 3).toISOString()];
  // Written today (00:30, say a re-render after a late-night completion), so the
  // staleness guard passes it through and what is being tested is the ENGINE's
  // floor guard: before the user is awake, nothing has started.
  const overnight = {
    ...planWrittenToday([{ c: "CHEM 115", what: "last night's idea", why: "overnight", t: "08:00", mins: 45 }]),
    generatedAt: todayAtLocal(30).toISOString(),
  };
  withRender({ items, args: at0703 }, (blind) => {
    withRender({ items, focusPlan: overnight, args: at0703 }, (informed) => {
      assert.deepEqual(informed.focus, blind.focus, "before the wake floor the record changes nothing at all");
      assert.equal(informed.focus.flatMap((d) => d.blocks).filter((b) => b.kept).length, 0);
    });
  });
});

test("yesterday's plan is NOT today's record, however many blocks it has for today", () => {
  // The seven-day plan trap. The morning run was missed (a sleeping laptop does
  // it), so the newest file on disk is YESTERDAY's - and a seven-day plan
  // written yesterday contains an entry for today. Honouring it would show the
  // user three blocks they never saw as "the record of their day", spend the
  // whole budget and all three slots on them, and leave the evening empty -
  // while logging "3 kept" as though the run had gone perfectly.
  const yesterdaysGuess = [
    { c: "CHEM 115", what: "GUESS one", why: "written yesterday", t: "08:00", mins: 90 },
    { c: "MATH 210", what: "GUESS two", why: "written yesterday", t: "11:00", mins: 90 },
    { c: "ART 101", what: "GUESS three", why: "written yesterday", t: "14:00", mins: 60 },
  ];
  const today = localDayKey(new Date(NOW), TZ);
  const yesterdayEvening = new Date(todayAtLocal(20 * 60).getTime() - DAY);
  withRender(
    {
      items: THREE_COURSES,
      focusPlan: {
        v: 1,
        generatedAt: yesterdayEvening.toISOString(),
        tz: TZ,
        // Exactly what a real seven-day plan holds: an entry for the day it was
        // written, and six guesses after it - one of which is today.
        focus: [
          {
            d: localDayKey(yesterdayEvening, TZ),
            blocks: [{ c: "CHEM 115", what: "actually yesterday", why: "y", t: "19:00", mins: 60 }],
          },
          { d: today, blocks: yesterdaysGuess },
        ],
      },
      args: ["--now", todayAtLocal(18 * 60 + 7).toISOString()],
    },
    (payload, dir, stdout) => {
      const day = payload.focus[0].blocks;
      assert.deepEqual(day.filter((b) => b.kept), [], "a guess about today is not a record of today");
      assert.equal(day.filter((b) => /^GUESS/.test(b.what)).length, 0, "and none of it is republished");
      assert.ok(day.length > 0, "the evening is planned, not swallowed by a budget spent on fiction");
      for (const b of day) {
        assert.ok(typeof b.t !== "string" || b.t >= "18:15", `${b.c} at ${b.t} belongs to the evening that is left`);
      }
      assert.match(stdout, /0 block\(s\) kept from the previous plan, [1-9]\d* packed/);
      assert.match(
        stdout,
        new RegExp(`\\(previous plan is stale: ${localDayKey(yesterdayEvening, TZ)}\\)`),
        "and the log says WHY it kept nothing - this failure has no other signal",
      );
    },
  );
});

test("a plan with no usable generatedAt is treated as stale, not as today's record", () => {
  withRender(
    {
      items: THREE_COURSES,
      focusPlan: { v: 1, tz: TZ, focus: [{ d: localDayKey(new Date(NOW), TZ), blocks: [SENTINEL] }] },
      args: ["--now", todayAtLocal(18 * 60 + 7).toISOString()],
    },
    (payload, dir, stdout) => {
      assert.deepEqual(payload.focus[0].blocks.filter((b) => b.kept), [], "undated is unproven");
      assert.match(stdout, /\(previous plan is stale: undated\)/);
    },
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a --now the operator fat-fingered stops the render rather than quietly using the real clock", () => {
  const dir = sandbox({ items: [snapItem()] });
  try {
    const run = runRender(dir, ["--now", "half past four"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /bad --now value/);
    assert.equal(fs.existsSync(path.join(dir, "data", "payload.b64.txt")), false, "and publishes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unset timezone stops the render with the onboarding hint, not a stack trace", () => {
  const { timezone, ...noTz } = CONFIG;
  const dir = sandbox({ items: [snapItem()], config: { ...noTz, timezone: "[NOT SET]" } });
  try {
    const run = runRender(dir);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /config: "timezone" is not set yet/);
    assert.match(run.stderr, /say "hey"/);
    assert.doesNotMatch(run.stderr, /at Object\.<anonymous>/, "a new user must not be shown a stack trace");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing snapshot names the file and says what to run instead", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-render-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(dir, "template.html"), TEMPLATE);
  fs.mkdirSync(path.join(dir, "data"));
  try {
    const run = runRender(dir);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /latest\.json does not exist yet/);
    assert.match(run.stderr, /scrape\.mjs/);
    assert.match(run.stderr, /demo\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--gaps lists the undescribed keys and writes absolutely nothing", () => {
  const dir = sandbox({ items: [snapItem(), snapItem({ title: "Homework 12" })] });
  try {
    const run = runRender(dir, ["--gaps"]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /2 item key\(s\) missing a description/);
    assert.match(run.stdout, /110002::homework::homework 2/);
    assert.equal(fs.existsSync(path.join(dir, "data", "payload.b64.txt")), false);
    assert.equal(fs.existsSync(path.join(dir, "data", "focus-plan.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "agenda.html")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test("closing a deliverable frees its blocks all week and grows what is left", () => {
  // The whole product in one test: three courses share the week, one is
  // finished, and the time it was holding goes to the work that is left.
  const heavy = snapItem({ course: "CHEM 115", courseId: 110003, title: "Homework 1", due: iso(2 * DAY) });
  const items = THREE_COURSES;
  const minutes = (payload, day, course) =>
    payload.focus[day].blocks.filter((b) => b.c === course).reduce((n, b) => n + b.mins, 0);

  withRender({ items }, (before) => {
    withRender(
      { items, completions: { v: 2, completions: { [keyOf(heavy)]: { at: iso(-1 * HOUR), via: "page" } }, cleared: {} } },
      (after) => {
        assert.ok(minutes(before, 1, "CHEM 115") > 0, "the finished course was holding time tomorrow");
        assert.equal(
          after.focus.flatMap((d) => d.blocks).filter((b) => b.c === "CHEM 115").length,
          0,
          "and after one mark it holds none, on any day",
        );
        assert.ok(
          minutes(after, 1, "ART 101") > minutes(before, 1, "ART 101"),
          `the freed minutes are re-shared, not dropped ` +
            `(${minutes(before, 1, "ART 101")} -> ${minutes(after, 1, "ART 101")})`,
        );
      },
    );
  });
});

test("the published page template, when present, carries both markers", () => {
  // The stub above proves the substitution; this proves the real template still
  // has somewhere to substitute INTO. It skips on a checkout that has not built
  // the page yet rather than failing for a reason the reader cannot act on.
  const real = path.join(ROOT, "web", "page-template.html");
  if (!fs.existsSync(real)) return;
  const html = fs.readFileSync(real, "utf8");
  assert.ok(html.includes('"__PAYLOAD__"'), "the payload marker must be quoted in the template");
  assert.ok(html.includes("__PAGE_CONFIG__"), "the page-config marker must be bare");
});
