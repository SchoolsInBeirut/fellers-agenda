// ===========================================================================
//  setup.test.mjs - the one-command setup wizard
// ===========================================================================
//
//  Two halves.
//
//  The PURE half pins the four transformations the wizard is: argv -> options,
//  answers -> config, CLAUDE.md -> filled CLAUDE.md, platform -> schedule plan.
//  The sentinel test runs against the REAL `CLAUDE.md` in this repository, not
//  a fixture, because the thing that would actually break is somebody editing
//  Part 2 into a shape the wizard no longer recognises - and a fixture would
//  keep passing while that happened.
//
//  The END-TO-END half copies what the wizard needs into a temp directory and
//  runs the real script as a subprocess. It never touches the developer's own
//  `config.json`, `CLAUDE.md` or `data/`.
// ===========================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseArgs, effective, helpText, npmSeparatorMessage, npmSwallowed, SetupArgError } from "../scripts/lib/setup-args.mjs";
import {
  LMS_CHOICES, USER_STYLES, buildConfig, connectorsOn, currentLms, detectTimezone,
  hostOf, keepNamespace, normaliseBaseUrl, setIn, suggestNamespace, brightspacePackage, wrapNpxForWindows,
} from "../scripts/lib/setup-config.mjs";
import { checkGcal } from "../scripts/lib/setup-gcal.mjs";
import { makePrinter, makeRunner, probe, stop } from "../scripts/lib/setup-io.mjs";
import { checkMachine, NODE_MIN } from "../scripts/lib/setup-machine.mjs";
import { FIELDS, PENDING, SENTINEL, SENTINEL_PREFIX, fieldValues, fillSentinels, hasSentinels, isoDate, readFields } from "../scripts/lib/setup-claudemd.mjs";
import { SCHEDULER_DEFAULTS, parseHM, schedulePlan } from "../scripts/lib/setup-schedule.mjs";
import { isExpectedFail, nextSteps, openCommand, parseFails, RCLONE_INSTALL, rcloneConsent, rcloneSteps } from "../scripts/lib/setup-report.mjs";
import { askChoice, askUntil, makeAsk, yesNo, TRIES } from "../scripts/lib/setup-ask.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * Remove a scratch directory. Windows can keep a just-rewritten directory open
 * for a moment (the indexer, an antivirus scan), and a leftover temp dir is not
 * a wizard defect - so retry for a few seconds, then warn rather than fail a
 * test whose assertions already passed.
 */
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    console.warn(`[setup.test] could not remove ${dir}: ${e.code ?? e.message}`);
  }
}
const EXAMPLE = readJson(join(REPO, "config.example.json"));
const CLAUDE_MD = readFileSync(join(REPO, "CLAUDE.md"), "utf8");

// ===========================================================================
describe("setup: the command line", () => {
  it("recognises every documented flag", () => {
    const f = parseArgs(["--yes", "--agent", "--reset", "--no-demo", "--skip-auth", "--skip-schedule", "--schedule", "--help"]);
    assert.deepEqual(
      { ...f },
      { yes: true, agent: true, reset: true, noDemo: true, skipAuth: true, skipSchedule: true, schedule: true, help: true },
    );
  });

  it("no flags means every switch is off", () => {
    assert.equal(Object.values({ ...parseArgs([]) }).some(Boolean), false);
  });

  it("an unknown flag is a hard error that names the valid ones", () => {
    assert.throws(() => parseArgs(["--skipauth"]), (e) => e instanceof SetupArgError && /unknown flag "--skipauth"/.test(e.message) && /--skip-auth/.test(e.message));
  });

  it("a positional argument is refused rather than ignored", () => {
    assert.throws(() => parseArgs(["setup"]), SetupArgError);
  });

  it("--yes accepts defaults but starts NO login and installs NO tasks", () => {
    const e = effective(parseArgs(["--yes"]));
    assert.equal(e.interactive, false);
    assert.equal(e.runAuth, false, "--yes must never raise a two-factor prompt");
    assert.equal(e.runSchedule, false, "--yes must never write into the OS scheduler");
    assert.equal(e.runDemo, true);
    assert.equal(e.fillSentinels, true);
  });

  it("--yes --schedule is the explicit opt-in that brings task installation back", () => {
    assert.equal(effective(parseArgs(["--yes", "--schedule"])).runSchedule, true);
    assert.equal(effective(parseArgs(["--yes", "--schedule"])).runAuth, false, "there is deliberately no such opt-in for auth");
  });

  it("without --yes the login and the scheduler are both on by default", () => {
    const e = effective(parseArgs([]));
    assert.equal(e.runAuth, true);
    assert.equal(e.runSchedule, true);
    assert.equal(e.interactive, true);
  });

  it("--skip-auth, --skip-schedule and --no-demo each turn off exactly one thing", () => {
    assert.equal(effective(parseArgs(["--skip-auth"])).runAuth, false);
    assert.equal(effective(parseArgs(["--skip-schedule"])).runSchedule, false);
    assert.equal(effective(parseArgs(["--no-demo"])).runDemo, false);
    assert.equal(effective(parseArgs(["--no-demo"])).runAuth, true);
  });

  it("--agent leaves the sentinels for the onboarding agent", () => {
    assert.equal(effective(parseArgs(["--agent"])).fillSentinels, false);
  });

  it("--help lists every flag it accepts", () => {
    const text = helpText();
    for (const flag of ["--yes", "--agent", "--reset", "--no-demo", "--skip-auth", "--skip-schedule", "--schedule"]) {
      assert.ok(text.includes(flag), `--help does not mention ${flag}`);
    }
  });
});

// ===========================================================================
describe("setup: the flag npm ate", () => {
  const none = parseArgs([]);

  it("spots each flag npm kept for itself", () => {
    // These are the names npm actually exports. `--no-demo` becomes
    // `npm_config_demo=""` because npm reads `--no-x` as `x=false`.
    assert.deepEqual(npmSwallowed(none, { npm_config_yes: "true" }), ["yes"]);
    assert.deepEqual(npmSwallowed(none, { npm_config_agent: "true" }), ["agent"]);
    assert.deepEqual(npmSwallowed(none, { npm_config_reset: "true" }), ["reset"]);
    assert.deepEqual(npmSwallowed(none, { npm_config_demo: "" }), ["no-demo"]);
    assert.deepEqual(npmSwallowed(none, { npm_config_no_demo: "true" }), ["no-demo"]);
    assert.deepEqual(npmSwallowed(none, { npm_config_skip_auth: "true" }), ["skip-auth"]);
    assert.deepEqual(npmSwallowed(none, { npm_config_skip_schedule: "true" }), ["skip-schedule"]);
    assert.deepEqual(npmSwallowed(none, { npm_config_schedule: "true" }), ["schedule"]);
  });

  it("says nothing when the flag actually arrived", () => {
    assert.deepEqual(npmSwallowed(parseArgs(["--yes"]), { npm_config_yes: "true" }), []);
    assert.deepEqual(npmSwallowed(parseArgs(["--no-demo"]), { npm_config_demo: "" }), []);
  });

  it("the block npm always exports is never mistaken for a flag", () => {
    // Every one of these is present on a plain `npm run setup`. A false
    // positive here would make the documented command impossible to run.
    const always = {
      npm_config_cache: "/x", npm_config_global_prefix: "/x", npm_config_globalconfig: "/x",
      npm_config_init_module: "/x", npm_config_local_prefix: "/x", npm_config_loglevel: "notice",
      npm_config_node_gyp: "/x", npm_config_noproxy: "", npm_config_npm_version: "10.9.0",
      npm_config_prefix: "/x", npm_config_user_agent: "npm/10.9.0", npm_config_userconfig: "/x",
    };
    assert.deepEqual(npmSwallowed(none, always), []);
    assert.deepEqual(npmSwallowed(none, {}), []);
  });

  it("the message is one line and names the exact command", () => {
    assert.equal(
      npmSeparatorMessage(["yes"]),
      "  you passed --yes to npm, not to setup - run: npm run setup -- --yes",
    );
    assert.equal(
      npmSeparatorMessage(["yes", "skip-auth"]),
      "  you passed --yes --skip-auth to npm, not to setup - run: npm run setup -- --yes --skip-auth",
    );
  });
});

