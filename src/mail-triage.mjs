#!/usr/bin/env node
// mail-triage.mjs - the gate between the model's mail triage and data/.
//
// PURPOSE
//   The daily run's model window reads the mail sweep out of the work order,
//   decides what is a dated deliverable and what is just mail, and hands the
//   result over as ONE JSON file. Nothing it writes reaches data/ directly.
//   This file is the only route, and it refuses the whole payload rather than
//   let a half-shaped or invented entry through: a hallucinated due date, a type
//   nobody renders, a course id that belongs to another course, a second copy of
//   an assignment the scrape already has, a mail card with no gist. One bad
//   field rejects the batch; the model fixes it and retries once.
//
//   The shape, date and course checks live in mail-triage-rules.mjs (pure, and
//   re-exported below so callers still import one module). They are
//   `runbooks/legacy/heavy-run.md` sections 3.2-3.6, and nothing in either file
//   names a school, a course or a person - the course list is `config.courses`.
//
// CLI USAGE
//   node src/mail-triage.mjs --apply <file>      validate, merge, write, print token
//   node src/mail-triage.mjs --validate <file>   same checks and token, writes nothing
//
//   Both forms also accept `--config <path>` and `--data <dir>` (src/lib/paths.mjs),
//   which is what lets the pipeline and a hermetic test point the whole run at a
//   scratch directory.
//
//   <file> is {"items":[Item],"mail":[Mail],"drop":["<id>"]}; missing arrays are
//   empty. Item and Mail are the v2 short-key shapes from docs/PROTOCOL.md.
//
//   Reads  config.json           (courses: code -> id, and which are skipped)
//          data/latest.json      (the scrape's truth, for the duplicate check)
//          data/outlook-items.json and data/outlook-mail.json (the base to merge onto)
//   Writes data/outlook-items.json and data/outlook-mail.json - and only on
//          --apply, and only after every check has passed. Each file is written
//          to a temp file and renamed, so no reader ever sees half a document;
//          the PAIR is written as one unit, and if the second write fails the
//          first is rolled back from a snapshot taken before either was touched.
//          A refusal therefore always means nothing changed on disk.
//
//   stdout: `triage=+Nitem,+Mmail,-Kdropped` on success (N validated items,
//           M validated mail entries, K existing mail entries the drop list
//           actually removed), or `triage=REJECTED(<reason>)` on refusal.
//           Every reason starts with a machine-readable token. It is always
//           exactly one line, with no spaces in the success form, because the
//           model copies it verbatim into data/llm-notes.json and the pipeline
//           copies that into the runlog line.
//
// EXIT CODES  (binary: it either applied cleanly or it refused)
//   0  accepted (and written, under --apply)
//   5  refused - bad arguments, unreadable input, a failed check, or a write
//      that could not be completed. NOTHING is left changed on disk.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { configPath, dataDir as resolveDataDir } from "./lib/paths.mjs";
import {
  MAIL_CAP,
  NO_COURSES,
  courseIndex,
  isDuplicateOfLatest,
  isNonEmptyString,
  isPlainObject,
  mailKey,
  quote,
  recvMs,
  validateItem,
  validateMailEntry,
} from "./mail-triage-rules.mjs";

// One public surface: callers import everything from mail-triage.mjs.
export {
  ITEM_TYPES,
  MAIL_TAGS,
  MAIL_CAP,
  NO_COURSES,
  assignmentNumber,
  checkCourse,
  containsWhole,
  courseIndex,
  isDuplicateOfLatest,
  titlesRelated,
  validateItem,
  validateMailEntry,
} from "./mail-triage-rules.mjs";

export const EXIT = Object.freeze({ ok: 0, rejected: 5 });

function reject(reason) {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// the gate

/**
 * @param input    {items?, mail?, drop?} straight off the model's file
 * @param options  {latestItems} data/latest.json items (the scrape's truth),
 *                 {courses} a courseIndex(), {now} the run's single clock
 * @returns {ok:true, items, mail, drop} | {ok:false, reason}
 */
export function validateTriage(input, options = {}) {
  const latestItems = Array.isArray(options.latestItems) ? options.latestItems : [];
  const courses = options.courses ?? NO_COURSES;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) return reject("now-invalid: the caller passed a clock that is not a date");
  if (!isPlainObject(input)) return reject(`input-not-object: expected {"items":[],"mail":[],"drop":[]}, got ${quote(input)}`);

  for (const field of ["items", "mail", "drop"]) {
    if (field in input && input[field] !== null && !Array.isArray(input[field])) {
      return reject(`${field}-not-array: ${field} must be an array (or absent, which means empty), got ${quote(input[field])}`);
    }
  }
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const rawMail = Array.isArray(input.mail) ? input.mail : [];
  const rawDrop = Array.isArray(input.drop) ? input.drop : [];

  const items = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const result = validateItem(rawItems[i], i, now, courses);
    if (result.reason) return reject(result.reason);
    if (isDuplicateOfLatest(result.item, latestItems)) {
      return reject(`duplicate-of-latest: items[${i}] ${quote(result.item.t)} repeats a data/latest.json item for course ${result.item.cid} due within a day - the scrape already has it, do not duplicate it`);
    }
    items.push(result.item);
  }
  const uniqueItems = mergeItems([], items);
  const emailItems = uniqueItems.filter((item) => item.ty === "email");

  const mail = [];
  for (let i = 0; i < rawMail.length; i += 1) {
    const result = validateMailEntry(rawMail[i], i, emailItems);
    if (result.reason) return reject(result.reason);
    mail.push(result.entry);
  }

  for (let i = 0; i < rawDrop.length; i += 1) {
    if (!isNonEmptyString(rawDrop[i])) {
      return reject(`drop-not-entry-id: drop[${i}] must be a non-empty mail entry id string, got ${quote(rawDrop[i])}`);
    }
  }

  return { ok: true, items: uniqueItems, mail, drop: rawDrop.slice() };
}

