// node --test  (run from the repository root)
//
// Nothing here runs rclone, reaches the network, or looks at `data/`. Every
// exported function takes an injected runner, so a test is a script of fake
// rclone results and an assertion about the token line the pipeline will read.
//
// The envelopes are REAL: `pack()` from src/lib/envelope.mjs builds them and
// `docsExport()` puts them through what Google Docs actually does to a document
// on the way out - a BOM at the front, CRLF everywhere, the blank lines
// rearranged, and the plain-text brief still sitting after the terminator. A
// verification that passes a hand-written string and fails that round trip is a
// verification that has never been tested.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REMOTE,
  PUBLISH_KINDS,
  RCLONE_MAX_BUFFER,
  RCLONE_TIMEOUT_MS,
  cliMain,
  consumeWithRunner,
  consumedFolder,
  dedupeWithRunner,
  duplicatesToConsume,
  exportMatches,
  lastErrorLine,
  localPaths,
  makeCommands,
  makeRealRunner,
  normalizeExport,
  parseQueryRows,
  publishPlan,
  publishWithRunner,
  pullWithRunner,
  purgeWithRunner,
  rcloneArgv,
  rcloneConfPath,
  readLocalEnvelope,
  remoteName,
  resolveRcloneExe,
  statusWithRunner,
} from "../src/drive-rclone.mjs";
import { pack } from "../src/lib/envelope.mjs";
import { derive } from "../src/lib/config.mjs";

const NOTICE = "NOTICE: agenda: This remote uses rclone's shared Google Drive client_id - see the docs";

const TITLES = derive({ namespace: "study" }).docTitles;
const CONSUMED = consumedFolder("study");
const PATHS = {
  payload: "data/payload.b64.txt",
  mirror: "data/backup.b64.txt",
  lastGood: "data/payload.last-good.txt",
};

/** What `src/render.mjs` writes: the envelope, a blank line, then the phone brief. */
function payloadFile(scrapedAt = "2026-09-15T14:30:00.000Z") {
  const envelope = pack("data", { v: 4, scrapedAt, items: [{ k: "1::hw::x", t: "Homework 2" }] });
  return `${envelope}\n\n--- BRIEF ---\nHomework 2 is due Tuesday.\n--- END BRIEF ---\n`;
}

/** What `src/drive-bundle.mjs --pack` writes: the mirror envelope, alone. */
function mirrorFile() {
  return `${pack("mirror", { v: 1, packedAt: "2026-09-15T14:30:00.000Z", files: { "config.json": "{}" } })}\n`;
}

/**
 * What a Google Docs export gives back. Docs is a rich-text editor: it hands
 * over a BOM, it uses CRLF, and it does not preserve blank lines. The brief
 * after the terminator comes back too, which is exactly why every machine reader
 * slices at the first `.END`.
 */
function docsExport(local) {
  const kept = String(local).split("\n").filter((line) => line.trim() !== "");
  return `\uFEFF${kept.join("\r\n")}\r\n`;
}

/**
 * Corrupt one character INSIDE the base64 body, keeping it a legal base64
 * character and the envelope's prefix and terminator intact - so it is the
 * CRC32, not the shape, that has to catch it.
 */
function mangle(text) {
  const i = text.indexOf(".END") - 12;
  return text.slice(0, i) + (text[i] === "Z" ? "Y" : "Z") + text.slice(i + 1);
}

