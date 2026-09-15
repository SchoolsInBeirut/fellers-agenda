// node --test test/send-digest.test.mjs
//
// The digest sender. Every test drives the pure functions or `cliMain` with a
// fake disk and a fake runner: no test starts PowerShell, opens Outlook, sends
// anything, or reads the repository's own data/ or config.json. The platform is
// injected, so the Windows-only path is exercised on ubuntu and the skip path is
// exercised on Windows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXIT,
  ascii,
  buildScript,
  cliMain,
  parseArgs,
  parseDigest,
  readSettings,
  sendWithRunner,
  shouldSend,
  subjectPattern,
} from "../src/send-digest.mjs";

const TITLE = "Weekly Agenda";
const SETTINGS = { title: TITLE, to: "student@example.edu", sink: "outlook" };

test("parseDigest splits subject and body", () => {
  const r = parseDigest("Weekly Agenda - Monday\n\nDUE TODAY\n  none\n", TITLE);
  assert.equal(r.subject, "Weekly Agenda - Monday");
  assert.match(r.body, /^DUE TODAY/);
});

test("the subject must be the configured title, with an optional BEHIND: prefix", () => {
  assert.ok(parseDigest("hello\nbody", TITLE).error);
  assert.equal(parseDigest("BEHIND: Weekly Agenda - Monday\nbody", TITLE).subject, "BEHIND: Weekly Agenda - Monday");
  // A title that merely starts the same is not the title: the boundary is real.
  assert.equal(parseDigest("Weekly Agendas - Monday\nbody", TITLE).error, "bad-subject");
  // Another installation's title travels with the config, not with the code.
  assert.equal(parseDigest("Lab Week - Monday\nbody", "Lab Week").subject, "Lab Week - Monday");
  assert.equal(parseDigest("Lab Week - Monday\nbody", TITLE).error, "bad-subject");
  // A title with regex punctuation in it is matched literally.
  assert.ok(subjectPattern("A.B (2026)").test("A.B (2026) - Friday"));
  assert.equal(subjectPattern("A.B (2026)").test("AXB (2026) - Friday"), false);
});

test("ascii folds smart punctuation and drops the rest", () => {
  assert.equal(ascii("She said \u201cgo\u201d \u2014 now\u2026"), 'She said "go" - now...');
});

test("buildScript escapes single quotes, carries the recipient, and never launches Outlook", () => {
  const s = buildScript({ subject: "It's", body: "a'b", to: "x@y" });
  assert.match(s, /It''s/);
  assert.match(s, /x@y/);
  assert.match(s, /\.Send\(\)/);
  assert.match(s, /Get-Process -Name OUTLOOK/);
  assert.equal(/Start-Process|OUTLOOK\.EXE/i.test(s), false);
});

test("sendWithRunner maps SENT to ok and anything else to a reason", () => {
  const mail = { subject: "Weekly Agenda - Monday", body: "b", to: "x@y", title: TITLE };
  assert.equal(sendWithRunner(mail, () => ({ status: 0, stdout: "SENT\n", stderr: "" })).ok, true);
  assert.equal(sendWithRunner(mail, () => ({ status: 1, stdout: "", stderr: "COM error" })).reason, "com");
  assert.equal(sendWithRunner(mail, () => ({ status: 3, stdout: "NO-OUTLOOK\n", stderr: "" })).reason, "no-outlook");
  assert.equal(sendWithRunner(mail, () => { throw new Error("spawn failed"); }).reason, "com");
  assert.equal(sendWithRunner({ ...mail, to: "nobody" }, () => ({ status: 0, stdout: "SENT" })).reason, "no-recipient");
  assert.equal(sendWithRunner({ ...mail, subject: "Anything" }, () => ({ status: 0, stdout: "SENT" })).reason, "bad-subject");
});