// ---------------------------------------------------------------------------
// merging (never mutates either argument)

/** Keyed by `k`; incoming wins, in place, so the page's order stays stable. */
export function mergeItems(existing, incoming) {
  const out = [];
  const slotOf = new Map();
  const pool = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])];
  for (const item of pool) {
    if (!isPlainObject(item)) continue;
    const copy = { ...item };
    if (!isNonEmptyString(item.k)) {
      out.push(copy);
      continue;
    }
    if (slotOf.has(item.k)) out[slotOf.get(item.k)] = copy;
    else {
      slotOf.set(item.k, out.length);
      out.push(copy);
    }
  }
  return out;
}

/** Drop by id, dedupe (id, else addr+subject), newest first, cap 12. */
export function mergeMail(existing, incoming, drop) {
  const dropped = new Set((Array.isArray(drop) ? drop : []).filter(isNonEmptyString));
  const out = [];
  const seen = new Set();
  const pool = [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(existing) ? existing : [])];
  for (const entry of pool) {
    if (!isPlainObject(entry)) continue;
    if (isNonEmptyString(entry.id) && dropped.has(entry.id)) continue;
    const key = mailKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry });
  }
  return out.sort((a, b) => recvMs(b) - recvMs(a)).slice(0, MAIL_CAP);
}

/** How many entries the drop list actually removed - the `-Kdropped` number. */
export function countDropped(existing, drop) {
  const dropped = new Set((Array.isArray(drop) ? drop : []).filter(isNonEmptyString));
  const hit = new Set();
  for (const entry of Array.isArray(existing) ? existing : []) {
    if (isNonEmptyString(entry?.id) && dropped.has(entry.id)) hit.add(entry.id);
  }
  return hit.size;
}

// ---------------------------------------------------------------------------
// thin CLI layer (the only place that touches the filesystem)

const USAGE = "usage: node src/mail-triage.mjs --apply|--validate <file> [--config <path>] [--data <dir>]";

/** Flags that belong to paths.mjs, not to this script; skipped with their value. */
const PATH_FLAGS = new Set(["--config", "--data"]);

export function parseArgs(argv) {
  let mode = null;
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (PATH_FLAGS.has(a)) {
      i += 1;
      continue;
    }
    if ([...PATH_FLAGS].some((flag) => a.startsWith(`${flag}=`))) continue;
    if (a !== "--apply" && a !== "--validate") {
      return { error: `unknown argument ${quote(a)}; ${USAGE}` };
    }
    if (mode) return { error: "pass exactly one of --apply or --validate" };
    mode = a.slice(2);
    file = argv[i + 1] ?? null;
    i += 1;
    if (!isNonEmptyString(file) || file.startsWith("--")) return { error: `${a} needs a path to the triage JSON file` };
  }
  if (!mode) return { error: USAGE };
  return { mode, file };
}

/** The injected runner: four text operations, nothing else. */
export const defaultIo = {
  readText: (file) => fs.readFileSync(file, "utf8"),
  writeText: (file, text) => fs.writeFileSync(file, text, "utf8"),
  renameFile: (from, to) => fs.renameSync(from, to),
  removeFile: (file) => fs.rmSync(file, { force: true }),
};

const JSON_INDENT = 1;

function readJsonFile(io, file) {
  return JSON.parse(io.readText(file));
}

/**
 * One document, written where no reader can see it half-done: temp file first,
 * rename second, and the temp removed if the rename never happens. A rename
 * within a directory is the closest thing a filesystem offers to atomic.
 */
function writeJsonFile(io, file, obj) {
  const tmp = `${file}.tmp`;
  try {
    io.writeText(tmp, `${JSON.stringify(obj, null, JSON_INDENT)}\n`);
    io.renameFile(tmp, file);
  } catch (err) {
    try {
      io.removeFile(tmp);
    } catch {
      /* the temp file is scratch; failing to clear it must not mask the cause */
    }
    throw err;
  }
}

