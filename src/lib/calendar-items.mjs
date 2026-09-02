// calendar-items.mjs - what every calendar sink needs before it writes anything.
//
// WHY THIS IS A LIBRARY AND NOT A COPY IN EACH SINK
//
// There are two calendar sinks - Outlook on Windows, an ICS file everywhere
// else - and a third will exist the day somebody wires up CalDAV. All of them
// answer the same four questions before they touch a calendar: which rows in
// the snapshot are real items, which of those are still worth a reminder, how
// do several rows for one deadline collapse into one event, and how long before
// the deadline should the alarm fire.
//
// Those answers must be IDENTICAL across sinks. A user who switches from
// Outlook to ICS, or runs both, must not get two different sets of reminders
// out of one snapshot - and the moment the logic is copied it starts drifting,
// quietly, in the direction of whichever sink somebody edited last.
//
// Everything here is pure except `loadCalendarItems`, which reads two JSON
// files and returns what it found. Nothing here writes anything, and nothing
// here knows what a calendar is.
import { existsSync, readFileSync } from "node:fs";
import { itemKey, normTitle } from "../merge.mjs";

/** Minutes before the start at which a sink should raise its reminder. */
export const REMINDER_MINUTES = Object.freeze({
  exam: 1440,
  quiz: 180,
  homework: 360,
  project: 360,
  lab: 360,
  email: 180,
  task: 360,
  other: 360,
  default: 360,
});

/** Length of the calendar block. Deadline items END at the due time; exams START at it. */
export const DURATION_MINUTES = Object.freeze({
  exam: 30,
  quiz: 20,
  homework: 30,
  project: 30,
  lab: 30,
  email: 15,
  task: 15,
  other: 15,
  default: 15,
});

export const EXAM_PREP_LEAD_MS = 72 * 3600 * 1000; // second, earlier nudge for exams
export const EXAM_PREP_DURATION = 30;
export const EXAM_PREP_REMINDER = 60;

export function minutesFor(table, type) {
  return table[type] ?? table.default;
}

/**
 * Strip anything outside printable ASCII.
 *
 * Both sinks need this and for the same reason: one crosses a PowerShell/COM
 * bridge, the other writes a file that ancient calendar clients still parse a
 * byte at a time. A curly quote in an assignment title has broken both.
 */
export function ascii(s) {
  return String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e\n]/g, "")
    .trim();
}

// Intl formatters are expensive to build and the timezone comes from config, so
// they are cached per zone rather than created at module load.
const LABEL_FMTS = new Map();
const DATE_FMTS = new Map();

function labelFmt(tz) {
  if (!LABEL_FMTS.has(tz)) {
    LABEL_FMTS.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      }),
    );
  }
  return LABEL_FMTS.get(tz);
}

function dateFmt(tz) {
  if (!DATE_FMTS.has(tz)) {
    DATE_FMTS.set(
      tz,
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
    );
  }
  return DATE_FMTS.get(tz);
}

/** "Mon, Sep 14, 11:59 PM EDT" - the zone abbreviation comes from the zone. */
export function localLabel(date, tz) {
  return ascii(labelFmt(tz).format(date));
}

/** "2026-09-14" in the agenda's timezone. */
export function localDate(date, tz) {
  return dateFmt(tz).format(date);
}

