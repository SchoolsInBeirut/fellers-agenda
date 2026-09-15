// render.mjs - the build step. Snapshot plus state in, one page and one
// envelope out.
//
// It writes three things:
//
//   <data>/payload.b64.txt  the compressed envelope a scheduled run uploads to
//                           the Drive document, and the reason this file cares
//                           about size at all (see BUDGET below).
//   agenda.html             the page: the template with a complete, plain copy
//                           of the payload baked in. Published once as an
//                           artifact; only needs republishing when the template
//                           itself changes.
//   <data>/focus-plan.json  the focus array in the clear, so completion.mjs can
//                           resolve "start hw 1" to the session key of a block
//                           that actually exists.
//
// THE BUDGET, AND WHY IT IS THE INTERESTING PART OF THIS FILE
//
// Nothing here can reach the published page directly. The only channel is a
// Google Doc. In 1.x the only thing that could write into it was an agent - a
// language model read `payload.b64.txt` and typed its exact contents as a tool
// argument, paying for every character twice - and an uncompressed payload of
// this size was a run that could not finish. Since 2.0.0 `src/drive-rclone.mjs`
// carries the bytes over rclone; the budget stays because a small document is
// what a phone reads fastest and what a Doc export mangles least.
//
// So the payload is gzipped before it is base64'd (about a 6x win on JSON with
// keys this repetitive), guarded with a CRC32 so a truncated or reflowed
// export fails loudly instead of half-decoding, and slimmed one announced tier at a
// time until it fits `drive.maxEmitChars`. The run prints which tier it needed.
// If even the last tier is too big, nothing is truncated: the oversize text is
// written to a file, the run says so, and the page falls back to the complete
// copy embedded in the HTML.
//
// THE CLOCK IS PART OF THE PLAN
//
// The engine keeps today's blocks that have already started and re-packs only
// the hours that are left, so a render is a function of WHEN it ran as well as
// of what it read. `now` is taken once at the top, threaded everywhere, and
// printed - and `--now <ISO>` reproduces a past run from its own log line.
//
// Usage:
//   node src/render.mjs [--config <path>] [--data <dir>] [--out <file>]
//                       [--template <file>]
//   node src/render.mjs --gaps           list item keys with no description; writes nothing
//   node src/render.mjs --now <ISO>      plan as if it were that instant
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derive, loadConfigured, pageConfig, standardsCourse } from "./lib/config.mjs";
import { budgetOf, pack, packWithinBudget } from "./lib/envelope.mjs";
import { renderBrief } from "./brief.mjs";
import { argFlag, argHas, argNow, dataDir as resolveDataDir, outPath, repoRoot } from "./lib/paths.mjs";
import { itemKey } from "./merge.mjs";
import { applyUserCompletions, completionLedger, resolveMarks } from "./completion.mjs";
import { allocWeights } from "./study-model.mjs";
import { addDays, computeFocus, extractReassessment, localDayKey, localTimeLabel, localWeekday } from "./focus-engine.mjs";

const MAIL_CAP = 12;
// How many meetings the PAGE may draw. It is a payload-size limit, not a
// statement about the calendar: the planner is given every meeting in the
// horizon, because capping what the planner sees would put study straight
// through meeting 81, which is a real commitment whether or not there was room
// to draw it.
const MEETING_CAP = 80;
// How old the inbound calendar file may get before the page is told. A lane
// that has silently stopped looks exactly like a calendar with nothing on it.
const MEETING_STALE_HOURS = 36;
const HORIZON_DAYS = 7;

const BOARD_CAP = 10; // the board is a nudge, not a backlog viewer
const DONE_WINDOW_DAYS = 14;
const PAYLOAD_VERSION = 4;

const argv = process.argv.slice(2);
const ROOT = repoRoot();
const DATA = resolveDataDir(argv, ROOT);
const GAPS_ONLY = argHas(argv, "gaps");

// An unconfigured repo stops here with one sentence, not a stack trace: the
// person reading it has never opened a terminal, and ten lines of Node internals
// with the useful instruction buried in the middle reads as "I broke it".
const cfg = loadConfigured(["timezone"], { argv });
const derived = derive(cfg);
const TZ = cfg.timezone;

