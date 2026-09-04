// brief.mjs - the plain-text brief that rides after the payload envelope.
//
// WHY THIS EXISTS
//
// The `<ns>-data` document has two readers with nothing in common. The PAGE
// wants the whole payload and gets it from the `AGD2.` envelope. The PHONE - a
// claude.ai Project with a Drive connector and no code of its own - was being
// asked to base64-decode, checksum and gunzip several thousand characters
// inside a chat turn, which is slow, lossy and pointless when all it ever needs
// is four short lists.
//
// So the same document now carries a brief in plain English after the envelope,
// and the phone reads THAT. `docs/PHONE.md` is what the user pastes into the
// Project.
//
// The rule that keeps the two halves honest: **everything after the FIRST
// `.END` is invisible to every machine reader.** `sliceEnvelope()` in
// `lib/envelope.mjs` is the one function that enforces it, and both machine
// readers - the page's refresh path and `behind.mjs` - go through it. The brief
// can therefore say anything at all, including something that looks like an
// envelope, without any risk of being parsed as data.
//
// It is derived from exactly the object the envelope carries - never from the
// files behind it - so the two halves of the document can never disagree.
//
// PURE. No clock of its own, no filesystem, no globals: `now` is passed in, as
// it is everywhere else in this pipeline, so a brief is reproducible.
import {
  addDays,
  clockOf,
  localDayKey,
  localMinuteOfDay,
  localTimeLabel,
  localWeekday,
  minutesOfClock,
  weekdayOfKey,
} from "./focus-engine.mjs";

/* A phone screen and a chat turn, not a report. The caps are belt AND braces:
   each section is capped so a busy day cannot crowd out the section below it,
   and the whole brief is capped again at the end so no future section can break
   the promise on its own. */
export const MAX_LINES = 60;
export const MAX_COLS = 100;
/* The caps have to ADD UP, not merely each be small. A full brief is
     1 open marker + 1 header
   + 4 sections, each a title + its cap + one "... and N more" overflow line
   + 1 NOTE + 1 close marker
   = 12 + PLAN + DUE + OVERDUE + MEETINGS,
   so the four caps may total at most MAX_LINES - 12 = 48. They total exactly
   that, which is why nothing - not the NOTE, not an overflow line - can be
   silently cut on the busiest day of the term. `briefBudget()` below is the
   same arithmetic as a function, and a test calls it. */
export const PLAN_CAP = 18;
export const DUE_CAP = 12;
export const OVERDUE_CAP = 10;
export const MEETINGS_CAP = 8;
export const SECTION_OVERHEAD = 12;
export const DUE_WINDOW_HOURS = 48;

/** The worst-case line count of a brief, from the caps alone. PURE. */
export function briefBudget() {
  return SECTION_OVERHEAD + PLAN_CAP + DUE_CAP + OVERDUE_CAP + MEETINGS_CAP;
}

export const OPEN_MARK = "--- BRIEF (plain text for the phone; the blob above is the page's) ---";
export const CLOSE_MARK = "--- END BRIEF ---";

/** What the header calls the agenda when the caller does not say. */
export const DEFAULT_TITLE = "Agenda";

const MINUTES_PER_DAY = 24 * 60;
const LAST_MINUTE = MINUTES_PER_DAY - 1;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/* Course titles, mail subjects and calendar summaries are whatever somebody
   typed - curly quotes, en dashes, emoji, a stray tab. The document is read by
   a phone through a Google Doc round trip, so it is held to plain ASCII: the
   handful of characters with an obvious ASCII spelling are transliterated and
   everything else is dropped rather than turned into a mojibake box. */
/* This file is itself pure ASCII, so every source key here is an escape. */
const ASCII = new Map([
  ["\u2018", "'"], ["\u2019", "'"], ["\u201a", "'"], ["\u201b", "'"],
  ["\u201c", '"'], ["\u201d", '"'], ["\u201e", '"'], ["\u00ab", '"'], ["\u00bb", '"'],
  ["\u2010", "-"], ["\u2011", "-"], ["\u2012", "-"], ["\u2013", "-"], ["\u2014", "-"], ["\u2015", "-"],
  ["\u2026", "..."], ["\u2022", "*"], ["\u00b7", "-"], ["\u2192", "->"], ["\u00d7", "x"], ["\u00b0", "deg"],
]);

