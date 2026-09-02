#!/usr/bin/env node
// ===========================================================================
//  reset.mjs - start setup again from a clean sheet
// ===========================================================================
//
//  WHY A SCRIPT AND NOT A LINE OF SHELL
//  ------------------------------------
//  "Delete config.json and empty data/" is two commands on macOS and two
//  different commands on Windows, and the person who needs them is the person
//  least able to translate between the two. It is also the one instruction in
//  this repository where a typo destroys something: `rm -rf data/*` with a
//  wrong path, or run from the wrong folder, is not recoverable.
//
//  So: one command everywhere, a dry run by default, an explicit `--yes` to act,
//  and a hard refusal to touch anything outside this repository.
//
//  WHAT IT WILL NEVER DELETE
//  -------------------------
//  `backups/` - the local mirrors `drive-bundle.mjs --pack` writes. They are the
//  only copy of state that survives a reset, which is exactly what makes a reset
//  safe to run, and a reset that removed them would be a data-loss bug with a
//  reassuring name. Nothing outside the repository root, ever.
//
//  It also does not edit `CLAUDE.md`. Part 2 of that file is prose the setup
//  agent writes, so this script prints what to restore rather than guessing at
//  a format that may have moved on.
//
//  Usage:
//    node scripts/reset.mjs           list what would be removed, remove nothing
//    node scripts/reset.mjs --yes     actually remove it
//    node scripts/reset.mjs --yes --keep-data   only the config, leave state alone
//
//  EXIT CODES
//    0  listed, or removed what it listed
//    1  something could not be removed; the reason is printed
// ===========================================================================

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { argHas, repoRoot } from "../src/lib/paths.mjs";

const ROOT = repoRoot();

/** Files that hold the user's answers, and the pages built from them. */
const CONFIG_TARGETS = ["config.json", "config.json.bak", "agenda.html", "agenda-preview.html", "demo-agenda.html"];

/** Everything in data/ except the marker that keeps the directory in git. */
function dataTargets() {
  const dir = join(ROOT, "data");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name !== ".gitkeep")
    .map((name) => join(dir, name));
}

/** Refuse anything that is not inside this repository, whatever produced it. */
function insideRepo(path) {
  const rel = relative(ROOT, path);
  return rel !== "" && !rel.startsWith("..");
}

function describe(path) {
  try {
    const s = statSync(path);
    return s.isDirectory() ? `${relative(ROOT, path)}${"/"} (directory)` : relative(ROOT, path);
  } catch {
    return relative(ROOT, path);
  }
}

const argv = process.argv.slice(2);
const commit = argHas(argv, "yes");
const keepData = argHas(argv, "keep-data");

const targets = [
  ...CONFIG_TARGETS.map((name) => join(ROOT, name)).filter(existsSync),
  ...(keepData ? [] : dataTargets()),
].filter(insideRepo);

if (targets.length === 0) {
  console.log("reset: nothing to remove - this checkout is already in its fresh state.");
  process.exit(0);
}

console.log("");
console.log(commit ? "  removing:" : "  would remove (nothing has been deleted):");
for (const t of targets) console.log(`    ${describe(t)}`);
console.log("");
console.log("  kept, always: backups/, everything git-tracked, and anything outside this folder.");

if (!commit) {
  console.log("");
  console.log("  Run it for real with:  node scripts/reset.mjs --yes");
  console.log("");
  process.exit(0);
}

let failed = 0;
for (const t of targets) {
  try {
    rmSync(t, { recursive: true, force: true });
  } catch (err) {
    failed += 1;
    console.error(`  could not remove ${describe(t)}: ${err.message}`);
  }
}

console.log("");
if (failed) {
  console.error(`  ${failed} item(s) could not be removed - close anything that has them open and run this again.`);
  process.exit(1);
}
console.log("  Done. Two things are left for you:");
console.log("    1. Restore Part 2 of CLAUDE.md to its [NOT SET] block (git checkout CLAUDE.md does it).");
console.log("    2. Say \"hey\" in Claude Code, and setup starts from the beginning.");
console.log("");
console.log("  If the MCP trust dialog never reappears: claude mcp reset-project-choices");
console.log("");
process.exit(0);