/** script: [{match: RegExp, status, stdout, stderr}] against the joined argv. */
function fakeRunner(script = []) {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const hit = script.find((s) => s.match.test(args.join(" ")));
    return hit
      ? { status: hit.status ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" }
      : { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function fakeFs(files) {
  return {
    readFile: (p) => files[p],
    writeFile: (p, t) => { files[p] = t; },
    exists: (p) => p in files,
  };
}

const publish = (kind, opts) =>
  publishWithRunner(kind, { docTitles: TITLES, paths: PATHS, remote: "gd", consumed: CONSUMED, ...opts });

// ------------------------------------------------------------------ pure helpers

test("normalizeExport strips a BOM and CRLF so an exported document compares equal", () => {
  assert.equal(normalizeExport("\uFEFFa\r\nb\r\n"), "a\nb\n");
  assert.equal(normalizeExport(null), "");
});

test("the shared client_id NOTICE never becomes the failure reason", () => {
  assert.equal(lastErrorLine(`${NOTICE}\n`), "");
  assert.equal(lastErrorLine(`${NOTICE}\nrateLimitExceeded\n`), "rateLimitExceeded");
  assert.equal(lastErrorLine(undefined), "");
});

test("parseQueryRows treats the literal null from backend query as zero rows", () => {
  assert.deepEqual(parseQueryRows("null\n"), []);
  assert.deepEqual(parseQueryRows(""), []);
  assert.deepEqual(parseQueryRows("[{\"id\":\"A1\"}]"), [{ id: "A1" }]);
  assert.equal(parseQueryRows("not json"), null);
});

test("duplicatesToConsume keeps the newest modifiedTime and returns the rest oldest first", () => {
  const rows = [
    { id: "B", modifiedTime: "2026-09-15T10:00:00Z" },
    { id: "C", modifiedTime: "2026-09-16T10:00:00Z" },
    { id: "A", modifiedTime: "2026-09-14T10:00:00Z" },
  ];
  assert.deepEqual(duplicatesToConsume(rows).map((d) => d.id), ["A", "B"]);
  assert.deepEqual(duplicatesToConsume([rows[0]]), []);
  assert.deepEqual(duplicatesToConsume(null), []);
});

test("readLocalEnvelope accepts a real payload file, refuses a mangled one, and checks the kind", () => {
  const file = payloadFile();
  const ok = readLocalEnvelope(file, "data");
  assert.equal(ok.ok, true);
  // The brief after the terminator is never part of the envelope.
  assert.ok(ok.envelope.endsWith(".END"));
  assert.ok(!ok.envelope.includes("BRIEF"));

  assert.equal(readLocalEnvelope(mangle(file), "data").ok, false);
  assert.equal(readLocalEnvelope("", "data").why, "empty");
  assert.equal(readLocalEnvelope("not an envelope", "data").why, "unreadable");
  // A mirror file published as the payload would verify perfectly and be useless.
  assert.equal(readLocalEnvelope(mirrorFile(), "data").why, "wrong-kind-mirror");
  assert.equal(readLocalEnvelope(payloadFile(), "nonsense").why, "unknown-kind");
});

test("exportMatches survives a real Docs round trip and catches a single changed character", () => {
  const file = payloadFile();
  const { envelope } = readLocalEnvelope(file, "data");
  assert.equal(exportMatches(docsExport(file), envelope), true);
  // Extra blank lines, which Docs also produces, change nothing.
  assert.equal(exportMatches(`${docsExport(file)}\r\n\r\n`, envelope), true);
  assert.equal(exportMatches(docsExport(mangle(file)), envelope), false);
  assert.equal(exportMatches("", envelope), false);
});

// ------------------------------------------------------------------ names and argv

test("makeCommands is the single place command shapes live, and copyto needs both format flags", () => {
  const cmd = makeCommands({ remote: "gd", consumed: CONSUMED });
  assert.ok(cmd.query("study-data").includes("name = 'study-data' and trashed = false"));
  const c = cmd.copyto("data/payload.b64.txt", "study-data");
  assert.deepEqual(c.slice(0, 3), ["copyto", "data/payload.b64.txt", "gd:study-data.txt"]);
  assert.equal(c[c.indexOf("--drive-import-formats") + 1], "txt");
  assert.equal(c[c.indexOf("--drive-export-formats") + 1], "txt");
  assert.deepEqual(cmd.moveid("A1", "study-commands"), [
    "backend", "moveid", "gd:", "A1", "gd:study-consumed/study-commands-A1.txt",
  ]);
  assert.deepEqual(cmd.purge(), ["delete", "--min-age", "7d", "gd:study-consumed"]);
});

test("the remote name comes from config, and the default is the one the docs tell people to create", () => {
  assert.equal(remoteName({ drive: { rcloneRemote: "mydrive" } }), "mydrive");
  assert.equal(remoteName({}), DEFAULT_REMOTE);
  assert.equal(remoteName(null), "agenda");
  // A config builder D has not filled in yet must not become the remote name.
  assert.equal(remoteName({ drive: { rcloneRemote: "[NOT SET]" } }), "agenda");
  assert.equal(remoteName({ drive: { rcloneRemote: "   " } }), "agenda");
});

test("--config is passed on win32 and NOWHERE else, because rclone finds its own", () => {
  const win = rcloneConfPath("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" });
  assert.ok(win.endsWith("rclone.conf"));
  assert.ok(win.includes("AppData"));
  assert.equal(rcloneConfPath("linux", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }), null);
  assert.equal(rcloneConfPath("darwin", {}), null);
  // No APPDATA on win32 either: a relative "rclone/rclone.conf" would be worse
  // than letting rclone look where it normally looks.
  assert.equal(rcloneConfPath("win32", {}), null);

  assert.deepEqual(rcloneArgv(["lsjson", "gd:"], { exe: "rclone", conf: null }), ["rclone", "lsjson", "gd:"]);
  assert.deepEqual(rcloneArgv(["lsjson", "gd:"], { exe: "R.exe", conf: "C:\\c.conf" }), [
    "R.exe", "--config", "C:\\c.conf", "lsjson", "gd:",
  ]);
});

test("the rclone binary resolves config, then $RCLONE_EXE, then PATH, then WinGet", () => {
  const cfg = { drive: { rcloneExe: "C:\\tools\\rclone.exe" } };
  assert.equal(resolveRcloneExe({ cfg, env: { RCLONE_EXE: "E" }, onPath: () => true }), "C:\\tools\\rclone.exe");
  assert.equal(resolveRcloneExe({ cfg: { drive: { rcloneExe: "[NOT SET]" } }, env: { RCLONE_EXE: "E" } }), "E");
  assert.equal(resolveRcloneExe({ cfg: {}, env: {}, onPath: () => true }), "rclone");
  assert.equal(
    resolveRcloneExe({ cfg: {}, env: {}, platform: "win32", onPath: () => false, winget: () => "W\\rclone.exe" }),
    "W\\rclone.exe",
  );
  // Nothing found anywhere: run the bare name so the ENOENT becomes rclone=missing.
  assert.equal(resolveRcloneExe({ cfg: {}, env: {}, platform: "linux", onPath: () => false }), "rclone");
  assert.equal(resolveRcloneExe({ cfg: {}, env: {}, platform: "win32", onPath: () => false, winget: () => null }), "rclone");
});

// ------------------------------------------------------------------ status

test("status maps rclone outcomes to the three exit codes", () => {
  assert.deepEqual(statusWithRunner({ runner: fakeRunner([{ match: /lsjson/, status: 0, stdout: "[]" }]).runner }), {
    exit: 0, line: "rclone=ok",
  });
  assert.equal(statusWithRunner({ runner: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } }).exit, 2);

  const stderr = `${NOTICE}\nFailed to lsjson: googleapi: Error 403: rateLimitExceeded\n`;
  const s = statusWithRunner({ runner: fakeRunner([{ match: /lsjson/, status: 1, stderr }]).runner });
  assert.equal(s.exit, 5);
  assert.match(s.line, /^rclone=auth-failed\(.*rateLimitExceeded\)$/);
  assert.ok(!s.line.includes("client_id"));
});

