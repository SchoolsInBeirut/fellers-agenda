// gcal-normalize.mjs - the PURE half of the inbound calendar route.
//
// Split out of `gcal-ingest.mjs` because that file would otherwise carry both
// the CLI and the whole contract. The division is the useful one rather than an
// arbitrary cut: everything here is a total function of its arguments - no
// filesystem, no clock, no argv, no console - so it is tested by calling it,
// and `gcal-ingest.mjs` is left holding only argument parsing, file I/O and
// exit codes.
//
// WHAT THIS IS FOR
//
// `src/connectors/calendar-ics.mjs` is a SINK: it writes the agenda's deadlines
// out as a calendar file. This is the other direction. The user has a real
// calendar somewhere - meetings, appointments, an all-day conference - and the
// planner needs to know about it, because an hour that is already spoken for is
// not an hour of study. Those events arrive as `payload.meetings[]`, are drawn
// on the page, and are busy time in `src/focus-engine.mjs`.
//
// The pipeline has no credentials for anybody's calendar and never will. The
// bytes are fetched by the AGENT, through whatever calendar connector the user
// has authorized in their own Claude account, and saved verbatim to a file.
// This module then decides what they mean. **The agent copies bytes; the script
// decides.** Nothing here can reach the network, so nothing here can write to
// anyone's calendar even if it were asked to.
//
// WHAT LIVES HERE
//
//   ids          `decodeGoogleUid`, `uidOfApiEvent` - recovering the original
//                iCalendar UID from a provider's encoded event id
//   fields       `record`, `ownEventRule` - one output record, and the rule
//                that says an event is one the agenda itself planted
//   time         `instantOf`, `parsePoint` - an ISO string to an instant,
//                resolving an offset-less one in the DECLARED zone and never in
//                the machine's
//   windowing    `windowBounds`, `inWindowExact`
//   normalizers  `normalizeApi`, `normalizeSimple`, `collate`
//
// SECRET HYGIENE. `attendees`, `creator`, `organizer` and `conferenceData` are
// never read, so they can never reach the payload, the page, or a Drive
// document. A warning names an event by eight characters of its id and nothing
// else.
import { civilOf, dayKeyOf, dayNumOfKey, flattenText, isValidZone, localToUtc } from "../lib/civil-time.mjs";

/** DESCRIPTION is trimmed to this many characters. The payload has a budget. */
export const DESC_MAX = 300;
/** A timed event with no usable end runs this long. */
export const DEFAULT_TIMED_MINUTES = 60;
/** How many events one document may carry. */
export const EVENT_CAP = 200;
/** The window this route covers, in local days either side of today. */
export const WINDOW_BACK_DAYS = 1;
export const WINDOW_FORWARD_DAYS = 21;
/** A boundary guard. A page is 250 events, so this is pure paranoia. */
export const MAX_INPUT_EVENTS = 5000;

/**
 * The default loop guards.
 *
 * If the ICS sink is on, the user's calendar already contains this agenda's own
 * deadlines - and importing them back would draw every deadline twice and let
 * the planner refuse to plan around a block it invented. Two INDEPENDENT rules,
 * because no provider preserves both reliably:
 *
 *   uid          `calendar-ics.mjs` writes `<hash>-<role>@<ns>.agenda.local`,
 *                and an importer keeps the original UID inside its own event
 *                id. This one is PROOF.
 *   description  the literal every sink event's body ends with. This one is a
 *                HEURISTIC - it can hit a real meeting whose body quotes an
 *                agenda invite - so a description-only skip is counted and
 *                warned about rather than silent.
 *
 * `gcal-ingest.mjs` narrows the uid suffix to this agenda's own namespace.
 */
export const DEFAULT_SKIP_UID_SUFFIX = ".agenda.local";
export const DEFAULT_SKIP_DESC_MARKER = "Auto-created by the agenda.";

export const DEFAULT_FEED_ID = "calendar";

const MINUTE_MS = 60000;
/** RFC 4648 base32 with the EXTENDED HEX alphabet, lowercase. */
const B32HEX = "0123456789abcdefghijklmnopqrstuv";

/** A non-null, non-array object. The type gate at every boundary. PURE. */
export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ------------------------------------------------------------- provider ids

