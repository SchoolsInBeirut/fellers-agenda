// study-model.mjs - the deterministic "how much of my week does this course
// deserve?" model for the agenda.
//
// config.difficulty is what the USER believes about each course. This file is
// what the DATA says about it: grades that came back, exams closing in, work
// piling up, minutes actually spent, and lectures that are not being attended.
// The result is data/study-model.json, whose `alloc` numbers become the payload
// `weights` and feed focus-engine.mjs as allocWeights.
//
// PURE CORE: computeStudyModel() does no I/O. The CLI at the bottom is the only
// impure part.
//
// ---------------------------------------------------------------------------
// THE FORMULA (deterministic, no randomness, no clock beyond `now`)
//
//   alloc(bucket) = clamp(0, 5, prior + grade + exam + backlog + pace + attend
//                                     [+ board, the side-project bucket only])
//   rounded to one decimal place.
//
// A prior of 0 is a veto, not a starting point: alloc stays exactly 0. Scoring a
// course 0 in config.difficulty is how a user keeps a zero-work seminar out of
// the focus strip entirely, and no amount of evidence may overrule that.
//
//   prior      config.difficulty[bucket], else DEFAULT_PRIOR (2). Range 0..5.
//              A bucket the user scored 0 never gets time - see the veto below.
//
//   grade      GRADE_SWING * (GRADE_PIVOT - gradeSignal) / GRADE_SPAN,
//              clamped to +/-GRADE_SWING (1.0).
//              gradeSignal = mean of the percentages parsed out of the items'
//              `g` / `grade` display strings for this bucket ("100 %" -> 100).
//              Pivot 85, span 15: 70% or below -> +1.0 (needs the time), 85% ->
//              0, 100% -> -1.0 (coasting, give the hours to something else).
//              No graded items -> gradeSignal null -> 0. Silence is not a grade.
//
//   exam       EXAM_SWING * (1 - examDays / EXAM_HORIZON), floored at 0.
//              examDays = whole days from today to the next assessment for this
//              bucket: an items[] entry of type "exam", or - for the configured
//              standards course, when that feature is on - a sittings[] entry
//              the user is ACTUALLY sitting
//              (focus-engine sittingAttendance() === "yes"; a skipped or
//              unknown-signup reassessment contributes nothing, same rule as
//              the focus engine). Today -> +1.5, a week out -> +0.75, 14 days
//              or more -> 0, none known -> 0.
//
//   backlog    min(BACKLOG_SWING, BACKLOG_STEP * backlog), where backlog counts
//              OPEN items for the bucket (not submitted, not user-completed)
//              due between BACKLOG_OVERDUE_DAYS behind and BACKLOG_AHEAD_DAYS
//              ahead of today. 4 open items saturates it at +1.0.
//
//   pace       PACE_SWING * (paceMinsPerTask - PACE_PIVOT) / PACE_SPAN, clamped
//              to +/-PACE_SWING (0.5). paceMinsPerTask = logged minutes for the
//              bucket in the last PACE_WINDOW_DAYS divided by the number of
//              things finished in the same window (user-completions resolved to
//              this bucket). A course that eats 3 hours per finished task is
//              harder than the prior admits (+); one that closes tasks in 45
//              minutes is easier (-). No log or nothing finished -> null -> 0.
//
//   attend     +ATTEND_BOOST (0.5) when config.schedule[bucket].attend === false
//              and today is inside the course's from/until range. For a course
//              whose lectures the user does not attend, self-study has to
//              REPLACE the lecture hours rather than merely supplement them.
//
//   board      the side-project bucket only. No open board entries -> -SIDE_IDLE (1.0),
//              because an empty board is the only honest evidence that the
//              side project needs nothing this week. Otherwise
//              min(BOARD_SWING, BOARD_STEP * openEntries) (+1.0 max).
//
// Everything above is additive and clamped independently, so the worst case
// swing around the user's prior is about -2.5 .. +4.5 before the final clamp.
//
// ---------------------------------------------------------------------------
// CLI
//   node src/study-model.mjs --refresh              recompute, write data/study-model.json
//   node src/study-model.mjs --show                 print the current model, write nothing
//   node src/study-model.mjs --log "MATH 210" 90 "note"
//                                               append to data/study-log.json and
//                                               mirror one line into
//                                               <materials.root>/MATH-210/study-log.md
//                                               WHEN that folder already exists
//                                               (the course-materials tree belongs
//                                               to materials-sync.mjs - this script
//                                               never creates a folder in it)
//
// Every command also accepts --config <path> and --data <dir>.
//
// Exit codes:
//   0  ok
//   2  usage error
//   3  a required input (the config / data/latest.json) is missing or unreadable
//   4  --log target bucket is not a known bucket (typo guard)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { completionsMap, readItem } from "./completion.mjs";
import { dayDiff, localDayKey, sittingAttendance } from "./focus-engine.mjs";
import { derive, loadConfig, standardsCourse } from "./lib/config.mjs";
import { configPath, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";

// --- tunables (all documented in the header formula) ------------------------
export const DEFAULT_PRIOR = 2;
export const GRADE_PIVOT = 85;
export const GRADE_SPAN = 15;
export const GRADE_SWING = 1.0;
export const EXAM_HORIZON = 14;
export const EXAM_SWING = 1.5;
export const BACKLOG_STEP = 0.25;
export const BACKLOG_SWING = 1.0;
export const BACKLOG_AHEAD_DAYS = 14;
export const BACKLOG_OVERDUE_DAYS = 7;
export const PACE_PIVOT = 90;
export const PACE_SPAN = 90;
export const PACE_SWING = 0.5;
export const PACE_WINDOW_DAYS = 21;
export const ATTEND_BOOST = 0.5;
/**
 * The side-project bucket's label when the config does not name one.
 * `config.sideProject.label` wins wherever it is set; this is only the fallback
 * that keeps the module usable with a bare `{}` config.
 */
export const SIDE_BUCKET = "Side Project";
/**
 * The zone to reckon "which day is it" in when nobody has said. UTC is the only
 * answer that is not a guess about where the user lives; every real run threads
 * `config.timezone` through instead.
 */
export const FALLBACK_TZ = "UTC";
export const SIDE_IDLE = 1.0;
export const BOARD_STEP = 0.25;
export const BOARD_SWING = 1.0;
export const MAX_ALLOC = 5;
export const HISTORY_CAP = 30;

const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** "92.5 %" / "18 / 20" -> 92.5 / 90. null when the string carries no percentage. */
export function parseGradePercent(text) {
  if (typeof text !== "string") return null;
  const pct = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const v = Number.parseFloat(pct[1]);
    return Number.isFinite(v) ? v : null;
  }
  const frac = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (frac) {
    const den = Number.parseFloat(frac[2]);
    const nu = Number.parseFloat(frac[1]);
    if (Number.isFinite(den) && den > 0 && Number.isFinite(nu)) return (nu / den) * 100;
  }
  return null;
}

