#!/usr/bin/env node
// ===========================================================================
//  validate-setup.mjs - the preflight
// ===========================================================================
//
//  WHAT THIS IS FOR
//  ----------------
//  This is the first thing setup runs and the first thing /agenda-doctor runs.
//  Its audience is a person who has never opened a terminal, so it has exactly
//  one job: for every prerequisite, say PASS or FAIL, and for every FAIL say
//  the ONE thing to do about it.
//
//  THE RULE THAT SHAPES THE WHOLE FILE
//  -----------------------------------
//  It must run on a machine with NOTHING installed and print a fix link for
//  every failure instead of throwing. A preflight that crashes on the machine
//  it was written to diagnose is worse than no preflight, because the user
//  cannot tell "your Node is too old" from "this repo is broken". So every
//  probe is wrapped, every failure is a result rather than an exception, and
//  the process only ever exits 0 or 1.
//
//  It writes nothing anywhere except stdout, and the only thing it reads out of
//  data/ is whether two files exist: its own write probe, and the inbound
//  calendar's `gcal-items.json` (one field of it - the feed's status). No
//  scraped content, no grades, no deadlines.
//
//  EXIT CODES
//    0  every hard check passed (warnings and notes do not fail)
//    1  at least one hard check failed; the reasons were printed
// ===========================================================================

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Both live beside this file, in scripts/lib/. They are the same two functions
// the wizard uses, imported rather than copied so the preflight's table and
// CLAUDE.md's "Connectors on:" line cannot drift apart.
import { connectorsOn } from "./lib/setup-config.mjs";
import { checkGcal, GCAL_FILE } from "./lib/setup-gcal.mjs";
import { RCLONE_INSTALL, rcloneConsent } from "./lib/setup-report.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- result collection -----------------------------------------------------
// Four levels. Only FAIL affects the exit code. WARN means "this works without
// it"; NOTE is context a human wants and a machine does not.
const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";
const NOTE = "NOTE";

const results = [];

function record(level, name, detail, fix = null) {
  results.push({ level, name, detail, fix });
}

/**
 * Run one probe. Anything it throws becomes a FAIL with the message attached,
 * so a broken probe reports itself instead of taking the run down.
 */
function check(name, fix, fn) {
  try {
    const out = fn();
    if (out && out.level) record(out.level, name, out.detail, out.fix ?? fix);
    else record(PASS, name, typeof out === "string" ? out : "ok");
  } catch (err) {
    record(FAIL, name, `the check itself failed: ${err && err.message}`, fix);
  }
}

/** Is <bin> on PATH? Returns its version line, or null. Never throws. */
function probeBin(bin, args = ["--version"]) {
  try {
    const out = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
      windowsHide: true
    });
    return String(out).trim().split(/\r?\n/)[0] || "(no version output)";
  } catch {
    return null;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ===========================================================================
//  1. Node
// ===========================================================================
// The only genuinely hard requirement. Everything here is stdlib-only ESM and
// several modules use APIs that landed in 22.
check(
  "Node 22 or newer",
  "Install the LTS build from https://nodejs.org and run this again.",
  () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (Number.isNaN(major) || major < 22) {
      return { level: FAIL, detail: `found ${process.version}, need v22 or newer` };
    }
    return `${process.version}`;
  }
);

// ===========================================================================
//  2. Platform
// ===========================================================================
// Not a pass/fail. It decides which connectors can even be offered, so the
// setup agent needs it stated plainly rather than inferred.
check("Operating system", null, () => {
  const names = { win32: "Windows", darwin: "macOS", linux: "Linux" };
  const os = names[process.platform] ?? process.platform;
  const extra =
    process.platform === "win32"
      ? "every connector is available here"
      : "mail and the Exchange calendar sink are Windows-only and will stay off; everything else works";
  return { level: NOTE, detail: `${os} (${process.arch}) - ${extra}` };
});

// ===========================================================================
//  3. Command-line tools
// ===========================================================================
check(
  "Claude Code on PATH",
  "Install it from https://claude.com/claude-code. Without it, nothing can run on a schedule.",
  () => {
    const v = probeBin("claude");
    return v ? v : { level: FAIL, detail: "`claude` was not found on PATH" };
  }
);