// ===========================================================================
describe("setup: answers -> config", () => {
  const answers = {
    timezone: "America/New_York",
    namespace: "my-agenda",
    lms: "brightspace",
    schoolName: "Example University",
    lmsHost: "lms.example.edu",
  };

  it("writes every answer where docs/SETUP.md says it goes", () => {
    const cfg = buildConfig(EXAMPLE, answers);
    assert.equal(cfg.timezone, "America/New_York");
    assert.equal(cfg.namespace, "my-agenda");
    assert.equal(cfg.institution.name, "Example University");
    assert.equal(cfg.institution.lmsHost, "lms.example.edu");
    assert.equal(cfg.connectors.lms.brightspace.enabled, true);
    assert.equal(cfg.connectors.lms.canvas.enabled, false);
  });

  it("never mutates the config it was given", () => {
    const before = JSON.stringify(EXAMPLE);
    buildConfig(EXAMPLE, { ...answers, lms: "canvas", canvasToken: "secret" });
    assert.equal(JSON.stringify(EXAMPLE), before);
  });

  it("leaves every key it was not asked about at the example's value", () => {
    const cfg = buildConfig(EXAMPLE, answers);
    assert.equal(cfg.wakeTime, EXAMPLE.wakeTime);
    assert.deepEqual(cfg.studyMinutes, EXAMPLE.studyMinutes);
    assert.deepEqual(cfg.scheduler, EXAMPLE.scheduler);
    assert.deepEqual(cfg.notifications, EXAMPLE.notifications);
    assert.deepEqual(cfg.courses, EXAMPLE.courses, "courses come from the LMS at Step 6, never from the wizard");
  });

  it("keeps the annotations the example ships, so config.json stays readable", () => {
    const cfg = buildConfig(EXAMPLE, answers);
    assert.equal(typeof cfg.connectors.lms.canvas._comment, "string");
  });

  it("canvas gets a normalised baseUrl and, only when given, the token", () => {
    const bare = buildConfig(EXAMPLE, { ...answers, lms: "canvas", lmsHost: "canvas.example.edu/" });
    assert.equal(bare.connectors.lms.canvas.enabled, true);
    assert.equal(bare.connectors.lms.brightspace.enabled, false);
    assert.equal(bare.connectors.lms.canvas.baseUrl, "https://canvas.example.edu");
    assert.equal(bare.connectors.lms.canvas.token, EXAMPLE.connectors.lms.canvas.token, "no token answered means no token written");
    assert.equal(bare.institution.lmsHost, "canvas.example.edu", "the label is the host, not the whole URL");

    const withToken = buildConfig(EXAMPLE, { ...answers, lms: "canvas", canvasToken: "abc123" });
    assert.equal(withToken.connectors.lms.canvas.token, "abc123");
  });

  it('"none" turns both LMS connectors off - demo-only is a supported answer', () => {
    const cfg = buildConfig(EXAMPLE, { ...answers, lms: "none" });
    assert.equal(cfg.connectors.lms.brightspace.enabled, false);
    assert.equal(cfg.connectors.lms.canvas.enabled, false);
  });

  it("refuses an LMS it does not have a connector for", () => {
    assert.throws(() => buildConfig(EXAMPLE, { lms: "blackboard" }), /brightspace, canvas, none/);
    assert.deepEqual(LMS_CHOICES, ["brightspace", "canvas", "none"]);
  });

  it("setIn is a deep immutable set", () => {
    const before = { a: { b: 1, c: 2 } };
    const after = setIn(before, "a.b", 9);
    assert.deepEqual(before, { a: { b: 1, c: 2 } });
    assert.deepEqual(after, { a: { b: 9, c: 2 } });
  });

  it("a namespace suggestion is always valid, whatever the folder is called", () => {
    assert.equal(suggestNamespace("my-agenda"), "my-agenda");
    assert.equal(suggestNamespace("My Agenda!"), "my-agenda");
    assert.equal(suggestNamespace("x"), "agenda", "too short falls back");
    assert.equal(suggestNamespace(""), "agenda");
    assert.equal(suggestNamespace("!!!"), "agenda");
    assert.match(suggestNamespace("a".repeat(80)), /^[a-z0-9-]{3,24}$/);
  });

  it("a bare host becomes https, and a trailing slash is dropped", () => {
    assert.equal(normaliseBaseUrl("canvas.example.edu"), "https://canvas.example.edu");
    assert.equal(normaliseBaseUrl("https://canvas.example.edu/"), "https://canvas.example.edu");
    assert.equal(normaliseBaseUrl("  "), null);
    assert.equal(hostOf("https://canvas.example.edu/courses"), "canvas.example.edu");
  });

  it("detectTimezone accepts a zone NAME, including UTC, and refuses an offset", () => {
    const named = (tz) => detectTimezone({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) });
    assert.equal(named("America/New_York"), "America/New_York");
    assert.equal(named("UTC"), "UTC", "containers and CI runners report exactly this");
    assert.equal(named("GMT+2"), null, "a fixed offset does not follow daylight saving");
    assert.equal(named(undefined), null);
    assert.equal(detectTimezone({ DateTimeFormat: () => { throw new Error("no Intl"); } }), null);
  });

  it("a valid namespace already in config.json is kept, always", () => {
    // Rewriting it renames all four Drive documents and orphans a page that
    // has already been published, and the wizard's own default - the folder
    // slug - is exactly what would overwrite it on a re-run.
    assert.equal(keepNamespace({ namespace: "agenda" }), "agenda", '"agenda" is a namespace somebody chose, not a placeholder');
    assert.equal(keepNamespace({ namespace: "my-agenda" }), "my-agenda");
    assert.equal(keepNamespace({ namespace: "[NOT SET]" }), null);
    assert.equal(keepNamespace({ namespace: "NO" }), null);
    assert.equal(keepNamespace({}), null);
    assert.equal(keepNamespace(null), null);
  });

  it("connectorsOn walks the same tree the preflight does", () => {
    // Exact shape, against a config this test owns - so adding a connector to
    // config.example.json cannot make this fail for the wrong reason.
    const cfg = {
      connectors: {
        lms: { brightspace: { enabled: true }, canvas: { enabled: false } },
        calendar: { ics: { enabled: true }, outlook: { enabled: false } },
        materials: { enabled: true },
      },
      drive: { enabled: true },
    };
    assert.deepEqual(connectorsOn(cfg), ["lms.brightspace", "calendar.ics", "materials", "drive"]);
    assert.deepEqual(connectorsOn({}), []);
    assert.deepEqual(connectorsOn({ drive: { enabled: false } }), []);
  });

  it("what the wizard writes shows up in that walk", () => {
    const on = connectorsOn(buildConfig(EXAMPLE, answers));
    assert.ok(on.includes("lms.brightspace"));
    assert.ok(on.includes("drive"));
    assert.ok(!on.includes("lms.canvas"));
    assert.ok(!connectorsOn(buildConfig(EXAMPLE, { ...answers, lms: "none" })).some((c) => c.startsWith("lms.")));
  });

  it("currentLms reads back what a previous run wrote", () => {
    assert.equal(currentLms(buildConfig(EXAMPLE, { lms: "canvas" })), "canvas");
    assert.equal(currentLms(buildConfig(EXAMPLE, { lms: "brightspace" })), "brightspace");
    assert.equal(currentLms(buildConfig(EXAMPLE, { lms: "none" })), "none");
    assert.equal(currentLms(undefined), "none");
  });

  it("the Brightspace package comes from the config, never from a constant here", () => {
    assert.equal(brightspacePackage(EXAMPLE), EXAMPLE.connectors.lms.brightspace.package);
    assert.equal(brightspacePackage(setIn(EXAMPLE, "connectors.lms.brightspace.package", "x@1.2.3")), "x@1.2.3");
    assert.equal(brightspacePackage({}), "brightspace-mcp-server@latest");
  });

  it("the Windows npx wrapper is applied once and is then a no-op", () => {
    const shipped = readJson(join(REPO, ".mcp.json"));
    const once = wrapNpxForWindows(shipped);
    assert.deepEqual(once.changed, ["brightspace"]);
    assert.equal(once.next.mcpServers.brightspace.command, "cmd");
    assert.deepEqual(once.next.mcpServers.brightspace.args.slice(0, 2), ["/c", "npx"]);
    assert.deepEqual(once.next.mcpServers.brightspace.args.slice(2), shipped.mcpServers.brightspace.args);
    const twice = wrapNpxForWindows(once.next);
    assert.deepEqual(twice.changed, [], "running setup again must not wrap the wrapper");
    assert.equal(twice.next, once.next);
    assert.equal(shipped.mcpServers.brightspace.command, "npx", "the input was not mutated");
  });
});