test("status asks the configured remote, not a hard-coded one", () => {
  const { runner, calls } = fakeRunner([{ match: /lsjson/, status: 0 }]);
  statusWithRunner({ runner, remote: "mydrive" });
  assert.deepEqual(calls[0], ["lsjson", "mydrive:", "--max-depth", "1", "--files-only"]);
});

// ------------------------------------------------------------------ publish

test("publish payload: dedupe, copyto, cat, verify, and only then last-good", () => {
  const text = payloadFile();
  const files = { [PATHS.payload]: text };
  const { runner, calls } = fakeRunner([
    { match: /^backend query/, status: 0, stdout: "null" },
    { match: /^cat/, status: 0, stdout: docsExport(text) },
  ]);
  const r = publish("payload", { runner, ...fakeFs(files) });

  assert.equal(r.exit, 0);
  assert.match(r.token, /^drive=ok\(\d+KB;rclone;verified\)$/);
  assert.equal(files[PATHS.lastGood], text);
  // The titles are derived from the namespace, not spelled by hand.
  assert.deepEqual(calls.map((c) => c[0]), ["backend", "copyto", "cat"]);
  assert.deepEqual(calls[1].slice(0, 3), ["copyto", "data/payload.b64.txt", "gd:study-data.txt"]);
  assert.equal(calls[2][1], "gd:study-data.txt");
});

test("publish mirror verifies the same way and never writes a last-good", () => {
  const text = mirrorFile();
  const files = { [PATHS.mirror]: text };
  const r = publish("mirror", {
    runner: fakeRunner([{ match: /^cat/, stdout: docsExport(text) }]).runner,
    ...fakeFs(files),
  });
  assert.equal(r.exit, 0);
  assert.match(r.token, /^mirror=ok\(\d+KB;rclone;verified\)$/);
  assert.equal(files[PATHS.lastGood], undefined);
});

test("publish payload: a failed verify re-uploads last-good and exits 3", () => {
  const fresh = payloadFile("2026-09-15T14:30:00.000Z");
  const good = payloadFile("2026-09-14T00:00:00.000Z");
  const files = { [PATHS.payload]: fresh, [PATHS.lastGood]: good };
  const { runner, calls } = fakeRunner([{ match: /^cat/, status: 0, stdout: docsExport(mangle(fresh)) }]);

  const r = publish("payload", { runner, ...fakeFs(files) });

  assert.equal(r.exit, 3);
  assert.equal(r.token, "drive=FAILED(verify;restored-last-good)");
  const copytos = calls.filter((c) => c[0] === "copyto");
  assert.equal(copytos.length, 2);
  assert.equal(copytos[1][1], PATHS.lastGood);
  // The bad bytes never become the new last-good.
  assert.equal(files[PATHS.lastGood], good);
});

