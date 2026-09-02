// node --test test/study-model.test.mjs   (run from the repository root)
//
// The study model is the one place where the agenda stops repeating the user's
// own difficulty priors back at them and starts reading the data. Every term of
// the formula documented in study-model.mjs gets a test here, including the
// clamps - an unclamped signal is how a single 40% quiz would quietly turn a
// 1-weight elective into a 5-weight emergency.
//
// Nothing here reads `data/`. Every input is built in the test, so the suite is
// green on a bare checkout with an empty working directory.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeStudyModel,
  allocWeights,
  pushHistory,
  appendLogEntry,
  studyLogLine,
  parseGradePercent,
  courseFolder,
  bucketOfKey,
  ATTEND_BOOST,
  EXAM_SWING,
  GRADE_SWING,
  BACKLOG_SWING,
  BACKLOG_STEP,
  HISTORY_CAP,
  SIDE_BUCKET,
  FALLBACK_TZ,
} from "../src/study-model.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "America/New_York";

// 2026-08-31 09:00 local = 13:00Z. Monday.
const NOW = new Date("2026-08-31T13:00:00.000Z");
const TODAY = "2026-08-31";

const CONFIG = {
  timezone: TZ,
  courses: [
    { id: 110001, code: "PHYS 221" },
    { id: 110002, code: "MATH 210" },
    { id: 110005, code: "ART 101" },
  ],
  difficulty: { "PHYS 221": 5, "MATH 210": 4, "ART 101": 1, "SEM 100": 0, "Side Project": 3 },
  schedule: {
    "PHYS 221": { room: "HALL 101", attend: false, from: "2026-08-25", until: "2026-12-10", meets: [] },
    "MATH 210": { room: "LAB 110", attend: true, from: "2026-08-25", until: "2026-12-10", meets: [] },
  },
  connectors: { materials: { root: null } },
};

/** v1 snapshot item, the shape data/latest.json actually carries. */
const item = (o) => ({
  courseId: 110005,
  course: "ART 101",
  title: "Homework 1",
  due: "2026-09-05T03:59:00.000Z",
  type: "homework",
  submitted: null,
  sources: ["dropbox"],
  ...o,
});

const model = (o = {}) => computeStudyModel({ config: CONFIG, now: NOW, ...o });
/** alloc ships on one decimal, so expectations round the same way. */
const r1 = (x) => Math.round(x * 10) / 10;
const alloc = (m, bucket) => m.courses[bucket].alloc;

// ---------------------------------------------------------------------------
// The prior and its veto
// ---------------------------------------------------------------------------

test("with no evidence at all the model just repeats the user's priors", () => {
  const m = model({ items: [] });
  assert.equal(alloc(m, "MATH 210"), 4);
  assert.equal(m.courses["MATH 210"].gradeSignal, null);
  assert.equal(m.courses["MATH 210"].paceMinsPerTask, null);
  assert.equal(m.courses["MATH 210"].backlog, 0);
  assert.equal(m.courses["MATH 210"].examDays, null);
});

test("a prior of 0 is a veto, not a starting point (SEM 100 stays 0)", () => {
  const m = model({
    items: [
      item({ courseId: 110006, course: "SEM 100", title: "Seminar attendance", type: "exam", due: "2026-08-31T20:00:00Z" }),
      item({ courseId: 110006, course: "SEM 100", title: "Reflection 1", grade: "40 %" }),
    ],
  });
  assert.equal(alloc(m, "SEM 100"), 0, "a muted course must survive every positive signal");
  assert.match(m.courses["SEM 100"].evidence.join(" "), /muted/);
});

test("alloc never leaves the 0..5 scale however the signals stack", () => {
  const items = [
    item({ course: "PHYS 221", courseId: 110001, title: "Exam 1", type: "exam", due: "2026-08-31T23:00:00Z" }),
    ...Array.from({ length: 9 }, (_, i) =>
      item({ course: "PHYS 221", courseId: 110001, title: `Practice ${i}`, grade: "20 %" }),
    ),
  ];
  const m = model({ items });
  assert.equal(alloc(m, "PHYS 221"), 5, "prior 5 + every boost is still capped at 5");
  assert.ok(alloc(m, "PHYS 221") <= 5 && alloc(m, "PHYS 221") >= 0);
});

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

