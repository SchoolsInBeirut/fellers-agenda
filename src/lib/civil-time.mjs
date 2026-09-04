// civil-time.mjs - the pure arithmetic every calendar-shaped module needs.
//
// WHY THIS IS A LIBRARY
//
// Three separate questions keep coming up, and every one of them has a wrong
// answer that looks right on the machine you wrote it on:
//
//   1. "What day is this?"   A calendar day is not 86,400,000 ms after the last
//      one - not across a daylight-saving boundary. Counting days as INTEGERS
//      (days since the epoch, in UTC) makes the arithmetic exact and makes
//      "the day after" a `+ 1`.
//   2. "What instant is 09:00 local?"  `new Date("2026-03-08T09:00")` resolves
//      in the MACHINE's zone, which is a setting, not data. Every offset-less
//      wall clock in this pipeline is resolved in a zone that was DECLARED.
//   3. "Is this string a zone at all?"  `Intl` throws on a bad one, and a
//      throw two layers down reads as a crash rather than as bad config.
//
// Everything here is a total function of its arguments: no clock, no
// filesystem, no globals, no throwing. `src/focus-engine.mjs` keeps its own
// display-oriented helpers (`localDayKey`, `localTimeLabel`, ...), which answer
// "how do I show this?"; this file answers "when is it?".
//
// The day number is the pivot. It is the count of whole days from
// 1970-01-01, computed in UTC, so it is stable, orderable, and one integer
// wide. `dayKeyOf` turns it back into the `YYYY-MM-DD` strings the rest of the
// repo passes around.

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

// ---------------------------------------------------------------- day numbers

/** (2026, 9, 3) -> the day number. PURE. */
export function dayNumOf(year, month, day) {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** day number -> `{year, month, day}`. PURE. */
export function civilOf(n) {
  const d = new Date(n * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** day number -> `"YYYY-MM-DD"`. PURE. */
export function dayKeyOf(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** `"YYYY-MM-DD"` -> day number, or `null` when it is not one. PURE. */
export function dayNumOfKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ""));
  return m ? dayNumOf(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

// ------------------------------------------------------------------- zones

const zoneFormatters = new Map();
const zoneValidity = new Map();

function zoneFormatter(tz) {
  let f = zoneFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(tz, f);
  }
  return f;
}

/** Is this a zone `Intl` will accept? Cached, and never throws. PURE-ish. */
export function isValidZone(name) {
  if (typeof name !== "string" || !name.trim()) return false;
  const key = name.trim();
  if (zoneValidity.has(key)) return zoneValidity.get(key);
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: key });
    ok = true;
  } catch {
    ok = false;
  }
  zoneValidity.set(key, ok);
  return ok;
}

/**
 * The zone's UTC offset in minutes AT that instant - negative west of
 * Greenwich, so New York is -240 in summer and -300 in winter. PURE.
 *
 * It reads the zone's own rendering of the instant rather than a name like
 * "GMT-4", because not every ICU build produces a parseable long offset and a
 * regex over a localized string is a silent zero waiting to happen.
 */
export function zoneOffsetMinutes(ms, tz) {
  if (tz === "UTC") return 0;
  const parts = zoneFormatter(tz).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") % 24; // some ICU builds render midnight as 24
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asIfUtc - ms) / MINUTE_MS);
}

/**
 * A wall clock in a named zone -> the UTC instant.
 *
 * Guess the wall clock is UTC, ask the zone what that instant looks like,
 * subtract, and correct once - one pass settles every transition, because an
 * offset changes by at most a couple of hours and the correction cannot cross a
 * second boundary.
 *
 * Ambiguous local times - the hour repeated at fall-back - resolve to the FIRST
 * occurrence, which is what every calendar client does.
 *
 * NON-EXISTENT ones - the hour skipped at spring-forward - resolve with the
 * offset in force AFTER the transition, which lands them one offset EARLIER
 * than the gap rather than after it: 02:30 on 2026-03-08 in America/New_York
 * does not exist, and this returns 06:30Z, which reads back as 01:30 EST. A
 * client that shifts the gap forward would say 07:30Z (03:30 EDT). Both are
 * conventions; this one falls out of the single correction pass above, and
 * `test/civil-time.test.mjs` pins it so the choice cannot drift silently. PURE.
 */
export function localToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const guessed = zoneOffsetMinutes(wall, tz);
  const ms = wall - guessed * MINUTE_MS;
  const corrected = zoneOffsetMinutes(ms, tz);
  return corrected === guessed ? ms : wall - corrected * MINUTE_MS;
}

// -------------------------------------------------------------------- text

/**
 * Any value -> one line of text, or `null` when there is nothing left.
 *
 * Every text field on the wire is ONE LINE. A raw newline inside a title or a
 * location travels into the payload, into a grid cell and into whatever
 * line-based context an agent builds out of it, so it is flattened once here
 * rather than in each of the places that would otherwise have to remember. PURE.
 */
export function flattenText(value) {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? flat : null;
}
