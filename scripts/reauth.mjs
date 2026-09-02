// reauth.mjs - re-run the LMS server's own auth command and say what happened.
//
// WHAT THIS IS FOR
//
// Sessions expire. When they do, every scrape in the pipeline fails the same
// way and a human has to log in again through a browser. This script does the
// one part a script can do: it starts the login, waits, and turns whatever the
// auth CLI printed into ONE exit code that a runbook can branch on. It never
// stores a password, never reads one, and never types one.
//
// THREE MODES, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE DESIGN
//
//   --silent   headless. Never prompts (stdin is closed), never installs
//              (an `npx -y` entry becomes `npx --no`), prints one verdict line.
//              This is what a scheduled run executes, and the only mode it may.
//   --setup    interactive. The user types into their own terminal, so it
//              REFUSES to run without one. This is the mode that fixes
//              reauth=BAD-CREDS and reauth=NO-CREDS.
//   --probe    read-only diagnostic. Sends no credentials, opens no login, and
//              writes data/auth-probe.json: the login chain your school is
//              serving right now, with every query value stripped. Safe to read
//              and safe to paste into an issue.
//
// With no mode flag it runs the ordinary interactive login, which is what a
// person typing `node scripts/reauth.mjs` after a "session expired" message
// means. An UNKNOWN flag is a hard error - never a silent fallback into a live
// two-factor login, which is what happens when a typo is ignored.
//
// EXIT CODES - the contract a runbook keys off
//   0  the session was refreshed                                 reauth=ok
//   1  anything else                                             reauth=FAILED
//   2  no credentials saved yet / nothing configured to run      reauth=NO-CREDS
//   4  the command line was wrong; nothing was attempted         reauth=USAGE
//   5  the credentials were rejected (a human must fix this)     reauth=BAD-CREDS
//   6  a two-factor push was sent and never approved             reauth=MFA-PENDING
//   7  the LMS server package is not installed                   reauth=NO-PACKAGE
//
// WHY 6 IS NOT 1. A push that was never approved is a person who was away from
// their phone. Retrying that in twenty minutes is correct. Retrying a rejected
// password is not: it locks the account. Collapsing the two into "auth failed"
// is how a watchdog turns one missed notification into a lockout.
//
// WHY THE SESSION FILE IS CHECKED AT ALL. An auth CLI that exits 0 without
// writing a session has not logged anybody in - it has failed quietly. Reporting
// that as success republishes a stale token as fresh and pushes the real failure
// one run into the future, where it is much harder to read. So success needs
// both signals: a zero exit AND a session file that moved.
//
// SECURITY. Nothing secret passes through this file. The browser handles the
// login; the server stores whatever it stores, outside this repository. The
// probe records structure, never values. `scrubSecret` exists to defend the log
// path anyway, because the cheapest place to leak a password is a debug line in
// somebody else's child process.
//
// Usage:
//   node scripts/reauth.mjs                 run the login, print the verdict
//   node scripts/reauth.mjs --silent        headless; what a scheduled run uses
//   node scripts/reauth.mjs --setup         interactive; type a new password
//   node scripts/reauth.mjs --probe         read-only diagnostic, no login
//   node scripts/reauth.mjs --dry-run       print the command that would run
//   node scripts/reauth.mjs --home <dir>    override the session-file root (tests)
//   node scripts/reauth.mjs --config <path> --data <dir>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { argFlag, argHas, dataDir as resolveDataDir, repoRoot } from "../src/lib/paths.mjs";
import { loadConfig } from "../src/lib/config.mjs";

const CLI_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20000;
const PROBE_MAX_HOPS = 6;

/** Where an LMS MCP server conventionally leaves its session, relative to a home root. */
export const SESSION_CANDIDATES = [".brightspace-mcp/session.json", ".d2l-session/session.json"];