/** "MATH 210" -> "MATH-210": the folder name the course-materials tree uses. */
export function courseFolder(bucket) {
  return String(bucket ?? "").trim().replace(/\s+/g, "-");
}

/** courseId -> course code, from config.courses. */
function courseIdIndex(config) {
  const idx = new Map();
  for (const c of config?.courses ?? []) if (c?.id != null && c?.code) idx.set(String(c.id), c.code);
  return idx;
}

/**
 * Which bucket does an itemKey belong to? Items win (they carry the display
 * bucket outright); a key that matches nothing falls back to its courseId
 * prefix, which is how a completion for an item that has since left the
 * snapshot still counts toward that course's pace.
 */
export function bucketOfKey(key, items, config) {
  const k = String(key ?? "");
  if (!k) return null;
  for (const it of items ?? []) {
    const view = readItem(it);
    if (view.key === k && view.course) return view.course;
  }
  const cid = k.split("::")[0];
  return courseIdIndex(config).get(cid) ?? null;
}

/**
 * The full bucket list: everything the user weighted, plus every bucket that
 * actually shows up in the data, plus the side-project bucket - which exists
 * whether or not anyone has scored it, because an idle board is itself a
 * finding. Sorted so output files diff cleanly.
 */
function allBuckets(config, items, sideBucket) {
  const set = new Set(Object.keys(config?.difficulty ?? {}));
  for (const it of items ?? []) {
    const c = readItem(it).course;
    if (c) set.add(c);
  }
  set.add(sideBucket);
  return [...set].sort();
}