test("perfect grades ease a course by exactly the clamp, never more", () => {
  const flawless = Array.from({ length: 6 }, (_, i) => item({ title: `Quiz ${i}`, grade: "100 %", submitted: true }));
  const m = model({ items: flawless });
  // prior 1 - GRADE_SWING, floored at 0 by the clamp
  assert.equal(m.courses["ART 101"].gradeSignal, 100);
  assert.equal(alloc(m, "ART 101"), Math.max(0, 1 - GRADE_SWING));
});

test("bad grades raise a course by at most the clamp", () => {
  const m = model({ items: [item({ course: "MATH 210", courseId: 110002, title: "HW 1", grade: "12 %", submitted: true })] });
  assert.equal(alloc(m, "MATH 210"), 4 + GRADE_SWING, "a disaster is worth +1.0, not +5");
});

test("an ungraded course gets a neutral grade term, not a pessimistic one", () => {
  const m = model({ items: [item({ course: "MATH 210", courseId: 110002, title: "HW 1" })] });
  assert.equal(m.courses["MATH 210"].gradeSignal, null);
  assert.match(m.courses["MATH 210"].evidence.join(" "), /no graded work yet/);
});

test("parseGradePercent reads the display strings Brightspace actually sends", () => {
  assert.equal(parseGradePercent("100 %"), 100);
  assert.equal(parseGradePercent("87.5%"), 87.5);
  assert.equal(parseGradePercent("18 / 20"), 90);
  assert.equal(parseGradePercent("not graded"), null);
  assert.equal(parseGradePercent(null), null);
});

// ---------------------------------------------------------------------------
// Exam / sitting proximity
// ---------------------------------------------------------------------------

test("an exam today is worth the full proximity swing, one a fortnight out nothing", () => {
  const today = model({ items: [item({ title: "Exam 1", type: "exam", due: "2026-08-31T23:00:00Z" })] });
  assert.equal(today.courses["ART 101"].examDays, 0);
  // prior 1 + the full exam swing + the one open item it also counts as backlog
  assert.equal(alloc(today, "ART 101"), r1(1 + EXAM_SWING + BACKLOG_STEP));

  const far = model({ items: [item({ title: "Exam 1", type: "exam", due: "2026-09-30T23:00:00Z" })] });
  assert.equal(alloc(far, "ART 101"), 1, "a month out is not urgency");
});

test("only sittings the user actually sits create urgency (attending:false is history)", () => {
  const plan = {
    course: "PHYS 221",
    sittings: [
      { date: "2026-09-02", kind: "reassessment", attending: false, targets: ["C1"] },
      { date: "2026-09-04", kind: "reassessment", targets: ["C1"] }, // unknown signup
    ],
  };
  const skipped = model({ items: [], studyPlan: plan });
  assert.equal(skipped.courses["PHYS 221"].examDays, null, "skipped and unknown sittings are not deadlines");

  const signedUp = model({
    items: [],
    studyPlan: { course: "PHYS 221", sittings: [{ date: "2026-09-02", kind: "reassessment", attending: true }] },
  });
  assert.equal(signedUp.courses["PHYS 221"].examDays, 2);
  assert.ok(alloc(signedUp, "PHYS 221") > 0);
});

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

test("open work piles up to the backlog clamp and no further", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    item({ course: "MATH 210", courseId: 110002, title: `HW ${i}`, due: "2026-09-05T03:59:00.000Z" }),
  );
  const m = model({ items: many });
  assert.equal(m.courses["MATH 210"].backlog, 12);
  assert.equal(alloc(m, "MATH 210"), 4 + BACKLOG_SWING);
});

test("submitted and user-completed work is not backlog", () => {
  const items = [
    item({ course: "MATH 210", courseId: 110002, title: "HW 1", submitted: true }),
    item({ course: "MATH 210", courseId: 110002, title: "HW 2" }),
  ];
  const withCompletion = model({
    items,
    userCompletions: { completions: { "110002::homework::hw 2": { at: "2026-08-31T12:00:00Z", via: "user" } } },
  });
  assert.equal(withCompletion.courses["MATH 210"].backlog, 0, "declaring it done removes it from the pile");
});