test("shouldSend refuses a missing, empty or stale file", () => {
  assert.equal(shouldSend({ exists: false, size: 1, mtimeMs: 9, sinceMs: null }).reason, "missing");
  assert.equal(shouldSend({ exists: true, size: 0, mtimeMs: 9, sinceMs: null }).reason, "empty");
  assert.equal(shouldSend({ exists: true, size: 9, mtimeMs: 5, sinceMs: 9 }).reason, "stale");
  assert.equal(shouldSend({ exists: true, size: 9, mtimeMs: 9, sinceMs: 9 }).send, true);
  assert.equal(shouldSend({ exists: true, size: 9, mtimeMs: 1, sinceMs: null }).send, true);
});

test("parseArgs reports a flag with nothing after it", () => {
  assert.equal(parseArgs(["--file"]).error, "--file needs a path");
  assert.equal(parseArgs(["--since", "not-a-date"]).error?.startsWith("--since is not an ISO instant"), true);
  assert.deepEqual(parseArgs([]), { file: null, sinceMs: null, error: null });
  assert.equal(parseArgs(["--since", "2026-09-15T14:30:00Z"]).sinceMs, Date.parse("2026-09-15T14:30:00Z"));
});

// --- the CLI, against a fake disk ------------------------------------------

const forbiddenFs = {
  existsSync() { throw new Error("the disk must never be touched on this path"); },
  statSync() { throw new Error("the disk must never be touched on this path"); },
  readFileSync() { throw new Error("the disk must never be touched on this path"); },
};

const forbiddenRunner = () => {
  throw new Error("the runner must never be reached in this test");
};

function runCli(deps, argv = []) {
  const printed = [];
  const code = cliMain(argv, { runner: forbiddenRunner, log: (line) => printed.push(line), warn: () => {}, ...deps });
  return { code, printed };
}

test("a platform with no mail sink skips before it reads anything", () => {
  const { code, printed } = runCli({ platform: "linux", fs: forbiddenFs, settings: SETTINGS });
  assert.equal(code, EXIT.ok);
  assert.deepEqual(printed, ["digest=SKIPPED(no-mail-sink)"]);
});

test('emailDigest other than "outlook" is SKIPPED(off), not a failure', () => {
  const { code, printed } = runCli({
    platform: "win32",
    fs: forbiddenFs,
    settings: { ...SETTINGS, sink: "off" },
  });
  assert.equal(code, EXIT.ok);
  assert.deepEqual(printed, ["digest=SKIPPED(off)"]);
});

test("a config that cannot be loaded is FAILED(bad-config), never a guessed subject", () => {
  const { code, printed } = runCli({
    platform: "win32",
    fs: forbiddenFs,
    settings: null,
    // readSettings is only reached when `settings` is not injected; force it to
    // throw by pointing --config at a file that is not JSON.
  }, ["--config", path.join(fixtureDir(), "not-json.txt")]);
  assert.equal(code, EXIT.failed);
  assert.deepEqual(printed, ["digest=FAILED(bad-config)"]);
});

test("bad arguments print one token and exit 1", () => {
  const { code, printed } = runCli({ platform: "win32", fs: forbiddenFs, settings: SETTINGS }, ["--file"]);
  assert.equal(code, EXIT.failed);
  assert.deepEqual(printed, ["digest=FAILED(bad-args)"]);
});

test("a missing or whitespace-only digest is digest=none, not a failure", () => {
  const empty = runCli({
    platform: "win32",
    settings: SETTINGS,
    fs: { existsSync: () => true, statSync: () => ({ size: 12, mtimeMs: 1 }), readFileSync: () => "   \n\n\t \n" },
  });
  assert.equal(empty.code, EXIT.ok);
  assert.deepEqual(empty.printed, ["digest=none"]);

  const missing = runCli({
    platform: "win32",
    settings: SETTINGS,
    fs: { existsSync: () => false, statSync: () => ({ size: 0, mtimeMs: 0 }), readFileSync: () => "" },
  });
  assert.deepEqual(missing.printed, ["digest=none"]);
});