test("a restore that itself fails says so rather than claiming the page was put back", () => {
  // Whatever broke the verify usually breaks the restore too - an unreachable
  // remote, an exhausted quota. `restored-last-good` would then send the user to
  // a troubleshooting row that says "the page is showing yesterday" when the
  // corrupt document is still the live one.
  const fresh = payloadFile();
  const files = { [PATHS.payload]: fresh, [PATHS.lastGood]: payloadFile("2026-09-14T00:00:00.000Z") };
  const { runner, calls } = fakeRunner([
    { match: /^backend query/, stdout: "null" },
    { match: /^cat/, status: 0, stdout: docsExport(mangle(fresh)) },
    { match: /^copyto data\/payload\.last-good\.txt/, status: 7, stderr: `${NOTICE}\nquota exceeded` },
  ]);

  const r = publish("payload", { runner, ...fakeFs(files) });

  assert.equal(r.exit, 3);
  assert.equal(r.token, "drive=FAILED(verify;restore-failed)");
  assert.equal(calls.filter((c) => c[0] === "copyto").length, 2);

  // A restore the runner could not even start is the same answer, not a throw.
  const throwing = (args) => {
    if (args[0] === "copyto" && args[1] === PATHS.lastGood) throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
    if (args[0] === "cat") return { status: 0, stdout: docsExport(mangle(fresh)), stderr: "" };
    return { status: 0, stdout: "null", stderr: "" };
  };
  const t = publish("payload", { runner: throwing, ...fakeFs(files) });
  assert.equal(t.exit, 3);
  assert.equal(t.token, "drive=FAILED(verify;restore-failed)");
});

test("a payload verify failure with no last-good says so instead of claiming a restore", () => {
  const fresh = payloadFile();
  const files = { [PATHS.payload]: fresh };
  const { runner, calls } = fakeRunner([{ match: /^cat/, status: 0, stdout: docsExport(mangle(fresh)) }]);

  const r = publish("payload", { runner, ...fakeFs(files) });

  assert.equal(r.exit, 3);
  assert.equal(r.token, "drive=FAILED(verify;no-last-good)");
  assert.equal(calls.filter((c) => c[0] === "copyto").length, 1);
});

test("a mirror that does not verify keeps the previous document and restores nothing", () => {
  const text = mirrorFile();
  const files = { [PATHS.mirror]: text, [PATHS.lastGood]: payloadFile() };
  const { runner, calls } = fakeRunner([{ match: /^cat/, status: 0, stdout: docsExport(mangle(text)) }]);

  const r = publish("mirror", { runner, ...fakeFs(files) });

  assert.equal(r.exit, 3);
  assert.equal(r.token, "mirror=FAILED(verify;kept-previous)");
  assert.equal(calls.filter((c) => c[0] === "copyto").length, 1);
});

test("publish refuses a missing or unreadable local file and calls rclone not at all", () => {
  const a = fakeRunner();
  const r = publish("payload", { runner: a.runner, readFile: () => undefined, writeFile: () => {}, exists: () => false });
  assert.equal(r.exit, 1);
  assert.equal(r.token, "drive=FAILED(no-local-file)");
  assert.equal(a.calls.length, 0);

  const b = fakeRunner();
  const m = publish("mirror", {
    runner: b.runner,
    readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    writeFile: () => {},
    exists: () => false,
  });
  assert.equal(m.exit, 1);
  assert.equal(m.token, "mirror=FAILED(no-local-file)");
  assert.equal(b.calls.length, 0);
});

test("a local file that does not unpack is exit 4 and nothing is uploaded", () => {
  for (const [kind, key, bad] of [
    ["payload", "payload", mangle(payloadFile())],
    ["mirror", "mirror", "AGM2.deadbeef.notbase64!.END\n"],
    // Right shape, wrong message: the mirror envelope in the payload's file.
    ["payload", "payload", mirrorFile()],
  ]) {
    const files = { [PATHS[key]]: bad };
    const { runner, calls } = fakeRunner();
    const r = publish(kind, { runner, ...fakeFs(files) });
    assert.equal(r.exit, 4);
    assert.equal(r.token, `${PUBLISH_KINDS[kind].token}=FAILED(local-invalid)`);
    assert.equal(calls.length, 0);
    assert.equal(files[PATHS.lastGood], undefined);
  }
});