/* The one sequence untrusted text may not keep: a "#" with a space in front of
   it, which is `KEY_LEAD` and the only thing telling a phone where an item key
   starts (docs/PHONE.md). A title like "Homework #3" would otherwise put a
   second lead-in on a row and hand the phone a phantom key - a key it quotes
   back verbatim, the completions bus matches nothing, and the user is told work
   is done that the pipeline still shows as overdue. A "#" at the START counts
   too: a row's own furniture is what puts the space in front of it.

   "No." is the substitution because it is ASCII, it reads as the same thing to
   a person, and it can never itself become a lead-in. A "#" with a letter in
   front of it is nobody's key ("C#", "F#") and is left alone. */
const keyLeadOut = (text) => text.replace(/(^|\s)#/g, "$1No.");

/** Any string -> one line of printable ASCII. Never null, never multi-line. PURE. */
export function toAscii(text) {
  if (text === null || text === undefined) return "";
  let out = "";
  for (const ch of String(text)) {
    if (ch >= " " && ch <= "~") out += ch;
    else if (ASCII.has(ch)) out += ASCII.get(ch);
    else if (/\s/.test(ch)) out += " ";
    // anything else is dropped: a box glyph is worse than a missing one
  }
  return keyLeadOut(out.replace(/\s+/g, " ").trim());
}

/**
 * Length clamp only. Whitespace is LOAD-BEARING once a row is assembled, so
 * this is what the final pass uses; `clip` is the same thing with a normalize
 * in front of it, for the raw strings that go INTO a row. PURE.
 */
export function truncate(text, max) {
  const s = text === null || text === undefined ? "" : String(text);
  if (max <= 0) return "";
  if (s.length <= max) return s;
  return max <= 3 ? s.slice(0, max) : s.slice(0, max - 3) + "...";
}

/** ASCII, and no longer than `max` - the tail becomes "..." when it is cut. PURE. */
export function clip(text, max) {
  return truncate(toAscii(text), max);
}

/**
 * The one choke point every FINISHED line passes through.
 *
 * Each field is already `toAscii`d on the way into a row, but "already" is a
 * convention and this is the guarantee: any character that slipped in whole -
 * an interpolated `scrapedAt`, a constant somebody edits later - is
 * transliterated or dropped here, and the line is clamped to MAX_COLS.
 *
 * It deliberately does NOT collapse runs of spaces the way `toAscii` does: by
 * this point the padding IS the layout, and normalizing it would destroy every
 * column in the brief. PURE.
 */
export function finishLine(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    if (ch >= " " && ch <= "~") out += ch;
    else if (ASCII.has(ch)) out += ASCII.get(ch);
    // control characters (including any stray newline) and the rest are dropped
  }
  return truncate(out, MAX_COLS);
}

/**
 * Codepoint order, never the runtime's collation. `localeCompare` without an
 * explicit locale follows the host's ICU, and this file promises a brief is
 * reproducible: two machines must not order two same-start rows differently.
 * PURE.
 */
export const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/* focus-engine's helpers already handle the timezone and the DST edges; this is
   the one format they do not have - the brief's header stamp. Built from parts
   so it reads "Thu Sep 3, 2026 2:10 PM EDT" and not en-US's default comma-heavy
   form. A runtime whose ICU cannot resolve the zone (a small-icu build) falls
   back to the UTC instant rather than throwing: a brief with a slightly foreign
   stamp beats no brief at all. PURE. */
export function stampOf(at, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short", month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    }).formatToParts(at);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
    const zone = get("timeZoneName");
    return toAscii(
      `${get("weekday")} ${get("month")} ${get("day")}, ${get("year")} ` +
        `${get("hour")}:${get("minute")} ${get("dayPeriod")}${zone ? " " + zone : ""}`,
    );
  } catch {
    return at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
}

