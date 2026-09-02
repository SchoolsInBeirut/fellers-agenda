// completion.mjs -- deterministic "is this actually done?" matching for the agenda.
//
// Completion signals do not all come from Brightspace. Three extra channels exist:
//   1. The user replied to the mail that created the item  -> src/connectors/mail-outlook.mjs matchReplies()
//   2. The user submitted the work on Gradescope            -> applyGradescopeStatus() here
//   3. The user said so, in chat or on the page             -> applyUserCompletions() here
//                                                              (data/user-completions.json)
//
// Everything exported here is PURE except the loaders/writers at the bottom
// (loadGradescopeAssignments, loadUserCompletions, saveUserCompletions) and the
// CLI, which only runs when this file is executed directly.
//
// SHAPE TOLERANCE. The pipeline carries two item shapes and both turn up at the
// wiring points, so every reader here goes through readItem():
//   the SNAPSHOT shape (data/latest.json): {courseId, course, title, due, type, submitted, sources}
//   the PAYLOAD shape  (data/outlook-items.json, the page): {k, c, cid, t, d, ty, s, src}
// Neither is more correct than the other; they are what the two halves of the
// pipeline find convenient, and this file writes back into whichever it was given.
//
// normTitle / itemKey are imported from merge.mjs and never reimplemented.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { itemKey, normTitle } from "./merge.mjs";
import { EnvelopeError, unpack } from "./lib/envelope.mjs";
import { loadConfig } from "./lib/config.mjs";
import { dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";

// ---------------------------------------------------------------------------
// Subject / title normalization
// ---------------------------------------------------------------------------

// "Re:", "RE :", "Fwd:", "FW:", "RE: RE:" ... stripped repeatedly, left to right.
const REPLY_PREFIX_RE = /^\s*(?:re|fw|fwd|aw|tr|rv)\s*(?:\[\d+\])?\s*:\s*/i;

/** Strip every leading reply/forward marker from a mail subject. */
export function stripReplyPrefix(subject) {
  let s = String(subject ?? "");
  for (let i = 0; i < 8; i += 1) {
    const next = s.replace(REPLY_PREFIX_RE, "");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** Fold a mail subject to the same space as merge.mjs normTitle output. */
export function normSubject(subject) {
  return normTitle(stripReplyPrefix(subject));
}

/** "hw1" -> "hw 1", "1a" -> "1 a": makes numbered deliverables comparable. */
function spaceOutDigits(s) {
  return String(s ?? "")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2");
}

// Ordered: the first alias that appears decides the kind.
const KIND_ALIASES = [
  [/\b(?:hw|hwk|homework|home work|problem set|problemset|pset|assignment|assn)\b/, "hw"],
  [/\b(?:exam|midterm|final|test)\b/, "exam"],
  [/\bquiz(?:zes)?\b/, "quiz"],
  [/\blabs?\b/, "lab"],
  [/\b(?:project|proj)\b/, "project"],
  [/\b(?:report|paper|essay)\b/, "report"],
];

// "chem 115", "chem 11500", "art101" -- a course code is never the deliverable number.
const COURSE_CODE_RE = /\b[a-z]{2,5}\s*\d{3,5}\b/g;

function numberNear(text, kindRe) {
  const near = text.match(new RegExp(`${kindRe.source}\\s*(?:#|no|number|num)?\\s*(\\d{1,3})\\b`, "i"));
  if (near) return Number.parseInt(near[1], 10);
  const loose = text.replace(COURSE_CODE_RE, " ").match(/\b(\d{1,3})\b/);
  return loose ? Number.parseInt(loose[1], 10) : null;
}

/**
 * Canonical identity for a numbered deliverable: "hw#1", "quiz#3", "exam#2".
 * Returns null when the title is not a numbered deliverable (then fuzzy text
 * matching takes over). This is what lets "HW1" (email) meet "Homework 1"
 * (Gradescope) while keeping "Homework 1" and "Homework 2" apart.
 */
export function assignmentSignature(title) {
  const text = spaceOutDigits(normTitle(title));
  if (!text) return null;
  for (const [re, kind] of KIND_ALIASES) {
    if (!re.test(text)) continue;
    const num = numberNear(text, re);
    return num === null ? null : `${kind}#${num}`;
  }
  return null;
}

/**
 * Do two titles name the same deliverable?
 * Precedence:
 *   1. identical after normTitle
 *   2. both are numbered deliverables -> the signature is decisive, both ways
 *      (this VETOES "hw 1" vs "hw 11", which plain containment would accept)
 *   3. containment (guarded against tiny strings)
 *   4. token overlap >= 0.6
 */
export function fuzzyTitleMatch(a, b) {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const sa = assignmentSignature(a);
  const sb = assignmentSignature(b);
  if (sa && sb) return sa === sb;

  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;

  const setA = new Set(na.split(" ").filter(Boolean));
  const setB = new Set(nb.split(" ").filter(Boolean));
  const inter = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 && inter / union >= 0.6;
}

/** Two mail subjects belong to the same thread (reply prefixes ignored). */
export function subjectsMatchThread(a, b) {
  const na = normSubject(a);
  const nb = normSubject(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // A reply often truncates or extends the subject; require a real prefix/suffix
  // relationship rather than a stray shared word.
  if (na.length >= 8 && nb.length >= 8 && (na.startsWith(nb) || nb.startsWith(na))) return true;
  return fuzzyTitleMatch(na, nb);
}

// ---------------------------------------------------------------------------
// Course codes
// ---------------------------------------------------------------------------

/** "CHEM 11500" / "CHEM-115" / "chem115" -> "CHEM115". Non-course text passes through. */
export function normCourseCode(code) {
  const s = String(code ?? "").toUpperCase();
  const m = s.match(/([A-Z]{2,5})\s*-?\s*(\d{3})(\d{2})?(?![0-9])/);
  if (m) return `${m[1]}${m[2]}`;
  return s.replace(/[^A-Z0-9]/g, "");
}

/** Same course? Requires a real course code on both sides ("Research" never matches). */
export function courseMatches(a, b) {
  const na = normCourseCode(a);
  const nb = normCourseCode(b);
  if (!na || !nb) return false;
  if (!/\d{3}/.test(na) || !/\d{3}/.test(nb)) return false;
  return na === nb;
}

// ---------------------------------------------------------------------------
// Item shape tolerance
// ---------------------------------------------------------------------------

/**
 * Read either item shape into one view. Never mutates the input.
 * `cancelled` is spelled the same in both shapes (see markCancelled) and is a
 * plain boolean here: absent means "not cancelled", never "unknown".
 */
export function readItem(it) {
  const src = it ?? {};
  const courseId = src.cid ?? src.courseId ?? null;
  const title = src.t ?? src.title ?? "";
  const type = src.ty ?? src.type ?? "other";
  const key = src.k ?? (title ? itemKey({ courseId: courseId ?? 0, type, title }) : null);
  return {
    key,
    course: src.c ?? src.course ?? "",
    courseId,
    title,
    due: src.d ?? src.due ?? null,
    type,
    submitted: src.s ?? src.submitted ?? null,
    cancelled: src.cancelled === true,
  };
}

/** true when the object uses the payload keys (so we set `s`, not `submitted`). */
function isPayloadItem(it) {
  return !!it && (it.k !== undefined || it.t !== undefined || it.ty !== undefined);
}

/**
 * Return a NEW item with its completion flag set, written in the item's own
 * shape (payload `s`, snapshot `submitted`). Never mutates. Used by every
 * completion channel so the flag is set exactly one way across the codebase.
 */
export function markSubmitted(it, value = true) {
  return isPayloadItem(it) ? { ...it, s: value } : { ...it, submitted: value };
}

/**
 * Return a NEW item flagged `cancelled: true` - the user decided not to do this
 * work. One field name in BOTH shapes, deliberately: one name means one
 * selector everywhere downstream, and there is no reason for the two halves of
 * the pipeline to spell this one differently.
 *
 * Cancelled is NOT done. This function never touches submitted/s, and nothing
 * that reads the submitted flag may infer anything from it.
 *
 * PURE. An item already in the requested state comes back by identity.
 */
export function markCancelled(it, value = true) {
  if (!it || typeof it !== "object") return it;
  if ((it.cancelled === true) === (value === true)) return it;
  return value === true ? { ...it, cancelled: true } : { ...it, cancelled: false };
}

// ---------------------------------------------------------------------------
// Gradescope cross-matching
// ---------------------------------------------------------------------------

/**
 * Which items does Gradescope say are already submitted?
 * A Gradescope assignment matches an item when the COURSE CODE matches and the
 * titles match fuzzily -- deliberately independent of the due date and of where
 * the item came from, so an item born from Prof. Lang's email ("HW1", cid
 * 110004) is caught by the Gradescope row "Homework 1" in HIST 14000.
 *
 * PURE. Returns a report; use applyGradescopeStatus() to get updated items.
 */
export function gradescopeMatches(items, gradescopeAssignments) {
  const done = (gradescopeAssignments ?? []).filter((g) => g && g.submitted === true);
  const out = [];
  (items ?? []).forEach((it, index) => {
    const view = readItem(it);
    if (view.submitted === true) return; // already known done, nothing to report
    if (!view.title || !view.course) return;
    const hit = done.find(
      (g) => courseMatches(view.course, g.courseCode) && fuzzyTitleMatch(view.title, g.name),
    );
    if (!hit) return;
    out.push({
      index,
      key: view.key,
      course: view.course,
      title: view.title,
      due: view.due,
      gsCourse: hit.courseCode ?? null,
      gsName: hit.name ?? null,
      gsStatus: hit.status ?? null,
      gsUrl: hit.url ?? null,
    });
  });
  return out;
}

/**
 * Return a NEW items array with the submitted flag set on everything Gradescope
 * reports as submitted. Input array and input objects are never mutated; the
 * flag written matches the shape of the item (payload `s`, snapshot `submitted`).
 *
 * PURE.
 */
export function applyGradescopeStatus(items, gradescopeAssignments) {
  const list = Array.isArray(items) ? items : [];
  const hits = new Set(gradescopeMatches(list, gradescopeAssignments).map((m) => m.index));
  return list.map((it, index) => (hits.has(index) ? markSubmitted(it) : it));
}

// ---------------------------------------------------------------------------
// Loader (the only impure export)
// ---------------------------------------------------------------------------

/**
 * Read data/gradescope.json written by gradescope.py. Returns [] when the file is
 * absent (no credentials = Gradescope dormant) or unreadable -- never throws, so a
 * caller can wire it in unconditionally.
 */
export function loadGradescopeAssignments(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, "gradescope.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.assignments) ? parsed.assignments : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Channel 3: the user says so ("I finished X", "I am not doing X")
// ---------------------------------------------------------------------------
//
// data/user-completions.json is the record of what the USER declared about her
// own work, through chat (`node src/completion.mjs --done "..."`) or through the
// page's completion write-back bus (docs/PROTOCOL.md). The store on disk:
//
//   {"v": 2,
//    "completions": {"<key>": {"at":"ISO","via":"user|page","state":"done|cancelled","note":""}},
//    "cleared":     {"<key>": {"at":"ISO","via":"user|page"}}}
//
// THE FOUR RULES THAT KEEP THIS FILE HONEST (docs/PROTOCOL.md):
//
//   1. KEY SPACES. `<key>` is either a deliverable (itemKey, "cid::type::title")
//      or a study SESSION ("fb|<YYYY-MM-DD>|<bucket>"). They never collide,
//      because a session key always starts "fb|". A session mark finishes one
//      block on one day and MUST NEVER touch an item - a mark on "Start HW 1"
//      that checks off the whole deliverable is the bug this key space exists
//      to kill.
//   2. STATE. `state` absent means "done", so an entry that carries nothing but
//      a timestamp still means what a reader would assume. "cancelled" is a
//      third, distinct thing: the user decided not to do the work. It is NOT
//      done - it never sets submitted/s - but it stops generating blocks,
//      backlog and behind-ness.
//   3. TOMBSTONES. Absence of a key still means NOTHING. Only an entry in
//      `cleared` revokes a mark, and only the user can write one. For one key
//      the entry with the newest `at` wins across `completions` and `cleared`;
//      on an exact tie the mark beats the tombstone. resolveMarks() is the one
//      implementation of that rule and everything reads through it.
//   4. ORIGIN. Pipeline-origin completions (an LMS `s:true`, a grade, a
//      Gradescope submission, a sent reply) never enter this file and can never
//      be cleared or cancelled through it. Only user-origin marks are revocable,
//      by the user, because "the scrape did not see it" is still not evidence
//      that the user did not do it.

/** A study session's key: one focus block, one day, one bucket. */
export const SESSION_PREFIX = "fb|";
export const STATE_DONE = "done";
export const STATE_CANCELLED = "cancelled";
/** Not a mark state: the ledger's word for "this mark was revoked". */
export const STATE_CLEARED = "cleared";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** true for a focus-session key ("fb|2026-09-01|CHEM 115"), false for an itemKey. */
export function isSessionKey(key) {
  return typeof key === "string" && key.startsWith(SESSION_PREFIX);
}

/**
 * Build a session key. Returns null unless the day is a real YYYY-MM-DD.
 *
 * The bucket goes in VERBATIM - no trimming, no folding. It is half of a key
 * the page builds independently from the same payload string, and a key space
 * where one side normalizes and the other does not is not one key space. If a
 * bucket ever arrives with stray whitespace, the honest outcome is a session
 * that does not resolve (and refuses), not a mark on a key the page cannot find.
 */
export function sessionKeyFor(day, bucket) {
  const d = String(day ?? "");
  const b = String(bucket ?? "");
  if (!DAY_RE.test(d) || b === "") return null;
  return `${SESSION_PREFIX}${d}|${b}`;
}

/**
 * Split a session key back into {day, bucket}, or null when it is not one.
 * The day is fixed-width and the bucket may contain spaces or a "|" of its own,
 * so the split is done on the FIRST two separators only.
 */
export function parseSessionKey(key) {
  if (!isSessionKey(key)) return null;
  const rest = key.slice(SESSION_PREFIX.length);
  const cut = rest.indexOf("|");
  if (cut === -1) return null;
  const day = rest.slice(0, cut);
  const bucket = rest.slice(cut + 1);
  if (!DAY_RE.test(day) || !bucket) return null;
  return { day, bucket };
}

/** The state of one mark. Anything unrecognised - including absent - is "done". */
export function markState(entry) {
  return entry && entry.state === STATE_CANCELLED ? STATE_CANCELLED : STATE_DONE;
}

/**
 * An entry's channel. "user" and "page" are the user's own two doors; anything
 * else is PIPELINE origin (a grade, a Gradescope submission, a sent reply) and
 * is preserved VERBATIM rather than folded into "user".
 *
 * Folding it would be the quiet kind of wrong: origin is what decides whether a
 * mark is revocable at all, so re-badging a grade as the user's own makes it
 * revocable one run later, and the guard that refuses that revocation becomes
 * decorative. An entry with no channel at all is the user's - that is the only
 * thing a bare timestamp can mean.
 */
function markVia(entry) {
  const via = entry?.via;
  return typeof via === "string" && via !== "" ? via : "user";
}

/**
 * Is this a completion the PIPELINE reported rather than one the user declared?
 * The single definition of "not hers to take back", shared by the CLI's state
 * machine and the bus merge so the two can never disagree.
 */
export function isPipelineVia(via) {
  return typeof via === "string" && via !== "" && via !== "user" && via !== "page";
}

/** Tolerant reader shared by the `completions` and `cleared` maps. */
function entryMap(map) {
  const out = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map)) {
    if (typeof k !== "string" || !k) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v;
    else if (typeof v === "string") out[k] = { at: v, via: "user" }; // tolerate a bare timestamp
  }
  return out;
}

/**
 * Accept the wrapper `{completions:{...}}` or a bare map. Always a plain map.
 *
 * RAW: this reads the marks as written and knows nothing about tombstones, so a
 * revoked mark is still in what it returns. Use resolveMarks() for the truth.
 * This exists for the callers that genuinely want the marks as recorded - the
 * ledger needs both halves separately to decide what to republish.
 */
export function completionsMap(source) {
  if (!source || typeof source !== "object") return {};
  const map = source.completions && typeof source.completions === "object" ? source.completions : source;
  return entryMap(map);
}

/** The tombstone map. A bare marks map has none, and that is not an error. */
export function clearedMap(source) {
  if (!source || typeof source !== "object") return {};
  return entryMap(source.cleared);
}

/**
 * An entry's `at` as epoch milliseconds, or null when there is no usable one.
 *
 * The resolution rule is comparative, so the two sides of the bus have to
 * compare the SAME WAY. The page resolves with Date.parse(); if this file
 * compared the raw strings, `"2026-09-01T10:00:00Z"` and
 * `"2026-09-01T06:00:00-04:00"` - the same instant, written two ways - would
 * order differently here than there, and one side would show a mark the other
 * had revoked. Parsing both sides to an instant is the only way the tie rule
 * means anything.
 *
 * A missing or unparseable stamp is null, and null LOSES to any real stamp
 * (see atRank): an entry nobody can place in time cannot outrank one that can.
 */
function atMs(entry) {
  const raw = entry?.at;
  if (typeof raw !== "string" || raw === "") return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** Sortable rank: the instant, or -Infinity for "cannot be placed in time". */
const atRank = (entry) => atMs(entry) ?? Number.NEGATIVE_INFINITY;

/**
 * The EFFECTIVE marks: key -> {at, via, state, ...}, tombstones applied per the
 * resolution rule (newest `at` wins as an INSTANT; a tie goes to the mark, and
 * an unplaceable stamp loses to a real one).
 *
 * Accepts a full store, a bare marks map, or null, and is idempotent - its own
 * output resolves to itself - so any layer may call it without knowing which
 * shape it was handed. PURE.
 */
export function resolveMarks(source) {
  const marks = completionsMap(source);
  const tombs = clearedMap(source);
  const out = {};
  for (const [key, entry] of Object.entries(marks)) {
    const tomb = tombs[key];
    if (tomb && atRank(tomb) > atRank(entry)) continue; // revoked by a newer tombstone
    out[key] = { ...entry, at: entry.at ?? null, via: markVia(entry), state: markState(entry) };
  }
  return out;
}

/** Add a source tag to whichever source array this item shape uses. Never mutates. */
export function addSource(it, name) {
  const key = isPayloadItem(it) ? "src" : "sources";
  const current = Array.isArray(it?.[key]) ? it[key] : [];
  if (current.includes(name)) return it;
  return { ...it, [key]: [...current, name] };
}

/**
 * Apply the user's own marks to an item list.
 *
 * Two states, two effects, and one thing that must never happen:
 *   done       -> submitted/s = true, "user" appended to the item's sources.
 *                 ONE-WAY as ever: an absent entry never clears a flag.
 *   cancelled  -> cancelled: true, "user" appended. The submitted flag is NOT
 *                 touched: the work was not done, the user decided not to do it,
 *                 and claiming otherwise would be a lie in every surface that
 *                 reads `s`.
 *   fb|... key -> NOTHING. A session mark is one focus block on one day; it has
 *                 no deliverable to close, and treating it as one is exactly
 *                 the bug the session key space exists to prevent. Session keys
 *                 cannot collide with an itemKey, and this loop still refuses
 *                 them by name so the guarantee is visible rather than
 *                 incidental.
 *
 * Tombstones are honoured (resolveMarks), so a mark the user took back stops
 * closing its item. Tolerates both item shapes through readItem(), writes flags
 * in the item's own shape, and accepts a full store or a bare marks map alike.
 *
 * PURE. Input array and input objects are never mutated.
 */
export function applyUserCompletions(items, completions) {
  const list = Array.isArray(items) ? items : [];
  const map = resolveMarks(completions);
  if (Object.keys(map).length === 0) return list;
  return list.map((it) => {
    const key = readItem(it).key;
    if (!key || isSessionKey(key) || !Object.prototype.hasOwnProperty.call(map, key)) return it;
    if (markState(map[key]) === STATE_CANCELLED) return addSource(markCancelled(it), "user");
    return addSource(markSubmitted(it, true), "user");
  });
}

/**
 * Candidates for a `--done` query, one per itemKey (Brightspace hands the same
 * deliverable to us several times; the user means the deliverable, not the row).
 * The occurrence kept is the earliest-due one, so the printed date is the one a
 * human would recognise.
 *
 * PURE. Returns [{key, course, title, due, type, submitted}] sorted by due.
 */
export function completionCandidates(items) {
  const byKey = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const view = readItem(it);
    if (!view.key || !view.title) continue;
    const prev = byKey.get(view.key);
    if (!prev || String(view.due ?? "") < String(prev.due ?? "")) byKey.set(view.key, view);
  }
  return [...byKey.values()].sort(
    (a, b) => String(a.due ?? "").localeCompare(String(b.due ?? "")) || a.title.localeCompare(b.title),
  );
}

/**
 * Resolve a free-text query to item candidates.
 *   1. An exact itemKey wins outright - this is the escape hatch the CLI points
 *      the user at when a query turns out ambiguous.
 *   2. A course code in the query ("math 210 hw 2") narrows the field first and
 *      is then stripped, so the title match only sees title words.
 *   3. What is left is matched with fuzzyTitleMatch(), the same matcher the
 *      Gradescope and mail channels use.
 *
 * PURE. Returns {matches: [candidate], via: "key"|"title"|"course"|"empty"}.
 */
export function matchCompletionQuery(query, items) {
  const candidates = completionCandidates(items);
  const raw = String(query ?? "").trim();
  if (!raw) return { matches: [], via: "empty" };

  const exact = candidates.filter((c) => c.key === raw);
  if (exact.length) return { matches: [exact[0]], via: "key" };

  const codeMatch = raw.match(/\b[A-Za-z]{2,5}\s*-?\s*\d{3,5}\b/);
  let pool = candidates;
  let text = raw;
  if (codeMatch) {
    const narrowed = candidates.filter((c) => courseMatches(c.course, codeMatch[0]));
    if (narrowed.length) {
      pool = narrowed;
      text = raw.replace(codeMatch[0], " ").trim();
    }
  }
  if (!normTitle(text)) {
    // "math 210" on its own: the course IS the query, so every item in it is a
    // candidate. Exactly one left means the user was unambiguous after all.
    return { matches: pool, via: "course" };
  }
  return { matches: pool.filter((c) => fuzzyTitleMatch(text, c.title)), via: "title" };
}

// ---------------------------------------------------------------------------
// Session queries: "start hw 1" is a BLOCK, "hw 1" is the deliverable
// ---------------------------------------------------------------------------
//
// The focus strip labels every block with an imperative verb (focus-engine
// verbFor): "Start HW 1", "Keep working on HW 1", "Finish HW 1", "Catch up on
// HW 1". When the user types one of those back at us she is talking about THAT
// BLOCK, not about the deliverable it belongs to - which is precisely the
// distinction the old matcher could not make, and precisely how one finished
// study session came to check off an entire assignment.
//
// Longest phrase first, matched only at the START of the query and only when a
// word boundary follows, so "start-up survey" stays a deliverable.
//
// PAST TENSE IS DELIBERATELY NOT HERE. "I finished HW 1" in chat means the
// deliverable is finished; "finish hw 1" is the label on tonight's block. The
// verbs recognised are exactly the imperatives the engine prints, plus the "on"
// forms an English speaker types anyway.
export const SESSION_VERBS = [
  "keep working on",
  "keep working",
  "catch up on",
  "catch up",
  "catchup",
  "continue with",
  "continue on",
  "continue",
  "start on",
  "start",
  "finish",
];

/**
 * Split a CLI query into {scope, verb, query}.
 *   scope "session" - a leading session verb; the rest names the deliverable
 *                     whose block the user means.
 *   scope "item"    - everything else, i.e. today's behaviour, unchanged.
 * PURE.
 */
export function parseCompletionQuery(raw) {
  const text = String(raw ?? "").trim();
  const lower = text.toLowerCase();
  for (const verb of SESSION_VERBS) {
    if (!lower.startsWith(verb)) continue;
    const after = text.slice(verb.length);
    if (after && !/^\s/.test(after)) continue; // "start-up ..." is not "start ..."
    return { scope: "session", verb, query: after.trim() };
  }
  return { scope: "item", verb: null, query: text };
}

/**
 * Normalize whatever data/focus-plan.json (or a payload `focus`) holds into
 * [{d, blocks}] with a usable day key. Junk days are dropped rather than
 * guessed at. PURE.
 */
export function focusPlanDays(plan) {
  const days = Array.isArray(plan) ? plan : Array.isArray(plan?.focus) ? plan.focus : [];
  const out = [];
  for (const day of days) {
    if (!day || typeof day !== "object") continue;
    if (typeof day.d !== "string" || !DAY_RE.test(day.d)) continue;
    out.push({ d: day.d, blocks: Array.isArray(day.blocks) ? day.blocks : [] });
  }
  return out;
}

/** Whole days between two YYYY-MM-DD keys. Local dates, no zone arithmetic. */
function dayGap(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/**
 * Which study session does "start hw 1 115" mean? The block for that
 * deliverable's bucket on the focus plan: TODAY's if there is one, otherwise
 * the nearest day that has one (a tie between a day before and a day after goes
 * forward - the plan is written forwards and the session the user is talking
 * about has usually not happened yet).
 *
 * Returns {key, day, block} or null. Null is a REFUSAL, never a fallback: the
 * caller must not quietly mark the deliverable instead.
 *
 * PURE.
 */
export function resolveSession(planDays, bucket, todayKey) {
  const days = Array.isArray(planDays) ? planDays : focusPlanDays(planDays);
  const want = String(bucket ?? ""); // verbatim, exactly as sessionKeyFor takes it
  if (want === "" || !DAY_RE.test(String(todayKey ?? ""))) return null;
  const hits = [];
  for (const day of days) {
    const block = day.blocks.find((b) => b && typeof b === "object" && b.c === want);
    if (!block) continue;
    const gap = dayGap(todayKey, day.d);
    if (gap === null) continue;
    hits.push({ day: day.d, block, gap });
  }
  if (!hits.length) return null;
  hits.sort(
    (a, b) =>
      Math.abs(a.gap) - Math.abs(b.gap) || // today first, then the nearest day
      (b.gap >= 0) - (a.gap >= 0) || // a tie goes forwards
      a.day.localeCompare(b.day),
  );
  const best = hits[0];
  // Keyed off the PLAN's own bucket string, which is the one the page will see.
  const key = sessionKeyFor(best.day, best.block.c);
  return key ? { key, day: best.day, block: best.block } : null;
}

/**
 * Merge new completion entries into an existing map WITHOUT ever removing or
 * overwriting one. The first recording of a key is the true one: a later run
 * observing the same finish must not move its timestamp.
 *
 * This is the plain additive merge of two bare marks maps: it knows nothing
 * about tombstones or states, and it is the right tool only where both sides
 * are known to be plain completions. The page's bus merges with
 * mergeCompletionDocs() instead, which implements the full resolution rule.
 *
 * PURE. Returns a NEW map.
 */
export function mergeCompletions(existing, additions) {
  const base = completionsMap(existing);
  const extra = completionsMap(additions);
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (Object.prototype.hasOwnProperty.call(out, k)) continue; // one-way: first write wins
    out[k] = v;
  }
  return out;
}

/**
 * The payload's completion LEDGER: what render.mjs publishes as `done[]`.
 *
 * Three kinds of entry, all `{k, at, via}` plus a state:
 *   (no state)          a completion. Absent means done, so the common case
 *                       carries no extra field at all.
 *   state "cancelled"   the user decided not to do it.
 *   state "cleared"     a TOMBSTONE - this mark was revoked.
 *
 * The tombstones are the pipeline -> page revocation channel, and without them
 * `--undone` is a lie: the page's own localStorage copy of a mark would
 * resurrect it on every load, forever, because a ledger of winners alone can
 * never say "this is gone". Only WINNING tombstones ship - a tombstone that
 * lost to a newer mark is dead history and would just be noise to re-resolve.
 *
 * `since` is one window rule for both (render passes the same 14-day cut it uses
 * for marks); an entry with no usable `at` cannot be resolved against anything
 * and is dropped rather than guessed at. Sorted newest first, ties by key so the
 * payload is stable between runs.
 *
 * PURE.
 */
export function completionLedger(store, { since = null } = {}) {
  const marks = resolveMarks(store);
  const tombs = clearedMap(store);
  const sinceMs = atMs({ at: since });
  // The window is measured in instants too, for the same reason resolution is.
  const inWindow = (entry) => {
    const ms = atMs(entry);
    return ms !== null && (sinceMs === null || ms >= sinceMs);
  };
  const out = [];
  for (const [k, entry] of Object.entries(marks)) {
    if (!inWindow(entry)) continue;
    const state = markState(entry);
    out.push({ k, at: entry.at, via: markVia(entry), ...(state === STATE_DONE ? {} : { state }) });
  }
  for (const [k, entry] of Object.entries(tombs)) {
    if (Object.prototype.hasOwnProperty.call(marks, k)) continue; // the mark won; nothing to revoke
    if (!inWindow(entry)) continue;
    out.push({ k, at: entry.at, via: markVia(entry), state: STATE_CLEARED });
  }
  return out.sort((a, b) => atRank(b) - atRank(a) || a.k.localeCompare(b.k));
}

// ---------------------------------------------------------------------------
// The store: one normalized shape, three pure transitions
// ---------------------------------------------------------------------------

/** {v:2, completions, cleared} out of a full store, a bare marks map, or junk. */
function normalizeStore(source) {
  return { v: 2, completions: completionsMap(source), cleared: clearedMap(source) };
}

/** The effective state of ONE key: {state:"none"|"done"|"cancelled", at, via}. PURE. */
export function markStatus(store, key) {
  const entry = resolveMarks(store)[key];
  if (!entry) return { state: "none", at: null, via: null };
  return { state: markState(entry), at: entry.at ?? null, via: markVia(entry) };
}

/**
 * Record a mark. Returns a NEW store with `key` marked in `completions` and any
 * tombstone for it dropped - a fresh mark supersedes its own history outright,
 * so the result does not depend on clock skew between this write and an old
 * tombstone. Losers are not kept: the store holds the winner per key, which
 * makes it a projection that merges the same way however often it is re-merged.
 *
 * PURE, apart from the `at` default (now) - pass `at` for a deterministic result.
 */
export function applyMark(store, key, { at, via = "user", state = STATE_DONE, note } = {}) {
  const base = normalizeStore(store);
  const entry = {
    at: at ?? new Date().toISOString(),
    via: via === "page" ? "page" : "user",
    state: state === STATE_CANCELLED ? STATE_CANCELLED : STATE_DONE,
    ...(note ? { note } : {}),
  };
  const cleared = { ...base.cleared };
  delete cleared[key];
  return { v: 2, completions: { ...base.completions, [key]: entry }, cleared };
}

/**
 * Revoke a mark (uncheck, or un-cancel - they are the same operation). Returns a
 * NEW store carrying a TOMBSTONE for `key` and no mark for it. The tombstone is
 * the record: dropping the entry alone would say nothing, because absence never
 * means removal on this bus.
 *
 * PURE, apart from the `at` default (now) - pass `at` for a deterministic result.
 */
export function clearMark(store, key, { at, via = "user" } = {}) {
  const base = normalizeStore(store);
  const completions = { ...base.completions };
  delete completions[key];
  return {
    v: 2,
    completions,
    cleared: {
      ...base.cleared,
      [key]: { at: at ?? new Date().toISOString(), via: via === "page" ? "page" : "user" },
    },
  };
}

/**
 * The three-state machine, as a pure decision. Returns
 * {op, state?, why} where op is:
 *   "mark"    write a mark of `state`
 *   "clear"   write a tombstone
 *   "noop"    already in that state - say so, change nothing, exit 0
 *   "refuse"  the transition is not allowed; `why` is the sentence to print
 *
 * The two refusals are the contract's, not this file's taste:
 *   done -> cancelled is a TWO-STEP (uncheck, then cancel), so the state machine
 *   stays three-state and no single command can silently rewrite a completion;
 *   and a PIPELINE-origin completion (Brightspace/grade/Gradescope/reply, i.e.
 *   `submitted === true` with no user mark behind it) can never be cleared or
 *   cancelled here - this file only ever owned the user's own declarations.
 *
 * cancelled -> done is allowed in one step: it adds a completion rather than
 * rewriting one, and "actually, I did do it" is the sentence a user types.
 *
 * PURE.
 */
export function markTransition(store, key, action, { submitted = null } = {}) {
  const status = markStatus(store, key);
  const current = status.state;
  // Two ways a completion can be the pipeline's: the item is flagged submitted
  // with no mark of hers behind it, or a mark of pipeline origin is what stands
  // (one can reach the store through the bus). Either way it is not hers.
  const pipeline = (submitted === true && current === "none") || isPipelineVia(status.via);
  if (action === "done") {
    if (current === STATE_DONE) return { op: "noop", why: "already recorded as done" };
    return {
      op: "mark",
      state: STATE_DONE,
      why: current === STATE_CANCELLED ? "was cancelled; recording it done instead" : "",
    };
  }
  if (action === "cancel") {
    if (pipeline) {
      return { op: "refuse", why: "the pipeline already has this submitted - a pipeline completion cannot be cancelled" };
    }
    if (current === STATE_CANCELLED) return { op: "noop", why: "already cancelled" };
    if (current === STATE_DONE) {
      return { op: "refuse", why: "it is currently marked done - clear that first (--undone), then cancel" };
    }
    return { op: "mark", state: STATE_CANCELLED, why: "" };
  }
  if (action === "clear") {
    if (pipeline) {
      return { op: "refuse", why: "this is a pipeline completion (Brightspace / grade / reply) - it is not yours to clear" };
    }
    if (current === "none") return { op: "noop", why: "nothing of yours is recorded for it" };
    return { op: "clear", why: current === STATE_CANCELLED ? "un-cancelled" : "unchecked" };
  }
  return { op: "refuse", why: `unknown action "${action}"` };
}

// ---------------------------------------------------------------------------
// The page bus: AGC1 envelopes -> one merged store
// ---------------------------------------------------------------------------
//
// The page writes its marks into a Google Doc as one `AGC1.<base64>.END` line
// and a scheduled run reads them back here. The envelope itself - the prefix,
// the whitespace tolerance a Doc's soft line breaks demand, the `.END` that
// proves the transcription was not cut short - is src/lib/envelope.mjs's job,
// shared with every other bus so the two ends can never drift apart.
//
// This bus stays uncompressed on purpose: the page writes it through a tool
// call with no language model in the path, and these documents are small.

/**
 * Decode one `AGC1.<base64>.END` doc body into {v, marks, cleared}.
 *
 * Returns null for anything that is not a clean completions envelope - a doc
 * that does not decode is SKIPPED and left in Drive, never guessed at and never
 * partially applied. That is deliberate: a half-read mark is worse than an
 * unread one, because the run that consumed it would then trash the document
 * holding the other half.
 *
 * A well-formed envelope of another kind (a payload, a command) is rejected the
 * same way. Kinds are not interchangeable, and a command doc silently read as
 * marks would write nonsense keys into the user's own record.
 *
 * PURE.
 */
export function decodeCompletionEnvelope(text) {
  let opened;
  try {
    opened = unpack(text);
  } catch (e) {
    if (e instanceof EnvelopeError) return null;
    throw e;
  }
  if (opened.kind !== "completions") return null;
  return decodeCompletionDoc(opened.data);
}

/**
 * Normalize an already-decoded doc into {v, marks, cleared}.
 *
 * The full doc shape is {v, marks, cleared}. A BARE MARKS MAP is also accepted,
 * because that is what an item-by-item export or a hand-written fixture looks
 * like - and it is treated as marks only, with no tombstones, so a bare map can
 * never revoke anything however new its timestamps look. The `v` in the result
 * says which of the two was read, and the ingest summary prints it.
 *
 * PURE.
 */
function decodeCompletionDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const isFullDoc =
    doc.marks !== undefined || doc.cleared !== undefined || (typeof doc.v === "number" && doc.v >= 2);
  if (isFullDoc) {
    const marks = entryMap(doc.marks !== undefined ? doc.marks : doc.completions);
    return { v: 2, marks, cleared: entryMap(doc.cleared) };
  }
  // A bare map: every entry is a completion, and nothing in it can clear anything.
  const marks = {};
  for (const [k, v] of Object.entries(completionsMap(doc))) marks[k] = { ...v, state: STATE_DONE };
  return { v: 1, marks, cleared: {} };
}

/** Sort a map's keys so a written file (and a test's deepEqual) is stable. */
function sortedMap(map) {
  const out = {};
  for (const k of Object.keys(map).sort()) out[k] = map[k];
  return out;
}

/**
 * Merge the page's completion docs into the current store. THE ingest step's
 * one function (docs/PROTOCOL.md).
 *
 * `docs` may hold raw envelope strings, already-decoded doc JSON, or a mix;
 * anything that does not decode is skipped without disturbing what is already
 * recorded. For each key every candidate - the current mark, the current
 * tombstone, and each doc's marks/cleared - competes on `at` as an INSTANT:
 * newest wins, an exact tie goes to the MARK, and an exact tie between two
 * entries of the same kind keeps the one seen first (the current store, then
 * docs in the order given), which makes the merge deterministic for a caller
 * that lists docs in a stable order. Only the winner is kept, so re-merging the
 * same docs is a no-op.
 *
 * THE ORIGIN RULE IS STRUCTURAL HERE, not a matter of timestamps: a tombstone
 * can never beat a PIPELINE-ORIGIN mark (one whose `via` is neither "user" nor
 * "page" - a grade, a Gradescope submission, a sent reply). markTransition
 * refuses that revocation at the CLI, the page refuses it too, and this refuses
 * it on the way in, so a malformed or hostile doc cannot achieve through the
 * bus what neither door allows. Refusals are counted, not hidden: the returned
 * `refusedTombstones` is a REPORT for the ingest summary, not part of the store
 * (saveUserCompletions writes only v/completions/cleared).
 *
 * PURE. Returns a NEW {v:2, completions, cleared, refusedTombstones}; inputs are
 * never mutated.
 */
export function mergeCompletionDocs(current, docs = []) {
  const base = normalizeStore(current);
  const best = new Map(); // key -> {kind, entry, pipeline}
  let refusedTombstones = 0;
  const offer = (key, kind, raw) => {
    const pipeline = kind === "mark" && isPipelineVia(raw?.via);
    const entry =
      kind === "mark"
        ? { ...raw, at: raw.at ?? null, via: markVia(raw), state: markState(raw) }
        : { at: raw.at ?? null, via: markVia(raw) };
    const held = best.get(key);
    if (!held) {
      best.set(key, { kind, entry, pipeline });
      return;
    }
    // Origin rule, both orderings, before any clock is consulted.
    if (kind === "cleared" && held.kind === "mark" && held.pipeline) {
      refusedTombstones += 1;
      return;
    }
    if (pipeline && held.kind === "cleared") {
      best.set(key, { kind, entry, pipeline });
      refusedTombstones += 1;
      return;
    }
    const a = atRank(held.entry);
    const b = atRank(entry);
    if (b > a || (b === a && held.kind === "cleared" && kind === "mark")) best.set(key, { kind, entry, pipeline });
  };

  for (const [k, v] of Object.entries(base.completions)) offer(k, "mark", v);
  for (const [k, v] of Object.entries(base.cleared)) offer(k, "cleared", v);
  for (const doc of Array.isArray(docs) ? docs : []) {
    const decoded = typeof doc === "string" ? decodeCompletionEnvelope(doc) : decodeCompletionDoc(doc);
    if (!decoded) continue;
    for (const [k, v] of Object.entries(decoded.marks)) offer(k, "mark", v);
    for (const [k, v] of Object.entries(decoded.cleared)) offer(k, "cleared", v);
  }

  const completions = {};
  const cleared = {};
  for (const [key, held] of best) {
    if (held.kind === "mark") completions[key] = held.entry;
    else cleared[key] = held.entry;
  }
  return { v: 2, completions: sortedMap(completions), cleared: sortedMap(cleared), refusedTombstones };
}

// ---------------------------------------------------------------------------
// Loaders / writers (impure, and the only ones in this file)
// ---------------------------------------------------------------------------

/**
 * Read data/user-completions.json as a normalized store. A file holding only a
 * bare marks map loads unchanged into `completions` with an empty `cleared`; an
 * absent or unreadable file is an empty store, never a throw.
 */
export function loadCompletionStore(dataDir) {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(path.join(dataDir, "user-completions.json"), "utf8")));
  } catch {
    return { v: 2, completions: {}, cleared: {} };
  }
}