export const USAGE = [
  "usage: node scripts/reauth.mjs [--silent | --setup | --probe] [--dry-run]",
  "                              [--home <dir>] [--config <path>] [--data <dir>]",
  "",
  "  (no mode)   run the ordinary interactive login and print one verdict line",
  "  --silent    headless: never prompts, never installs. What a scheduled run uses",
  "  --setup     interactive: you type a new password. Needs a real terminal",
  "  --probe     read-only: writes data/auth-probe.json. Sends no credentials,",
  "              opens no login, and is safe to paste into an issue",
  "  --dry-run   print the command that would run, and stop",
  "  --help      this text",
  "",
  "exit codes: 0 ok - 1 failed - 2 NO-CREDS - 4 usage - 5 BAD-CREDS",
  "            6 MFA-PENDING - 7 NO-PACKAGE",
].join("\n");

// ---------------------------------------------------------------------------
// Pure cores (unit-tested)
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set(["silent", "quiet", "setup", "probe", "dry-run", "help", "h"]);
const KNOWN_VALUE_FLAGS = new Set(["home", "config", "data"]);

/**
 * Read the command line, or say exactly what is wrong with it.
 *
 * An unrecognised flag is refused rather than ignored. The version of this
 * script that ignored them turned `--probe` - documented everywhere as the safe
 * diagnostic that sends no credentials - into a real browser login with a
 * two-factor push and a five-minute block. Silently doing something more
 * dangerous than what was asked for is the worst failure mode a script has.
 */
export function parseArgs(argv) {
  const modes = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") && !(arg === "-h")) {
      return { error: `unexpected argument "${arg}"` };
    }
    const name = arg.replace(/^--?/, "").split("=")[0];
    if (KNOWN_VALUE_FLAGS.has(name)) {
      if (!arg.includes("=")) i += 1; // its value, already read by argFlag
      continue;
    }
    if (!KNOWN_FLAGS.has(name)) return { error: `unknown option "${arg}"` };
    if (name === "probe" || name === "setup") modes.push(name);
  }
  if (modes.length > 1) return { error: `--${modes[0]} and --${modes[1]} cannot both be given` };
  return {
    error: null,
    help: argHas(argv, "help") || argv.includes("-h"),
    mode: modes[0] ?? "auth",
    silent: argHas(argv, "silent") || argHas(argv, "quiet"),
    dryRun: argHas(argv, "dry-run"),
    home: argFlag(argv, "home"),
  };
}

/**
 * Map the auth CLI's combined output - plus whether the session file actually
 * moved - onto one exit code and a short token.
 *
 * ORDER IS THE POINT. A credential rejection wins over everything, including a
 * zero exit code, because some CLIs report a failed login on stdout and still
 * exit 0. A two-factor timeout wins over a generic failure because it is the
 * one failure worth retrying automatically. A missing package wins over
 * "no credentials", because a tool that never ran cannot have read a store.
 */
export function classifyResult({ output, sessionAdvanced, cliCode }) {
  const text = String(output || "");
  if (/CREDENTIALS-REJECTED|invalid (?:username|password)|authentication failed/i.test(text)) {
    return { code: 5, token: "BAD-CREDS" };
  }
  if (/MFA-TIMEOUT|MFA approval timed out|mfa_approval|two-factor.*(?:timed out|not approved)/i.test(text)) {
    return { code: 6, token: "MFA-PENDING" };
  }
  if (
    /NO-PACKAGE|npm ERR! (?:404|code E404)|code E404|could not determine executable|canceled due to missing package|MODULE_NOT_FOUND|ENOENT|is not recognized as an internal or external command|command not found/i.test(
      text,
    )
  ) {
    return { code: 7, token: "NO-PACKAGE" };
  }
  if (/NO-CREDS|no (?:saved |stored )?credentials|credentials? (?:file )?not found|no stored password|run .*--setup/i.test(text)) {
    return { code: 2, token: "NO-CREDS" };
  }
  if (sessionAdvanced && (cliCode === 0 || /Authentication successful/i.test(text))) {
    return { code: 0, token: "ok" };
  }
  if (cliCode === 0 && !sessionAdvanced) {
    // The CLI claimed success but the session file did not move. Never report a
    // stale token as fresh.
    return { code: 1, token: "NO-SESSION-WRITE" };
  }
  return { code: 1, token: "FAILED" };
}

