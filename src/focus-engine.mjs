// focus-engine.mjs - the deterministic "what to study, for how long, and when" planner.
//
// PURE CORE: computeFocus() does no I/O. Feed it items, weights, the optional
// standards plan and the clock, and it returns the payload's `focus` array
// (7 entries, today first, LOCAL days), every block carrying `t` (suggested
// local start "HH:MM") and `mins` (allocated minutes).
//
// ---------------------------------------------------------------------------
// PART 1 - WHAT: scoring rubric (all additive, higher = more deserving of a block)
//
//   score = difficulty            course weight from config.difficulty (0..5).
//                                 A weight of 0 removes the course entirely, so
//                                 a zero-work seminar can never show up.
//         + typeWeight            what kind of work it is (exam 4 ... other 0.25)
//         + urgency               6 * (1 - lag / (lead + 1)) where
//                                   lag  = days from this day until the due date
//                                   lead = config.leadTimeDays[type] (exam 7,
//                                          project/lab 5, homework 3, quiz 2)
//                                 So an item only becomes a candidate inside its
//                                 lead window, and it climbs steadily as the
//                                 deadline approaches: 6 on the due day, ~0.75
//                                 on the first day of a 7-day window.
//         + OVERDUE_BONUS         unsubmitted and already past due (today only)
//
// When a standards-based course is configured (config.standardsPlan), it gets
// one extra synthetic candidate per day: practice for the week's focus
// standards. Its urgency is measured against the next sitting THE USER IS
// ACTUALLY SITTING (see PART 3), with the exam lead window. With no such
// sitting in range it falls back to a low "steady practice" score so the course
// stays visible. With no standards course configured, none of PART 3 runs.
//
// SELECTION: candidates are grouped by course (one block per course per day), the
// group takes its best item's score plus a small density bonus for having several
// things due, and the top `tuning.maxBlocksPerDay` groups become the day's blocks.
// Ties break on course code then title, so output is stable.
//
// ---------------------------------------------------------------------------
// PART 2 - HOW LONG and WHEN: the time budget
//
// Each day has a minute budget (config.studyMinutes.weekday / .weekend). The
// budget is split across that day's blocks in proportion to NEED, which unlike
// `score` is multiplicative - difficulty times urgency times a per-type factor:
//
//   need = max(1, difficulty) * (1 + (urgency + overdue) / 6) * typeFactor
//
// so a hard course with a deadline tomorrow gets several times the minutes of an
// easy course with a deadline next week. Shares are rounded to
// `tuning.blockStepMinutes`, floored at `tuning.minBlockMinutes` and capped at
// `tuning.maxBlockMinutes` so one block can never eat the whole evening. If
// rounding pushes the day over budget, minutes are shaved a step at a time off
// the LEAST-needed block first.
//
// Start times are then packed into the day's window (config.studyMinutes
// .weekdayWindow / .weekendWindow, hard-clamped to tuning.dayStart-dayEnd) with
// a `tuning.breakMinutes` gap between blocks, honouring:
//   - fixed commitments visible in the data: an exam or a sitting the user is
//     actually attending occupies its slot, and nothing is scheduled on top;
//   - deadlines: a block whose work is due later TODAY must finish by then
//     (an 11:59 PM deadline is no real constraint, a 4:30 PM one is).
// Blocks are placed highest-score first, except that anything with an earlier
// hard finish time jumps the queue.
//
// THE TIMETABLE IS REAL DATA. Every day is bounded below by config.wakeTime (a
// hard floor - no block may start before the user is awake, whatever the study
// window says) and the meetings in config.schedule that the user ATTENDS are
// busy intervals the packer routes around. Non-attended courses (attend:false)
// are NOT busy: their lecture hours are exactly the hours the user is free to
// self-study, which is also why study-model.mjs boosts their allocation.
//
// ---------------------------------------------------------------------------
// PART 2b - ALLOCATION WEIGHTS AND THE SIDE-PROJECT BUCKET
//
// `allocWeights` (data/study-model.json alloc values) overrides `weights`
// (config.difficulty) course by course; an absent bucket falls back to the
// config prior, and 0 still means "muted, never appears". The user's priors are
// the fallback, never the ceiling.
//
// The side-project bucket (config.sideProject.label, passed in as `sideBucket`)
// is not a course and has no LMS deadlines, so it gets a floor instead of a due
// date: when open side-project work exists - board entries from
// data/board-items.json, or dated items in that bucket - every day carries one
// block sized into [config.sideProject.minDailyMinutes, maxDailyMinutes], taken
// out of the SAME daily budget (minutes are shaved off the least-needed other
// block, never added on top).
//
// ---------------------------------------------------------------------------
// PART 3 - ATTENDANCE: which sittings are real for THIS user
//
// A standards-based course has two kinds of assessment opportunity and they must
// not be treated alike:
//   kind "exam"          whole-class evening exams and the final week. Everyone
//                        sits them. Absent `attending` means YES.
//   kind "reassessment"  opt-in retake sittings. You only sit one if you filled
//                        in that week's signup survey before it closed. Absent
//                        `attending` means UNKNOWN, not yes.
//
//   attending === true   -> "yes"     drives urgency, is a fixed commitment
//   attending === false  -> "no"      contributes ZERO urgency, is not mentioned
//   absent, kind exam    -> "yes"
//   absent, kind reassm. -> "unknown" contributes ZERO urgency; earns at most a
//                                     one-clause "only if you signed up" mention
//
// The `attending` flag in data/study-plan.json sittings[] is the single source of
// truth and overrides anything the week-note prose says, because prose describes
// what the professor announced, not what the user did about it.
//
// This whole part is dormant unless the plan names a course. No plan, or no
// course, means no synthetic candidates and no sitting commitments.
//
// ---------------------------------------------------------------------------
// PART 4 - THE USER'S OWN EDITS: pinned blocks, and learning from them
//
// The published page lets the user drag and resize a focus block. Those edits
// travel back through the command bus into data/block-edits.json, and
// render.mjs hands the whole file to computeFocus as `blockEdits`
// ({v, edits, history}). Absent or empty, nothing below happens.
//
// APPLY (`edits[]`, the live overrides - latest per (day, course) wins):
//   A pinned block is the user's decision, not the engine's suggestion, so it is
//   taken VERBATIM: exactly the start and duration the edit carries. It is
//   placed FIRST, becomes a busy interval every other block routes around, and
//   is never moved, shrunk, or dropped - not by the deadline packer, not by the
//   budget, not by the blocks-per-day cap. Its minutes are, however, spent: they
//   come off the day's budget before anything else is sized, and the remaining
//   blocks share what is left under the unchanged floor/cap/shave rules. On a
//   day where the pin eats the budget the un-pinned blocks simply stop being
//   promised - the pin is what the user asked for and it survives alone.
//   If the engine had no block for that course that day, one is synthesized:
//   the course's best candidate for the day if it had one that lost the cut,
//   otherwise a generic self-study block. Pinned blocks carry `"pinned": true`
//   into the payload.
//   The wake floor, the day clamp, the minute band and the no-overlap rule are
//   all engine judgement, and a pin outranks engine judgement -
//   command-ingest.mjs is the guard that keeps a pin sane, not this file. Two
//   pins the user deliberately overlapped stay overlapped for the same reason.
//
// LEARN (`history[]`, every accepted edit ever, capped at 200 by the ingester):
//   Only entries that carry `prev` (what the engine had shipped before the user
//   grabbed it) say anything about preference; a block the user created from
//   nothing teaches us nothing about where we were wrong. Per course, in `at`
//   order, two exponential moving averages with alpha = 0.3, each seeded with
//   its first observation:
//     startShift = EMA of start(t) - start(prev.t)   minutes, + = later
//     sizeRatio  = EMA of mins / prev.mins
//   With fewer than 2 contributing entries a course has no preference at all -
//   one drag is an accident, two is a habit. A preference NEVER applies to a
//   pinned block (the pin already says where it goes) and never to a course the
//   user has not actually edited.
//   sizeRatio, clamped to [0.5, 1.5], scales that block's proportional share
//   BEFORE the rounding, floor, cap and budget shave - so a learned preference
//   reshapes the split, it never inflates the day. (config.sideProject's
//   min/max band is a promise the user made to the side project and is still
//   applied afterwards, so it wins for that bucket's block.)
//   startShift, clamped to +/-180 minutes, is added to the start the packer
//   chose on its own and re-clamped into the day window - and it is a TARGET,
//   not a constraint. The packer tries at-or-after the target first, then
//   at-or-before it, then falls back to the ordinary ladder, so a deadline, an
//   attended class, an exam and an already-placed block all still win. The
//   engine's own choice is what the shift is measured against, so the day is
//   packed twice: once to learn where the block naturally lands, once with the
//   target applied. Both passes are pure, and the whole thing is deterministic.
//
// ---------------------------------------------------------------------------
// PART 5 - WHAT IS NO LONGER WORK: done, and cancelled
//
// An item is CLOSED when any of three things is true, and a closed item never
// generates a block, never counts as open side-project work, and never draws
// minutes:
//   s === true          the pipeline saw it submitted / graded / replied to
//   cancelled === true  the user decided not to do it (render.mjs writes this
//                       flag from their own mark - see completion.mjs)
//   its itemKey carries an effective mark in `completions`, in EITHER state
//
// Cancelled is not done and nothing here pretends otherwise - no submitted flag
// moves, no completion is claimed. It is simply not work any more, and planning
// an evening around it would be noise.
//
// `completions` is read through completion.mjs resolveMarks(), which is the one
// implementation of the resolution rule (docs/PROTOCOL.md): a mark the user took
// back has a newer TOMBSTONE and stops closing its item, so unchecking something
// on the page puts it straight back into the plan. Session keys
// ("fb|<day>|<bucket>") live in the same map and are simply never equal to an
// itemKey: finishing tonight's block closes that block on the page, and changes
// nothing about the deliverable or about tomorrow's block.
//
// ---------------------------------------------------------------------------
// PART 6 - THE CLOCK: today is a day already in progress
//
// A planner that re-derived every day from the wake floor would draw an
// untouched day at six in the evening. Two things are wrong with that. The
// morning's blocks, which the user may well have worked, get silently
// re-derived and can move; and the hours that have already passed are still
// offered as somewhere to put work that a closed deliverable has just freed. So
// the engine is given the clock and the plan it last published:
//
//   cut             `now` in local minutes, rounded UP to the next block step
//                   and never before the wake floor. New work for TODAY is only
//                   ever planned into [cut, windowEnd]; the packer's own floor
//                   becomes `cut` too, so not even its last-resort fallback can
//                   drop a block into a morning that is over.
//   previousFocus   the `focus` array of the last render (data/focus-plan.json).
//                   Today's blocks in it that START BEFORE `cut` are KEPT
//                   VERBATIM: same course, same words, same start, same minutes.
//                   They are the record of the day, they count against today's
//                   budget (that time really is spent), they are busy intervals
//                   the new packing routes around, and their buckets are not
//                   offered again - one block per (day, bucket) is what keeps
//                   the `fb|day|bucket` session keys stable across a re-render.
//                   Kept blocks carry `"kept": true` so the page can tell the
//                   day's record from the part of it that is still ahead and
//                   therefore still freeable.
//
// Nothing is kept when `cut` is the wake floor - before the floor nothing has
// started yet, whatever a pin says - so a pre-dawn run plans the day whole. A
// missing or stale previousFocus keeps nothing either, and today is simply
// packed from `cut`. A kept block whose deliverable has since closed is STILL
// kept: the past is a record, not a promise, and the page strikes it.
//
// SESSIONS: a session mark `fb|<today>|<bucket>`, in EITHER state, means that
// bucket gets no NEWLY packed block today - the session happened, or the user
// declined it, and re-offering it at 19:00 because the evening run re-derived
// the day is exactly the noise this rule exists to stop. It outranks a pin for
// today, and the side-project daily floor respects it. Future days are
// untouched: tomorrow's block for the same course is a different session.
//
// LIBERATION needs no machinery and gets none: a closed goal stops producing
// candidates (PART 5), so its minutes are simply budget again and the remaining
// courses absorb them under the unchanged floor/cap/shave rules. Because of
// PART 6 that happens for the REST OF TODAY too, not only from tomorrow on.
//
// ---------------------------------------------------------------------------
// Everything that touches "which day is this" goes through an IANA timezone -
// item dues are UTC ISO strings and would bucket into the wrong day if compared
// as UTC. There is no default zone anywhere in this file: `tz` is
// config.timezone, and computeFocus refuses to run without it, because a
// planner that quietly guesses the wrong zone produces a plausible plan for the
// wrong day.
// ---------------------------------------------------------------------------

