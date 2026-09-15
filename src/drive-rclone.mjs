#!/usr/bin/env node
// drive-rclone.mjs - the Drive transport, with no model in the loop.
//
// WHY THIS FILE EXISTS
//
// Until 2.0.0 a language model moved every byte between this machine and Google
// Drive. It read `data/payload.b64.txt`, typed the contents into a connector
// call, then read the document back to check its own typing. That is a copy
// machine running on the largest model available: it cost more output tokens per
// day than every other part of the run put together, and its transcription error
// rate was not zero. This file is the subprocess that replaced it.
//
// THE SHAPE
//
// Every Drive operation is a plain `rclone` process. All of the logic lives in
// exported functions that take an injected `runner(args) -> {status, stdout,
// stderr}`, so the tests never touch the network, never touch rclone and never
// touch `data/`. `spawnSync` appears exactly once, in the thin CLI layer at the
// bottom, and so does every filesystem call.
//
// UPDATE IN PLACE, VERIFIED BY READ-BACK
//
// `copyto` replaces the body of the document that already carries the title, so
// the page's "newest document with this name" read keeps working and nothing is
// ever trashed. Both format flags are mandatory: with only
// `--drive-import-formats` rclone refuses the round trip ("can't convert .txt to
// a document with a different export filetype (.docx)").
//
// A publish is not finished when the upload exits 0. Google Docs is a rich-text
// editor, not a file store - an export comes back with a BOM, with CRLF, and
// with its blank lines rearranged. So the run reads the document back, slices
// the envelope out of both sides (`src/lib/envelope.mjs` strips whitespace for
// exactly this reason) and compares them, and it unpacks the LOCAL envelope
// first to prove the bytes that went up were readable in the first place. That
// second half matters more than it looks: a file that does not decode here is
// never sent, because a document nobody can read is worse than yesterday's.
//
// A payload that fails the read-back is replaced with `payload.last-good.txt`,
// so the page never serves a corrupt document for a day. A mirror that fails
// leaves the previous one exactly where it is, because insurance never fails the
// thing it insures.
//
// DUPLICATES FROM THE 1.x ERA
//
// 1.x created a new document and trashed the old one. A run that died between
// those two steps left two live documents with one title, and the page reads the
// newest - usually, but not always, the one that run wrote. So before every
// publish this file asks Drive how many documents carry the title and MOVES all
// but the newest into `<ns>-consumed/`, where they stay recoverable for seven
// days. Nothing here ever trashes anything, and a dedupe that cannot run is
// never a reason to skip the publish: tidying is not the job.
//
// Usage:
//   node src/drive-rclone.mjs status
//   node src/drive-rclone.mjs publish payload|mirror [--dry-run]
//   node src/drive-rclone.mjs pull <title> --out <dir>
//   node src/drive-rclone.mjs consume <id> --title <t>
//   node src/drive-rclone.mjs purge
// Every form also accepts `--config <path>` and `--data <dir>` (src/lib/paths.mjs).
//
// Exit codes:
//   status   0 ok / 2 rclone is not installed / 5 rclone cannot reach the remote
//   publish  0 ok / 3 the read-back did not verify (payload: last-good restored,
//            or `no-last-good` when there is none; mirror: the previous document
//            is kept) / 4 the LOCAL file is not a readable envelope and nothing
//            was sent / 1 anything else, a missing local file included
//   pull, consume, purge   0 / 1
//
// The rclone binary is `drive.rcloneExe`, else `$RCLONE_EXE`, else `rclone` on
// PATH, else the WinGet package. The OAuth token lives in
// `%APPDATA%\rclone\rclone.conf` on Windows and wherever rclone keeps it
// everywhere else - which is why `--config` is passed on win32 and only there.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KINDS, sliceEnvelope, unpack } from "./lib/envelope.mjs";
import { NOT_SET, derive, loadConfig } from "./lib/config.mjs";
import { argFlag, argHas, dataDir, repoRoot } from "./lib/paths.mjs";

// --------------------------------------------------------------- constants

