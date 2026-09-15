// ics-parse.mjs - the RFC 5545 subset a real calendar exporter actually writes,
// parsed and expanded into flat event INSTANCES. PURE: text in, plain objects
// out. No I/O, no network, no clock, no config. `src/connectors/gcal-sync.mjs`
// owns everything else, and `ics-rrule.mjs` owns the recurrence arithmetic this
// file drives.
//
// It lives apart from the connector for one reason: parsing is the part that has
// to be tested to death - a dozen separate rules, each of which is a SILENT
// wrong answer if it is missed - and a pure module is the only kind of thing a
// test can hammer without a network or a temp directory.
//
// ---------------------------------------------------------------------------
// WHAT IT HANDS BACK, AND WHY THAT SHAPE
//
// Not the finished record. `buildInstances` yields entries in exactly the
// hand-transcribed shape `src/connectors/gcal-normalize.mjs` already normalizes:
//
//   {id, title, start, end, allDay, location, description, free, url}
//
// so route A (an ICS feed URL) and the connector route end up in the SAME
// `normalizeSimple()`, produce byte-identical records, and cannot drift apart
// field by field. Everything downstream of "what does this text say" - the key
// format, the 300-character description trim, the window filter, the event cap -
// is decided once, over there, for both routes.
//
// ---------------------------------------------------------------------------
// WHAT IT HANDLES (every bullet has a test in test/ics-parse.test.mjs)
//
//   - CRLF, LF and lone CR; line unfolding (a continuation starts with space
//     or tab, and the fold character alone is removed)
//   - property parameters, including quoted values containing ';' and ':'
//   - text escapes  \,  \;  \n  \N  \\
//   - VTIMEZONE read for its TZID name only; the IANA name goes to Intl
//   - DTSTART/DTEND as DATE-TIME with TZID, as UTC (trailing Z), as floating
//     (= the declared pipeline zone), and as VALUE=DATE (all-day, DTEND EXCLUSIVE)
//   - DURATION instead of DTEND; neither -> +60 min timed, +1 day all-day
//   - RRULE FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL,
//     BYDAY (plain and ordinal), BYMONTHDAY, BYMONTH, WKST  (see ics-rrule.mjs)
//   - EXDATE (many lines, many values, TZID or DATE form) and RDATE
//   - RECURRENCE-ID overrides (a moved or renamed instance), and cancelling one
//   - STATUS:CANCELLED on a master (the series is gone)
//   - TRANSP:TRANSPARENT -> free:true
//   - SUMMARY / LOCATION / DESCRIPTION / URL, all whitespace-flattened
//   - VTODO, VJOURNAL, VFREEBUSY and VALARM ignored silently
//
// ---------------------------------------------------------------------------
// LOCAL TIME WITHOUT A LIBRARY
//
// `src/lib/civil-time.mjs` turns a wall clock in a named zone into an instant by
// guessing the wall clock IS UTC, asking Intl what that instant looks like in
// the zone, and correcting once. Every instance of a recurring event keeps
// DTSTART's WALL CLOCK and is converted on its own day, which is the only way a
// weekly 13:30 meeting is 17:30Z in October and 18:30Z in November. Anything
// that adds 7 x 86,400,000 ms gets one of those wrong by an hour, twice a year,
// for six months.
//
// ---------------------------------------------------------------------------
// UNTIL IS AN INSTANT FOR A TIMED SERIES, AND A DAY FOR AN ALL-DAY ONE
//
// Exporters write UNTIL as a UTC timestamp derived from the LOCAL end of the
// last day, so for any calendar west of Greenwich its UTC *date* is the day
// AFTER the last real instance. Comparing by calendar day therefore emits one
// phantom meeting - and a phantom meeting becomes phantom busy time in the
// planner, deleting real study hours the day after a series ends. So the day
// comparison bounds the expansion (it is all a day-number expander can do) and
// the INSTANT comparison is applied here, per instance, once the zone has been
// used. An all-day series has no instant to compare and keeps the day rule,
// where UNTIL is inclusive.
import { civilOf, dayKeyOf, dayNumOf, dayNumOfKey, flattenText, isValidZone, localToUtc } from "./civil-time.mjs";
import { MAX_CANDIDATES, expandRuleDetailed, parseRRule } from "./ics-rrule.mjs";