const readJson = (path, fallback) => {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.warn(`warn: could not read ${path}: ${e.message}`);
    return fallback;
  }
};

const latestPath = join(DATA, "latest.json");
if (!existsSync(latestPath)) {
  console.error(
    `render: ${latestPath} does not exist yet.\n` +
      "  Fix: run `node src/scrape.mjs` first, or see a full agenda built from sample\n" +
      "  data with `node scripts/demo.mjs`.",
  );
  process.exit(1);
}
const snap = JSON.parse(readFileSync(latestPath, "utf-8"));
const descriptions = readJson(join(DATA, "descriptions.json"), {});
const now = argNow(argv, "render");

// ---------------------------------------------------------------------------
// Items: the LMS snapshot plus anything another source turned into a task.
// ---------------------------------------------------------------------------

/** Accepts both the internal snapshot shape and the compact payload Item shape. */
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const due = raw.due ?? raw.d;
  const title = raw.title ?? raw.t;
  if (!due || !title) return null; // contract: undated things go to mail[], not items[]
  if (Number.isNaN(new Date(due).getTime())) return null;
  return {
    courseId: raw.courseId ?? raw.cid ?? 0,
    course: raw.course ?? raw.c ?? "Mail",
    title: String(title),
    due: new Date(due).toISOString(),
    type: raw.type ?? raw.ty ?? "task",
    submitted: raw.submitted ?? raw.s ?? null,
    approx: raw.approx ?? raw.a ?? false,
    sources: raw.sources ?? raw.src ?? ["outlook"],
    url: raw.url ?? raw.u ?? null,
    grade: typeof (raw.grade ?? raw.g) === "string" ? (raw.grade ?? raw.g) : null,
    // Mail-derived items arrive with a description already written by the mail
    // connector; data/descriptions.json still wins if it has an entry.
    desc: typeof raw.desc === "string" ? raw.desc : null,
  };
}

const merged = [];
const seen = new Set();
const absorb = (list) => {
  for (const raw of list ?? []) {
    const it = normalizeItem(raw);
    if (!it) continue;
    const key = itemKey(it) + "|" + it.due;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
  }
};
absorb(snap.items);
// A mail sweep can also run after a scrape, so merge again and drop repeats.
absorb(readJson(join(DATA, "outlook-items.json"), { items: [] }).items);
// The board file carries DATED side-project work (a milestone, a demo); its
// undated entries go to payload.board instead. An absent file means dormant.
const boardData = readJson(join(DATA, "board-items.json"), { board: [], items: [] });
absorb(boardData.items);
// Tasks the user added from their phone through the command bus.
absorb(readJson(join(DATA, "phone-items.json"), { items: [] }).items);
merged.sort((a, b) => a.due.localeCompare(b.due) || a.course.localeCompare(b.course));

const descOf = (i) => {
  const fromFile = descriptions[itemKey(i)];
  if (typeof fromFile === "string" && fromFile.trim()) return fromFile.trim();
  if (typeof i.desc === "string" && i.desc.trim()) return i.desc.trim();
  return null;
};

// The user's own record of their own work: "I finished X", "I am not doing X",
// and "actually, un-check that". resolveMarks() applies the tombstones, so what
// comes back is the EFFECTIVE set: done and cancelled entries, keyed by itemKey
// or by session key ("fb|<day>|<bucket>"). Pipeline-origin completions never
// live in this file and are never revocable from it.
//
// The raw store is kept as well: the tombstones in it are not "nothing", they
// are the revocations done[] has to republish, and resolving them away here
// would throw the only pipeline-to-page uncheck channel on the floor.
const completionStore = readJson(join(DATA, "user-completions.json"), { completions: {} });
const completions = resolveMarks(completionStore);

// The items as the PIPELINE has them, before any of the user's marks are
// applied. `s === true` here is the pipeline's own evidence - a grade, a
// submission, a sent reply - and it is what the origin rule is about. The
// distinction is only visible before the apply: afterwards a `true` might be
// the user's own mark, which IS theirs to take back.
const pipelineItems = merged.map((i) => {
  const desc = descOf(i);
  return {
    k: itemKey(i),
    c: i.course,
    cid: i.courseId,
    t: i.title,
    d: i.due,
    ty: i.type,
    s: i.submitted ?? null,
    ...(i.approx ? { a: true } : {}),
    src: i.sources,
    ...(typeof desc === "string" && desc.trim() ? { desc: desc.trim() } : {}),
    ...(typeof i.grade === "string" && i.grade ? { g: i.grade } : {}),
    u: i.url ?? null,
  };
});

