// Covers the pure decision cores of scripts/reauth.mjs: the exit-code
// classifier, the secret scrubber, and the command builder.
//
// Nothing here logs in, touches a real session file, or starts a browser. The
// login itself is the one part of this repository that can only be tested by a
// human watching it, which is exactly why the parts around it are pinned down
// this hard: when a session expires at 07:03 on a Monday, the exit code is the
// only thing a runbook has to reason with.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  USAGE,
  authCommand,
  classifyResult,
  localProbe,
  parseArgs,
  parseLoginForm,
  sanitizeUrl,
  scrubSecret,
  sessionStamp,
  traceLoginChain,
} from "../scripts/reauth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "reauth.mjs");

// ---------------------------------------------------------------------------
// classifyResult - the exit-code contract
// ---------------------------------------------------------------------------

test("classify: a credential rejection wins, even on a zero exit", () => {
  const r = classifyResult({ output: "ERROR CREDENTIALS-REJECTED (password): wrong", sessionAdvanced: true, cliCode: 0 });
  assert.equal(r.code, 5);
  assert.equal(r.token, "BAD-CREDS");
});

test("classify: a two-factor timeout maps to 6, the retryable code", () => {
  const r = classifyResult({ output: "MFA-TIMEOUT: the push was never approved", sessionAdvanced: false, cliCode: 1 });
  assert.equal(r.code, 6);
  assert.equal(r.token, "MFA-PENDING");
});

test("classify: success requires the session file to have advanced", () => {
  assert.equal(classifyResult({ output: "Authentication successful!", sessionAdvanced: true, cliCode: 0 }).code, 0);
});

test("classify: a zero exit with no session write is a failure, not a success", () => {
  const r = classifyResult({ output: "done", sessionAdvanced: false, cliCode: 0 });
  assert.equal(r.code, 1);
  assert.equal(r.token, "NO-SESSION-WRITE");
});

test("classify: a generic non-zero exit is 1", () => {
  assert.equal(classifyResult({ output: "boom", sessionAdvanced: false, cliCode: 2 }).code, 1);
});

test("classify: a credential rejection beats a co-occurring two-factor line", () => {
  const r = classifyResult({ output: "CREDENTIALS-REJECTED\nMFA-TIMEOUT", sessionAdvanced: false, cliCode: 1 });
  assert.equal(r.code, 5, "order matters: retrying a rejected password locks the account");
});

test("classify: a session that advanced without a zero exit still is not silently ok", () => {
  const r = classifyResult({ output: "partial write", sessionAdvanced: true, cliCode: 3 });
  assert.equal(r.code, 1);
  assert.equal(r.token, "FAILED");
});

// ---------------------------------------------------------------------------
// scrubSecret - the log path
// ---------------------------------------------------------------------------

test("scrub: removes every occurrence of the secret", () => {
  const out = scrubSecret("user=abc pass=hunter2 retry pass=hunter2", "hunter2");
  assert.ok(!out.includes("hunter2"));
  assert.equal(out.match(/«redacted»/g).length, 2);
});

test("scrub: an empty secret is a no-op and never throws", () => {
  assert.equal(scrubSecret("nothing to hide", ""), "nothing to hide");
  assert.equal(scrubSecret("", "x"), "");
  assert.equal(scrubSecret(null, "x"), "");
});

test("scrub: a child line echoing the password never survives", () => {
  const secret = "P@ss w/ spaces!";
  assert.ok(!scrubSecret(`[debug] filling password field with ${secret} now`, secret).includes(secret));
});

// ---------------------------------------------------------------------------
// authCommand - never hardcode a package or a platform wrapper
// ---------------------------------------------------------------------------

test("authCommand: appends `auth` to the server's own argv", () => {
  const cmd = authCommand({ brightspace: { command: "npx", args: ["-y", "some-mcp-server"] } }, "brightspace");
  assert.deepEqual(cmd, { command: "npx", args: ["-y", "some-mcp-server", "auth"], env: null });
});

test("authCommand: a Windows cmd-wrapped entry keeps its wrapper", () => {
  const cmd = authCommand({ lms: { command: "cmd", args: ["/c", "npx", "-y", "some-mcp-server"] } }, "lms");
  assert.deepEqual(cmd.args, ["/c", "npx", "-y", "some-mcp-server", "auth"]);
});

test("authCommand: an unknown or malformed server yields null, not a throw", () => {
  assert.equal(authCommand({}, "brightspace"), null);
  assert.equal(authCommand(null, "brightspace"), null);
  assert.equal(authCommand({ brightspace: { args: ["x"] } }, "brightspace"), null);
});

// ---------------------------------------------------------------------------
// sessionStamp - "did the login actually write anything?"
// ---------------------------------------------------------------------------