test("a digest whose subject is not the configured title is refused, unsent", () => {
  const { code, printed } = runCli({
    platform: "win32",
    settings: SETTINGS,
    fs: { existsSync: () => true, statSync: () => ({ size: 40, mtimeMs: 1 }), readFileSync: () => "Someone else's mail\n\nbody" },
  });
  assert.equal(code, EXIT.failed);
  assert.deepEqual(printed, ["digest=FAILED(bad-subject)"]);
});

test("no configured recipient is FAILED(no-recipient) and the runner is never called", () => {
  const { code, printed } = runCli({
    platform: "win32",
    settings: { ...SETTINGS, to: "" },
    fs: { existsSync: () => true, statSync: () => ({ size: 40, mtimeMs: 1 }), readFileSync: () => "Weekly Agenda - Monday\n\nbody" },
  });
  assert.equal(code, EXIT.failed);
  assert.deepEqual(printed, ["digest=FAILED(no-recipient)"]);
});

test("a good digest is handed to the runner once and reported as sent", () => {
  const scripts = [];
  const printed = [];
  const code = cliMain(["--since", "2026-09-15T10:30:00Z"], {
    platform: "win32",
    settings: SETTINGS,
    fs: {
      existsSync: () => true,
      statSync: () => ({ size: 40, mtimeMs: Date.parse("2026-09-15T14:30:00Z") }),
      readFileSync: () => "BEHIND: Weekly Agenda - Tuesday\n\nDUE TODAY\n  MATH 210 HW 3\n",
    },
    runner: (script) => {
      scripts.push(script);
      return { status: 0, stdout: "SENT\n", stderr: "" };
    },
    log: (line) => printed.push(line),
    warn: () => {},
  });
  assert.equal(code, EXIT.ok);
  assert.deepEqual(printed, ["digest=sent"]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /BEHIND: Weekly Agenda - Tuesday/);
  assert.match(scripts[0], /student@example\.edu/);
});

test("a throw inside the CLI still prints one digest token and exits 1", () => {
  const { code, printed } = runCli({
    platform: "win32",
    settings: SETTINGS,
    fs: {
      existsSync: () => true,
      statSync: () => ({ size: 400, mtimeMs: 1 }),
      readFileSync: () => {
        const e = new Error("ENOENT: the digest vanished between the stat and the read");
        e.code = "ENOENT";
        throw e;
      },
    },
  });
  assert.equal(code, EXIT.failed);
  assert.deepEqual(printed, ["digest=FAILED(enoent)"]);
  assert.match(printed[0], /^digest=FAILED\([^()\s]+\)$/);
});

test("a throw with no errno still yields a one-word reason", () => {
  const { code, printed } = runCli({
    platform: "win32",
    settings: SETTINGS,
    fs: {
      existsSync: () => {
        throw new Error("disk on fire (with spaces and parens)");
      },
      statSync: () => ({ size: 1, mtimeMs: 1 }),
      readFileSync: () => "",
    },
  });
  assert.equal(code, EXIT.failed);
  assert.deepEqual(printed, ["digest=FAILED(crash)"]);
});

// --- the configured values, read from a scratch config.json ----------------

let FIXTURES = null;
function fixtureDir() {
  if (!FIXTURES) {
    FIXTURES = mkdtempSync(path.join(tmpdir(), "agenda-digest-"));
    writeFileSync(path.join(FIXTURES, "not-json.txt"), "this is not JSON", "utf8");
  }
  return FIXTURES;
}

test("readSettings takes the title, the recipient and the sink from --config", () => {
  const dir = fixtureDir();
  const file = path.join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({ title: "Lab Week", notifications: { emailDigest: "outlook", digestTo: "me@example.edu" } }),
    "utf8",
  );
  assert.deepEqual(readSettings(["--config", file], () => {}), {
    title: "Lab Week",
    to: "me@example.edu",
    sink: "outlook",
  });

  const bare = path.join(dir, "bare.json");
  writeFileSync(bare, "{}", "utf8");
  const defaults = readSettings(["--config", bare], () => {});
  assert.equal(defaults.title, TITLE);
  assert.equal(defaults.sink, "off");
  assert.equal(defaults.to, "");
});