/** A timed event with neither DTEND nor DURATION runs this long. */
export const DEFAULT_TIMED_MINUTES = 60;

const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const IGNORED_COMPONENTS = new Set(["VTODO", "VJOURNAL", "VFREEBUSY", "VALARM"]);
/** Multi-day events are clipped here; a feed claiming more is malformed. */
const MAX_INSTANCE_DAYS = 400;

// ------------------------------------------------------------- line syntax

/**
 * An iCalendar body -> LOGICAL lines. A physical line beginning with a space or
 * a tab continues the one before it (RFC 5545 3.1) and the fold character
 * itself - and nothing else - is removed. CRLF, LF and lone CR are all accepted,
 * because feeds in the wild use all three. PURE.
 */
export function unfoldLines(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r\n|\n|\r/)) {
    if (out.length && (line.startsWith(" ") || line.startsWith("\t"))) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** Split on `sep`, ignoring separators inside double quotes. PURE. */
function splitUnquoted(text, sep) {
  const parts = [];
  let buf = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);
  return parts;
}

/**
 * One logical line -> `{name, params, value}`, or null when it is not a property.
 * Parameter names are upper-cased; a quoted parameter value keeps its content,
 * because it may legally contain ';' and ':'. PURE.
 */
export function parseLine(line) {
  if (typeof line !== "string" || !line) return null;
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) break;
  }
  if (i >= line.length) return null; // no unquoted colon: not a property
  const parts = splitUnquoted(line.slice(0, i), ";");
  const name = (parts[0] ?? "").trim().toUpperCase();
  if (!name) return null;
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim().toUpperCase();
    let v = p.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k) params[k] = v;
  }
  return { name, params, value: line.slice(i + 1) };
}

/** RFC 5545 TEXT unescaping: `\,` `\;` `\n` `\N` `\\`. Anything else keeps its char. PURE. */
export function unescapeText(value) {
  const s = String(value ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      out += s[i];
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) return out + "\\";
    i++;
    if (next === "n" || next === "N") out += "\n";
    else out += next; // covers \, \; \\ and anything unexpected
  }
  return out;
}

// -------------------------------------------------------------- date values

/** An IANA zone id, conservatively - shape first, then meaning. PURE. */
const ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const usableZone = (name) => {
  const zone = typeof name === "string" ? name.trim() : "";
  return zone && ZONE_RE.test(zone) && isValidZone(zone) ? zone : null;
};

/**
 * A DTSTART/DTEND/EXDATE/RDATE/RECURRENCE-ID value -> a normalized point.
 *
 *   all-day  `{allDay:true,  dayNum, day:"YYYY-MM-DD"}`
 *   timed    `{allDay:false, ms, zone, fields, unknownTzid}`
 *
 * `unknownTzid` is the TZID we were given and could not use, so the caller can
 * warn once; the value itself has already fallen back to `fallbackTz`. Returns
 * null when the value is not a date at all. PURE.
 */