test("publish maps a cat that throws mid-run, and a cat that fails, without restoring", () => {
  const good = payloadFile();
  const files = { [PATHS.payload]: good, [PATHS.lastGood]: good };

  let seen = 0;
  const flaky = (args) => {
    seen += 1;
    if (args[0] === "cat") throw Object.assign(new Error("spawnSync rclone ETIMEDOUT"), { code: "ETIMEDOUT" });
    return { status: 0, stdout: "null", stderr: "" };
  };
  const t = publish("payload", { runner: flaky, ...fakeFs(files) });
  assert.equal(t.exit, 1);
  assert.equal(t.token, "drive=FAILED(rclone;ETIMEDOUT)");
  assert.equal(seen, 3);                                   // query, copyto, cat - and no restore

  const { runner, calls } = fakeRunner([
    { match: /^backend query/, stdout: "null" },
    { match: /^cat/, status: 3, stderr: `${NOTICE}\ndirectory not found` },
  ]);
  const r = publish("payload", { runner, ...fakeFs(files) });
  assert.equal(r.exit, 1);
  assert.equal(r.token, "drive=FAILED(cat;directory not found)");
  assert.equal(calls.filter((c) => c[0] === "copyto").length, 1);
});

test("an upload that fails is exit 1 and says what rclone said", () => {
  const files = { [PATHS.payload]: payloadFile() };
  const { runner } = fakeRunner([
    { match: /^backend query/, stdout: "null" },
    { match: /^copyto/, status: 7, stderr: `${NOTICE}\nquota exceeded` },
  ]);
  const r = publish("payload", { runner, ...fakeFs(files) });
  assert.equal(r.exit, 1);
  assert.equal(r.token, "drive=FAILED(upload;quota exceeded)");
});

test("a runner that throws never escapes: every command still returns its line", () => {
  const good = payloadFile();
  const files = { [PATHS.payload]: good, [PATHS.lastGood]: good, [PATHS.mirror]: mirrorFile() };
  const throwing = (code, message) => () => { throw Object.assign(new Error(message), { code }); };
  const fs = fakeFs(files);

  const m = publish("mirror", { runner: throwing("ETIMEDOUT", "spawnSync rclone ETIMEDOUT"), ...fs });
  assert.equal(m.exit, 1);
  assert.equal(m.token, "mirror=FAILED(rclone;ETIMEDOUT)");

  const c = consumeWithRunner("A1", "study-commands", { runner: throwing(null, "spawnSync rclone ETIMEDOUT") });
  assert.equal(c.exit, 1);
  assert.match(c.line, /rclone;spawnSync rclone ETIMEDOUT$/);

  const g = purgeWithRunner({ runner: throwing("EACCES", "nope") });
  assert.equal(g.exit, 1);
  assert.equal(g.line, "purge=FAILED(rclone;EACCES)");
});

test("rclone not installed is the word `missing` everywhere, not a raw ENOENT", () => {
  // `rclone;missing` is the exact string docs/TROUBLESHOOTING.md and
  // docs/connectors/google-drive.md tell a user to grep their run log for. An
  // errno leaking out here is a documented string nobody can find.
  const good = payloadFile();
  const files = { [PATHS.payload]: good, [PATHS.lastGood]: good, [PATHS.mirror]: mirrorFile() };
  const gone = () => { throw Object.assign(new Error("spawnSync rclone ENOENT"), { code: "ENOENT" }); };
  const fs = fakeFs(files);

  assert.equal(publish("payload", { runner: gone, ...fs }).token, "drive=FAILED(rclone;missing)");
  assert.equal(publish("mirror", { runner: gone, ...fs }).token, "mirror=FAILED(rclone;missing)");
  assert.equal(purgeWithRunner({ runner: gone }).line, "purge=FAILED(rclone;missing)");
  assert.match(consumeWithRunner("A1", "t", { runner: gone }).line, /rclone;missing$/);
  assert.deepEqual(pullWithRunner("study-commands", { runner: gone, outDir: "x" }), { error: "rclone;missing", docs: [] });
  // status has said `rclone=missing` all along, and still does.
  assert.deepEqual(statusWithRunner({ runner: gone }), { exit: 2, line: "rclone=missing" });
});

// ------------------------------------------------------------------ dedupe

test("dedupe moves every document but the newest into the consumed folder", () => {
  const rows = JSON.stringify([
    { id: "OLD", name: "study-data", modifiedTime: "2026-09-13T10:00:00Z" },
    { id: "NEW", name: "study-data", modifiedTime: "2026-09-15T10:00:00Z" },
    { id: "MID", name: "study-data", modifiedTime: "2026-09-14T10:00:00Z" },
  ]);
  const { runner, calls } = fakeRunner([{ match: /^backend query/, stdout: rows }]);

  const moved = dedupeWithRunner("study-data", { runner, remote: "gd", consumed: CONSUMED });

  assert.equal(moved, 2);
  const moves = calls.filter((c) => c[1] === "moveid");
  assert.deepEqual(moves.map((c) => c[3]), ["OLD", "MID"]);
  assert.equal(moves[0][4], "gd:study-consumed/study-data-OLD.txt");
  // The newest is the one the page reads: it is never touched.
  assert.ok(!moves.some((c) => c[3] === "NEW"));
});

