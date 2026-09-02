// node --test  (run from the repository root)
//
// The mirror has three jobs and all of them are about trust: pack the files that
// matter and NONE of the ones that do not, give them back byte for byte, and leave
// a local copy behind whether or not anything downstream worked. So most of these
// tests are about the boundary - what is excluded, what a hostile envelope may not
// do, what happens when the bundle is too big to push, and what survives a failure.
//
// Every test runs inside a temp root (`--root <dir>`): nothing here ever reads or
// writes the repository's own data/, and nothing here depends on a config.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cliMain,
  collect,
  human,
  isMirrored,
  mirrorPaths,
  pack,
  restore,
  resolveRel,
  safeRelPath,
  stamp,
  unwrap,
  wrap,
  BACKUP_NAME,
  BAK_SUFFIX,
  BUNDLE_VERSION,
  EXIT,
  MARK_HEAD,
  MARK_TAIL,
  DEFAULT_MIRROR_CHARS,
  BACKUP_DIR,
  BACKUP_KEEP,
  FIXTURES_DIR,
  ROOT_FILES,
  backupName,
  writeLocalBackup,
} from "../src/drive-bundle.mjs";
import { pack as packEnvelope } from "../src/lib/envelope.mjs";

const NOW = new Date("2026-09-01T13:15:00");

/**
 * Text that gzip cannot help with, so a size test is about size rather than about
 * how compressible the letter "x" is. Deterministic, so the test never flickers.
 */
function incompressible(n) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = 0x9e3779b9;
  const next = () => {
    s ^= s << 13;
    s |= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    return s >>> 0;
  };
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = alphabet[next() % alphabet.length];
  return out.join("");
}

const CONFIG = { difficulty: { "MATH 210": 4 }, wakeTime: "10:00" };
const LATEST = { scrapedAt: "2026-09-01T11:03:00.000Z", items: [{ k: "1::hw::x" }] };

/**
 * A throwaway repo: config.json at the root, a data/ dir holding one of everything
 * the include list has an opinion about, plus a subdirectory.
 */
function sandbox(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-bundle-"));
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(CONFIG, null, 2));
  fs.writeFileSync(path.join(data, "latest.json"), JSON.stringify(LATEST, null, 2));
  fs.writeFileSync(path.join(data, "block-edits.json"), JSON.stringify({ v: 1, edits: [], history: [] }));
  fs.writeFileSync(path.join(data, "study-log.json"), JSON.stringify({ entries: [] }));
  fs.writeFileSync(path.join(data, "focus-note.txt"), "2026-09-01: iClicker on before 4:30\n");
  // Everything below is deliberately NOT state:
  fs.writeFileSync(path.join(data, "content-dump.json"), JSON.stringify({ big: "x".repeat(200) }));
  fs.writeFileSync(path.join(data, "sample-payload-v3.json"), JSON.stringify({ fixture: true }));
  fs.writeFileSync(path.join(data, "runlog.txt"), "2026-09-01T07:03:00 items=80\n");
  fs.writeFileSync(path.join(data, "runlog-stdout.txt"), "noise\n");
  fs.writeFileSync(path.join(data, "payload.b64.txt"), "PAY1.zzzz.END");
  fs.mkdirSync(path.join(data, "phys221-docs"));
  fs.writeFileSync(path.join(data, "phys221-docs", "notes.json"), JSON.stringify({ nested: true }));
  for (const [rel, value] of Object.entries(extra)) {
    const target = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  }
  return root;
}

