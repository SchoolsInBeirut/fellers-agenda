#!/usr/bin/env node
// behind.mjs - the deterministic "is the user behind?" verdict for the agenda.
//
// Everything the agenda knows is already on disk by the time this runs. This file
// reads that local JSON and answers ONE question with no network, no clock beyond
// `now`, and no judgement calls: is there something the user is late on, and how
// loudly should this run say so.
//
// ---------------------------------------------------------------------------
// WHAT "NOT DONE" MEANS (the rule that keeps this file honest)
//
//   confirmed(item) = s === true                      (grade / submission / reply)
//                  OR cancelled === true               (the user decided not to)
//                  OR an EFFECTIVE mark on its key in data/user-completions.json
//                     (done or cancelled; a mark they unchecked does not count)
//                  OR key in the payload done[] set     (last published truth,
//                     minus its `state:"cleared"` entries, which are revocations)
//
// An item is a trigger only when confirmed() is FALSE. `s === false` is NEVER a
// trigger, in any rule, deliberately:
//   - `submitted` is tri-state and `false` is a CLAIM, not a default. `null`
//     means "the source could not tell", which is what most items carry and is
//     the correct answer for them.
//   - Almost nothing in a real snapshot carries `false`, because almost no
//     source states non-submission outright. A rule keyed on `false` is
//     therefore structurally unreachable - it would look like a working alarm
//     and never fire once.
//   - And when a source DOES write `false` wrongly - a quiz endpoint that
//     reports zero attempts for work the gradebook has already scored - reading
//     it as a trigger is exactly how a user gets told they have not done work
//     they have already done. See docs/design-notes/data-truth.md.
// So: absence of proof of completion is what fires here, never proof of absence.
//
// data/overrides.json (written by command-ingest.mjs `defer`) supplies the
// EFFECTIVE due date for the date rules. A defer can only ever move a due date
// LATER, so an override can only ever SILENCE an alert, never invent one - and
// silencing something the user deliberately pushed from their phone an hour ago
// is the whole point. The scraped date in data/latest.json is never rewritten.
//
// ---------------------------------------------------------------------------
// THE RULES (each one fires at most once, each one is a pure function)
//
//   B1  high    not confirmed AND effective due < now.  True overdue.
//   B2  high    not confirmed AND due inside the next 24h.
//   B3  medium  not confirmed AND due in the 24h-48h band (B2 owns the inner one).
//   B4  medium  the standards-course week is >= 60% elapsed, every focus standard
//               for that week is still "todo", and ZERO minutes are logged against
//               the course this week. Three independent silences, not one. The
//               whole rule is dormant when no standards course is configured.
//   B5  HIGH    it is Saturday or Sunday AND an opt-in reassessment sitting falls
//               in the next 7 days AND there is no attending:true evidence for it.
//               The signup survey for an opt-in sitting typically closes the
//               Sunday before it, so a weekend with no signup on record is the
//               last moment anything can still be done about it.
//   B6  medium  a sitting the user is ACTUALLY sitting is <= 14 days out and fewer
//               than half its target standards are met.
//   B7  low     unconsumed completion/command Drive docs older than 6h (passed in
//               by the caller, --stale-docs). Self-diagnostic: the PIPELINE is
//               behind, not the user, and the summary says so.
//
//   level = "behind" if any high fired, "notice" if only medium/low fired,
//           "clear" otherwise.
//
//   rules[] comes back RANKED, worst first, so a caller with room for one line
//   leads with rules[0] and counts the rest. See SEVERITY_RANK.
//
// B5 and attending:false - a deliberate non-fire. sittings[] carries three states
// (focus-engine sittingAttendance): yes / no / unknown. B5 fires on "unknown",
// which is the risk this rule exists for, and NOT on "no" - an explicit
// attending:false is the user having decided, recorded from their own words, and
// data/study-plan.json says such a sitting "contributes zero urgency". Nagging a
// decision every weekend is how an alarm gets ignored. Declined sittings are still
// listed in the rule detail so the verdict never hides one. Flip
// B5_FIRE_ON_DECLINED to change this in one place.
//
// This file NEVER writes anything and never sends anything. It prints a verdict;
// the playbook (runbooks/heavy-run.md 5b.4) decides what to do with it inside the one-push cap.
//
// ---------------------------------------------------------------------------
// CLI
//   node src/behind.mjs --check                       print the verdict as JSON
//   node src/behind.mjs --check --now <ISO>           pretend "now" is this instant
//   node src/behind.mjs --check --stale-docs <n>      B7 input: unconsumed Drive docs
//   node src/behind.mjs --check --stale-oldest <ISO>  oldest of those docs (optional)
//   node src/behind.mjs --check --human               same verdict, one line per rule
//
// Every command also accepts --config <path> and --data <dir>.
//
// Exit codes:
//   0  a verdict was printed - INCLUDING level "behind". A verdict is not an error,
//      so the caller never has to distinguish "bad news" from "broken script".
//   2  usage error (no --check, or a bad flag value)
// Unreadable inputs never fail the run: they land in `warnings[]` and the verdict
// is computed from what could be read. A missing data file makes the agenda quieter,
// so the caller sees the warning rather than a silent "clear".

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isSessionKey, readItem, resolveMarks } from "./completion.mjs";
import {
  dayDiff,
  localDayKey,
  localMinuteOfDay,
  localWeekday,
  sittingAttendance,
} from "./focus-engine.mjs";
import { loadConfig, standardsCourse } from "./lib/config.mjs";
import { configPath, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";
import { EnvelopeError, sliceEnvelope, unpack } from "./lib/envelope.mjs";

// --------------------------------------------------------------- constants

/**
 * The zone to reckon local days in when nobody has said which one. UTC is the
 * only answer that is not a guess about where the user lives; every real run
 * threads `config.timezone` through instead, and the pure helpers take `tz`
 * explicitly so a test never depends on the machine it runs on.
 */
export const FALLBACK_TZ = "UTC";

export const SEVERITY = { high: "high", medium: "medium", low: "low" };
export const LEVEL = { clear: "clear", notice: "notice", behind: "behind" };

// rules[] comes back RANKED: highest severity first, and within one severity in
// rule order (B1 before B2 before ...). A caller that has room for exactly one
// line - which is every caller, given the one-push cap - leads with rules[0] and
// counts the rest. Without this a medium B3 could sit above a high B5 purely
// because 3 is less than 5.
export const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

const HOUR_MS = 3600 * 1000;
export const DUE_SOON_HOURS = 24; // B2 window
export const DUE_NEXT_HOURS = 48; // B3 window (outer edge)
export const WEEK_ELAPSED_TRIGGER = 0.6; // B4: 60% of the study week gone
export const WEEK_DAYS = 7;
export const SITTING_WEEKEND_DAYS = 7; // B5: "the coming week"
export const EXAM_HORIZON_DAYS = 14; // B6
export const STANDARD_READY_RATIO = 0.5; // B6: fewer than half met
export const STALE_DOC_HOURS = 6; // B7
export const B5_FIRE_ON_DECLINED = false; // see the header note on attending:false

const TODO = "todo";
const LIST_CAP = 3; // how many item titles a summary names before "and N more"

// ------------------------------------------------------------- pure helpers

const ms = (value) => {
  const t = new Date(value ?? "").getTime();
  return Number.isNaN(t) ? null : t;
};

/** Human date for a summary line: "Sep 1". Never throws on junk. */
function shortDate(value, tz = FALLBACK_TZ) {
  const key = localDayKey(value, tz);
  if (!key) return "no date";
  const [, m, d] = key.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1] ?? "?"} ${d}`;
}

/** "PHYS 221 Homework 2 (Sep 1), ART 101 Quiz 3 (Sep 2) and 4 more" */
function nameThem(views, tz) {
  const named = views.slice(0, LIST_CAP).map((v) => `${v.course} ${v.title} (${shortDate(v.due, tz)})`);
  const extra = views.length - named.length;
  return named.join(", ") + (extra > 0 ? ` and ${extra} more` : "");
}

/**
 * The set of item keys that are NOT open work, by something other than the
 * scrape's tri-state flag: the user's own record plus the last published
 * payload's done[].
 *
 * Four refinements, all of them about honesty:
 *   - the record is read through resolveMarks(), so a mark the user UNCHECKED
 *     (a newer tombstone) drops out and its work is open again. Unchecking has
 *     to mean something, or the uncheck is a lie.
 *   - a CANCELLED mark counts here. The work is not done, but the user decided
 *     not to do it, and nagging someone about a decision they made is how an
 *     alarm gets ignored (same reasoning as B5 and attending:false).
 *   - SESSION keys ("fb|<day>|<bucket>") are skipped. They close one study
 *     block, never a deliverable; letting one in would silence an assignment
 *     because an evening of work on it went well.
 *   - the payload's done[] is a LEDGER, not a done list: an entry
 *     with `state:"cleared"` is a REVOCATION and is skipped here. Counting one
 *     as a completion would make `--undone` a no-op for every rule in this file,
 *     which is precisely backwards.
 * PURE.
 */
export function confirmedKeys(completions, doneList) {
  const keys = new Set();
  for (const k of Object.keys(resolveMarks(completions))) if (!isSessionKey(k)) keys.add(k);
  for (const entry of Array.isArray(doneList) ? doneList : []) {
    const k = typeof entry === "string" ? entry : entry?.k;
    if (typeof entry === "object" && entry?.state === "cleared") continue;
    if (typeof k === "string" && k && !isSessionKey(k)) keys.add(k);
  }
  return keys;
}

/**
 * Is this item settled, by any channel we trust? `s === false` is not consulted
 * - see the header. An item carrying `cancelled: true` (render.mjs writes the
 * flag from the user's own mark) is settled too: not done, but not owed either.
 * PURE.
 */
export function isConfirmed(item, keys) {
  const view = readItem(item);
  if (view.submitted === true || view.cancelled === true) return true;
  return !!(view.key && keys && keys.has(view.key));
}

/** deferTo from data/overrides.json wins over the scraped due date. PURE. */
export function effectiveDue(view, overrides) {
  const o = overrides && view.key ? overrides[view.key] : null;
  const deferred = o && typeof o.deferTo === "string" ? o.deferTo : null;
  if (!deferred || ms(deferred) === null) return { due: view.due, deferred: false };
  return { due: deferred, deferred: true };
}

/** Accept `{overrides:{...}}` or the bare map the contract writes. PURE. */
export function overridesMap(source) {
  if (!source || typeof source !== "object") return {};
  const map = source.overrides && typeof source.overrides === "object" ? source.overrides : source;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof k === "string" && k && v && typeof v === "object") out[k] = v;
  }
  return out;
}

/** Is a snooze in force? Reported, never applied - the playbook decides. PURE. */
export function snoozeState(snooze, now) {
  const until = snooze && typeof snooze.until === "string" ? snooze.until : null;
  const untilMs = ms(until);
  const active = untilMs !== null && untilMs > now.getTime();
  return { active, until, why: (snooze && typeof snooze.why === "string" ? snooze.why : "") || "" };
}

/**
 * Fold every input into the one context every rule reads. PURE.
 * `open` holds the unconfirmed items with a usable effective due date, sorted
 * earliest first - that ordering is what makes the summaries readable.
 */
export function buildContext({
  now = new Date(),
  items = [],
  completions = {},
  done = [],
  overrides = {},
  plan = null,
  studyLog = { entries: [] },
  config = {},
  staleDocs = null,
  tz = null,
} = {}) {
  const cfg = config && typeof config === "object" ? config : {};
  const zone = tz || cfg.timezone || FALLBACK_TZ;
  const keys = confirmedKeys(completions, done);
  const oMap = overridesMap(overrides);
  const views = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const view = readItem(raw);
    if (!view.title) continue;
    const { due, deferred } = effectiveDue(view, oMap);
    const dueMs = ms(due);
    views.push({ ...view, due, dueMs, deferred, confirmed: isConfirmed(raw, keys) });
  }
  const open = views
    .filter((v) => !v.confirmed && v.dueMs !== null)
    .sort((a, b) => a.dueMs - b.dueMs);
  return {
    now,
    nowMs: now.getTime(),
    tz: zone,
    todayKey: localDayKey(now, zone),
    views,
    open,
    confirmedKeys: keys,
    overrides: oMap,
    plan: plan && typeof plan === "object" ? plan : null,
    studyLog: studyLog && Array.isArray(studyLog.entries) ? studyLog : { entries: [] },
    config: cfg,
    // null when the standards-plan feature is off. B4 and the sitting rules
    // read this and go dormant rather than guessing at a course code.
    standardsCourse: standardsCourse(cfg),
    staleDocs: staleDocs && typeof staleDocs === "object" ? staleDocs : null,
  };
}

const fired = (id, severity, summary, extra = {}) => ({ id, severity, summary, ...extra });

// ------------------------------------------------------------------- rules

/** B1: past due and nothing says it is done. */
export function ruleOverdue(ctx) {
  const hits = ctx.open.filter((v) => v.dueMs < ctx.nowMs);
  if (!hits.length) return null;
  const worst = Math.floor((ctx.nowMs - hits[0].dueMs) / (24 * HOUR_MS));
  return fired(
    "B1",
    SEVERITY.high,
    `${hits.length} item(s) past due with nothing recorded as done` +
      `${worst >= 1 ? ` (oldest ${worst} day(s) ago)` : ""}: ${nameThem(hits, ctx.tz)}`,
    { itemKeys: hits.map((v) => v.key) },
  );
}

/** B2: inside 24h. */
export function ruleDueToday(ctx) {
  const cut = ctx.nowMs + DUE_SOON_HOURS * HOUR_MS;
  const hits = ctx.open.filter((v) => v.dueMs >= ctx.nowMs && v.dueMs < cut);
  if (!hits.length) return null;
  const soonest = Math.max(0, Math.round((hits[0].dueMs - ctx.nowMs) / HOUR_MS));
  return fired(
    "B2",
    SEVERITY.high,
    `${hits.length} item(s) due within ${DUE_SOON_HOURS}h (next in ~${soonest}h): ${nameThem(hits, ctx.tz)}`,
    { itemKeys: hits.map((v) => v.key) },
  );
}

/** B3: the 24h-48h band only; B2 already owns everything nearer. */
export function ruleDueSoon(ctx) {
  const from = ctx.nowMs + DUE_SOON_HOURS * HOUR_MS;
  const to = ctx.nowMs + DUE_NEXT_HOURS * HOUR_MS;
  const hits = ctx.open.filter((v) => v.dueMs >= from && v.dueMs <= to);
  if (!hits.length) return null;
  return fired(
    "B3",
    SEVERITY.medium,
    `${hits.length} item(s) due in the next ${DUE_SOON_HOURS}-${DUE_NEXT_HOURS}h: ${nameThem(hits, ctx.tz)}`,
    { itemKeys: hits.map((v) => v.key) },
  );
}

/** The study-plan week containing a day key, or null. PURE. */
export function weekOf(plan, dayKey) {
  for (const week of plan?.weeks ?? []) {
    if (typeof week?.start !== "string") continue;
    const offset = dayDiff(week.start, dayKey);
    if (offset >= 0 && offset < WEEK_DAYS) return { ...week, offset };
  }
  return null;
}

/** How much of the study week is gone, 0..1. PURE. */
export function weekElapsed(week, now, tz = FALLBACK_TZ) {
  const minute = localMinuteOfDay(now, tz);
  const partial = minute === null ? 0 : minute / 1440;
  return (week.offset + partial) / WEEK_DAYS;
}

/** Minutes logged against one bucket inside [weekStart, weekStart+7). PURE. */
export function minutesLoggedInWeek(studyLog, bucket, weekStart, tz = FALLBACK_TZ) {
  let total = 0;
  for (const entry of studyLog?.entries ?? []) {
    if ((entry?.c ?? entry?.course) !== bucket) continue;
    const key = localDayKey(entry?.at, tz);
    if (!key) continue;
    const offset = dayDiff(weekStart, key);
    if (offset < 0 || offset >= WEEK_DAYS) continue;
    const mins = Number(entry?.mins);
    if (Number.isFinite(mins) && mins > 0) total += mins;
  }
  return total;
}

/**
 * B4: the standards-course week is running out with nothing to show for it.
 *
 * The plan file names its own course; the configured standards course is the
 * fallback for a plan that does not. With neither, there is no bucket to
 * measure minutes against, so the rule is dormant - it never guesses a course.
 */
export function ruleStudyWeekStalled(ctx) {
  const plan = ctx.plan;
  if (!plan || !ctx.todayKey) return null;
  const bucket =
    (typeof plan.course === "string" && plan.course ? plan.course : null) ?? ctx.standardsCourse ?? null;
  if (!bucket) return null;
  const week = weekOf(plan, ctx.todayKey);
  if (!week) return null;

  const elapsed = weekElapsed(week, ctx.now, ctx.tz);
  if (elapsed < WEEK_ELAPSED_TRIGGER) return null;

  // "retries" / "Synthesis prep" are prose, not standards: a week whose focus
  // resolves to no real standard has nothing this rule can measure.
  const codes = (Array.isArray(week.focus) ? week.focus : []).filter((c) => plan.standards?.[c]);
  if (!codes.length) return null;
  const stillTodo = codes.filter((c) => (plan.standards[c].status ?? TODO) === TODO);
  if (stillTodo.length !== codes.length) return null;

  const mins = minutesLoggedInWeek(ctx.studyLog, bucket, week.start, ctx.tz);
  if (mins > 0) return null;

  return fired(
    "B4",
    SEVERITY.medium,
    `${bucket}: week of ${week.start} is ${Math.round(elapsed * 100)}% gone, ` +
      `${codes.join("/")} still todo, 0 minutes logged`,
    { detail: { bucket, weekStart: week.start, standards: codes, elapsed: Number(elapsed.toFixed(2)), minutes: 0 } },
  );
}

/** Sittings of one kind inside a forward day window. PURE. */
export function sittingsWithin(plan, todayKey, days, kind = null) {
  const out = [];
  for (const sitting of plan?.sittings ?? []) {
    if (typeof sitting?.date !== "string") continue;
    if (kind && sitting.kind !== kind) continue;
    const offset = dayDiff(todayKey, sitting.date);
    if (offset < 0 || offset > days) continue;
    out.push({ ...sitting, inDays: offset, attendance: sittingAttendance(sitting) });
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

/** B5: the weekend the Standard Selection Survey closes. */
export function ruleSurveyWeekend(ctx) {
  if (!ctx.plan || !ctx.todayKey) return null;
  const day = localWeekday(ctx.now, ctx.tz);
  if (day !== "Sat" && day !== "Sun") return null;

  const upcoming = sittingsWithin(ctx.plan, ctx.todayKey, SITTING_WEEKEND_DAYS, "reassessment");
  if (!upcoming.length) return null;

  const declined = upcoming.filter((s) => s.attendance === "no");
  const atRisk = upcoming.filter(
    (s) => s.attendance === "unknown" || (B5_FIRE_ON_DECLINED && s.attendance === "no"),
  );
  if (!atRisk.length) return null;

  const first = atRisk[0];
  return fired(
    "B5",
    SEVERITY.high,
    `Standard Selection Survey closes Sunday 23:59: ${atRisk.length} reassessment sitting(s) ` +
      `in the next ${SITTING_WEEKEND_DAYS} days with no signup on record - ` +
      `${first.label ?? first.date} (${first.date}, ${first.inDays} day(s) out, targets ${(first.targets ?? []).join("/") || "unstated"})`,
    {
      detail: {
        weekday: day,
        atRisk: atRisk.map((s) => ({ date: s.date, label: s.label ?? null, inDays: s.inDays, targets: s.targets ?? [] })),
        declined: declined.map((s) => ({ date: s.date, label: s.label ?? null })),
      },
    },
  );
}

/** B6: an exam the user IS sitting, with the standards not banked yet. */
export function ruleExamStandardsGap(ctx) {
  if (!ctx.plan || !ctx.todayKey) return null;
  const soon = sittingsWithin(ctx.plan, ctx.todayKey, EXAM_HORIZON_DAYS).filter((s) => s.attendance === "yes");
  const gaps = [];
  for (const sitting of soon) {
    const codes = (Array.isArray(sitting.targets) ? sitting.targets : []).filter((c) => ctx.plan.standards?.[c]);
    if (!codes.length) continue; // "retries" / "Synthesis Exam": nothing measurable
    const met = codes.filter((c) => {
      const status = ctx.plan.standards[c].status ?? TODO;
      return status !== TODO;
    });
    const ratio = met.length / codes.length;
    if (ratio >= STANDARD_READY_RATIO) continue;
    gaps.push({
      date: sitting.date,
      label: sitting.label ?? null,
      inDays: sitting.inDays,
      met: met.length,
      target: codes.length,
      missing: codes.filter((c) => !met.includes(c)),
    });
  }
  if (!gaps.length) return null;
  const g = gaps[0];
  return fired(
    "B6",
    SEVERITY.medium,
    `${g.label ?? "sitting"} in ${g.inDays} day(s) (${g.date}): ${g.met}/${g.target} target standards met - ` +
      `still open: ${g.missing.join("/")}`,
    { detail: { sittings: gaps } },
  );
}

/** B7: the pipeline is behind, not the user. */
export function ruleStalePipeline(ctx) {
  const stale = ctx.staleDocs;
  if (!stale) return null;
  const count = Number(stale.count);
  if (!Number.isFinite(count) || count <= 0) return null;
  const oldestMs = ms(stale.oldest);
  const ageHours = oldestMs === null ? null : (ctx.nowMs - oldestMs) / HOUR_MS;
  if (ageHours !== null && ageHours < STALE_DOC_HOURS) return null;
  return fired(
    "B7",
    SEVERITY.low,
    `pipeline behind, not user: ${count} unconsumed completion/command Drive doc(s) ` +
      `older than ${STALE_DOC_HOURS}h${ageHours === null ? "" : ` (oldest ~${Math.round(ageHours)}h)`} - ` +
      `marks or phone commands are sitting in Drive unread`,
    { detail: { count, oldest: stale.oldest ?? null, ageHours: ageHours === null ? null : Math.round(ageHours) } },
  );
}

export const RULES = [
  ruleOverdue,
  ruleDueToday,
  ruleDueSoon,
  ruleStudyWeekStalled,
  ruleSurveyWeekend,
  ruleExamStandardsGap,
  ruleStalePipeline,
];

/** high anywhere -> behind; anything else fired -> notice; nothing -> clear. PURE. */
export function levelOf(rules) {
  if (rules.some((r) => r.severity === SEVERITY.high)) return LEVEL.behind;
  return rules.length ? LEVEL.notice : LEVEL.clear;
}

/**
 * The whole verdict, from data already in memory. PURE - no I/O, no clock beyond
 * the `now` handed in. This is what the tests drive.
 */
export function computeBehind(input = {}) {
  const ctx = buildContext(input);
  // Stable sort: severity decides, rule order breaks ties. See SEVERITY_RANK.
  const rules = RULES.map((rule) => rule(ctx))
    .filter(Boolean)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const counts = {
    fired: rules.length,
    high: rules.filter((r) => r.severity === SEVERITY.high).length,
    medium: rules.filter((r) => r.severity === SEVERITY.medium).length,
    low: rules.filter((r) => r.severity === SEVERITY.low).length,
    items: ctx.views.length,
    confirmed: ctx.views.filter((v) => v.confirmed).length,
    open: ctx.open.length,
    overdue: ctx.open.filter((v) => v.dueMs < ctx.nowMs).length,
    due24h: ctx.open.filter((v) => v.dueMs >= ctx.nowMs && v.dueMs < ctx.nowMs + DUE_SOON_HOURS * HOUR_MS).length,
    due48h: ctx.open.filter((v) => v.dueMs >= ctx.nowMs && v.dueMs <= ctx.nowMs + DUE_NEXT_HOURS * HOUR_MS).length,
    deferred: ctx.views.filter((v) => v.deferred).length,
  };
  return {
    computedAt: ctx.now.toISOString(),
    level: levelOf(rules),
    rules,
    counts,
    snooze: snoozeState(input.snooze, ctx.now),
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
  };
}

// --------------------------------------------------------------------- CLI

function readJson(file, fallback, warnings, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // Absence is normal for the optional files; only say something when the file
    // is there and unreadable, or when a load-bearing one is missing.
    if (label) warnings.push(`${label}: ${e.code === "ENOENT" ? "missing" : e.message}`);
    return fallback;
  }
}

/**
 * Decode the payload envelope back to its done[] list.
 *
 * Both forms are accepted: the plain `AGD1.` copy and the compressed,
 * checksummed `AGD2.` one that actually travels to Drive. Anything else - a
 * truncated document, a completions envelope handed in by mistake, an empty
 * file on a first run - yields an empty list rather than a throw. This is a
 * diagnostic input, and a broken one must make the verdict quieter, never make
 * the run fail.
 */
export function doneFromPayload(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  try {
    // The document carries a plain-text brief after the envelope (src/brief.mjs).
    // Everything past the first `.END` is prose for a phone and is never parsed:
    // `sliceEnvelope` is the one place that boundary is drawn. An `AGD2.` that
    // then fails validation is still a hard refusal - the fallback is an empty
    // ledger, never a looser parse.
    const { kind, data } = unpack(sliceEnvelope(text));
    if (kind !== "data") return [];
    return Array.isArray(data?.done) ? data.done : [];
  } catch (e) {
    if (e instanceof EnvelopeError) return [];
    throw e;
  }
}

/** Every item source the render merges, deduped the same way render.mjs does. */
function loadItems(dataDir, warnings) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const view = readItem(raw);
    if (!view.title || !view.due) return;
    const key = `${view.key}|${view.due}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(raw);
  };
  const snap = readJson(path.join(dataDir, "latest.json"), null, warnings, "data/latest.json");
  for (const raw of snap?.items ?? []) push(raw);
  for (const file of ["outlook-items.json", "board-items.json", "phone-items.json"]) {
    const data = readJson(path.join(dataDir, file), null, warnings, null);
    for (const raw of data?.items ?? []) push(raw);
  }
  return out;
}

