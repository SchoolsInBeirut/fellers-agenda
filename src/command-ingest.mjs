#!/usr/bin/env node
// command-ingest.mjs - the phone's one-way command bus into the agenda.
//
// The user is on a phone, away from the PC, and wants to change something: push a
// deadline, add a task, leave a note for tomorrow, log an hour of studying, confirm
// they signed up for a sitting, or ask the agenda to be quiet for a while. They
// write one Drive doc; a scheduled run saves that document's text to a file and
// hands the file to this script.
//
// THE ENVELOPE. The page writes `AGQ1.<base64(utf8(json))>.END` - the command
// bus form described in docs/PROTOCOL.md. This script accepts that envelope
// directly, and also accepts the bare JSON inside it, because a human debugging
// a refusal should be able to hand it the object rather than re-encoding one.
// Decoding goes through src/lib/envelope.mjs so the page and the pipeline can
// never drift apart on what a valid message looks like, and an envelope of any
// other kind is refused by name rather than parsed hopefully.
//
// Either way, what this file validates is the same object:
//
//   {"v":1, "issuedAt":"ISO", "commands":[ ... ]}
//
// ---------------------------------------------------------------------------
// FAIL CLOSED, IN TWO PHASES
//
// Phase 1 validates EVERY command - structure, arguments, and the state guards
// (does that item exist, is that a real bucket, is there a sitting on that date).
// If ANY command is bad, NOTHING is applied and the whole document is refused with
// every offender named. Phase 2 then applies a document already known to be good.
//
// The alternative - apply what parses, refuse the rest - means a doc written on a
// phone with one typo half-lands, and the user has no way to know which half. A
// refused document is re-sent in ten seconds; a half-applied one is a mystery for
// a week. `--validate` is exactly phase 1 with phase 2 skipped.
//
// ---------------------------------------------------------------------------
// THE OPS (everything else is refused by name)
//
//   defer     {k, to, why}      Record an override: this item is now due later.
//                               NEVER for ty:"exam" - the university sets that
//                               date, not the phone. `to` must be LATER than the
//                               item's current effective due, so a defer can only
//                               ever buy time, never manufacture an alarm.
//                               Written to data/overrides.json. The scraped date
//                               in data/latest.json is NEVER rewritten: the
//                               override is a user opinion layered on top of the
//                               truth, and it is reversible by deleting one key.
//                               behind.mjs already reads it; render.mjs and
//                               focus-engine.mjs consume it in a future round.
//   add       {c,t,d,ty,desc}   A task the phone knows about and Brightspace does
//                               not. A real ISO `d` is mandatory - docs/PROTOCOL.md says
//                               undated things are not items - and ty must be
//                               "task": deliverables come from the scrape, never
//                               from a thumb. Appended to data/phone-items.json
//                               in the compact item shape with cid 0 and
//                               src ["phone"], which render.mjs merges like any
//                               other non-LMS item.
//   note      {day, text}       One line appended to data/focus-note.txt as
//                               "<day>: <text>". 90 characters, because it has to
//                               fit on a focus strip.
//   logstudy  {c, mins, note}   Routed through `node src/study-model.mjs --log` as a
//                               child process. This file NEVER hand-edits
//                               data/study-log.json: the mirror into the academics
//                               tree, the bucket check and the append semantics all
//                               live in one place and stay there.
//   attending {date, value}     Positive (or negative) evidence about a sitting,
//                               written onto the matching data/study-plan.json
//                               sittings[] entries. value:true is the signup
//                               evidence runbooks/legacy/heavy-run.md section 4 demands before an
//                               opt-in sitting is allowed to drive anything.
//                               Refused when no sitting has that date - inventing
//                               a sitting from a phone is exactly the phantom exam
//                               the Rules forbid.
//   snooze    {hours, why}      data/snooze.json {until, why}. Suppresses PUSHES
//                               only. It NEVER suppresses a calendar alarm: those
//                               are already on the phone, the user set them up to
//                               be un-ignorable, and a snooze is "stop nagging me",
//                               not "let me miss my exam".
//   block     {day,c,t,mins,    A focus block the user dragged or resized on the
//              prev?}           published week grid. The page snaps to 15 minutes and
//                               so does this script - the page's snap is a courtesy,
//                               THIS one is the guarantee, because the page is the
//                               one part of the pipeline a stale browser tab can run
//                               an old copy of. Written to data/block-edits.json and
//                               to nothing else: a block is a plan for an hour, not a
//                               fact about one, so it never touches items,
//                               completions or the study log.
//                               `prev` is what the engine had shipped for that
//                               (day,c) BEFORE the drag. It is the learning sample,
//                               and it is optional - a block the user invented, or
//                               dragged in from another day, has no "before".
//                               Overlap with a class meeting is ALLOWED: the user
//                               chose that slot on a grid where the meeting was
//                               visible, and the user wins.
//
//   done      REFUSED, explicitly. Completion is not expressible from this bus.
//             Marks travel on the page's completions doc (the AGC1 write-back
//             bus in docs/PROTOCOL.md), or through
//             `node src/completion.mjs --done "<query>"` in chat.
//             One channel for "it is finished", forever, so the one-way append-only
//             guarantee on data/user-completions.json has exactly one door.
//
// ---------------------------------------------------------------------------
// GLOBAL GUARDS
//   v !== 1                      refuse the document (exit 5)
//   issuedAt unreadable          refuse the document (exit 5)
//   issuedAt older than 72h      refuse the document as STALE (exit 4). A command
//                                written three days ago describes a world that has
//                                moved on; re-send it.
//   more than 25 commands        refuse (a runaway doc is not a user)
//   this issuedAt already in
//   data/command-log.json        refuse: a doc that lands twice must not apply
//                                twice (notes and tasks would duplicate).
//   any unknown op               refuse the WHOLE document, naming the offender
//
// Every APPLIED command appends {at, op, args, result, doc} to
// data/command-log.json. Refusals are printed, not logged: the log is the record of
// what changed on disk, and nothing changed.
//
// ---------------------------------------------------------------------------
// BLOCK GUARDS (docs/PROTOCOL.md section 1, and they live HERE, nowhere else)
//
// In order, and every one of them refuses the WHOLE document like any other guard:
//   1. `c` is a focus bucket: config.difficulty[c] > 0, or the literal "Side Project".
//      A zero-difficulty course (SEM 100) is never a focus bucket, so it can never
//      be given an hour by a drag either.
//   2. `day` is a real YYYY-MM-DD inside [today-1, today+7] LOCAL. Yesterday is in
//      range on purpose - a block moved at 00:30 is usually about the day that just
//      ended - and eight days out is past the horizon the page even draws.
//   3. `t` and `mins` are SNAPPED to 15 minutes (round to nearest) BEFORE any range
//      check, so 20:22/97 becomes 20:15/90 and is judged as 20:15/90.
//   4. After snapping: mins in [15, 240]. 7 minutes snaps to 0 and is refused; that
//      is the intended reading of "snap, then check".
//   5. After snapping: the block occupies no minute earlier than 08:00 and no minute
//      later than 23:59, i.e. t >= 08:00 and t + mins <= 24:00. 23:00 + 60 min ends
//      the day and is legal; 23:30 + 60 min would spill into tomorrow and is not.
//      The engine's own packer stops at 23:00 (focus-engine HARD_DAY_END) - this
//      window is deliberately WIDER, because a user who drags a block to 23:00 has
//      decided something the packer is only allowed to guess at.
//   6. `prev`, when present, is {t, mins} under exactly the same clock and snapping
//      rules. A `prev.mins` of 0 would make the learning ratio infinite, so a prev
//      outside [15, 240] is malformed rather than merely odd.
// Nothing here consults the schedule: a block that overlaps a lecture is accepted.
//
// data/block-edits.json is what the ingester writes and the ONLY way an edit
// reaches the focus engine:
//   edits[]    the live overrides. Latest edit per (day, c) REPLACES the previous
//              one; entries older than today-1 are pruned on every write. Sorted by
//              (day, c) so the file diffs cleanly - the engine looks edits up by
//              key, never by position.
//   history[]  every accepted edit ever, in arrival order, newest 200 kept. This is
//              the learning corpus; pruning edits[] never touches it.
//   `at`       the COMMAND DOC's issuedAt (fallback: ingest time), canonicalised to
//              a Z-form ISO string so the engine can sort the corpus by plain string
//              compare no matter which offset the phone wrote.
//
// ---------------------------------------------------------------------------
// CLI
//   node src/command-ingest.mjs --apply <file>            AGQ1 envelope or bare JSON
//   node src/command-ingest.mjs --validate <file>         dry run, writes nothing
//   node src/command-ingest.mjs --apply <f> --data <dir>  redirect the files THIS
//                                                         script writes (logstudy
//                                                         still routes through
//                                                         study-model.mjs, which
//                                                         owns its own paths)
//   node src/command-ingest.mjs --apply <f> --config <p>  read another config
//
// Exit codes:
//   0  applied (or validated clean)
//   1  error: the file could not be read/parsed, or an apply step failed after
//      validation passed. The command log says exactly how far it got.
//   2  usage error
//   4  STALE document - nothing applied
//   5  REFUSED document - nothing applied, every offender printed

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normTitle } from "./merge.mjs";
import { readItem } from "./completion.mjs";
import { EnvelopeError, unpack } from "./lib/envelope.mjs";
import { derive, loadConfig } from "./lib/config.mjs";
import { configPath, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";

// --------------------------------------------------------------- constants

export const DOC_VERSION = 1;
export const STALE_HOURS = 72;
export const MAX_COMMANDS = 25;
export const MAX_SNOOZE_HOURS = 72;
export const MIN_SNOOZE_HOURS = 1;
export const MAX_NOTE_CHARS = 90;
export const MAX_LOG_MINUTES = 24 * 60;
export const COMMAND_LOG_CAP = 500; // newest kept; the log is a trail, not an archive

// --- block op (docs/PROTOCOL.md sections 1 and 2) ---------------------------------
export const BLOCK_SNAP = 15; // minutes; the grid's granularity and this guard's
export const MIN_BLOCK_MINUTES = 15;
export const MAX_BLOCK_MINUTES = 240;
export const BLOCK_DAY_START = 8 * 60; // 08:00 - no block may start earlier
export const BLOCK_DAY_END = 24 * 60; // exclusive: the last minute a block may hold is 23:59
export const BLOCK_DAYS_BACK = 1; // yesterday is still editable
export const BLOCK_DAYS_AHEAD = 7; // one week out is as far as the grid goes
export const BLOCK_HISTORY_CAP = 200; // newest kept; the learning corpus, not an archive
export const BLOCK_EDITS_VERSION = 1;

/**
 * The side-project bucket's label when no config says otherwise. The real value
 * comes from `sideProject.label` and travels on the loaded state, because the
 * bucket name is user-visible and must be the same string in the page, the
 * planner and this guard.
 */
export const DEFAULT_SIDE_BUCKET = "Side Project";

export const KNOWN_OPS = ["defer", "add", "note", "logstudy", "attending", "snooze", "block"];

const DONE_POINTER =
  "completion is not expressible from the phone bus. Marks travel on the page's completions doc " +
  '(the AGC1 write-back bus in docs/PROTOCOL.md), or `node src/completion.mjs --done "<query>"` in chat';

const EXIT = { ok: 0, error: 1, usage: 2, stale: 4, refused: 5 };
export { EXIT };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// --------------------------------------------------------------- pure helpers

// Curly quotes and long dashes fold to their ASCII cousins BEFORE the strip, so
// "don't" stays "don't" rather than losing the apostrophe. The codepoints are
// spelled numerically to keep this file ASCII from end to end.
const ASCII_FOLD = Object.fromEntries(
  [
    [0x2018, "'"],
    [0x2019, "'"],
    [0x201c, '"'],
    [0x201d, '"'],
    [0x2013, "-"],
    [0x2014, "-"],
  ].map(([code, to]) => [String.fromCharCode(code), to]),
);
const FOLD_RE = new RegExp("[" + Object.keys(ASCII_FOLD).join("") + "]", "g");

/**
 * Printable ASCII only. Same treatment src/connectors/calendar-outlook.mjs gives anything crossing
 * into Outlook, applied here because these strings land in ASCII-only repo files
 * that other tools read line by line.
 */
export function ascii(s) {
  return String(s ?? "")
    .replace(FOLD_RE, (ch) => ASCII_FOLD[ch])
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
}

const isoMs = (v) => {
  const t = new Date(typeof v === "string" ? v : NaN).getTime();
  return Number.isNaN(t) ? null : t;
};

/** A real calendar day, not just four digits and two dashes. */
export function isDayKey(value) {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

const str = (v) => (typeof v === "string" ? ascii(v) : "");
const bad = (reason) => ({ ok: false, reason });
const good = (args, describe) => ({ ok: true, args, describe });

// ---------------------------------------------------------------- clock helpers
//
// A block lives on a 24h local clock and a 15-minute grid. These four functions are
// the whole of that arithmetic, and they are pure so the tests can pin the snapping
// rule (round to NEAREST, halves up) without going near a file.

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

/** "HH:MM" -> minutes since local midnight, or null if that is not a time of day. */
export function parseClock(value) {
  const m = CLOCK_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since midnight -> "HH:MM". */
export function formatClock(minutes) {
  const total = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A finite number, or null. A doc typed by thumb may quote the number, so "90" is a
 * format and not an error; `null`, `true` and `""` all coerce to a number in JS and
 * none of them is one, so they are refused rather than silently read as 0.
 */
export function numberish(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Round to the nearest 15 minutes. 22 -> 15, 23 -> 30, 7 -> 0 (and 0 is refused). */
export function snapMinutes(minutes, step = BLOCK_SNAP) {
  return Math.round(Number(minutes) / step) * step;
}

/** The LOCAL calendar day of an instant, as the YYYY-MM-DD the page and the grid use. */
export function localDayKey(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A day key n days away, resolved through a LOCAL date so DST cannot shift it. */
export function shiftDayKey(key, days) {
  const [y, m, d] = String(key).split("-").map(Number);
  return localDayKey(new Date(y, m - 1, d + days));
}

// ------------------------------------------------------------- op validators
//
// Each validator is PURE: (raw command, state) -> {ok, args, describe} | {ok:false, reason}.
// `state` is everything on disk the guard needs, loaded once. `describe` is the
// line the human summary prints, so the wording lives next to the rule.

export function validateDefer(cmd, state) {
  const k = str(cmd.k);
  if (!k) return bad("defer needs `k` (the item key)");
  const item = state.itemsByKey.get(k);
  if (!item) return bad(`defer: no item with key "${k}" (run \`node src/render.mjs --gaps\` for the keys in play)`);
  if (item.type === "exam") return bad(`defer: "${item.title}" is an exam - exam dates are the university's, not the phone's`);
  const toMs = isoMs(cmd.to);
  if (toMs === null) return bad("defer needs `to` as a real ISO datetime");
  const current = state.overrides[k]?.deferTo ?? item.due;
  const currentMs = isoMs(current);
  if (currentMs !== null && toMs <= currentMs) {
    return bad(`defer: ${new Date(toMs).toISOString()} is not later than the current due ${current} - a defer only ever moves a date later`);
  }
  const to = new Date(toMs).toISOString();
  return good(
    { k, to, why: str(cmd.why).slice(0, 120) },
    `defer ${item.course} ${item.title}: ${String(current).slice(0, 16)} -> ${to.slice(0, 16)}`,
  );
}

export function validateAdd(cmd, state) {
  const c = str(cmd.c).slice(0, 40);
  const t = str(cmd.t).slice(0, 120);
  if (!c) return bad("add needs `c` (the bucket it belongs to)");
  if (!t) return bad("add needs `t` (the title)");
  const ty = str(cmd.ty) || "task";
  if (ty !== "task") return bad(`add: ty must be "task" (got "${ty}") - graded deliverables come from the scrape, never from the phone`);
  const dMs = isoMs(cmd.d);
  if (dMs === null) return bad(`add "${t}" needs a real ISO \`d\` - docs/PROTOCOL.md: undated things are not items`);
  const norm = normTitle(t);
  if (!norm) return bad(`add: "${t}" normalizes to an empty title, so it cannot have a stable key`);
  const k = `0::task::${norm}`;
  if (state.itemsByKey.has(k)) return bad(`add: "${t}" already exists (${k}) - defer or delete it instead of adding a twin`);
  return good(
    { k, c, t, d: new Date(dMs).toISOString(), ty: "task", desc: str(cmd.desc).slice(0, 300) },
    `add ${c} task "${t}" due ${new Date(dMs).toISOString().slice(0, 16)}`,
  );
}

export function validateNote(cmd) {
  const day = str(cmd.day);
  if (!isDayKey(day)) return bad(`note needs \`day\` as YYYY-MM-DD (got "${day}")`);
  const text = str(cmd.text).replace(/\s+/g, " ");
  if (!text) return bad("note needs `text`");
  if (text.length > MAX_NOTE_CHARS) {
    return bad(`note: ${text.length} characters, the focus strip fits ${MAX_NOTE_CHARS}`);
  }
  return good({ day, text }, `note ${day}: ${text}`);
}

export function validateLogstudy(cmd, state) {
  const c = str(cmd.c);
  if (!c) return bad("logstudy needs `c` (the bucket)");
  if (!state.buckets.has(c)) {
    return bad(`logstudy: "${c}" is not a known bucket. known: ${[...state.buckets].sort().join(", ")}`);
  }
  const mins = Number(cmd.mins);
  if (!Number.isInteger(mins) || mins <= 0 || mins > MAX_LOG_MINUTES) {
    return bad(`logstudy: \`mins\` must be a whole number of minutes, 1-${MAX_LOG_MINUTES} (got ${JSON.stringify(cmd.mins)})`);
  }
  return good({ c, mins, note: str(cmd.note).slice(0, 120) }, `logstudy ${mins} min on ${c}`);
}

export function validateAttending(cmd, state) {
  const date = str(cmd.date);
  if (!isDayKey(date)) return bad(`attending needs \`date\` as YYYY-MM-DD (got "${date}")`);
  if (typeof cmd.value !== "boolean") return bad("attending needs `value` as a literal true or false");
  const hits = (state.plan?.sittings ?? []).filter((s) => s?.date === date);
  if (!hits.length) {
    return bad(`attending: no sitting on ${date} in data/study-plan.json - a sitting is never invented from a phone command`);
  }
  return good(
    { date, value: cmd.value },
    `attending ${date} = ${cmd.value} (${hits.map((h) => h.label ?? h.kind ?? "sitting").join(", ")})`,
  );
}

export function validateSnooze(cmd) {
  const hours = Number(cmd.hours);
  if (!Number.isFinite(hours) || hours < MIN_SNOOZE_HOURS || hours > MAX_SNOOZE_HOURS) {
    return bad(`snooze: \`hours\` must be ${MIN_SNOOZE_HOURS}-${MAX_SNOOZE_HOURS} (got ${JSON.stringify(cmd.hours)})`);
  }
  return good({ hours, why: str(cmd.why).slice(0, 120) }, `snooze pushes for ${hours}h`);
}

/**
 * The buckets a focus block may belong to: every bucket `config.difficulty`
 * scores above 0, plus the side-project bucket whether or not the map mentions
 * it. Difficulty 0 means "never appears in the focus strip" - that is what a 0
 * is FOR, and it is how a user says "this course exists and I owe it nothing" -
 * so a bucket that may not appear may not be dragged into existence either.
 * PURE.
 */
export function focusBuckets(state) {
  const out = new Set([state?.sideBucket || DEFAULT_SIDE_BUCKET]);
  for (const [name, score] of Object.entries(state?.config?.difficulty ?? {})) {
    if (Number(score) > 0) out.add(name);
  }
  return out;
}

/** `prev` as the learning corpus wants it, or a refusal. Absent is fine. PURE. */
function validatePrev(raw) {
  if (raw === undefined || raw === null) return { ok: true, prev: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return bad("block: `prev` must be an object {t, mins} - omit it when the engine had no block there");
  }
  const start = parseClock(str(raw.t));
  if (start === null) return bad(`block: \`prev.t\` must be a 24h "HH:MM" local time (got ${JSON.stringify(raw.t)})`);
  const rawMins = numberish(raw.mins);
  if (rawMins === null) return bad(`block: \`prev.mins\` must be a number (got ${JSON.stringify(raw.mins)})`);
  const t = snapMinutes(start);
  const mins = snapMinutes(rawMins);
  if (t >= BLOCK_DAY_END) return bad(`block: \`prev.t\` ${str(raw.t)} snaps past midnight`);
  if (mins < MIN_BLOCK_MINUTES || mins > MAX_BLOCK_MINUTES) {
    return bad(
      `block: \`prev.mins\` is ${mins} after snapping, outside ${MIN_BLOCK_MINUTES}-${MAX_BLOCK_MINUTES} - ` +
        "a learning sample the engine never could have shipped is malformed, not merely odd",
    );
  }
  return { ok: true, prev: { t: formatClock(t), mins } };
}

export function validateBlock(cmd, state, now = new Date()) {
  const c = str(cmd.c).slice(0, 40);
  if (!c) return bad("block needs `c` (the focus bucket)");
  const buckets = focusBuckets(state);
  if (!buckets.has(c)) {
    return bad(`block: "${c}" is not a focus bucket (difficulty > 0). known: ${[...buckets].sort().join(", ")}`);
  }

  const day = str(cmd.day);
  if (!isDayKey(day)) return bad(`block needs \`day\` as YYYY-MM-DD (got ${JSON.stringify(cmd.day)})`);
  const today = localDayKey(now);
  const first = shiftDayKey(today, -BLOCK_DAYS_BACK);
  const last = shiftDayKey(today, BLOCK_DAYS_AHEAD);
  if (day < first || day > last) {
    return bad(`block: ${day} is outside the editable window ${first}..${last} (today is ${today})`);
  }

  const rawStart = parseClock(str(cmd.t));
  if (rawStart === null) return bad(`block needs \`t\` as a 24h "HH:MM" local time (got ${JSON.stringify(cmd.t)})`);
  const rawMins = numberish(cmd.mins);
  if (rawMins === null) {
    return bad(`block needs \`mins\` as a number of minutes (got ${JSON.stringify(cmd.mins)})`);
  }

  // Snap FIRST, judge the snapped values. The page snaps too; this is the guarantee.
  const t = snapMinutes(rawStart);
  const mins = snapMinutes(rawMins);
  if (mins < MIN_BLOCK_MINUTES || mins > MAX_BLOCK_MINUTES) {
    return bad(
      `block: ${mins} min after 15-min snapping, and a block is ${MIN_BLOCK_MINUTES}-${MAX_BLOCK_MINUTES} min`,
    );
  }
  if (t < BLOCK_DAY_START || t + mins > BLOCK_DAY_END) {
    return bad(
      `block: ${formatClock(t)} for ${mins} min does not fit inside ${formatClock(BLOCK_DAY_START)}-23:59`,
    );
  }

  const prevResult = validatePrev(cmd.prev);
  if (prevResult.ok === false) return prevResult;
  const prev = prevResult.prev;

  const args = { day, c, t: formatClock(t), mins, ...(prev ? { prev } : {}) };
  const was = prev ? `was ${prev.t} for ${prev.mins}m` : "no previous block";
  return good(args, `block ${c} on ${day}: ${args.t} for ${mins}m (${was})`);
}

const VALIDATORS = {
  defer: validateDefer,
  add: validateAdd,
  note: validateNote,
  logstudy: validateLogstudy,
  attending: validateAttending,
  snooze: validateSnooze,
  block: validateBlock,
};

// ------------------------------------------------------------- doc validation

/**
 * Phase 1. PURE: given the parsed document and the state read off disk, decide
 * whether the WHOLE document may be applied. Never throws.
 *
 * Returns {status: "ok"|"stale"|"refused", plan: [{op,args,describe}], refusals,
 *          issuedAt, ageHours}.
 */
export function validateDoc(doc, state, now = new Date()) {
  const refusals = [];
  const refuse = (reason, index = null, op = null) => refusals.push({ index, op, reason });

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    refuse("document is not a JSON object");
    return { status: "refused", plan: [], refusals, issuedAt: null, ageHours: null };
  }
  if (doc.v !== DOC_VERSION) {
    refuse(`unsupported document version ${JSON.stringify(doc.v)} - this bus speaks v${DOC_VERSION} only`);
  }

  const issuedMs = isoMs(doc.issuedAt);
  let ageHours = null;
  if (issuedMs === null) {
    refuse(`issuedAt is missing or unreadable (${JSON.stringify(doc.issuedAt)})`);
  } else {
    ageHours = (now.getTime() - issuedMs) / 3600000;
    if (ageHours > STALE_HOURS) {
      return {
        status: "stale",
        plan: [],
        refusals: [{ index: null, op: null, reason: `document is ${Math.round(ageHours)}h old (limit ${STALE_HOURS}h) - re-send it` }],
        issuedAt: doc.issuedAt,
        ageHours,
      };
    }
    if (state.appliedDocs?.has(doc.issuedAt)) {
      refuse(`a document issued at ${doc.issuedAt} has already been applied - refusing to apply it twice`);
    }
  }

  const commands = doc.commands;
  if (!Array.isArray(commands)) {
    refuse("`commands` must be an array");
    return { status: "refused", plan: [], refusals, issuedAt: doc.issuedAt ?? null, ageHours };
  }
  if (commands.length > MAX_COMMANDS) {
    refuse(`${commands.length} commands in one document (limit ${MAX_COMMANDS})`);
  }

  const plan = [];
  commands.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      refuse("command is not an object", index, null);
      return;
    }
    const op = typeof raw.op === "string" ? raw.op.trim() : "";
    if (op === "done") {
      refuse(DONE_POINTER, index, "done");
      return;
    }
    const validator = VALIDATORS[op];
    if (!validator) {
      refuse(`unknown op "${op || "(missing)"}" - this bus accepts ${KNOWN_OPS.join(", ")}`, index, op || null);
      return;
    }
    const result = validator(raw, state, now);
    if (!result.ok) {
      refuse(result.reason, index, op);
      return;
    }
    plan.push({ index, op, args: result.args, describe: result.describe });
  });

  if (refusals.length) return { status: "refused", plan: [], refusals, issuedAt: doc.issuedAt ?? null, ageHours };
  return { status: "ok", plan, refusals, issuedAt: doc.issuedAt ?? null, ageHours };
}

// --------------------------------------------------------------- state / io

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Accept `{overrides:{...}}` or the bare map the contract writes. PURE. */
export function overridesMap(source) {
  if (!source || typeof source !== "object") return {};
  const map = source.overrides && typeof source.overrides === "object" ? source.overrides : source;
  const out = {};
  for (const [k, v] of Object.entries(map)) if (typeof k === "string" && k && v && typeof v === "object") out[k] = v;
  return out;
}

/**
 * Everything the guards need, read once. Absent files are empty, never fatal:
 * a phone command must not depend on an optional file existing.
 */
export function loadState(dataDir, rootDir, opts = {}) {
  // A config that will not load is not a reason to lose a phone command: the
  // guards that need it degrade to "no configured buckets", which refuses more
  // than it should rather than accepting more than it should.
  let config = {};
  let sideBucket = DEFAULT_SIDE_BUCKET;
  try {
    config = loadConfig(opts.configFile ?? path.join(rootDir, "config.json"), { warn: () => {} });
    sideBucket = derive(config).sideBucket;
  } catch {
    config = {};
  }
  const overrides = overridesMap(readJson(path.join(dataDir, "overrides.json"), {}));
  const itemsByKey = new Map();
  const addItems = (list) => {
    for (const raw of list ?? []) {
      const view = readItem(raw);
      if (!view.key || !view.title) continue;
      if (!itemsByKey.has(view.key)) itemsByKey.set(view.key, view);
    }
  };
  addItems(readJson(path.join(dataDir, "latest.json"), {}).items);
  addItems(readJson(path.join(dataDir, "outlook-items.json"), {}).items);
  addItems(readJson(path.join(dataDir, "board-items.json"), {}).items);
  addItems(readJson(path.join(dataDir, "phone-items.json"), {}).items);

  const log = readJson(path.join(dataDir, "command-log.json"), { entries: [] });
  const appliedDocs = new Set(
    (Array.isArray(log.entries) ? log.entries : []).map((e) => e?.doc).filter((d) => typeof d === "string"),
  );

  return {
    config,
    sideBucket,
    overrides,
    itemsByKey,
    buckets: new Set(Object.keys(config.difficulty ?? {})),
    plan: readJson(path.join(dataDir, "study-plan.json"), null),
    appliedDocs,
  };
}

/**
 * Text on disk -> the command document, or {error}. Accepts the `AGQ1.` envelope
 * the page writes and the bare JSON object inside it, and refuses anything else
 * by name: an envelope of the wrong kind is a real mistake worth reporting (a
 * payload doc pasted into the wrong file), never something to parse hopefully.
 * PURE, and never throws.
 */
export function readDoc(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { error: "the file is empty" };
  if (raw.startsWith("{")) {
    try {
      return { doc: JSON.parse(raw) };
    } catch (e) {
      return { error: `the file is not JSON: ${ascii(e.message)}` };
    }
  }
  try {
    const { kind, data } = unpack(raw);
    if (kind !== "commands") {
      return { error: `this is a "${kind}" envelope, not a command document - the command bus is AGQ1` };
    }
    return { doc: data };
  } catch (e) {
    if (e instanceof EnvelopeError) return { error: ascii(e.message) };
    return { error: ascii(e && e.message ? e.message : String(e)) };
  }
}

/** Append entries to the command log, newest last, capped. PURE. */
export function appendLog(log, entries, cap = COMMAND_LOG_CAP) {
  const existing = Array.isArray(log?.entries) ? log.entries : [];
  const all = [...existing, ...entries];
  return { entries: all.slice(Math.max(0, all.length - cap)) };
}

/** The item an `add` becomes. PURE - docs/PROTOCOL.md Item shape, cid 0, src ["phone"]. */
export function phoneItem(args, now) {
  return {
    k: args.k,
    c: args.c,
    cid: 0,
    t: args.t,
    d: args.d,
    ty: "task",
    s: null,
    src: ["phone"],
    ...(args.desc ? { desc: args.desc } : {}),
    addedAt: now.toISOString(),
  };
}

/**
 * data/block-edits.json after one accepted edit. PURE, and the only shape the focus
 * engine is promised:
 *
 *   edits[]    latest per (day, c) - the incoming entry REPLACES any entry with the
 *              same key - with everything older than today-1 pruned on the way past.
 *              Sorted by (day, c) so a diff of this file reads like a list of
 *              decisions rather than a shuffle; the engine looks edits up by key.
 *   history[]  append in ARRIVAL order, newest BLOCK_HISTORY_CAP kept. Pruning
 *              edits[] never touches it: the corpus outlives the override.
 *
 * `via` lives on the edit and not on the history entry, because history records what
 * the user did and edits records what is currently in force.
 */
export function blockEdits(current, entry, todayKey, now = new Date()) {
  const src = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const floor = shiftDayKey(todayKey, -BLOCK_DAYS_BACK);

  const kept = (Array.isArray(src.edits) ? src.edits : []).filter(
    (e) =>
      e &&
      typeof e === "object" &&
      isDayKey(e.day) &&
      typeof e.c === "string" &&
      e.day >= floor &&
      !(e.day === entry.day && e.c === entry.c),
  );
  const edits = [...kept, { ...entry, via: "page" }].sort(
    (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.c < b.c ? -1 : a.c > b.c ? 1 : 0),
  );

  const all = [...(Array.isArray(src.history) ? src.history : []), entry];
  const history = all.slice(Math.max(0, all.length - BLOCK_HISTORY_CAP));

  return { ...src, v: BLOCK_EDITS_VERSION, updated: now.toISOString(), edits, history };
}

/** Set `attending` on every sitting with this date. Never mutates. PURE. */
export function applyAttending(plan, date, value) {
  const sittings = (plan?.sittings ?? []).map((s) => (s?.date === date ? { ...s, attending: value } : s));
  const touched = sittings.filter((s, i) => s !== (plan?.sittings ?? [])[i]).length;
  return { plan: { ...plan, sittings }, touched };
}

/** The default logstudy runner: the CLI of the module that owns the study log. */
function studyModelRunner(rootDir) {
  return (args) => {
    const proc = spawnSync(process.execPath, [path.join(rootDir, "src", "study-model.mjs"), "--log", ...args], {
      encoding: "utf8",
      timeout: 60 * 1000,
      windowsHide: true,
    });
    return {
      status: proc.status ?? 1,
      output: ascii((proc.stdout || "") + (proc.stderr || "")).split("\n").filter(Boolean).pop() ?? "",
    };
  };
}

// ------------------------------------------------------------------- phase 2

/**
 * Apply an already-validated plan. Impure by definition; every step reports what
 * it did so the command log and the human summary say the same thing.
 *
 * Returns {applied: [{op, args, result}], failed: [{op, reason}]}.
 */
export function applyPlan(plan, { dataDir, rootDir, now = new Date(), runner = null, issuedAt = null }) {
  const applied = [];
  const failed = [];
  const runLog = runner ?? studyModelRunner(rootDir);
  const at = now.toISOString();
  // The learning corpus is ordered by when the USER acted, not by when the pipeline
  // happened to read the doc - a command can sit in Drive for hours. Canonicalised so
  // a phone writing "+02:00" sorts against a phone writing "Z".
  const issuedMs = isoMs(issuedAt);
  const editAt = issuedMs === null ? at : new Date(issuedMs).toISOString();

  for (const step of plan) {
    const { op, args } = step;
    try {
      let result = "";
      if (op === "defer") {
        const file = path.join(dataDir, "overrides.json");
        const current = overridesMap(readJson(file, {}));
        writeJson(file, { ...current, [args.k]: { deferTo: args.to, why: args.why, at } });
        result = `overrides.json: ${args.k} -> ${args.to}`;
      } else if (op === "add") {
        const file = path.join(dataDir, "phone-items.json");
        const current = readJson(file, { items: [] });
        const items = [...(Array.isArray(current.items) ? current.items : []), phoneItem(args, now)];
        writeJson(file, { ...current, items });
        result = `phone-items.json: +${args.k} (${items.length} phone item(s))`;
      } else if (op === "note") {
        const file = path.join(dataDir, "focus-note.txt");
        const line = `${args.day}: ${args.text}\n`;
        const needsNewline = fs.existsSync(file) && fs.statSync(file).size > 0 && !fs.readFileSync(file, "utf8").endsWith("\n");
        fs.appendFileSync(file, (needsNewline ? "\n" : "") + line);
        result = `focus-note.txt: +1 line`;
      } else if (op === "logstudy") {
        const call = [args.c, String(args.mins), ...(args.note ? [args.note] : [])];
        const out = runLog(call);
        if (out.status !== 0) {
          failed.push({ op, args, reason: `study-model.mjs --log exited ${out.status}: ${out.output}` });
          continue;
        }
        result = `study-model.mjs --log: ${out.output}`;
      } else if (op === "attending") {
        const file = path.join(dataDir, "study-plan.json");
        const current = readJson(file, null);
        if (!current) {
          failed.push({ op, args, reason: "data/study-plan.json disappeared between validation and apply" });
          continue;
        }
        const { plan: next, touched } = applyAttending(current, args.date, args.value);
        writeJson(file, next);
        result = `study-plan.json: attending=${args.value} on ${touched} sitting(s) dated ${args.date}`;
      } else if (op === "snooze") {
        const until = new Date(now.getTime() + args.hours * 3600000).toISOString();
        writeJson(path.join(dataDir, "snooze.json"), { until, why: args.why, hours: args.hours, at });
        result = `snooze.json: pushes quiet until ${until} (calendar alarms unaffected)`;
      } else if (op === "block") {
        const file = path.join(dataDir, "block-edits.json");
        const entry = {
          day: args.day,
          c: args.c,
          t: args.t,
          mins: args.mins,
          ...(args.prev ? { prev: args.prev } : {}),
          at: editAt,
        };
        const next = blockEdits(readJson(file, null), entry, localDayKey(now), now);
        writeJson(file, next);
        result =
          `block-edits.json: ${args.c} ${args.day} ${args.t} for ${args.mins}m ` +
          `(${next.edits.length} live edit(s), ${next.history.length} in history)`;
      }
      applied.push({ op, args, result });
    } catch (e) {
      failed.push({ op, args, reason: ascii(e && e.message ? e.message : String(e)) });
    }
  }
  return { applied, failed };
}

// --------------------------------------------------------------------- CLI

const ROOT = repoRoot();

function printRefusals(kind, refusals) {
  console.log(`${kind}: nothing was applied.`);
  for (const r of refusals) {
    const where = r.index === null ? "document" : `command ${r.index}${r.op ? ` (${r.op})` : ""}`;
    console.log(`  ${where}: ${r.reason}`);
  }
}

export function cliMain(argv, opts = {}) {
  const now = opts.now ?? new Date();
  const applyAt = argv.indexOf("--apply");
  const validateAt = argv.indexOf("--validate");
  const dataAt = argv.indexOf("--data");
  const file = applyAt !== -1 ? argv[applyAt + 1] : validateAt !== -1 ? argv[validateAt + 1] : null;
  const dryRun = applyAt === -1;

  if ((applyAt === -1 && validateAt === -1) || !file || file.startsWith("--")) {
    console.log(
      "usage: node src/command-ingest.mjs --apply <file> | --validate <file> [--data <dir>] [--config <path>]",
    );
    return EXIT.usage;
  }
  const root = ROOT;
  const dataDir = dataAt !== -1 && argv[dataAt + 1] ? argv[dataAt + 1] : resolveDataDir(argv, root);

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    console.log(`cannot read ${file}: ${ascii(e.message)}`);
    return EXIT.error;
  }
  const { doc, error } = readDoc(text);
  if (error) {
    console.log(`cannot read ${file}: ${error}`);
    return EXIT.error;
  }

  const state = loadState(dataDir, root, { configFile: configPath(argv, root) });
  const verdict = validateDoc(doc, state, now);

  if (verdict.status === "stale") {
    printRefusals("STALE", verdict.refusals);
    return EXIT.stale;
  }
  if (verdict.status === "refused") {
    printRefusals("REFUSED", verdict.refusals);
    return EXIT.refused;
  }

  if (dryRun) {
    console.log(`VALID: ${verdict.plan.length} command(s) would apply (issued ${verdict.issuedAt}):`);
    for (const step of verdict.plan) console.log(`  ${step.describe}`);
    if (!verdict.plan.length) console.log("  (the document is empty - nothing to do)");
    return EXIT.ok;
  }

  const { applied, failed } = applyPlan(verdict.plan, {
    dataDir,
    rootDir: root,
    now,
    runner: opts.runner,
    issuedAt: verdict.issuedAt,
  });
  if (applied.length) {
    const logFile = path.join(dataDir, "command-log.json");
    const entries = applied.map((a) => ({
      at: now.toISOString(),
      op: a.op,
      args: a.args,
      result: a.result,
      doc: verdict.issuedAt,
    }));
    writeJson(logFile, appendLog(readJson(logFile, { entries: [] }), entries));
  }

  console.log(`APPLIED ${applied.length}/${verdict.plan.length} command(s) from a document issued ${verdict.issuedAt}:`);
  for (const step of verdict.plan) {
    const hit = applied.find((a) => a.op === step.op && a.args === step.args);
    console.log(`  ${hit ? "ok  " : "FAIL"} ${step.describe}`);
    if (hit) console.log(`       ${hit.result}`);
  }
  for (const f of failed) console.log(`  ERROR ${f.op}: ${f.reason}`);
  if (failed.length) {
    console.log("the document was valid, so this is a run failure, not a refusal - data/command-log.json shows how far it got.");
    return EXIT.error;
  }
  return EXIT.ok;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(cliMain(process.argv.slice(2)));
}