/** "Fri Sep 4 11:59 PM" - the column the deadline sections lead with. PURE. */
function dueStamp(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "(no date)";
  let monthDay = "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
    monthDay = `${get("month")} ${get("day")}`;
  } catch {
    monthDay = d.toISOString().slice(5, 10);
  }
  return toAscii(`${localWeekday(d, tz)} ${monthDay} ${localTimeLabel(d, tz)}`);
}

/** 630, 60 -> "10:30-11:30". A span that would run past midnight stops at it. PURE. */
function span(startMin, minutes) {
  const end = Math.min(startMin + Math.max(0, Math.round(minutes || 0)), LAST_MINUTE);
  return `${clockOf(startMin)}-${clockOf(end)}`;
}

// ---------------------------------------------------------------------------
// The one completion rule this file has
// ---------------------------------------------------------------------------

/**
 * The keys the last publish says are closed. `state: "cleared"` entries are
 * REVOCATIONS (docs/PROTOCOL.md section 6) - the user took that mark back - so
 * they are not closures and must not silence anything. PURE.
 */
export function closedKeys(done) {
  const out = new Set();
  for (const e of Array.isArray(done) ? done : []) {
    if (!e || typeof e.k !== "string" || e.state === "cleared") continue;
    out.add(e.k);
  }
  return out;
}

/* An item is worth the user's attention when nothing has closed it: no mark or
   cancellation in done[], and no submission the pipeline can prove. `s !== true`
   is deliberately the whole test on that side - `s: false` and `s: null` both
   mean "not proven done", and the brief says exactly that with "(not
   confirmed)" rather than claiming the work has not been done. */
const isOpen = (item, closed) =>
  item && typeof item.k === "string" && item.s !== true && !closed.has(item.k);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const PLAN_TIME_W = 11;
const PLAN_LABEL_W = 10;
const PLAN_PREFIX_W = 2 + PLAN_TIME_W + 2 + PLAN_LABEL_W + 1;
const PLAN_TEXT_W = MAX_COLS - PLAN_PREFIX_W;

/* The phone reads the brief and nothing else, and both write-back buses are
   keyed by item key - so a row the user can ACT on has to carry its key, or the
   phone can only ever say "do that on the page". `#` is the lead-in the phone
   quotes back verbatim; it is not part of the key. The key is everything after
   the LAST " #" on the line. */
export const KEY_LEAD = " #";

/**
 * Can this key suffix be printed WHOLE on a row with `prefixW` columns of fixed
 * furniture in front of it? PURE, and the ONE place either row builder asks.
 *
 * It exists because reserving the key out of the title's budget is not the same
 * as checking the key fits: a title can shrink to nothing, and then the row is
 * just prefix + key, over 100 columns, and `finishLine` trims the tail - which
 * by then IS the key - and writes "..." on the end of it. An item key is
 * `<courseId>::<type>::<normalized title>`, so a six-digit id plus "homework"
 * is 18 characters before the title even starts.
 */
export function fitsKey(keySuffix, prefixW) {
  return prefixW + String(keySuffix ?? "").length <= MAX_COLS;
}

/* NO KEY BEATS A WRONG KEY - the same rule an ambiguous tie already follows. A
   truncated key is worse than none: the phone is told to quote it exactly and
   cannot know it was already cut, so it writes a stub the completions bus will
   never match, the mark silently no-ops, and the user is told work is done that
   the pipeline still shows as overdue. A keyless row is already handled - the
   phone says so and offers the page (docs/PHONE.md, "Item keys"). */
export function keyOf(item, prefixW) {
  if (!item || typeof item.k !== "string" || !item.k) return "";
  const clean = toAscii(item.k);
  // The same rule, for the same reason, as a key that does not fit: a key the
  // ASCII pass had to CHANGE is no longer the key the completions bus holds, so
  // it is not printed at all. `normTitle` cannot produce one today - it strips
  // everything outside [a-z0-9 ] - and this is what keeps the row honest if that
  // ever changes.
  if (clean !== item.k) return "";
  const suffix = KEY_LEAD + clean;
  return fitsKey(suffix, prefixW) ? suffix : "";
}

