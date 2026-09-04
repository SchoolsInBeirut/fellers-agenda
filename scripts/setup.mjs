#!/usr/bin/env node
// ===========================================================================
//  setup.mjs - first-time setup, in one command
// ===========================================================================
//  `docs/SETUP.md` is eleven steps and every one is honest work. Most of it is
//  mechanical: copy a file, answer five questions, run the preflight, render the
//  demo, install five scheduled tasks. This does the mechanical part and stops -
//  loudly - wherever a human is genuinely required: a two-factor push, a Google
//  consent screen, an approval inside claude.ai. It never pretends those can be
//  automated and never works around one.
//
//  IT ORCHESTRATES, IT DOES NOT REIMPLEMENT. The preflight, the demo, the reset
//  and the Windows task installer already exist and are already tested; this
//  calls them and interprets what they say. The only new logic is the questions
//  and the two files they land in, and that lives in `scripts/lib/setup-*.mjs`
//  where a unit test can reach it with no terminal.
//
//  Usage:  npm run setup    (or: node scripts/setup.mjs [--help])
//
//  EXIT CODES
//    0  the wizard finished its own steps. The preflight's verdict is reported
//       separately: "your courses are not chosen yet" is the EXPECTED state here
//       and must not read as a crash
//    1  a step this script owns failed, a flag was wrong, or the preflight
//       reported a failure no numbered step closes; the message says how to
//       resume
//    2  a prerequisite blocks everything (Node too old, no terminal to ask in,
//       stdin ended before a question was answered)
// ===========================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, effective, helpText, npmSeparatorMessage, npmSwallowed, SetupArgError } from "./lib/setup-args.mjs";
import {
  LMS_CHOICES, NAMESPACE_RE, USER_STYLES, DEFAULT_USER_STYLE,
  buildConfig, connectorsOn, currentLms, detectTimezone, hostOf, keepNamespace, suggestNamespace, brightspacePackage, wrapNpxForWindows,
} from "./lib/setup-config.mjs";
import { fillSentinels, fieldValues, hasSentinels, isoDate, SENTINEL } from "./lib/setup-claudemd.mjs";
import { schedulePlan } from "./lib/setup-schedule.mjs";
import { banner, isExpectedFail, nextSteps, openCommand, parseFails } from "./lib/setup-report.mjs";
import { askChoice, askUntil, hasTty, makeAsk, SetupEofError, yesNo } from "./lib/setup-ask.mjs";
import { makePrinter, makeRunner, probe, readJson, stop } from "./lib/setup-io.mjs";
import { checkMachine } from "./lib/setup-machine.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every write to the terminal, every child process and the one exit path go
// through scripts/lib/setup-io.mjs, where a test can reach them.
const { say, step, did } = makePrinter();
const { run, node } = makeRunner(REPO);
const fail = stop;

/** A rejected question is a hard stop: guessing past one writes the wrong config. */
const required = (answer, what) => answer ?? fail(`no usable answer for ${what}.`, "npm run setup");

