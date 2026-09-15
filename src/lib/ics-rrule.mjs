// ics-rrule.mjs - RFC 5545 recurrence: RRULE parsing and a BOUNDED expander.
// PURE: no I/O, no clock, no zones, no dependencies beyond `civil-time.mjs`.
//
// Split out of `ics-parse.mjs` because recurrence is calendar ARITHMETIC and has
// nothing to say about iCalendar text or about time zones. Everything here works
// in day NUMBERS - days since the epoch, counted in UTC - because "every other
// Tuesday" is a statement about DAYS, not about instants. Only the caller, which
// knows the event's zone, turns a day back into an instant. That separation is
// what makes daylight saving work: the same wall clock on each day, converted
// once per day, so the October instance is 17:30Z and the November one 18:30Z.
//
// The dependency runs one way: `ics-parse.mjs` imports this, never the reverse.
//
// ---------------------------------------------------------------------------
// EXPANSION IS BOUNDED, ALWAYS, AND SAYS WHEN IT GAVE UP
//
// A feed is a file somebody else writes. Three separate things must not be able
// to wedge a scheduled run:
//
//   1. an endless rule    `FREQ=DAILY` with no COUNT and no UNTIL, from 2019.
//                         Bounded by the window: expansion never generates past
//                         `toDay`, and `fastForward` skips straight to the first
//                         period that can reach the window rather than walking
//                         the years in between.
//   2. an UNSATISFIABLE rule  `FREQ=MONTHLY;BYMONTHDAY=32`, `BYMONTH=13`,
//                         `BYMONTH=2;BYMONTHDAY=30`. Every period yields ZERO
//                         candidates, so nothing advances and nothing is ever
//                         "past" the window. That is why an EMPTY period counts
//                         against MAX_CANDIDATES too (`considered++` below):
//                         without that clause the loop runs forever, the run
//                         never finishes, and the only thing that notices is the
//                         stale-run watchdog.
//   3. a huge COUNT       `FREQ=DAILY;COUNT=5000` from 2019. Walking it exhausts
//                         the bound years before today and returns NOTHING while
//                         reporting success - a recurring meeting vanishes and
//                         the run claims perfect health. So `fastForward` handles
//                         COUNT wherever the instances it skips can be counted
//                         EXACTLY (see `canFastForwardCount`), and whenever the
//                         bound IS reached the caller is told, so a truncated
//                         series is a warning rather than a disappearance.
import { civilOf, dayNumOf } from "./civil-time.mjs";

/** Hard ceiling on candidate instances - and on empty periods - per event. */
export const MAX_CANDIDATES = 2000;

const DAY_MS = 86400000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const SUPPORTED_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const RRULE_KNOWN = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"]);

// -------------------------------------------------------------- week and month

/** day number -> `"MO"`..`"SU"`. PURE. */
export function weekdayOf(n) {
  return WEEKDAYS[new Date(n * DAY_MS).getUTCDay()];
}

/** The day number the week containing `n` starts on, given WKST. PURE. */
function weekStartOf(n, wkst) {
  const wkstIdx = Math.max(0, WEEKDAYS.indexOf(wkst));
  return n - ((new Date(n * DAY_MS).getUTCDay() - wkstIdx + 7) % 7);
}

/** How many days that month has. PURE. */
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Add `n` whole months to `{year, month}`, keeping the pair normalized. PURE. */
function addMonths(year, month, n) {
  const total = year * 12 + (month - 1) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

// ------------------------------------------------------------------- RRULE

const intList = (value) =>
  String(value)
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));

/** `"MO,2TU,-1FR"` -> `[{ord, day}]`; an entry we cannot read becomes null. PURE. */
function parseByDay(value) {
  return String(value)
    .split(",")
    .map((raw) => {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(raw.trim().toUpperCase());
      return m ? { ord: m[1] ? Number(m[1]) : null, day: m[2] } : null;
    });
}

/**
 * `"FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2"` -> a plain object. Every part this
 * module cannot honour is collected in `unsupported`, which is what turns such a
 * rule into a single-instance event plus a warning rather than into a wrong
 * grid. Guessing at BYSETPOS would put phantom meetings on somebody's week. PURE.
 */
export function parseRRule(text) {
  const rule = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: [],
    bymonthday: [],
    bymonth: [],
    wkst: "MO",
    unsupported: [],
  };
  for (const part of String(text ?? "").split(";")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      rule.unsupported.push(part.trim().toUpperCase());
      continue;
    }
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (!RRULE_KNOWN.has(key)) {
      rule.unsupported.push(key);
      continue;
    }
    applyRulePart(rule, key, value);
  }
  if (!SUPPORTED_FREQ.has(rule.freq)) rule.unsupported.push(`FREQ=${rule.freq ?? ""}`);
  if (rule.byday.some((d) => d === null)) {
    rule.unsupported.push("BYDAY");
    rule.byday = rule.byday.filter((d) => d !== null);
  }
  return rule;
}