test("publish reports the tidy-up it did, and one live document means no tidy-up at all", () => {
  const text = payloadFile();
  const rows = JSON.stringify([
    { id: "A", name: "study-data", modifiedTime: "2026-09-13T10:00:00Z" },
    { id: "B", name: "study-data", modifiedTime: "2026-09-15T10:00:00Z" },
  ]);
  const dup = fakeRunner([
    { match: /^backend query/, stdout: rows },
    { match: /^cat/, stdout: docsExport(text) },
  ]);
  const r = publish("payload", { runner: dup.runner, ...fakeFs({ [PATHS.payload]: text }) });
  assert.equal(r.exit, 0);
  assert.match(r.token, /^drive=ok\(\d+KB;rclone;verified;deduped=1\)$/);
  // The dedupe happens BEFORE the upload, so the publish lands on the survivor.
  assert.deepEqual(dup.calls.map((c) => c[1] ?? c[0]), ["query", "moveid", "data/payload.b64.txt", "gd:study-data.txt"]);

  const one = fakeRunner([
    { match: /^backend query/, stdout: JSON.stringify([{ id: "B", modifiedTime: "2026-09-15T10:00:00Z" }]) },
    { match: /^cat/, stdout: docsExport(text) },
  ]);
  const clean = publish("payload", { runner: one.runner, ...fakeFs({ [PATHS.payload]: text }) });
  assert.match(clean.token, /^drive=ok\(\d+KB;rclone;verified\)$/);
  assert.equal(one.calls.filter((c) => c[1] === "moveid").length, 0);
});

test("a dedupe that cannot run is never a reason to skip the publish", () => {
  const text = payloadFile();
  const { runner, calls } = fakeRunner([
    { match: /^backend query/, status: 1, stderr: `${NOTICE}\nrateLimitExceeded` },
    { match: /^cat/, stdout: docsExport(text) },
  ]);
  const r = publish("payload", { runner, ...fakeFs({ [PATHS.payload]: text }) });
  assert.equal(r.exit, 0);
  assert.match(r.token, /^drive=ok\(\d+KB;rclone;verified\)$/);
  assert.equal(calls.filter((c) => c[0] === "copyto").length, 1);

  // Unparseable output is the same story.
  const junk = fakeRunner([{ match: /^backend query/, stdout: "<html>signed out</html>" }, { match: /^cat/, stdout: docsExport(text) }]);
  assert.equal(dedupeWithRunner("study-data", { runner: junk.runner, remote: "gd", consumed: CONSUMED }), 0);
  assert.equal(junk.calls.filter((c) => c[1] === "moveid").length, 0);
});

test("a move that fails is not counted as deduped", () => {
  const rows = JSON.stringify([
    { id: "A", modifiedTime: "2026-09-13T10:00:00Z" },
    { id: "B", modifiedTime: "2026-09-14T10:00:00Z" },
    { id: "C", modifiedTime: "2026-09-15T10:00:00Z" },
  ]);
  const { runner } = fakeRunner([
    { match: /^backend query/, stdout: rows },
    { match: /moveid gd: A /, status: 1, stderr: "file not found" },
  ]);
  assert.equal(dedupeWithRunner("study-data", { runner, remote: "gd", consumed: CONSUMED }), 1);
});

// ------------------------------------------------------------------ pull / consume / purge

test("pull lists documents oldest first and copies each by id", () => {
  const rows = JSON.stringify([
    { id: "B2", name: "study-completions", modifiedTime: "2026-09-15T10:00:00Z" },
    { id: "A1", name: "study-completions", modifiedTime: "2026-09-14T10:00:00Z" },
  ]);
  const { runner, calls } = fakeRunner([{ match: /^backend query/, stdout: rows }]);
  const r = pullWithRunner("study-completions", { runner, remote: "gd", outDir: "data/tmp" });

  assert.deepEqual(r.docs.map((d) => d.id), ["A1", "B2"]);
  assert.equal(r.docs[0].path, "data/tmp/study-completions-A1.txt");
  assert.deepEqual(calls[1].slice(0, 3), ["backend", "copyid", "gd:"]);
  assert.ok(calls[1].includes("--drive-export-formats"));
});