const planLine = (r) => {
  const key = r.key || "";
  return (
    "  " + pad(r.time, PLAN_TIME_W) + "  " + pad(clip(r.label, PLAN_LABEL_W), PLAN_LABEL_W) +
    " " + clip(r.text, Math.max(PLAN_TEXT_W - key.length, 0)) + key
  );
};

/** Sort key: all-day first, then by start minute, then stably by what it says. */
const byStart = (a, b) => a.order - b.order || a.at - b.at || byCode(a.label, b.label) || byCode(a.text, b.text);

/* ---------------------------------------------------------------- ties ----
   Which deliverable is a study block FOR? The planner does not record it, so
   this is the page's own matcher (page-template.html `tieItemFor`), ported
   verbatim in behaviour so the phone and the page never disagree about which
   block serves which item: same bucket, the item is not already past the
   block's day, every non-stopword of the item's title appears in the block's
   text, and EXACTLY ONE item qualifies. One hit or none - an ambiguous tie is
   no tie, because a wrong key on a phone is a wrong item marked done. */
const TIE_STOP = new Set(["the", "a", "an", "of", "for", "and", "to", "in", "on", "at", "with", "my"]);

/** A title -> its comparable words, with the usual coursework abbreviations expanded. PURE. */
export function tieWords(s) {
  let t = " " + String(s == null ? "" : s).toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() + " ";
  t = t.replace(/ hw /g, " homework ").replace(/ hwk /g, " homework ")
    .replace(/ pset /g, " problem set ").replace(/ ps /g, " problem set ");
  return t.trim().split(/\s+/).filter(Boolean);
}

/** The one item a block serves, or null when nothing or more than one qualifies. PURE. */
export function tieItemFor(block, dayKey, items, tz) {
  if (!block || !block.c) return null;
  const bag = new Set(tieWords((block.what || "") + " " + (block.why || "")));
  let found = null;
  for (const it of items) {
    if (!it || it.c !== block.c) continue;
    if (localDayKey(it.d, tz) < dayKey) continue;
    const need = tieWords(it.t);
    let matched = 0;
    let ok = true;
    for (const w of need) {
      if (TIE_STOP.has(w)) continue;
      if (!bag.has(w)) { ok = false; break; }
      matched++;
    }
    if (!ok || !matched) continue;
    if (found) return null; // two candidates is not a tie, it is a guess
    found = it;
  }
  return found;
}

/** Today's focus blocks. An untimed block has no place in the clock order, so it
    sits after the timed ones and says "anytime" instead of inventing an hour. */
function focusRows(compact, todayKey, items, tz) {
  const day = (Array.isArray(compact.focus) ? compact.focus : []).find((d) => d && d.d === todayKey);
  const rows = [];
  for (const b of Array.isArray(day?.blocks) ? day.blocks : []) {
    if (!b || typeof b !== "object") continue;
    const start = minutesOfClock(b.t);
    rows.push({
      order: start === null ? 2 : 1,
      at: start === null ? 0 : start,
      time: start === null ? "anytime" : span(start, b.mins),
      label: toAscii(b.c),
      text: toAscii(b.what || b.why || "study"),
      // A block the user can close from the phone carries the deliverable's
      // key; a block serving nothing nameable carries none rather than a guess.
      key: keyOf(tieItemFor(b, todayKey, items, tz), PLAN_PREFIX_W),
    });
  }
  return rows;
}

/** The classes the user actually attends on this day. `attend: false` courses are
    self-study - the focus blocks already carry them, and printing a lecture the
    user does not go to as if it were a commitment is exactly the wrong nudge. */
function classRows(compact, todayKey) {
  const weekday = weekdayOfKey(todayKey);
  const rows = [];
  for (const s of Array.isArray(compact.schedule) ? compact.schedule : []) {
    if (!s || s.attend !== true) continue;
    if (!Array.isArray(s.days) || !s.days.includes(weekday)) continue;
    if (typeof s.from === "string" && s.from && todayKey < s.from) continue;
    if (typeof s.until === "string" && s.until && todayKey > s.until) continue;
    const start = minutesOfClock(s.start);
    rows.push({
      order: 1,
      at: start === null ? 0 : start,
      time: s.start && s.end ? `${s.start}-${s.end}` : "class",
      label: toAscii(s.c),
      text: "class" + (s.room ? ", " + toAscii(s.room) : ""),
      key: "", // a lecture is not a deliverable and has nothing to mark done
    });
  }
  return rows;
}