const items = applyUserCompletions(pipelineItems, completions);

// ---------------------------------------------------------------------------
// --gaps: which items still need a description written for them?
// ---------------------------------------------------------------------------
if (GAPS_ONLY) {
  const gaps = merged.filter((i) => !descOf(i));
  const todayKey = localDayKey(now, TZ);
  const upcoming = gaps.filter((i) => localDayKey(i.due, TZ) >= todayKey);
  const byKey = new Map();
  for (const i of gaps) if (!byKey.has(itemKey(i))) byKey.set(itemKey(i), i);

  for (const [key, i] of byKey) {
    const when = `${localWeekday(i.due, TZ)} ${localDayKey(i.due, TZ)} ${localTimeLabel(i.due, TZ)}`;
    console.log([key, i.course, i.title, when, i.approx ? "approx" : ""].join("\t").trimEnd());
  }
  console.log(
    `\n${byKey.size} item key(s) missing a description (${upcoming.length} of ${gaps.length} occurrences are still upcoming).`,
  );
  console.log("Write them into data/descriptions.json keyed by the first column, then re-run node src/render.mjs.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The standards-based grading tracker, and the richer view the planner needs.
//
// This whole section is dormant unless a standards course is configured. It is
// for a course graded on mastered standards with retake "sittings"; if that
// means nothing to you it stays switched off and nothing here runs.
// ---------------------------------------------------------------------------
let standardsPlan = null;
let planForFocus = null;
const planCourse = standardsCourse(cfg);
if (planCourse) {
  try {
    const plan = JSON.parse(readFileSync(join(DATA, "study-plan.json"), "utf-8"));
    const todayK = localDayKey(now, TZ);
    const week = [...plan.weeks].reverse().find((w) => w.start <= todayK) ?? plan.weeks[0];
    const met = Object.values(plan.standards).filter((st) => st.status === "met");
    standardsPlan = {
      course: plan.course ?? planCourse,
      week: { start: week.start, focus: week.focus, note: week.note },
      metF: met.filter((st) => st.class === "F").length,
      metA: met.filter((st) => st.class === "A").length,
      e1: plan.standards.E1?.status ?? null,
      // The next sitting the user will actually be at. An entry flagged
      // attending:false (a reassessment whose sign-up survey closed without a
      // sign-up) stays in the file as history but is never "next" - the next
      // real opportunity is the following exam.
      nextSitting: plan.sittings.find((sit) => sit.date >= todayK && sit.attending !== false) ?? null,
      focusNames: week.focus.map((f) => (plan.standards[f] ? f + ": " + plan.standards[f].name : f)),
    };
    planForFocus = {
      course: standardsPlan.course,
      weeks: plan.weeks,
      week: standardsPlan.week,
      standards: plan.standards,
      sittings: plan.sittings,
      // The week note describes what was ANNOUNCED; sittings[].attending
      // records what the user did about it, and wins.
      reassessment: extractReassessment(week.note, week.start, plan.sittings),
    };
  } catch {
    /* the plan file is optional even when the feature is on */
  }
}

// ---------------------------------------------------------------------------
// Mail: research and actionable threads that have no deadline item of their own
// ---------------------------------------------------------------------------
const rawMail = readJson(join(DATA, "outlook-mail.json"), { mail: [] }).mail ?? [];
const mail = rawMail
  .filter((m) => m && typeof m === "object")
  .map((m) => ({
    from: m.from ?? m.sender ?? "",
    addr: m.addr ?? m.address ?? "",
    subj: m.subj ?? m.s ?? m.subject ?? "",
    recv: m.recv ?? m.d ?? m.received ?? null,
    tag: m.tag ?? "info",
    gist: m.gist ?? m.note ?? "",
    ask: m.ask ?? null,
    replyBy: m.replyBy ?? null,
  }))
  .sort((a, b) => String(b.recv ?? "").localeCompare(String(a.recv ?? "")))
  .slice(0, MAIL_CAP);

// ---------------------------------------------------------------------------
// The user's own focus-block edits.
//
// data/block-edits.json is written ONLY by command-ingest.mjs, from the `block`
// commands the page sends when a block is dragged or resized. The render just
// hands it to the engine, which pins `edits[]` and learns from `history[]`.
//
// A missing file is the normal case and says nothing. A file we cannot read is
// worth one warning on stderr and nothing more: an unreadable overlay must
// never cost the user their agenda, so the render carries on with the engine's
// own plan rather than failing the run.
// ---------------------------------------------------------------------------
function readBlockEdits() {
  const path = join(DATA, "block-edits.json");
  if (!existsSync(path)) return null;
  const skip = (reason) => {
    console.warn(`warn: data/block-edits.json ${reason}; rendering without your block edits`);
    return null;
  };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return skip(`could not be parsed (${e.message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return skip("is not an object");
  if (!Array.isArray(raw.edits) && !Array.isArray(raw.history)) return skip("has neither edits[] nor history[]");
  return {
    v: typeof raw.v === "number" ? raw.v : 1,
    edits: Array.isArray(raw.edits) ? raw.edits : [],
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}
const blockEdits = readBlockEdits();

// ---------------------------------------------------------------------------
// The plan this render is replacing.
//
// data/focus-plan.json is written at the bottom of this file, so right now it
// still holds the LAST run's plan - and that is the only record of what the
// user was told to do this morning. The engine keeps today's blocks that have
// already started instead of re-deriving a day that is half over, so the
// evening run reorganises the evening without rewriting the morning.
//
// It must therefore be read BEFORE the write below, which is why it is here and
// not next to it. Absent (first run, deleted file, fresh checkout) is normal
// and means "no record": the engine simply packs today from the current time.
//
// STALENESS IS THE DANGEROUS CASE, and it is not the obvious one. The plan is a
// SEVEN-DAY plan, so YESTERDAY's file already contains an entry for today - the
// day it was guessing about. If the morning run is missed (a sleeping laptop is
// all it takes) the evening render would find that entry, treat three blocks
// the user never saw as "the record of their day", spend the whole minute
// budget and all three block slots on them, and pack nothing for the evening -
// while logging "3 kept" as though it had gone well.
//
// So the plan is only a record of TODAY if it was WRITTEN today. `generatedAt`
// is already in the file for exactly this kind of question; anything else is
// discarded, said out loud in the log, and today is planned from the clock.
// ---------------------------------------------------------------------------
const previousPlan = readJson(join(DATA, "focus-plan.json"), null);
const previousDay = previousPlan ? localDayKey(previousPlan.generatedAt, TZ) : null;
const previousIsToday = previousDay !== null && previousDay === localDayKey(now, TZ);
const previousFocus = previousIsToday && Array.isArray(previousPlan.focus) ? previousPlan.focus : [];
const previousNote = !previousPlan
  ? " (no previous plan on disk)"
  : !previousIsToday
    ? ` (previous plan is stale: ${previousDay ?? "undated"})`
    : Array.isArray(previousPlan.focus)
      ? ""
      : " (previous plan has no focus array)";

// ---------------------------------------------------------------------------
// Daily focus. The engine is deterministic; a scheduled agent may add a
// one-line rationale per day through data/focus-note.txt:
//   2026-09-14: Front-load PHYS 221 today - the sitting is Thursday.
//   (a bare line with no date prefix applies to today)
// ---------------------------------------------------------------------------
function readFocusNotes() {
  const path = join(DATA, "focus-note.txt");
  const notes = {};
  if (!existsSync(path)) return notes;
  const today = localDayKey(now, TZ);
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const m = text.match(/^(\d{4}-\d{2}-\d{2})\s*[:\-]\s*(.+)$/);
    if (m) notes[m[1]] = m[2].trim();
    else notes[today] = text;
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Schedule, board, completions and the study-model weights
// ---------------------------------------------------------------------------

// One ClassMeeting per meets[] pattern, for both attended and self-study
// courses - the page decides how to draw them, the engine only avoids the
// attended ones.
const schedule = Object.entries(cfg.schedule ?? {}).flatMap(([c, e]) =>
  (Array.isArray(e?.meets) ? e.meets : []).map((m) => ({
    c,
    attend: e.attend !== false,
    room: e.room ?? null,
    days: Array.isArray(m.days) ? m.days : [],
    start: m.start ?? null,
    end: m.end ?? null,
    from: e.from ?? null,
    until: e.until ?? null,
  })),
);

// ---------------------------------------------------------------------------
// meetings[]: the user's own calendar, read INBOUND.
//
// `data/gcal-items.json` is written by `src/connectors/gcal-ingest.mjs`, which a
// scheduled run executes before this script (src/pipeline.mjs, phase 1). It is a
// side file like every other one here: absent or unreadable means an empty list
// and nothing else. A calendar the user has not connected, or a connector
// outage, must never cost them their agenda.
//
// `calendars.gcal.enabled` is the one switch, and it is read HERE rather than
// only by the runbook that decides whether to fetch. A file left behind by a
// term when the route was on is not a reason to put meetings back on the page,
// or to warn about a stale calendar nobody is using - so while the block is off
// the file is not read at all and `meetings[]` is empty, exactly as
// docs/CONFIG.md and docs/PROTOCOL.md section 4 promise.
//
// Direction is inbound only. Nothing in this file, or anything it calls, can
// write to anybody's calendar - the ICS sink is the only thing here that writes
// a calendar at all, and it writes a file.
// ---------------------------------------------------------------------------
const gcalEnabled = cfg.calendars?.gcal?.enabled === true;
const gcalData = gcalEnabled ? readJson(join(DATA, "gcal-items.json"), null) : null;
const gcalErrors = [];

/**
 * Every inbound event inside the horizon the page draws, minus `desc` - the
 * page shows title, time and location, and the description is bulk the payload
 * budget does not need. Sorted by start. UNCAPPED. PURE.
 */
function meetingsInHorizon(data, todayKey) {
  const from = addDays(todayKey, -1);
  const to = addDays(todayKey, HORIZON_DAYS);
  const events = Array.isArray(data?.events) ? data.events : [];
  // An all-day `e` is EXCLUSIVE, so a missing one is ONE DAY, never zero:
  // defaulting it to `s` makes the span `s <= day < s`, which is empty, and the
  // meeting disappears from a page that still has it on file.
  const endOf = (m) => {
    if (typeof m.e === "string" && m.e) return m.e;
    return m.ad === true ? addDays(m.s, 1) : m.s;
  };
  const inHorizon = (m) => {
    if (m.ad) return m.s <= to && m.e > from;
    const day = localDayKey(m.s, TZ);
    const endDay = localDayKey(m.e, TZ) ?? day;
    return day !== null && day <= to && endDay >= from;
  };
  return events
    .filter((m) => m && typeof m === "object" && typeof m.k === "string" && typeof m.s === "string")
    .map((m) => ({
      k: m.k,
      feed: m.feed ?? "",
      lbl: m.lbl ?? "",
      t: m.t ?? "(untitled)",
      s: m.s,
      e: endOf(m),
      ad: m.ad === true,
      loc: m.loc ?? null,
      free: m.free === true,
      url: m.url ?? null,
    }))
    .filter(inHorizon)
    .sort((a, b) => a.s.localeCompare(b.s) || a.k.localeCompare(b.k));
}

const allMeetings = meetingsInHorizon(gcalData, localDayKey(now, TZ));
const meetings = allMeetings.slice(0, MEETING_CAP);
// The meetings still ship - stale meetings beat none - but the page's error
// strip says how old they are, so "an empty week" and "a lane that stopped" do
// not look the same.
if (gcalData && typeof gcalData.generatedAt === "string") {
  const ageHours = Math.floor((now.getTime() - Date.parse(gcalData.generatedAt)) / 3600000);
  if (Number.isFinite(ageHours) && ageHours >= MEETING_STALE_HOURS) {
    gcalErrors.push(`calendar: meeting data is ${ageHours}h old`);
  }
}
for (const feed of Array.isArray(gcalData?.feeds) ? gcalData.feeds : []) {
  if (feed && typeof feed === "object" && feed.status && feed.status !== "ok") {
    gcalErrors.push(`calendar: feed ${feed.id ?? "?"} is ${feed.status}`);
  }
}

const board = (boardData.board ?? [])
  .filter((b) => b && typeof b === "object")
  .slice(0, BOARD_CAP)
  .map((b) => ({
    repo: b.repo ?? "",
    n: b.n ?? null,
    t: b.t ?? b.title ?? "",
    kind: b.kind === "pr" ? "pr" : "issue",
    u: b.u ?? b.url ?? null,
    upd: b.upd ?? null,
  }));

// done[]: what closed in the last 14 days, with a timestamp we actually know.
// Two sources have one - the user's own record (exact), and this run's diff of
// the LMS snapshot (stamped with the scrape time, the earliest moment we can
// honestly claim to have seen it).
//
// An entry may carry `state: "cancelled"`, and `k` may be a SESSION key rather
// than a deliverable key. The page needs both: `state` to paint a cancelled
// item grey rather than done-blue, and the session keys to know which
// individual study blocks are already ticked off.
//
// done[] is the completion LEDGER, not a done list, so it also republishes the
// last 14 days of TOMBSTONES as `state: "cleared"`. That is the only channel
// the pipeline has for saying "this mark is gone" - a page holding its own
// browser-storage copy of a mark the user revoked in chat would otherwise
// resurrect it on every single load, forever.
const doneCut = new Date(now.getTime() - DONE_WINDOW_DAYS * 86400000).toISOString();
const viaOfSources = (sources) => {
  const src = Array.isArray(sources) ? sources : [];
  if (src.includes("gradescope")) return "gradescope";
  if (src.includes("outlook")) return "reply";
  return "grade";
};
// Every key the PIPELINE claims as done, on evidence from ANY run - not just
// this one's diff. An item submitted three weeks ago is still `s: true` in the
// snapshot and has long since dropped out of diff.json, and it is exactly as
// unrevocable today as it was the day it flipped.
const pipelineClaims = new Map();
for (const it of pipelineItems) {
  if (it.s === true && it.k) pipelineClaims.set(it.k, viaOfSources(it.src));
}

const ledger = completionLedger(completionStore, { since: doneCut });
const doneByKey = new Map();
// 1. The user's marks. Exact timestamps, and the best evidence there is.
for (const entry of ledger) {
  if (entry.state === "cleared") continue;
  doneByKey.set(entry.k, entry);
}
// 2. What this run's scrape saw close by itself.
for (const raw of readJson(join(DATA, "diff.json"), {}).nowSubmitted ?? []) {
  const it = normalizeItem(raw);
  if (!it) continue;
  const k = itemKey(it);
  if (doneByKey.has(k)) continue; // the user's own timestamp is the better one
  const at = snap.scrapedAt;
  if (typeof at !== "string" || at < doneCut) continue;
  doneByKey.set(k, { k, at, via: viaOfSources(it.sources) });
}
// 3. The revocations, LAST, and never over a key the pipeline claims. This is
// the origin rule made mechanical: a tombstone may only ever revoke one of the
// user's OWN marks. Publishing one against pipeline evidence would tell the
// page - and through it the digest - that they have not done something that is
// already graded. Where the claim exists, the claim is what ships, stamped with
// the scrape that last saw it. Where it does not, the revocation ships, which
// is the whole point of republishing tombstones.
for (const entry of ledger) {
  if (entry.state !== "cleared" || doneByKey.has(entry.k)) continue;
  const claim = pipelineClaims.get(entry.k);
  if (claim === undefined) {
    doneByKey.set(entry.k, entry);
    continue;
  }
  const at = snap.scrapedAt;
  if (typeof at === "string" && at >= doneCut) doneByKey.set(entry.k, { k: entry.k, at, via: claim });
  // With no usable scrape time the tombstone is still refused: silence is
  // wrong-in-one-run, publishing it is wrong about the pipeline's own evidence.
}
const done = [...doneByKey.values()].sort(
  (a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || a.k.localeCompare(b.k),
);

// Weights are the study model's allocations; config.difficulty is the fallback
// for any bucket the model has not scored (and when the model file is missing).
const model = readJson(join(DATA, "study-model.json"), null);
const allocs = allocWeights(model);
const weights = { ...(cfg.difficulty ?? {}), ...allocs };

const focus = computeFocus({
  items,
  weights: cfg.difficulty ?? {},
  allocWeights: allocs,
  standardsPlan: planForFocus,
  now,
  days: 7,
  leadTimeDays: cfg.leadTimeDays,
  studyMinutes: cfg.studyMinutes,
  wakeTime: cfg.wakeTime,
  schedule: cfg.schedule,
  // A timed meeting the user is not marked free for is busy time exactly like
  // an attended class: the planner must never put study over one. The UNcapped
  // list - MEETING_CAP is a payload size limit, not a plan.
  meetings: allMeetings,
  board: boardData.board ?? [],
  sideProject: cfg.sideProject,
  sideBucket: derived.sideBucket,
  tuning: cfg.focus?.tuning,
  completions,
  blockEdits,
  previousFocus,
  tz: TZ,
  notes: readFocusNotes(),
});

// ---------------------------------------------------------------------------
// data/focus-plan.json - the plan, in the clear, for the chat channel.
//
// The payload is base64 and the page is a large HTML file, so neither is
// something another tool can read cheaply. completion.mjs needs exactly one
// thing out of this render - which focus blocks exist, on which day, for which
// bucket - to turn "start hw 1" into the session key `fb|<day>|<bucket>`
// instead of marking the whole deliverable done. So the focus array is
// mirrored here verbatim, as JSON, next to the state files it belongs with.
//
// It is a DERIVED file: nothing reads it as truth, every reader tolerates its
// absence, and it is rewritten from scratch on every render. That also means it
// travels in the state mirror with the rest of the data directory for free.
// ---------------------------------------------------------------------------
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
writeFileSync(
  join(DATA, "focus-plan.json"),
  JSON.stringify({ v: 1, generatedAt: now.toISOString(), tz: TZ, focus }, null, 2) + "\n",
);

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------
const compact = {
  v: PAYLOAD_VERSION,
  scrapedAt: snap.scrapedAt,
  tz: TZ,
  weights,
  schedule,
  board,
  done,
  items,
  announcements: (snap.announcements ?? []).map((a) => ({ c: a.course, t: a.title, p: a.posted })),
  mail,
  ...(standardsPlan ? { standardsPlan } : {}),
  focus,
  // Additive: `v` stays 4. A page that has never heard of meetings[] ignores an
  // unknown key and renders exactly as it did before.
  meetings,
  // Errors about courses the user asked us to skip are noise, and noise is how
  // a real error gets ignored.
  errors: [
    ...(snap.errors ?? []).filter(
      (e) => ![...derived.skipCodes].some((code) => code && String(e).includes(code)),
    ),
    ...gcalErrors,
  ],
};

const budget = budgetOf(cfg, "data");
const packed = packWithinBudget("data", compact, { budget, now });
// `cfg.title` names the agenda in the brief's header line. Nothing on the wire
// ever carries this project's name - the same rule every other identity string
// in this repo follows.
const brief = renderBrief(packed.payload, now, TZ, { title: cfg.title });
const briefLines = brief.split("\n").length;
if (packed.over) {
  writeFileSync(join(DATA, "payload.oversize.txt"), packed.text);
  console.warn(
    `WARNING: the payload is ${packed.text.length} characters after every slim tier, over the ` +
      `${budget}-character budget. Nothing was truncated - truncating would publish a week that lies. ` +
      "The oversize text is in data/payload.oversize.txt; the run should log drive=SKIPPED(oversize). " +
      "The copy embedded in the page is always complete.",
  );
} else {
  // The document has two readers with nothing in common. The PAGE reads the
  // envelope. The PHONE - a claude.ai Project with a Drive connector and no code
  // of its own - reads the plain-text brief underneath it, because asking a chat
  // turn to base64-decode, checksum and gunzip several thousand characters is
  // slow, lossy and pointless when all it needs is four short lists.
  //
  // The brief is built from `packed.payload` - the object that was actually
  // packed, slim tier and all - so the two halves of the document can never
  // disagree about what was published. Everything after the first `.END` is
  // invisible to every machine reader (`sliceEnvelope`), so nothing in it can
  // ever be parsed as data.
  writeFileSync(join(DATA, "payload.b64.txt"), `${packed.text}\n\n${brief}\n`);
}
// The page's first paint is synchronous, so the embedded copy is the plain
// form - no decompression, no await, no blank grid while a stream drains. It is
// also always the FULL payload: the budget only ever applies to the copy that
// has to travel through a document.
const embedded = pack("data", compact, { compress: false });

// `--template` exists so demo mode and the test suite can build a page without
// depending on the published template, and so somebody forking the page has
// somewhere to point. Everything else uses the one in web/.
const templatePath = argFlag(argv, "template") ?? join(ROOT, "web", "page-template.html");
if (!existsSync(templatePath)) {
  console.error(`render: ${templatePath} is missing - the page cannot be built without its template.`);
  process.exit(1);
}
const template = readFileSync(templatePath, "utf-8");
const html = template
  .replace('"__PAYLOAD__"', JSON.stringify(embedded))
  .replace("__PAGE_CONFIG__", JSON.stringify(pageConfig(cfg)));
const htmlPath = outPath(argv, ROOT, "agenda.html");
writeFileSync(htmlPath, html);

const described = items.filter((i) => i.desc).length;
const missing = new Set(items.filter((i) => !i.desc).map((i) => i.k)).size;
const pinned = focus.reduce((n, d) => n + d.blocks.filter((b) => b.pinned).length, 0);
// How much of today this run inherited rather than invented. Only today can
// carry kept blocks - every other day is planned from scratch, as ever.
const today = focus[0] ?? { d: "", blocks: [] };
const keptToday = today.blocks.filter((b) => b.kept).length;
console.log(
  `payload v${PAYLOAD_VERSION}: ${items.length} items (${described} described, ${missing} key(s) without a description), ` +
    `${compact.announcements.length} announcements, ${mail.length} mail, ` +
    `${schedule.length} class meetings, ${meetings.length} calendar meetings, ` +
    `${board.length} board entries, ${done.length} done, ` +
    `weights ${Object.keys(allocs).length ? "from study-model" : "from config.difficulty (model missing)"}, ` +
    `${focus.reduce((n, d) => n + d.blocks.length, 0)} focus blocks over ${focus.length} days ` +
    `(${focus.reduce((n, d) => n + d.blocks.reduce((m, b) => m + (b.mins ?? 0), 0), 0)} planned minutes, ` +
    `${focus.reduce((n, d) => n + d.blocks.filter((b) => b.t).length, 0)} timed` +
    `${pinned ? `, ${pinned} pinned by you` : ""}); ${htmlPath} rebuilt`,
);
console.log(
  `upload: ${packed.text.length} chars (budget ${budget}, tier ${packed.tier}${packed.over ? ", OVER" : ""})` +
    (packed.tier > 0 ? ` - dropped ${packed.label}` : "") +
    (packed.over ? "" : ` + brief ${brief.length} chars, ${briefLines} lines`),
);
// The line that makes a run reproducible from its own log: which clock the plan
// was built against, how much of today it preserved, and - when it preserved
// nothing - WHY. A mid-day re-render should show the morning kept and the
// evening re-packed. "0 kept" at 6pm is never just an empty day: the suffix
// says whether the plan was missing, dated to another day, or simply had
// nothing behind the clock yet, and those are three different things to do
// something about.
console.log(
  `today ${today.d} planned at ${localTimeLabel(now, TZ)} local: ` +
    `${keptToday} block(s) kept from the previous plan, ` +
    `${today.blocks.length - keptToday} packed into the rest of the day${previousNote}`,
);
// The hint has to be runnable as printed. A render pointed at another config or
// another data directory - which is exactly what demo mode and every test do -
// must suggest the command WITH those flags, or the reader copies a line that
// fails against their real repo.
if (missing) {
  const passthrough = ["config", "data"]
    .map((flag) => (argFlag(argv, flag) ? ` --${flag} ${JSON.stringify(argFlag(argv, flag))}` : ""))
    .join("");
  console.log(`run \`node src/render.mjs --gaps${passthrough}\` to list the item keys that still need a description`);
}