check(
  "git on PATH",
  "Install from https://git-scm.com. Only needed to clone and update this repo, not to run it.",
  () => {
    const v = probeBin("git");
    return v ? v : { level: WARN, detail: "`git` was not found - the agenda still runs without it" };
  }
);

check(
  "GitHub CLI on PATH (optional)",
  "Install from https://cli.github.com if you want the side-project board. Skip it otherwise.",
  () => {
    const v = probeBin("gh");
    if (!v) return { level: NOTE, detail: "`gh` not installed - the side-project board will stay off" };
    // Being installed is not being logged in, and the difference is invisible
    // until a board sync silently returns nothing.
    try {
      execFileSync("gh", ["auth", "status"], {
        stdio: "ignore",
        timeout: 15000,
        windowsHide: true
      });
      return `${v}, authenticated`;
    } catch {
      return {
        level: WARN,
        detail: `${v}, but not authenticated`,
        fix: "Run `gh auth login` once. Until then the board connector reports SKIPPED and the run continues."
      };
    }
  }
);

// ===========================================================================
//  4. The repository itself
// ===========================================================================
check(
  "Repository layout",
  "Something is missing from this clone. Re-clone the template, or check you are in the right folder.",
  () => {
    // The four files a scheduled run actually needs, and the two the whole
    // repository is built around. `runbooks/daily-agent.md` is what the model
    // window reads; `scripts/run-daily.mjs` is what the scheduler starts;
    // `src/pipeline.mjs` is what does the work either side of the model.
    // (1.x wanted runbooks/heavy-run.md and runbooks/sync-run.md. Those are
    // retired and now live under runbooks/legacy/, where nothing reads them.)
    const want = [
      "src",
      "web/page-template.html",
      "runbooks/daily-agent.md",
      "scripts/run-daily.mjs",
      "src/pipeline.mjs",
      "config.example.json",
      "fixtures/demo"
    ];
    const missing = want.filter((p) => !existsSync(join(REPO, p)));
    if (missing.length) return { level: FAIL, detail: `missing: ${missing.join(", ")}` };
    return `all expected files present`;
  }
);

check(
  "Sample data for demo mode",
  "fixtures/demo/ is missing. Demo mode cannot run. Re-clone the template.",
  () => {
    const cfg = join(REPO, "fixtures", "demo", "config.demo.json");
    const data = join(REPO, "fixtures", "demo", "data");
    if (!existsSync(cfg) || !existsSync(data)) {
      return { level: FAIL, detail: "fixtures/demo is incomplete" };
    }
    return "present - `node scripts/demo.mjs` will work with no accounts";
  }
);

check(
  "data/ is writable",
  "Move the repo somewhere your user account can write - your home folder, not Program Files.",
  () => {
    const dir = join(REPO, "data");
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const probe = join(dir, ".write-probe");
      writeFileSync(probe, "ok");
      unlinkSync(probe);
      return "writable";
    } catch (err) {
      return { level: FAIL, detail: `cannot write to data/: ${err && err.message}` };
    }
  }
);

// ===========================================================================
//  5. Configuration
// ===========================================================================
// config.json's absence is the NORMAL state before setup, so it is a note, not
// a failure. Once it exists, the loader is the only thing that knows which
// values count as unset - this file deliberately does not reimplement that.
let cfg = null;
// The `.mcp.json` server keys the ENABLED connectors actually ask for. Filled
// in below once the registry has been consulted; null means "we could not
// work it out", which the .mcp.json check treats as "do not judge".
let requiredMcpKeys = null;

check(
  "config.json",
  'Say "hey" in Claude Code and the setup agent creates it from config.example.json.',
  () => {
    const p = join(REPO, "config.json");
    if (!existsSync(p)) {
      return { level: NOTE, detail: "not created yet - setup has not run" };
    }
    try {
      readJson(p);
    } catch (err) {
      return {
        level: FAIL,
        detail: `exists but is not valid JSON: ${err && err.message}`,
        fix: "A trailing comma or a missing quote. Fix it, or delete config.json and re-run setup."
      };
    }
    return "present and parses";
  }
);