// ===========================================================================
describe("setup: the terminal and child-process seam", () => {
  const printer = () => {
    const out = [];
    return { out, io: makePrinter((line) => out.push(line)) };
  };

  it("numbers the steps from one, per run, not per process", () => {
    const a = printer();
    a.io.step("first");
    a.io.step("second");
    assert.match(a.out[0], /\[1\] first/);
    assert.match(a.out[1], /\[2\] second/);
    const b = printer();
    b.io.step("first");
    assert.match(b.out[0], /\[1\] first/, "a second printer starts again at [1] - the counter is per run");
    b.io.did("a thing");
    assert.equal(b.out[1], "      a thing");
  });

  it("a child that will not start is a status, never a thrown stack", () => {
    const { run } = makeRunner("/nowhere", () => ({ error: new Error("ENOENT: not-a-real-binary") }));
    assert.deepEqual(run("not-a-real-binary", []), { status: 1, stdout: "", stderr: "ENOENT: not-a-real-binary" });
    const missing = makeRunner("/nowhere", () => ({ status: null, stdout: null, stderr: null }));
    assert.equal(missing.run("x", []).status, 1, "a null status is a failure, not a success");
  });

  it("probe returns the first line, or null, and never throws", () => {
    assert.equal(probe("x", ["--version"], () => ({ status: 0, stdout: "v1.2.3\nextra\n" })), "v1.2.3");
    assert.equal(probe("x", ["--version"], () => ({ status: 0, stdout: "  \n" })), "(no version output)");
    assert.equal(probe("x", ["--version"], () => ({ status: 1, stdout: "" })), null);
    assert.equal(probe("x", ["--version"], () => ({ error: new Error("nope") })), null);
  });

  it("stop says why, how to resume, and with which exit code", () => {
    const said = [];
    const codes = [];
    stop("something broke", "npm run setup", 1, { err: (l) => said.push(l), exit: (c) => codes.push(c) });
    assert.ok(said.join("\n").includes("setup stopped: something broke"));
    assert.ok(said.join("\n").includes("Resume with: npm run setup"));
    assert.deepEqual(codes, [1]);
    stop("no terminal", null, 2, { err: () => {}, exit: (c) => codes.push(c) });
    assert.deepEqual(codes, [1, 2], "2 is the prerequisite code AGENTS.md documents");
  });
});

// ===========================================================================
describe("setup: Step 1, the machine", () => {
  const io = () => {
    const out = [];
    return { out, step: (s) => out.push(s), did: (s) => out.push(s) };
  };

  it("an old Node stops the wizard at exit 2 with this platform's install line", () => {
    const codes = [];
    const said = [];
    const o = io();
    checkMachine(o, { probe: () => null, version: "v20.11.0", platform: "darwin", err: (l) => said.push(l), exit: (c) => codes.push(c) });
    assert.deepEqual(codes, [2]);
    assert.ok(said.join("\n").includes("brew install node@22"), said.join("\n"));
    assert.ok(!o.out.some((l) => l.includes("ok")), "it must not go on to report the machine as fine");
  });

  it("a missing claude is reported and never blocked on", () => {
    const o = io();
    const got = checkMachine(o, { probe: (bin) => (bin === "git" ? "git version 2.46.0" : null), version: "v22.0.0", platform: "linux", arch: "x64" });
    assert.deepEqual(got, { claude: false });
    const text = o.out.join("\n");
    assert.ok(text.includes("git version 2.46.0"));
    assert.ok(text.includes("Claude Code: not found on PATH."));
    assert.ok(text.includes("Linux (x64)"));
  });

  it("a machine with everything answers true", () => {
    assert.deepEqual(
      checkMachine(io(), { probe: () => "2.1.0", version: "v24.0.0", platform: "win32", arch: "x64" }),
      { claude: true },
    );
  });

  it("the minimum matches what package.json engines demands", () => {
    assert.match(readJson(join(REPO, "package.json")).engines.node, new RegExp(`>=\\s*${NODE_MIN}`));
  });
});

// ===========================================================================
describe("setup: the inbound calendar", () => {
  const on = (gcal) => ({ calendars: { gcal } });

  it("off is a NOTE that names the opt-in, never a failure", () => {
    assert.equal(checkGcal({}).level, "NOTE");
    assert.match(checkGcal({}).detail, /inbound calendar: off \(opt-in, docs\/CONFIG\.md\)/);
    assert.equal(checkGcal(on({ enabled: false, feed: "calendar" })).level, "NOTE");
    assert.equal(checkGcal(undefined).level, "NOTE");
  });

  it("on says which feed, and whether the file a run writes is there yet", () => {
    const fresh = checkGcal(on({ enabled: true, feed: "calendar" }), { exists: false });
    assert.equal(fresh.level, "PASS");
    assert.match(fresh.detail, /feed "calendar"/);
    assert.match(fresh.detail, /data\/gcal-items\.json/);
    assert.match(fresh.detail, /not written yet/);
    const ran = checkGcal(on({ enabled: true, feed: "calendar" }), { exists: true, status: "stale" });
    assert.equal(ran.level, "PASS");
    assert.match(ran.detail, /status "stale"/);
  });

  it("only a real boolean true counts as on", () => {
    // Anything else is a config `src/lib/config.mjs` refuses outright, so the
    // preflight's Config validation row carries it and this never runs. It
    // must not read a quoted "true" as on and then describe a route that is
    // dormant.
    for (const enabled of ["true", 1, "yes", {}]) {
      assert.equal(checkGcal(on({ enabled, feed: "calendar" })).level, "NOTE", JSON.stringify(enabled));
    }
  });

  it("does NOT re-implement the loader's shape rules", () => {
    // validateCalendars() in src/lib/config.mjs owns every one of them and runs
    // inside loadConfig, which the preflight calls first. A second copy here is
    // a second, wrong source of truth the first time either moves.
    const src = readFileSync(join(REPO, "scripts", "lib", "setup-gcal.mjs"), "utf8");
    assert.ok(!src.includes("FAIL"), "the inbound-calendar row reports; it does not judge");
    assert.ok(!/maxEvents\s*[<>!=]/.test(src), "maxEvents is the loader's rule");
  });

  it("the shipped example is off, and reads as on the moment it is switched on", () => {
    assert.equal(checkGcal(EXAMPLE).level, "NOTE");
    const live = checkGcal({ calendars: { gcal: { ...EXAMPLE.calendars.gcal, enabled: true } } });
    assert.equal(live.level, "PASS");
    assert.match(live.detail, new RegExp(`feed "${EXAMPLE.calendars.gcal.feed}"`));
  });

  it("connectorsOn names it, so CLAUDE.md's line matches what is actually on", () => {
    assert.ok(connectorsOn(on({ enabled: true, feed: "work" })).includes("inbound calendar (work)"));
    assert.deepEqual(connectorsOn(on({ enabled: false, feed: "work" })), []);
    assert.ok(connectorsOn(on({ enabled: true })).includes("inbound calendar (calendar)"), "the shipped feed id is the default");
  });
});