test("work outside the backlog window does not count", () => {
  const m = model({ items: [item({ course: "MATH 210", courseId: 110002, title: "Final report", due: "2026-12-01T05:00:00Z" })] });
  assert.equal(m.courses["MATH 210"].backlog, 0);
});

// ---------------------------------------------------------------------------
// Observed pace
// ---------------------------------------------------------------------------

test("no study log means no pace term at all", () => {
  const m = model({ items: [item()], studyLog: { entries: [] } });
  assert.equal(m.courses["ART 101"].paceMinsPerTask, null);
  assert.equal(m.courses["ART 101"].loggedMins, 0);
  assert.equal(alloc(m, "ART 101"), r1(1 + BACKLOG_STEP), "only the one open item moves it, not the empty log");
});

test("minutes without completions is still no pace (nothing to divide by)", () => {
  const m = model({
    items: [item()],
    studyLog: { entries: [{ at: "2026-08-30T20:00:00Z", c: "ART 101", mins: 240 }] },
  });
  assert.equal(m.courses["ART 101"].loggedMins, 240);
  assert.equal(m.courses["ART 101"].paceMinsPerTask, null);
});

test("a course that eats hours per finished task is pushed up, a fast one down", () => {
  const items = [item({ course: "MATH 210", courseId: 110002, title: "HW 1", submitted: true })];
  const completions = { completions: { "110002::homework::hw 1": { at: "2026-08-30T18:00:00Z", via: "user" } } };
  const slow = model({
    items,
    userCompletions: completions,
    studyLog: { entries: [{ at: "2026-08-30T14:00:00Z", c: "MATH 210", mins: 300 }] },
  });
  assert.equal(slow.courses["MATH 210"].paceMinsPerTask, 300);
  assert.ok(alloc(slow, "MATH 210") > 4, "300 min for one deliverable means the prior was too low");

  const fast = model({
    items,
    userCompletions: completions,
    studyLog: { entries: [{ at: "2026-08-30T14:00:00Z", c: "MATH 210", mins: 30 }] },
  });
  assert.ok(alloc(fast, "MATH 210") < 4, "half an hour per deliverable means the prior was too high");
});

test("study-log entries older than the pace window are ignored", () => {
  const m = model({
    items: [item({ course: "MATH 210", courseId: 110002, title: "HW 1", submitted: true })],
    userCompletions: { completions: { "110002::homework::hw 1": { at: "2026-08-30T18:00:00Z", via: "user" } } },
    studyLog: { entries: [{ at: "2026-05-01T14:00:00Z", c: "MATH 210", mins: 600 }] },
  });
  assert.equal(m.courses["MATH 210"].loggedMins, 0);
  assert.equal(m.courses["MATH 210"].paceMinsPerTask, null);
});

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

test("a course the user does not attend gets the self-study boost", () => {
  const m = model({ items: [] });
  assert.equal(alloc(m, "PHYS 221"), Math.min(5, 5 + ATTEND_BOOST));
  assert.match(m.courses["PHYS 221"].evidence.join(" "), /attend:false/);
  // MATH 210 is attended - no boost.
  assert.equal(alloc(m, "MATH 210"), 4);
  assert.ok(!/attend:false/.test(m.courses["MATH 210"].evidence.join(" ")));
});

test("the self-study boost stops when the course does", () => {
  const config = {
    ...CONFIG,
    difficulty: { "HIST 140": 3 },
    schedule: { "HIST 140": { attend: false, from: "2026-01-12", until: "2026-05-08", meets: [] } },
  };
  const m = computeStudyModel({ config, items: [], now: NOW });
  assert.equal(m.courses["HIST 140"].alloc, 3, "a course that ended last spring is not self-study today");
});

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

test("an empty board eases the side project below its prior", () => {
  const m = model({ items: [], board: [] });
  assert.equal(alloc(m, "Side Project"), 2, "prior 3 - 1.0 idle");
});

test("a busy board raises it to the board clamp", () => {
  const board = Array.from({ length: 15 }, (_, n) => ({ repo: "example-api", n, t: `Issue ${n}`, kind: "issue" }));
  const m = model({ items: [], board: board });
  assert.equal(alloc(m, "Side Project"), 4, "prior 3 + 1.0 board clamp");
});