function readDocOrEmpty(io, file, fallback) {
  let doc;
  try {
    doc = readJsonFile(io, file);
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
  return isPlainObject(doc) ? doc : fallback;
}

/** Exact bytes as they stand now, or null when the file does not exist yet. */
function snapshotText(io, file) {
  try {
    return io.readText(file);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function restoreText(io, file, snapshot) {
  try {
    if (snapshot === null) io.removeFile(file);
    else io.writeText(file, snapshot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write outlook-items.json and outlook-mail.json as one unit. Two files cannot
 * be renamed in one step, so the second failure is repaired instead: the items
 * file goes back to the bytes snapshotted before either write, which keeps the
 * promise that a rejection left nothing behind.
 *
 * @returns null on success, or the reason string to reject with
 */
function writePair(io, plan) {
  const { itemsFile, mailFile, itemsDoc, mailDoc } = plan;
  const itemsBefore = snapshotText(io, itemsFile);
  try {
    writeJsonFile(io, itemsFile, itemsDoc);
  } catch (err) {
    return `write-failed: ${itemsFile}: ${err?.message ?? err} - nothing was written`;
  }
  try {
    writeJsonFile(io, mailFile, mailDoc);
  } catch (err) {
    const repaired = restoreText(io, itemsFile, itemsBefore);
    const tail = repaired
      ? `${itemsFile} rolled back, nothing was written`
      : `${itemsFile} COULD NOT BE ROLLED BACK and now holds this run's items while the mail file does not - fix by hand`;
    return `write-failed: ${mailFile}: ${err?.message ?? err} - ${tail}`;
  }
  return null;
}

/** config.courses for this run, or NO_COURSES when there is no readable config. */
function loadCourses(argv, warn) {
  try {
    return courseIndex(loadConfig(configPath(argv), { argv, warn }).courses);
  } catch {
    // A missing or broken config.json is the scrape's problem to report, not a
    // reason to throw away the model's triage: the shape rules still apply and
    // only the code/id cross-check goes quiet.
    return NO_COURSES;
  }
}

/**
 * @param argv  process.argv.slice(2)
 * @param deps  {io, dataDir, courses, now, say, warn}
 */
export function runTriage(argv, deps = {}) {
  const io = deps.io ?? defaultIo;
  const say = deps.say ?? ((line) => console.log(line));
  const warn = deps.warn ?? ((line) => console.error(line));
  const now = deps.now instanceof Date ? deps.now : new Date();

  const args = parseArgs(argv);
  if (args.error) {
    say(`triage=REJECTED(usage: ${args.error})`);
    return EXIT.rejected;
  }

  const dir = deps.dataDir ?? resolveDataDir(argv);
  const courses = deps.courses ?? loadCourses(argv, warn);

  let input;
  try {
    input = readJsonFile(io, args.file);
  } catch (err) {
    say(`triage=REJECTED(input-unreadable: ${args.file}: ${err?.message ?? err})`);
    return EXIT.rejected;
  }

  const itemsFile = path.join(dir, "outlook-items.json");
  const mailFile = path.join(dir, "outlook-mail.json");
  let latest;
  let itemsDoc;
  let mailDoc;
  try {
    latest = readDocOrEmpty(io, path.join(dir, "latest.json"), { items: [] });
    itemsDoc = readDocOrEmpty(io, itemsFile, { items: [] });
    mailDoc = readDocOrEmpty(io, mailFile, { mail: [] });
  } catch (err) {
    say(`triage=REJECTED(data-unreadable: ${err?.message ?? err})`);
    return EXIT.rejected;
  }

  const verdict = validateTriage(input, { latestItems: latest.items ?? [], courses, now });
  if (!verdict.ok) {
    say(`triage=REJECTED(${verdict.reason})`);
    return EXIT.rejected;
  }

  const existingItems = Array.isArray(itemsDoc.items) ? itemsDoc.items : [];
  const existingMail = Array.isArray(mailDoc.mail) ? mailDoc.mail : [];
  const dropped = countDropped(existingMail, verdict.drop);

  if (args.mode === "apply") {
    const stamp = now.toISOString();
    const failure = writePair(io, {
      itemsFile,
      mailFile,
      itemsDoc: {
        ...itemsDoc,
        generatedAt: stamp,
        source: `mail-triage.mjs --apply ${path.basename(args.file)} at ${stamp}`,
        items: mergeItems(existingItems, verdict.items),
      },
      mailDoc: { ...mailDoc, mail: mergeMail(existingMail, verdict.mail, verdict.drop) },
    });
    if (failure) {
      say(`triage=REJECTED(${failure})`);
      return EXIT.rejected;
    }
  }

  say(`triage=+${verdict.items.length}item,+${verdict.mail.length}mail,-${dropped}dropped`);
  return EXIT.ok;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let code = EXIT.rejected;
  try {
    code = runTriage(process.argv.slice(2));
  } catch (err) {
    console.log(`triage=REJECTED(crash: ${err?.message ?? err})`);
  }
  process.exit(code);
}
