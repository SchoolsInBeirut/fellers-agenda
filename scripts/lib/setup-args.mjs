// ===========================================================================
//  setup-args.mjs - the wizard's command line, as a pure function
// ===========================================================================
//
//  WHY THIS IS ITS OWN FILE
//  ------------------------
//  `scripts/setup.mjs` is the one script in this repository that a stranger
//  runs before they have read anything, so the difference between `--skip-auth`
//  and `--skipauth` must be a clear sentence rather than a wizard that quietly
//  does the opposite of what was asked. Argument parsing is also the only part
//  of setup that can be tested without a terminal, a network or a clock, so it
//  lives here where a unit test can reach it.
//
//  THE HOUSE RULE: an unknown flag is a hard error. `scripts/reauth.mjs`
//  already works this way (AGENTS.md, "The command table"), and for the same
//  reason: a typo that silently selects the default behaviour is how somebody
//  ends up believing they skipped a step they did not skip.
// ===========================================================================

/** Every switch the wizard accepts, with the one line `--help` prints. */
export const FLAGS = Object.freeze({
  yes: "accept every safe default and ask nothing (never starts a login)",
  agent: "leave the CLAUDE.md [NOT SET] block alone for the onboarding agent",
  reset: "hand over to scripts/reset.mjs and stop",
  "no-demo": "do not render the demo agenda",
  "skip-auth": "do not run the LMS login step",
  "skip-schedule": "do not install the scheduled tasks",
  schedule: "with --yes, install the scheduled tasks anyway",
  help: "print this list and stop",
});

export class SetupArgError extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupArgError";
  }
}

const KNOWN = new Set(Object.keys(FLAGS));

/**
 * argv slice -> the flags that were present. Throws `SetupArgError` on anything
 * it does not recognise, naming the flag and listing what is valid.
 *
 * @param {string[]} argv
 * @returns {{yes:boolean, agent:boolean, reset:boolean, noDemo:boolean,
 *            skipAuth:boolean, skipSchedule:boolean, schedule:boolean,
 *            help:boolean}}
 */
export function parseArgs(argv = []) {
  const seen = new Set();
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      throw new SetupArgError(
        `setup: "${raw}" is not a flag. This wizard takes no positional arguments.\n` +
          `  Valid flags: ${[...KNOWN].map((f) => `--${f}`).join(" ")}`,
      );
    }
    const name = raw.slice(2);
    if (!KNOWN.has(name)) {
      throw new SetupArgError(
        `setup: unknown flag "${raw}". Nothing was run.\n` +
          `  Valid flags: ${[...KNOWN].map((f) => `--${f}`).join(" ")}`,
      );
    }
    seen.add(name);
  }
  return Object.freeze({
    yes: seen.has("yes"),
    agent: seen.has("agent"),
    reset: seen.has("reset"),
    noDemo: seen.has("no-demo"),
    skipAuth: seen.has("skip-auth"),
    skipSchedule: seen.has("skip-schedule"),
    schedule: seen.has("schedule"),
    help: seen.has("help"),
  });
}

/**
 * What those flags mean once they have argued with each other.
 *
 * The rule that matters: **`--yes` never starts a login and never registers a
 * scheduled task.** Both of those reach outside this folder - one raises a
 * two-factor prompt on somebody's phone, the other writes into the operating
 * system's scheduler - and a flag whose whole purpose is "stop asking me" is
 * the last place either belongs. `--schedule` is the explicit opt-in that
 * brings task installation back; there is deliberately no equivalent for auth,
 * because the login step is interactive by construction and an unattended run
 * cannot answer it.
 *
 * @param {ReturnType<typeof parseArgs>} flags
 */
export function effective(flags) {
  return Object.freeze({
    interactive: !flags.yes,
    runDemo: !flags.noDemo,
    // --yes is unattended; a login needs a human at a phone.
    runAuth: !flags.skipAuth && !flags.yes,
    runSchedule: !flags.skipSchedule && (!flags.yes || flags.schedule),
    // --agent hands Part 2 of CLAUDE.md back to the onboarding agent untouched.
    fillSentinels: !flags.agent,
  });
}

/**
 * The environment variables npm exports when a flag was given to IT rather
 * than to this script - `npm run setup --yes` instead of
 * `npm run setup -- --yes`. npm keeps the flag, `process.argv` is empty, and
 * the wizard would run interactively while the user believes they asked for
 * the defaults.
 *
 * The names are npm's, not ours: `--no-demo` becomes `npm_config_demo=""`,
 * because npm reads `--no-x` as `x=false`. `npm_config_no_demo` is listed too
 * in case a future npm normalises differently; neither is a real npm config,
 * so neither can appear by accident.
 *
 * Nothing npm sets on a plain `npm run` is in this map - `cache`, `loglevel`,
 * `prefix`, `user_agent` and the rest of that block are deliberately absent,
 * because a false positive here makes the documented command impossible to run.
 */
export const NPM_SWALLOWED_ENV = Object.freeze({
  npm_config_yes: "yes",
  npm_config_agent: "agent",
  npm_config_reset: "reset",
  npm_config_demo: "no-demo",
  npm_config_no_demo: "no-demo",
  npm_config_skip_auth: "skip-auth",
  npm_config_skip_schedule: "skip-schedule",
  npm_config_schedule: "schedule",
});

/** `--no-demo` -> the `noDemo` property `parseArgs` returns. */
const propOf = (flag) => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Which flags npm ate. A flag that actually reached `argv` is not counted:
 * `npm run setup -- --yes` sets nothing, and a user who types both forms has
 * already got what they asked for.
 *
 * @param {ReturnType<typeof parseArgs>} flags
 * @param {Record<string,string|undefined>} env
 * @returns {string[]} flag names, without the leading `--`, in FLAGS order
 */
export function npmSwallowed(flags, env = process.env) {
  const eaten = new Set();
  for (const [key, flag] of Object.entries(NPM_SWALLOWED_ENV)) {
    if (env?.[key] === undefined) continue;
    if (flags?.[propOf(flag)]) continue;
    eaten.add(flag);
  }
  return Object.keys(FLAGS).filter((f) => eaten.has(f));
}

/**
 * The one line the wizard prints before stopping. It does NOT guess: acting on
 * a flag npm swallowed would mean inferring intent from an environment
 * variable, and the whole reason this file exists is that a silently different
 * behaviour is worse than a refusal.
 */
export function npmSeparatorMessage(names) {
  const flags = names.map((n) => `--${n}`).join(" ");
  return `  you passed ${flags} to npm, not to setup - run: npm run setup -- ${flags}`;
}

/** The `--help` body, so the wizard and a test agree on one text. */
export function helpText() {
  const width = Math.max(...Object.keys(FLAGS).map((f) => f.length)) + 2;
  const rows = Object.entries(FLAGS)
    .map(([name, what]) => `  --${name.padEnd(width)}${what}`)
    .join("\n");
  return [
    "",
    "  npm run setup - first-time setup for this agenda",
    "",
    "  Usage: node scripts/setup.mjs [flags]",
    "",
    rows,
    "",
    "  With no flags it asks a handful of questions, writes config.json,",
    "  fills in CLAUDE.md, runs the preflight and renders the demo agenda.",
    "",
  ].join("\n");
}
