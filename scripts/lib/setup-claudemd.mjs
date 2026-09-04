// ===========================================================================
//  setup-claudemd.mjs - filling Part 2 of CLAUDE.md the way the agent does
// ===========================================================================
//
//  THE CONTRACT THIS FILE IMPLEMENTS
//  ---------------------------------
//  `CLAUDE.md` Part 2 ships as six lines, each ending in the literal string
//  `[NOT SET]`. Two things read them:
//
//    * `AGENTS.md` - "if the user says hey and CLAUDE.md still has [NOT SET]
//      fields, run the onboarding agent";
//    * `.claude/agents/onboarding.md` Step 11 - which rewrites the same six
//      lines and deletes every sentinel it filled.
//
//  So there are two routes to a set-up repository, and they must converge on
//  the same bytes or the wizard's user gets the setup agent again on their next
//  greeting. This module is the wizard's half, written against Step 11's
//  example block field for field.
//
//  THE ONE PLACE THE WIZARD CANNOT MATCH THE AGENT
//  ----------------------------------------------
//  Courses come from a live `get_my_courses` call, and the school's name comes
//  from a conversation. A non-interactive wizard has neither. Rather than
//  leaving `[NOT SET]` there - which would re-trigger the setup agent for a
//  user who has just finished the wizard - it writes an explicit PENDING
//  sentence. Nothing is hidden by that: the real gate on courses is
//  `scripts/validate-setup.mjs`, which FAILS on "Your courses" until the
//  example cast is replaced, and that check is untouched.
//
//  Only the six field lines are rewritten. Part 1 mentions `[NOT SET]` in prose
//  three times and must not be edited, so every pattern here is anchored to the
//  start of a line.
// ===========================================================================

/** The six fields, in the order CLAUDE.md Part 2 prints them. */
export const FIELDS = Object.freeze(["Configured", "Timezone", "School", "Courses", "User style", "Connectors on"]);

/** The literal sentinel `src/lib/config.mjs` turns into null inside config.json. */
export const SENTINEL = "[NOT SET]";

/**
 * What actually marks a Part 2 field as unanswered.
 *
 * It is the PREFIX, not the whole sentinel, because the first line does not use
 * the bare form: CLAUDE.md ships
 * `**Configured:** [NOT SET — type "hey" to run setup]`, which contains the
 * instruction inside the brackets. Matching only `[NOT SET]` would read that
 * line as answered, so a repository whose setup never ran would look set up.
 */
export const SENTINEL_PREFIX = "[NOT SET";

/**
 * What the wizard writes into a field it genuinely cannot answer. It is not a
 * sentinel: it is a sentence that names the next action, and the preflight is
 * what actually blocks on the missing value.
 */
export const PENDING = Object.freeze({
  school: 'not recorded — set institution.name in config.json, or say "hey" in Claude Code',
  courses: 'not chosen yet — connect your LMS, then say "hey" in Claude Code to pick them',
  timezone: 'not detected — set timezone in config.json, or say "hey" in Claude Code',
});

/**
 * The pattern for one field line, anchored to the start of a line.
 *
 * No escaping is done and none is needed: `FIELDS` is a frozen list of literal
 * names with no regular-expression metacharacter in any of them, and
 * `assertKnownField` refuses anything else. Building a pattern out of an
 * arbitrary caller-supplied string is exactly the bug this avoids.
 */
const lineRe = (field) => new RegExp(`^\\*\\*${assertKnownField(field)}:\\*\\*.*$`, "m");

function assertKnownField(field) {
  if (!FIELDS.includes(field)) {
    throw new Error(`CLAUDE.md: "${field}" is not one of the Part 2 fields (${FIELDS.join(", ")})`);
  }
  return field;
}

/**
 * The ONE line for a field, or none. Every reader below goes through here.
 *
 * A duplicated field line is refused rather than resolved. Picking the first
 * match - which is what a non-global regular expression does, silently - means
 * `fillSentinels` writes into one copy and `hasSentinels` inspects the same
 * one, so a second copy carrying `[NOT SET]` survives the wizard, re-triggers
 * the onboarding agent on the user's next greeting, and run 2 cheerfully
 * reports "Part 2 is already filled in".
 */