/** base32hex text -> the bytes it encodes, or null when it is not base32hex. PURE. */
function b32hexBytes(text) {
  if (!text) return null;
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const idx = B32HEX.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return out;
}

/**
 * A provider event id -> the iCalendar UID it came from.
 *
 * An event imported from an `.ics` file is given `_<base32hex(UID)>` for the
 * series and `_<base32hex(UID)>_<instance stamp>` for each instance, so the
 * original `...@<ns>.agenda.local` UID is still in there and the uid rule can
 * see it. An ordinary id (no leading underscore) IS the uid. Anything that does
 * not decode to clean text is kept verbatim rather than guessed at. PURE.
 */
export function decodeGoogleUid(id) {
  const raw = String(id ?? "");
  if (!raw.startsWith("_")) return raw;
  const body = raw.slice(1);
  const cut = body.indexOf("_");
  const bytes = b32hexBytes(cut < 0 ? body : body.slice(0, cut));
  if (!bytes || !bytes.length) return raw;
  const text = Buffer.from(bytes).toString("utf8");
  // A wrong guess decodes to control characters or U+FFFD. Trust only clean text.
  if (!text || /[\u0000-\u001f\u007f\ufffd]/.test(text)) return raw;
  return text;
}

/** The uid an event is keyed by: iCalUID, else the decoded series id, else the decoded id. PURE. */
export function uidOfApiEvent(event) {
  const ical = typeof event.iCalUID === "string" ? event.iCalUID.trim() : "";
  if (ical) return ical;
  const series = typeof event.recurringEventId === "string" ? event.recurringEventId.trim() : "";
  if (series) return decodeGoogleUid(series);
  return decodeGoogleUid(typeof event.id === "string" ? event.id.trim() : "");
}

/** How an event is named in a warning: 8 characters of its id, never its content. PURE. */
const idTag = (id) => String(id ?? "(no id)").slice(0, 8);

// ------------------------------------------------------------ field mapping

/** DESCRIPTION as the payload wants it: one line, at most DESC_MAX chars. PURE. */
const describe = (value) => {
  const flat = flattenText(value);
  return flat ? flat.slice(0, DESC_MAX) : null;
};

/** One output record, always in the same key order, from either input path. PURE. */
const record = ({ feedId, label, uid, s, e, ad, t, loc, desc, free, url }) => ({
  k: `${feedId}|${uid}|${s}`,
  feed: feedId,
  lbl: label,
  t,
  s,
  e,
  ad,
  loc,
  desc,
  free,
  url,
});

/** The five text/flag fields, identical on both paths. PURE. */
const fieldsOf = (event) => ({
  t: flattenText(event.summary) ?? "(untitled)",
  loc: flattenText(event.location),
  desc: describe(event.description),
  free: String(event.transparency ?? "").toLowerCase() === "transparent",
  url: typeof event.htmlLink === "string" && event.htmlLink.trim() ? event.htmlLink.trim() : null,
});

/**
 * WHICH loop guard marks an event as one of ours - `"uid"`, `"description"` or
 * `null`. The caller needs to know which, because only one of them is proof.
 * PURE.
 */
export function ownEventRule(event, uid, guards = {}) {
  const uidSuffix = typeof guards.skipUidSuffix === "string" ? guards.skipUidSuffix : DEFAULT_SKIP_UID_SUFFIX;
  const marker = typeof guards.skipDescriptionMarker === "string" ? guards.skipDescriptionMarker : DEFAULT_SKIP_DESC_MARKER;
  if (uidSuffix && uid && String(uid).endsWith(uidSuffix)) return "uid";
  if (marker && typeof event?.description === "string" && event.description.includes(marker)) return "description";
  return null;
}

/** Is this one of ours? Either rule alone is enough. PURE. */
export const isOwnEvent = (event, uid, guards) => ownEventRule(event, uid, guards) !== null;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;
/** A trailing `Z` or `+HH:MM` / `-HHMM`: the string names its own instant. */
const OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
/** An IANA zone id, conservatively - shape first, then meaning. */
const ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** A zone safe to compute with, or null. PURE. */
function usableZone(name) {
  const zone = typeof name === "string" ? name.trim() : "";
  return zone && ZONE_RE.test(zone) && isValidZone(zone) ? zone : null;
}

