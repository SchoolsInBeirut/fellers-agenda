// mail-triage-rules.mjs - the shape, date and course rules mail-triage.mjs enforces.
//
// Pure functions only: no filesystem, no clock of its own, no mutation of any
// argument. Split out of mail-triage.mjs so both files stay well under the
// 500-line limit; mail-triage.mjs re-exports everything a caller needs, so the
// public surface is still one module. No shebang: like merge.mjs and
// lib/civil-time.mjs, this is a library, not a CLI.
//
// The rules are `runbooks/legacy/heavy-run.md` sections 3.2-3.6 turned into
// checks, each carrying its own `<token>: <human detail>` reason string. Nothing
// here knows a school, a course or a person: the course list arrives as
// `config.courses` and everything else is shape and arithmetic.
//
//   3.2  an item is a DATED actionable deliverable - `d` is always ISO UTC and
//        never invented; undated things belong in mail[], not items[]. `k` is
//        recomputed here with `itemKey`/`normTitle` from merge.mjs and never
//        trusted from the input. Before adding, check latest.json for the same
//        course, a due date within a day and a similar title: if the LMS already
//        has it, it is not a new item.
//   3.3  mail[] is capped at 12, newest first; every entry carries the mail
//        client's entry id, a tag and a gist written from the body. A thread
//        with a hard reply-by ALSO appears in items[] as ty:"email".
//   3.4  noise never gets this far - the sweep and the model drop it. What this
//        file still refuses is an item for a course the user marked `skip`.
//   3.5  resolved threads leave mail[] through `drop`, by id. Items are kept and
//        flipped, never deleted, so history and the calendar sink's cleanup both
//        survive.
//   3.6  re-emitting the same `k` is a no-op; changing `d` is a real change.
//        Merging is therefore keyed by `k`, incoming wins.

import { itemKey, normTitle } from "./merge.mjs";

export const ITEM_TYPES = Object.freeze(["exam", "project", "lab", "quiz", "homework", "email", "task", "other"]);
export const MAIL_TAGS = Object.freeze(["research", "course", "action", "info"]);
export const MAIL_CAP = 12;

export const DAY_MS = 24 * 60 * 60 * 1000;
// Wide on purpose: the model re-emits the previous run's items every run, so a
// finished item from last term must still pass. This only catches a year slip.
export const PAST_WINDOW_MS = 365 * DAY_MS;
export const FUTURE_WINDOW_MS = 730 * DAY_MS;

// ---------------------------------------------------------------------------
// small pure helpers