import { parseSessionKey, resolveMarks } from "./completion.mjs";

/**
 * The zone the local-time helpers fall back to when a caller does not name one.
 *
 * This is the RUNTIME's own zone, not a constant: there is no correct default
 * timezone for a template, and baking one in would silently plan somebody's
 * week in the wrong day. computeFocus never uses this - it demands `tz` - but
 * the small helpers are also used interactively, where "the machine's own zone"
 * is the honest answer.
 */
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Used when config.difficulty has no entry for a course bucket. */
export const DEFAULT_WEIGHT = 2;

/** How much intrinsic attention a kind of work deserves. */
export const TYPE_WEIGHT = {
  exam: 4,
  project: 3,
  lab: 2.5,
  email: 2.5,
  homework: 2,
  task: 1.5,
  quiz: 1,
  other: 0.25, // the catch-all bucket: worksheets, content releases, unknowns
};

/** Minute-budget multiplier per kind of work (see NEED above). */
export const NEED_TYPE_FACTOR = {
  exam: 1.5,
  project: 1.3,
  lab: 1.25,
  homework: 1.2,
  email: 0.9,
  task: 0.9,
  quiz: 1,
  other: 0.8,
};

/** Fallback lead windows; render.mjs passes config.leadTimeDays over the top. */
export const DEFAULT_LEAD_DAYS = {
  exam: 7,
  project: 5,
  lab: 5,
  homework: 3,
  quiz: 2,
  email: 2,
  task: 2,
  default: 3,
};

/**
 * Fallback time budget; render.mjs passes config.studyMinutes over the top.
 *   weekday / weekend    total minutes of study the day may be filled with
 *   weekdayWindow        [start, end] local 24h clock the packer may use
 *   weekendWindow        same, for Sat/Sun
 * Windows are advisory and are hard-clamped to 08:00-23:00.
 */
export const DEFAULT_STUDY_MINUTES = {
  weekday: 240,
  weekend: 300,
  weekdayWindow: ["16:00", "22:30"],
  weekendWindow: ["10:00", "21:00"],
};

const URGENCY_SCALE = 6;
const OVERDUE_BONUS = 3;
const DENSITY_BONUS = 0.35; // per extra item stacked on the same course+day
const MAX_DENSITY_BONUS = 1; // a pile of light work must not outrank a hard exam
const PLAN_FOCUS_BONUS = 1; // standards work is plan-driven, so nudge it up
const STEADY_PRACTICE = 1.5; // the standards baseline when no sitting is in reach
const MAX_ITEMS_NAMED = 3;

/**
 * The name the side-project bucket goes by when the caller does not say.
 * config.sideProject.label is what actually reaches computeFocus as
 * `sideBucket`; this is only the fallback.
 */
export const DEFAULT_SIDE_BUCKET = "Side Project";

/**
 * PACKING TUNING - the numbers a user may reasonably want to move, and the only
 * ones config.focus.tuning may override. Everything else in this file is a
 * scoring decision rather than a preference, and lives as a plain constant.
 *
 * The defaults are the shipped behaviour; a partial override merges over them,
 * so `{ maxBlocksPerDay: 1 }` changes exactly that.
 */
export const DEFAULT_TUNING = Object.freeze({
  maxBlocksPerDay: 3,
  blockStepMinutes: 15,
  breakMinutes: 15,
  minBlockMinutes: 30,
  maxBlockMinutes: 150,
  dayStart: "08:00", // never schedule earlier
  dayEnd: "23:00", // never schedule past this
});

/** Timing bounds at the default tuning, as minutes-of-day in local time. */
export const HARD_DAY_START = 8 * 60;
export const HARD_DAY_END = 23 * 60;
export const MIN_BLOCK_MINUTES = 30;
export const MAX_BLOCK_MINUTES = 150;
export const BLOCK_STEP_MINUTES = 15;
export const BREAK_MINUTES = 15; // breathing room between consecutive blocks
export const MAX_BLOCKS_PER_DAY = 3;

const EXAM_BUSY_MINUTES = 120; // how long an exam item occupies the evening
const SITTING_BUSY_MINUTES = 90; // announced reassessment sittings run 90 min
const BUSY_EARLIEST = 7 * 60; // an "exam" due before 07:00 or after 21:00 is a
const BUSY_LATEST = 21 * 60; // deadline, not a sitting - do not block time out
const MENTION_WINDOW_DAYS = 3; // how far ahead an unknown sitting is mentioned
const WEEKEND_DAYS = new Set(["Sat", "Sun"]);
const SIDE_STEADY = 1.5; // the side project has no deadline; this is its claim
const SIDE_NAMED_ON_BOARD = 1; // how many board entries a block names by title

/** PART 4 - learning from the user's own block edits. */
export const LEARN_ALPHA = 0.3; // EMA smoothing; the newest edit is 30% of it
export const LEARN_MIN_SAMPLES = 2; // one drag is an accident, two is a habit
export const LEARN_MAX_SHIFT = 180; // a learned start shift, in minutes, either way
export const LEARN_MIN_RATIO = 0.5; // a learned size may halve a block...
export const LEARN_MAX_RATIO = 1.5; // ...or add half again, and no further
/** A pin's duration band, matching command-ingest.mjs's own guard. */
export const PIN_MIN_MINUTES = 15;
export const PIN_MAX_MINUTES = 240;

// ---------------------------------------------------------------------------
// Local-time helpers
// ---------------------------------------------------------------------------

