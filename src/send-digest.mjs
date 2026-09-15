#!/usr/bin/env node
// send-digest.mjs - mail `data/digest.md` to the user through Outlook Classic COM.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// The digest is the one artefact of the daily run that has to leave the machine
// as an EMAIL, and the model is not allowed a mail tool: a language model with a
// send button is a language model that can mail the wrong body to the wrong
// address on a bad day. So the model only ever WRITES a file; this script is the
// only thing that sends, it sends exactly what is in that file, and the
// recipient comes from `config.notifications.digestTo` - never from the digest,
// never from an argument.
//
// The transport is the one `src/connectors/calendar-outlook.mjs` and
// `src/deadman.mjs` already use: one `powershell.exe` process holding one
// `Outlook.Application` COM handle, no state kept in the shell. Outlook Classic
// is already signed in, so there is no OAuth, no app registration and no token
// to expire. It is also the ONLY mail sink in 2.0.0, which is why
// `notifications.emailDigest` has exactly two values, `"off"` and `"outlook"`.
//
// This script never STARTS Outlook. A scheduled run that launches OUTLOOK.EXE
// gets a headless instance that cannot show an MFA prompt and then wedges every
// later COM call. If Outlook is not already running the run reports
// `digest=FAILED(no-outlook)` and leaves the process table alone.
//
// ---------------------------------------------------------------------------
// USAGE
//   node src/send-digest.mjs                      send data/digest.md
//   node src/send-digest.mjs --file <path>        send another file
//   node src/send-digest.mjs --since <ISO>        only if the file is newer
//   node src/send-digest.mjs --config <p> --data <d>    (src/lib/paths.mjs)
//
// The last stdout line is the runlog token for phase 2 step 6, ALWAYS - a throw
// inside the CLI is caught and still prints one:
//   digest=sent                  the mail was handed to Outlook
//   digest=none                  no file, an empty or whitespace-only file, or
//                                older than --since
//   digest=SKIPPED(off)          notifications.emailDigest is not "outlook"
//   digest=SKIPPED(no-mail-sink) not Windows: there is no mail sink to hand it to
//   digest=FAILED(<reason>)      reason in {bad-args, bad-config, bad-subject,
//                                no-recipient, no-outlook, com}, or the errno of
//                                an unexpected throw
//
// EXIT CODES
//   0  digest=sent, digest=none or digest=SKIPPED(...) - nothing to do, and
//      nowhere to send it, are both ordinary configurations, not failures
//   1  digest=FAILED(<reason>)
//
// The digest file itself: line 1 is the subject and must start with
// `<config.title>` or `BEHIND: <config.title>`, an optional blank line, then the
// body. A subject this script does not recognise is a FAILURE, not a silent
// skip - it means something other than the digest writer wrote that file, and
// mailing it unread is exactly the wrong move.
//
// Tests: `test/send-digest.test.mjs`. They exercise the pure functions with a
// fake runner and a fake disk; no test starts PowerShell, opens Outlook, or
// sends anything.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULTS, loadConfig } from "./lib/config.mjs";
import { configPath, dataDir } from "./lib/paths.mjs";

const PS_TIMEOUT_MS = 2 * 60 * 1000;

export const EXIT = { ok: 0, failed: 1 };

// ------------------------------------------------------------------- text

/** Fold the punctuation a language model reaches for into its ASCII twin, then drop the rest. */
export function ascii(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7e\n\t]/g, "");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The only subjects this script will ever put on an outgoing mail: the
 * configured title, optionally prefixed `BEHIND: `. The lookahead is a word
 * boundary that works for a title ending in any character - "Weekly Agenda -
 * Monday" matches, "Weekly Agendas" does not.
 */
export function subjectPattern(title) {
  const clean = ascii(title).trim() || DEFAULTS.title;
  return new RegExp(`^(?:BEHIND:\\s+)?${escapeRegex(clean)}(?=$|[^A-Za-z0-9])`);
}

/**
 * Split a digest file into the mail it describes.
 * Line 1 is the subject; a blank line after it is optional; the rest is the body.
 * Returns `{ subject, body }` or `{ error }` - never throws, never mutates.
 */
export function parseDigest(text, title = DEFAULTS.title) {
  const clean = ascii(text);
  if (!clean.trim()) return { error: "empty" };
  const lines = clean.split("\n");
  const subject = String(lines[0] ?? "").trim();
  if (!subjectPattern(title).test(subject)) return { error: "bad-subject" };
  const rest = lines.slice(1);
  let start = 0;
  while (start < rest.length && rest[start].trim() === "") start += 1;
  const body = rest.slice(start).join("\n").replace(/\s+$/, "");
  return { subject, body };
}

// --------------------------------------------------------------- COM bridge