export function parseDateValue(value, params = {}, fallbackTz = "UTC") {
  const v = String(value ?? "").trim();
  // An 8-digit value is a DATE whether or not VALUE=DATE was written out: the
  // parameter is the declaration, the shape is the fact, and exporters omit the
  // parameter on EXDATE lines for all-day series.
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return { allDay: true, dayNum: dayNumOf(Number(y), Number(mo), Number(d)), day: `${y}-${mo}-${d}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const fields = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  if (m[7]) return { allDay: false, ms: localToUtc(fields, "UTC"), zone: "UTC", fields, unknownTzid: null };
  const tzid = typeof params.TZID === "string" && params.TZID.trim() ? params.TZID.trim() : null;
  const zone = usableZone(tzid);
  const resolved = zone ?? fallbackTz;
  return { allDay: false, ms: localToUtc(fields, resolved), zone: resolved, fields, unknownTzid: zone ? null : tzid };
}

/** `"PT1H30M"` / `"P1D"` / `"P1W"` -> milliseconds, or null. PURE. */
export function parseDuration(text) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    String(text ?? "")
      .trim()
      .toUpperCase(),
  );
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  if (!w && !d && !h && !mi && !s) return null;
  const ms =
    Number(w ?? 0) * 7 * DAY_MS + Number(d ?? 0) * DAY_MS + Number(h ?? 0) * 3600000 + Number(mi ?? 0) * 60000 + Number(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

/**
 * The UNTIL limit as `{dayNum, ms}`. `dayNum` bounds the day-number expansion;
 * `ms` is non-null only for a DATE-TIME UNTIL and is the comparison that
 * actually decides a timed series (see the header). PURE.
 */
export function untilLimit(rule, zone) {
  if (!rule.until) return null;
  const point = parseDateValue(rule.until, {}, zone);
  if (!point) return null;
  if (point.allDay) return { dayNum: point.dayNum, ms: null };
  return { dayNum: dayNumOf(point.fields.year, point.fields.month, point.fields.day), ms: point.ms };
}

// --------------------------------------------------- VEVENT -> instances

/**
 * An iCalendar body -> VEVENT property lists and the TZID names its VTIMEZONE
 * blocks declare. VTODO/VJOURNAL/VFREEBUSY/VALARM are skipped whole, including
 * anything nested inside them. PURE.
 */
export function parseComponents(text) {
  const vevents = [];
  const tzids = [];
  let event = null;
  let inTimezone = false;
  let ignoreDepth = 0;

  for (const line of unfoldLines(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const comp = p.value.trim().toUpperCase();
      if (ignoreDepth > 0 || IGNORED_COMPONENTS.has(comp)) {
        ignoreDepth++;
        continue;
      }
      if (comp === "VEVENT") event = { props: [] };
      else if (comp === "VTIMEZONE") inTimezone = true;
      continue;
    }
    if (p.name === "END") {
      const comp = p.value.trim().toUpperCase();
      if (ignoreDepth > 0) {
        ignoreDepth--;
        continue;
      }
      if (comp === "VEVENT") {
        if (event) vevents.push(event);
        event = null;
      } else if (comp === "VTIMEZONE") inTimezone = false;
      continue;
    }
    if (ignoreDepth > 0) continue;
    if (inTimezone) {
      if (p.name === "TZID") tzids.push(p.value.trim());
      continue;
    }
    if (event) event.props.push(p);
  }
  return { vevents, tzids };
}

const first = (props, name) => props.find((p) => p.name === name) ?? null;
const all = (props, name) => props.filter((p) => p.name === name);
/** One property, unescaped and flattened to a single line, or null. PURE. */
const textOf = (props, name) => {
  const p = first(props, name);
  return p ? flattenText(unescapeText(p.value)) : null;
};

/** How an event is named in a warning: 8 characters of its UID, never more. PURE. */
const uidTag = (uid) => String(uid ?? "").slice(0, 8);

/** The DTEND / DURATION / default length of one event. PURE. */
function lengthOf(props, start, zone) {
  const dtendProp = first(props, "DTEND");
  const end = dtendProp ? parseDateValue(dtendProp.value, dtendProp.params, zone) : null;
  const durationMs = parseDuration(first(props, "DURATION")?.value);
  if (start.allDay) {
    let days = 1;
    if (end && end.allDay) days = Math.max(1, end.dayNum - start.dayNum);
    else if (durationMs !== null) days = Math.max(1, Math.round(durationMs / DAY_MS));
    return { lengthMs: null, lengthDays: Math.min(days, MAX_INSTANCE_DAYS) };
  }
  let ms = null;
  if (end && !end.allDay) ms = end.ms - start.ms;
  else if (durationMs !== null) ms = durationMs;
  if (ms === null || !Number.isFinite(ms) || ms <= 0) ms = DEFAULT_TIMED_MINUTES * MINUTE_MS;
  return { lengthMs: Math.min(ms, MAX_INSTANCE_DAYS * DAY_MS), lengthDays: null };
}

/**
 * The dated skeleton of one VEVENT: uid, start, length, and the fields every
 * instance inherits. Returns `{error}` instead of throwing. PURE.
 */
function readEvent(props, fallbackTz) {
  const uid = textOf(props, "UID");
  if (!uid) return { error: "VEVENT with no UID" };
  const dtstartProp = first(props, "DTSTART");
  if (!dtstartProp) return { error: `VEVENT ${uidTag(uid)} has no DTSTART` };
  const start = parseDateValue(dtstartProp.value, dtstartProp.params, fallbackTz);
  if (!start) return { error: `VEVENT ${uidTag(uid)} has an unreadable DTSTART` };

  const zone = start.allDay ? fallbackTz : start.zone;
  const { lengthMs, lengthDays } = lengthOf(props, start, zone);
  const recurProp = first(props, "RECURRENCE-ID");
  const recurrenceId = recurProp ? parseDateValue(recurProp.value, recurProp.params, zone) : null;

  return {
    error: null,
    uid,
    start,
    zone,
    lengthMs,
    lengthDays,
    cancelled: (textOf(props, "STATUS") ?? "").toUpperCase() === "CANCELLED",
    free: (textOf(props, "TRANSP") ?? "").toUpperCase() === "TRANSPARENT",
    title: textOf(props, "SUMMARY") ?? "(untitled)",
    loc: textOf(props, "LOCATION"),
    desc: textOf(props, "DESCRIPTION"),
    url: first(props, "URL")?.value.trim() || null,
    rrule: first(props, "RRULE")?.value ?? null,
    exdates: all(props, "EXDATE"),
    rdates: all(props, "RDATE"),
    recurrenceId,
    // RANGE=THISANDFUTURE asks for "this instance and every one after it". The
    // exporters this route sees split the series into two UIDs instead of
    // sending it, so honouring the named instance alone is right for the feeds
    // we have - but SAY SO, because on another exporter the tail of the series
    // would silently keep the old time.
    thisAndFuture: String(recurProp?.params.RANGE ?? "").toUpperCase() === "THISANDFUTURE",
    unknownTzid: start.unknownTzid ?? recurrenceId?.unknownTzid ?? null,
  };
}

/** Every value on a set of EXDATE/RDATE lines, as instance ids. PURE. */
function dateListIds(lines, zone) {
  const ids = [];
  for (const line of lines) {
    for (const raw of String(line.value).split(",")) {
      const point = parseDateValue(raw.trim(), line.params, zone);
      if (!point) continue;
      ids.push(point.allDay ? point.day : new Date(point.ms).toISOString());
    }
  }
  return ids;
}

/** The start point of a record, in the shape `expandMaster` yields. PURE. */
function startOf(rec) {
  return rec.start.allDay
    ? { allDay: true, dayNum: rec.start.dayNum, ms: null, id: rec.start.day }
    : { allDay: false, dayNum: null, ms: rec.start.ms, id: new Date(rec.start.ms).toISOString() };
}

const timeOf = (f) => ({ hour: f.hour, minute: f.minute, second: f.second });

/** An instance id back into a parseable value (`"2026-09-10"` or an ISO instant). PURE. */
const rdateValueOf = (id) =>
  /^\d{4}-\d{2}-\d{2}$/.test(id) ? id.replace(/-/g, "") : id.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** The day numbers an RRULE contributes, plus whether it was truncated. */
function ruleDays(master, civil, fromDay, toDay, warn) {
  const rule = parseRRule(master.rrule);
  if (rule.unsupported.length) {
    warn(`rrule ${uidTag(master.uid)}: unsupported ${rule.unsupported.join(",")} - first instance only`);
    return { dayNums: [dayNumOf(civil.year, civil.month, civil.day)], until: null };
  }
  const until = untilLimit(rule, master.zone);
  const expanded = expandRuleDetailed(rule, civil, { fromDay: fromDay - 1, toDay: toDay + 1, until });
  if (expanded.truncated) {
    warn(`rrule ${uidTag(master.uid)}: hit the ${MAX_CANDIDATES}-candidate bound - instances may be missing`);
  }
  return { dayNums: expanded.days, until };
}

/**
 * Every instance start of one master, as `{allDay, dayNum, ms, id}`. The RRULE
 * is expanded a day either side of the window so an instance that merely
 * OVERLAPS it still shows up; the precise filter runs later, in
 * `gcal-normalize.mjs`. PURE except `warn`.
 */
function expandMaster(master, { fromDay, toDay, warn }) {
  if (!master.rrule && !master.rdates.length) return [startOf(master)];

  const civil = master.start.allDay
    ? civilOf(master.start.dayNum)
    : { year: master.start.fields.year, month: master.start.fields.month, day: master.start.fields.day };

  let dayNums = [dayNumOf(civil.year, civil.month, civil.day)];
  let until = null;
  if (master.rrule) ({ dayNums, until } = ruleDays(master, civil, fromDay, toDay, warn));

  // Every instance keeps DTSTART's WALL CLOCK and is converted in the event's
  // own zone, which is exactly what makes the November instance an hour later in
  // UTC than the October one.
  let out = dayNums.map((n) => {
    if (master.start.allDay) return { allDay: true, dayNum: n, ms: null, id: dayKeyOf(n) };
    const ms = localToUtc({ ...civilOf(n), ...timeOf(master.start.fields) }, master.zone);
    return { allDay: false, dayNum: n, ms, id: new Date(ms).toISOString() };
  });
  // A timed series ends at an INSTANT, not at the end of a UTC day (header).
  if (until && until.ms !== null && !master.start.allDay) out = out.filter((p) => p.ms <= until.ms);

  // RDATE is independent of the rule, so UNTIL does not bound it.
  for (const id of dateListIds(master.rdates, master.zone)) {
    if (out.some((p) => p.id === id)) continue;
    const point = parseDateValue(rdateValueOf(id), {}, master.zone);
    if (!point) continue;
    out.push(
      point.allDay
        ? { allDay: true, dayNum: point.dayNum, ms: null, id: point.day }
        : { allDay: false, dayNum: null, ms: point.ms, id: new Date(point.ms).toISOString() },
    );
  }

  const excluded = new Set(dateListIds(master.exdates, master.zone));
  return out.filter((p) => !excluded.has(p.id)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * One instance -> one entry in the hand-transcribed shape `normalizeSimple()`
 * reads. `start`/`end` are `YYYY-MM-DD` for an all-day event (the end
 * EXCLUSIVE, as RFC 5545 has it) and ISO instants for a timed one, so nothing
 * downstream has to know a zone to read them back. PURE.
 */
function toEntry(source, point) {
  const common = {
    id: source.uid,
    title: source.title,
    location: source.loc,
    description: source.desc,
    free: source.free,
    url: source.url,
  };
  if (point.allDay) {
    return {
      ...common,
      start: dayKeyOf(point.dayNum),
      end: dayKeyOf(point.dayNum + (source.lengthDays ?? 1)),
      allDay: true,
    };
  }
  if (!Number.isFinite(point.ms)) return null;
  const length = source.lengthMs ?? DEFAULT_TIMED_MINUTES * MINUTE_MS;
  return {
    ...common,
    start: new Date(point.ms).toISOString(),
    end: new Date(point.ms + length).toISOString(),
    allDay: false,
  };
}

/**
 * Read every VEVENT and split masters from RECURRENCE-ID overrides, dropping
 * the events this agenda itself put on that calendar on the way through.
 *
 * `ownRule(uid, description)` is the LOOP GUARD, injected rather than
 * implemented: `src/connectors/gcal-normalize.mjs` owns the two rules and both
 * inbound routes ask it the same question. It returns `"uid"` (proof),
 * `"description"` (a heuristic, so it is counted and warned about) or null.
 * PURE except `warn`.
 */
function sortComponents(vevents, { tz, ownRule, warn }) {
  const masters = [];
  const overrides = new Map(); // uid -> Map(instanceId -> record)
  let skippedOwn = 0;
  let descOnly = 0;
  for (const ve of vevents) {
    const rec = readEvent(ve.props, tz);
    if (rec.error) {
      warn(rec.error);
      continue;
    }
    const own = ownRule(rec.uid, rec.desc);
    if (own) {
      skippedOwn++;
      // A DESCRIPTION-only skip is the one that can be WRONG: a real meeting
      // whose body quotes an agenda invite would vanish from the grid and the
      // planner would put study straight over it. Still dropped - the rule earns
      // its keep on re-imported events - but no longer silent.
      if (own === "description") descOnly++;
      continue;
    }
    if (rec.unknownTzid) warn(`unknown TZID "${rec.unknownTzid}" on ${uidTag(rec.uid)}; using ${tz}`);
    if (!rec.recurrenceId) {
      masters.push(rec);
      continue;
    }
    if (rec.thisAndFuture) {
      warn(`recurrence-id ${uidTag(rec.uid)}: RANGE=THISANDFUTURE is not supported - only the named instance moves`);
    }
    const id = rec.recurrenceId.allDay ? rec.recurrenceId.day : new Date(rec.recurrenceId.ms).toISOString();
    if (!overrides.has(rec.uid)) overrides.set(rec.uid, new Map());
    overrides.get(rec.uid).set(id, rec);
  }
  if (descOnly > 0) warn(`${descOnly} event(s) skipped by description marker only (uid did not match)`);
  return { masters, overrides, skippedOwn };
}

/**
 * Every VEVENT in one feed -> flat instance entries.
 *
 * @param {object}   o
 * @param {Array}    o.vevents  `parseComponents().vevents`
 * @param {string}   o.tz       the pipeline zone: the fallback for a floating
 *                              time and for a TZID `Intl` will not take
 * @param {string}   o.from     window start, `"YYYY-MM-DD"` local
 * @param {string}   o.to       window end, `"YYYY-MM-DD"` local, INCLUSIVE.
 *                              Both bound the RRULE expansion ONLY - the
 *                              precise filter belongs to the normalizer.
 * @param {Function} o.ownRule  the loop guard; see `sortComponents`
 * @returns {{instances: Array, warnings: string[], skippedOwn: number}} PURE.
 */
export function buildInstances({ vevents = [], tz = "UTC", from, to, ownRule = () => null } = {}) {
  const warnings = [];
  const warn = (text) => {
    if (!warnings.includes(text)) warnings.push(text);
  };
  const fromDay = dayNumOfKey(from);
  const toDay = dayNumOfKey(to);
  if (fromDay === null || toDay === null) return { instances: [], warnings: [`bad window ${from}..${to}`], skippedOwn: 0 };

  const { masters, overrides, skippedOwn } = sortComponents(vevents, { tz, ownRule, warn });

  const instances = [];
  for (const master of masters) {
    if (master.cancelled) continue; // STATUS:CANCELLED on the master: the series is gone
    const mine = overrides.get(master.uid) ?? new Map();
    for (const point of expandMaster(master, { fromDay, toDay, warn })) {
      const override = mine.get(point.id);
      if (override?.cancelled) continue;
      const entry = toEntry(override ?? master, override ? startOf(override) : point);
      if (entry) instances.push(entry);
    }
  }
  return { instances, warnings, skippedOwn };
}

/** `parseComponents` + `buildInstances`, the way `gcal-sync.mjs` uses them. PURE. */
export function parseFeed(text, options = {}) {
  const { vevents, tzids } = parseComponents(text);
  return { ...buildInstances({ ...options, vevents }), tzids };
}

export default parseFeed;