/** Remove every occurrence of a secret from text. A falsy secret is a no-op. */
export function scrubSecret(text, secret) {
  const s = String(text ?? "");
  if (!secret) return s;
  return s.split(secret).join("«redacted»");
}

/**
 * Build the command that re-authenticates, from the `.mcp.json` entry the LMS
 * connector already uses. Adding `auth` to that server's own argv is what
 * every one of these servers expects, and it means this script never hardcodes
 * a package name or a platform-specific wrapper - the entry already has both.
 *
 * WHEN THERE IS NO ENTRY, `connectors.lms.brightspace.package` is the fallback.
 * A user who built a patched server, or who removed the project server from
 * `.mcp.json`, still has a documented package name in their config and still
 * deserves a working re-auth rather than exit 2.
 *
 * IN SILENT MODE `npx -y` becomes `npx --no`. `--silent` is documented as
 * "never installs", and an unattended run that quietly pulls a new version of
 * an auth tool off the network at 07:03 is not what that sentence promises.
 *
 * Returns null when nothing at all is configured, which is exit 2 (NO-CREDS).
 */
export function authCommand(mcpServers, serverKey, opts = {}) {
  const { silent = false, pkg = null, platform = process.platform } = opts;
  const entry = mcpServers?.[serverKey];
  let command;
  let args;
  let env = null;

  if (entry && typeof entry.command === "string" && entry.command) {
    command = entry.command;
    args = [...(entry.args ?? [])];
    env = entry.env ?? null;
  } else if (pkg) {
    // The Windows `cmd /c` wrapper is not optional: a bare `npx` spawned
    // without a shell fails silently on Windows, which is the single most
    // common cross-platform break in this project.
    command = platform === "win32" ? "cmd" : "npx";
    args = platform === "win32" ? ["/c", "npx", "-y", pkg] : ["-y", pkg];
  } else {
    return null;
  }

  if (silent) args = args.map((a) => (a === "-y" || a === "--yes" ? "--no" : a));
  return { command, args: [...args, "auth"], env };
}

/** The newest mtime among the known session-file locations, or 0 if there is none. */
export function sessionStamp(home, candidates = SESSION_CANDIDATES) {
  let newest = 0;
  for (const rel of candidates) {
    const p = join(home, ...rel.split("/"));
    try {
      if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs);
    } catch {
      /* an unreadable session file is the same as an absent one, here */
    }
  }
  return newest;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * A URL with every query VALUE removed, keeping the names.
 *
 * A login redirect chain carries `client_id`, `state`, `nonce` and sometimes a
 * one-time code. None of those is a password and all of them are noise in an
 * issue thread, and one of them is a session handle. Names describe the chain
 * and values describe the person, so the names stay and the values go.
 */
export function sanitizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const params = [...u.searchParams.keys()];
    return `${u.origin}${u.pathname}${params.length ? `?${params.map((k) => `${k}=`).join("&")}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * The public login form's structure: where it posts, and what its fields are
 * called. Field NAMES only - a probe that recorded a value would be a probe
 * nobody could paste anywhere.
 */
export function parseLoginForm(html) {
  const text = String(html ?? "");
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(text);
  if (!form) return null;
  const attr = (source, name) => {
    const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(source);
    return m ? m[1] : null;
  };
  const fields = [...form[2].matchAll(/<input\b([^>]*)>/gi)]
    .map((m) => ({ name: attr(m[1], "name"), type: (attr(m[1], "type") ?? "text").toLowerCase() }))
    .filter((f) => f.name && f.type !== "hidden");
  return {
    action: attr(form[1], "action"),
    method: (attr(form[1], "method") ?? "get").toLowerCase(),
    fields,
  };
}