/** One recognised RRULE part, folded into the rule object. */
function applyRulePart(rule, key, value) {
  if (key === "FREQ") rule.freq = value.toUpperCase();
  else if (key === "INTERVAL") {
    const n = Number(value);
    rule.interval = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  } else if (key === "COUNT") {
    const n = Number(value);
    rule.count = Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  } else if (key === "UNTIL") rule.until = value;
  else if (key === "BYDAY") rule.byday = parseByDay(value);
  else if (key === "BYMONTHDAY") rule.bymonthday = intList(value);
  else if (key === "BYMONTH") rule.bymonth = intList(value);
  else if (key === "WKST") rule.wkst = value.toUpperCase();
}

// --------------------------------------------------------------- expansion

/**
 * The candidate days one MONTHLY/YEARLY period contributes, given BYDAY /
 * BYMONTHDAY, falling back to DTSTART's day of the month. May legitimately be
 * EMPTY - day 31 in February, or a malformed `BYMONTHDAY=32`. PURE.
 */
function daysInPeriod(year, month, rule, startDay) {
  const last = daysInMonth(year, month);
  const out = [];
  if (rule.bymonthday.length) {
    for (const d of rule.bymonthday) {
      const day = d > 0 ? d : last + d + 1;
      if (day >= 1 && day <= last) out.push(dayNumOf(year, month, day));
    }
    return out;
  }
  if (rule.byday.length) {
    for (const entry of rule.byday) {
      const matches = [];
      for (let d = 1; d <= last; d++) {
        const n = dayNumOf(year, month, d);
        if (weekdayOf(n) === entry.day) matches.push(n);
      }
      if (entry.ord === null) out.push(...matches);
      else {
        const pick = entry.ord > 0 ? matches[entry.ord - 1] : matches[matches.length + entry.ord];
        if (pick !== undefined) out.push(pick);
      }
    }
    return out;
  }
  return startDay <= last ? [dayNumOf(year, month, startDay)] : [];
}

/** The raw candidate days of period `p`, before any filtering. PURE. */
function candidatesOfPeriod(rule, start, startNum, p) {
  if (rule.freq === "DAILY") return [startNum + p * rule.interval];
  if (rule.freq === "WEEKLY") {
    if (!rule.byday.length) return [startNum + p * rule.interval * 7];
    const base = weekStartOf(startNum, rule.wkst) + p * rule.interval * 7;
    const baseDow = new Date(base * DAY_MS).getUTCDay();
    return rule.byday.map((e) => base + ((WEEKDAYS.indexOf(e.day) - baseDow + 7) % 7));
  }
  if (rule.freq === "MONTHLY") {
    const { year, month } = addMonths(start.year, start.month, p * rule.interval);
    return daysInPeriod(year, month, rule, start.day);
  }
  const year = start.year + p * rule.interval;
  const months = rule.bymonth.length ? rule.bymonth : [start.month];
  return months.flatMap((m) => daysInPeriod(year, m, rule, start.day));
}

/** BYMONTH / BYDAY / BYMONTHDAY as post-filters on a DAILY or WEEKLY period. PURE. */
function filterCandidates(rule, candidates) {
  let out = candidates.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (rule.bymonth.length && rule.freq !== "YEARLY") out = out.filter((n) => rule.bymonth.includes(civilOf(n).month));
  if (rule.freq === "DAILY" && rule.byday.length) out = out.filter((n) => rule.byday.some((e) => e.day === weekdayOf(n)));
  if (rule.freq === "DAILY" && rule.bymonthday.length) out = out.filter((n) => rule.bymonthday.includes(civilOf(n).day));
  return out;
}

/**
 * Can the instances a fast-forward would skip be counted EXACTLY? Only then may
 * a COUNT rule be fast-forwarded: miscounting them would end the series in the
 * wrong place, which is worse than being slow. DAILY with no BY* filters emits
 * exactly one instance per period; WEEKLY with plain (non-ordinal) BYDAY emits
 * exactly `byday.length` per period after the first. Everything else walks. PURE.
 */
function canFastForwardCount(rule) {
  if (rule.freq === "DAILY") return !rule.byday.length && !rule.bymonth.length && !rule.bymonthday.length;
  if (rule.freq === "WEEKLY") {
    return !rule.bymonth.length && !rule.bymonthday.length && rule.byday.every((e) => e.ord === null);
  }
  return false;
}