/** Every meeting that touches one local day. All-day entries carry day keys and
    an EXCLUSIVE end, so `s <= day < e`; timed ones are instants and are placed
    by the local day their START falls on. */
function meetingsOn(compact, dayKey, tz) {
  const out = [];
  for (const m of Array.isArray(compact.meetings) ? compact.meetings : []) {
    if (!m || typeof m !== "object" || typeof m.s !== "string") continue;
    if (m.ad === true) {
      // `e` is EXCLUSIVE, so a missing one is the NEXT day, never the same one:
      // `s <= day < s` is an empty span and the meeting would silently vanish.
      const end = typeof m.e === "string" && m.e ? m.e : addDays(m.s, 1);
      if (m.s <= dayKey && dayKey < end) out.push({ m, allDay: true, at: -1 });
      continue;
    }
    if (localDayKey(m.s, tz) !== dayKey) continue;
    out.push({ m, allDay: false, at: localMinuteOfDay(m.s, tz) ?? 0 });
  }
  return out;
}

function meetingRow(entry, tz, prefix) {
  const { m, allDay, at } = entry;
  let time = "all day";
  if (!allDay) {
    // A MISSING end is unknown, not midnight. Reading `null` as the last minute
    // of the day would print "14:00-23:59" over an evening nobody had booked - a
    // confident lie is worse than an honest half-answer, so an endless meeting
    // shows its start alone.
    const end = m.e === null || m.e === undefined || m.e === ""
      ? null
      : localDayKey(m.e, tz) === localDayKey(m.s, tz)
        ? localMinuteOfDay(m.e, tz)
        : LAST_MINUTE;
    time = end === null || end < at ? clockOf(at) : `${clockOf(at)}-${clockOf(end)}`;
  }
  return {
    order: allDay ? 0 : 1,
    at,
    time,
    label: toAscii(m.lbl || m.feed),
    text: prefix + toAscii(m.t || "(untitled)") + (m.loc ? " (" + toAscii(m.loc) + ")" : ""),
    key: "", // a meeting is a commitment, not a deliverable: nothing to mark
  };
}

const DUE_WHEN_W = 19;
const DUE_COURSE_W = 8;
const DUE_PREFIX_W = 2 + DUE_WHEN_W + 1 + DUE_COURSE_W + 1;
const NOT_CONFIRMED = "  (not confirmed)";
const DUE_TITLE_MIN = 40;
/* Below this the title has stopped being a title, so the "(not confirmed)"
   marker gives way before the key does - the key is the only part of the row
   the phone can act on. */
const TITLE_FLOOR = 12;