test("a missing board-items.json is simply an idle board, never a crash", () => {
  const m = computeStudyModel({ config: CONFIG, items: [], now: NOW, board: undefined });
  assert.equal(typeof m.courses[SIDE_BUCKET].alloc, "number");
});

test("the side-project bucket takes its name from the config, not from a constant", () => {
  const renamed = {
    ...CONFIG,
    sideProject: { enabled: true, label: "Studio" },
    difficulty: { ...CONFIG.difficulty, Studio: 3 },
  };
  const m = computeStudyModel({ config: renamed, items: [], now: NOW, board: [] });
  assert.equal(m.courses.Studio.alloc, 2, "prior 3 - 1.0 idle, under the user's own label");
  assert.match(m.courses.Studio.evidence.join(" "), /no open board entries/);
  // "Side Project" is only the fallback label; with a custom one it carries no
  // board term at all, so its default prior stands untouched.
  assert.ok(!/open board entr/.test((m.courses[SIDE_BUCKET]?.evidence ?? []).join(" ")));
});

// ---------------------------------------------------------------------------
// Shape, history, and the small helpers
// ---------------------------------------------------------------------------

test("every bucket reports the fields docs/PROTOCOL.md promises", () => {
  const m = model({ items: [item()] });
  for (const [bucket, row] of Object.entries(m.courses)) {
    for (const field of ["prior", "gradeSignal", "backlog", "examDays", "paceMinsPerTask", "alloc", "evidence"]) {
      assert.ok(field in row, `${bucket} is missing ${field}`);
    }
    assert.ok(Array.isArray(row.evidence) && row.evidence.length, `${bucket} must explain itself`);
    assert.equal(row.alloc, Math.round(row.alloc * 10) / 10, "alloc stays on one decimal");
  }
  assert.equal(m.today, TODAY);
});

test("the model is deterministic: same inputs, same numbers", () => {
  const inputs = { items: [item({ grade: "70 %" })], board: [{ repo: "r", n: 1, t: "x" }] };
  assert.deepEqual(model(inputs).courses, model(inputs).courses);
});

test("allocWeights is just the alloc column", () => {
  const m = model({ items: [] });
  const w = allocWeights(m);
  assert.equal(w["PHYS 221"], m.courses["PHYS 221"].alloc);
  assert.equal(w["SEM 100"], 0);
  assert.equal(allocWeights(null)["PHYS 221"], undefined);
});

test("history keeps the newest first and never grows past the cap", () => {
  let history = [];
  for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
    history = pushHistory(history, { updated: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, courses: { X: { alloc: i } } });
  }
  assert.equal(history.length, HISTORY_CAP);
  assert.equal(history[0].alloc.X, HISTORY_CAP + 4, "newest first");
});

test("appendLogEntry never mutates the log it was handed", () => {
  const log = { entries: [{ at: "2026-08-30T00:00:00Z", c: "MATH 210", mins: 60, note: "" }] };
  const next = appendLogEntry(log, { at: "2026-08-31T00:00:00Z", c: "Side Project", mins: 90, note: "PR review" });
  assert.equal(log.entries.length, 1);
  assert.equal(next.entries.length, 2);
  assert.equal(next.entries[1].c, "Side Project");
});

test("the mirrored markdown line is one ASCII line, in the zone it is told", () => {
  const entry = { at: "2026-08-31T20:30:00Z", c: "MATH 210", mins: 90, note: "root locus" };
  const line = studyLogLine(entry, TZ);
  assert.equal(line, "- 2026-08-31 16:30 - 90 min - root locus");
  assert.ok(!/[^\x20-\x7e]/.test(line), "ASCII only");
  assert.ok(!line.includes("\n"));
  // No zone given is not a guess about where the user lives: it is UTC.
  assert.equal(studyLogLine(entry), "- 2026-08-31 20:30 - 90 min - root locus");
  assert.equal(studyLogLine(entry, FALLBACK_TZ), studyLogLine(entry));
});

test("courseFolder matches the course-materials tree naming", () => {
  assert.equal(courseFolder("MATH 210"), "MATH-210");
  assert.equal(courseFolder("ART 101"), "ART-101");
  assert.equal(courseFolder("Side Project"), "Side-Project");
});