await (async () => {
  const p = join(REPO, "config.json");
  if (!existsSync(p)) return;

  // The loader owns the definition of "not set yet" and the derivation of every
  // name. Import it defensively: on a half-built checkout it may not be there,
  // and a preflight must survive that rather than crash.
  let loadConfig = null;
  try {
    ({ loadConfig } = await import(new URL("../src/lib/config.mjs", import.meta.url)));
  } catch {
    record(WARN, "Config validation", "src/lib/config.mjs is unavailable - skipped the deep check");
    return;
  }

  let assertConfigured = null;
  try {
    ({ assertConfigured } = await import(new URL("../src/lib/config.mjs", import.meta.url)));
  } catch {
    /* reported below as a skipped deep check */
  }

  try {
    cfg = loadConfig(p);
    // The loader is happy with a half-filled config; the pipeline is not.
    // `render.mjs` refuses to run without a timezone, so a preflight that says
    // "every enabled feature has what it needs" before checking it is telling a
    // user their setup is fine one command before it stops.
    if (assertConfigured) assertConfigured(cfg, ["timezone"]);
    record(PASS, "Config validation", "loads, and every enabled feature has what it needs");
  } catch (err) {
    record(
      FAIL,
      "Config validation",
      String((err && err.message) || err).split("\n")[0],
      "docs/CONFIG.md explains every key, or re-run setup and it will fill this in."
    );
    return;
  }

  // The one hard requirement in the connector registry.
  //
  // THIS MUST ASK THE REGISTRY, NOT THE RAW KEYS. A provider named in
  // config.json with no connector behind it used to pass here and then fail at
  // `node src/scrape.mjs` with "no LMS source is enabled" - the preflight said
  // the LMS was fine and the scrape demanded the thing already done. One
  // function answers for both, and this is it.
  let registry = null;
  try {
    registry = await import(new URL("../src/connectors/index.mjs", import.meta.url));
  } catch {
    record(WARN, "An LMS source is enabled", "src/connectors/index.mjs is unavailable - skipped the deep check");
  }

  if (registry) {
    const enabledLms = registry.ALL.filter((m) => m.meta?.kind === "lms" && registry.isEnabled(m, cfg));
    if (enabledLms.length === 0) {
      const named = Object.entries(cfg?.connectors?.lms ?? {})
        .filter(([, v]) => v && v.enabled === true)
        .map(([k]) => k);
      record(
        FAIL,
        "An LMS source is enabled",
        named.length
          ? `${named.join(", ")} is switched on in config.json, but no connector of that name is registered`
          : "every LMS connector is off, so there is nothing to build an agenda from",
        named.length
          ? "Either enable one of the shipped providers, or write the connector and register it in src/connectors/index.mjs - docs/EXTENDING.md walks through it."
          : "Set connectors.lms.brightspace.enabled or connectors.lms.canvas.enabled to true. Both may be on at once."
      );
    } else {
      record(PASS, "An LMS source is enabled", enabledLms.map((m) => m.meta.id).join(", "));
    }

    // Enabled is not the same as able to run. Ask each enabled connector what
    // it still needs, so a PASS above means the next command will actually work.
    const servers = (() => {
      try {
        return Object.keys(readJson(join(REPO, ".mcp.json")).mcpServers ?? {});
      } catch {
        return [];
      }
    })();
    const enabledMods = [...registry.sources(cfg), ...registry.sinks(cfg)];
    requiredMcpKeys = new Set(enabledMods.flatMap((m) => m.meta?.requires?.mcp ?? []));
    for (const mod of enabledMods) {
      const id = mod.meta.id;
      const can = registry.satisfies(mod, {
        platform: process.platform,
        hasBin: (bin) => probeBin(bin) !== null,
        mcpServers: servers
      });
      if (!can.ok) {
        record(
          mod.meta.kind === "lms" ? FAIL : WARN,
          `${id} can run here`,
          can.reason,
          mod.meta.kind === "lms"
            ? "An LMS source that cannot run leaves nothing to build an agenda from. Fix it, or enable another provider."
            : `Optional. Set ${mod.meta.configPath}.enabled to false if this machine will never have it.`
        );
        continue;
      }
      // A connector may also need config of its own - Canvas needs an address
      // and a token, and neither has a platform or a binary to check.
      const ready = typeof mod.precheck === "function" ? mod.precheck(cfg) : { ok: true };
      if (ready.ok === false) {
        record(mod.meta.kind === "lms" ? FAIL : WARN, `${id} can run here`, ready.detail, ready.fix);
      } else {
        record(PASS, `${id} can run here`, ready.detail ?? "ready");
      }
    }
  }

  // Setup that stopped before Q5 leaves the example cast in place.
  //
  // `config.example.json` ships five invented courses with invented ids so the
  // shape of the block is obvious. Every other user-specific value carries a
  // `[NOT SET]` sentinel, but a course list cannot: the example has to be a
  // real-looking list to be worth copying. So the sentinel is the list itself,
  // and this is the check that reads it. Without it a user who answered the
  // timezone question and stopped gets "everything checks out" over a config
  // that would ask their real LMS for course 110001 - and the setup agent's own
  // promise that "a half-finished config.json makes the preflight stricter on
  // purpose" (.claude/agents/onboarding.md, Step 0.5) would not be true.
  //
  // The example file is the source of truth here rather than a hardcoded list,
  // so editing the shipped cast can never silently disable this.
  try {
    const exampleCodes = readJson(join(REPO, "config.example.json"))
      .courses.map((c) => String(c.code))
      .sort();
    const liveCodes = (Array.isArray(cfg?.courses) ? cfg.courses : [])
      .filter((c) => c && c.code)
      .map((c) => String(c.code))
      .sort();
    if (exampleCodes.length && liveCodes.join("|") === exampleCodes.join("|")) {
      record(
        FAIL,
        "Your courses",
        `still the example courses (${exampleCodes.join(", ")}) - setup did not get as far as your real ones`,
        'Say "hey" in Claude Code. The setup agent picks up where it left off and replaces the whole list; it will not merge with these.'
      );
    } else if (liveCodes.length) {
      record(PASS, "Your courses", `${liveCodes.length} course(s): ${liveCodes.join(", ")}`);
    } else {
      record(
        FAIL,
        "Your courses",
        "no courses are listed, so there is nothing to build an agenda around",
        'Say "hey" in Claude Code and the setup agent will ask for your course list.'
      );
    }
  } catch {
    /* a malformed courses block was already reported by Config validation */
  }

  // The transport the daily run publishes through.
  //
  // This is the one prerequisite that is invisible until the moment it matters:
  // everything renders perfectly on a machine with no rclone, and the only
  // symptom is that the page on the user's phone never changes. rclone needs an
  // install AND one consent click, and neither this file nor the wizard can do
  // the second - so both are named here, with the exact command.
  check("Drive transport (rclone)", null, () => {
    if (cfg?.drive?.enabled !== true) {
      return { level: PASS, detail: "(off) - drive.enabled is false, so nothing is published" };
    }
    const remote = cfg?.drive?.rcloneRemote || "agenda";
    const install = RCLONE_INSTALL[process.platform] ?? "see https://rclone.org/install/";
    const consent = rcloneConsent(remote);

    // Checked BEFORE the probe, not after it: `AGENDA_PREFLIGHT_NO_NETWORK` is
    // the test suite's way out, and the suite may not spawn rclone AT ALL - not
    // the listing, not even `rclone --version`. A guard that only skipped the
    // listing still ran the binary several times per `npm test` on a machine
    // that happened to have it. Nothing but `test/setup.test.mjs` sets this; it
    // is not a supported setting.
    if (process.env.AGENDA_PREFLIGHT_NO_NETWORK) {
      return { level: NOTE, detail: `remote "${remote}" not probed (AGENDA_PREFLIGHT_NO_NETWORK)` };
    }

    const version = probeBin(cfg?.drive?.rcloneExe || "rclone");
    if (!version) {
      return {
        level: FAIL,
        detail: "`rclone` was not found - the daily run has no way to publish your page",
        fix: `Install it:  ${install}      Then, once:  ${consent}`,
      };
    }

    const cli = join(REPO, "src", "drive-rclone.mjs");
    if (!existsSync(cli)) {
      return { level: FAIL, detail: `${version}, but src/drive-rclone.mjs is missing from this clone`, fix: "Re-clone the template." };
    }

    // `status` is a read-only listing of the remote's root, and it is the ONE
    // thing in this file that leaves the machine. There is no offline way to
    // learn that a consent screen was answered, so the choice is this call or
    // no check at all - and "no check" is how a user finds out at 10:30
    // tomorrow.
    const r = spawnSync(process.execPath, [cli, "status"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    if (r.status === 0) return `${version}, remote "${remote}" answers`;
    const why = String(r.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit ${r.status}`;
    return {
      level: FAIL,
      detail: `${version}, but the remote did not answer: ${why}`,
      fix: `One consent click fixes it - a browser opens and you click Allow:  ${consent}`,
    };
  });

  // The model window. `llm.model` is the one value in that block a run cannot
  // invent a default for once it is in front of the CLI.
  check("The model window", null, () => {
    const llm = cfg?.llm ?? {};
    if (typeof llm.model !== "string" || !llm.model.trim()) {
      return {
        level: FAIL,
        detail: "llm.model is not set, so a scheduled run has no model to open a window on",
        fix: 'Put `"llm": { "model": "claude-sonnet-5" }` in config.json - docs/CONFIG.md has the whole block.',
      };
    }
    if (llm.enabled !== true) {
      return {
        level: WARN,
        detail: `off - llm.enabled is false, so every run logs llm=absent and the page still updates`,
        fix: "Set llm.enabled to true when you want mail triage, descriptions and the digest.",
      };
    }
    return `${llm.model}, effort ${llm.effort}, capped at ${llm.maxTurns} turns and $${llm.maxBudgetUsd} a run`;
  });

  // The INBOUND calendar. It is not under `connectors` - it reads the user's
  // own meetings in, where `connectors.calendar.*` writes deadlines out - so
  // nothing above sees it, and its failure mode is silence: an empty
  // `meetings[]` looks exactly like a calendar with nothing on it.
  //
  // Every shape rule for the block lives in `validateCalendars()` in
  // `src/lib/config.mjs`, which ran above: a malformed one has already FAILed
  // "Config validation" with the offending key named, and never reaches here.
  // So this reports rather than judges, and adds the one thing a loader cannot
  // know - whether a run has written `data/gcal-items.json` yet, and what it
  // said.
  check("Inbound calendar", null, () => {
    const p = join(REPO, GCAL_FILE);
    let file = { exists: existsSync(p), status: null };
    if (file.exists) {
      try {
        file = { exists: true, status: readJson(p)?.feeds?.[0]?.status ?? null };
      } catch {
        file = { exists: true, status: "unreadable" };
      }
    }
    return checkGcal(cfg, file);
  });

  // Everything else is a note: an optional connector being off is the shipped
  // default and must never look like a fault.
  try {
    const on = connectorsOn(cfg);
    record(NOTE, "Connectors turned on", on.length ? on.join(", ") : "none yet");
  } catch {
    /* a malformed connectors block was already reported above */
  }

  record(
    NOTE,
    "Published page",
    cfg?.artifact?.url ? "artifact.url is set" : "not published yet - see docs/ARTIFACT.md"
  );
})();

// ===========================================================================
//  6. MCP servers
// ===========================================================================
// The Windows npx wrapper is the single most common cross-platform break in
// this project: a Mac-shaped stdio entry fails SILENTLY on Windows, so the
// server never starts and the only symptom is an empty course list.
check(
  ".mcp.json",
  "Re-clone the template, or ask the setup agent to rewrite it.",
  () => {
    const p = join(REPO, ".mcp.json");
    if (!existsSync(p)) return { level: WARN, detail: "not present - no project-scoped MCP servers declared" };

    let mcp;
    try {
      mcp = readJson(p);
    } catch (err) {
      return { level: FAIL, detail: `is not valid JSON: ${err && err.message}` };
    }

    const servers = Object.entries(mcp.mcpServers ?? {});
    if (!servers.length) return { level: WARN, detail: "declares no servers" };

    if (process.platform === "win32") {
      const bare = servers
        .filter(([, s]) => typeof s?.command === "string" && /^npx(\.cmd)?$/i.test(s.command))
        .map(([k]) => k);
      if (bare.length) {
        // The template ships the portable form and the setup agent rewrites it
        // for Windows, so before setup this is expected and only a warning.
        // After setup it means the rewrite did not happen, and that is a real
        // failure whose only symptom would otherwise be an empty course list.
        //
        // Unless nothing needs the server. A user on Canvas still has the
        // shipped Brightspace entry sitting in .mcp.json, and failing their
        // preflight over a server no enabled connector will ever start is how a
        // clean setup gets reported as broken.
        const setupHasRun = existsSync(join(REPO, "config.json"));
        const needed = requiredMcpKeys ? bare.filter((k) => requiredMcpKeys.has(k)) : bare;
        if (!needed.length) {
          return {
            level: WARN,
            detail: `${bare.join(", ")} would need the Windows cmd wrapper, but no enabled connector uses it`,
            fix: "Harmless. Remove the entry from .mcp.json, or leave it for later."
          };
        }
        return {
          level: setupHasRun ? FAIL : WARN,
          detail: `on Windows these stdio servers need the cmd wrapper: ${needed.join(", ")}`,
          fix: setupHasRun
            ? 'Change each to {"command": "cmd", "args": ["/c", "npx", "-y", "<pkg>"]}. A bare npx entry fails silently on Windows. If you are still mid-setup, the setup agent does this when it connects your school.'
            : "Expected before setup - the setup agent rewrites this for Windows when it connects your school."
        };
      }
    }

    return `${servers.length} server(s) declared: ${servers.map(([k]) => k).join(", ")}`;
  }
);

check(
  "MCP server approval",
  "Approve the trust dialog in Claude Code. `claude mcp reset-project-choices` re-prompts if you dismissed it.",
  () => {
    const out = probeBin("claude", ["mcp", "list"]);
    if (out === null) {
      return { level: NOTE, detail: "could not ask `claude mcp list` - check this from inside Claude Code" };
    }
    // A repository cannot pre-grant this approval: it is per-user and
    // per-project by design. All this check can do is tell the user it is
    // waiting.
    return { level: NOTE, detail: "run `claude mcp list` inside Claude Code to see pending approvals" };
  }
);

// ===========================================================================
//  7. Windows-only extras
// ===========================================================================
if (process.platform === "win32") {
  check(
    "Classic Outlook (optional)",
    "Only needed for mail triage and the Exchange calendar sink. Both are optional and ship off.",
    () => {
      // The modern Outlook app is a different program with no COM surface, so
      // "Outlook is installed" is not the question - "classic Outlook is
      // installed" is. Registry probe, no process is started.
      const out = probeBin("reg", [
        "query",
        "HKCR\\Outlook.Application\\CurVer",
        "/ve"
      ]);
      if (out === null) {
        return { level: NOTE, detail: "classic Outlook not detected - the mail and calendar connectors stay off" };
      }
      return { level: NOTE, detail: "classic Outlook detected - mail and calendar connectors can be offered" };
    }
  );
}

// ===========================================================================
//  Report
// ===========================================================================
const width = Math.max(...results.map((r) => r.name.length));
const fails = results.filter((r) => r.level === FAIL);
const warns = results.filter((r) => r.level === WARN);

console.log("");
console.log("  preflight");
console.log("  " + "-".repeat(width + 34));

for (const r of results) {
  console.log(`  ${r.level.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
  if (r.fix && (r.level === FAIL || r.level === WARN)) {
    console.log(`  ${" ".repeat(4)}  ${" ".repeat(width)}  -> ${r.fix}`);
  }
}

console.log("  " + "-".repeat(width + 34));

if (fails.length === 0 && warns.length === 0) {
  console.log("  everything checks out.");
} else {
  if (fails.length) console.log(`  ${fails.length} thing(s) must be fixed before a real run.`);
  if (warns.length) console.log(`  ${warns.length} warning(s) - the agenda still runs, with less in it.`);
}

// Demo mode needs none of the above except Node and the fixtures, so say so:
// a first success that does not depend on any account is the whole point of it.
if (fails.length) {
  const blockedByNode = fails.some((r) => r.name.startsWith("Node"));
  if (!blockedByNode) {
    console.log("");
    console.log("  You can still see a full working agenda right now with no accounts:");
    console.log("    node scripts/demo.mjs");
  }
}

console.log("");
process.exit(fails.length ? 1 : 0);
