// node --test test/describe.test.mjs
//
// The gate between the model's prose and data/descriptions.json. The pure
// validator takes its world as arguments; the CLI layer is exercised through an
// injected `io` and one subprocess run against a `mkdtemp` directory. No test
// reads the repository's own data/ or writes anything outside the temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyDescriptions,
  describePaths,
  main,
  mergeDescriptions,
  readGapKeys,
  validateDescriptions,
} from "../src/describe.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "src", "describe.mjs");

const ctx = { allowedKeys: ["1::homework::hw 1", "2::quiz::quiz 2"], existing: { "9::exam::exam 1": "kept" } };

test("accepts gap keys with plain ASCII text", () => {
  const r = validateDescriptions({ "1::homework::hw 1": "Homework 1 on the grading service, due Fri 11:59 pm." }, ctx);
  assert.equal(r.ok, true);
  assert.equal(Object.keys(r.accepted).length, 1);
});

test("rejects a key outside the gap list", () => {
  assert.equal(validateDescriptions({ "3::lab::lab 1": "x" }, ctx).reason, "unknown-key");
});

// The test above rejects at the unknown-key gate, so it never reaches the
// overwrite rule. A stale gaps.json - one written before a description landed -
// lists a key that now HAS text, which is the only way the overwrite gate is
// ever reached. That is the case below.
test("rejects an overwrite when a stale gap key already has a description", () => {
  const stale = { allowedKeys: ["1::homework::hw 1", "2::quiz::quiz 2"], existing: { "2::quiz::quiz 2": "kept" } };
  const r = validateDescriptions({ "2::quiz::quiz 2": "new text" }, stale);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "overwrite");
  assert.deepEqual(r.accepted, {});
});

test("rejects non-ASCII and over 400 chars", () => {
  assert.equal(validateDescriptions({ "1::homework::hw 1": "caf\u00e9" }, ctx).reason, "non-ascii");
  assert.equal(validateDescriptions({ "1::homework::hw 1": "a".repeat(401) }, ctx).reason, "too-long");
  assert.equal(validateDescriptions({ "1::homework::hw 1": "a".repeat(400) }, ctx).ok, true);
});

test("rejects a non-object submission and a non-string value", () => {
  assert.equal(validateDescriptions([], ctx).reason, "not-an-object");
  assert.equal(validateDescriptions({ "1::homework::hw 1": 3 }, ctx).reason, "not-a-string");
  assert.equal(validateDescriptions({ "1::homework::hw 1": "   " }, ctx).reason, "empty-text");
});

test("empty input is ok with zero accepted", () => {
  assert.deepEqual(validateDescriptions({}, ctx).accepted, {});
});

test("readGapKeys and mergeDescriptions never mutate their arguments", () => {
  assert.equal(readGapKeys({ keys: [1] }), null);
  assert.equal(readGapKeys({ at: "now" }), null);
  assert.deepEqual(readGapKeys({ keys: ["a"] }), ["a"]);
  const existing = { a: "1" };
  assert.deepEqual(mergeDescriptions(existing, { b: "2" }), { a: "1", b: "2" });
  assert.deepEqual(existing, { a: "1" });
});

// --- the CLI layer, against an injected disk -------------------------------

/** `files` is a map of path -> parsed JSON; `undefined` models unparseable. */
function fakeIo(files, opts = {}) {
  const written = [];
  return {
    written,
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readJson: (p) => files[p],
    writeJson: (p, obj) => {
      if (opts.failWrite) throw Object.assign(new Error("EACCES: read-only"), { code: "EACCES" });
      written.push([p, obj]);
      files[p] = obj;
    },
  };
}

const paths = { gaps: "GAPS", descriptions: "DESC" };