test("bucketOfKey resolves through the items first, then the courseId", () => {
  const items = [item({ course: "ART 101", title: "Homework 1" })];
  assert.equal(bucketOfKey("110005::homework::homework 1", items, CONFIG), "ART 101");
  assert.equal(bucketOfKey("110002::homework::gone from the snapshot", items, CONFIG), "MATH 210");
  assert.equal(bucketOfKey("0::task::a side project thing", items, CONFIG), null);
});

// ---------------------------------------------------------------------------
// The standards plan is optional, and "off" must be a quiet, working state
// ---------------------------------------------------------------------------

test("with no standards course configured the sitting path is skipped entirely", () => {
  // A plan file with sittings but no `course`, and a config whose standardsPlan
  // is off. Nothing may adopt those sittings as a deadline for some bucket.
  const plan = { sittings: [{ date: "2026-09-02", kind: "reassessment", attending: true, targets: ["C1"] }] };
  const m = computeStudyModel({ config: CONFIG, items: [], now: NOW, studyPlan: plan });
  for (const [bucket, row] of Object.entries(m.courses)) {
    assert.equal(row.examDays, null, `${bucket} must have no assessment when no standards course is configured`);
  }
});

test("an enabled standardsPlan supplies the course a plan file does not name", () => {
  const cfg = { ...CONFIG, standardsPlan: { enabled: true, course: "PHYS 221", label: "Standards" } };
  const plan = { sittings: [{ date: "2026-09-02", kind: "reassessment", attending: true, targets: ["C1"] }] };
  const m = computeStudyModel({ config: cfg, items: [], now: NOW, studyPlan: plan });
  assert.equal(m.courses["PHYS 221"].examDays, 2, "config named the course, so its sittings count");
  assert.equal(m.courses["MATH 210"].examDays, null, "and only that course's");

  // The plan file still wins when it names one itself.
  const owned = computeStudyModel({ config: cfg, items: [], now: NOW, studyPlan: { ...plan, course: "MATH 210" } });
  assert.equal(owned.courses["MATH 210"].examDays, 2);
  assert.equal(owned.courses["PHYS 221"].examDays, null);
});

test("a disabled standardsPlan is not a course code, even with a course written in it", () => {
  const cfg = { ...CONFIG, standardsPlan: { enabled: false, course: "PHYS 221", label: "Standards" } };
  const plan = { sittings: [{ date: "2026-09-02", kind: "reassessment", attending: true }] };
  const m = computeStudyModel({ config: cfg, items: [], now: NOW, studyPlan: plan });
  assert.equal(m.courses["PHYS 221"].examDays, null, "off means dormant, not 'use it anyway'");
});

// ---------------------------------------------------------------------------
// The model's allocs are what ship as the payload `weights`
// ---------------------------------------------------------------------------

test("a persisted model round-trips through allocWeights", () => {
  const m = model({ items: [item({ grade: "70 %" })], board: [{ repo: "example-api", n: 1, t: "x", kind: "issue" }] });
  const persisted = JSON.parse(JSON.stringify({ ...m, history: pushHistory([], m) }));
  const weights = allocWeights(persisted);
  for (const [bucket, row] of Object.entries(m.courses)) {
    assert.equal(weights[bucket], row.alloc, `weights.${bucket} must be the model's alloc`);
    assert.equal(typeof weights[bucket], "number");
  }
  assert.equal(persisted.history[0].alloc["MATH 210"], m.courses["MATH 210"].alloc);
});

test("model allocs override config.difficulty the way the render composes weights", () => {
  // render.mjs builds `weights` as {...config.difficulty, ...allocWeights(model)}.
  // Reproduce that composition here so the precedence has a test of its own.
  const m = model({ items: [item({ course: "MATH 210", courseId: 110002, title: "HW 1", grade: "12 %", submitted: true })] });
  const weights = { ...CONFIG.difficulty, ...allocWeights(m) };
  assert.equal(weights["MATH 210"], m.courses["MATH 210"].alloc);
  assert.notEqual(weights["MATH 210"], CONFIG.difficulty["MATH 210"], "evidence moved it off the prior");
  // A bucket the model never scored keeps the user's own number.
  const sparse = { ...CONFIG.difficulty, Research: 3 };
  assert.equal({ ...sparse, ...allocWeights({ courses: {} }) }.Research, 3);
});

