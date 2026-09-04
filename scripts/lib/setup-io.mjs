// ===========================================================================
//  setup-io.mjs - the wizard's seam onto the terminal and onto other processes
// ===========================================================================
//
//  `scripts/setup.mjs` says it orchestrates rather than reimplements, and this
//  is the half of that promise a test can hold it to. Everything here writes to
//  a stream, starts a child process, or ends the run - the three things that
//  make a script impossible to exercise without a terminal - and every one of
//  them takes its stream, its child-process runner or its exit function as an
//  argument with the real one as the default.
//
//  Nothing here decides anything. The step counter is the only state, it lives
//  inside one closure rather than at module scope, and a second printer starts
//  again at [1] - which is what makes the numbering a property of one run
//  rather than of the process.
// ===========================================================================

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `say` / `step` / `did`, with the numbered-step counter closed over. */
export function makePrinter(out = console.log) {
  let n = 0;
  const say = (...lines) => out(lines.join("\n"));
  return Object.freeze({
    say,
    step: (title) => say("", `  [${(n += 1)}] ${title}`, "  " + "-".repeat(Math.max(20, title.length + 4))),
    did: (what) => say(`      ${what}`),
  });
}

/**
 * `run(file, args)` and `node(script, args)`, both rooted at one checkout.
 *
 * A child's failure is a status, never an exception: the wizard's whole job is
 * to say what went wrong in a sentence, and a `spawnSync` that throws ENOENT
 * deep inside a step would print a stack trace instead.
 */
export function makeRunner(repo, spawn = spawnSync) {
  const run = (file, args, { capture = false } = {}) => {
    const r = spawn(file, args, {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (r.error) return { status: 1, stdout: "", stderr: String(r.error.message) };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return Object.freeze({
    run,
    node: (script, args = [], opts) => run(process.execPath, [join(repo, script), ...args], opts),
  });
}

/** Is `bin` on PATH? Its version line, or null. Never throws. */
export function probe(bin, args = ["--version"], spawn = spawnSync) {
  const r = spawn(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? "").trim().split(/\r?\n/)[0] || "(no version output)";
}

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * Stop, saying why and how to resume.
 *
 * `code` is 1 for "a step this script owns failed" and 2 for "a prerequisite
 * blocks everything", which is the split `scripts/setup.mjs`'s header
 * documents and the exit-code table in AGENTS.md repeats.
 */
export function stop(message, resume, code = 1, { err = console.error, exit = process.exit } = {}) {
  err("");
  err(`  setup stopped: ${message}`);
  if (resume) err(`  Resume with: ${resume}`);
  err("");
  return exit(code);
}