/**
 * The EFFECTIVE marks on disk: key -> {at, via, state}, tombstones applied.
 * This is what every consumer (render, focus, behind) wants; the raw store is
 * loadCompletionStore().
 */
export function loadUserCompletions(dataDir) {
  return resolveMarks(loadCompletionStore(dataDir));
}

/**
 * Write the store back, key-sorted, in the wrapper shape. Accepts a full store
 * or a bare marks map so no caller has to know which it holds. Sorting is what
 * keeps the file's diffs readable and the Drive mirror stable between runs.
 */
export function saveUserCompletions(dataDir, storeOrMap) {
  const store = normalizeStore(storeOrMap);
  fs.writeFileSync(
    path.join(dataDir, "user-completions.json"),
    JSON.stringify(
      { v: 2, completions: sortedMap(store.completions), cleared: sortedMap(store.cleared) },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Read data/focus-plan.json - the plan render.mjs writes next to the payload so
 * this file can turn "start hw 1" into the session key of an actual block.
 * Returns the parsed plan or null; absence is normal (no render has run yet)
 * and is a REFUSAL input, never a reason to fall back to the deliverable.
 */
export function loadFocusPlan(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "focus-plan.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI -- the user's chat channel into the pipeline
// ---------------------------------------------------------------------------
//
//   node src/completion.mjs --done     "<query>"   mark it finished
//   node src/completion.mjs --done     "<itemKey>" the same, by exact key
//   node src/completion.mjs --undone   "<query>"   take a mark of YOURS back
//   node src/completion.mjs --cancel   "<query>"   decide not to do it
//   node src/completion.mjs --uncancel "<query>"   alias of --undone
//   node src/completion.mjs --list                 print what has been recorded
//   node src/completion.mjs --ingest <doc> [...]   merge page docs (AGC1 body
//                                              text, or a file holding one)
//
// Every form also takes --config <path> and --data <dir>, which is what lets a
// test drive the real CLI against a scratch directory instead of live state.
//
// A query that STARTS with a session verb ("start hw 1", "keep working on hw 1")
// means that study BLOCK, resolved against data/focus-plan.json. When no session
// can be resolved the command REFUSES and names both options; it never falls
// back to the deliverable, because doing that silently is the bug the session
// key space exists to prevent.
//
// Exit codes (the caller and the scheduled agent depend on these):
//   0  recorded / cleared / already in that state / listed / ingested
//   2  usage error
//   3  data/latest.json missing or unreadable (or the store could not be written)
//   4  ambiguous query - candidates printed, re-run with the exact itemKey
//   5  no match at all
//   6  refused - a transition the contract does not allow, or a session that
//      could not be resolved. Nothing was written.

const CLI_CANDIDATE_CAP = 12; // a numbered list longer than this helps nobody

function cliPrintCandidates(matches) {
  matches.slice(0, CLI_CANDIDATE_CAP).forEach((c, i) => {
    const when = c.due ? String(c.due).slice(0, 10) : "no date";
    const done = c.submitted === true ? " [already submitted]" : "";
    console.log(`${String(i + 1).padStart(2)}. ${c.course} - ${c.title} (${when})${done}`);
    console.log(`    ${c.key}`);
  });
  const extra = matches.length - CLI_CANDIDATE_CAP;
  if (extra > 0) console.log(`    ... and ${extra} more - narrow the query (e.g. add the course code)`);
}

const USAGE =
  'usage: node src/completion.mjs --done|--undone|--cancel|--uncancel "<title, session verb + title, or itemKey>"\n' +
  "       node src/completion.mjs --list\n" +
  "       node src/completion.mjs --ingest <AGC1 doc body or file> [...]\n" +
  "       (any form also takes --config <path> and --data <dir>)";

/**
 * Today, in the focus plan's zone when it has one, then the configured zone,
 * and only then the machine's. The plan wins because a session key must be
 * built in the same zone the plan's day keys were.
 */
function cliToday(tz) {
  const now = new Date();
  try {
    if (tz) {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    }
  } catch {
    /* an unknown zone in the plan is not worth failing over */
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function cliList(dir) {
  const store = loadCompletionStore(dir);
  const map = resolveMarks(store);
  const keys = Object.keys(map).sort((a, b) => String(map[b].at ?? "").localeCompare(String(map[a].at ?? "")));
  const tombs = Object.keys(store.cleared).length;
  if (!keys.length) {
    console.log(`no marks recorded yet${tombs ? ` (${tombs} cleared)` : ""}`);
    return 0;
  }
  for (const k of keys) {
    const e = map[k];
    const kind = isSessionKey(k) ? "session" : "item";
    console.log(
      `${String(e.at ?? "").slice(0, 19)}  ${(e.via ?? "user").padEnd(4)}  ${markState(e).padEnd(9)}  ${kind.padEnd(7)}  ${k}${e.note ? "  " + e.note : ""}`,
    );
  }
  console.log(
    `\n${keys.length} mark(s) in ${path.join(dir, "user-completions.json")}` + (tombs ? `, ${tombs} cleared` : ""),
  );
  return 0;
}

// The item files render.mjs merges on top of the Brightspace snapshot. The chat
// channel has to see the same universe the agenda does: CHEM 115's "Homework 1"
// lives in outlook-items.json (it was born from Prof. Lang's email and never
// existed in Brightspace), and a query the user can read off her own agenda has
// to be answerable. Absent files are the normal case and say nothing.
const CLI_ITEM_FILES = ["outlook-items.json", "board-items.json", "phone-items.json"];

/**
 * Every item the pipeline knows about, deduped by key+due exactly as render.mjs
 * and behind.mjs dedupe. data/latest.json is required - without the snapshot
 * there is no matching to do (exit 3); the side files are optional.
 */
function cliItems(dir) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8"));
  } catch (e) {
    console.log(`cannot read data/latest.json: ${e.message}`);
    return null;
  }
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const view = readItem(raw);
    if (!view.key || !view.title) return;
    const id = `${view.key}|${view.due ?? ""}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(raw);
  };
  for (const raw of snapshot.items ?? []) push(raw);
  for (const file of CLI_ITEM_FILES) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      for (const raw of data?.items ?? []) push(raw);
    } catch {
      /* optional: an absent or unreadable side file is not a failure */
    }
  }
  return out;
}

/**
 * Turn a raw query into the ONE key this command will act on.
 * Returns {key, label, submitted, session} or {code} to exit with.
 */
function cliResolveTarget(raw, dir, cfg) {
  const items = cliItems(dir);
  if (!items) return { code: 3 };

  const parsed = parseCompletionQuery(raw);
  const { matches } = matchCompletionQuery(parsed.query, items);
  if (matches.length === 0) {
    console.log(`no item matches "${raw}".`);
    console.log("try `node src/completion.mjs --list` for what is already recorded, or");
    console.log("`node src/render.mjs --gaps` for the item keys the pipeline knows about.");
    return { code: 5 };
  }
  if (matches.length > 1) {
    console.log(`"${raw}" matches ${matches.length} items - re-run with the exact key:`);
    cliPrintCandidates(matches);
    return { code: 4 };
  }

  const hit = matches[0];
  if (parsed.scope !== "session") {
    return {
      key: hit.key,
      label: `${hit.course} - ${hit.title}${hit.due ? " (due " + String(hit.due).slice(0, 10) + ")" : ""}`,
      submitted: hit.submitted,
      session: null,
    };
  }

  // A session verb was used, so ONLY a session may be marked. If the plan on
  // disk cannot produce one, this refuses - it does not quietly widen the mark
  // to the whole deliverable, which is the bug this branch exists to prevent.
  const plan = loadFocusPlan(dir);
  const session = resolveSession(focusPlanDays(plan), hit.course, cliToday(plan?.tz ?? cfg?.timezone));
  if (!session) {
    console.log(`"${raw}" names a study session ("${parsed.verb}"), and no ${hit.course} block could be found.`);
    console.log(
      plan
        ? `  data/focus-plan.json has no ${hit.course} block in the next week.`
        : "  data/focus-plan.json is not on disk yet (no render has written a plan).",
    );
    console.log("refusing to guess. the two things you might have meant:");
    console.log("  the SESSION      - re-run after `node src/render.mjs` rebuilds the focus plan");
    console.log(`  the DELIVERABLE  - every block, chip and card of it, which is NOT what a`);
    console.log(`                     session verb asks for:`);
    console.log(`      node src/completion.mjs --done "${hit.key}"`);
    return { code: 6 };
  }
  const what = typeof session.block.what === "string" && session.block.what ? session.block.what : hit.title;
  return {
    key: session.key,
    label: `${hit.course} ${session.day}${session.block.t ? " " + session.block.t : ""} - ${what}`,
    submitted: null, // a study block has no pipeline origin: it is only ever the user's
    session,
  };
}

/**
 * --done / --undone / --cancel / --uncancel: one matcher, one state machine,
 * one refusal lane. `action` is "done" | "cancel" | "clear".
 */
function cliMark(action, raw, dir, cfg) {
  const target = cliResolveTarget(raw, dir, cfg);
  if (target.code) return target.code;

  const store = loadCompletionStore(dir);
  const decision = markTransition(store, target.key, action, { submitted: target.submitted });
  if (decision.op === "refuse") {
    console.log(`refused: ${target.label}`);
    console.log(`  ${decision.why}`);
    console.log(`  key ${target.key}`);
    return 6;
  }
  if (decision.op === "noop") {
    const at = markStatus(store, target.key).at;
    console.log(`${decision.why}${at ? " (" + String(at).slice(0, 19) + ")" : ""}: ${target.label}`);
    return 0;
  }

  const at = new Date().toISOString();
  const next =
    decision.op === "clear"
      ? clearMark(store, target.key, { at, via: "user" })
      : applyMark(store, target.key, { at, via: "user", state: decision.state });
  try {
    saveUserCompletions(dir, next);
  } catch (e) {
    console.log(`cannot write data/user-completions.json: ${e.message}`);
    return 3;
  }

  const headline =
    decision.op === "clear"
      ? `cleared (${decision.why})`
      : decision.state === STATE_CANCELLED
        ? "cancelled"
        : "marked done";
  console.log(`${headline}: ${target.label}`);
  console.log(`  key ${target.key}${target.session ? "  (this study block only)" : ""}`);
  console.log(`  at  ${at} via user`);
  if (decision.op === "mark" && decision.why) console.log(`  (${decision.why})`);
  if (target.submitted === true && decision.op === "mark") {
    console.log("  (the pipeline already had it submitted - recorded anyway, completions are additive)");
  }
  return 0;
}

/**
 * --ingest: merge the page's completion docs into data/user-completions.json.
 * Each argument is either an AGC1 doc body or a path to a file holding one.
 * Docs are reported one line each so the caller knows exactly which ones it may
 * trash: a SKIPPED doc was not consumed and must be left in Drive.
 */
function cliIngest(args, dir) {
  if (!args.length) {
    console.log(USAGE);
    return 2;
  }
  const before = loadCompletionStore(dir);
  const docs = [];
  let skipped = 0;
  args.forEach((arg, i) => {
    let text = arg;
    if (!/^\s*AGC1\./.test(arg)) {
      try {
        text = fs.readFileSync(arg, "utf8");
      } catch (e) {
        console.log(`doc ${i + 1}: SKIPPED - cannot read ${arg} (${e.message})`);
        skipped += 1;
        return;
      }
    }
    const decoded = decodeCompletionEnvelope(text);
    if (!decoded) {
      console.log(`doc ${i + 1}: SKIPPED - not a decodable AGC1 envelope`);
      skipped += 1;
      return;
    }
    docs.push(decoded);
    console.log(
      `doc ${i + 1}: ok - v${decoded.v}, ${Object.keys(decoded.marks).length} mark(s), ${Object.keys(decoded.cleared).length} cleared`,
    );
  });

  const merged = mergeCompletionDocs(before, docs);
  try {
    saveUserCompletions(dir, merged);
  } catch (e) {
    console.log(`cannot write data/user-completions.json: ${e.message}`);
    return 3;
  }
  const was = resolveMarks(before);
  const now = resolveMarks(merged);
  const added = Object.keys(now).filter((k) => !(k in was)).length;
  const revoked = Object.keys(was).filter((k) => !(k in now)).length;
  const changed = Object.keys(now).filter((k) => k in was && markState(now[k]) !== markState(was[k])).length;
  console.log(
    `ingest: ${docs.length} doc(s) consumed, ${skipped} skipped; ` +
      `${added} new mark(s), ${revoked} revoked, ${changed} changed state` +
      (merged.refusedTombstones
        ? `, ${merged.refusedTombstones} tombstone(s) REFUSED (pipeline-origin completion, not the user's to clear)`
        : "") +
      `; ${Object.keys(merged.completions).length} mark(s) and ${Object.keys(merged.cleared).length} tombstone(s) on file`,
  );
  return 0;
}

const CLI_ACTIONS = { "--done": "done", "--undone": "clear", "--uncancel": "clear", "--cancel": "cancel" };

function cliMain(argv) {
  const root = repoRoot();
  const dir = resolveDataDir(argv, root);
  // The config is only consulted for a timezone fallback, so a missing or
  // half-filled config.json must not stop the user recording that she is done.
  let cfg = null;
  try {
    cfg = loadConfig(null, { argv, warn: () => {} });
  } catch {
    /* an unreadable config is not a reason to refuse a mark */
  }

  const ingestAt = argv.indexOf("--ingest");
  if (ingestAt !== -1) {
    const docs = [];
    for (let i = ingestAt + 1; i < argv.length; i += 1) {
      const arg = argv[i];
      // --config/--data take a value; skipping the flag alone would feed the
      // path in as a document body.
      if (arg === "--config" || arg === "--data") {
        i += 1;
        continue;
      }
      if (arg.startsWith("--")) continue;
      docs.push(arg);
    }
    return cliIngest(docs, dir);
  }

  for (const [flag, action] of Object.entries(CLI_ACTIONS)) {
    const at = argv.indexOf(flag);
    if (at === -1) continue;
    const query = argv[at + 1];
    if (!query || query.startsWith("--")) {
      console.log(USAGE);
      return 2;
    }
    return cliMark(action, query, dir, cfg);
  }
  if (argv.includes("--list")) return cliList(dir);
  console.log(USAGE);
  return 2;
}

// Only when run directly: several modules import this one for its pure half.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(cliMain(process.argv.slice(2)));
}
