#!/usr/bin/env node
// describe.mjs - the gate between the model's prose and data/descriptions.json.
//
// Phase 1 of the daily run hands the model a list of item keys with no
// description yet (`data/tmp/gaps.json`, `{"keys":[...]}`). The model writes one
// to three plain sentences per key into a scratch file and calls this script.
// Nothing it says reaches data/descriptions.json until it passes here, because
// that file is accumulated human-facing value: the page renders it verbatim, an
// overwrite silently destroys an earlier (often better) description, and an
// invented key would put text next to an item that does not exist. So the rule
// is paranoid and ALL-OR-NOTHING: one bad entry rejects the whole submission,
// the file is untouched, and the model gets one reason code to fix and re-apply
// once. Partial application would leave it guessing which half landed.
//
// ---------------------------------------------------------------------------
// WHAT IS ACCEPTED
//
//   key   - must appear in gaps.json `keys[]` (the gap list)
//         - must NOT already exist in data/descriptions.json (no overwrite)
//   text  - a string, non-empty after trimming
//         - printable ASCII only, 0x20-0x7E (the phone and the page read this
//           file; a smart quote from a language model breaks both)
//         - 400 characters max after trimming
//
// Reason codes (single token, no spaces, safe inside the runlog line):
//   not-an-object  bad-key  unknown-key  overwrite  not-a-string
//   empty-text  non-ascii  too-long
//   CLI-only: usage  no-gaps-file  bad-gaps-file  no-input-file  bad-json
//             bad-descriptions-file  write-failed
//
// ---------------------------------------------------------------------------
// CLI
//
//   node src/describe.mjs --apply <file>   <file> is `{ "<itemKey>": "text", ... }`
//
//   `--config <path>` and `--data <dir>` (src/lib/paths.mjs) move both files.
//
//   reads   data/tmp/gaps.json       { "keys": ["<itemKey>", ...] }
//           data/descriptions.json   { "<itemKey>": "text", ... }  (may be absent)
//   writes  data/descriptions.json   { ...existing, ...accepted }, 1-space indent,
//                                    temp file + rename, so a crash cannot truncate it
//   prints  descriptions=+N                    (N entries added)
//           descriptions=REJECTED(<reason>)    (nothing written)
//
// EXIT CODES
//   0  accepted (N may be 0)
//   5  rejected - bad input, bad key, or no gap list to check against
//
// Pure logic is `validateDescriptions`: no file, no mutation of its arguments.
// The filesystem lives in `applyDescriptions`, which takes an injected `io`, and
// in `main`, the only thing that resolves disk paths.

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir } from "./lib/paths.mjs";

export const MAX_TEXT = 400;

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrintableAscii = (s) => /^[\x20-\x7E]*$/.test(s);
const reject = (reason) => ({ ok: false, reason, accepted: {} });

/**
 * Decide whether a batch of model-written descriptions may be stored.
 *
 * @param {object} input        `{ "<itemKey>": "text" }` as the model wrote it
 * @param {object} ctx
 * @param {string[]} ctx.allowedKeys  keys from data/tmp/gaps.json
 * @param {object} ctx.existing       current data/descriptions.json
 * @returns {{ok: boolean, reason?: string, accepted: Record<string,string>}}
 *          `accepted` is a fresh object; on rejection it is empty.
 */
export function validateDescriptions(input, { allowedKeys = [], existing = {} } = {}) {
  if (!isPlainObject(input)) return reject("not-an-object");
  const allowed = new Set(allowedKeys);
  const accepted = {};
  for (const key of Object.keys(input)) {
    if (typeof key !== "string" || key.trim() === "") return reject("bad-key");
    if (!allowed.has(key)) return reject("unknown-key");
    if (Object.prototype.hasOwnProperty.call(existing, key)) return reject("overwrite");
    const raw = input[key];
    if (typeof raw !== "string") return reject("not-a-string");
    const text = raw.trim();
    if (text === "") return reject("empty-text");
    if (!isPrintableAscii(text)) return reject("non-ascii");
    if (text.length > MAX_TEXT) return reject("too-long");
    accepted[key] = text;
  }
  return { ok: true, accepted };
}