/** One PowerShell single-quoted literal. Doubling the quote is the whole escape. */
function psQuote(s) {
  return "'" + ascii(s).replace(/\n/g, " ").replace(/'/g, "''") + "'";
}

/**
 * The PowerShell text that sends ONE plain-text MailItem and prints `SENT`.
 * Every value is a quoted literal, so nothing in the digest can become code.
 */
export function buildScript({ subject, body, to }) {
  const bodyLines = ascii(body)
    .split("\n")
    .map((line) => "  " + psQuote(line))
    .join(",\n");
  return [
    "$ErrorActionPreference = 'Stop'",
    "# Attach to a RUNNING Outlook only - never launch one from a scheduled run.",
    "if (-not (Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue)) {",
    "  Write-Output 'NO-OUTLOOK'",
    "  exit 3",
    "}",
    "$bodyLines = @(",
    bodyLines,
    ")",
    "$body = [string]::Join([char]13 + [char]10, $bodyLines)",
    "try {",
    "  $app = New-Object -ComObject Outlook.Application",
    "  $mail = $app.CreateItem(0)",
    "  $mail.To = " + psQuote(to),
    "  $mail.Subject = " + psQuote(subject),
    "  $mail.BodyFormat = 1",
    "  $mail.Body = $body",
    "  $mail.Send()",
    "  Write-Output 'SENT'",
    "} catch {",
    "  Write-Output ('COM-ERROR: ' + $_.Exception.Message)",
    "  exit 4",
    "}",
    "exit 0",
  ].join("\n");
}

/** First useful line of a runner result, short enough for a log line. */
function firstLine(...blobs) {
  for (const blob of blobs) {
    const line = ascii(blob)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "");
    if (line) return line.slice(0, 200);
  }
  return "";
}

/**
 * Hand one mail to `runner(script) => { status, stdout, stderr }`.
 * `{ ok: true }` only when the script printed SENT on a clean exit; anything else
 * is `{ ok: false, reason, detail }` with a reason short enough for the runlog.
 */
export function sendWithRunner({ subject, body, to, title = DEFAULTS.title }, runner) {
  const recipient = ascii(to).trim();
  if (!recipient.includes("@")) return { ok: false, reason: "no-recipient", detail: "" };
  const line1 = ascii(subject).trim();
  if (!subjectPattern(title).test(line1)) return { ok: false, reason: "bad-subject", detail: line1.slice(0, 80) };

  let res;
  try {
    res = runner(buildScript({ subject: line1, body, to: recipient }));
  } catch (e) {
    return { ok: false, reason: "com", detail: firstLine((e && e.message) || String(e)) };
  }
  const status = res && typeof res.status === "number" ? res.status : 1;
  const stdout = ascii(res && res.stdout);
  const stderr = ascii(res && res.stderr);
  const printed = stdout.split("\n").map((l) => l.trim());
  if (status === 0 && printed.includes("SENT")) return { ok: true };
  if (printed.includes("NO-OUTLOOK")) return { ok: false, reason: "no-outlook", detail: "" };
  return { ok: false, reason: "com", detail: firstLine(stderr, stdout, "exit " + status) };
}

/** The real runner: a script file under `<data>/tmp` and one powershell.exe. */
export function makePowershellRunner(tmpDir) {
  const scriptPath = path.join(tmpDir, "send-digest.ps1");
  return function powershellRunner(script) {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(scriptPath, script, "utf8");
    const proc = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { encoding: "utf8", timeout: PS_TIMEOUT_MS, windowsHide: true },
    );
    return {
      status: typeof proc.status === "number" ? proc.status : 1,
      stdout: proc.stdout || "",
      stderr: proc.stderr || (proc.error ? proc.error.message : ""),
    };
  };
}

// ---------------------------------------------------------------------- CLI

const USAGE = "usage: node src/send-digest.mjs [--file <path>] [--since <ISO>] [--config <path>] [--data <dir>]";

/** `{ file, sinceMs, error }` - `file` is null for "the default", `sinceMs` null for "any age". */
export function parseArgs(argv) {
  const valueAfter = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : "";
  };
  const file = valueAfter("--file");
  const since = valueAfter("--since");
  if (file === "") return { file: null, sinceMs: null, error: "--file needs a path" };
  if (since === "") return { file, sinceMs: null, error: "--since needs an ISO instant" };
  const sinceMs = since === null ? null : Date.parse(since);
  if (sinceMs !== null && !Number.isFinite(sinceMs)) {
    return { file, sinceMs: null, error: "--since is not an ISO instant: " + since };
  }
  return { file, sinceMs, error: null };
}

/**
 * Is this file worth mailing? Pure, so the freshness rule is testable without a
 * disk. `{ send: true }` or `{ send: false, reason }` with the reason for the log.
 */
export function shouldSend({ exists, size, mtimeMs, sinceMs }) {
  if (!exists) return { send: false, reason: "missing" };
  if (!(Number(size) > 0)) return { send: false, reason: "empty" };
  if (sinceMs !== null && sinceMs !== undefined && Number(mtimeMs) < Number(sinceMs)) {
    return { send: false, reason: "stale" };
  }
  return { send: true, reason: "fresh" };
}