test("a missing or malformed gap list refuses the whole submission", () => {
  assert.deepEqual(applyDescriptions({ inputPath: "IN", io: fakeIo({}), paths }), {
    line: "descriptions=REJECTED(no-gaps-file)",
    code: 5,
  });
  assert.equal(
    applyDescriptions({ inputPath: "IN", io: fakeIo({ GAPS: { at: "now" } }), paths }).line,
    "descriptions=REJECTED(bad-gaps-file)",
  );
  assert.equal(
    applyDescriptions({ inputPath: undefined, io: fakeIo({ GAPS: { keys: [] } }), paths }).line,
    "descriptions=REJECTED(usage)",
  );
  assert.equal(
    applyDescriptions({ inputPath: "IN", io: fakeIo({ GAPS: { keys: [] } }), paths }).line,
    "descriptions=REJECTED(no-input-file)",
  );
});

test("a clean apply merges onto the existing file and prints the count", () => {
  const io = fakeIo({ GAPS: { keys: ["1::homework::hw 1"] }, IN: { "1::homework::hw 1": "  Due Friday.  " }, DESC: { old: "kept" } });
  const out = applyDescriptions({ inputPath: "IN", io, paths });
  assert.deepEqual(out, { line: "descriptions=+1", code: 0 });
  assert.deepEqual(io.written, [["DESC", { old: "kept", "1::homework::hw 1": "Due Friday." }]]);
});

test("nothing to add writes nothing at all", () => {
  const io = fakeIo({ GAPS: { keys: ["1::homework::hw 1"] }, IN: {} });
  assert.deepEqual(applyDescriptions({ inputPath: "IN", io, paths }), { line: "descriptions=+0", code: 0 });
  assert.deepEqual(io.written, []);
});

test("a write that throws still prints exactly one space-free token", () => {
  const lines = [];
  const io = fakeIo({ GAPS: { keys: ["1::homework::hw 1"] }, IN: { "1::homework::hw 1": "Due Friday." } }, { failWrite: true });
  const code = main(["--apply", "IN"], { io, paths, log: (l) => lines.push(l), warn: () => {} });
  assert.equal(code, 5);
  assert.deepEqual(lines, ["descriptions=REJECTED(write-failed)"]);
  assert.match(lines[0], /^descriptions=REJECTED\([^()\s]+\)$/);
});

test("--apply with no path is a usage rejection, not a crash", () => {
  const lines = [];
  const io = fakeIo({ GAPS: { keys: [] } });
  assert.equal(main(["--apply", "--data", "X"], { io, paths, log: (l) => lines.push(l), warn: () => {} }), 5);
  assert.deepEqual(lines, ["descriptions=REJECTED(usage)"]);
});

test("--data moves both files, and the default sits under the repo's data dir", () => {
  const moved = describePaths(["--data", "SCRATCH"]);
  assert.equal(path.basename(moved.descriptions), "descriptions.json");
  assert.equal(moved.gaps.endsWith(path.join("SCRATCH", "tmp", "gaps.json")), true);
  const fallback = describePaths([]);
  assert.equal(fallback.descriptions, path.join(REPO, "data", "descriptions.json"));
});

// --- the real script, against a scratch directory --------------------------

test("the CLI accepts a gap key once and refuses the overwrite on the second run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agenda-describe-"));
  const data = path.join(dir, "data");
  mkdirSync(path.join(data, "tmp"), { recursive: true });
  const key = "101::project::project brief";
  writeFileSync(path.join(data, "tmp", "gaps.json"), JSON.stringify({ at: "2026-09-15T14:30:00Z", keys: [key], gaps: [] }), "utf8");
  const input = path.join(dir, "descriptions.json");
  writeFileSync(input, JSON.stringify({ [key]: "One page on the LMS, Thursday 11:59 pm." }), "utf8");

  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: REPO });
  const first = run(["--apply", input, "--data", data]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), "descriptions=+1");
  assert.equal(JSON.parse(readFileSync(path.join(data, "descriptions.json"), "utf8"))[key].startsWith("One page"), true);

  const second = run(["--apply", input, "--data", data]);
  assert.equal(second.status, 5);
  assert.equal(second.stdout.trim(), "descriptions=REJECTED(overwrite)");
});