function deadlineLine(item, tz, withMark) {
  const key = keyOf(item, DUE_PREFIX_W);
  let mark = withMark && item.s !== true ? NOT_CONFIRMED : "";
  let room = MAX_COLS - DUE_PREFIX_W - mark.length - key.length;
  if (mark && room < TITLE_FLOOR) {
    mark = "";
    room = MAX_COLS - DUE_PREFIX_W - key.length;
  }
  room = Math.max(room, 0);
  const title = mark ? pad(clip(item.t, room), Math.min(DUE_TITLE_MIN, room)) : clip(item.t, room);
  return (
    "  " + pad(clip(dueStamp(item.d, tz), DUE_WHEN_W), DUE_WHEN_W) +
    " " + pad(clip(item.c, DUE_COURSE_W), DUE_COURSE_W) +
    " " + title + mark + key
  ).replace(/ +$/, "");
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

function section(title, rows, cap) {
  const out = [title];
  if (!rows.length) return out.concat("  (none)");
  for (const line of rows.slice(0, cap)) out.push(line);
  if (rows.length > cap) out.push(`  ... and ${rows.length - cap} more`);
  return out;
}

/**
 * The whole brief block, opening marker to closing marker, as one string with
 * no trailing newline. PURE.
 *
 * @param {object} compact the payload object the envelope carries
 * @param {Date|string|number} now the instant this run is planning against
 * @param {string} tz the payload's timezone
 * @param {{title?: string}} [opts] `title` names the agenda in the header line;
 *        it comes from `config.title` and defaults to a generic word, because
 *        nothing on the wire may carry this project's name.
 */
export function renderBrief(compact, now, tz, opts = {}) {
  if (!compact || typeof compact !== "object" || Array.isArray(compact)) {
    throw new TypeError("renderBrief: compact payload object required");
  }
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new RangeError(`renderBrief: unreadable now: ${String(now)}`);
  const zone = typeof tz === "string" && tz.trim() ? tz : (typeof compact.tz === "string" && compact.tz) || "UTC";
  const title = toAscii(opts.title) || DEFAULT_TITLE;

  const todayKey = localDayKey(at, zone);
  const tomorrowKey = addDays(todayKey, 1);
  const closed = closedKeys(compact.done);
  const items = (Array.isArray(compact.items) ? compact.items : []).filter((i) => isOpen(i, closed));

  // TODAY'S PLAN - the study the planner planned, the classes the user attends
  // and the meetings they accepted, in one column, in the order they meet them.
  const plan = [
    ...focusRows(compact, todayKey, items, zone),
    ...classRows(compact, todayKey),
    ...meetingsOn(compact, todayKey, zone).map((e) => meetingRow(e, zone, "MEETING ")),
  ]
    .sort(byStart)
    .map(planLine);

  const nowMs = at.getTime();
  const horizon = nowMs + DUE_WINDOW_HOURS * 3600000;
  const dated = items
    .map((i) => ({ i, ms: Date.parse(i.d) }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms || byCode(String(a.i.k), String(b.i.k)));

  const due = dated.filter((x) => x.ms >= nowMs && x.ms <= horizon).map((x) => deadlineLine(x.i, zone, true));
  // Oldest first: the thing that has been rotting longest is the thing to say
  // first, and `dated` is already ascending by due date.
  const overdue = dated.filter((x) => x.ms < nowMs).map((x) => deadlineLine(x.i, zone, false));

  const tomorrow = meetingsOn(compact, tomorrowKey, zone)
    .map((e) => meetingRow(e, zone, ""))
    .sort(byStart)
    .map(planLine);

  const focusToday = (Array.isArray(compact.focus) ? compact.focus : []).find((d) => d && d.d === todayKey);
  const note = toAscii(focusToday?.note);

  // Through toAscii like every other field: `scrapedAt` is pipeline-generated
  // today, but "the brief is pure ASCII" is a promise the Doc round trip and the
  // phone both rest on, and an interpolated string is exactly how such a promise
  // stops being true without anyone noticing. A plain slice, not `clip`: an ISO
  // instant cut to its minute is not an elision and must not grow a "...".
  const scrapedAt = toAscii(compact.scrapedAt).slice(0, 16);
  const scraped = scrapedAt ? ` (scraped ${scrapedAt}Z)` : "";

  const lines = [
    OPEN_MARK,
    `${title} brief - ${stampOf(at, zone)}${scraped}`,
    ...section("TODAY'S PLAN", plan, PLAN_CAP),
    ...section("DUE IN 48H", due, DUE_CAP),
    ...section("OVERDUE", overdue, OVERDUE_CAP),
    ...section("MEETINGS TOMORROW", tomorrow, MEETINGS_CAP),
    ...(note ? [`NOTE  ${note}`] : []),
  ].map(finishLine); // the one choke point: ASCII in, <= MAX_COLS out, padding kept

  // The closing marker is never the line that gets dropped: it is what tells the
  // phone it has the whole brief, so it is reserved out of the budget. The caps
  // above already guarantee `lines` cannot reach that reservation (see
  // briefBudget) - this slice is the belt behind the braces, not the mechanism.
  const body = lines.slice(0, MAX_LINES - 1);
  // CLOSE_MARK is concatenated AFTER the finishLine pass, deliberately: it is a
  // short ASCII literal, so there is nothing to clean or clamp, and it must
  // reach the phone whatever happened above it.
  return body.concat(CLOSE_MARK).join("\n");
}

export default renderBrief;