function fieldLine(text, field) {
  const re = new RegExp(`^\\*\\*${assertKnownField(field)}:\\*\\*.*$`, "gm");
  const found = String(text ?? "").match(re) ?? [];
  if (found.length > 1) {
    throw new Error(
      `CLAUDE.md: "**${field}:**" appears ${found.length} times. Part 2 has more than one line for one field, so setup cannot tell which is real.\n` +
        `  Fix: git checkout CLAUDE.md, then run npm run setup again.`,
    );
  }
  return found[0] ?? null;
}

/**
 * True when any of the six field lines still carries the sentinel.
 *
 * Every field is read before the answer is decided, deliberately: a `.some()`
 * that short-circuits on the first sentinel would never reach - and so never
 * report - a duplicated line further down Part 2.
 */
export function hasSentinels(text) {
  const lines = FIELDS.map((f) => fieldLine(text, f) ?? "");
  return lines.some((l) => l.includes(SENTINEL_PREFIX));
}

/** The six field lines as they currently read, for a diff or a test. */
export function readFields(text) {
  const out = {};
  for (const f of FIELDS) {
    const line = fieldLine(text, f);
    out[f] = line ? line.slice(`**${f}:** `.length) : null;
  }
  return Object.freeze(out);
}

/**
 * Replace the six field lines. Returns new text; the input is never mutated.
 * A field absent from `values` is left exactly as it was, so a re-run that only
 * learned the timezone does not blank out the courses somebody already has.
 *
 * @param {string} text     the whole CLAUDE.md
 * @param {Record<string,string>} values  keyed by the names in FIELDS
 */
export function fillSentinels(text, values = {}) {
  // A misspelled key would otherwise do nothing at all, silently, and the field
  // it meant to fill would keep its sentinel.
  for (const key of Object.keys(values)) assertKnownField(key);
  let out = String(text ?? "");
  // A duplicated line anywhere in Part 2 is refused before a byte is written,
  // not just in the fields this call happens to be filling.
  for (const f of FIELDS) fieldLine(out, f);
  for (const f of FIELDS) {
    const value = values[f];
    if (value === undefined || value === null) continue;
    // Throws on a duplicate before anything is written, so a half-filled Part 2
    // is never left behind.
    if (fieldLine(out, f) === null) {
      throw new Error(
        `CLAUDE.md: no "**${f}:**" line to fill. Part 2 has been edited into a shape setup does not recognise.\n` +
          `  Fix: git checkout CLAUDE.md, then run npm run setup again.`,
      );
    }
    // $-sequences in a replacement string are magic; a function replacement is not.
    out = out.replace(lineRe(f), () => `**${f}:** ${String(value).replace(/\r?\n/g, " ")}`);
  }
  return out;
}

/**
 * The six values, assembled from what the wizard actually knows.
 *
 * @param {{date:string, timezone?:string|null, schoolName?:string|null,
 *          lmsHost?:string|null, courses?:string|null, userStyle:string,
 *          connectors:string[]}} facts
 */
export function fieldValues(facts) {
  const school = facts.schoolName
    ? facts.lmsHost
      ? `${facts.schoolName} (${facts.lmsHost})`
      : String(facts.schoolName)
    : PENDING.school;
  return Object.freeze({
    Configured: `yes, ${facts.date}`,
    Timezone: facts.timezone || PENDING.timezone,
    School: school,
    Courses: facts.courses || PENDING.courses,
    "User style": facts.userStyle,
    "Connectors on": facts.connectors?.length ? facts.connectors.join(", ") : "none yet",
  });
}

/**
 * `2026-09-03`, the format Step 11's example uses - in the USER'S day, not
 * UTC's. `toISOString()` would stamp tomorrow's date on an evening setup run
 * anywhere east of Greenwich's evening, and "Configured: yes, <tomorrow>" is a
 * small lie in the one line whose whole job is to say when this happened.
 */
export function isoDate(now = new Date()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
