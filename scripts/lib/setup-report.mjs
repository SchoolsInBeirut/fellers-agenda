// ===========================================================================
//  setup-report.mjs - what the wizard says, as pure functions
// ===========================================================================
//
//  Two jobs, both pure so a test can pin the exact words:
//
//    1. Reading the preflight's verdict out of its printed table, and knowing
//       which of its failures are the EXPECTED state at the end of the wizard.
//       Getting this wrong in either direction is bad: call a real failure
//       expected and the user is told everything is fine over a broken repo;
//       call an expected one unexpected and a correct setup ends on an alarm.
//
//    2. The closing "what happens next" text, which is the single most
//       important thing this wizard prints. It has to be honest about the fact
//       that five things are still left, and about WHY a script cannot do them.
// ===========================================================================

/**
 * Preflight FAILs that are correct at the end of setup. Every one is closed by
 * a numbered step in `nextSteps` below.
 *
 *   Your courses            needs a live get_my_courses - docs/SETUP.md Step 6
 *   An LMS source is...     the user may legitimately have chosen demo-only
 *   Claude Code on PATH     needed for the runs, not for setup
 *   .mcp.json               the setup agent rewrites this for Windows at Step 5
 *
 * `<id> can run here` joins them by pattern: an enabled connector that is not
 * finished being connected is exactly what this wizard hands over.
 */
export const EXPECTED_FAILS = Object.freeze([
  "Your courses",
  "An LMS source is enabled",
  "Claude Code on PATH",
  ".mcp.json",
]);

export const isExpectedFail = (name) => EXPECTED_FAILS.includes(name) || / can run here$/.test(String(name));

/**
 * The FAIL rows of a `validate-setup.mjs` table. Its report line is
 * `  FAIL  <name padded>  <detail>`, so two spaces separate the columns.
 */
export function parseFails(stdout) {
  return [...String(stdout ?? "").matchAll(/^ {2}FAIL {2}(.+?) {2}/gm)].map((m) => m[1].trim());
}

/** The opening banner. */
export function banner() {
  return [
    "",
    "  Feller's Agenda - setup",
    "  =======================",
    "  Five questions, then it runs the preflight and shows you a working demo.",
    "  It never asks for a password and never turns off a permission prompt.",
  ];
}

/** How to open a rendered HTML file on this platform. */
export function openCommand(platform, file) {
  const verb = { win32: "start", darwin: "open", linux: "xdg-open" }[platform];
  return verb ? `${verb} ${file}` : file;
}

/**
 * The closing summary: the remaining HUMAN steps, why each one is human, and
 * the doc section that covers it.
 *
 * @param {{fails:string[], unexpected?:string[]}} verdict  what the preflight
 *   still says, split the same way Step 4 split it. `unexpected` is the half no
 *   numbered step below closes.
 * @param {{claude:boolean}} machine     what the machine check found
 */
export function nextSteps(verdict, machine) {
  const lines = [
    "",
    "      Setup did what a script honestly can. These are yours, and here is why:",
    "",
    "      1. Pick your courses and paste your timetable.",
    "         A script cannot call get_my_courses on your account, and it cannot read",
    '         your timetable out of your head. Open this folder in Claude Code, say "hey",',
    "         and the setup agent resumes at exactly this point.",
    "         -> docs/SETUP.md, Steps 6 and 7",
    "",
    "      2. Your first real run:  node src/scrape.mjs  &&  node src/render.mjs",
    "         -> docs/SETUP.md, Step 8",
    "",
    "      3. Add the Google Drive connector to your Claude account.",
    "         claude.ai -> Settings -> Connectors -> Google Drive. That lives on your",
    "         Claude account, not in this folder, and no consent screen can appear",
    "         until it exists. Nothing here can do it for you.",
    "         -> docs/SETUP.md, Step 9.1",
    "",
    "      4. Publish the page, once, so your phone can read it.",
    "         It ends with an artifact URL, which goes into artifact.url in config.json.",
    "         -> docs/ARTIFACT.md, section 2",
    "",
    "      5. Optional extras - mail, an .ics calendar, the side-project board.",
    "         -> docs/SETUP.md, Step 10",
  ];
  if (!machine.claude) {
    lines.push("", "      Claude Code is not installed yet, and steps 1, 3 and 4 all need it.", "         -> https://claude.com/claude-code");
  }
  // The two halves are printed apart, and the second one is why this function
  // takes `unexpected` at all. Step 4 already told the user that a missing
  // fixtures/demo (say) is UNEXPECTED; folding it back into "every one of those
  // is closed by a numbered step above" contradicts that four screens later,
  // over a clone that is genuinely broken.
  const unexpected = verdict.unexpected ?? [];
  const closed = verdict.fails.filter((f) => !unexpected.includes(f));
  if (closed.length) {
    lines.push(
      "",
      `      The preflight still fails on: ${closed.join(", ")}.`,
      "      Every one of those is closed by a numbered step above. Re-check with `npm run doctor`.",
    );
  }
  if (unexpected.length) {
    lines.push(
      "",
      `      UNEXPECTED preflight failure(s): ${unexpected.join(", ")}.`,
      "      Nothing above closes those. Read the fix line printed with each one in the",
      "      table further up, then re-check with `npm run doctor`.",
    );
  }
  lines.push(
    "",
    "      Later, to check on it:",
    "        npm run health    asks every enabled connector whether its backend answers",
    "        npm run doctor    the preflight - no network, a fix line per failure",
    "        npm run setup     safe to run again; it updates rather than starting over",
    "        node scripts/reset.mjs   lists what a clean slate would remove, and removes nothing",
    "",
  );
  return lines;
}