/** Is `dayKey` inside this schedule entry's from/until range? */
function scheduleActive(entry, todayKey) {
  if (!entry) return false;
  if (entry.from && todayKey < entry.from) return false;
  if (entry.until && todayKey > entry.until) return false;
  return true;
}

/**
 * Compute the study model.
 *
 * @param {object} o
 * @param {object} o.config           the loaded config (difficulty, schedule, courses, sideProject)
 * @param {Array}  o.items            snapshot items from data/latest.json (compact shape tolerated)
 * @param {object} o.studyLog         data/study-log.json  {entries:[{at,c,mins,note}]}
 * @param {object} o.userCompletions  data/user-completions.json (wrapper or bare map)
 * @param {object} o.studyPlan        data/study-plan.json (sittings drive exam proximity)
 * @param {Array}  o.board            data/board-items.json board[] (may be empty)
 * @param {Date}   o.now              evaluation instant
 * @param {string} o.tz               IANA zone for "which day is it"; defaults to
 *                                    config.timezone, then FALLBACK_TZ
 * @returns {{updated:string, today:string, courses:object}}
 */
export function computeStudyModel({
  config = {},
  items = [],
  studyLog = null,
  userCompletions = null,
  studyPlan = null,
  board = [],
  now = new Date(),
  tz = null,
} = {}) {
  const zone = tz || config?.timezone || FALLBACK_TZ;
  const todayKey = localDayKey(now, zone) ?? new Date().toISOString().slice(0, 10);
  const completions = completionsMap(userCompletions);
  const logEntries = Array.isArray(studyLog?.entries) ? studyLog.entries : Array.isArray(studyLog) ? studyLog : [];
  const boardEntries = Array.isArray(board) ? board : [];
  const sideBucket = derive(config).sideBucket;
  // null means the standards-plan feature is off. Everything downstream treats
  // that as "this subsystem is dormant" - never as an error, and never as a
  // course code that some bucket might accidentally match.
  const planCourse = studyPlan?.course ?? standardsCourse(config) ?? null;

  // One pass over the items, bucketed.
  const views = (items ?? []).map((it) => readItem(it)).filter((v) => v.course);
  const gradeOf = (it) => parseGradePercent(it?.g ?? it?.grade ?? null);

  // Study-log minutes per bucket inside the pace window.
  const loggedByBucket = new Map();
  for (const e of logEntries) {
    const bucket = e?.c ?? e?.course;
    const mins = num(e?.mins);
    if (!bucket || mins === null || mins <= 0) continue;
    const day = e?.at ? localDayKey(e.at, zone) : null;
    if (day && dayDiff(day, todayKey) > PACE_WINDOW_DAYS) continue;
    loggedByBucket.set(bucket, (loggedByBucket.get(bucket) ?? 0) + mins);
  }

  // Completions per bucket inside the same window (the denominator of pace).
  const closedByBucket = new Map();
  for (const [key, entry] of Object.entries(completions)) {
    const bucket = bucketOfKey(key, items, config);
    if (!bucket) continue;
    const day = entry?.at ? localDayKey(entry.at, zone) : null;
    if (day && dayDiff(day, todayKey) > PACE_WINDOW_DAYS) continue;
    closedByBucket.set(bucket, (closedByBucket.get(bucket) ?? 0) + 1);
  }

  // Assessment dates the user is really sitting, for the study-plan course.
  const planSittingDays = (studyPlan?.sittings ?? [])
    .filter((s) => s?.date && sittingAttendance(s) === "yes")
    .map((s) => dayDiff(todayKey, s.date))
    .filter((d) => Number.isFinite(d) && d >= 0);

  const courses = {};
  for (const bucket of allBuckets(config, items, sideBucket)) {
    const prior = num(config?.difficulty?.[bucket]) ?? DEFAULT_PRIOR;
    const evidence = [`prior ${prior.toFixed(1)} from config.difficulty`];

    if (prior <= 0) {
      courses[bucket] = {
        prior,
        gradeSignal: null,
        gradedItems: 0,
        backlog: 0,
        examDays: null,
        paceMinsPerTask: null,
        loggedMins: 0,
        alloc: 0,
        evidence: [...evidence, "prior 0 - muted, never appears in the focus strip"],
      };
      continue;
    }

    const mine = (items ?? []).filter((it) => readItem(it).course === bucket);

    // --- grade signal ------------------------------------------------------
    const grades = mine.map(gradeOf).filter((g) => g !== null);
    const gradeSignal = grades.length ? round1(grades.reduce((s, g) => s + g, 0) / grades.length) : null;
    const gradeAdj =
      gradeSignal === null ? 0 : clamp((GRADE_SWING * (GRADE_PIVOT - gradeSignal)) / GRADE_SPAN, -GRADE_SWING, GRADE_SWING);
    evidence.push(
      gradeSignal === null
        ? "no graded work yet - grade signal neutral"
        : `grade signal ${gradeSignal}% over ${grades.length} graded item(s) -> ${gradeAdj >= 0 ? "+" : ""}${round1(gradeAdj)}`,
    );

    // --- exam / sitting proximity -----------------------------------------
    const examOffsets = mine
      .filter((it) => readItem(it).type === "exam" && readItem(it).due)
      .map((it) => dayDiff(todayKey, localDayKey(readItem(it).due, zone)))
      .filter((d) => Number.isFinite(d) && d >= 0);
    if (planCourse !== null && bucket === planCourse) examOffsets.push(...planSittingDays);
    const examDays = examOffsets.length ? Math.min(...examOffsets) : null;
    const examAdj = examDays === null ? 0 : Math.max(0, EXAM_SWING * (1 - examDays / EXAM_HORIZON));
    evidence.push(
      examDays === null
        ? "no assessment on the horizon"
        : `next assessment in ${examDays} day(s) -> +${round1(examAdj)}`,
    );

    // --- open backlog ------------------------------------------------------
    const backlog = mine.filter((it) => {
      const view = readItem(it);
      if (view.submitted === true) return false;
      if (view.key && Object.prototype.hasOwnProperty.call(completions, view.key)) return false;
      if (!view.due) return false;
      const off = dayDiff(todayKey, localDayKey(view.due, zone));
      return Number.isFinite(off) && off <= BACKLOG_AHEAD_DAYS && off >= -BACKLOG_OVERDUE_DAYS;
    }).length;
    const backlogAdj = Math.min(BACKLOG_SWING, BACKLOG_STEP * backlog);
    evidence.push(`${backlog} open item(s) inside the backlog window -> +${round1(backlogAdj)}`);

    // --- observed pace -----------------------------------------------------
    const loggedMins = loggedByBucket.get(bucket) ?? 0;
    const closed = closedByBucket.get(bucket) ?? 0;
    const paceMinsPerTask = closed > 0 && loggedMins > 0 ? Math.round(loggedMins / closed) : null;
    const paceAdj =
      paceMinsPerTask === null
        ? 0
        : clamp((PACE_SWING * (paceMinsPerTask - PACE_PIVOT)) / PACE_SPAN, -PACE_SWING, PACE_SWING);
    evidence.push(
      paceMinsPerTask === null
        ? `no pace evidence (${loggedMins} logged min, ${closed} completion(s) in ${PACE_WINDOW_DAYS} days)`
        : `${paceMinsPerTask} min per finished task -> ${paceAdj >= 0 ? "+" : ""}${round1(paceAdj)}`,
    );

    // --- attendance --------------------------------------------------------
    const sched = config?.schedule?.[bucket];
    const selfStudy = !!sched && sched.attend === false && scheduleActive(sched, todayKey);
    const attendAdj = selfStudy ? ATTEND_BOOST : 0;
    if (selfStudy) evidence.push(`lectures not attended (attend:false) - self-study replaces them -> +${ATTEND_BOOST}`);

    // --- side-project board -------------------------------------------------
    let boardAdj = 0;
    if (bucket === sideBucket) {
      boardAdj =
        boardEntries.length === 0
          ? -SIDE_IDLE
          : Math.min(BOARD_SWING, BOARD_STEP * boardEntries.length);
      evidence.push(
        boardEntries.length === 0
          ? `no open board entries -> ${round1(boardAdj)}`
          : `${boardEntries.length} open board entr(y/ies) -> +${round1(boardAdj)}`,
      );
    }

    const rawAlloc = prior + gradeAdj + examAdj + backlogAdj + paceAdj + attendAdj + boardAdj;
    const alloc = round1(clamp(rawAlloc, 0, MAX_ALLOC));
    evidence.push(`alloc ${round1(rawAlloc)} -> ${alloc}`);

    courses[bucket] = {
      prior,
      gradeSignal,
      gradedItems: grades.length,
      backlog,
      examDays,
      paceMinsPerTask,
      loggedMins,
      alloc,
      evidence,
    };
  }

  return { updated: now.toISOString(), today: todayKey, courses };
}

