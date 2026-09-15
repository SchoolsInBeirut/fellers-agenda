// node --test test/mail-triage.test.mjs
//
// The gate between the model's `data/tmp/triage.json` and data/. Every test here
// is hermetic: the pure functions take their world as arguments, the CLI tests
// drive `runTriage` with an in-memory disk and an injected course list, and the
// one subprocess test runs the real script against a `mkdtemp` directory with
// `--config` and `--data`. Nothing reads the repository's own `data/` or
// `config.json`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT,
  checkCourse,
  courseIndex,
  isDuplicateOfLatest,
  mergeItems,
  mergeMail,
  runTriage,
  validateTriage,
} from "../src/mail-triage.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "src", "mail-triage.mjs");

const now = new Date("2026-09-15T15:00:00Z");

// A fictional term, the same cast the demo fixtures use. Nothing in the module
// under test knows any of these names; they arrive as config.courses.
const COURSES = courseIndex([
  { code: "MATH 210", id: 101, name: "Linear Algebra" },
  { code: "PHYS 172", id: 102, name: "Mechanics" },
  { code: "ART 101", id: 103, name: "Drawing", skip: true },
]);

const latest = [
  { courseId: 101, course: "MATH 210", title: "HW 3", due: "2026-09-19T03:59:00.000Z", type: "homework" },
];

// An item the scrape cannot see: the instructor announced it by mail only.
const mailed = {
  c: "PHYS 172",
  cid: 102,
  t: "Hw 3",
  d: "2026-09-21T03:59:00.000Z",
  ty: "homework",
  s: null,
  src: ["outlook"],
  desc: "Hw 3 on the grading service, due Sun Sep 20 11:59 pm.",
};

const opts = { latestItems: latest, courses: COURSES, now };

test("a valid mail-only item is accepted and gets a normTitle key", () => {
  const r = validateTriage({ items: [mailed] }, opts);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].k, "102::homework::hw 3");
});

test("an item without a parseable UTC due is rejected, nothing else is returned", () => {
  const r = validateTriage({ items: [{ ...mailed, d: "Sunday" }] }, opts);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^due-not-iso-utc:/);
});

test("an item that duplicates a scraped item within a day is rejected", () => {
  const dup = { ...mailed, c: "MATH 210", cid: 101, t: "Homework 3", d: "2026-09-19T20:00:00.000Z" };
  assert.equal(isDuplicateOfLatest(dup, latest), true);
  assert.equal(validateTriage({ items: [dup] }, opts).ok, false);
});