const fmtCache = new Map();
function formatter(tz, opts) {
  const key = tz + "|" + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

/** "2026-08-31" for the local calendar day that this instant falls on. */
export function localDayKey(value, tz = systemZone()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = formatter(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "11:59 PM" in local time. */
export function localTimeLabel(value, tz = systemZone()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return formatter(tz, { hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/[\u202f\u00a0]/g, " ");
}

/** "Mon" in local time. */
export function localWeekday(value, tz = systemZone()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return formatter(tz, { weekday: "short" }).format(d);
}

/** Local hour 0-23, for "due tonight" vs "due today". */
function localHour(value, tz = systemZone()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 12;
  return Number(formatter(tz, { hour: "2-digit", hour12: false }).format(d)) || 0;
}

/** Minutes since local midnight for an instant, or null. */
export function localMinuteOfDay(value, tz = systemZone()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = formatter(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(p.find((x) => x.type === "hour")?.value);
  const m = Number(p.find((x) => x.type === "minute")?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h % 24) * 60 + m;
}

/** "16:00" or "7:30 PM" -> minutes since midnight. null when unreadable. */
export function minutesOfClock(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{1,2}):(\d{2})\s*(?:([AaPp])\.?\s?[Mm]\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || mm > 59) return null;
  if (m[3]) {
    if (h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  }
  if (h > 23) return null;
  return h * 60 + mm;
}

/** 990 -> "16:30" (the payload's `t` format). */
export function clockOf(minutes) {
  const v = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

// Day keys are compared through UTC noon so DST transitions can never shift a day.
function keyToNoon(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

/** Whole calendar days from dayKey a to dayKey b (negative = b is earlier). */
export function dayDiff(a, b) {
  return Math.round((keyToNoon(b) - keyToNoon(a)) / 86400000);
}

/** dayKey + n days, still a dayKey. */
export function addDays(key, n) {
  return new Date(keyToNoon(key) + n * 86400000).toISOString().slice(0, 10);
}

/** "Mon" for a bare dayKey (no timezone maths needed - it is already local). */
export function weekdayOfKey(key) {
  return new Date(keyToNoon(key)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
}

/**
 * Turn a partial `config.focus.tuning` into a complete, sane set of packing
 * numbers, in the units the rest of this file works in (minutes, and
 * minutes-of-day for the two clock bounds).
 *
 * Every field is validated rather than trusted: a hand-edited config with
 * `minBlockMinutes: 0` or `dayEnd: "banana"` must produce the shipped default
 * for that one field and nothing worse. The two orderings that matter are
 * forced last - a minimum can never exceed the maximum, and the day has to be
 * long enough to hold one block - because either inversion turns the packer
 * into an infinite shave loop rather than a wrong answer. PURE.
 */
export function resolveTuning(tuning) {
  const raw = tuning && typeof tuning === "object" ? tuning : {};
  const num = (v, fallback) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  const clock = (v, fallback) => minutesOfClock(v) ?? fallback;

  const step = num(raw.blockStepMinutes, DEFAULT_TUNING.blockStepMinutes);
  const minBlock = num(raw.minBlockMinutes, DEFAULT_TUNING.minBlockMinutes);
  const maxBlock = Math.max(minBlock, num(raw.maxBlockMinutes, DEFAULT_TUNING.maxBlockMinutes));
  const dayStart = clock(raw.dayStart, HARD_DAY_START);
  const dayEnd = Math.max(dayStart + minBlock, clock(raw.dayEnd, HARD_DAY_END));

  return Object.freeze({
    maxBlocksPerDay: num(raw.maxBlocksPerDay, DEFAULT_TUNING.maxBlocksPerDay),
    step,
    breakMinutes:
      typeof raw.breakMinutes === "number" && Number.isFinite(raw.breakMinutes) && raw.breakMinutes >= 0
        ? Math.round(raw.breakMinutes)
        : DEFAULT_TUNING.breakMinutes,
    minBlock,
    maxBlock,
    dayStart,
    dayEnd,
  });
}

/** The resolved defaults, built once, for helpers called without a tuning. */
const BASE_TUNING = resolveTuning(null);

// ---------------------------------------------------------------------------
// PHYS 221 sittings
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Is the user actually going to be in the room?
 *   "yes"     -> drives urgency and blocks out its slot
 *   "no"      -> contributes nothing at all
 *   "unknown" -> contributes nothing but earns a gentle mention
 * See PART 3 in the header for why an absent flag means different things for a
 * whole-class exam and for an opt-in weekly reassessment.
 */
export function sittingAttendance(sitting) {
  if (!sitting) return "unknown";
  if (sitting.attending === true) return "yes";
  if (sitting.attending === false) return "no";
  return sitting.kind === "reassessment" ? "unknown" : "yes";
}

/**
 * The professor announces weekly reassessment sittings in prose, and the
 * scheduled agent parks that prose in the current week's `note` of
 * data/study-plan.json (e.g. "First reassessment Wed Sep 2, 7:30 pm, PHYS 114
 * (C1 only ...)"). Pull the date/time/room/standards back out so the engine can
 * treat it as a real sitting. Returns null on anything it cannot read
 * confidently, and refuses dates outside the two weeks after weekStart.
 *
 * The note says what was ANNOUNCED. Whether the user signed up lives in
 * study-plan sittings[].attending, so pass that array in as `sittings` and the
 * flag is copied onto the parsed sitting - a note that still describes a sitting
 * the user skipped therefore produces attending:false, not a phantom exam.
 */
export function extractReassessment(note, weekStart, sittings = []) {
  if (typeof note !== "string" || !weekStart) return null;
  const m = note.match(
    /reassessment[^.]{0,80}?\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\b\s*,?\s*(\d{1,2}):(\d{2})\s*([ap])\.?\s?m/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "p") hour += 12;
  const year = Number(String(weekStart).slice(0, 4));
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const offset = dayDiff(weekStart, date);
  if (!Number.isFinite(offset) || offset < 0 || offset > 13) return null;

  const tail = note.slice(m.index + m[0].length);
  const room = tail.match(/\b([A-Z]{3,5}\s?\d{1,4})\b/)?.[1] ?? null;
  const stdList = note.match(/\(([A-Z]\d{1,2}(?:\s*,\s*[A-Z]\d{1,2})*)\s*(?:only|\))/);
  const standards = stdList ? stdList[1].split(",").map((s) => s.trim()) : [];
  const record = (Array.isArray(sittings) ? sittings : []).find((s) => s?.date === date);
  return {
    date,
    time: `${String(Number(m[3]) % 12 || 12)}:${m[4]} ${m[5].toUpperCase()}M`,
    room,
    standards,
    label: "Reassessment sitting",
    kind: "reassessment",
    ...(record && typeof record.attending === "boolean" ? { attending: record.attending } : {}),
  };
}

/**
 * Every assessment opportunity the standards course has, as { date, label,
 * standards, time, room, kind, attending? }, sorted and de-duplicated by date.
 *
 * Sources are merged rather than first-wins, because each knows different
 * things: study-plan sittings[] carry the authoritative label, target standards,
 * kind and attendance; the week-note parse adds the time and room; LMS exam
 * items add a time for exams the plan only knows the date of.
 *
 * `standardsCourse` names the course whose exam items count. It defaults to the
 * plan's own `course`, which is where config.standardsPlan.course lands; with
 * neither, no item is ever matched and only the plan's own records survive.
 */
export function collectSittings(standardsPlan, items, tz = systemZone(), standardsCourse = null) {
  const course = standardsCourse ?? standardsPlan?.course ?? null;
  const byDate = new Map();
  const merge = (s) => {
    if (!s?.date) return;
    const cur = byDate.get(s.date);
    if (!cur) {
      byDate.set(s.date, {
        date: s.date,
        label: s.label ?? "",
        standards: Array.isArray(s.standards) ? s.standards : [],
        time: s.time ?? null,
        room: s.room ?? null,
        kind: s.kind ?? "exam",
        ...(typeof s.attending === "boolean" ? { attending: s.attending } : {}),
      });
      return;
    }
    if (!cur.label && s.label) cur.label = s.label;
    if (!cur.time && s.time) cur.time = s.time;
    if (!cur.room && s.room) cur.room = s.room;
    if (!cur.standards.length && Array.isArray(s.standards) && s.standards.length) cur.standards = s.standards;
    // A "reassessment" reading is more specific than the generic "exam" default.
    if (s.kind === "reassessment") cur.kind = "reassessment";
    // The first explicit flag wins; study-plan sittings[] are merged first, so
    // the user's own record always beats anything inferred from prose.
    if (typeof cur.attending !== "boolean" && typeof s.attending === "boolean") cur.attending = s.attending;
  };

  // 1. The plan's own record: labels, targets, kind, and the attending flag.
  for (const s of standardsPlan?.sittings ?? []) {
    merge({
      date: s.date,
      label: s.label,
      standards: s.targets ?? [],
      kind: s.kind ?? "exam",
      ...(typeof s.attending === "boolean" ? { attending: s.attending } : {}),
    });
  }
  // 2. The weekly reassessment parsed out of the week note: time and room.
  if (standardsPlan?.reassessment) merge({ kind: "reassessment", ...standardsPlan.reassessment });
  // 3. Exam items for the standards course: a time for the evening exams.
  for (const it of course ? (items ?? []) : []) {
    if (it?.ty !== "exam" || it?.c !== course || !it?.d) continue;
    merge({ date: localDayKey(it.d, tz), label: it.t, kind: "exam", time: localTimeLabel(it.d, tz) });
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function shortTitle(title) {
  return String(title ?? "")
    .replace(/\bAsynchronous\b/gi, "Async")
    .replace(/\bHomework\b/g, "HW")
    .replace(/\s*\([^)]{12,}\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Long GitHub titles do not fit a focus card; clip on a word boundary. */
function clip(text, max = 52) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "...";
}

/**
 * Name only the work that shares the primary's deadline, so a block never says
 * "Submit A + B" when B is not due for another three days. Overdue and due-today
 * work is treated as one bucket - it is all "deal with this now".
 */
function sameDeadline(list, primary) {
  const cut = Math.max(primary.lag, 0);
  return list.filter((c) => (primary.lag <= 0 ? c.lag <= 0 : c.lag === cut));
}

/** "HW 2", "HW 2 + Async Quiz 3", "HW 2 + 2 more" once the list gets long. */
function titleList(items) {
  const names = items.slice(0, MAX_ITEMS_NAMED).map((c) => shortTitle(c.item.t));
  const extra = items.length - names.length;
  let text = names.join(" + ");
  if (extra > 0) text += ` + ${extra} more`;
  return text;
}

/**
 * Brightspace hands us the same deliverable more than once (a due date and a
 * "disappears from Brightspace" date, a calendar echo of a dropbox entry). They
 * share an itemKey, so collapse them to the next deadline that has not passed -
 * otherwise "HW 2" shows up twice in the same week for no reason.
 */
function dedupeByKey(items, todayKey, tz) {
  const groups = new Map();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const id = it.k || `${it.c}|${it.ty}|${it.t}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(it);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const sorted = [...list].sort((a, b) => String(a.d).localeCompare(String(b.d)));
    out.push(sorted.find((x) => (localDayKey(x.d, tz) ?? "") >= todayKey) ?? sorted[sorted.length - 1]);
  }
  return out;
}

function verbFor(primary) {
  const { lag, lead, item } = primary;
  // Some kinds of work have one honest verb whatever the lead time.
  if (item.ty === "email") return lag < 0 ? "Overdue reply:" : "Reply:";
  if (item.ty === "exam") return lag === 0 ? "Take" : "Study for";
  if (item.ty === "other") return "Work through"; // never claim a lecture PDF is "submitted"
  if (lag < 0) return "Catch up on";
  if (lag === 0) return item.ty === "quiz" ? "Take" : "Submit";
  if (lag === 1) return "Finish";
  if (lag >= lead) return "Start";
  return "Keep working on";
}

function whyFor(primary, dayOffset) {
  const { lag, item, tz } = primary;
  const time = localTimeLabel(item.d, tz);
  const approx = item.a ? " (approx)" : "";
  if (lag < 0) return `overdue by ${-lag} day${-lag === 1 ? "" : "s"}` + approx;
  if (item.ty === "exam") {
    if (lag === 0) return `exam ${dayOffset === 0 ? "today" : weekdayOfKey(primary.dayKey)} ${time}`.trim() + approx;
    return `exam in ${lag} day${lag === 1 ? "" : "s"}` + approx;
  }
  if (lag === 0) {
    if (dayOffset === 0) return (localHour(item.d, tz) >= 17 ? "due tonight " : "due today ") + time + approx;
    return `due ${weekdayOfKey(primary.dayKey)} ${time}` + approx;
  }
  if (lag === 1 && dayOffset === 0) return `due tomorrow ${time}` + approx;
  return `due ${weekdayOfKey(addDays(primary.dayKey, lag))} ${time}` + approx;
}

// ---------------------------------------------------------------------------
// Budget + packing
// ---------------------------------------------------------------------------

/**
 * The earliest minute of the day anything may be scheduled: 08:00, or
 * config.wakeTime when it is later. This is a HARD floor - it outranks the
 * study window, a deadline, and a packer fallback alike, because a block before
 * the user is awake is not advice, it is noise.
 */
export function wakeFloor(wakeTime, tune = BASE_TUNING) {
  const wake = minutesOfClock(wakeTime);
  const floor = wake === null ? tune.dayStart : Math.max(tune.dayStart, wake);
  return Math.min(floor, tune.dayEnd - tune.minBlock);
}

/** The local clock window this day's blocks may occupy, clamped to the day bounds. */
function dayWindow(dayKey, studyMinutes, floor = BASE_TUNING.dayStart, tune = BASE_TUNING) {
  const weekend = WEEKEND_DAYS.has(weekdayOfKey(dayKey));
  const fallback = weekend ? DEFAULT_STUDY_MINUTES.weekendWindow : DEFAULT_STUDY_MINUTES.weekdayWindow;
  const given = weekend ? studyMinutes?.weekendWindow : studyMinutes?.weekdayWindow;
  const pair = Array.isArray(given) ? given : [];
  let start = minutesOfClock(pair[0]) ?? minutesOfClock(fallback[0]);
  let end = minutesOfClock(pair[1]) ?? minutesOfClock(fallback[1]);
  start = Math.min(Math.max(start, floor), tune.dayEnd - tune.minBlock);
  end = Math.max(Math.min(end, tune.dayEnd), start + tune.minBlock);
  return { start, end, weekend };
}

/**
 * The class meetings config.schedule puts on one local day, as
 * {c, attend, room, start, end} with minute-of-day bounds. Meetings outside the
 * course's from/until range are dropped, so the timetable stops on its own at
 * the end of term. PURE.
 */
export function classMeetings(schedule, dayKey) {
  const out = [];
  const wd = weekdayOfKey(dayKey);
  for (const [course, entry] of Object.entries(schedule ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.from && dayKey < entry.from) continue;
    if (entry.until && dayKey > entry.until) continue;
    for (const m of Array.isArray(entry.meets) ? entry.meets : []) {
      if (!Array.isArray(m?.days) || !m.days.includes(wd)) continue;
      const start = minutesOfClock(m.start);
      const end = minutesOfClock(m.end);
      if (start === null || end === null || end <= start) continue;
      out.push({ c: course, attend: entry.attend !== false, room: entry.room ?? null, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.c.localeCompare(b.c));
}

/** Total minutes of study this day may be filled with. */
function dayBudget(weekend, studyMinutes, tune = BASE_TUNING) {
  const given = weekend ? studyMinutes?.weekend : studyMinutes?.weekday;
  const fallback = weekend ? DEFAULT_STUDY_MINUTES.weekend : DEFAULT_STUDY_MINUTES.weekday;
  const v = typeof given === "number" && Number.isFinite(given) && given > 0 ? given : fallback;
  return Math.max(tune.minBlock, Math.round(v));
}

/**
 * Split `budget` minutes across blocks in proportion to `needs`, on the tuning's
 * minute grid, floored at its minimum block and capped at its maximum. When
 * rounding pushes the total over budget the excess is shaved off the least
 * needed block first. Deterministic: ties resolve by original index.
 *
 * `scales` (PART 4) is an optional per-block multiplier - the learned sizeRatio
 * for that course - applied to the proportional share BEFORE the rounding, the
 * floor, the cap and the shave, so a learned preference reshapes the split
 * without ever growing the day. Absent, null, or 1 changes nothing.
 */
export function allocateMinutes(needs, budget, scales = null, tune = BASE_TUNING) {
  const n = needs.length;
  if (!n) return [];
  const safe = needs.map((x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0.001));
  const total = safe.reduce((s, x) => s + x, 0);
  const scaleAt = (i) => {
    const s = scales?.[i];
    return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1;
  };
  const mins = safe.map((x, i) => {
    const raw = ((budget * x) / total) * scaleAt(i);
    const v = Math.round(raw / tune.step) * tune.step;
    return Math.min(tune.maxBlock, Math.max(tune.minBlock, v));
  });

  const leastFirst = safe.map((_, i) => i).sort((a, b) => safe[a] - safe[b] || a - b);
  const sum = () => mins.reduce((s, v) => s + v, 0);
  for (let guard = 0; guard < 1000 && sum() > budget; guard++) {
    const i = leastFirst.find((k) => mins[k] > tune.minBlock);
    if (i === undefined) break; // everything is already at the floor
    mins[i] -= tune.step;
  }
  return mins;
}

/**
 * Force one block's minutes into [minK, maxK] without growing the day.
 *
 * Growing takes budget slack first, then shaves one step at a time off the
 * LEAST-needed other block (never below the minimum block); if neither can pay,
 * the block simply stays under its minimum - the budget is the user's and this
 * function never exceeds it. Shrinking hands the surplus to the most-needed
 * block that is still under the maximum, and drops it otherwise (a day may come
 * in under budget; it may never come in over).
 *
 * PURE. Returns a NEW array. Used for the side-project floor/ceiling
 * (config.sideProject.minDailyMinutes / maxDailyMinutes).
 */
export function enforceBlockMinutes(mins, needs, index, minK, maxK, budget, tune = BASE_TUNING) {
  const out = [...mins];
  if (!(index >= 0 && index < out.length)) return out;
  const grid = (v) => Math.round(v / tune.step) * tune.step;
  const lo = Math.max(tune.minBlock, grid(Number.isFinite(minK) && minK > 0 ? minK : tune.minBlock));
  const hi = Math.min(
    tune.maxBlock,
    Math.max(lo, grid(Number.isFinite(maxK) && maxK > 0 ? maxK : tune.maxBlock)),
  );
  const target = Math.min(hi, Math.max(lo, out[index]));
  const others = out.map((_, i) => i).filter((i) => i !== index);
  const leastFirst = [...others].sort((a, b) => (needs[a] ?? 0) - (needs[b] ?? 0) || a - b);
  const mostFirst = [...others].sort((a, b) => (needs[b] ?? 0) - (needs[a] ?? 0) || a - b);
  const total = () => out.reduce((sum, v) => sum + v, 0);

  for (let guard = 0; guard < 100 && out[index] < target; guard++) {
    if (budget - total() >= tune.step) {
      out[index] += tune.step;
      continue;
    }
    const donor = leastFirst.find((i) => out[i] > tune.minBlock);
    if (donor === undefined) break; // nothing left to take: honour the budget, not the floor
    out[donor] -= tune.step;
    out[index] += tune.step;
  }
  for (let guard = 0; guard < 100 && out[index] > target; guard++) {
    out[index] -= tune.step;
    const taker = mostFirst.find((i) => out[i] < tune.maxBlock);
    if (taker !== undefined) out[taker] += tune.step;
  }
  return out;
}

/** [[s,e],...] -> non-overlapping, sorted. */
function mergeIntervals(list) {
  const sorted = list
    .filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
    .map((iv) => [iv[0], iv[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv);
  }
  return out;
}

/**
 * Earliest start >= `from` where a `dur`-minute block fits without touching any
 * interval in `taken` and finishes by `limit`. Starts snap to a 5-minute grid.
 */
function findSlot(from, dur, limit, taken) {
  let t = Math.max(0, Math.ceil(from / 5) * 5);
  for (let guard = 0; guard < 500; guard++) {
    if (t + dur > limit) return null;
    const hit = taken.find(([s, e]) => t < e && s < t + dur);
    if (!hit) return t;
    t = Math.ceil(hit[1] / 5) * 5;
  }
  return null;
}

/**
 * The mirror of findSlot: the LATEST start no later than `latestStart` where a
 * `dur`-minute block fits without collisions and without starting before
 * `floor`. Used when a deadline falls before the day's window even opens - the
 * honest advice is "right before it is due", not "at breakfast".
 */
function findSlotBack(latestStart, dur, floor, taken) {
  let t = Math.floor(latestStart / 5) * 5;
  for (let guard = 0; guard < 500; guard++) {
    if (t < floor) return null;
    const hit = taken.find(([s, e]) => t < e && s < t + dur);
    if (!hit) return t;
    t = Math.floor((hit[0] - dur) / 5) * 5;
  }
  return null;
}

/**
 * Assign a start minute to each entry ({ id, mins, limit, rank, target? })
 * inside [windowStart, windowEnd], routing around `busy` and around blocks
 * already placed. Entries arrive in placement order. Returns Map id -> start
 * minute; an entry that genuinely cannot be placed is simply absent (the
 * contract lets a block be untimed, and a wrong time is worse than none).
 *
 * `target` (PART 4) is a learned preferred start. It is SOFT: it only changes
 * which slots are tried first, so a deadline, an attended class, an exam and an
 * already-placed block all still outrank it, and an entry without one packs
 * exactly as it always did.
 */
function packDay(entries, windowStart, windowEnd, busy, floor = BASE_TUNING.dayStart, tune = BASE_TUNING) {
  const taken = mergeIntervals(busy);
  const dayFloor = Math.max(tune.dayStart, floor);
  const placed = new Map();
  let cursor = windowStart;

  for (const e of entries) {
    const dur = e.mins;
    const hasLimit = typeof e.limit === "number" && Number.isFinite(e.limit);
    const softLimit = Math.min(hasLimit ? e.limit : windowEnd, windowEnd);
    let t = null;
    // 0. the user's learned hour, when this course has one: at or after it
    //    first, then at or before it - always inside the window and always
    //    before the deadline, because a preference is not a permission.
    if (typeof e.target === "number" && Number.isFinite(e.target)) {
      t = findSlot(Math.max(e.target, windowStart, dayFloor), dur, softLimit, taken);
      if (t === null) t = findSlotBack(Math.min(e.target, softLimit - dur), dur, Math.max(windowStart, dayFloor), taken);
    }
    // 1. after the previous block, inside the window, before the deadline
    if (t === null) t = findSlot(cursor, dur, softLimit, taken);
    // 2. anywhere in the window (an earlier deadline may have jumped the queue)
    if (t === null) t = findSlot(windowStart, dur, softLimit, taken);
    // 3. the deadline lands before the window even opens: sit the block as late
    //    as it can go and still beat it, rather than dumping it at breakfast
    if (t === null && hasLimit) {
      t = findSlotBack(Math.min(e.limit, tune.dayEnd) - dur, dur, dayFloor, taken);
    }
    // 4. deadline unreachable (already past, or the day is packed): keep the
    //    block in the window - the time is advice, not a promise
    if (t === null) t = findSlot(cursor, dur, windowEnd, taken);
    if (t === null) t = findSlot(windowStart, dur, windowEnd, taken);
    // 5. window full: anywhere inside waking hours (never before wakeTime)
    if (t === null) t = findSlot(dayFloor, dur, tune.dayEnd, taken);
    if (t === null) continue;

    placed.set(e.id, t);
    taken.push([t, t + dur]);
    taken.sort((a, b) => a[0] - b[0]);
    // Only a placement INSIDE the preferred window moves the queue forward. One
    // block with an early deadline must never drag the rest of the day with it.
    const inWindow = t >= windowStart && t + dur <= windowEnd;
    cursor = inWindow ? t + dur + tune.breakMinutes : Math.max(cursor, windowStart);
  }
  return placed;
}

// ---------------------------------------------------------------------------
// The user's own block edits (PART 4)
// ---------------------------------------------------------------------------

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One `edits[]` entry -> {day, c, start, mins}, or null when it is not a block
 * edit we can act on. command-ingest.mjs is the guard that decides what is a
 * legal pin (15-240 minutes, snapped to 15, inside 08:00-23:59, a real bucket);
 * this only refuses what it cannot READ, and clamps the duration into the same
 * band so a hand-edited file cannot produce an absurd block.
 */
function pinOf(edit) {
  if (!edit || typeof edit !== "object") return null;
  const day = typeof edit.day === "string" && DAY_KEY_RE.test(edit.day) ? edit.day : null;
  const course = typeof edit.c === "string" ? edit.c.trim() : "";
  const start = minutesOfClock(edit.t);
  const mins = typeof edit.mins === "number" && Number.isFinite(edit.mins) ? Math.round(edit.mins) : null;
  if (!day || !course || start === null || mins === null || mins <= 0) return null;
  return {
    day,
    c: course,
    start: Math.max(0, Math.min(24 * 60 - 1, start)),
    mins: Math.min(PIN_MAX_MINUTES, Math.max(PIN_MIN_MINUTES, mins)),
  };
}

/**
 * data/block-edits.json `edits[]` -> Map dayKey -> Map course -> {start, mins}.
 *
 * A later entry REPLACES an earlier one for the same (day, course): the
 * ingester already keeps only the newest, this is the belt to its braces. Each
 * day's courses are re-keyed in code order so a day carrying two pins is
 * deterministic whatever order they arrived in. PURE.
 */
export function pinnedBlocks(blockEdits) {
  const byDay = new Map();
  for (const raw of Array.isArray(blockEdits?.edits) ? blockEdits.edits : []) {
    const pin = pinOf(raw);
    if (!pin) continue;
    if (!byDay.has(pin.day)) byDay.set(pin.day, new Map());
    byDay.get(pin.day).set(pin.c, { start: pin.start, mins: pin.mins });
  }
  const out = new Map();
  for (const [day, courses] of byDay) {
    out.set(day, new Map([...courses.entries()].sort((a, b) => a[0].localeCompare(b[0]))));
  }
  return out;
}

/**
 * data/block-edits.json `history[]` -> Map course -> {startShift, sizeRatio, n}.
 *
 * Only entries carrying `prev` contribute - a block the user conjured out of
 * nothing says nothing about where the engine was wrong. Contributions are
 * folded in `at` order (original array order breaks ties) as two EMAs with
 * alpha = LEARN_ALPHA, each seeded with its first observation:
 *
 *   startShift  EMA of start(t) - start(prev.t), minutes, + = the user moved it later
 *   sizeRatio   EMA of mins / prev.mins
 *   n           how many entries contributed
 *
 * Raw and unclamped: the caller decides whether n earns the preference any
 * authority and clamps it. PURE.
 */
export function learnedPreferences(blockEdits) {
  const rows = [];
  const history = Array.isArray(blockEdits?.history) ? blockEdits.history : [];
  history.forEach((h, idx) => {
    if (!h || typeof h !== "object") return;
    const course = typeof h.c === "string" ? h.c.trim() : "";
    const start = minutesOfClock(h.t);
    const mins = typeof h.mins === "number" && Number.isFinite(h.mins) ? h.mins : null;
    const prevStart = minutesOfClock(h.prev?.t);
    const prevMins = typeof h.prev?.mins === "number" && Number.isFinite(h.prev.mins) ? h.prev.mins : null;
    if (!course || start === null || mins === null || mins <= 0) return;
    if (prevStart === null || prevMins === null || prevMins <= 0) return; // no `prev`, no lesson
    rows.push({
      idx,
      course,
      at: typeof h.at === "string" ? h.at : "",
      shift: start - prevStart,
      ratio: mins / prevMins,
    });
  });
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.idx - b.idx);

  const out = new Map();
  for (const row of rows) {
    const cur = out.get(row.course);
    out.set(
      row.course,
      cur
        ? {
            startShift: LEARN_ALPHA * row.shift + (1 - LEARN_ALPHA) * cur.startShift,
            sizeRatio: LEARN_ALPHA * row.ratio + (1 - LEARN_ALPHA) * cur.sizeRatio,
            n: cur.n + 1,
          }
        : { startShift: row.shift, sizeRatio: row.ratio, n: 1 },
    );
  }
  return out;
}

/**
 * The block a pin gets when the engine had nothing for that course that day and
 * no candidate to promote either. It still has to say something honest: the
 * user put an hour here, and the only thing we know about it is the course.
 */
function selfStudyBlock(course, sideBucket) {
  return {
    c: course,
    what: course === sideBucket ? `Work the ${course} board` : `Self-study ${course}`,
    why: "you put this block here",
  };
}

// ---------------------------------------------------------------------------
// The clock and the record so far (PART 6)
// ---------------------------------------------------------------------------

/**
 * The first minute of today that new work may be planned into: the local clock
 * rounded UP to the next quarter hour, never earlier than the wake floor.
 *
 * Rounding UP is the whole point - planning a block that started ten minutes ago
 * is an instruction to travel backwards - and the 15-minute grid is the one
 * every duration in this file already lives on, so a run at 18:07 and a run at
 * 18:14 produce the same day and the plan does not shiver when the agent starts
 * a minute late.
 *
 * An unreadable `now`, or one before the floor, gives the floor back: nothing
 * has started yet, and the day is packed whole. Nullish counts
 * as unreadable - `new Date(null)` is a perfectly valid instant (the epoch) and
 * would otherwise cut the day at whatever o'clock 1970 was in this zone, which
 * is the kind of answer that looks like an answer. PURE.
 */
export function cutMinute(now, tz = systemZone(), floor = BASE_TUNING.dayStart, tune = BASE_TUNING) {
  const minute = now === null || now === undefined ? null : localMinuteOfDay(now, tz);
  if (minute === null) return floor;
  return Math.max(floor, Math.ceil(minute / tune.step) * tune.step);
}

/**
 * The blocks a previous render published for `dayKey` that had already STARTED
 * by `cut`: the record of the day so far.
 *
 * `previousFocus` is the `focus` array of the last render (render.mjs reads it
 * out of data/focus-plan.json before overwriting it) - an array of days, or the
 * whole {v, focus} file, or nothing at all. All three are normal; a first run,
 * a deleted file and a plan from last week are the same thing to this function,
 * which is "no record", not "an error".
 *
 * A kept block is taken VERBATIM - every field the previous render wrote
 * survives, `pinned` and any tie included - with only three things enforced:
 * a readable course, a readable start, and positive whole minutes. The block is
 * stamped `kept: true` so the page can tell what has already happened from what
 * is still ahead of the user and therefore still freeable.
 *
 * At most one block per bucket comes back, earliest first, because one block per
 * (day, bucket) is the identity the `fb|day|bucket` session keys are built on.
 * PURE - and total: it never throws on a malformed plan, it just keeps less.
 */
export function keptBlocks(previousFocus, dayKey, cut) {
  const days = Array.isArray(previousFocus)
    ? previousFocus
    : Array.isArray(previousFocus?.focus)
      ? previousFocus.focus
      : [];
  if (!DAY_KEY_RE.test(String(dayKey ?? "")) || !Number.isFinite(cut)) return [];
  const day = days.find((d) => d && typeof d === "object" && d.d === dayKey);
  const rows = [];
  for (const raw of Array.isArray(day?.blocks) ? day.blocks : []) {
    if (!raw || typeof raw !== "object") continue;
    const c = typeof raw.c === "string" ? raw.c.trim() : "";
    const start = minutesOfClock(raw.t);
    const mins = typeof raw.mins === "number" && Number.isFinite(raw.mins) ? Math.round(raw.mins) : null;
    // An untimed block never started: it was advice with no hour on it, and
    // re-planning it costs the user nothing. Only a block with a real start,
    // and one that is genuinely behind us, is the record of anything.
    if (!c || start === null || mins === null || mins <= 0 || start >= cut) continue;
    rows.push({ start, block: { ...raw, c, t: clockOf(start), mins, kept: true } });
  }
  rows.sort((a, b) => a.start - b.start || a.block.c.localeCompare(b.block.c));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.block.c)) continue;
    seen.add(row.block.c);
    out.push(row.block);
  }
  return out;
}

/**
 * The buckets whose session on `dayKey` the user has already closed - the set of
 * `b` for every effective mark on a key `fb|<dayKey>|<b>`.
 *
 * State does not matter here and must not: "I did tonight's 115 block" and "I am
 * not doing tonight's 115 block" are different sentences about the deliverable
 * and the same sentence about the block, which is that it is not to be offered
 * again today. Tombstones are applied first (resolveMarks), so an unchecked
 * session comes straight back into the plan. PURE.
 */
export function closedSessionBuckets(completions, dayKey) {
  const out = new Set();
  if (!DAY_KEY_RE.test(String(dayKey ?? ""))) return out;
  for (const key of Object.keys(resolveMarks(completions))) {
    const session = parseSessionKey(key);
    if (session && session.day === dayKey) out.add(session.bucket);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {object}   o
 * @param {Array}    o.items     payload items ({k,c,cid,t,d,ty,s,a,src,...})
 * @param {object}   o.weights   config.difficulty, course code -> 0..5
 * @param {object}   o.allocWeights  data/study-model.json allocs; overrides
 *                                   `weights` per bucket, 0 still means muted
 * @param {object}   o.standardsPlan   { course?, weeks?, week?, standards?, sittings?, reassessment? }
 *                                  Absent, or without a `course`, means the
 *                                  whole standards subsystem stays dormant.
 * @param {string}   o.standardsCourse  overrides standardsPlan.course
 * @param {Date}     o.now       render time
 * @param {number}   o.days      horizon, default 7
 * @param {object}   o.leadTimeDays  config.leadTimeDays
 * @param {object}   o.studyMinutes  config.studyMinutes (see DEFAULT_STUDY_MINUTES)
 * @param {object}   o.tuning    config.focus.tuning; partial, merged over
 *                               DEFAULT_TUNING (see resolveTuning)
 * @param {string}   o.wakeTime  config.wakeTime "HH:MM" - hard floor for every start
 * @param {object}   o.schedule  config.schedule; attend:true meetings are busy time
 * @param {Array}    o.board     data/board-items.json board[] (open side-project work)
 * @param {string}   o.sideBucket  config.sideProject.label - the bucket name
 * @param {object}   o.sideProject config.sideProject {minDailyMinutes, maxDailyMinutes}
 * @param {object}   o.completions  the user's marks - the effective map, a raw
 *                                  store, or a bare map (see PART 5). Items
 *                                  marked done OR cancelled never get blocks;
 *                                  session keys never touch an item.
 * @param {object}   o.blockEdits   data/block-edits.json {v,edits,history} - the
 *                                  user's own drags and resizes (PART 4).
 * @param {Array}    o.previousFocus  the focus array of the LAST render
 *                                  (data/focus-plan.json), so today's blocks
 *                                  that have already started are kept rather
 *                                  than re-derived (PART 6). Absent/empty means
 *                                  today is planned whole.
 * @param {string}   o.tz        IANA zone. REQUIRED - see the header.
 * @param {object}   o.notes     dayKey -> one-line agent rationale
 * @returns {Array<{d:string, blocks:Array<{c,what,why,t?,mins,pinned?,kept?}>, note?:string}>}
 */
export function computeFocus({
  items = [],
  weights = {},
  allocWeights = null,
  standardsPlan = null,
  standardsCourse = null,
  now = new Date(),
  days = 7,
  leadTimeDays = DEFAULT_LEAD_DAYS,
  studyMinutes = DEFAULT_STUDY_MINUTES,
  tuning = null,
  wakeTime = null,
  schedule = null,
  board = [],
  sideBucket = DEFAULT_SIDE_BUCKET,
  sideProject = null,
  completions = null,
  blockEdits = null,
  previousFocus = null,
  tz = null,
  notes = {},
} = {}) {
  // A planner with no zone would bucket every due date by the machine's own
  // clock and produce a plausible plan for the wrong day. That is worse than no
  // plan, so it is a hard stop rather than a default.
  if (typeof tz !== "string" || !tz.trim()) {
    throw new Error("focus-engine: computeFocus needs a tz (IANA timezone) - it is config.timezone");
  }
  const tune = resolveTuning(tuning);
  // The standards subsystem is dormant unless a course is named. `null` is the
  // ordinary state for the many users who have no standards-graded course.
  const STANDARDS_COURSE = standardsCourse ?? standardsPlan?.course ?? null;
  const SIDE_BUCKET = typeof sideBucket === "string" && sideBucket.trim() ? sideBucket.trim() : DEFAULT_SIDE_BUCKET;

  const horizon = Math.max(1, Math.floor(days) || 7);
  const todayKey = localDayKey(now, tz) ?? new Date().toISOString().slice(0, 10);
  const dayKeys = Array.from({ length: horizon }, (_, i) => addDays(todayKey, i));
  const dayIndex = new Map(dayKeys.map((k, i) => [k, i]));

  // The study model decides; config.difficulty is the fallback, not the ceiling.
  const weightOf = (course) => {
    const a = allocWeights?.[course];
    if (typeof a === "number" && Number.isFinite(a)) return a;
    const w = weights?.[course];
    return typeof w === "number" && Number.isFinite(w) ? w : DEFAULT_WEIGHT;
  };
  const leadOf = (type) => {
    const l = leadTimeDays?.[type];
    if (typeof l === "number" && Number.isFinite(l)) return l;
    const d = leadTimeDays?.default;
    return typeof d === "number" && Number.isFinite(d) ? d : DEFAULT_LEAD_DAYS.default;
  };

  const deduped = dedupeByKey(items, todayKey, tz);
  const floor = wakeFloor(wakeTime, tune);

  // ---- 0. the user's own edits (PART 4) ---------------------------------
  // `pins` is what they moved; `prefs` is what those moves have taught us.
  const pins = pinnedBlocks(blockEdits);
  const prefs = learnedPreferences(blockEdits);
  /** A preference only exists once the same course has been edited twice. */
  const learnedOf = (course) => {
    const p = prefs.get(course);
    return p && p.n >= LEARN_MIN_SAMPLES ? p : null;
  };
  const learnedShift = (course) => {
    const p = learnedOf(course);
    return p ? Math.max(-LEARN_MAX_SHIFT, Math.min(LEARN_MAX_SHIFT, Math.round(p.startShift))) : null;
  };
  const learnedRatio = (course) => {
    const p = learnedOf(course);
    return p ? Math.max(LEARN_MIN_RATIO, Math.min(LEARN_MAX_RATIO, p.sizeRatio)) : null;
  };

  // ---- 1. real deliverables -> candidates -------------------------------
  // candidates[dayIndex] = [{ course, score, need, item, lag, lead, dayKey, tz }]
  const candidates = dayKeys.map(() => []);
  // Fixed commitments the packer must not schedule over.
  const busy = dayKeys.map(() => []);

  // The timetable is a commitment for the courses the user actually attends.
  // attend:false courses are deliberately NOT busy: those hours are free study
  // time, which is the whole reason the study model boosts their allocation.
  dayKeys.forEach((dayKey, i) => {
    for (const meeting of classMeetings(schedule, dayKey)) {
      if (meeting.attend) busy[i].push([meeting.start, meeting.end]);
    }
  });

  // CLOSED work never generates a block (PART 5). `completions` may be the
  // effective map render.mjs passes, or the raw store itself - resolveMarks
  // takes all three and applies the tombstones, so an unchecked mark brings its
  // work straight back into the plan.
  const doneKeys = resolveMarks(completions);
  const isClosed = (item) =>
    item?.s === true ||
    item?.cancelled === true ||
    (item?.k && Object.prototype.hasOwnProperty.call(doneKeys, item.k));

  // ---- 0b. the clock, and the day as it has already been lived (PART 6) ----
  //
  // Two cuts, one clock. `pastCut` is "how far into today we are", and it is
  // what decides whether a block already happened. `cut` is that same minute
  // clamped into the study window so [cut, windowEnd] is a real interval to pack
  // into. They differ only after the window has closed - a render at 23:20 packs
  // nothing (there is nowhere left) but must still keep the evening it planned,
  // and clamping the record down to 22:30 would quietly delete the last block of
  // the day from the only place it is written down.
  const todayWindowEnd = dayWindow(todayKey, studyMinutes, floor, tune).end;
  const pastCut = cutMinute(now, tz, floor, tune);
  const cut = Math.min(pastCut, todayWindowEnd);
  // Before the floor, nothing has started - not even a block a pin put at 08:00,
  // because "the user is asleep" is exactly what the floor means. So the early
  // run keeps nothing, treats no pin as history, and plans the day whole;
  // `dayStarted` is that one question, asked once.
  const dayStarted = pastCut > floor;
  const keptToday = dayStarted ? keptBlocks(previousFocus, todayKey, pastCut) : [];
  const keptBuckets = new Set(keptToday.map((b) => b.c));
  const keptMinutes = keptToday.reduce((sum, b) => sum + b.mins, 0);
  // Section B: a session the user has closed today is not offered again today.
  const closedToday = closedSessionBuckets(doneKeys, todayKey);

  for (const item of deduped) {
    if (!item || isClosed(item)) continue; // done or cancelled - either way, not work
    if (!item.d) continue; // contract: undated things live in mail[], not items[]
    const dueKey = localDayKey(item.d, tz);
    if (!dueKey) continue;

    // An exam that starts at a plausible sitting hour is time the user is not
    // free, whatever the course weight says.
    const di = dayIndex.get(dueKey);
    if (item.ty === "exam" && di !== undefined) {
      const start = localMinuteOfDay(item.d, tz);
      if (start !== null && start >= BUSY_EARLIEST && start <= BUSY_LATEST) {
        busy[di].push([start, start + EXAM_BUSY_MINUTES]);
      }
    }

    const course = item.c || "Other";
    const weight = weightOf(course);
    if (weight <= 0) continue; // seminar / muted course: never in focus
    const lead = leadOf(item.ty);
    const dueOffset = dayDiff(todayKey, dueKey);

    for (let i = 0; i < horizon; i++) {
      const lag = dueOffset - i;
      if (lag > lead) continue; // too early to start
      if (lag < 0 && i !== 0) continue; // overdue work only nags on today
      const urgency = URGENCY_SCALE * (1 - Math.max(0, lag) / (lead + 1));
      const overdue = lag < 0 ? OVERDUE_BONUS : 0;
      const score = weight + (TYPE_WEIGHT[item.ty] ?? TYPE_WEIGHT.other) + urgency + overdue;
      const need =
        Math.max(1, weight) *
        (1 + (urgency + overdue) / URGENCY_SCALE) *
        (NEED_TYPE_FACTOR[item.ty] ?? NEED_TYPE_FACTOR.other);
      candidates[i].push({ course, score, need, item, lag, lead, dayKey: dayKeys[i], tz });
    }
  }

  // ---- 2. standards practice (synthetic, plan-driven) --------------------
  // With no standards course configured this whole part is inert: no sittings
  // are collected, nothing becomes a fixed commitment, and no synthetic
  // candidate is ever produced.
  const sittings = STANDARDS_COURSE ? collectSittings(standardsPlan, deduped, tz, STANDARDS_COURSE) : [];
  const attended = sittings.filter((s) => sittingAttendance(s) === "yes");
  const unknown = sittings.filter((s) => sittingAttendance(s) === "unknown");
  const standardsWeight = STANDARDS_COURSE ? weightOf(STANDARDS_COURSE) : 0;
  const synthetic = dayKeys.map(() => null);

  // A sitting the user is actually attending is a fixed commitment too.
  for (const s of attended) {
    const di = dayIndex.get(s.date);
    if (di === undefined) continue;
    const start = minutesOfClock(s.time);
    if (start === null || start < BUSY_EARLIEST || start > BUSY_LATEST) continue;
    busy[di].push([start, start + SITTING_BUSY_MINUTES]);
  }

  if (standardsPlan && STANDARDS_COURSE && standardsWeight > 0) {
    const weeks = Array.isArray(standardsPlan.weeks) && standardsPlan.weeks.length
      ? standardsPlan.weeks
      : standardsPlan.week
        ? [standardsPlan.week]
        : [];
    const examLead = leadOf("exam");

    for (let i = 0; i < horizon; i++) {
      const dayKey = dayKeys[i];
      const week = [...weeks].reverse().find((w) => w.start <= dayKey) ?? weeks[0] ?? null;
      // ONLY sittings the user is actually sitting create urgency. One they
      // skipped, or one whose signup we have no evidence of, must not turn
      // Monday-to-Wednesday into a cram.
      const sitting = attended.find((s) => dayDiff(dayKey, s.date) >= 0);
      const lag = sitting ? dayDiff(dayKey, sitting.date) : null;
      const maybe = unknown.find((s) => {
        const gap = dayDiff(dayKey, s.date);
        return gap >= 0 && gap <= MENTION_WINDOW_DAYS;
      });

      // Standards to work on: this week's focus, minus anything already met.
      const focusIds = (week?.focus ?? []).filter((id) => standardsPlan.standards?.[id]?.status !== "met");
      const targets = focusIds.length
        ? focusIds
        : sitting?.standards?.length
          ? sitting.standards
          : week?.focus ?? [];
      if (!targets.length && !sitting) continue;

      const near = lag !== null && lag <= examLead;
      const urgency = near ? URGENCY_SCALE * (1 - lag / (examLead + 1)) : 0;
      const score =
        standardsWeight +
        (near ? TYPE_WEIGHT.exam : STEADY_PRACTICE) +
        urgency +
        PLAN_FOCUS_BONUS;
      const need =
        Math.max(1, standardsWeight) *
        (1 + urgency / URGENCY_SCALE) *
        (near ? NEED_TYPE_FACTOR.exam : 1);

      const label = targets.length ? targets.join(", ") : sitting?.label ?? "standards";
      const where = (s) => [s?.time, s?.room].filter(Boolean).join(" ");
      let what;
      if (near && lag === 0) {
        const at = where(sitting);
        what = `Light review, then ${sitting.label || "sitting"}${at ? " " + at : ""}`;
      } else if (near && lag === 1) {
        what = `Timed self-test on ${label}`;
      } else {
        what = `Practice ${label} (2 problems each)`;
        if (near && sitting) what += `; sitting ${weekdayOfKey(sitting.date)} ${where(sitting)}`.trimEnd();
      }
      // Unknown attendance earns one clause, never a boost and never the lead.
      if (maybe && !(near && lag === 0)) {
        const at = where(maybe);
        const when = dayDiff(dayKey, maybe.date) === 0 ? "tonight" : weekdayOfKey(maybe.date);
        what += `; optional reassessment ${when}${at ? " " + at : ""} only if you signed up`;
      }
      const why = near
        ? lag === 0
          ? "sitting today"
          : `sitting in ${lag} day${lag === 1 ? "" : "s"}`
        : "standards plan for this week";

      // The sitting itself is the hard stop on a sitting day.
      const sittingStart = near && lag === 0 ? minutesOfClock(sitting?.time) : null;
      synthetic[i] = {
        c: STANDARDS_COURSE,
        what: what.replace(/\s+/g, " ").trim(),
        why,
        score,
        need,
        ...(sittingStart !== null ? { limit: sittingStart } : {}),
      };
    }
  }

  // ---- 2b. the side project: a floor instead of a deadline ----------------
  // Open side-project work is either an entry on the work board (undated) or a
  // dated item in that bucket; the dated ones already produce candidates above,
  // and the board is what would otherwise be invisible to a deadline-driven
  // engine.
  const boardEntries = Array.isArray(board) ? board.filter((b) => b && typeof b === "object") : [];
  const sideWeight = weightOf(SIDE_BUCKET);
  const sideOpenItems = deduped.filter((it) => it?.c === SIDE_BUCKET && !isClosed(it));
  const sideActive = sideWeight > 0 && (boardEntries.length > 0 || sideOpenItems.length > 0);
  const sideMin = Number.isFinite(sideProject?.minDailyMinutes) ? sideProject.minDailyMinutes : 0;
  const sideMax = Number.isFinite(sideProject?.maxDailyMinutes) ? sideProject.maxDailyMinutes : tune.maxBlock;
  const sideBlock = () => {
    const named = boardEntries
      .slice(0, SIDE_NAMED_ON_BOARD)
      .map((b) => clip(shortTitle(b.t ?? b.title ?? "board item")));
    const extra = boardEntries.length - named.length;
    const what = named.length
      ? `Push ${named.join(" + ")}${extra > 0 ? ` (+${extra} more on the board)` : ""}`
      : `Work the ${SIDE_BUCKET} board`;
    const why = boardEntries.length
      ? `${boardEntries.length} open board item${boardEntries.length === 1 ? "" : "s"}`
      : "keep the side project moving";
    return {
      c: SIDE_BUCKET,
      what,
      why,
      score: sideWeight + TYPE_WEIGHT.task + SIDE_STEADY,
      need: Math.max(1, sideWeight) * NEED_TYPE_FACTOR.task,
    };
  };

  // ---- 3. group by course, pick + size + place the day's blocks -----------
  return dayKeys.map((dayKey, i) => {
    const today = i === 0;
    const kept = today ? keptToday : [];
    const groups = new Map();
    for (const cand of candidates[i]) {
      if (!groups.has(cand.course)) groups.set(cand.course, []);
      groups.get(cand.course).push(cand);
    }

    const blocks = [];
    for (const [course, list] of groups) {
      list.sort((a, b) => b.score - a.score || a.lag - b.lag || String(a.item.t).localeCompare(String(b.item.t)));
      const primary = list[0];
      const named = sameDeadline(list, primary);
      const score = primary.score + Math.min(MAX_DENSITY_BONUS, DENSITY_BONUS * (list.length - 1));
      const what = `${verbFor(primary)} ${titleList(named)}`.replace(/\s+/g, " ").trim();
      // Work due later today has to be finished before it is due.
      const limit = primary.lag === 0 ? localMinuteOfDay(primary.item.d, tz) : null;
      blocks.push({
        c: course,
        what,
        why: whyFor(primary, i),
        score,
        need: primary.need,
        ...(limit !== null ? { limit } : {}),
      });
    }

    // The synthetic standards block replaces the item-driven one when it scores
    // higher (a sitting outranks "submit the ethics paper in 9 days").
    const syn = synthetic[i];
    if (syn) {
      const existing = blocks.findIndex((b) => b.c === STANDARDS_COURSE);
      if (existing === -1) blocks.push({ ...syn });
      else if (syn.score > blocks[existing].score) blocks[existing] = { ...syn };
    }

    // The side project never has a deadline to compete with, so it is entered as
    // a standing candidate on every day open work exists - and then guaranteed a
    // slot below.
    if (sideActive && !blocks.some((b) => b.c === SIDE_BUCKET)) blocks.push(sideBlock());

    blocks.sort((a, b) => b.score - a.score || a.c.localeCompare(b.c) || a.what.localeCompare(b.what));

    const { start: dayStart, end: windowEnd, weekend } = dayWindow(dayKey, studyMinutes, floor, tune);
    // PART 6. Today starts where the clock is, not where the window opens, and
    // its budget is what the blocks already lived through have left of it.
    const windowStart = today ? Math.max(dayStart, cut) : dayStart;
    const packFloor = today ? Math.max(floor, cut) : floor;
    const budget = Math.max(0, dayBudget(weekend, studyMinutes, tune) - (today ? keptMinutes : 0));
    // A bucket already on today's record, or whose session the user has closed
    // today, is not offered again today: one block per (day, bucket) is what the
    // fb|day|bucket session keys are built on, and a closed session is an answer
    // the engine has no business asking twice.
    const spent = today && (kept.length || closedToday.size)
      ? (course) => keptBuckets.has(course) || closedToday.has(course)
      : null;

    // PART 4 - APPLY. A pinned course leaves the pool entirely: it keeps the
    // block the engine would have written for it (or the best candidate it had,
    // or a bare self-study block), takes the user's start and duration verbatim,
    // and is never sized, moved or dropped with the rest.
    //
    // PART 6 puts two conditions on a pin for TODAY. A pin already behind the
    // clock is history - the previous render either honoured it (and it is kept
    // above) or the hour has simply passed - and a pin for a bucket that is
    // already spent loses to that, because section B outranks a pin: the user
    // dragged the block once, and then said she was done with it.
    //
    // "Behind the clock" is measured against `pastCut`, the same unclamped
    // minute `keptBlocks` uses, and NOT against the window-clamped `cut`. They
    // differ only after the window has closed, and there the clamped test gets
    // it exactly backwards: at 23:20 with a window ending at 22:30, a pin at
    // 23:00 is not before `cut` (22:30), so it would be republished as a live
    // block twenty minutes in the past.
    const pinList = [];
    let pool = spent ? blocks.filter((b) => !spent(b.c)) : blocks;
    for (const [course, pin] of pins.get(dayKey) ?? []) {
      // (a spent course is already out of the pool; a merely-past pin leaves its
      // course free to earn an ordinary block in the hours that are left. A day
      // that has not started yet has no past for a pin to fall into.)
      if (today && ((dayStarted && pin.start < pastCut) || spent?.(course))) continue;
      pinList.push({ block: pool.find((b) => b.c === course) ?? selfStudyBlock(course, SIDE_BUCKET), ...pin });
      pool = pool.filter((b) => b.c !== course);
    }
    // Pinned minutes are spent first; everything else shares what is left.
    const pinnedMins = pinList.reduce((sum, p) => sum + p.mins, 0);
    const rest = Math.max(0, budget - pinnedMins);

    // Never promise more blocks than the budget can fund at the 30-minute floor,
    // and - PART 6 - never any at all once what is left of the day is too short
    // to hold one. A day whose window has run out gets its record and nothing
    // else; the work is not lost, it is tomorrow's.
    const room = windowEnd - windowStart < tune.minBlock
      ? 0
      : pinList.length || kept.length
        ? Math.max(0, Math.floor(rest / tune.minBlock))
        : Math.max(1, Math.floor(budget / tune.minBlock));
    const limit = Math.max(0, Math.min(tune.maxBlocksPerDay - pinList.length - kept.length, room));
    const chosen = pool.slice(0, limit);

    // A day with open side-project work always carries one of its blocks.
    // config.sideProject.minDailyMinutes is a commitment the user made to the
    // side project, so on a day that is already full it gets an EXTRA slot
    // rather than evicting coursework - the minute budget still holds, the
    // blocks just get shorter. Only when the budget cannot fund another block at
    // the minimum does it displace the lowest-scoring block instead.
    if (sideActive && sideMin > 0 && !pinList.some((p) => p.block.c === SIDE_BUCKET) && !chosen.some((b) => b.c === SIDE_BUCKET)) {
      const kb = pool.find((b) => b.c === SIDE_BUCKET);
      if (kb) {
        if (chosen.length < room) chosen.push(kb);
        else if (chosen.length) chosen[chosen.length - 1] = kb;
        chosen.sort((a, b) => b.score - a.score || a.c.localeCompare(b.c) || a.what.localeCompare(b.what));
      }
    }

    const needs = chosen.map((b) => b.need);
    // PART 4 - LEARN, half one: a course the user keeps resizing has its share
    // scaled before anything is rounded, floored, capped or shaved.
    const ratios = chosen.map((b) => learnedRatio(b.c));
    let mins = allocateMinutes(needs, rest, ratios.some((r) => r !== null) ? ratios : null, tune);
    // The side project's daily allowance is a band, not a share of need:
    // config.sideProject min/maxDailyMinutes, funded out of this same budget.
    const sideIdx = chosen.findIndex((b) => b.c === SIDE_BUCKET);
    if (sideActive && sideIdx !== -1 && (sideMin > 0 || sideMax < tune.maxBlock)) {
      mins = enforceBlockMinutes(mins, needs, sideIdx, sideMin, sideMax, rest, tune);
    }
    // A pinned block is a fixed commitment like any class or exam - and so is a
    // block that has already been lived through.
    const dayBusy = pinList.length || kept.length
      ? [
          ...busy[i],
          ...kept.map((b) => [minutesOfClock(b.t), minutesOfClock(b.t) + b.mins]),
          ...pinList.map((p) => [p.start, p.start + p.mins]),
        ]
      : busy[i];
    // Placement order: an earlier hard finish jumps the queue, otherwise the
    // most important work gets the first (freshest) slot.
    const order = chosen
      .map((b, idx) => ({
        id: idx,
        mins: mins[idx],
        limit: b.limit ?? null,
        effective: Math.min(b.limit ?? windowEnd, windowEnd),
        score: b.score,
        c: b.c,
      }))
      .sort((a, b) => a.effective - b.effective || b.score - a.score || a.c.localeCompare(b.c));
    let placed = packDay(order, windowStart, windowEnd, dayBusy, packFloor, tune);

    // PART 4 - LEARN, half two: the shift is measured against where the engine
    // puts the block on its own, so pack once to find that out and once more
    // with the preferred hour as a soft target.
    if (order.some((e) => learnedShift(e.c) !== null)) {
      const targeted = order.map((e) => {
        const shift = learnedShift(e.c);
        const natural = placed.get(e.id);
        if (shift === null || natural === undefined) return e;
        const latest = Math.max(windowStart, windowEnd - e.mins);
        return { ...e, target: Math.min(Math.max(natural + shift, windowStart), latest) };
      });
      placed = packDay(targeted, windowStart, windowEnd, dayBusy, packFloor, tune);
    }

    const out = chosen.map((b, idx) => {
      const t = placed.get(idx);
      return {
        c: b.c,
        what: b.what,
        why: b.why,
        ...(t === undefined ? {} : { t: clockOf(t) }),
        mins: mins[idx],
      };
    });

    // The day reads forwards: what has already happened (PART 6), then the
    // blocks the user chose herself, then the engine's own plan for the hours
    // that are left. Kept blocks all start before `cut` and everything else at
    // or after it, so this is chronological as well as hierarchical.
    const dayBlocks = kept.length || pinList.length
      ? [
          ...kept,
          ...[...pinList]
            .sort((a, b) => a.start - b.start || a.block.c.localeCompare(b.block.c))
            .map((p) => ({
              c: p.block.c,
              what: p.block.what,
              why: p.block.why,
              t: clockOf(p.start),
              mins: p.mins,
              pinned: true,
            })),
          ...out,
        ]
      : out;

    const note = notes?.[dayKey];
    return { d: dayKey, blocks: dayBlocks, ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}) };
  });
}

export default computeFocus;