/** The civil fields of an ISO date-time, or null when it is not one. PURE. */
function civilFieldsOf(text) {
  const m = WALL_RE.exec(text);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 };
}

/**
 * An ISO date-time string -> the instant it names.
 *
 * With a `Z` or an offset the string names its own instant and `Date.parse` is
 * right. WITHOUT one, the ECMAScript spec says local time - and "local" there
 * means the MACHINE's zone, a setting this pipeline must never depend on. So an
 * offset-less time is resolved in the zone the DATA declares, falling back to
 * the pipeline zone, and never to the machine's. PURE.
 */
export function instantOf(raw, zone) {
  const text = String(raw ?? "").trim();
  if (!text) return NaN;
  if (OFFSET_RE.test(text)) return Date.parse(text);
  const civil = civilFieldsOf(text);
  // Not a wall clock at all - let Date.parse be the one to reject it.
  if (!civil) return Date.parse(text);
  const tz = usableZone(zone) ?? "UTC";
  return localToUtc(civil, tz);
}

/**
 * A `{dateTime, timeZone}` / `{date}` point -> `{allDay, day}` or
 * `{allDay:false, ms, zone}`, or null when it is not a date at all.
 *
 * `ms` is the ONE truth about when this is, and it is the only one: an event's
 * wall clock is never carried alongside it, so a record and anything computed
 * from it cannot disagree when the offset and the declared zone differ.
 *
 * `zone` is the zone that RESOLVED an offset-less string - the event's own
 * `timeZone` when it declared one, the pipeline zone when it did not, and null
 * when the string named its own offset and no zone was needed. PURE.
 */
export function parsePoint(part, fallbackTz) {
  if (!isPlainObject(part)) return null;
  if (typeof part.date === "string" && DATE_ONLY_RE.test(part.date.trim())) {
    const day = part.date.trim();
    return dayNumOfKey(day) === null ? null : { allDay: true, day };
  }
  const raw = typeof part.dateTime === "string" ? part.dateTime.trim() : "";
  if (!raw) return null;
  const declared = usableZone(part.timeZone);
  const ms = instantOf(raw, declared ?? fallbackTz);
  if (!Number.isFinite(ms)) return null;
  const zone = declared ?? (OFFSET_RE.test(raw) ? null : usableZone(fallbackTz));
  return { allDay: false, ms, zone };
}

// ---------------------------------------------------------------- windowing

/** The window as day numbers and the instants that bound it, or null. PURE. */
export function windowBounds(window, tz) {
  const fromDay = dayNumOfKey(window?.from);
  const toDay = dayNumOfKey(window?.to);
  if (fromDay === null || toDay === null) return null;
  const zone = usableZone(tz) ?? "UTC";
  return {
    fromDay,
    toDay,
    startMs: localToUtc({ ...civilOf(fromDay) }, zone),
    endMs: localToUtc({ ...civilOf(toDay + 1) }, zone),
  };
}

/** A timed record is kept when it OVERLAPS the window; an all-day one when any day falls in. PURE. */
export function inWindowExact(rec, bounds) {
  if (!bounds || !rec) return false;
  if (rec.ad) {
    const s = dayNumOfKey(rec.s);
    const e = dayNumOfKey(rec.e);
    if (s === null || e === null) return false;
    return s <= bounds.toDay && e > bounds.fromDay;
  }
  const s = Date.parse(rec.s);
  const e = Date.parse(rec.e);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return s < bounds.endMs && Math.max(e, s + 1) > bounds.startMs;
}

// ------------------------------------------------------------- normalization

/** A collector that keeps warnings unique and in the order they happened. */
function warnings() {
  const list = [];
  return {
    list,
    warn: (text) => {
      if (!list.includes(text)) list.push(text);
    },
  };
}

function boundedEntries(entries, warn) {
  const all = Array.isArray(entries) ? entries : [];
  if (all.length <= MAX_INPUT_EVENTS) return all;
  warn(`ignored ${all.length - MAX_INPUT_EVENTS} entr(ies) over the ${MAX_INPUT_EVENTS}-entry input limit`);
  return all.slice(0, MAX_INPUT_EVENTS);
}