// --- Step 2 - config.json ---
async function configStep(ask, opts) {
  step("Your answers -> config.json");
  const target = join(REPO, "config.json");
  const example = join(REPO, "config.example.json");
  if (!existsSync(example)) fail("config.example.json is missing - this checkout is incomplete.", "re-clone the template");

  const exists = existsSync(target);
  let base;
  try {
    base = readJson(exists ? target : example);
  } catch (e) {
    fail(`${exists ? "config.json" : "config.example.json"} is not valid JSON (${e.message})`, "fix or delete config.json, then `npm run setup`");
  }
  if (exists) {
    did("config.json already exists - updating it in place, keeping every answer you already gave.");
    if (opts.interactive && !(await yesNo(ask, "Update it?", "y"))) {
      did("Left config.json exactly as it was.");
      return { cfg: base, path: target, answers: {} };
    }
  } else {
    did("Copying config.example.json -> config.json (git-ignored; it never leaves this machine).");
  }

  // The example ships every user-specific value as the literal `[NOT SET]`.
  // It must never survive into an answer: a sentinel written back into
  // CLAUDE.md Part 2 would re-trigger the setup agent on the next greeting.
  const said = (v) => (typeof v === "string" && v.trim() && v !== SENTINEL ? v.trim() : null);

  const timezone = said(await ask("What timezone are you in? (IANA name, e.g. America/New_York)", said(base.timezone) ?? detectTimezone() ?? ""));
  if (!timezone) fail("a timezone is required - nothing can be planned without one", "npm run setup");

  const lms = required(await askChoice(ask, "Which LMS does your school use?", LMS_CHOICES, exists ? currentLms(base) : "brightspace"), "your LMS");

  let schoolName = said(base.institution?.name);
  let lmsHost = said(base.institution?.lmsHost);
  if (lms !== "none") {
    schoolName = said(await ask("What is your school called? (a label - nothing connects to it)", schoolName ?? ""));
    lmsHost = said(
      await ask(
        lms === "canvas"
          ? "Your Canvas address? (e.g. canvas.example.edu - this one IS read, as the connector's baseUrl)"
          : "The web address you log into for classes? (e.g. lms.example.edu - a label)",
        lmsHost ?? "",
      ),
    );
  }

  // A namespace already in config.json is KEPT, always, and is not even offered
  // as a question - `keepNamespace` explains what changing one costs. Only a
  // checkout with no config.json gets a suggestion.
  const existingNs = exists ? keepNamespace(base) : null;
  let namespace = existingNs;
  if (existingNs) {
    did(`Keeping the namespace you already have: "${existingNs}" (it names your four Drive documents).`);
  } else {
    namespace = required(
      await askUntil(ask, "A namespace for your four Google Drive documents (a-z, 0-9, dashes)", suggestNamespace(basename(REPO)), (a) => NAMESPACE_RE.test(a), () => 'A namespace is 3-24 characters of a-z, 0-9 or "-". Try again.'),
      "the Drive namespace",
    );
  }

  const style = await askChoice(ask, "Last one: are you comfortable in a terminal, or would you rather I just did everything and told you what happened?", ["terminal", "just-do-it"], "terminal");
  const userStyle = style === "just-do-it" ? USER_STYLES.hands_off : USER_STYLES.terminal;

  const answers = { timezone, namespace, lms, schoolName, lmsHost, userStyle };
  const cfg = buildConfig(base, answers);
  try {
    writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch (e) {
    fail(`could not write config.json (${e.message})`, "check the folder is writable, then `npm run setup`");
  }
  did(`Wrote config.json - timezone ${timezone}, namespace "${namespace}", LMS ${lms}.`);
  if (lms === "none") did("No LMS is enabled, so the preflight below will say so. That is correct for demo-only use.");
  wrapMcpForWindows(lms);
  return { cfg, path: target, answers };
}

/** `wrapNpxForWindows` applied to this checkout's `.mcp.json`. See that function. */
function wrapMcpForWindows(lms) {
  const p = join(REPO, ".mcp.json");
  if (process.platform !== "win32" || lms !== "brightspace" || !existsSync(p)) return;
  let mcp;
  try {
    mcp = readJson(p);
  } catch {
    return did(".mcp.json is not valid JSON, so it was left alone. docs/SETUP.md Step 5 has the correct shape.");
  }
  const { changed, next } = wrapNpxForWindows(mcp);
  if (!changed.length) return;
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  did(`Wrapped ${changed.join(", ")} in .mcp.json for Windows - a bare npx entry starts nothing here, silently.`);
  did("Claude Code reads .mcp.json at session start, so restart it before you connect your school.");
}

// --- Step 3 - CLAUDE.md ---
function claudeMdStep(cfg, answers, opts) {
  step("Your answers -> CLAUDE.md Part 2");
  const path = join(REPO, "CLAUDE.md");
  if (!existsSync(path)) return did("CLAUDE.md is not in this checkout - skipped.");

  const text = readFileSync(path, "utf8");
  if (!opts.fillSentinels) {
    did("--agent: left the [NOT SET] block exactly as it is.");
    did('Start the setup agent by opening this folder in Claude Code and saying: hey');
    return;
  }
  // A Part 2 edited into a shape this cannot read - a missing field line, or
  // two lines for one field - is a stop with an instruction, not a stack trace.
  let stillBlank;
  try {
    stillBlank = hasSentinels(text);
  } catch (e) {
    fail(e.message, "npm run setup");
  }
  if (!stillBlank) return did("Part 2 is already filled in - left it alone.");

  const values = fieldValues({
    date: isoDate(),
    timezone: answers.timezone ?? cfg.timezone,
    schoolName: answers.schoolName,
    lmsHost: answers.lmsHost ? hostOf(answers.lmsHost) ?? answers.lmsHost : null,
    courses: null, // Step 6 of docs/SETUP.md; the preflight is the real gate
    userStyle: answers.userStyle ?? DEFAULT_USER_STYLE,
    connectors: connectorsOn(cfg),
  });
  let filled;
  try {
    filled = fillSentinels(text, values);
  } catch (e) {
    fail(e.message, "npm run setup");
  }
  try {
    writeFileSync(path, filled, "utf8");
  } catch (e) {
    fail(`could not write CLAUDE.md (${e.message})`, "npm run setup");
  }
  did("Filled in the six Part 2 fields, so the setup agent stops triggering on a greeting.");
  did('Courses still say "not chosen yet" - that part needs a live look at your LMS.');
}

// --- Step 4 - the preflight ---
function doctorStep() {
  step("Running the preflight (node scripts/validate-setup.mjs)");
  const r = node("scripts/validate-setup.mjs", [], { capture: true });
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const fails = parseFails(r.stdout);
  const unexpected = fails.filter((f) => !isExpectedFail(f));
  if (r.status === 0) did("Every check passed.");
  else if (unexpected.length === 0) did(`${fails.length} check(s) still fail, and every one of them is a step below. Nothing is broken.`);
  else did(`Unexpected failure(s): ${unexpected.join(", ")}. Read the fix line above before going further.`);
  return { fails, unexpected };
}

// --- Step 5 - the demo ---
function demoStep() {
  step("Rendering the demo agenda (node scripts/demo.mjs)");
  did("No accounts, no logins, no network - it renders from bundled fictional data.");
  const r = node("scripts/demo.mjs");
  if (r.status !== 0) {
    fail("demo mode failed. That is a bug in this template, not in your setup - please open an issue.", "node scripts/demo.mjs");
  }
  did(`Open it: ${openCommand(process.platform, "demo-agenda.html")}`);
}

// --- Step 6 - the LMS login ---
async function authStep(ask, cfg, answers, opts) {
  step("Connecting your school");
  const lms = answers.lms ?? currentLms(cfg);
  if (lms === "none") return did("No LMS chosen - nothing to connect. Demo mode still works.");

  if (lms === "canvas") {
    did("Canvas needs one thing: a personal access token.");
    did("  Canvas -> Account -> Settings -> Approved Integrations -> + New Access Token.");
    did("  It goes into config.json, which is git-ignored, and never into .mcp.json or .env.");
    const token = await ask("Paste the token (blank to do this later)", "");
    if (!token) return did("Skipped. Put it in connectors.lms.canvas.token when you have it.");
    const target = join(REPO, "config.json");
    writeFileSync(target, `${JSON.stringify(buildConfig(readJson(target), { lms: "canvas", lmsHost: answers.lmsHost, canvasToken: token }), null, 2)}\n`, "utf8");
    did("Saved. Asking Canvas whether it accepts it (node scripts/health-check.mjs):");
    const r = node("scripts/health-check.mjs");
    if (r.status !== 0) fail("Canvas did not accept that token. The reason is printed above.", "npm run setup   (or edit connectors.lms.canvas.token by hand)");
    return did("Canvas answered. Your enrolments are visible.");
  }

  const pkg = brightspacePackage(cfg);
  did("Brightspace needs a browser login, and this is the one step only you can do:");
  did("  a window opens on your school's own sign-in page, and your phone gets a two-factor push.");
  did("  Your password never passes through this repository. Approve the push, then come back here.");
  if (opts.interactive && !(await yesNo(ask, "Start the login now?", "y"))) {
    return did(`Skipped. Run it yourself later: npx -y ${pkg} auth`);
  }
  const r = process.platform === "win32"
    ? run("cmd.exe", ["/c", "npx", "-y", pkg, "auth"])
    : run("npx", ["-y", pkg, "auth"]);
  if (r.status !== 0) {
    fail(
      "the login did not complete. docs/connectors/brightspace.md has the two known causes, and " +
        "`node scripts/reauth.mjs --probe` writes a credential-free diagnostic you can attach to an issue.",
      "npm run setup   (auth is re-runnable and safe to retry)",
    );
  }
  did("Logged in.");
}

// --- Step 7 - scheduling ---
async function scheduleStep(ask, cfg, opts) {
  step("Making it run by itself");
  const plan = schedulePlan(process.platform, REPO, cfg);

  if (plan.kind === "undocumented") {
    plan.notes.forEach((n) => did(n));
    return;
  }
  if (plan.kind === "windows") {
    did("scripts\\install-tasks.cmd registers five per-user scheduled tasks:");
    plan.tasks.forEach((t) => did(`  ${t}`));
    plan.notes.forEach((n) => did(n));
    if (opts.interactive && !(await yesNo(ask, "Install them now?", "y"))) return did("Skipped. Run scripts\\install-tasks.cmd whenever you like.");
    const r = run("cmd.exe", ["/c", join(REPO, "scripts", "install-tasks.cmd")]);
    if (r.status !== 0) fail("the task installer reported a problem (above).", "scripts\\install-tasks.cmd");
    return did("Installed. It is idempotent - re-run it after you move this folder.");
  }

  did(`${plan.doc} describes ${plan.kind}. Here is that, with this checkout's real path filled in:`);
  for (const f of plan.files) {
    say("", `      --- ${f.path} ---`);
    say(f.content.split("\n").map((l) => `      ${l}`).join("\n").replace(/\s+$/, ""));
  }
  plan.notes.forEach((n) => did(n));
  const home = process.env.HOME ?? "";
  if (plan.kind === "launchd" && home && opts.interactive && (await yesNo(ask, "Write those three plists and load them?", "n"))) {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    for (const f of plan.files) {
      const abs = join(home, "Library", "LaunchAgents", basename(f.path));
      writeFileSync(abs, f.content, "utf8");
      const r = run("launchctl", ["load", abs]);
      did(`wrote ${abs}${r.status === 0 ? " and loaded it" : " - `launchctl load` failed, load it by hand"}`);
    }
    return;
  }
  say("", "      Install it with:");
  plan.commands.forEach((c) => did(`  ${c}`));
}

// --- main ------------------------------------------------------------------
async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof SetupArgError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  if (flags.help) {
    say(helpText());
    return;
  }

  // `npm run setup --yes` hands --yes to npm, which keeps it: argv arrives
  // empty and the flag comes through as an environment variable instead. Doing
  // what the variable says would mean inferring intent from npm's leftovers, so
  // this fails closed and prints the one command that works.
  const eaten = npmSwallowed(flags, process.env);
  if (eaten.length) {
    console.error("");
    console.error(npmSeparatorMessage(eaten));
    console.error("");
    process.exit(1);
  }

  if (flags.reset) {
    say("", "  Handing over to scripts/reset.mjs - it lists what it would remove and removes nothing.");
    process.exit(node("scripts/reset.mjs").status);
  }

  const opts = effective(flags);
  say(...banner());
  if (opts.interactive && !hasTty()) {
    console.error("\n  setup: there is no terminal here to ask questions in.");
    console.error("  Run `node scripts/setup.mjs --yes` to accept the safe defaults instead.\n");
    process.exit(2);
  }

  const rl = opts.interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = makeAsk(rl);
  try {
    const machine = checkMachine({ step, did }, { probe });
    const { cfg, answers } = await configStep(ask, opts);
    claudeMdStep(cfg, answers, opts);
    const verdict = doctorStep();
    if (opts.runDemo) demoStep();
    if (opts.runAuth) await authStep(ask, cfg, answers, opts);
    else say("", "  [skipped] the LMS login - docs/SETUP.md Step 5 when you are ready.");
    if (opts.runSchedule) await scheduleStep(ask, cfg, opts);
    else say("", "  [skipped] scheduled tasks - docs/SCHEDULING.md when you are ready.");
    step("What happens next");
    say(...nextSteps(verdict, machine));
    // Step 4 called these UNEXPECTED to the user's face; exiting 0 straight
    // afterwards tells every script that ran this that setup succeeded.
    // `exitCode` rather than `exit()` so the readline below is still closed.
    if (verdict.unexpected.length) process.exitCode = 1;
  } catch (e) {
    // Ctrl+D, or a stdin that went away. There is no safe default to fall back
    // on here: the very first question is the timezone, and a guess writes the
    // wrong week into somebody's config.
    if (e instanceof SetupEofError) {
      fail("no answer given - run `node scripts/setup.mjs --yes` for the defaults", null, 2);
    }
    throw e;
  } finally {
    rl?.close();
  }
}

main().catch((e) => {
  console.error(`\n  setup: ${e?.stack ?? e}\n`);
  console.error("  Nothing was left half-written that `npm run setup` cannot redo. Run it again.\n");
  process.exit(1);
});