/**
 * Walk the redirect chain a browser would walk, with no cookies and no
 * credentials, and record its shape. Every hop is recorded even when the chain
 * ends in an error: "it stopped at the identity provider with a 500" is exactly
 * the kind of finding this file exists to make visible.
 */
export async function traceLoginChain(startUrl, fetchImpl = globalThis.fetch) {
  const chain = [];
  let url = startUrl;
  let body = null;
  for (let hop = 0; hop < PROBE_MAX_HOPS && url; hop += 1) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (e) {
      chain.push({ hop, url: sanitizeUrl(url), status: 0, error: String(e?.message ?? e).slice(0, 200) });
      break;
    }
    const location = typeof res.headers?.get === "function" ? res.headers.get("location") : null;
    chain.push({
      hop,
      url: sanitizeUrl(url),
      status: res.status,
      redirectsTo: location ? sanitizeUrl(new URL(location, url).toString()) : null,
    });
    if (location) {
      url = new URL(location, url).toString();
      continue;
    }
    try {
      body = await res.text();
    } catch {
      body = null;
    }
    break;
  }
  return { chain, form: body ? parseLoginForm(body) : null };
}

/**
 * Everything the probe knows without touching the network: which server would
 * be run, with which arguments, and whether a session file exists at all.
 * Argument VALUES are kept because an `.mcp.json` entry is not secret - but the
 * env block is reduced to its key names, because a `${TOKEN}` there might be.
 */
export function localProbe({ serverKey, entry, pkg, home, sessionCandidates = SESSION_CANDIDATES }) {
  const stamp = sessionStamp(home, sessionCandidates);
  return {
    serverKey,
    declaredInMcpJson: Boolean(entry),
    command: entry?.command ?? null,
    args: entry?.args ?? null,
    envKeys: entry?.env ? Object.keys(entry.env) : [],
    packageFromConfig: pkg,
    sessionFile: stamp > 0 ? { present: true, modified: new Date(stamp).toISOString() } : { present: false },
    node: process.version,
    platform: process.platform,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readMcpServers(root) {
  try {
    return JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"))?.mcpServers ?? {};
  } catch {
    return {};
  }
}

function run(command, args, env, { interactive }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      // A headless run must never be able to block on a prompt nobody can see,
      // so its stdin is closed rather than inherited.
      stdio: [interactive ? "inherit" : "ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let output = "";
    const collect = (d) => {
      output += d.toString();
      process.stdout.write(d);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ output: `${output}\ncould not start ${command}: ${e.message}`, cliCode: 1 });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ output, cliCode: code ?? 1 });
    });
  });
}

function say(quiet, line) {
  if (!quiet) console.log(line);
}