/**
 * The three configured values this script needs: the subject prefix, the
 * recipient, and whether there is a sink at all. A config.json that cannot be
 * read or validated is a FAILURE rather than a silent skip - guessing a subject
 * or a recipient is the one thing this script must never do.
 */
export function readSettings(argv, warn) {
  const cfg = loadConfig(configPath(argv), { argv, warn });
  return {
    title: ascii(cfg?.title).trim() || DEFAULTS.title,
    to: ascii(cfg?.notifications?.digestTo).trim(),
    sink: String(cfg?.notifications?.emailDigest ?? DEFAULTS.notifications.emailDigest),
  };
}

/** A one-word token for an unexpected throw: the errno if there is one. */
function crashReason(e) {
  const raw = e && typeof e.code === "string" && e.code ? e.code : "crash";
  const token = ascii(raw).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24).toLowerCase();
  return token || "crash";
}

/** The disk this CLI reads. Injectable so a test can make the read fail. */
const DEFAULT_FS = { existsSync, statSync, readFileSync };

/**
 * The CLI. Every path prints exactly one `digest=` token on stdout, including the
 * ones nobody planned for: a run that throws without a token leaves phase 2 with
 * no step result at all, which is worse than a token saying it broke.
 */
export function cliMain(argv, deps = {}) {
  const { log = console.log, warn = console.error } = deps;
  try {
    return cliRun(argv, deps);
  } catch (e) {
    warn("[send-digest] fatal: " + ((e && e.stack) || e));
    log("digest=FAILED(" + crashReason(e) + ")");
    return EXIT.failed;
  }
}

function cliRun(argv, deps = {}) {
  const {
    log = console.log,
    warn = console.error,
    fs = DEFAULT_FS,
    platform = process.platform,
    settings: injected = null,
  } = deps;

  const args = parseArgs(argv);
  if (args.error) {
    warn("[send-digest] " + args.error);
    warn(USAGE);
    log("digest=FAILED(bad-args)");
    return EXIT.failed;
  }

  // Outlook Classic COM is the only sink there is, and it is Windows-only. On
  // anything else the run is complete without a mail, and says so.
  if (platform !== "win32") {
    warn("[send-digest] no mail sink on " + platform + ": Outlook Classic COM needs Windows");
    log("digest=SKIPPED(no-mail-sink)");
    return EXIT.ok;
  }

  let settings;
  try {
    settings = injected ?? readSettings(argv, warn);
  } catch (e) {
    warn("[send-digest] " + ((e && e.message) || e));
    log("digest=FAILED(bad-config)");
    return EXIT.failed;
  }
  if (settings.sink !== "outlook") {
    warn('[send-digest] notifications.emailDigest is "' + settings.sink + '", not "outlook"');
    log("digest=SKIPPED(off)");
    return EXIT.ok;
  }

  const dir = dataDir(argv);
  const chosen = args.file ?? path.join(dir, "digest.md");
  const file = path.isAbsolute(chosen) ? chosen : path.resolve(process.cwd(), chosen);
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  const verdict = shouldSend({
    exists: Boolean(stat),
    size: stat ? stat.size : 0,
    mtimeMs: stat ? stat.mtimeMs : 0,
    sinceMs: args.sinceMs,
  });
  if (!verdict.send) {
    warn("[send-digest] nothing to send (" + verdict.reason + "): " + file);
    log("digest=none");
    return EXIT.ok;
  }

  const parsed = parseDigest(fs.readFileSync(file, "utf8"), settings.title);
  // A file that is bytes but no content is "empty": nothing to send is never a
  // failure, however many blank lines the writer left behind.
  if (parsed.error === "empty") {
    warn("[send-digest] nothing to send (whitespace-only): " + file);
    log("digest=none");
    return EXIT.ok;
  }
  if (parsed.error) {
    warn("[send-digest] " + file + " is not a digest (" + parsed.error + "): line 1 must start with " + JSON.stringify(settings.title));
    log("digest=FAILED(" + parsed.error + ")");
    return EXIT.failed;
  }

  if (!settings.to) {
    warn("[send-digest] config.notifications.digestTo is missing");
    log("digest=FAILED(no-recipient)");
    return EXIT.failed;
  }

  const runner = deps.runner ?? makePowershellRunner(path.join(dir, "tmp"));
  const sent = sendWithRunner({ subject: parsed.subject, body: parsed.body, to: settings.to, title: settings.title }, runner);
  if (sent.ok) {
    warn('[send-digest] sent "' + parsed.subject + '" to ' + settings.to);
    log("digest=sent");
    return EXIT.ok;
  }
  if (sent.detail) warn("[send-digest] " + sent.reason + ": " + sent.detail);
  log("digest=FAILED(" + sent.reason + ")");
  return EXIT.failed;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(cliMain(process.argv.slice(2)));
}