test("every bucket in a persisted model carries a one-decimal alloc inside 0..5", () => {
  const m = model({ items: [item({ grade: "40 %" })], board: [] });
  for (const [bucket, row] of Object.entries(m.courses)) {
    assert.ok(row.alloc >= 0 && row.alloc <= 5, `${bucket} alloc ${row.alloc} left the scale`);
    assert.equal(row.alloc, Math.round(row.alloc * 10) / 10, `${bucket} alloc is not on one decimal`);
  }
});

// ---------------------------------------------------------------------------
// The CLI: --config / --data, and the materials mirror
// ---------------------------------------------------------------------------

/** A throwaway repo-shaped scratch dir: a config file and an empty data dir. */
function scratch(config) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agenda-study-model-"));
  const dataDir = path.join(dir, "data");
  mkdirSync(dataDir);
  const configFile = path.join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  return { dir, dataDir, configFile };
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [path.join(REPO, "src", "study-model.mjs"), ...args], {
    cwd: cwd ?? REPO,
    encoding: "utf8",
  });
}

test("--log writes only the study log when no materials root is configured", () => {
  const { dataDir, configFile } = scratch({ ...CONFIG, connectors: { materials: { root: null } } });
  const out = runCli(["--log", "MATH 210", "45", "row reduction", "--config", configFile, "--data", dataDir]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /logged 45 min on MATH 210/);
  assert.ok(!/mirrored to/.test(out.stdout), "nowhere to mirror to is a no-op, not a throw");
  const log = JSON.parse(readFileSync(path.join(dataDir, "study-log.json"), "utf8"));
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].mins, 45);
});

test("--log mirrors into the materials tree only when the course folder already exists", () => {
  const { dir, dataDir, configFile } = scratch(CONFIG);
  const materials = path.join(dir, "coursework");
  mkdirSync(path.join(materials, "MATH-210"), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ ...CONFIG, connectors: { materials: { root: materials } } }, null, 2));

  const mirrored = runCli(["--log", "MATH 210", "60", "notes", "--config", configFile, "--data", dataDir]);
  assert.equal(mirrored.status, 0, mirrored.stdout + mirrored.stderr);
  assert.match(mirrored.stdout, /mirrored to/);
  const md = readFileSync(path.join(materials, "MATH-210", "study-log.md"), "utf8");
  assert.match(md, /# MATH 210 study log/);
  assert.match(md, /- 60 min - notes/);

  // A course with no folder is skipped in silence: this script never creates one.
  const skipped = runCli(["--log", "PHYS 221", "30", "", "--config", configFile, "--data", dataDir]);
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.ok(!/mirrored to/.test(skipped.stdout));
  assert.equal(existsSync(path.join(materials, "PHYS-221")), false, "no folder was created");
});

test("--log refuses a bucket the config does not know (exit 4, the typo guard)", () => {
  const { dataDir, configFile } = scratch(CONFIG);
  const out = runCli(["--log", "MATH 2100", "30", "", "--config", configFile, "--data", dataDir]);
  assert.equal(out.status, 4);
  assert.match(out.stdout, /unknown bucket "MATH 2100"/);
  assert.equal(existsSync(path.join(dataDir, "study-log.json")), false, "nothing is written on a refusal");
});

test("--refresh without a snapshot exits 3 and says which file is missing", () => {
  const { dataDir, configFile } = scratch(CONFIG);
  const out = runCli(["--refresh", "--config", configFile, "--data", dataDir]);
  assert.equal(out.status, 3);
  assert.match(out.stdout, /cannot read data\/latest\.json/);
});

test("--refresh reads --data and writes the model back into it", () => {
  const { dataDir, configFile } = scratch(CONFIG);
  writeFileSync(
    path.join(dataDir, "latest.json"),
    JSON.stringify({ scrapedAt: NOW.toISOString(), items: [item({ grade: "40 %", submitted: true })] }),
  );
  const out = runCli(["--refresh", "--config", configFile, "--data", dataDir]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const written = JSON.parse(readFileSync(path.join(dataDir, "study-model.json"), "utf8"));
  assert.ok(written.courses["ART 101"], "the snapshot's bucket is in the model");
  assert.equal(written.history.length, 1);
  assert.deepEqual(allocWeights(written)["ART 101"], written.courses["ART 101"].alloc);
});