async function probe({ root, argv, serverKey, entry, pkg, home, lmsHost, quiet }) {
  const dir = resolveDataDir(argv, root);
  const out = join(dir, "auth-probe.json");
  const report = {
    probedAt: new Date().toISOString(),
    note: "Structure only. No credentials, no cookies, no query values, no login attempted.",
    local: localProbe({ serverKey, entry, pkg, home }),
    lmsHost: lmsHost ?? null,
    chain: [],
    form: null,
  };

  if (lmsHost) {
    const start = /^https?:\/\//i.test(lmsHost) ? lmsHost : `https://${lmsHost}`;
    const traced = await traceLoginChain(start);
    report.chain = traced.chain;
    report.form = traced.form;
  } else {
    report.chain = [];
    report.form = null;
    report.hint =
      'institution.lmsHost is not set in config.json, so there was no address to probe. Set it (e.g. "lms.example.edu") and run this again.';
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 1) + "\n", "utf8");
  say(quiet, `reauth=PROBE wrote ${out} (${report.chain.length} hop(s), ${report.form ? `${report.form.fields.length} form field(s)` : "no login form seen"})`);
  say(quiet, "  It contains no credentials and no query values. It is safe to read and safe to paste into an issue.");
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const root = repoRoot();
  const opts = parseArgs(argv);

  if (opts.error) {
    console.error(`reauth=FAILED(USAGE) ${opts.error}\n\n${USAGE}`);
    process.exit(4);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const home = opts.home ?? homedir();
  const quiet = opts.silent;

  let serverKey = "brightspace";
  let pkg = null;
  let lmsHost = null;
  try {
    const cfg = loadConfig(null, { argv, warn: () => {} });
    serverKey = cfg.connectors?.lms?.brightspace?.mcpServer ?? serverKey;
    pkg = cfg.connectors?.lms?.brightspace?.package ?? null;
    lmsHost = cfg.institution?.lmsHost ?? null;
  } catch {
    /* a broken config must not stop somebody logging back in */
  }

  const servers = readMcpServers(root);

  if (opts.mode === "probe") {
    process.exit(await probe({ root, argv, serverKey, entry: servers[serverKey] ?? null, pkg, home, lmsHost, quiet }));
  }

  const cmd = authCommand(servers, serverKey, { silent: opts.silent, pkg });
  if (!cmd) {
    console.error(
      `reauth=NO-CREDS nothing is configured to log in with: no MCP server named "${serverKey}" in .mcp.json,\n` +
        "  and connectors.lms.brightspace.package is not set either.\n" +
        "  Fix: run `node scripts/reauth.mjs --setup` once, or check .mcp.json (`claude mcp list`).",
    );
    process.exit(2);
  }

  if (opts.dryRun) {
    console.log(`${cmd.command} ${cmd.args.join(" ")}`);
    process.exit(0);
  }

  if (opts.mode === "setup") {
    // The security model says a scheduled run may RUN the wrapper and may never
    // run interactive setup - that is a person typing a password into their own
    // terminal. Without a TTY there is nobody to type, so refuse rather than
    // hang for five minutes and report a timeout.
    if (!process.stdin.isTTY) {
      console.error(
        "reauth=FAILED(USAGE) --setup is interactive and there is no terminal attached.\n" +
          "  Run it yourself in a terminal window. A scheduled run must never run setup.",
      );
      process.exit(4);
    }
    console.log("This is the one command here that may ask you to type your school password.");
    console.log("It goes to your school's login, never to this repository, and is never logged.");
    console.log("A browser window and a two-factor push are both likely. It waits up to five minutes.\n");
  } else if (!quiet) {
    console.log("A browser window will open on your school's login page, and your phone will");
    console.log("probably get a two-factor push. Log in there - this script never sees your");
    console.log("password. It waits up to five minutes.\n");
  }

  const before = sessionStamp(home);
  const { output, cliCode } = await run(cmd.command, cmd.args, cmd.env, { interactive: opts.mode === "setup" || !opts.silent });
  const after = sessionStamp(home);
  const verdict = classifyResult({ output: scrubSecret(output, ""), sessionAdvanced: after > before, cliCode });

  const advice = {
    5: " - fix the account itself; retrying will lock it. Run `node scripts/reauth.mjs --setup`",
    6: " - the push was never approved; this one is worth retrying",
    2: " - nothing is saved yet. Run `node scripts/reauth.mjs --setup` once",
    7: " - the LMS server package is not installed. Run the auth CLI once to reinstall it",
  };
  console.log(
    verdict.code === 0
      ? "reauth=OK the session was refreshed"
      : `reauth=FAILED(${verdict.token}) exit ${verdict.code}${advice[verdict.code] ?? ""}`,
  );
  process.exit(verdict.code);
}

// Run only when this file is the entry point, so a test may import the pure
// cores without starting a login.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`reauth=FAILED(CRASH) ${e.message}`);
    process.exit(1);
  });
}