/** {bucket: alloc} - what render.mjs and focus-engine.mjs actually consume. */
export function allocWeights(model) {
  const out = {};
  for (const [bucket, row] of Object.entries(model?.courses ?? {})) {
    if (typeof row?.alloc === "number" && Number.isFinite(row.alloc)) out[bucket] = row.alloc;
  }
  return out;
}

/**
 * Prepend this run to the history and cap it. Newest first; each entry is just
 * the allocation vector, which is all anyone has ever wanted to look back at.
 *
 * PURE.
 */
export function pushHistory(previousHistory, model, cap = HISTORY_CAP) {
  const prev = Array.isArray(previousHistory) ? previousHistory : [];
  return [{ at: model.updated, alloc: allocWeights(model) }, ...prev].slice(0, Math.max(1, cap));
}

/**
 * Append a study-log entry. PURE - returns a NEW log object; the caller writes it.
 */
export function appendLogEntry(studyLog, entry) {
  const entries = Array.isArray(studyLog?.entries) ? studyLog.entries : [];
  return { entries: [...entries, entry] };
}

/** "- 2026-08-31 16:40 - 90 min - note" (ASCII only, one line). */
export function studyLogLine(entry, tz = FALLBACK_TZ) {
  const day = localDayKey(entry.at, tz) ?? String(entry.at).slice(0, 10);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(entry.at));
  const note = entry.note ? ` - ${entry.note}` : "";
  return `- ${day} ${time} - ${entry.mins} min${note}`;
}