test("mail is capped at 12 newest first, dropped ids removed, duplicates by id collapsed", () => {
  const mk = (i) => ({
    id: `e${i}`,
    from: "X",
    addr: "x@y",
    subj: `s${i}`,
    recv: `2026-09-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
    tag: "info",
    gist: "g",
    ask: null,
    replyBy: null,
  });
  const existing = Array.from({ length: 10 }, (_, i) => mk(i));
  const merged = mergeMail(existing, [mk(9), mk(10), mk(11), mk(12)], ["e0"]);
  assert.equal(merged.length, 12);
  assert.equal(merged[0].id, "e12");
  assert.equal(merged.find((m) => m.id === "e0"), undefined);
  assert.equal(merged.filter((m) => m.id === "e9").length, 1);
});

test("a mail entry missing gist or tag is rejected", () => {
  const r = validateTriage(
    { mail: [{ id: "e1", from: "X", addr: "x@y", subj: "s", recv: "2026-09-15T00:00:00Z" }] },
    opts,
  );
  assert.equal(r.ok, false);
});

test("mergeItems keys by k and lets incoming win", () => {
  const a = { k: "0::task::abstract", t: "Abstract", d: "2026-09-14T03:59:00.000Z" };
  const b = { ...a, d: "2026-09-16T03:59:00.000Z" };
  const out = mergeItems([a], [b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].d, b.d);
});

// --- the course list comes from config.courses, never from this file --------

test("a course code must carry that course's id, and an unknown course must carry 0", () => {
  const swapped = validateTriage({ items: [{ ...mailed, c: "MATH 210" }] }, opts);
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /^cid-mismatch:/);

  const invented = validateTriage({ items: [{ ...mailed, c: "Research", cid: 999 }] }, opts);
  assert.equal(invented.ok, false);
  assert.match(invented.reason, /^cid-unknown:/);

  const borrowed = validateTriage({ items: [{ ...mailed, c: "Research", cid: 101 }] }, opts);
  assert.equal(borrowed.ok, false);
  assert.match(borrowed.reason, /^cid-mismatch:/);

  const research = validateTriage({ items: [{ ...mailed, c: "Research", cid: 0 }] }, opts);
  assert.equal(research.ok, true);
  assert.equal(research.items[0].k, "0::homework::hw 3");
});

test("a course the config marks skip has no items, by code or by id", () => {
  for (const item of [
    { ...mailed, c: "ART 101", cid: 103 },
    { ...mailed, c: "Drawing", cid: 103 },
  ]) {
    const r = validateTriage({ items: [item] }, opts);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^course-skipped:/);
  }
});

test("an agenda with no courses configured still triages: only the cross-check goes quiet", () => {
  const bare = validateTriage({ items: [{ ...mailed, c: "ANY 999", cid: 4242 }] }, { latestItems: [], now });
  assert.equal(bare.ok, true);
  assert.equal(checkCourse({ c: "ANY 999", cid: 4242 }, "items[0]"), null);
  assert.match(checkCourse({ c: "", cid: 0 }, "items[0]"), /^course-missing:/);
  assert.match(checkCourse({ c: "X", cid: "1" }, "items[0]"), /^cid-not-integer:/);
});

// --- the CLI, against an in-memory disk ------------------------------------

function baseName(file) {
  return String(file).split(/[\\/]/).pop();
}

/** In-memory disk of raw text. `failOnWrite: n` makes the nth writeText throw. */
function memoryIo(seed, opts2 = {}) {
  const disk = new Map(Object.entries(seed));
  let writes = 0;
  return {
    disk,
    readText(file) {
      const key = baseName(file);
      if (!disk.has(key)) {
        const err = new Error(`ENOENT: no such file ${key}`);
        err.code = "ENOENT";
        throw err;
      }
      return disk.get(key);
    },
    writeText(file, text) {
      writes += 1;
      if (opts2.failOnWrite === writes) throw new Error("disk full");
      disk.set(baseName(file), text);
    },
    renameFile(from, to) {
      const key = baseName(from);
      if (!disk.has(key)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      disk.set(baseName(to), disk.get(key));
      disk.delete(key);
    },
    removeFile(file) {
      disk.delete(baseName(file));
    },
  };
}

const forbiddenIo = {
  readText() { throw new Error("io touched on a usage error"); },
  writeText() { throw new Error("io touched on a usage error"); },
  renameFile() { throw new Error("io touched on a usage error"); },
  removeFile() { throw new Error("io touched on a usage error"); },
};

const mailOk = {
  id: "e1",
  from: "Jill Rocha",
  addr: "jill@example.edu",
  subj: "Wire transfer",
  recv: "2026-09-14T00:00:00Z",
  tag: "research",
  gist: "Jill is processing the stipend wire.",
  ask: null,
  replyBy: null,
};

function seededDisk(extra = {}) {
  return {
    "triage.json": JSON.stringify({ items: [mailed], mail: [mailOk], drop: ["gone"] }),
    "latest.json": JSON.stringify({ items: latest }),
    "outlook-items.json": `${JSON.stringify({ generatedAt: "old", source: "old", items: [] }, null, 1)}\n`,
    "outlook-mail.json": `${JSON.stringify({ mail: [{ ...mailOk, id: "gone", subj: "resolved" }] }, null, 1)}\n`,
    ...extra,
  };
}

const cliDeps = (io, lines) => ({ io, dataDir: "D", courses: COURSES, now, say: (l) => lines.push(l), warn: () => {} });

test("exit codes are binary: a bad invocation rejects with 5, never 2, and reads nothing", () => {
  const lines = [];
  const deps = cliDeps(forbiddenIo, lines);
  for (const argv of [[], ["--nope", "x"], ["--apply"], ["--apply", "a.json", "--validate", "b.json"]]) {
    assert.equal(runTriage(argv, deps), 5);
  }
  assert.equal(EXIT.rejected, 5);
  assert.equal(EXIT.usage, undefined);
  for (const line of lines) assert.match(line, /^triage=REJECTED\(usage/);
});

test("--config and --data are path flags, not unknown arguments", () => {
  const lines = [];
  const io = memoryIo(seededDisk());
  const code = runTriage(
    ["--config", "/somewhere/config.json", "--apply", "D/triage.json", "--data=D"],
    cliDeps(io, lines),
  );
  assert.equal(code, 0);
  assert.equal(lines[0], "triage=+1item,+1mail,-1dropped");
});

test("HW 30 is not HW 3: title containment is word-bounded", () => {
  const hw30 = { ...mailed, c: "MATH 210", cid: 101, t: "HW 30", d: "2026-09-19T20:00:00.000Z" };
  assert.equal(isDuplicateOfLatest(hw30, latest), false);
  assert.equal(validateTriage({ items: [hw30] }, opts).ok, true);
  const spelled = { ...mailed, c: "MATH 210", cid: 101, t: "Homework 3", d: "2026-09-19T20:00:00.000Z" };
  assert.equal(isDuplicateOfLatest(spelled, latest), true);
  const otherType = { ...spelled, ty: "quiz" };
  assert.equal(isDuplicateOfLatest(otherType, latest), false);
});

test("a failed mail write rolls the items file back, so a rejection wrote nothing", () => {
  const seed = seededDisk();
  const io = memoryIo(seed, { failOnWrite: 2 });
  const lines = [];
  const code = runTriage(["--apply", "D/triage.json"], cliDeps(io, lines));
  assert.equal(code, 5);
  assert.match(lines[0], /^triage=REJECTED\(write-failed/);
  assert.match(lines[0], /rolled back/);
  assert.equal(io.disk.get("outlook-items.json"), seed["outlook-items.json"]);
  assert.equal(io.disk.get("outlook-mail.json"), seed["outlook-mail.json"]);
  assert.equal(io.disk.has("outlook-mail.json.tmp"), false);
});

test("a clean --apply writes both files and reports the dropped entry", () => {
  const seed = seededDisk();
  const io = memoryIo(seed);
  const lines = [];
  const code = runTriage(["--apply", "D/triage.json"], cliDeps(io, lines));
  assert.equal(code, 0);
  assert.equal(lines[0], "triage=+1item,+1mail,-1dropped");
  const items = JSON.parse(io.disk.get("outlook-items.json"));
  const mail = JSON.parse(io.disk.get("outlook-mail.json"));
  assert.equal(items.items[0].k, "102::homework::hw 3");
  assert.equal(items.generatedAt, now.toISOString());
  assert.deepEqual(mail.mail.map((m) => m.id), ["e1"]);
  assert.ok(io.disk.get("outlook-items.json").endsWith("}\n"));
  // Temp files are renamed away, never left behind.
  assert.deepEqual([...io.disk.keys()].filter((k) => k.endsWith(".tmp")), []);
});

test("a --validate run reads the same files and writes none of them", () => {
  const seed = seededDisk();
  const io = memoryIo(seed);
  const lines = [];
  assert.equal(runTriage(["--validate", "D/triage.json"], cliDeps(io, lines)), 0);
  assert.equal(lines[0], "triage=+1item,+1mail,-1dropped");
  assert.equal(io.disk.get("outlook-items.json"), seed["outlook-items.json"]);
  assert.equal(io.disk.get("outlook-mail.json"), seed["outlook-mail.json"]);
});

test("a gist with a smart quote is rejected: outlook-*.json is ASCII only", () => {
  const r = validateTriage({ mail: [{ ...mailOk, gist: "She said \u201cgo ahead\u201d." }] }, opts);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^non-ascii: mail\[0\]\.gist/);
});

test("a due date more than two years out is rejected as a year slip", () => {
  const slipped = validateTriage({ items: [{ ...mailed, d: "2029-09-21T03:59:00.000Z" }] }, opts);
  assert.equal(slipped.ok, false);
  assert.match(slipped.reason, /^due-out-of-window:/);
  const nextYear = validateTriage({ items: [{ ...mailed, d: "2027-09-21T03:59:00.000Z" }] }, opts);
  assert.equal(nextYear.ok, true);
});

test("a replyBy with no matching ty:email item is replyBy-without-item", () => {
  const replyBy = "2026-09-18T20:00:00.000Z";
  const orphan = validateTriage({ mail: [{ ...mailOk, replyBy }] }, opts);
  assert.equal(orphan.ok, false);
  assert.match(orphan.reason, /^replyBy-without-item:/);
  const paired = validateTriage(
    {
      items: [
        {
          c: "Research",
          cid: 0,
          t: "Reply to Jill on the wire transfer",
          d: replyBy,
          ty: "email",
          s: null,
          desc: "Answer Jill with the receipt totals.",
        },
      ],
      mail: [{ ...mailOk, replyBy }],
    },
    opts,
  );
  assert.equal(paired.ok, true);
});

test("mergeMail collapses Re: onto the same thread when ids are absent", () => {
  const thread = { from: "Jill Rocha", addr: "jill@example.edu", tag: "research", gist: "g", ask: null, replyBy: null };
  const older = { ...thread, subj: "Wire transfer", recv: "2026-09-10T00:00:00Z" };
  const newer = { ...thread, subj: "Re: Wire transfer", recv: "2026-09-14T00:00:00Z" };
  const merged = mergeMail([older], [newer], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].subj, "Re: Wire transfer");
});

// --- the real script, against a scratch directory --------------------------

test("the CLI reads config.courses and data/ from --config and --data", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agenda-triage-"));
  const data = path.join(dir, "data");
  mkdirSync(path.join(data, "tmp"), { recursive: true });
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ courses: [{ code: "MATH 210", id: 101, name: "Linear Algebra" }] }), "utf8");
  writeFileSync(path.join(data, "latest.json"), JSON.stringify({ items: [] }), "utf8");
  const triage = path.join(data, "tmp", "triage.json");
  const item = { c: "MATH 210", cid: 101, t: "Project brief", d: "2026-09-25T03:59:00.000Z", ty: "project", s: null, src: ["outlook"], desc: "One page, on the LMS, Thursday 11:59 pm." };
  writeFileSync(triage, JSON.stringify({ items: [item], mail: [], drop: [] }), "utf8");

  const run = spawnSync(process.execPath, [SCRIPT, "--apply", triage, "--config", config, "--data", data], {
    encoding: "utf8",
    cwd: REPO,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split("\n").pop(), "triage=+1item,+0mail,-0dropped");
  const written = JSON.parse(readFileSync(path.join(data, "outlook-items.json"), "utf8"));
  assert.equal(written.items[0].k, "101::project::project brief");

  // The same item under the wrong id is refused, and nothing is rewritten.
  writeFileSync(triage, JSON.stringify({ items: [{ ...item, cid: 999 }] }), "utf8");
  const bad = spawnSync(process.execPath, [SCRIPT, "--apply", triage, "--config", config, "--data", data], {
    encoding: "utf8",
    cwd: REPO,
  });
  assert.equal(bad.status, 5);
  assert.match(bad.stdout.trim().split("\n").pop(), /^triage=REJECTED\(cid-mismatch:/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(data, "outlook-items.json"), "utf8")).items, written.items);
});