/**
 * The half both normalizers share: window bounds, the entry loop, the
 * non-object warning, the own-event accounting and the window filter. Only the
 * per-entry mapping differs, so only that is passed in.
 *
 * `mapEntry(entry, ctx)` returns `{own}` when the entry is one of ours,
 * `{records}` when it is a meeting, or null when it was dropped - having warned
 * for itself if that deserved a trace.
 *
 * @returns {{events: Array, warnings: string[], skippedOwn: number}}
 */
function normalizeWith(rawEvents, context, mapEntry) {
  const { feedId = DEFAULT_FEED_ID, label = "", window, tz = "UTC", guards = {} } = context ?? {};
  const { list, warn } = warnings();
  const bounds = windowBounds(window, tz);
  if (!bounds) return { events: [], warnings: [`bad window ${window?.from}..${window?.to}`], skippedOwn: 0 };

  const out = [];
  let skippedOwn = 0;
  let descOnly = 0;
  const entries = boundedEntries(rawEvents, warn);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isPlainObject(entry)) {
      warn(`entry ${i} is not an event object`);
      continue;
    }
    const mapped = mapEntry(entry, { index: i, feedId, label, window, tz, guards, warn });
    if (!mapped) continue;
    if (mapped.own) {
      skippedOwn++;
      // A DESCRIPTION-only skip is the one that can be WRONG: a real meeting
      // whose body quotes an agenda invite would vanish from the grid and the
      // planner would put study straight over it. Still dropped - the rule
      // earns its keep on re-imported events - but no longer silent.
      if (mapped.own === "description") descOnly++;
      continue;
    }
    for (const rec of mapped.records ?? []) {
      if (inWindowExact(rec, bounds)) out.push(rec);
    }
  }
  if (descOnly > 0) warn(`${descOnly} event(s) skipped by description marker only (uid did not match)`);
  return { events: out, warnings: list, skippedOwn };
}

/** All-day end: the provider's EXCLUSIVE end date, or the day after the start. PURE. */
function allDayEnd(start, end) {
  const startDay = dayNumOfKey(start.day);
  if (end && end.allDay) {
    const endDay = dayNumOfKey(end.day);
    if (endDay !== null && endDay > startDay) return end.day;
  }
  return dayKeyOf(startDay + 1);
}

/** Timed end: the provider's end, or the default length when missing or backwards. PURE. */
function timedEnd(start, end) {
  const ms =
    end && !end.allDay && Number.isFinite(end.ms) && end.ms > start.ms
      ? end.ms
      : start.ms + DEFAULT_TIMED_MINUTES * MINUTE_MS;
  return new Date(ms).toISOString();
}

/**
 * One calendar-API event -> what `normalizeWith` needs.
 *
 * A RECURRING MASTER - an entry that still carries `recurrence[]` and is not
 * itself an instance - is DROPPED, loudly. Every connector this route supports
 * returns single instances; a master reaching here means the fetch step asked
 * for something else. Expanding an RRULE correctly across daylight-saving
 * boundaries is a parser this repo deliberately does not carry (see
 * `docs/EXTENDING.md`), and a half-right expansion would put phantom meetings
 * on the grid - which is worse than a warning that says exactly what happened.
 */
function mapApiEntry(event, { feedId, label, tz, guards, warn }) {
  if (String(event.status ?? "").toLowerCase() === "cancelled") return null;
  const uid = uidOfApiEvent(event);
  const own = ownEventRule(event, uid, guards);
  if (own) return { own };
  const isMaster =
    Array.isArray(event.recurrence) && event.recurrence.length > 0 && !event.recurringEventId && !event.originalStartTime;
  if (isMaster) {
    warn(
      `event ${idTag(event.id)} is a recurring master and was skipped - ` +
        "ask the calendar tool for single instances (expanded occurrences)",
    );
    return null;
  }
  const start = parsePoint(event.start, tz);
  if (!start) {
    warn(`event ${idTag(event.id)} has no usable start`);
    return null;
  }
  const end = parsePoint(event.end, tz);
  const fields = fieldsOf(event);
  const rec = start.allDay
    ? record({ feedId, label, uid, s: start.day, e: allDayEnd(start, end), ad: true, ...fields })
    : record({ feedId, label, uid, s: new Date(start.ms).toISOString(), e: timedEnd(start, end), ad: false, ...fields });
  return { records: [rec] };
}