function withSandbox(fn, extra = {}) {
  const root = sandbox(extra);
  try {
    return fn(root, path.join(root, "data"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function capture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const code = fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const restoreDirOf = (data) => fs.readdirSync(data).find((n) => n.startsWith("restore-"));

// ------------------------------------------------------------- the include list

test("the include list is a list: state in, renderings and artefacts out", () => {
  for (const name of ["latest.json", "overrides.json", "block-edits.json", "focus-note.txt"]) {
    assert.ok(isMirrored(name), `${name} should be mirrored`);
  }
  for (const name of [
    "content-dump.json",
    "sample-payload-v2.json",
    "sample-payload-v3.json",
    "runlog.txt",
    "runlog-stdout.txt",
    "payload.b64.txt",
    BACKUP_NAME,
    "notes.md",
    "agenda.html",
    "",
  ]) {
    assert.equal(isMirrored(name), false, `${name} should NOT be mirrored`);
  }
});

test("mirrorPaths lists config.json first, then data/ alphabetically, and skips dirs", () => {
  withSandbox((root, data) => {
    assert.deepEqual(mirrorPaths(root, data), [
      "config.json",
      "data/block-edits.json",
      "data/focus-note.txt",
      "data/latest.json",
      "data/study-log.json",
    ]);
  });
});

test("a missing config.json and a missing data/ are normal, not errors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-bundle-empty-"));
  try {
    assert.deepEqual(mirrorPaths(root, path.join(root, "data")), []);
    const { code, line } = pack({ root, dataDir: path.join(root, "data"), out: path.join(root, "out.txt"), now: NOW });
    assert.equal(code, EXIT.ok);
    assert.match(line, /files=0 bytes=0/);
    assert.deepEqual(unwrap(read(root, "out.txt")).bundle.files, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRel sends data/ to the data dir and everything else to the root", () => {
  assert.equal(resolveRel("config.json", "/r", "/d"), path.join("/r", "config.json"));
  assert.equal(resolveRel("data/latest.json", "/r", "/d"), path.join("/d", "latest.json"));
});

// ------------------------------------------------------------------ the envelope

test("the envelope round-trips exactly, whatever a Google Doc does to the whitespace", () => {
  const bundle = { v: BUNDLE_VERSION, packedAt: NOW.toISOString(), files: { "config.json": '{"a":1}\n' } };
  const envelope = wrap(bundle);
  assert.ok(envelope.startsWith(MARK_HEAD) && envelope.endsWith(MARK_TAIL));
  assert.deepEqual(unwrap(envelope).bundle, bundle);
  assert.deepEqual(unwrap(`\n\n  ${envelope}  \n`).bundle, bundle);
  assert.deepEqual(unwrap(JSON.stringify(bundle)).bundle, bundle, "a hand-decoded bundle is still readable");
});

test("unwrap never throws and names what is wrong", () => {
  assert.match(unwrap("").error, /empty/);
  assert.match(unwrap("AGM2.deadbeef.zzz").error, /\.END/);
  assert.match(unwrap("hello").error, /\.END/);
  assert.match(unwrap(JSON.stringify({ v: 2, files: {} })).error, /unsupported bundle version 2/);
  assert.match(unwrap(JSON.stringify({ v: 1 })).error, /no `files` map/);
  assert.match(unwrap(wrap([1, 2])).error, /not an object/);
  assert.match(unwrap("{nope").error, /not JSON/);
});

test("a corrupted or truncated mirror is refused, never half-decoded", () => {
  const envelope = wrap({ v: 1, packedAt: NOW.toISOString(), files: { "config.json": "{}" } });
  assert.ok(envelope.startsWith("AGM2."), "the mirror is compressed and checksummed");

  // One flipped base64 character inside the body. The checksum is the whole point:
  // a truncated gzip stream can start decompressing and fail somewhere deep inside.
  const at = envelope.length - 12;
  const flipped = envelope.slice(0, at) + (envelope[at] === "A" ? "B" : "A") + envelope.slice(at + 1);
  assert.ok(unwrap(flipped).error, "a single wrong character is not a mirror");

  assert.ok(unwrap(envelope.slice(0, envelope.length - 40)).error, "a truncated transcription is refused");
});

test("an envelope of another kind is refused by name, not parsed hopefully", () => {
  const payload = packEnvelope("data", { v: 4, items: [] });
  assert.match(unwrap(payload).error, /"data" envelope, not a state mirror/);
});

test("the bundled fixtures are never mirrored - they ship in the repository", () => {
  assert.equal(ROOT_FILES.some((f) => f.startsWith(`${FIXTURES_DIR}/`)), false);
  withSandbox((root, data) => {
    fs.mkdirSync(path.join(root, FIXTURES_DIR, "demo"), { recursive: true });
    fs.writeFileSync(path.join(root, FIXTURES_DIR, "demo", "config.demo.json"), "{}");
    assert.equal(
      mirrorPaths(root, data).some((rel) => rel.startsWith(FIXTURES_DIR)),
      false,
      "backing a fixture up to the place it came from is not insurance",
    );
  });
});

test("safeRelPath refuses every way out of the tree", () => {
  assert.equal(safeRelPath("data/latest.json"), "data/latest.json");
  assert.equal(safeRelPath("config.json"), "config.json");
  // These absolute and traversing paths are the ATTACK, not configuration: the
  // envelope arrives from a document anyone with the link could have edited, so
  // every one of them has to resolve to null before a single byte is written.
  for (const evil of ["../etc/passwd", "data/../../x", "/etc/passwd", "C:/Windows/x", "data\\latest.json", "", "data//x", null]) {
    assert.equal(safeRelPath(evil), null, `${evil} must not resolve`);
  }
});

test("human sizes read the way a log line wants them", () => {
  assert.equal(human(512), "512 B");
  assert.equal(human(2048), "2 KB");
  assert.equal(human(6 * 1024 * 1024), "6.0 MB");
  assert.match(stamp(NOW), /^20260901-131500$/);
});

// ------------------------------------------------------------------------ pack

test("--pack writes the envelope and includes exactly the mirrored files", () => {
  withSandbox((root, data) => {
    const { code, out } = capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
    assert.equal(code, EXIT.ok);
    assert.match(out, /pack ok files=5 bytes=\d+ encoded=\d+ out=/);

    const { bundle, error } = unwrap(read(data, BACKUP_NAME));
    assert.equal(error, undefined);
    assert.equal(bundle.v, 1);
    assert.equal(bundle.packedAt, NOW.toISOString());
    assert.deepEqual(Object.keys(bundle.files).sort(), [
      "config.json",
      "data/block-edits.json",
      "data/focus-note.txt",
      "data/latest.json",
      "data/study-log.json",
    ]);
    assert.equal(bundle.files["config.json"], read(root, "config.json"), "byte for byte");
    assert.equal(bundle.files["data/focus-note.txt"], "2026-09-01: iClicker on before 4:30\n");
    for (const gone of ["data/content-dump.json", "data/sample-payload-v3.json", "data/runlog.txt", "data/payload.b64.txt", "data/phys221-docs/notes.json"]) {
      assert.equal(gone in bundle.files, false, `${gone} must not be in the mirror`);
    }
  });
});

test("--pack never mirrors its own output, run after run", () => {
  withSandbox((root, data) => {
    capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
    const first = read(data, BACKUP_NAME).length;
    capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
    assert.equal(read(data, BACKUP_NAME).length, first, "a second pack is the same size, not double");
    assert.equal(BACKUP_NAME in unwrap(read(data, BACKUP_NAME)).bundle.files, false);
  });
});

test("--out puts the envelope somewhere else and leaves data/ alone", () => {
  withSandbox((root, data) => {
    const out = path.join(root, "elsewhere", "mirror.txt");
    const { code } = capture(() => cliMain(["--pack", "--root", root, "--out", out], { now: NOW }));
    assert.equal(code, EXIT.ok);
    assert.ok(fs.existsSync(out));
    assert.equal(fs.existsSync(path.join(data, BACKUP_NAME)), false);
  });
});

test("a bundle over the mirror cap exits 3, names the biggest files, and writes no Drive copy", () => {
  withSandbox(
    (root, data) => {
      const { code, out } = capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
      assert.equal(code, EXIT.tooBig);
      assert.match(out, /pack TOO BIG/);
      assert.match(out, new RegExp(`over the ${DEFAULT_MIRROR_CHARS}-char mirror cap`));
      assert.match(out, /biggest: data\/huge\.json /);
      assert.equal(fs.existsSync(path.join(data, BACKUP_NAME)), false, "no Drive copy when the cap is hit");
    },
    { "data/huge.json": JSON.stringify({ blob: incompressible(120000) }) },
  );
});

test("collect reports the sizes the cap message ranks by", () => {
  withSandbox((root, data) => {
    const { files, bytes, sizes } = collect(root, data);
    assert.equal(Object.keys(files).length, 5);
    assert.equal(bytes, sizes.reduce((a, s) => a + s.size, 0));
    assert.deepEqual(sizes.map((s) => s.size).sort((a, b) => b - a), sizes.map((s) => s.size));
    assert.ok(DEFAULT_MIRROR_CHARS > wrap({ v: 1, packedAt: NOW.toISOString(), files }).length);
  });
});

// ------------------------------------------------------------- the local backup
//
// Insurance that depends on an upload is not insurance: the upload is the step
// most likely to be the thing that failed. So the local copy is written first,
// unconditionally, and these three tests are about exactly that word.

test("--pack writes a local backup even when the Drive copy is refused by the cap", () => {
  withSandbox(
    (root, data) => {
      const { code } = capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
      assert.equal(code, EXIT.tooBig);
      assert.equal(fs.existsSync(path.join(data, BACKUP_NAME)), false, "no Drive copy");

      const backups = fs.readdirSync(path.join(root, BACKUP_DIR));
      assert.equal(backups.length, 1, "and yet the backup is there");
      assert.match(backups[0], /^mirror-.*\.txt$/);
      const { bundle } = unwrap(read(root, BACKUP_DIR, backups[0]));
      assert.ok(bundle.files["config.json"], "a complete bundle, not a stub");
    },
    { "data/huge.json": JSON.stringify({ blob: incompressible(120000) }) },
  );
});

test("--pack writes the local backup before the Drive copy, not after it", () => {
  withSandbox((root, data) => {
    // A file where the out path's PARENT should be: the write to data/ cannot
    // succeed, and the backup must already exist by the time it fails.
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const { code, out } = capture(() =>
      cliMain(["--pack", "--root", root, "--out", path.join(blocked, "mirror.txt")], { now: NOW }),
    );
    assert.equal(code, EXIT.error);
    assert.match(out, /pack FAILED/);
    assert.match(out, /backup=mirror-/, "the log says the backup survived the failure");
    assert.equal(fs.readdirSync(path.join(root, BACKUP_DIR)).length, 1);
    assert.equal(fs.existsSync(path.join(data, BACKUP_NAME)), false);
  });
});

test("the backup folder keeps exactly the newest 14", () => {
  withSandbox((root) => {
    const dir = path.join(root, BACKUP_DIR);
    // 20 packs, one per hour, so the filenames sort chronologically.
    for (let i = 0; i < 20; i++) {
      const at = new Date(NOW.getTime() + i * 3600000);
      writeLocalBackup(dir, `AGM2.00000000.x${i}.END`, at);
    }
    const kept = fs.readdirSync(dir).sort();
    assert.equal(kept.length, BACKUP_KEEP);
    assert.equal(BACKUP_KEEP, 14);
    assert.equal(kept[0], backupName(new Date(NOW.getTime() + 6 * 3600000)), "the oldest six are gone");
    assert.equal(kept.at(-1), backupName(new Date(NOW.getTime() + 19 * 3600000)), "the newest is still there");
  });
});

test("backupName is filename-safe on every platform", () => {
  const name = backupName(new Date("2026-09-01T13:15:00.000Z"));
  assert.equal(name, "mirror-2026-09-01T13-15-00.txt");
  assert.equal(/[:*?"<>|]/.test(name), false, "no character Windows refuses");
});

test("a backup folder that cannot be written is reported, never fatal", () => {
  withSandbox((root, data) => {
    const blocked = path.join(root, "blocked-backups");
    fs.writeFileSync(blocked, "not a directory");
    const { code, line } = pack({
      root,
      dataDir: data,
      out: path.join(data, BACKUP_NAME),
      now: NOW,
      backupDir: blocked,
    });
    assert.equal(code, EXIT.ok, "the Drive copy still happens");
    assert.match(line, /backup=FAILED\(/);
    assert.ok(fs.existsSync(path.join(data, BACKUP_NAME)));
  });
});

// --------------------------------------------------------------------- restore

test("--restore unpacks into a fresh data/restore-<stamp>/ and touches nothing live", () => {
  withSandbox((root, data) => {
    capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
    const before = read(root, "config.json");
    fs.writeFileSync(path.join(root, "config.json"), '{"tampered":true}');

    const { code, out } = capture(() => cliMain(["--restore", path.join(data, BACKUP_NAME), "--root", root], { now: NOW }));
    assert.equal(code, EXIT.ok);
    assert.match(out, /restore ok files=5 bytes=\d+ dir=.*restore-20260901-131500 forced=0/);
    assert.match(out, /packedAt=2026-09-01T/);

    const dir = path.join(data, "restore-20260901-131500");
    assert.equal(read(dir, "config.json"), before, "the mirror's copy is the one that came back");
    assert.equal(read(dir, "data", "latest.json"), JSON.stringify(LATEST, null, 2), "relative paths are preserved");
    assert.equal(read(root, "config.json"), '{"tampered":true}', "the live file is NOT overwritten without --force");
    assert.equal(fs.existsSync(path.join(root, "config.json" + BAK_SUFFIX)), false);
  });
});

test("--force overwrites the live files, but writes a .pre-restore.bak of each first", () => {
  withSandbox((root, data) => {
    capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
    const original = read(root, "config.json");
    fs.writeFileSync(path.join(root, "config.json"), '{"tampered":true}');
    fs.writeFileSync(path.join(data, "latest.json"), '{"tampered":true}');

    const { code, out } = capture(() =>
      cliMain(["--restore", path.join(data, BACKUP_NAME), "--root", root, "--force"], { now: NOW }),
    );
    assert.equal(code, EXIT.ok);
    assert.match(out, /forced=5/);
    assert.match(out, /\.pre-restore\.bak kept/);

    assert.equal(read(root, "config.json"), original, "the live file is back");
    assert.equal(read(root, "config.json" + BAK_SUFFIX), '{"tampered":true}', "and what it replaced is still there");
    assert.equal(read(data, "latest.json"), JSON.stringify(LATEST, null, 2));
    assert.equal(read(data, "latest.json" + BAK_SUFFIX), '{"tampered":true}');
    assert.ok(restoreDirOf(data), "--force still leaves the safe copy as well");
  });
});

test("--force onto a file that does not exist writes it without inventing a .bak", () => {
  withSandbox((root, data) => {
    capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
    fs.rmSync(path.join(data, "study-log.json"));
    const { code } = capture(() =>
      cliMain(["--restore", path.join(data, BACKUP_NAME), "--root", root, "--force"], { now: NOW }),
    );
    assert.equal(code, EXIT.ok);
    assert.equal(read(data, "study-log.json"), JSON.stringify({ entries: [] }));
    assert.equal(fs.existsSync(path.join(data, "study-log.json" + BAK_SUFFIX)), false);
  });
});

test("a restore refuses a bundle that tries to escape the tree, before writing anything", () => {
  withSandbox((root, data) => {
    const evil = path.join(root, "evil.txt");
    fs.writeFileSync(evil, wrap({ v: 1, packedAt: NOW.toISOString(), files: { "../../owned.json": "{}" } }));
    const { code, out } = capture(() => cliMain(["--restore", evil, "--root", root], { now: NOW }));
    assert.equal(code, EXIT.error);
    assert.match(out, /refusing the path "\.\.\/\.\.\/owned\.json"/);
    assert.equal(restoreDirOf(data), undefined, "not one byte was unpacked");
  });
});

test("a broken or missing envelope is exit 1 with a reason, never a half restore", () => {
  withSandbox((root, data) => {
    const broken = path.join(root, "broken.txt");
    fs.writeFileSync(broken, "BAK1.###.END");
    assert.equal(capture(() => cliMain(["--restore", broken, "--root", root], { now: NOW })).code, EXIT.error);

    const missing = capture(() => cliMain(["--restore", path.join(root, "nope.txt"), "--root", root], { now: NOW }));
    assert.equal(missing.code, EXIT.error);
    assert.match(missing.out, /cannot read/);

    const nonText = path.join(root, "nontext.txt");
    fs.writeFileSync(nonText, wrap({ v: 1, packedAt: NOW.toISOString(), files: { "config.json": 42 } }));
    assert.match(capture(() => cliMain(["--restore", nonText, "--root", root], { now: NOW })).out, /is not text/);
  });
});

test("pack -> restore is a true round trip for every mirrored byte", () => {
  withSandbox((root, data) => {
    capture(() => cliMain(["--pack", "--root", root], { now: NOW }));
    const before = Object.fromEntries(
      mirrorPaths(root, data).map((rel) => [rel, read(resolveRel(rel, root, data))]),
    );
    capture(() => cliMain(["--restore", path.join(data, BACKUP_NAME), "--root", root], { now: NOW }));
    const dir = path.join(data, restoreDirOf(data));
    for (const [rel, content] of Object.entries(before)) {
      assert.equal(read(path.join(dir, ...rel.split("/"))), content, rel);
    }
  });
});

// ------------------------------------------------------------------------- CLI

test("the CLI insists on exactly one mode", () => {
  withSandbox((root) => {
    for (const argv of [[], ["--force"], ["--pack", "--restore", "x"], ["--restore"], ["--restore", "--force"]]) {
      const { code, out } = capture(() => cliMain([...argv, "--root", root], { now: NOW }));
      assert.equal(code, EXIT.usage, argv.join(" "));
      assert.match(out, /usage: node src\/drive-bundle\.mjs/);
    }
  });
});

test("--data alone redirects only the data half", () => {
  withSandbox((root, data) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-bundle-data-"));
    try {
      fs.writeFileSync(path.join(elsewhere, "overrides.json"), '{"a":1}');
      const { code, out } = capture(() => cliMain(["--pack", "--root", root, "--data", elsewhere], { now: NOW }));
      assert.equal(code, EXIT.ok);
      assert.match(out, /files=2 /, "config.json from --root, one json from --data");
      const files = unwrap(read(elsewhere, BACKUP_NAME)).bundle.files;
      assert.deepEqual(Object.keys(files).sort(), ["config.json", "data/overrides.json"]);
      assert.equal(fs.existsSync(path.join(data, BACKUP_NAME)), false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