/** The remote `rclone config create <name> drive` made, when config is silent. */
export const DEFAULT_REMOTE = "agenda";
/** Long, because a Docs import of a large body is slow and a retry is worse. */
export const RCLONE_TIMEOUT_MS = 120000;
/**
 * Room for a `cat` of the whole document. Node's default is 1 MiB, and both
 * envelopes are capped far below that today (`drive.maxEmitChars` 12,000,
 * `maxMirrorChars` 20,000) - but the day somebody raises a cap, the default
 * would turn a SUCCESSFUL upload into `ENOBUFS` on the read-back, and on the
 * payload path into a last-good restore nobody needed.
 */
export const RCLONE_MAX_BUFFER = 16 * 1024 * 1024;

const IMPORT = ["--drive-import-formats", "txt"];
const EXPORT = ["--drive-export-formats", "txt"];

/** Which `derive().docTitles` key and which envelope kind each publish means. */
export const PUBLISH_KINDS = Object.freeze({
  payload: { titleKey: "data", envelopeKind: "data", token: "drive", pathKey: "payload" },
  mirror: { titleKey: "mirror", envelopeKind: "mirror", token: "mirror", pathKey: "mirror" },
});

/** A runner that threw - a spawn error or a timeout - reports this status. */
const THREW = -1;

// --------------------------------------------------------------- names

/** Where consumed documents go to be recoverable for a week. */
export function consumedFolder(ns) {
  return `${ns}-consumed`;
}

/**
 * Every rclone command shape, in one place, bound to one remote.
 *
 * `name = '<title>'` is not escaped because it never needs to be: every title
 * comes from `derive().docTitles`, and `config.namespace` is validated against
 * `/^[a-z0-9-]{3,24}$/`. A title from anywhere else does not belong here.
 */
export function makeCommands({ remote = DEFAULT_REMOTE, consumed = consumedFolder(DEFAULT_REMOTE) } = {}) {
  const at = `${remote}:`;
  const bin = `${at}${consumed}`;
  return {
    status: () => ["lsjson", at, "--max-depth", "1", "--files-only"],
    // Both format flags or rclone refuses the update; see the header.
    copyto: (local, title) => ["copyto", local, `${at}${title}.txt`, ...IMPORT, ...EXPORT],
    cat: (title) => ["cat", `${at}${title}.txt`, ...EXPORT],
    query: (title) => ["backend", "query", at, `name = '${title}' and trashed = false`],
    copyid: (id, dest) => ["backend", "copyid", at, id, dest, ...EXPORT],
    moveid: (id, title) => ["backend", "moveid", at, id, `${bin}/${title}-${id}.txt`],
    purge: () => ["delete", "--min-age", "7d", bin],
  };
}

/** The full argv a shell would see, `--config` included where it applies. PURE. */
export function rcloneArgv(args, { exe = "rclone", conf = null } = {}) {
  return [exe, ...(conf ? ["--config", conf] : []), ...args];
}

/** The remote name for this config, or the contract default. */
export function remoteName(cfg) {
  return configString(cfg?.drive?.rcloneRemote) ?? DEFAULT_REMOTE;
}

/**
 * The rclone config file to pass on the command line, or null to let rclone find
 * its own. Windows is the exception because a scheduled task runs as the user
 * but not always with the profile rclone expects to look in.
 */
export function rcloneConfPath(platform = process.platform, env = process.env) {
  if (platform !== "win32" || !env.APPDATA) return null;
  return join(env.APPDATA, "rclone", "rclone.conf");
}

/**
 * Which binary to run: `drive.rcloneExe`, then `$RCLONE_EXE`, then `rclone` on
 * PATH, then the WinGet package. `onPath` and `winget` are injected probes, so
 * the precedence is testable without a filesystem. Falling through to the bare
 * name is deliberate - an ENOENT from the spawn becomes `rclone=missing`, which
 * is a better message than anything this function could invent.
 */