// ===========================================================================
describe("setup: what the package ships", () => {
  const pkg = readJson(join(REPO, "package.json"));

  it("ships every file setup and the onboarding agent read", () => {
    // setup.mjs hard-fails without config.example.json, and the onboarding
    // agent is `.claude/agents/onboarding.md` reading AGENTS.md and CLAUDE.md.
    for (const f of ["config.example.json", "AGENTS.md", "CLAUDE.md", ".claude", "scripts"]) {
      assert.ok(pkg.files.includes(f), `package.json "files" omits ${f}`);
    }
  });

  it("every entry in files exists in this checkout", () => {
    for (const f of pkg.files) assert.ok(existsSync(join(REPO, f)), `package.json "files" names ${f}, which is not here`);
  });
});

// ===========================================================================
describe("setup: CLAUDE.md Part 2", () => {
  it("the shipped CLAUDE.md has all six sentinels", () => {
    assert.equal(hasSentinels(CLAUDE_MD), true);
    const fields = readFields(CLAUDE_MD);
    for (const f of FIELDS) assert.ok(fields[f]?.includes(SENTINEL_PREFIX), `**${f}:** does not carry ${SENTINEL_PREFIX}`);
  });

  it("the **Configured:** line is NOT the bare sentinel, and is still detected", () => {
    // It ships as `[NOT SET - type "hey" to run setup]`. Matching only the
    // closed form would read an untouched repository as already set up.
    assert.equal(readFields(CLAUDE_MD).Configured.includes(SENTINEL), false);
    assert.equal(hasSentinels(fillSentinels(CLAUDE_MD, { Timezone: "UTC", School: "x", Courses: "y", "User style": "z", "Connectors on": "drive" })), true,
      "five of six filled still counts as unfinished");
  });

  it("filling it leaves no sentinel in any of the six fields", () => {
    const filled = fillSentinels(CLAUDE_MD, fieldValues({
      date: "2026-09-03",
      timezone: "America/New_York",
      schoolName: "Example University",
      lmsHost: "lms.example.edu",
      courses: null,
      userStyle: USER_STYLES.hands_off,
      connectors: ["lms.brightspace", "drive"],
    }));
    assert.equal(hasSentinels(filled), false);
    const fields = readFields(filled);
    assert.equal(fields.Configured, "yes, 2026-09-03");
    assert.equal(fields.Timezone, "America/New_York");
    assert.equal(fields.School, "Example University (lms.example.edu)");
    assert.equal(fields.Courses, PENDING.courses);
    assert.equal(fields["User style"], USER_STYLES.hands_off);
    assert.equal(fields["Connectors on"], "lms.brightspace, drive");
  });

  it("matches the block .claude/agents/onboarding.md Step 11 writes, field for field", () => {
    // The agent's own example, verbatim from that file. Both routes must produce
    // this shape or a wizard user gets the setup agent again on their next hello.
    const filled = fillSentinels(CLAUDE_MD, {
      Configured: "yes, 2026-09-02",
      Timezone: "America/New_York",
      School: "Example University (lms.example.edu)",
      Courses: "PHYS 221, MATH 210, CHEM 115, HIST 140 (SEM 100 skipped)",
      "User style": "just do it — never show commands, report results in plain English",
      "Connectors on": "lms.brightspace, drive",
    });
    assert.ok(filled.includes("**Configured:** yes, 2026-09-02\n**Timezone:** America/New_York\n**School:** Example University (lms.example.edu)\n"));
    assert.ok(filled.includes("**Courses:** PHYS 221, MATH 210, CHEM 115, HIST 140 (SEM 100 skipped)\n"));
    assert.ok(filled.includes("**Connectors on:** lms.brightspace, drive\n"));
    assert.equal(hasSentinels(filled), false);
  });

  it("only the six field lines are touched - Part 1's prose keeps its [NOT SET]s", () => {
    const before = (CLAUDE_MD.match(/\[NOT SET/g) ?? []).length;
    const filled = fillSentinels(CLAUDE_MD, fieldValues({ date: "2026-09-03", timezone: "UTC", userStyle: USER_STYLES.terminal, connectors: [] }));
    const after = (filled.match(/\[NOT SET/g) ?? []).length;
    assert.equal(before - after, FIELDS.length, "exactly six sentinels should have gone");
    assert.ok(after > 0, "Part 1 explains what [NOT SET] means and must survive");
    assert.ok(filled.includes("`**User style:**` in Part 2"), "the Part 1 mention of the field name is not a field line");
  });

  it("a field left out of the values is left exactly as it was", () => {
    const once = fillSentinels(CLAUDE_MD, { Timezone: "Europe/Lisbon" });
    assert.equal(readFields(once).Timezone, "Europe/Lisbon");
    assert.ok(readFields(once).Courses.includes(SENTINEL));
  });

  it("never mutates the text it was handed", () => {
    const copy = String(CLAUDE_MD);
    fillSentinels(CLAUDE_MD, { Timezone: "Europe/Lisbon" });
    assert.equal(CLAUDE_MD, copy);
  });

  it("a value with a $ in it lands literally, not as a replacement pattern", () => {
    assert.equal(readFields(fillSentinels(CLAUDE_MD, { School: "A$B$&C" })).School, "A$B$&C");
  });

  it("refuses a field name it does not know, rather than silently doing nothing", () => {
    assert.throws(() => fillSentinels(CLAUDE_MD, { Timezoen: "UTC" }), /not one of the Part 2 fields/);
  });

  it("a duplicated field line is a hard error, never a silent pick", () => {
    // Both halves used to look at the FIRST match only, so a Part 2 with two
    // **Timezone:** lines left one sentinel behind - which re-triggers the
    // onboarding agent - while run 2 reported "already filled in".
    const dup = CLAUDE_MD.replace("**Timezone:** [NOT SET]", "**Timezone:** [NOT SET]\n**Timezone:** America/New_York");
    assert.throws(() => fillSentinels(dup, { Timezone: "Europe/Paris" }), /appears 2 times/);
    assert.throws(() => hasSentinels(dup), /appears 2 times/);
    assert.throws(() => readFields(dup), /appears 2 times/);
    for (const fn of [() => fillSentinels(dup, { Timezone: "x" }), () => hasSentinels(dup)]) {
      assert.throws(fn, /git checkout CLAUDE\.md/, "the fix line must match the missing-line error's style");
    }
  });

  it("says so loudly when Part 2 has been edited out of shape", () => {
    assert.throws(() => fillSentinels("# a file with no Part 2", { Timezone: "UTC" }), /no "\*\*Timezone:\*\*" line/);
  });

  it("an unanswered school or course list becomes a next action, never a sentinel", () => {
    const v = fieldValues({ date: "2026-09-03", timezone: "UTC", userStyle: USER_STYLES.terminal, connectors: [] });
    assert.equal(v.School, PENDING.school);
    assert.equal(v.Courses, PENDING.courses);
    assert.equal(v["Connectors on"], "none yet");
    for (const value of Object.values(v)) assert.ok(!value.includes(SENTINEL), `"${value}" would re-trigger the setup agent`);
  });

  it("the date is the user's day, not UTC's", () => {
    assert.equal(isoDate(new Date(2026, 8, 3, 23, 30)), "2026-09-03");
    assert.match(isoDate(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ===========================================================================
describe("setup: the schedule plan", () => {
  const cfg = { scheduler: SCHEDULER_DEFAULTS };

  it("Windows delegates to the installer that already exists", () => {
    const plan = schedulePlan("win32", "C:\\Users\\student\\my-agenda", cfg);
    assert.equal(plan.kind, "windows");
    assert.deepEqual(plan.commands, ["scripts\\install-tasks.cmd"]);
    assert.deepEqual(plan.files, [], "nothing is generated - install-tasks.cmd owns Task Scheduler");
    assert.equal(plan.tasks.length, 3, "docs/SCHEDULING.md documents three tasks");
    for (const name of ["Daily", "StaleCheck", "AuthRetry"]) {
      assert.ok(plan.tasks.some((t) => t.startsWith(`Agenda ${name}`)), `no task for ${name}`);
    }
    assert.ok(plan.tasks[0].includes("run-daily.cmd"), "the daily task runs the launcher, not a model");
    assert.ok(plan.tasks[0].includes("10:30"));
    for (const gone of ["Agenda Morning", "Agenda Evening", "Agenda Sync"]) {
      assert.ok(!plan.tasks.some((t) => t.startsWith(gone)), `${gone} is retired and must not be installed`);
    }
  });

  it("Windows tells an upgrader what to do about the three retired tasks", () => {
    // Left registered they point at launchers 2.0.0 deleted, and fail daily.
    // Deleted without being asked, an installer has reached outside its brief.
    const notes = schedulePlan("win32", "C:\\x", cfg).notes.join(" ");
    assert.ok(notes.includes("Agenda Morning"), notes);
    assert.ok(notes.includes("/remove-legacy"), notes);
  });

  it("Windows task names follow scheduler.taskPrefix", () => {
    const plan = schedulePlan("win32", "C:\\x", { scheduler: { ...SCHEDULER_DEFAULTS, taskPrefix: "Study" } });
    assert.ok(plan.tasks.every((t) => t.startsWith("Study ")));
  });

  it("macOS writes the two documented plists with THIS checkout's path", () => {
    const plan = schedulePlan("darwin", "/Users/student/my-agenda", cfg);
    assert.equal(plan.kind, "launchd");
    assert.deepEqual(plan.files.map((f) => f.path), [
      "~/Library/LaunchAgents/com.agenda.daily.plist",
      "~/Library/LaunchAgents/com.agenda.auth.plist",
    ]);
    for (const f of plan.files) {
      assert.ok(f.content.includes('cd "/Users/student/my-agenda"'), `${f.path} does not cd into the real clone`);
      assert.ok(!f.content.includes("$HOME/my-agenda"), `${f.path} still has the doc's placeholder`);
      assert.ok(f.content.startsWith('<?xml version="1.0"'), `${f.path} is not a plist`);
    }
    const daily = plan.files[0].content;
    assert.ok(daily.includes("<key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer>"));
    assert.ok(daily.includes("&amp;&amp;"), "&& must be XML-escaped inside a plist string");
    assert.ok(daily.includes("node scripts/run-daily.mjs"));
    assert.ok(daily.includes("data/runlog-stdout.txt"));
    assert.ok(plan.files[1].content.includes("node src/auth-retry.mjs"));
    assert.ok(plan.files[1].content.includes("<key>RunAtLoad</key><true/>"), "the auth lane runs at load; the daily run does not");
    assert.ok(daily.includes("<key>RunAtLoad</key><false/>"));
    assert.ok(plan.commands.some((c) => c.startsWith("launchctl load")));
  });

  it("no platform hands a tool allow-list to the scheduler any more", () => {
    // 1.x pasted `claude -p --allowedTools ...` into every plist and cron line,
    // and the three drifted apart. scripts/run-daily.mjs owns the model window
    // now, so nothing here may name a tool, a model or a runbook.
    for (const p of ["darwin", "linux"]) {
      const text = schedulePlan(p, "/Users/s/a", cfg).files.map((f) => f.content).join("\n");
      assert.ok(!text.includes("claude -p"), `${p} still schedules the model directly`);
      assert.ok(!text.includes("mcp__"), `${p} still carries an MCP allow-list`);
      assert.ok(!text.includes("--allowedTools"), `${p} still carries a tool allow-list`);
      assert.ok(!text.includes("runbooks/"), `${p} still names a runbook the launcher owns`);
    }
  });

  it("Linux writes the two documented cron lines against a real AGENDA path", () => {
    const plan = schedulePlan("linux", "/home/student/my-agenda", cfg);
    assert.equal(plan.kind, "cron");
    const text = plan.files[0].content;
    assert.ok(text.includes('AGENDA="/home/student/my-agenda"'));
    assert.ok(text.includes("PATH=/usr/local/bin:/usr/bin:/bin"), "cron's environment is nearly empty");
    assert.ok(text.includes('30 10 * * * cd "$AGENDA" && node scripts/run-daily.mjs >> data/runlog-stdout.txt 2>&1'));
    assert.ok(text.includes('4 * * * * cd "$AGENDA" && node src/auth-retry.mjs'));
    assert.equal(text.split("\n").filter((l) => /^[0-9]/.test(l)).length, 2, "two jobs, not four");
    assert.ok(plan.commands.some((c) => c.startsWith("crontab -e")));
  });

  it("a clone path with a space still produces cron jobs that run", () => {
    // cron word-splits an unquoted assignment, `cd` then fails on half a path,
    // and `&&` swallows the rest of the line. Nothing is printed anywhere: the
    // crontab looks perfectly installed and no agenda ever arrives.
    const text = schedulePlan("linux", "/home/sam/my agenda", {}).files[0].content;
    assert.ok(text.includes('AGENDA="/home/sam/my agenda"'), `AGENDA must be quoted:\n${text}`);
    assert.ok(!/cd \$AGENDA(?!")/.test(text), `every cd must quote $AGENDA:\n${text}`);
    for (const line of text.split("\n").filter((l) => /^[0-9]/.test(l))) {
      assert.ok(line.includes('cd "$AGENDA" &&'), line);
    }
  });

  it("the macOS plists quote the checkout path too", () => {
    for (const f of schedulePlan("darwin", "/Users/sam/my agenda", {}).files) {
      assert.ok(f.content.includes('cd "/Users/sam/my agenda" &amp;&amp;'), `${f.path} does not quote the path`);
    }
  });

  it("a changed dailyAt reaches every generated file", () => {
    const cfg2 = { scheduler: { ...SCHEDULER_DEFAULTS, dailyAt: "06:15" } };
    assert.ok(schedulePlan("linux", "/a", cfg2).files[0].content.includes("15 6 * * *"));
    assert.ok(
      schedulePlan("darwin", "/a", cfg2).files[0].content.includes(
        "<key>Hour</key><integer>6</integer><key>Minute</key><integer>15</integer>",
      ),
    );
    assert.ok(schedulePlan("win32", "C:\\a", cfg2).tasks[0].includes("06:15"));
  });

  it("an undocumented platform generates nothing rather than guessing", () => {
    const plan = schedulePlan("freebsd", "/home/s/a", cfg);
    assert.equal(plan.kind, "undocumented");
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.commands, []);
    assert.ok(plan.notes.join(" ").includes("freebsd"));
  });

  it("a missing or malformed scheduler block falls back to the shipped defaults", () => {
    assert.ok(schedulePlan("linux", "/a", {}).files[0].content.includes("30 10 * * *"));
    assert.ok(schedulePlan("linux", "/a", { scheduler: { dailyAt: "nope" } }).files[0].content.includes("30 10 * * *"));
    assert.ok(schedulePlan("linux", "/a", { scheduler: { dailyAt: "25:99" } }).files[0].content.includes("30 10 * * *"));
  });

  it("a config still carrying the 1.x keys schedules one run, not three", () => {
    const legacy = {
      scheduler: { taskPrefix: "Agenda", morningAt: "07:03", eveningAt: "18:07", syncWindow: ["09:00", "23:00"], syncGapHours: 3 },
    };
    const text = schedulePlan("linux", "/a", legacy).files[0].content;
    assert.ok(text.includes("30 10 * * *"), text);
    assert.ok(!text.includes("3 7 * * *"), "morningAt names a lane that no longer exists");
    assert.equal(schedulePlan("win32", "C:\\a", legacy).tasks.length, 3);
    assert.deepEqual(parseHM("10:30", "00:00"), { h: 10, m: 30 });
    assert.deepEqual(parseHM("bad", "10:30"), { h: 10, m: 30 });
  });

  it("the shipped scheduler defaults match config.example.json", () => {
    for (const [k, v] of Object.entries(SCHEDULER_DEFAULTS)) assert.deepEqual(EXAMPLE.scheduler[k], v, `scheduler.${k} has drifted`);
  });
});

// ===========================================================================
describe("setup: reading the preflight, and the closing summary", () => {
  const TABLE = [
    "  PASS  Node 22 or newer               v24.12.0",
    "  FAIL  Your courses                   still the example courses (PHYS 221) - setup did not get that far",
    "  FAIL  data/ is writable              cannot write to data/: EACCES",
    "  WARN  git on PATH                    not found",
  ].join("\n");

  it("picks the FAIL rows out of the table", () => {
    assert.deepEqual(parseFails(TABLE), ["Your courses", "data/ is writable"]);
    assert.deepEqual(parseFails(""), []);
  });

  it("knows which failures are the correct state at the end of setup", () => {
    assert.equal(isExpectedFail("Your courses"), true);
    assert.equal(isExpectedFail("An LMS source is enabled"), true);
    assert.equal(isExpectedFail("lms-canvas can run here"), true);
    // rclone needs an install and ONE consent click in a browser. A wizard
    // cannot click Allow, so handing this over is the CORRECT end of setup.
    assert.equal(isExpectedFail("Drive transport (rclone)"), true);
    assert.equal(isExpectedFail("data/ is writable"), false, "an unwritable data/ is a real problem");
    assert.equal(isExpectedFail("Config validation"), false, "a config that will not load is a real problem");
    assert.equal(isExpectedFail("Repository layout"), false);
    assert.equal(isExpectedFail("The model window"), false, "an unset llm.model is a real problem");
  });

  it("the closing summary names every human step and its doc section", () => {
    const text = nextSteps({ fails: ["Your courses"] }, { claude: true }).join("\n");
    assert.ok(text.includes("docs/SETUP.md, Steps 6 and 7"));
    assert.ok(text.includes("docs/SETUP.md, Step 8"));
    assert.ok(text.includes("docs/SETUP.md, Step 9.1"));
    assert.ok(text.includes("docs/ARTIFACT.md, section 2"));
    assert.ok(text.includes("docs/SETUP.md, Step 10"));
    assert.ok(text.includes("npm run health"), "the way to check on it later");
    assert.ok(text.includes("Your courses"));
  });

  it("an unexpected preflight failure is listed apart from the ones a step closes", () => {
    // Step 4 already called this one UNEXPECTED. Folding it into "every one of
    // those is closed by a numbered step above" tells the user a broken clone
    // is the normal end of setup.
    const text = nextSteps(
      { fails: ["Your courses", "Sample data for demo mode"], unexpected: ["Sample data for demo mode"] },
      { claude: true },
    ).join("\n");
    const closed = text.split("\n").find((l) => l.includes("still fails on:")) ?? "";
    assert.ok(closed.includes("Your courses"), text);
    assert.ok(!closed.includes("Sample data for demo mode"), `an unexpected failure must not be called closed:\n${text}`);
    assert.match(text, /UNEXPECTED/);
    assert.ok(text.includes("Sample data for demo mode"));
  });

  it("with nothing unexpected the summary reads exactly as it always did", () => {
    const text = nextSteps({ fails: ["Your courses"], unexpected: [] }, { claude: true }).join("\n");
    assert.ok(text.includes("Every one of those is closed by a numbered step above."));
    assert.ok(!text.includes("UNEXPECTED"));
  });

  it("when every failure is unexpected there is no closed-by-a-step list at all", () => {
    const text = nextSteps({ fails: ["Repository layout"], unexpected: ["Repository layout"] }, { claude: true }).join("\n");
    assert.ok(!text.includes("still fails on:"), text);
    assert.match(text, /UNEXPECTED[\s\S]*Repository layout/);
  });

  it("says so when Claude Code is missing, because three of the five steps need it", () => {
    assert.ok(nextSteps({ fails: [] }, { claude: false }).join("\n").includes("claude.com/claude-code"));
    assert.ok(!nextSteps({ fails: [] }, { claude: true }).join("\n").includes("Claude Code is not installed"));
  });

  // -------------------------------------------------------------------------
  //  Drive over rclone
  //
  //  Two things the wizard can only ever PRINT: a package install, and a Google
  //  consent screen. The one rule these tests defend is the second one - a
  //  setup run with --yes in a terminal nobody is watching must never start a
  //  command that opens a browser and blocks on a human.
  // -------------------------------------------------------------------------
  const DRIVE_ON = { drive: { enabled: true, rcloneRemote: "agenda" } };

  it("the Drive step prints the install line for a machine with no rclone", () => {
    const text = rcloneSteps("win32", DRIVE_ON, null).join("\n");
    assert.ok(text.includes("rclone is not installed"));
    assert.ok(text.includes(RCLONE_INSTALL.win32), text);
    assert.ok(text.includes("rclone config create agenda drive scope=drive"));
    assert.ok(text.includes("node src/drive-rclone.mjs status"));
    for (const [p, line] of Object.entries(RCLONE_INSTALL)) {
      assert.ok(rcloneSteps(p, DRIVE_ON, null).join("\n").includes(line), `${p} has no install line`);
    }
    assert.ok(rcloneSteps("sunos", DRIVE_ON, null).join("\n").includes("rclone.org/install"), "an unknown platform still gets a URL");
  });

  it("with rclone present it still only asks for the one consent click", () => {
    const text = rcloneSteps("darwin", DRIVE_ON, "rclone v1.68.2").join("\n");
    assert.ok(text.includes("rclone is installed: rclone v1.68.2"));
    assert.ok(!text.includes(RCLONE_INSTALL.darwin), "do not tell somebody to install what they have");
    assert.ok(text.includes(rcloneConsent("agenda")));
  });

  it("the consent command names the configured remote, never a hardcoded one", () => {
    assert.equal(rcloneConsent("study"), "rclone config create study drive scope=drive");
    const text = rcloneSteps("linux", { drive: { enabled: true, rcloneRemote: "study" } }, null).join("\n");
    assert.ok(text.includes("rclone config create study drive scope=drive"), text);
    // ...and an unset remote falls back to the documented default rather than
    // printing `rclone config create undefined`.
    assert.ok(rcloneSteps("linux", { drive: { enabled: true } }, null).join("\n").includes("create agenda drive"));
  });

  it("the Drive step says so and stops when Drive is off", () => {
    const text = rcloneSteps("win32", { drive: { enabled: false } }, null).join("\n");
    assert.ok(text.includes("off in config.json"));
    assert.ok(!text.includes("rclone config create"), "nothing to consent to when nothing is published");
    assert.ok(!rcloneSteps("win32", {}, null).join("\n").includes("rclone config create"));
  });

  it("the Drive step promises, in words, that it never runs the consent command", () => {
    // A browser that opens and waits for a click is the one thing `npm run
    // setup --yes` must not start. The user has to be able to read that here.
    const text = rcloneSteps("win32", DRIVE_ON, "rclone v1.68.2").join("\n");
    assert.match(text, /never runs the consent command/i);
  });

  it("openCommand knows each platform, and shrugs at one it does not", () => {
    assert.equal(openCommand("win32", "demo-agenda.html"), "start demo-agenda.html");
    assert.equal(openCommand("darwin", "demo-agenda.html"), "open demo-agenda.html");
    assert.equal(openCommand("linux", "demo-agenda.html"), "xdg-open demo-agenda.html");
    assert.equal(openCommand("sunos", "demo-agenda.html"), "demo-agenda.html");
  });
});

// ===========================================================================
describe("setup: asking", () => {
  const canned = (answers) => {
    const queue = [...answers];
    return async () => queue.shift() ?? "";
  };

  it("a null readline means every fallback is taken, silently", async () => {
    const ask = makeAsk(null);
    assert.equal(await ask("anything?", "the-default"), "the-default");
    assert.equal(await ask("anything?"), "");
  });

  it("an empty answer means the fallback, a typed one wins", async () => {
    const ask = makeAsk({ question: async () => "  \n" });
    assert.equal(await ask("q", "fallback"), "fallback");
    assert.equal(await makeAsk({ question: async () => " typed " })("q", "fallback"), "typed");
  });

  it("askChoice re-asks until the answer is in the set", async () => {
    const said = [];
    const got = await askChoice(canned(["maybe", "CANVAS"]), "which?", LMS_CHOICES, "brightspace", (l) => said.push(l));
    assert.equal(got, "canvas", "the answer is matched case-insensitively");
    assert.equal(said.length, 1);
    assert.match(said[0], /"maybe" is not one of brightspace, canvas, none/);
  });

  it("askUntil gives up rather than looping forever on an unreachable fallback", async () => {
    const said = [];
    const got = await askUntil(makeAsk(null), "q", "not-valid", () => false, (a) => `no: ${a}`, (l) => said.push(l));
    assert.equal(got, null, "under --yes the fallback repeats forever, so the loop must be bounded");
    assert.equal(said.length, TRIES);
  });

  it("yesNo takes anything starting with y as yes", async () => {
    assert.equal(await yesNo(canned(["Y"]), "?"), true);
    assert.equal(await yesNo(canned(["yes"]), "?"), true);
    assert.equal(await yesNo(canned(["n"]), "?"), false);
    assert.equal(await yesNo(canned([""]), "?", "n"), false, "the default is no for anything that reaches outside this folder");
  });
});

// ===========================================================================
describe("setup: the shell launchers", () => {
  const SH = readFileSync(join(REPO, "setup.sh"), "utf8");
  const bash = (() => {
    const r = spawnSync("bash", ["--version"], { encoding: "utf8", windowsHide: true });
    return r.error || r.status !== 0 ? null : "bash";
  })();

  it('forwards its arguments in the form bash 3.2 can expand under set -u', () => {
    // Stock macOS ships bash 3.2, where `set -u` makes a bare "$@" with zero
    // arguments an UNBOUND VARIABLE error: `./setup.sh` with no flags - the
    // documented way to run it - dies before it reaches npm. `${1+"$@"}` is
    // the portable form and expands to nothing at all when there is nothing.
    assert.ok(SH.includes('${1+"$@"}'), "setup.sh must forward with ${1+\"$@\"}");
    assert.ok(!/npm run setup -- "\$@"/.test(SH), 'a bare "$@" is the bash 3.2 trap');
    assert.ok(SH.includes("set -euo pipefail"), "the fix is the expansion, not dropping set -u");
  });

  it("setup.cmd forwards its arguments through the npm separator", () => {
    assert.match(readFileSync(join(REPO, "setup.cmd"), "utf8"), /call npm run setup -- %\*/);
  });

  it("runs with zero, one and space-carrying arguments", { timeout: 60000 }, (t) => {
    if (!bash) return t.skip("no bash on this machine - the CI matrix covers it on both runners");
    const dir = mkdtempSync(join(tmpdir(), "agenda-sh-"));
    try {
      // The real file, with only the `npm` call swapped for a stub that prints
      // what it was handed. Everything the test is about - set -u, the guard
      // clauses, the expansion - is byte-for-byte setup.sh's own text.
      const stub = join(dir, "stub.sh").replace(/\\/g, "/");
      writeFileSync(stub, '#!/bin/sh\nprintf "argc=%s\\n" "$#"\nfor a in "$@"; do printf "<%s>\\n" "$a"; done\n', "utf8");
      const copy = join(dir, "setup.sh");
      assert.ok(SH.includes("npm run setup --"), "setup.sh no longer calls npm the way this test patches");
      writeFileSync(copy, SH.replace("npm run setup --", `sh "${stub}" --`), "utf8");

      // Forward slashes: bash is the interpreter on both runners, and a
      // backslashed path reaches it as an escape sequence rather than a path.
      const run = (args) => spawnSync("bash", [copy.replace(/\\/g, "/"), ...args], { cwd: dir, encoding: "utf8", windowsHide: true });

      const none = run([]);
      assert.equal(none.status, 0, `zero arguments must not be an unbound variable:\n${none.stdout}\n${none.stderr}`);
      assert.ok(!/unbound variable/.test(none.stderr), none.stderr);
      assert.match(none.stdout, /argc=1\n<-->/);

      const one = run(["--yes"]);
      assert.equal(one.status, 0, one.stderr);
      assert.match(one.stdout, /argc=2\n<-->\n<--yes>/);

      const spaced = run(["--yes", "a b"]);
      assert.equal(spaced.status, 0, spaced.stderr);
      assert.match(spaced.stdout, /argc=3\n<-->\n<--yes>\n<a b>/, "a quoted argument must arrive as one word");
    } finally {
      cleanup(dir);
    }
  });
});

// ===========================================================================
//  End to end: the real script, in a temp directory
// ===========================================================================
describe("setup: end to end", () => {
  /** Everything the wizard and the preflight touch. Nothing from data/. */
  const NEEDED = ["src", "web", "runbooks", "fixtures", "scripts", "config.example.json", "CLAUDE.md", "package.json", ".mcp.json"];

  function stage() {
    const dir = mkdtempSync(join(tmpdir(), "agenda-setup-"));
    for (const name of NEEDED) cpSync(join(REPO, name), join(dir, name), { recursive: true });
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", ".gitkeep"), "");
    return dir;
  }

  const runSetup = (dir, args) =>
    spawnSync(process.execPath, [join(dir, "scripts", "setup.mjs"), ...args], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      // A CI runner's zone is whatever the image says; pin it so the assertion
      // below is about the wizard, not about the machine it happens to run on.
      env: { ...process.env, TZ: "America/New_York", AGENDA_PREFLIGHT_NO_NETWORK: "1" },
    });

  const BASE = ["--yes", "--no-demo", "--skip-auth", "--skip-schedule"];

  // No test may reach a network or spawn rclone, and the preflight's Drive
  // check does both when rclone happens to be installed on the machine running
  // the suite. This is the documented way out; `scripts/validate-setup.mjs`
  // explains why the check exists at all.
  const OFFLINE = { ...process.env, AGENDA_PREFLIGHT_NO_NETWORK: "1" };

  it("runs clean, writes a loadable config, and leaves no sentinel behind", { timeout: 120000 }, () => {
    const dir = stage();
    try {
      const r = runSetup(dir, BASE);
      assert.equal(r.status, 0, `setup exited ${r.status}\n${r.stdout}\n${r.stderr}`);

      // config.json: written, parses, and carries the answers.
      const cfg = readJson(join(dir, "config.json"));
      assert.equal(cfg.timezone, "America/New_York");
      assert.match(cfg.namespace, /^[a-z0-9-]{3,24}$/);
      assert.equal(cfg.connectors.lms.brightspace.enabled, true);

      // The preflight accepts it: the config loads and every enabled feature
      // has what it needs. The table still FAILs on "Your courses", which is
      // the correct handover - Step 6 needs a live LMS call.
      const doctor = spawnSync(process.execPath, [join(dir, "scripts", "validate-setup.mjs")], { cwd: dir, encoding: "utf8", windowsHide: true, env: OFFLINE });
      assert.match(doctor.stdout, /PASS {2}Config validation/, doctor.stdout);
      assert.match(doctor.stdout, /PASS {2}config\.json/);
      assert.deepEqual(parseFails(doctor.stdout).filter((f) => !isExpectedFail(f)), [], doctor.stdout);
      assert.ok(parseFails(doctor.stdout).includes("Your courses"), "the courses handover must stay visible, not be papered over");

      // CLAUDE.md: no sentinel left in any of the six Part 2 fields.
      const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      assert.equal(hasSentinels(md), false, `still has a sentinel:\n${JSON.stringify(readFields(md), null, 2)}`);
      const fields = readFields(md);
      assert.match(fields.Configured, /^yes, \d{4}-\d{2}-\d{2}$/);
      assert.equal(fields.Timezone, "America/New_York");
      assert.equal(fields["Connectors on"], "lms.brightspace, drive");
      assert.ok(md.includes("`**User style:**` in Part 2"), "Part 1 must be untouched");

      // And it said what is left, rather than implying it is finished.
      assert.match(r.stdout, /What happens next/);
      assert.match(r.stdout, /docs\/ARTIFACT\.md/);
    } finally {
      cleanup(dir);
    }
  });

  it("is re-runnable: a second run changes nothing", { timeout: 120000 }, () => {
    const dir = stage();
    try {
      assert.equal(runSetup(dir, BASE).status, 0);
      const after1 = ["config.json", "CLAUDE.md", ".mcp.json"].map((f) => readFileSync(join(dir, f), "utf8"));
      const second = runSetup(dir, BASE);
      assert.equal(second.status, 0, second.stderr);
      const after2 = ["config.json", "CLAUDE.md", ".mcp.json"].map((f) => readFileSync(join(dir, f), "utf8"));
      assert.deepEqual(after2, after1, "a second run must be a no-op");
      assert.match(second.stdout, /Part 2 is already filled in/);
    } finally {
      cleanup(dir);
    }
  });

  it("--agent leaves the sentinels for the onboarding agent", { timeout: 120000 }, () => {
    const dir = stage();
    try {
      const r = runSetup(dir, [...BASE, "--agent"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(hasSentinels(readFileSync(join(dir, "CLAUDE.md"), "utf8")), true);
      assert.ok(existsSync(join(dir, "config.json")), "--agent still writes the config");
      assert.match(r.stdout, /left the \[NOT SET\] block exactly as it is/);
    } finally {
      cleanup(dir);
    }
  });

  it("an unknown flag stops before anything is written", { timeout: 60000 }, () => {
    const dir = stage();
    try {
      const r = runSetup(dir, ["--yolo"]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /unknown flag "--yolo"/);
      assert.equal(existsSync(join(dir, "config.json")), false, "nothing may be written before the arguments are understood");
    } finally {
      cleanup(dir);
    }
  });

  it("refuses to guess when there is no terminal and no --yes", { timeout: 60000 }, () => {
    const dir = stage();
    try {
      const r = runSetup(dir, ["--no-demo", "--skip-auth", "--skip-schedule"]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /no terminal here/);
      assert.equal(existsSync(join(dir, "config.json")), false);
    } finally {
      cleanup(dir);
    }
  });

  it("a namespace already in config.json is never rewritten", { timeout: 120000 }, () => {
    // The temp folder is called agenda-setup-XXXXXX, so the folder slug is a
    // valid namespace and would happily overwrite this one - renaming all four
    // Drive documents and freezing a page that has already been published.
    const dir = stage();
    try {
      const seed = { ...readJson(join(dir, "config.example.json")), namespace: "agenda", timezone: "America/New_York" };
      writeFileSync(join(dir, "config.json"), `${JSON.stringify(seed, null, 2)}\n`, "utf8");
      const r = runSetup(dir, BASE);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(readJson(join(dir, "config.json")).namespace, "agenda", "an existing namespace is kept, always");
      assert.match(r.stdout, /Keeping the namespace/);
    } finally {
      cleanup(dir);
    }
  });

  it("a fresh clone still gets the folder slug suggested", { timeout: 120000 }, () => {
    const dir = stage();
    try {
      assert.equal(runSetup(dir, BASE).status, 0);
      assert.equal(readJson(join(dir, "config.json")).namespace, basename(dir).toLowerCase());
    } finally {
      cleanup(dir);
    }
  });

  it("EOF at a question stops at exit 2 instead of exiting 0 having done nothing", { timeout: 60000 }, () => {
    // Ctrl+D, or a closed stdin. The awaited question never settled, so the
    // wizard fell off the end of main() silently: exit 0, no output, no files.
    const dir = stage();
    try {
      const r = spawnSync(process.execPath, [join(dir, "scripts", "setup.mjs"), "--no-demo", "--skip-auth", "--skip-schedule"], {
        cwd: dir,
        encoding: "utf8",
        windowsHide: true,
        input: "",
        env: { ...process.env, TZ: "America/New_York", SETUP_FAKE_TTY: "1", AGENDA_PREFLIGHT_NO_NETWORK: "1" },
      });
      assert.equal(r.status, 2, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /setup stopped: no answer given/);
      assert.match(r.stderr, /--yes/, "it must name the way out");
      assert.equal(existsSync(join(dir, "config.json")), false, "no answer means nothing is written");
    } finally {
      cleanup(dir);
    }
  });

  it("an unexpected preflight failure ends the wizard at exit 1, listed on its own", { timeout: 120000 }, () => {
    const dir = stage();
    try {
      cleanup(join(dir, "fixtures", "demo"));
      const r = runSetup(dir, BASE);
      assert.equal(r.status, 1, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      const unexpected = r.stdout.split("\n").find((l) => l.includes("UNEXPECTED preflight failure")) ?? "";
      const closed = r.stdout.split("\n").find((l) => l.includes("still fails on:")) ?? "";
      assert.ok(unexpected.includes("Sample data for demo mode"), r.stdout);
      assert.ok(closed.includes("Your courses"), r.stdout);
      assert.ok(!closed.includes("Sample data for demo mode"), `the two lists must stay distinct:\n${r.stdout}`);
    } finally {
      cleanup(dir);
    }
  });

  it("a flag npm ate is refused rather than guessed at", { timeout: 60000 }, () => {
    // `npm run setup --yes` gives --yes to npm. argv is empty and npm exports
    // npm_config_yes instead, so the wizard would run interactively while the
    // user believes they asked for every default.
    const dir = stage();
    try {
      const r = spawnSync(process.execPath, [join(dir, "scripts", "setup.mjs")], {
        cwd: dir,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, TZ: "America/New_York", npm_config_yes: "true", AGENDA_PREFLIGHT_NO_NETWORK: "1" },
      });
      assert.equal(r.status, 1, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /you passed --yes to npm, not to setup/);
      assert.match(r.stderr, /npm run setup -- --yes/);
      assert.equal(existsSync(join(dir, "config.json")), false, "it fails closed - it never guesses the flag was meant");
    } finally {
      cleanup(dir);
    }
  });

  it("the preflight has a line for the inbound calendar, on or off", { timeout: 120000 }, () => {
    const dir = stage();
    const doctor = () => spawnSync(process.execPath, [join(dir, "scripts", "validate-setup.mjs")], { cwd: dir, encoding: "utf8", windowsHide: true, env: OFFLINE });
    const setGcal = (gcal) => {
      const cfg = readJson(join(dir, "config.json"));
      writeFileSync(join(dir, "config.json"), `${JSON.stringify({ ...cfg, calendars: { gcal } }, null, 2)}\n`, "utf8");
    };
    try {
      assert.equal(runSetup(dir, BASE).status, 0);
      assert.match(doctor().stdout, /NOTE {2}Inbound calendar\s+inbound calendar: off \(opt-in, docs\/CONFIG\.md\)/, doctor().stdout);

      setGcal({ enabled: true, calendarId: "primary", feed: "calendar", label: "Calendar", maxEvents: 200 });
      const on = doctor();
      assert.match(on.stdout, /PASS {2}Inbound calendar\s+on, feed "calendar"/, on.stdout);
      assert.match(on.stdout, /gcal-items\.json not written yet/);
      assert.match(on.stdout, /NOTE {2}Connectors turned on\s+.*inbound calendar \(calendar\)/, on.stdout);

      // A feed the key space cannot hold is the loader's rule, and the loader
      // runs first - so it lands on Config validation, with the key named, and
      // the preflight fails. The wizard must not report on a config nothing
      // will load.
      setGcal({ enabled: true, calendarId: "primary", feed: "fb", label: "Calendar", maxEvents: 200 });
      const bad = doctor();
      assert.equal(bad.status, 1, bad.stdout);
      assert.match(bad.stdout, /FAIL {2}Config validation\s+.*calendars\.gcal\.feed/, bad.stdout);
      assert.ok(!/Inbound calendar/.test(bad.stdout), "no row may describe a config that did not load");
    } finally {
      cleanup(dir);
    }
  });

  it("--help prints and writes nothing", { timeout: 60000 }, () => {
    const dir = stage();
    try {
      const r = runSetup(dir, ["--help"]);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /npm run setup/);
      assert.equal(existsSync(join(dir, "config.json")), false);
    } finally {
      cleanup(dir);
    }
  });
});