/** JSON with a BOM tolerated - some editors add one and it is not the user's fault. */
export function readJson(file) {
  const raw = readFileSync(file, "utf8");
  // A byte-order mark ahead of the first brace is not the user's fault and
  // must not be the difference between a calendar that syncs and one that does not.
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

/**
 * Accepts both the v1 snapshot shape (data/latest.json: courseId/course/title/
 * due/type/submitted/approx/sources/url) and the payload Item shape
 * (data/outlook-items.json: cid/c/t/d/ty/s/a/src/desc/u).
 * Returns null for anything unusable (never throws on bad data).
 */
export function normalizeItem(raw, origin, warnings) {
  if (!raw || typeof raw !== "object") {
    warnings.push(`${origin}: skipped non-object entry`);
    return null;
  }
  const title = ascii(raw.t ?? raw.title ?? "");
  const dueRaw = raw.d ?? raw.due ?? null;
  const course = ascii(raw.c ?? raw.course ?? "Other") || "Other";
  const courseId = Number(raw.cid ?? raw.courseId ?? 0) || 0;
  const type = ascii(raw.ty ?? raw.type ?? "other").toLowerCase() || "other";
  const submitted = raw.s !== undefined ? raw.s : (raw.submitted ?? null);
  const approx = Boolean(raw.a ?? raw.approx ?? false);
  const sources = Array.isArray(raw.src ?? raw.sources) ? (raw.src ?? raw.sources) : [];
  const desc = ascii(raw.desc ?? "");
  const url = ascii(raw.u ?? raw.url ?? "");

  if (!title) {
    warnings.push(`${origin}: skipped item with no title`);
    return null;
  }
  if (!dueRaw) {
    warnings.push(`${origin}: skipped "${title}" (no due date)`);
    return null;
  }
  const due = new Date(dueRaw);
  if (Number.isNaN(due.getTime())) {
    warnings.push(`${origin}: skipped "${title}" (unparseable due "${dueRaw}")`);
    return null;
  }
  return {
    key: itemKey({ courseId, type, title }),
    norm: normTitle(title),
    courseId,
    course,
    title,
    type,
    due,
    dueIso: due.toISOString(),
    submitted,
    approx,
    sources: sources.map((s) => ascii(s)).filter(Boolean),
    desc,
    url,
    origin,
  };
}

/**
 * Every item a calendar sink may consider: the merged snapshot, plus whatever
 * an agent lifted out of mail. A missing snapshot is a hard failure (there is
 * nothing to sync); a missing or unreadable mail cache is one warning.
 */
export function loadCalendarItems({ items: itemsPath, outlookItems: outlookPath }, warnings) {
  const all = [];
  if (!existsSync(itemsPath)) throw new Error(`items file not found: ${itemsPath}`);
  const snap = readJson(itemsPath);
  const snapItems = Array.isArray(snap) ? snap : (snap.items ?? []);
  for (const raw of snapItems) {
    const item = normalizeItem(raw, "latest", warnings);
    if (item) all.push(item);
  }
  let outlookCount = 0;
  if (outlookPath && existsSync(outlookPath)) {
    try {
      const doc = readJson(outlookPath);
      const list = Array.isArray(doc) ? doc : (doc.items ?? []);
      for (const raw of list) {
        const item = normalizeItem(raw, "outlook", warnings);
        if (item) {
          all.push(item);
          outlookCount += 1;
        }
      }
    } catch (err) {
      warnings.push(`outlook-items.json unreadable, ignored: ${err.message}`);
    }
  }
  return { items: all, snapshotCount: snapItems.length, outlookCount };
}

/** Future, inside the horizon, not submitted, not from a skipped course. */
export function isCandidate(item, now, horizon, settings) {
  if (settings.skipCodes?.has(item.course) || settings.skipIds?.has(item.courseId)) return false;
  if (item.submitted === true) return false;
  if (item.due <= now) return false;
  if (item.due > horizon) return false;
  return true;
}

/**
 * The scraper can emit several rows for one itemKey with different due dates
 * (D2L "opens" vs "closes" entries, moved deadlines). One item = one event, so
 * collapse to the EARLIEST due: being nudged early is cheap, being nudged late
 * is not. Ties break toward the most-corroborated (most sources), exact row.
 */
export function collapse(items, notes) {
  const groups = new Map();
  for (const item of items) {
    const list = groups.get(item.key);
    if (list) list.push(item);
    else groups.set(item.key, [item]);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const sorted = [...list].sort(
      (a, b) => a.due - b.due || b.sources.length - a.sources.length || Number(a.approx) - Number(b.approx),
    );
    const winner = { ...sorted[0], altDues: sorted.slice(1).map((i) => i.dueIso) };
    notes.push(
      `collapsed ${list.length} rows for ${key} ("${winner.norm}") -> ${winner.dueIso}` +
        ` (dropped ${sorted.slice(1).map((i) => i.dueIso).join(", ")})`,
    );
    out.push(winner);
  }
  return out.sort((a, b) => a.due - b.due);
}