test("pull treats the literal null from backend query as zero documents", () => {
  const { runner, calls } = fakeRunner([{ match: /^backend query/, stdout: "null\n" }]);
  const r = pullWithRunner("study-commands", { runner, remote: "gd", outDir: "data/tmp" });
  assert.deepEqual(r.docs, []);
  assert.equal(r.error, undefined);
  assert.equal(calls.filter((c) => c[1] === "copyid").length, 0);
});

test("pull rewrites each exported document without its BOM and CRLF", () => {
  const rows = JSON.stringify([{ id: "A1", name: "study-completions", modifiedTime: "2026-09-14T10:00:00Z" }]);
  const { runner } = fakeRunner([{ match: /^backend query/, stdout: rows }]);
  const envelope = pack("completions", { v: 1, marks: [{ k: "1::hw::x", done: true }] });
  // rclone writes the export; the fake stands in for what lands on disk.
  const files = { "data/tmp/study-completions-A1.txt": `\uFEFF${envelope}\r\n` };

  const r = pullWithRunner("study-completions", {
    runner, remote: "gd", outDir: "data/tmp",
    readFile: (p) => files[p], writeFile: (p, t) => { files[p] = t; },
  });

  assert.deepEqual(r.docs.map((d) => d.id), ["A1"]);
  assert.equal(files["data/tmp/study-completions-A1.txt"], `${envelope}\n`);
});

test("pull surfaces a thrown rclone as an error and never a partial docs list", () => {
  const rows = JSON.stringify([
    { id: "A1", modifiedTime: "2026-09-14T10:00:00Z" },
    { id: "B2", modifiedTime: "2026-09-15T10:00:00Z" },
  ]);
  const runner = (args) => {
    if (args[1] === "query") return { status: 0, stdout: rows, stderr: "" };
    throw Object.assign(new Error("spawnSync rclone ETIMEDOUT"), { code: "ETIMEDOUT" });
  };
  const r = pullWithRunner("study-completions", { runner, remote: "gd", outDir: "data/tmp" });
  assert.equal(r.error, "rclone;ETIMEDOUT");
  assert.deepEqual(r.docs, []);

  const failed = fakeRunner([{ match: /^backend query/, status: 1, stderr: `${NOTICE}\ncouldn't list directory` }]);
  const q = pullWithRunner("study-completions", { runner: failed.runner, remote: "gd", outDir: "data/tmp" });
  assert.equal(q.error, "couldn't list directory");
});

test("consume moves the document into the consumed folder under a unique name", () => {
  const { runner, calls } = fakeRunner();
  const r = consumeWithRunner("A1", "study-completions", { runner, remote: "gd", consumed: CONSUMED });
  assert.equal(r.exit, 0);
  assert.equal(r.line, "consumed A1");
  assert.deepEqual(calls[0], ["backend", "moveid", "gd:", "A1", "gd:study-consumed/study-completions-A1.txt"]);

  const bad = fakeRunner([{ match: /moveid/, status: 1, stderr: `${NOTICE}\nfile not found` }]);
  const f = consumeWithRunner("A1", "study-completions", { runner: bad.runner, remote: "gd", consumed: CONSUMED });
  assert.equal(f.exit, 1);
  assert.match(f.line, /file not found$/);
});

test("purge deletes only what has sat in the consumed folder for a week", () => {
  const { runner, calls } = fakeRunner();
  assert.deepEqual(purgeWithRunner({ runner, remote: "gd", consumed: CONSUMED }), { exit: 0, line: "purge=ok" });
  assert.deepEqual(calls[0], ["delete", "--min-age", "7d", "gd:study-consumed"]);
});

// ------------------------------------------------------------------ the CLI layer

const CLI_PORTS = {
  cfg: { namespace: "study", drive: { rcloneRemote: "gd" } },
  exe: "rclone",
  conf: null,
  dataDir: "data",
  paths: PATHS,
};

function runCli(argv, ports = {}) {
  const out = [];
  const errs = [];
  const code = cliMain(argv, { ...CLI_PORTS, ...ports, log: (s) => out.push(s), err: (s) => errs.push(s) });
  return { code, out, errs };
}