test("sessionStamp: absent session files stamp as 0", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-reauth-"));
  assert.equal(sessionStamp(home), 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test("sessionStamp: a written session file advances the stamp", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-reauth-"));
  const dir = path.join(home, ".brightspace-mcp");
  fs.mkdirSync(dir, { recursive: true });
  const before = sessionStamp(home);
  fs.writeFileSync(path.join(dir, "session.json"), "{}");
  assert.ok(sessionStamp(home) > before);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The rest of the exit-code contract
// ---------------------------------------------------------------------------

test("classify: a missing package is 7, not a generic failure", () => {
  for (const output of [
    "npm ERR! code E404",
    "npx canceled due to missing packages and no YES option",
    "could not determine executable to run",
    "could not start npx: spawn npx ENOENT",
    "'npx' is not recognized as an internal or external command",
  ]) {
    const r = classifyResult({ output, sessionAdvanced: false, cliCode: 1 });
    assert.equal(r.code, 7, `${output} should be NO-PACKAGE`);
    assert.equal(r.token, "NO-PACKAGE");
  }
});

test("classify: nothing saved yet is 2, the code that asks for --setup", () => {
  const r = classifyResult({ output: "no stored credentials for this profile", sessionAdvanced: false, cliCode: 1 });
  assert.equal(r.code, 2);
  assert.equal(r.token, "NO-CREDS");
});

test("classify: a missing package beats a no-credentials line - a tool that never ran read nothing", () => {
  const r = classifyResult({ output: "npm ERR! code E404\nno credentials found", sessionAdvanced: false, cliCode: 1 });
  assert.equal(r.token, "NO-PACKAGE");
});

// ---------------------------------------------------------------------------
// parseArgs - an unknown flag must never become a live login
// ---------------------------------------------------------------------------

test("parseArgs: every documented flag is understood", () => {
  assert.deepEqual(parseArgs(["--probe"]).mode, "probe");
  assert.deepEqual(parseArgs(["--setup"]).mode, "setup");
  assert.equal(parseArgs([]).mode, "auth");
  assert.equal(parseArgs(["--silent"]).silent, true);
  assert.equal(parseArgs(["--quiet"]).silent, true, "--quiet stays as an alias of the documented --silent");
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--home", "/tmp/x"]).home, "/tmp/x");
  assert.equal(parseArgs(["--config", "other.json", "--data", "d"]).error, null);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: an unknown flag is a hard error, not a silent login", () => {
  // This is the regression that matters most in this file: --probe is
  // documented as sending no credentials, and the version that ignored unknown
  // flags answered it with a browser window and a two-factor push.
  for (const argv of [["--prob"], ["--dry_run"], ["--force"], ["scrape"]]) {
    const r = parseArgs(argv);
    assert.ok(r.error, `${argv.join(" ")} must be refused`);
    assert.match(r.error, /unknown option|unexpected argument/);
  }
});

test("parseArgs: two modes at once is refused rather than guessed at", () => {
  assert.match(parseArgs(["--probe", "--setup"]).error, /cannot both be given/);
});

test("the usage text names every exit code a runbook branches on", () => {
  for (const token of ["NO-CREDS", "BAD-CREDS", "MFA-PENDING", "NO-PACKAGE", "--probe", "--setup", "--silent"]) {
    assert.ok(USAGE.includes(token), `usage must mention ${token}`);
  }
});

// ---------------------------------------------------------------------------
// authCommand - the silent and fallback paths
// ---------------------------------------------------------------------------

test("authCommand: --silent never installs, so `npx -y` becomes `npx --no`", () => {
  const cmd = authCommand({ brightspace: { command: "npx", args: ["-y", "some-mcp-server"] } }, "brightspace", {
    silent: true,
  });
  assert.deepEqual(cmd.args, ["--no", "some-mcp-server", "auth"]);
});

test("authCommand: with no .mcp.json entry it falls back to the configured package", () => {
  const posix = authCommand({}, "brightspace", { pkg: "some-mcp-server@latest", platform: "linux" });
  assert.deepEqual(posix, { command: "npx", args: ["-y", "some-mcp-server@latest", "auth"], env: null });
  const win = authCommand({}, "brightspace", { pkg: "some-mcp-server@latest", platform: "win32" });
  assert.deepEqual(win.args, ["/c", "npx", "-y", "some-mcp-server@latest", "auth"]);
  assert.equal(win.command, "cmd", "a bare npx fails silently on Windows");
});

test("authCommand: nothing configured anywhere is still null, which is exit 2", () => {
  assert.equal(authCommand({}, "brightspace", { pkg: null }), null);
});

// ---------------------------------------------------------------------------
// --probe: structure, never values
// ---------------------------------------------------------------------------

test("sanitizeUrl keeps the query parameter names and drops every value", () => {
  assert.equal(
    sanitizeUrl("https://login.example.edu/authorize?client_id=abc123&state=secret&nonce=xyz"),
    "https://login.example.edu/authorize?client_id=&state=&nonce=",
  );
  assert.equal(sanitizeUrl("https://lms.example.edu/d2l/login"), "https://lms.example.edu/d2l/login");
  assert.equal(sanitizeUrl("not a url"), null);
});

test("parseLoginForm records field names and never a value", () => {
  const html = `
    <html><body>
      <form action="/login/submit" method="POST">
        <input type="text" name="username" value="someone@example.edu">
        <input type="password" name="password" value="hunter2">
        <input type="hidden" name="csrf" value="deadbeef">
        <button>Sign in</button>
      </form>
    </body></html>`;
  const form = parseLoginForm(html);
  assert.equal(form.action, "/login/submit");
  assert.equal(form.method, "post");
  assert.deepEqual(form.fields, [
    { name: "username", type: "text" },
    { name: "password", type: "password" },
  ]);
  assert.ok(!JSON.stringify(form).includes("hunter2"));
  assert.ok(!JSON.stringify(form).includes("deadbeef"), "hidden fields carry tokens and are not recorded");
  assert.equal(parseLoginForm("<html>no form here</html>"), null);
});

test("traceLoginChain follows redirects by hand and records each hop", async () => {
  const pages = {
    "https://lms.example.edu/": { status: 302, location: "https://login.example.edu/authorize?client_id=abc&state=s" },
    "https://login.example.edu/authorize?client_id=abc&state=s": {
      status: 200,
      body: '<form action="/submit" method="post"><input name="loginfmt" type="email"></form>',
    },
  };
  const fake = async (url) => {
    const page = pages[url];
    if (!page) throw new Error(`unexpected ${url}`);
    return {
      status: page.status,
      headers: new Headers(page.location ? { location: page.location } : {}),
      text: async () => page.body ?? "",
    };
  };
  const { chain, form } = await traceLoginChain("https://lms.example.edu/", fake);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].status, 302);
  assert.equal(chain[0].redirectsTo, "https://login.example.edu/authorize?client_id=&state=");
  assert.equal(chain[1].url, "https://login.example.edu/authorize?client_id=&state=");
  assert.deepEqual(form.fields, [{ name: "loginfmt", type: "email" }]);
  assert.ok(!JSON.stringify(chain).includes("abc"), "no query value survives the probe");
});

test("traceLoginChain records a dead host as a hop rather than throwing", async () => {
  const fake = async () => {
    throw new Error("getaddrinfo ENOTFOUND lms.example.edu");
  };
  const { chain } = await traceLoginChain("https://lms.example.edu/", fake);
  assert.equal(chain.length, 1);
  assert.match(chain[0].error, /ENOTFOUND/);
});

test("localProbe reports the server without exposing an env value", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-reauth-"));
  const report = localProbe({
    serverKey: "brightspace",
    entry: { command: "cmd", args: ["/c", "npx", "-y", "some-mcp-server"], env: { LMS_TOKEN: "secret-value" } },
    pkg: "some-mcp-server@latest",
    home,
  });
  assert.equal(report.declaredInMcpJson, true);
  assert.deepEqual(report.envKeys, ["LMS_TOKEN"]);
  assert.ok(!JSON.stringify(report).includes("secret-value"));
  assert.deepEqual(report.sessionFile, { present: false });
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// End to end, as a subprocess: the two paths that must never start a login
// ---------------------------------------------------------------------------

const runScript = (args, cwd = ROOT) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", cwd, timeout: 30000 });

test("--probe writes a credential-free report and exits 0 with nothing configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-probe-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-home-"));
  const r = runScript(["--probe", "--data", dir, "--home", home, "--config", path.join(dir, "absent.json")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reauth=PROBE wrote/);
  assert.ok(!/browser window/i.test(r.stdout), "the probe must never announce, or start, a login");
  const report = JSON.parse(fs.readFileSync(path.join(dir, "auth-probe.json"), "utf-8"));
  assert.equal(report.local.serverKey, "brightspace");
  assert.equal(report.local.sessionFile.present, false);
  assert.match(report.note, /No credentials/i);
  assert.match(report.hint, /institution\.lmsHost/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("an unknown flag exits 4 with the usage text, and starts nothing", () => {
  const r = runScript(["--probee"]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /reauth=FAILED\(USAGE\)/);
  assert.match(r.stderr, /--probe/);
  assert.equal(r.stdout.trim(), "", "nothing ran");
});

test("--help prints usage and exits 0 instead of logging in", () => {
  const r = runScript(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: node scripts\/reauth\.mjs/);
  assert.ok(!/browser window/i.test(r.stdout));
});

test("--dry-run prints the command it would run and runs nothing", () => {
  const r = runScript(["--dry-run"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /auth$/, "the auth subcommand is appended to the server's own argv");
});

test("--setup refuses to run without a terminal, so a scheduled run can never type a password", () => {
  const r = runScript(["--setup"]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /interactive and there is no terminal/);
});