export function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** An instant we are willing to store: ISO, parseable, and explicitly UTC. */
export function parseUtc(v) {
  if (typeof v !== "string" || !v.endsWith("Z")) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function firstNonAscii(v) {
  const m = /[^\x20-\x7e\t\n\r]/.exec(typeof v === "string" ? v : "");
  return m ? m[0] : null;
}

export function quote(v) {
  return JSON.stringify(v === undefined ? null : v);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word containment. A normalised title is only [a-z0-9 ], so the word
 * boundary is whitespace or an end. This is the difference between "hw 3" being
 * part of "hw 3 on the grader" (it is) and part of "hw 30" (it is not) - plain
 * substring containment silently collapsed HW 3 and HW 30 into one deliverable.
 */
export function containsWhole(haystack, needle) {
  if (!haystack || !needle) return false;
  return new RegExp(`(?:^|\\s)${escapeRegex(needle)}(?:\\s|$)`).test(haystack);
}

/** Two normalised titles that name the same thing, on the words alone. */
export function titlesRelated(a, b) {
  if (!a || !b) return false;
  return a === b || containsWhole(a, b) || containsWhole(b, a);
}

/**
 * "Hw1", "HW 1" and "Homework 1" are one deliverable, but normTitle does not
 * fold homework into hw, so the words never match. The number after the word
 * does - paired with the type, so a quiz 3 never absorbs a homework 3.
 */
export function assignmentNumber(norm) {
  const m = /(?:^|\s)(?:hw|homework|assignment|problem set|pset)\s*0*(\d+)(?:\s|$)/.exec(norm);
  return m ? Number(m[1]) : null;
}

export function sameNumberedAssignment(aTitle, aType, bTitle, bType) {
  if (!isNonEmptyString(aType) || String(aType) !== String(bType)) return false;
  const na = assignmentNumber(aTitle);
  const nb = assignmentNumber(bTitle);
  return na !== null && nb !== null && na === nb;
}

/** Thread identity for mail without an id: sender + subject sans Re:/Fw:. */
export function normSubject(subj) {
  return String(subj ?? "")
    .replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function mailKey(entry) {
  if (isNonEmptyString(entry?.id)) return `id:${entry.id}`;
  return `as:${String(entry?.addr ?? "").toLowerCase().trim()}|${normSubject(entry?.subj)}`;
}

export function recvMs(entry) {
  const ms = Date.parse(entry?.recv ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

// ---------------------------------------------------------------------------
// the course list (config.courses, never a name in this file)

/** The empty index: every cid is allowed, because nothing is known yet. */
export const NO_COURSES = Object.freeze({ byCode: new Map(), byId: new Map(), known: false });

/**
 * Index `config.courses` for the item checks: code -> entry and id -> entry.
 * `known` is false for a config with no courses at all, and an unconfigured
 * agenda must still be able to triage mail - so the cross-checks below are
 * skipped entirely rather than rejecting everything.
 */
export function courseIndex(courses) {
  const byCode = new Map();
  const byId = new Map();
  for (const entry of Array.isArray(courses) ? courses : []) {
    if (!isPlainObject(entry)) continue;
    if (isNonEmptyString(entry.code)) byCode.set(entry.code.trim(), entry);
    const id = Number(entry.id);
    if (Number.isInteger(id)) byId.set(id, entry);
  }
  return { byCode, byId, known: byCode.size > 0 || byId.size > 0 };
}

/**
 * `c` and `cid` agree with config.courses, or the reason they do not.
 *
 * A course the config knows must be named with ITS id; anything the config does
 * not know is `cid: 0` (research, admin, mail). Pairing a real code with another
 * course's id is the failure that puts a deliverable on the wrong page row and
 * in the wrong calendar, and nothing downstream can tell it was a mistake.
 */
export function checkCourse(item, at, courses = NO_COURSES) {
  if (!isNonEmptyString(item.c)) {
    return `course-missing: ${at}.c must be a course code from config.json, or a label such as "Research" for work that belongs to no course, got ${quote(item.c)}`;
  }
  if (!Number.isInteger(item.cid)) {
    return `cid-not-integer: ${at}.cid must be an integer course id (0 when it is not a config.json course), got ${quote(item.cid)}`;
  }
  if (!courses?.known) return null;

  const code = item.c.trim();
  const byCode = courses.byCode.get(code) ?? null;
  const byId = item.cid === 0 ? null : (courses.byId.get(item.cid) ?? null);
  const entry = byCode ?? byId;
  if (entry?.skip === true) {
    return `course-skipped: ${at} is for ${quote(code)}, which config.json marks "skip": true - a skipped course has no items`;
  }
  if (byCode) {
    const id = Number(byCode.id);
    if (Number.isInteger(id) && id !== item.cid) {
      return `cid-mismatch: ${at}.c is ${quote(code)}, whose config.json id is ${id}, but cid is ${item.cid}`;
    }
    return null;
  }
  if (item.cid === 0) return null;
  if (byId) {
    return `cid-mismatch: ${at}.cid ${item.cid} belongs to ${quote(String(byId.code ?? ""))} in config.json, not to ${quote(code)}`;
  }
  return `cid-unknown: ${at}.cid ${item.cid} is not a course id in config.json - use 0 for anything that is not one of the user's courses`;
}

// ---------------------------------------------------------------------------
// the duplicate check (heavy-run.md 3.2)

/**
 * True when the scrape already has this deliverable: same course, a due date
 * within a day, and either titles that plainly name the same thing or the same
 * assignment number under the same type. A course whose homework schedule is
 * already parsed must not gain a second card from its "HW1 uploaded"
 * announcement - while HW 3 and HW 30 stay two different assignments.
 */
export function isDuplicateOfLatest(item, latestItems) {
  const due = parseUtc(item?.d);
  if (!due) return false;
  const cid = Number(item?.cid);
  if (!Number.isInteger(cid)) return false;
  const title = normTitle(item?.t ?? "");
  for (const row of Array.isArray(latestItems) ? latestItems : []) {
    if (Number(row?.courseId) !== cid) continue;
    const rowMs = Date.parse(row?.due ?? "");
    if (!Number.isFinite(rowMs)) continue;
    if (Math.abs(rowMs - due.getTime()) > DAY_MS) continue;
    const rowTitle = normTitle(row?.title ?? "");
    if (titlesRelated(title, rowTitle)) return true;
    if (sameNumberedAssignment(title, item?.ty, rowTitle, row?.type)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// per-entry validation - each returns {reason} or {item}/{entry}

function checkAscii(where, fields, entry) {
  for (const field of fields) {
    const bad = firstNonAscii(entry?.[field]);
    if (bad !== null) {
      return `non-ascii: ${where}.${field} contains ${quote(bad)} - outlook-*.json is read by the phone and the page, ASCII only`;
    }
  }
  return null;
}

export function validateItem(item, index, now, courses = NO_COURSES) {
  const at = `items[${index}]`;
  if (!isPlainObject(item)) return { reason: `item-not-object: ${at} is ${quote(item)}, expected an Item object` };
  const course = checkCourse(item, at, courses);
  if (course) return { reason: course };
  if (!isNonEmptyString(item.t)) return { reason: `title-missing: ${at}.t must be a non-empty title, got ${quote(item.t)}` };
  if (!ITEM_TYPES.includes(item.ty)) return { reason: `type-unknown: ${at}.ty must be one of ${ITEM_TYPES.join("|")}, got ${quote(item.ty)}` };
  const due = parseUtc(item.d);
  if (!due) {
    return { reason: `due-not-iso-utc: ${at}.d must be a parseable ISO UTC instant ending in Z, got ${quote(item.d)} - never invent a date; an undated thing belongs in mail[], not items[]` };
  }
  const drift = due.getTime() - now.getTime();
  if (drift < -PAST_WINDOW_MS || drift > FUTURE_WINDOW_MS) {
    return { reason: `due-out-of-window: ${at}.d ${quote(item.d)} is not within a year behind or two years ahead of ${now.toISOString()} - check the year` };
  }
  if (!(item.s === true || item.s === false || item.s === null)) {
    return { reason: `submitted-not-tristate: ${at}.s must be true, false or null (null = nothing observed), got ${quote(item.s)}` };
  }
  if (!isNonEmptyString(item.desc)) {
    return { reason: `desc-missing: ${at}.desc must be 1-3 plain sentences written from the body - what it is, what to do, where and by when` };
  }
  if ("a" in item && typeof item.a !== "boolean") return { reason: `approx-not-boolean: ${at}.a must be true or omitted, got ${quote(item.a)}` };
  if ("u" in item && !(item.u === null || typeof item.u === "string")) return { reason: `url-not-string: ${at}.u must be a string or null, got ${quote(item.u)}` };
  if ("src" in item && (!Array.isArray(item.src) || !item.src.every(isNonEmptyString))) {
    return { reason: `src-not-string-array: ${at}.src must be an array of source names, got ${quote(item.src)}` };
  }
  const ascii = checkAscii(at, ["c", "t", "desc"], item);
  if (ascii) return { reason: ascii };
  // `k` is recomputed through merge.mjs and put first, exactly as the payload
  // orders it; any `k` the model supplied is discarded rather than merged over.
  const { k: _supplied, ...rest } = item;
  const key = itemKey({ courseId: item.cid, type: item.ty, title: item.t });
  return { item: { k: key, ...rest, d: due.toISOString() } };
}

function hasEmailItemFor(entry, replyBy, emailItems) {
  const subject = normTitle(normSubject(entry.subj));
  for (const item of emailItems) {
    if (Date.parse(item.d) === replyBy.getTime()) return true;
    if (titlesRelated(normTitle(item.t), subject)) return true;
  }
  return false;
}

export function validateMailEntry(entry, index, emailItems) {
  const at = `mail[${index}]`;
  if (!isPlainObject(entry)) return { reason: `mail-not-object: ${at} is ${quote(entry)}, expected a Mail object` };
  if (!isNonEmptyString(entry.id)) return { reason: `mail-id-missing: ${at}.id must be the mail client's entry id - it is the exact key for do-not-re-alarm` };
  for (const field of ["from", "addr", "subj"]) {
    if (!isNonEmptyString(entry[field])) return { reason: `mail-${field}-missing: ${at}.${field} must be a non-empty string, got ${quote(entry[field])}` };
  }
  const recv = parseUtc(entry.recv);
  if (!recv) return { reason: `recv-not-iso-utc: ${at}.recv must be a parseable ISO UTC instant ending in Z, got ${quote(entry.recv)}` };
  if (!MAIL_TAGS.includes(entry.tag)) {
    return { reason: `tag-unknown: ${at}.tag must be one of ${MAIL_TAGS.join("|")}, got ${quote(entry.tag)}` };
  }
  if (!isNonEmptyString(entry.gist)) {
    return { reason: `gist-missing: ${at}.gist must be 1-2 sentences on what the thread is about, written from the body, not the subject line` };
  }
  if (!("ask" in entry) || !(entry.ask === null || isNonEmptyString(entry.ask))) {
    return { reason: `ask-missing: ${at}.ask must say what is owed and to whom, or be null - the key is required either way` };
  }
  if (!("replyBy" in entry)) return { reason: `replyBy-missing: ${at}.replyBy must be an ISO UTC instant or null - the key is required either way` };
  let replyBy = null;
  if (entry.replyBy !== null) {
    replyBy = parseUtc(entry.replyBy);
    if (!replyBy) return { reason: `replyBy-not-iso-utc: ${at}.replyBy must be null or a parseable ISO UTC instant ending in Z, got ${quote(entry.replyBy)}` };
    if (!hasEmailItemFor(entry, replyBy, emailItems)) {
      return { reason: `replyBy-without-item: ${at} ${quote(entry.subj)} has a hard reply-by, so it must also appear in items[] with ty:"email" and d = the reply-by instant` };
    }
  }
  const ascii = checkAscii(at, ["from", "addr", "subj", "gist", "ask"], entry);
  if (ascii) return { reason: ascii };
  return { entry: { ...entry, recv: recv.toISOString(), replyBy: replyBy ? replyBy.toISOString() : null } };
}