// ---------------------------------------------------------------------------
// CLI (the only impure part)
// ---------------------------------------------------------------------------

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

function loadInputs(argv) {
  const root = repoRoot();
  const DATA = resolveDataDir(argv, root);
  let config;
  try {
    config = loadConfig(null, { argv, warn: () => {} });
  } catch (e) {
    return { error: `cannot read ${configPath(argv, root)}: ${e.message}` };
  }
  const snapshot = readJson(path.join(DATA, "latest.json"), null);
  if (!snapshot) return { error: "cannot read data/latest.json - run node src/scrape.mjs first" };
  // The same item universe render.mjs builds: the snapshot, plus mail-born items,
  // plus dated side-project items, deduped on key+due. Without the extras the
  // backlog term is blind to every bucket that has no LMS course behind it.
  const items = [...(snapshot.items ?? [])];
  const seen = new Set(items.map((it) => {
    const v = readItem(it);
    return v.key + "|" + (v.due ?? "");
  }));
  const boardFile = readJson(path.join(DATA, "board-items.json"), { board: [], items: [] });
  for (const extra of [
    readJson(path.join(DATA, "outlook-items.json"), { items: [] }).items ?? [],
    boardFile.items ?? [],
  ]) {
    for (const it of extra) {
      const v = readItem(it);
      if (!v.key) continue;
      const dk = v.key + "|" + (v.due ?? "");
      if (seen.has(dk)) continue;
      seen.add(dk);
      items.push(it);
    }
  }
  return {
    config,
    dataDir: DATA,
    items,
    studyLog: readJson(path.join(DATA, "study-log.json"), { entries: [] }),
    userCompletions: readJson(path.join(DATA, "user-completions.json"), { completions: {} }),
    studyPlan: readJson(path.join(DATA, "study-plan.json"), null),
    board: boardFile.board ?? [],
  };
}