/**
 * Calendar-API events -> output records.
 *
 * `attendees` IS NOT READ. Nothing in the payload, the page or the planner
 * wants an attendee list, and copying one would put every colleague's address
 * into a Drive document. Same for `creator`, `organizer` and `conferenceData`.
 *
 * @returns {{events: Array, warnings: string[], skippedOwn: number}} PURE.
 */
export function normalizeApi(rawEvents, context = {}) {
  return normalizeWith(rawEvents, context, mapApiEntry);
}

/** One hand-transcribed entry -> what `normalizeWith` needs. PURE except `warn`. */
function mapSimpleEntry(event, { index, feedId, label, tz, guards, warn }) {
  const uid = typeof event.id === "string" ? event.id.trim() : "";
  if (!uid) {
    warn(`entry ${index} has no id`);
    return null;
  }
  const own = ownEventRule(event, uid, guards);
  if (own) return { own };
  const fields = {
    t: flattenText(event.title) ?? "(untitled)",
    loc: flattenText(event.location),
    desc: describe(event.description),
    free: event.free === true,
    url: typeof event.url === "string" && event.url.trim() ? event.url.trim() : null,
  };
  const startText = String(event.start ?? "").trim();
  const endText = String(event.end ?? "").trim();
  const unreadable = () => {
    warn(`entry ${index} (${idTag(uid)}) has an unreadable start`);
    return null;
  };
  if (event.allDay === true || DATE_ONLY_RE.test(startText)) {
    const startDay = dayNumOfKey(startText.slice(0, 10));
    if (startDay === null) return unreadable();
    const endDay = dayNumOfKey(endText.slice(0, 10));
    const e = dayKeyOf(endDay !== null && endDay > startDay ? endDay : startDay + 1);
    return { records: [record({ feedId, label, uid, s: dayKeyOf(startDay), e, ad: true, ...fields })] };
  }
  // An offset-less time here means PIPELINE-zone local, never machine-zone.
  const startMs = instantOf(startText, tz);
  if (!Number.isFinite(startMs)) return unreadable();
  const endMs = instantOf(endText, tz);
  const e = Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + DEFAULT_TIMED_MINUTES * MINUTE_MS;
  return {
    records: [
      record({ feedId, label, uid, s: new Date(startMs).toISOString(), e: new Date(e).toISOString(), ad: false, ...fields }),
    ],
  };
}

/**
 * The hand-transcribed shape `{id, title, start, end, allDay?, location?,
 * free?, url?}` -> the same records. `start`/`end` are ISO instants or
 * `YYYY-MM-DD`; a date-only start means all-day whether or not `allDay` was
 * set, and an ISO time with no offset means PIPELINE-zone local.
 *
 * @returns {{events: Array, warnings: string[], skippedOwn: number}} PURE.
 */
export function normalizeSimple(rawEvents, context = {}) {
  return normalizeWith(rawEvents, context, mapSimpleEntry);
}

// ------------------------------------------------------------------ collate

/** Keep the first `cap` records by start time; report what fell off. PURE. */
export function capEvents(events, cap = EVENT_CAP) {
  const sorted = [...events].sort(
    (a, b) => String(a.s).localeCompare(String(b.s)) || String(a.k).localeCompare(String(b.k)),
  );
  return { events: sorted.slice(0, cap), dropped: sorted.slice(cap) };
}

/** Dedupe by key (a duplicate keeps the LAST), sort, cap, and say what fell off. PURE. */
export function collate(records, cap = EVENT_CAP) {
  const byKey = new Map();
  for (const rec of records) byKey.set(rec.k, rec);
  const { events, dropped } = capEvents([...byKey.values()], cap);
  return { events, warnings: dropped.length ? [`dropped ${dropped.length} event(s) over the ${cap}-event cap`] : [] };
}