/** How many instances precede period `periods`. Exact for the cases above. PURE. */
function instancesBeforePeriod(rule, start, periods) {
  if (periods <= 0) return 0;
  if (rule.freq !== "WEEKLY" || !rule.byday.length) return periods;
  // The first week only counts the BYDAY days at or after DTSTART.
  const startNum = dayNumOf(start.year, start.month, start.day);
  const firstWeek = candidatesOfPeriod(rule, start, startNum, 0).filter((n) => n >= startNum).length;
  return firstWeek + (periods - 1) * rule.byday.length;
}

/**
 * How many whole periods to skip so the first candidate can reach `fromDay`.
 * Returns 0 whenever skipping would lose track of COUNT. PURE.
 */
function fastForward(rule, start, fromDay) {
  if (rule.count !== null && !canFastForwardCount(rule)) return 0;
  const startNum = dayNumOf(start.year, start.month, start.day);
  if (fromDay <= startNum) return 0;
  const step = rule.interval;
  if (rule.freq === "DAILY") return Math.max(0, Math.floor((fromDay - startNum) / step));
  if (rule.freq === "WEEKLY") {
    const weeks = Math.floor((weekStartOf(fromDay, rule.wkst) - weekStartOf(startNum, rule.wkst)) / 7);
    return Math.max(0, Math.floor(weeks / step));
  }
  const from = civilOf(fromDay);
  const months = (from.year - start.year) * 12 + (from.month - start.month);
  if (rule.freq === "MONTHLY") return Math.max(0, Math.floor((months - 1) / step));
  if (rule.freq === "YEARLY") return Math.max(0, Math.floor((from.year - start.year - 1) / step));
  return 0;
}

/**
 * Expand one RRULE into day numbers, DTSTART included.
 *
 * @param {object}  rule    `parseRRule()` output
 * @param {object}  start   DTSTART's civil date `{year, month, day}`
 * @param {object}  bounds
 * @param {number}  bounds.fromDay  inclusive lower day number
 * @param {number}  bounds.toDay    inclusive upper day number
 * @param {?object} bounds.until    `{dayNum}` from the rule's UNTIL, or null.
 *                                  The INSTANT half of UNTIL is applied by the
 *                                  caller, which knows the event's zone.
 * @param {boolean} bounds.noFastForward  walk every period (a test hook: the
 *                                  parity test compares the two paths)
 * @returns {{days: number[], truncated: boolean}} `truncated` means the expander
 *          stopped on MAX_CANDIDATES and instances may be missing. PURE.
 */
export function expandRuleDetailed(rule, start, { fromDay, toDay, until = null, noFastForward = false } = {}) {
  const startNum = dayNumOf(start.year, start.month, start.day);
  if (!SUPPORTED_FREQ.has(rule.freq)) return { days: [startNum], truncated: false };

  const days = new Set();
  let period = noFastForward ? 0 : fastForward(rule, start, fromDay);
  let emitted = instancesBeforePeriod(rule, start, period);
  if (rule.count !== null && emitted >= rule.count) return finish(days, startNum, fromDay, toDay, until, false);

  let considered = 0;
  let truncated = true; // proven false by whichever bound we actually leave on
  while (considered < MAX_CANDIDATES) {
    const candidates = filterCandidates(rule, candidatesOfPeriod(rule, start, startNum, period));
    // AN EMPTY PERIOD IS STILL WORK. Without this the loop never terminates on
    // an unsatisfiable rule - see the header, item 2.
    if (!candidates.length) considered++;

    let past = candidates.length > 0;
    for (const n of candidates) {
      considered++;
      if (n >= startNum) {
        emitted++;
        if (rule.count !== null && emitted > rule.count) return finish(days, startNum, fromDay, toDay, until, false);
      }
      if (until && n > until.dayNum) return finish(days, startNum, fromDay, toDay, until, false);
      if (n >= startNum && n >= fromDay && n <= toDay) days.add(n);
      if (n <= toDay) past = false;
    }
    if (past) {
      truncated = false; // the whole period is beyond the window; nothing later can help
      break;
    }
    if (rule.count !== null && emitted >= rule.count) {
      truncated = false;
      break;
    }
    period++;
  }
  return finish(days, startNum, fromDay, toDay, until, truncated && considered >= MAX_CANDIDATES);
}

/** The array-only form. PURE. */
export function expandRule(rule, start, bounds) {
  return expandRuleDetailed(rule, start, bounds).days;
}

/** DTSTART is always an instance of its own rule (RFC 5545 3.8.5.3). PURE. */
function finish(days, startNum, fromDay, toDay, until, truncated) {
  if (startNum >= fromDay && startNum <= toDay && (!until || startNum <= until.dayNum)) days.add(startNum);
  return { days: [...days].sort((a, b) => a - b), truncated: Boolean(truncated) };
}

export default expandRule;