function printModel(model) {
  const rows = Object.entries(model.courses).sort((a, b) => b[1].alloc - a[1].alloc || a[0].localeCompare(b[0]));
  for (const [bucket, row] of rows) {
    console.log(
      `${bucket.padEnd(10)} alloc ${String(row.alloc).padStart(4)}  (prior ${row.prior}` +
        `${row.gradeSignal === null ? "" : `, grades ${row.gradeSignal}%`}` +
        `${row.examDays === null ? "" : `, assessment in ${row.examDays}d`}` +
        `, backlog ${row.backlog}` +
        `${row.paceMinsPerTask === null ? "" : `, ${row.paceMinsPerTask} min/task`})`,
    );
  }
}

function cliRefresh(argv, write) {
  const inputs = loadInputs(argv);
  if (inputs.error) {
    console.log(inputs.error);
    return 3;
  }
  const { dataDir, ...modelInputs } = inputs;
  const model = computeStudyModel({ ...modelInputs, now: new Date() });
  printModel(model);
  if (!write) return 0;
  const target = path.join(dataDir, "study-model.json");
  const previous = readJson(target, null);
  const out = { ...model, history: pushHistory(previous?.history, model) };
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote ${target} (${Object.keys(model.courses).length} buckets, ${out.history.length} history entries)`);
  return 0;
}

function cliLog(argv, bucket, minutes, note) {
  const root = repoRoot();
  const DATA = resolveDataDir(argv, root);
  let config;
  try {
    config = loadConfig(null, { argv, warn: () => {} });
  } catch (e) {
    console.log(`cannot read ${configPath(argv, root)}: ${e.message}`);
    return 3;
  }
  const mins = Number.parseInt(minutes, 10);
  if (!Number.isFinite(mins) || mins <= 0) {
    console.log('usage: node src/study-model.mjs --log "<bucket>" <minutes> ["note"]');
    return 2;
  }
  const known = new Set(Object.keys(config.difficulty ?? {}));
  if (!known.has(bucket)) {
    console.log(`unknown bucket "${bucket}". known: ${[...known].sort().join(", ")}`);
    return 4;
  }

  const entry = { at: new Date().toISOString(), c: bucket, mins, note: typeof note === "string" ? note : "" };
  const log = appendLogEntry(readJson(path.join(DATA, "study-log.json"), { entries: [] }), entry);
  fs.writeFileSync(path.join(DATA, "study-log.json"), JSON.stringify(log, null, 2) + "\n");
  console.log(`logged ${mins} min on ${bucket}${entry.note ? " - " + entry.note : ""} (${log.entries.length} entries)`);

  // Mirror into the course-materials tree ONLY when the course folder already
  // exists. That tree belongs to materials-sync.mjs; creating folders here would
  // fight it, and an unset materials root simply means there is nowhere to
  // mirror to - a no-op, never an error.
  const materialsRoot = config?.connectors?.materials?.root;
  if (typeof materialsRoot === "string" && materialsRoot) {
    const dir = path.join(materialsRoot, courseFolder(bucket));
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const file = path.join(dir, "study-log.md");
      // materials-sync may have laid down an empty placeholder; give it a title
      // the first time a real line lands in it, then only ever append.
      const empty = !fs.existsSync(file) || fs.statSync(file).size === 0;
      fs.appendFileSync(file, (empty ? `# ${bucket} study log\n\n` : "") + studyLogLine(entry) + "\n");
      console.log(`mirrored to ${file}`);
    }
  }
  return 0;
}

function cliMain(argv) {
  if (argv.includes("--refresh")) return cliRefresh(argv, true);
  if (argv.includes("--show")) return cliRefresh(argv, false);
  const logAt = argv.indexOf("--log");
  if (logAt !== -1) return cliLog(argv, argv[logAt + 1], argv[logAt + 2], argv[logAt + 3]);
  console.log(
    'usage: node src/study-model.mjs --refresh | --show | --log "<bucket>" <minutes> ["note"]\n' +
      "       every command also accepts --config <path> and --data <dir>",
  );
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(cliMain(process.argv.slice(2)));
}

export default computeStudyModel;