test("the CLI derives its titles and its remote from the config it was given", () => {
  const text = payloadFile();
  const files = { [PATHS.payload]: text };
  const { runner, calls } = fakeRunner([
    { match: /^backend query/, stdout: "null" },
    { match: /^cat/, stdout: docsExport(text) },
  ]);
  const { code, out } = runCli(["publish", "payload"], { runner, fs: fakeFs(files) });

  assert.equal(code, 0);
  assert.match(out[0], /^drive=ok\(/);
  assert.ok(calls.some((c) => c.includes("gd:study-data.txt")));
});

test("--dry-run prints the rclone argv and touches absolutely nothing", () => {
  const explode = () => { throw new Error("a dry run must not run anything"); };
  const { code, out } = runCli(["publish", "payload", "--dry-run"], {
    runner: explode,
    fs: { readFile: explode, writeFile: explode, exists: explode },
    exe: "C:\\tools\\rclone.exe",
    conf: "C:\\conf\\rclone.conf",
  });

  assert.equal(code, 0);
  assert.equal(out.length, 3);
  assert.ok(out.every((l) => l.startsWith("C:\\tools\\rclone.exe --config C:\\conf\\rclone.conf ")));
  assert.match(out[1], /copyto data[\\/]payload\.b64\.txt gd:study-data\.txt/);
  assert.ok(out[1].includes("--drive-import-formats txt --drive-export-formats txt"));
});

test("publishPlan off win32 has no --config in it at all", () => {
  const plan = publishPlan("mirror", { docTitles: TITLES, paths: PATHS, remote: "gd", consumed: CONSUMED, exe: "rclone", conf: null });
  assert.equal(plan.length, 3);
  assert.ok(plan.every((argv) => !argv.includes("--config")));
  assert.deepEqual(plan[1].slice(0, 4), ["rclone", "copyto", "data/backup.b64.txt", "gd:study-mirror.txt"]);
});

test("the CLI passes status, pull, consume and purge straight through with their exit codes", () => {
  const status = runCli(["status"], { runner: fakeRunner([{ match: /lsjson/, status: 0 }]).runner });
  assert.deepEqual([status.code, status.out[0]], [0, "rclone=ok"]);

  const missing = runCli(["status"], { runner: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
  assert.deepEqual([missing.code, missing.out[0]], [2, "rclone=missing"]);

  const rows = JSON.stringify([{ id: "A1", name: "study-commands", modifiedTime: "2026-09-14T10:00:00Z" }]);
  const pull = runCli(["pull", "study-commands", "--out", "scratch"], {
    runner: fakeRunner([{ match: /^backend query/, stdout: rows }]).runner,
    fs: { readFile: () => undefined, writeFile: () => {}, exists: () => false },
  });
  assert.equal(pull.code, 0);
  assert.deepEqual(JSON.parse(pull.out[0]).docs.map((d) => d.path), ["scratch/study-commands-A1.txt"]);

  const consume = runCli(["consume", "A1", "--title", "study-commands"], { runner: fakeRunner().runner });
  assert.deepEqual([consume.code, consume.out[0]], [0, "consumed A1"]);

  const purge = runCli(["purge"], { runner: fakeRunner().runner });
  assert.deepEqual([purge.code, purge.out[0]], [0, "purge=ok"]);
});

test("an unknown command prints the usage line and exits 2 without running rclone", () => {
  const { code, out, errs } = runCli(["nonsense"], { runner: () => { throw new Error("must not run"); } });
  assert.equal(code, 2);
  assert.equal(out.length, 0);
  assert.match(errs[0], /^usage: node src\/drive-rclone\.mjs status \| publish payload\|mirror/);

  const halfway = runCli(["publish", "everything"], { runner: () => { throw new Error("must not run"); } });
  assert.equal(halfway.code, 2);
});

test("the real runner gives the read-back room, so a big cat is never a false failure", () => {
  // Node's spawnSync default is 1 MiB. A `cat` over it comes back as ENOBUFS
  // AFTER a successful upload, which reads as a failed publish and, on the
  // payload path, triggers a last-good restore that was never needed.
  let opts = null;
  const spy = (cmd, args, options) => {
    opts = options;
    return { status: 0, stdout: "ok", stderr: "" };
  };
  const runner = makeRealRunner("rclone", "C:\\c.conf", spy);
  assert.deepEqual(runner(["cat", "gd:study-data.txt"]), { status: 0, stdout: "ok", stderr: "" });

  assert.equal(opts.maxBuffer, RCLONE_MAX_BUFFER);
  assert.ok(RCLONE_MAX_BUFFER >= 16 * 1024 * 1024);
  assert.equal(opts.timeout, RCLONE_TIMEOUT_MS);
  assert.equal(opts.encoding, "utf8");

  // A spawn that fails still throws, so safeRun can turn it into a token.
  const broken = makeRealRunner("rclone", null, () => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }));
  assert.throws(() => broken(["cat", "gd:x.txt"]), { code: "ENOENT" });
});

test("localPaths puts the three files the publisher touches under whichever data dir is in play", () => {
  const p = localPaths("scratch");
  assert.ok(p.payload.endsWith("payload.b64.txt"));
  assert.ok(p.mirror.endsWith("backup.b64.txt"));
  assert.ok(p.lastGood.endsWith("payload.last-good.txt"));
  assert.ok(Object.values(p).every((v) => v.startsWith("scratch")));
});