function parseArgs(argv) {
  const args = { check: argv.includes("--check"), human: argv.includes("--human") };
  const grab = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  args.now = grab("--now");
  args.staleDocs = grab("--stale-docs");
  args.staleOldest = grab("--stale-oldest");
  return args;
}

function cliMain(argv) {
  const args = parseArgs(argv);
  if (!args.check) {
    console.log(
      "usage: node src/behind.mjs --check [--now <ISO>] [--stale-docs <n>] [--stale-oldest <ISO>] [--human]\n" +
        "       also accepts --config <path> and --data <dir>",
    );
    return 2;
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.log(`bad --now value: ${args.now}`);
    return 2;
  }
  let staleDocs = null;
  if (args.staleDocs !== null) {
    const count = Number.parseInt(args.staleDocs, 10);
    if (!Number.isFinite(count) || count < 0) {
      console.log(`bad --stale-docs value: ${args.staleDocs}`);
      return 2;
    }
    staleDocs = { count, oldest: args.staleOldest ?? null };
  }

  const root = repoRoot();
  const dataDir = resolveDataDir(argv, root);
  const warnings = [];
  let config = {};
  try {
    config = loadConfig(null, { argv, warn: (m) => warnings.push(m) });
  } catch (e) {
    warnings.push(`${configPath(argv, root)}: ${e.message}`);
  }
  const items = loadItems(dataDir, warnings);
  const verdict = computeBehind({
    now,
    items,
    completions: readJson(path.join(dataDir, "user-completions.json"), {}, warnings, "data/user-completions.json"),
    done: doneFromPayload(readSafeText(path.join(dataDir, "payload.b64.txt"))),
    overrides: readJson(path.join(dataDir, "overrides.json"), {}, warnings, null),
    plan: readJson(path.join(dataDir, "study-plan.json"), null, warnings, "data/study-plan.json"),
    studyLog: readJson(path.join(dataDir, "study-log.json"), { entries: [] }, warnings, null),
    config,
    snooze: readJson(path.join(dataDir, "snooze.json"), null, warnings, null),
    staleDocs,
    warnings,
  });

  if (args.human) {
    console.log(`level: ${verdict.level}  (${verdict.counts.fired} rule(s) fired, ${verdict.counts.open} open item(s))`);
    for (const rule of verdict.rules) console.log(`  ${rule.id} [${rule.severity}] ${rule.summary}`);
    if (verdict.snooze.active) console.log(`  snoozed until ${verdict.snooze.until} (${verdict.snooze.why})`);
    for (const w of verdict.warnings) console.log(`  warning: ${w}`);
  } else {
    console.log(JSON.stringify(verdict, null, 2));
  }
  return 0; // always: a verdict is not an error
}

function readSafeText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(cliMain(process.argv.slice(2)));
}