export function resolveRcloneExe({
  cfg = null, env = process.env, platform = process.platform,
  onPath = () => false, winget = () => null,
} = {}) {
  const fromConfig = configString(cfg?.drive?.rcloneExe);
  if (fromConfig) return fromConfig;
  const fromEnv = configString(env.RCLONE_EXE);
  if (fromEnv) return fromEnv;
  if (onPath()) return "rclone";
  if (platform === "win32") return winget() || "rclone";
  return "rclone";
}

/** A config string that is really set: not absent, not blank, not `[NOT SET]`. */
function configString(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t && t !== NOT_SET ? t : null;
}

// --------------------------------------------------------------- pure helpers

/** Undo what a Docs export adds: a BOM at the front and CRLF everywhere. */
export function normalizeExport(text) {
  return String(text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/**
 * rclone prints `NOTICE: <remote>: This remote uses rclone's shared Google Drive
 * client_id ...` on stderr on EVERY call. Drop that noise so the last line left
 * is the real error. Returns "" when there was nothing but noise.
 */
export function lastErrorLine(text) {
  const lines = String(text ?? "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("shared Google Drive client_id"));
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * The envelope at the head of a local file, proved readable. PURE.
 *
 * `sliceEnvelope` stops at the first `.END`, which is what keeps the plain-text
 * brief that rides after the payload out of the comparison. `unpack` is what
 * decides the bytes are a message: prefix, checksum, gzip stream and JSON, all
 * of it already implemented once in `src/lib/envelope.mjs`.
 */
export function readLocalEnvelope(text, expectKind) {
  if (!KINDS[expectKind]) return { ok: false, why: "unknown-kind" };
  const envelope = sliceEnvelope(text ?? "");
  if (!envelope) return { ok: false, why: "empty" };
  let read;
  try {
    read = unpack(envelope);
  } catch {
    return { ok: false, why: "unreadable" };
  }
  if (read.kind !== expectKind) return { ok: false, why: `wrong-kind-${read.kind}` };
  return { ok: true, envelope };
}

/** Did the document that came back carry exactly the envelope that went up? PURE. */
export function exportMatches(exported, envelope) {
  return sliceEnvelope(normalizeExport(exported)) === envelope;
}

/**
 * Which documents a dedupe would move, oldest first. The newest `modifiedTime`
 * is the one the page reads, so it is the one that stays. PURE.
 */
export function duplicatesToConsume(rows) {
  const live = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id);
  if (live.length < 2) return [];
  return [...live]
    .sort((a, b) => String(a.modifiedTime ?? "").localeCompare(String(b.modifiedTime ?? "")))
    .slice(0, -1);
}

/** `backend query` prints the literal `null` when nothing matches the name. PURE. */
export function parseQueryRows(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout || "[]");
  } catch {
    return null;
  }
  return Array.isArray(rows) ? rows : [];
}

// --------------------------------------------------------------- the runner seam

/**
 * The ONLY way this module calls the runner. The real one throws on a spawn
 * error or a timeout, and a throw means no token line for the pipeline, so every
 * throw becomes a result with `status: -1` instead. These functions return; they
 * do not raise.
 */
function safeRun(runner, args) {
  try {
    const r = runner(args);
    return { status: r?.status ?? 1, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "", code: null };
  } catch (e) {
    return { status: THREW, stdout: "", stderr: e?.message ? String(e.message) : String(e), code: e?.code || null };
  }
}

/**
 * Short, single-line reason for a runner that threw: the errno if there is one.
 *
 * ENOENT becomes `missing` rather than travelling as an errno. It is the one
 * cause a user can act on without reading anything - rclone is not installed -
 * and `rclone;missing` is the string the troubleshooting tables tell them to
 * grep their run log for. Every other errno stays as itself.
 */
function runReason(r) {
  if (r.code === "ENOENT") return "missing";
  return r.code || lastErrorLine(r.stderr).slice(0, 80) || "unknown";
}

// --------------------------------------------------------------- operations

export function statusWithRunner({ runner, remote = DEFAULT_REMOTE } = {}) {
  const r = safeRun(runner, makeCommands({ remote }).status());
  if (r.status === 0) return { exit: 0, line: "rclone=ok" };
  if (r.code === "ENOENT") return { exit: 2, line: "rclone=missing" };
  return { exit: 5, line: `rclone=auth-failed(${lastErrorLine(r.stderr) || lastErrorLine(r.stdout) || "unknown"})` };
}

/**
 * Move every document but the newest that carries `title` into the consumed
 * folder, and report how many moved. A query that fails or does not parse
 * returns 0 and the publish carries on - a tidy-up is never a reason to skip
 * the thing the run is actually for.
 */
export function dedupeWithRunner(title, { runner, remote = DEFAULT_REMOTE, consumed = consumedFolder(DEFAULT_REMOTE) } = {}) {
  const cmd = makeCommands({ remote, consumed });
  const q = safeRun(runner, cmd.query(title));
  if (q.status !== 0) return 0;
  const rows = parseQueryRows(q.stdout);
  if (!rows) return 0;
  let moved = 0;
  for (const d of duplicatesToConsume(rows)) {
    if (safeRun(runner, cmd.moveid(d.id, title)).status === 0) moved += 1;
  }
  return moved;
}

/** The rclone argv a publish would run, resolved, for `--dry-run` and the docs. PURE. */
export function publishPlan(kind, { docTitles, paths, remote = DEFAULT_REMOTE, consumed, exe, conf } = {}) {
  const spec = PUBLISH_KINDS[kind];
  if (!spec) return [];
  const cmd = makeCommands({ remote, consumed: consumed ?? consumedFolder(remote) });
  const title = docTitles?.[spec.titleKey];
  const local = paths?.[spec.pathKey];
  return [cmd.query(title), cmd.copyto(local, title), cmd.cat(title)]
    .map((args) => rcloneArgv(args, { exe, conf }));
}

/**
 * Publish one local file and prove it arrived. Returns `{exit, token}` for every
 * outcome - the pipeline needs exactly one token line whatever happened, so
 * `readFile` is guarded and every rclone call goes through `safeRun`.
 */
export function publishWithRunner(kind, {
  runner, docTitles, paths, remote = DEFAULT_REMOTE, consumed,
  readFile, writeFile, exists,
} = {}) {
  const spec = PUBLISH_KINDS[kind];
  if (!spec) return { exit: 1, token: `drive=FAILED(unknown-kind-${kind})` };
  const tok = spec.token;
  const title = docTitles?.[spec.titleKey];
  const local = paths?.[spec.pathKey];
  if (!title || !local) return { exit: 1, token: `${tok}=FAILED(no-title-or-path)` };
  const cmd = makeCommands({ remote, consumed: consumed ?? consumedFolder(remote) });

  let text = null;
  try { text = readFile(local); } catch { text = null; }
  if (text === null || text === undefined) return { exit: 1, token: `${tok}=FAILED(no-local-file)` };

  // Before any rclone call: a file that does not decode is never uploaded.
  const localEnv = readLocalEnvelope(text, spec.envelopeKind);
  if (!localEnv.ok) return { exit: 4, token: `${tok}=FAILED(local-invalid)` };

  const moved = dedupeWithRunner(title, { runner, remote, consumed });
  const tail = moved > 0 ? `;deduped=${moved}` : "";
  const fail = (why) => ({ exit: 1, token: `${tok}=FAILED(${why}${tail})` });

  const up = safeRun(runner, cmd.copyto(local, title));
  if (up.status === THREW) return fail(`rclone;${runReason(up)}`);
  if (up.status !== 0) return fail(`upload;${lastErrorLine(up.stderr) || `exit-${up.status}`}`);

  const back = safeRun(runner, cmd.cat(title));
  if (back.status === THREW) return fail(`rclone;${runReason(back)}`);
  // A cat that failed verified nothing, so it is exit 1 and no restore - distinct
  // from exit 3, where the document came back and did not match.
  if (back.status !== 0) return fail(`cat;${lastErrorLine(back.stderr) || `exit-${back.status}`}`);

  if (!exportMatches(back.stdout, localEnv.envelope)) {
    if (kind !== "payload") return { exit: 3, token: `${tok}=FAILED(verify;kept-previous${tail})` };
    // Only claim a restore that happened: on the first run of a new remote there
    // is no last-good file, and the document in Drive is the bad one nobody fixed.
    if (!paths.lastGood || !exists(paths.lastGood)) {
      return { exit: 3, token: `${tok}=FAILED(verify;no-last-good${tail})` };
    }
    // And only claim an upload that returned 0. Whatever broke the verify - the
    // remote unreachable, the quota gone - will usually break the restore too,
    // and `restored-last-good` tells the user their page is showing yesterday
    // when in fact the corrupt document is still the live one.
    const restore = safeRun(runner, cmd.copyto(paths.lastGood, title));
    const how = restore.status === 0 ? "restored-last-good" : "restore-failed";
    return { exit: 3, token: `${tok}=FAILED(verify;${how}${tail})` };
  }

  if (kind === "payload" && paths.lastGood) writeFile(paths.lastGood, text);
  return { exit: 0, token: `${tok}=ok(${Math.round(text.length / 1000)}KB;rclone;verified${tail})` };
}

/**
 * Copy every live document carrying `title` into `outDir`, oldest first, and
 * normalise each one. Oldest first is the order the buses must be applied in: a
 * later command has to win over an earlier one.
 */
export function pullWithRunner(title, { runner, remote = DEFAULT_REMOTE, outDir, readFile, writeFile } = {}) {
  const cmd = makeCommands({ remote });
  const q = safeRun(runner, cmd.query(title));
  if (q.status === THREW) return { error: `rclone;${runReason(q)}`, docs: [] };
  if (q.status !== 0) return { error: lastErrorLine(q.stderr) || "query-failed", docs: [] };
  const rows = parseQueryRows(q.stdout);
  if (!rows) return { error: "query-not-json", docs: [] };

  const docs = [...rows]
    .sort((a, b) => String(a.modifiedTime ?? "").localeCompare(String(b.modifiedTime ?? "")))
    .map((d) => ({ id: d.id, name: d.name, modifiedTime: d.modifiedTime, path: `${outDir}/${title}-${d.id}.txt` }));

  for (const d of docs) {
    const c = safeRun(runner, cmd.copyid(d.id, d.path));
    if (c.status === THREW) return { error: `rclone;${runReason(c)}`, docs: [] };
    if (c.status !== 0) return { error: `copyid-${d.id}`, docs: [] };
    // The export lands with a BOM and CRLF; rewrite it clean so the AGC1./AGQ1.
    // envelopes completion.mjs and command-ingest.mjs read are byte-sane.
    if (readFile && writeFile) {
      try {
        const raw = readFile(d.path);
        if (raw !== null && raw !== undefined) writeFile(d.path, normalizeExport(raw));
      } catch {
        return { error: `normalize-${d.id}`, docs: [] };
      }
    }
  }
  return { docs };
}

export function consumeWithRunner(id, title, { runner, remote = DEFAULT_REMOTE, consumed } = {}) {
  const cmd = makeCommands({ remote, consumed: consumed ?? consumedFolder(remote) });
  const r = safeRun(runner, cmd.moveid(id, title));
  if (r.status === 0) return { exit: 0, line: `consumed ${id}` };
  const why = r.status === THREW ? `rclone;${runReason(r)}` : lastErrorLine(r.stderr) || `exit-${r.status}`;
  return { exit: 1, line: `consume-failed ${id}: ${why}` };
}

export function purgeWithRunner({ runner, remote = DEFAULT_REMOTE, consumed } = {}) {
  const cmd = makeCommands({ remote, consumed: consumed ?? consumedFolder(remote) });
  const r = safeRun(runner, cmd.purge());
  if (r.status === 0) return { exit: 0, line: "purge=ok" };
  const why = r.status === THREW ? `rclone;${runReason(r)}` : lastErrorLine(r.stderr) || `exit-${r.status}`;
  return { exit: 1, line: `purge=FAILED(${why})` };
}

// --------------------------------------------------------------- CLI

const USAGE =
  "usage: node src/drive-rclone.mjs status | publish payload|mirror [--dry-run] | " +
  "pull <title> --out <dir> | consume <id> --title <t> | purge   [--config <path>] [--data <dir>]";

/** The local files a publish reads and writes, under whichever data dir is in play. */
export function localPaths(dir) {
  return {
    payload: join(dir, "payload.b64.txt"),
    mirror: join(dir, "backup.b64.txt"),
    lastGood: join(dir, "payload.last-good.txt"),
  };
}

/**
 * The WinGet package payload, whatever version is installed. The private
 * instance hard-codes one version string; a template that ships to other people
 * cannot, so this looks for any `Rclone.Rclone*` package with an `rclone.exe`.
 */
function wingetRclone(env = process.env) {
  const base = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages") : null;
  if (!base || !existsSync(base)) return null;
  try {
    for (const pkg of readdirSync(base)) {
      if (!pkg.startsWith("Rclone.Rclone")) continue;
      for (const version of readdirSync(join(base, pkg))) {
        const exe = join(base, pkg, version, "rclone.exe");
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    // An unreadable package folder is simply not an answer.
  }
  return null;
}

function onPath() {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, ["rclone"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/**
 * The one runner that starts a process. `spawnSyncImpl` is injectable only so a
 * test can read the options back; nothing in the pipeline passes it.
 */
export function makeRealRunner(exe, conf, spawnSyncImpl = spawnSync) {
  return (args) => {
    const argv = rcloneArgv(args, { exe, conf });
    const r = spawnSyncImpl(argv[0], argv.slice(1), {
      encoding: "utf8",
      timeout: RCLONE_TIMEOUT_MS,
      maxBuffer: RCLONE_MAX_BUFFER,
    });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
  };
}

const realFs = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, t) => writeFileSync(p, t),
  exists: (p) => existsSync(p),
};

/**
 * The whole command line, with every impure thing injectable so a test can drive
 * it without rclone, without a config and without `data/`.
 */
export function cliMain(argv, ports = {}) {
  const log = ports.log ?? ((s) => console.log(s));
  const err = ports.err ?? ((s) => console.error(s));
  const cfg = ports.cfg ?? loadConfig(null, { argv });
  const d = derive(cfg);
  const remote = ports.remote ?? remoteName(cfg);
  const consumed = consumedFolder(d.ns);
  const docTitles = ports.docTitles ?? d.docTitles;
  const dir = ports.dataDir ?? dataDir(argv, repoRoot());
  const paths = ports.paths ?? localPaths(dir);
  const exe = ports.exe ?? resolveRcloneExe({ cfg, onPath, winget: wingetRclone });
  const conf = ports.conf !== undefined ? ports.conf : rcloneConfPath();
  const runner = ports.runner ?? makeRealRunner(exe, conf);
  const fs = ports.fs ?? realFs;

  const [cmd, a] = argv;
  const opt = (k) => argFlag(argv, k);

  if (cmd === "status") {
    const r = statusWithRunner({ runner, remote });
    log(r.line);
    return r.exit;
  }
  if (cmd === "publish" && PUBLISH_KINDS[a]) {
    if (argHas(argv, "dry-run")) {
      for (const line of publishPlan(a, { docTitles, paths, remote, consumed, exe, conf })) log(line.join(" "));
      return 0;
    }
    const r = publishWithRunner(a, { runner, docTitles, paths, remote, consumed, ...fs });
    log(r.token);
    return r.exit;
  }
  if (cmd === "pull" && a) {
    const r = pullWithRunner(a, { runner, remote, outDir: opt("out") || join(dir, "tmp"), ...fs });
    log(JSON.stringify(r.error ? { error: r.error } : { docs: r.docs }));
    return r.error ? 1 : 0;
  }
  if (cmd === "consume" && a) {
    const r = consumeWithRunner(a, opt("title") || "doc", { runner, remote, consumed });
    log(r.line);
    return r.exit;
  }
  if (cmd === "purge") {
    const r = purgeWithRunner({ runner, remote, consumed });
    log(r.line);
    return r.exit;
  }
  err(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(cliMain(process.argv.slice(2)));
}