/** Pull `keys[]` out of a parsed gaps.json, or null when the shape is wrong. */
export function readGapKeys(parsed) {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.keys)) return null;
  if (!parsed.keys.every((k) => typeof k === "string")) return null;
  return [...parsed.keys];
}

/** Merge accepted text into the existing map without mutating either argument. */
export function mergeDescriptions(existing, accepted) {
  return { ...existing, ...accepted };
}

/**
 * The whole `--apply` flow with the filesystem injected, so it is testable.
 *
 * @param {object} args
 * @param {string|undefined} args.inputPath
 * @param {object} args.io  { exists, readJson(path) -> parsed|undefined, writeJson(path, obj) }
 * @param {object} args.paths { gaps, descriptions }
 * @returns {{line: string, code: number}}
 */
export function applyDescriptions({ inputPath, io, paths }) {
  const fail = (reason) => ({ line: `descriptions=REJECTED(${reason})`, code: 5 });
  if (!inputPath) return fail("usage");
  if (!io.exists(paths.gaps)) return fail("no-gaps-file");

  const gaps = io.readJson(paths.gaps);
  if (gaps === undefined) return fail("bad-gaps-file");
  const allowedKeys = readGapKeys(gaps);
  if (allowedKeys === null) return fail("bad-gaps-file");

  if (!io.exists(inputPath)) return fail("no-input-file");
  const input = io.readJson(inputPath);
  if (input === undefined) return fail("bad-json");

  const existingRaw = io.exists(paths.descriptions) ? io.readJson(paths.descriptions) : {};
  if (existingRaw === undefined || !isPlainObject(existingRaw)) return fail("bad-descriptions-file");

  const result = validateDescriptions(input, { allowedKeys, existing: existingRaw });
  if (!result.ok) return fail(result.reason);

  const added = Object.keys(result.accepted).length;
  if (added > 0) io.writeJson(paths.descriptions, mergeDescriptions(existingRaw, result.accepted));
  return { line: `descriptions=+${added}`, code: 0 };
}

/** Where the two files live for this invocation. Pure: it only joins paths. */
export function describePaths(argv = []) {
  const dir = dataDir(argv);
  return { gaps: join(dir, "tmp", "gaps.json"), descriptions: join(dir, "descriptions.json") };
}

// --------------------------------------------------------------------------
// CLI layer - the only code below this line touches disk or process state.

const nodeIo = {
  exists: (p) => existsSync(p),
  readJson: (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return undefined;
    }
  },
  writeJson: (p, obj) => {
    const tmp = `${p}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(obj, null, 1), "utf8");
      renameSync(tmp, p);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the temp file is scratch; failing to clear it must not mask the cause */
      }
      throw e;
    }
  },
};

export function main(argv, deps = {}) {
  const io = deps.io ?? nodeIo;
  const log = deps.log ?? ((line) => console.log(line));
  const warn = deps.warn ?? ((line) => console.error(line));
  const paths = deps.paths ?? describePaths(argv);
  const i = argv.indexOf("--apply");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  const inputPath = typeof raw === "string" && raw.trim() !== "" && !raw.startsWith("--") ? raw : undefined;
  let out;
  try {
    out = applyDescriptions({ inputPath, io, paths });
  } catch (e) {
    // stdout stays the single runlog token; the cause goes to stderr so a
    // permissions error, a full disk or a locked file leaves a trail to read.
    warn(`describe.mjs: write failed: ${e && e.stack ? e.stack : String(e)}`);
    out = { line: "descriptions=REJECTED(write-failed)", code: 5 };
  }
  log(out.line);
  return out.code;
}

// The same guard as every other CLI here: URLs, not paths - a repo reached
// through a junction spells the two differently, and a path comparison would
// silently skip main() and print nothing at all.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
