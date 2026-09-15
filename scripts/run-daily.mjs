#!/usr/bin/env node
// run-daily.mjs - the launcher for the once-a-day run.
//
// WHAT THIS IS. Five commands in a row, and the discipline to finish the run
// when the middle one cannot start:
//
//   1  node src/pipeline.mjs --phase 1      fetch, ingest, write the work order
//   2  claude -p "...daily-agent.md..."     the model window (skippable)
//   3  node src/pipeline.mjs --phase 2      render, publish, arm the watchdogs
//   4  node src/pipeline.mjs --finish       the one runlog line for this run
//   5  node src/pipeline.mjs --usage <file> record what the window cost
//
// Steps 3 and 4 are no-ops when the model already ran them, which it does at the
// end of `runbooks/daily-agent.md`; repeating them is how the page still gets
// published when it did not. A missing `claude`, a non-zero exit or a timeout is
// NOT a run failure: the launcher prints `llm=absent(<reason>)` and carries on,
// because the agenda updating without judgement beats the agenda going dark.
//
// WHAT IT READS   config.json (`llm.*`), and nothing else of its own.
// WHAT IT WRITES  `data/runlog-stdout.txt` - every step's raw stdout and stderr
//                 between `---- daily start/end <ISO> ----` markers - and
//                 `data/tmp/llm-result.json`, the model window's JSON result.
//                 Everything else is written by `src/pipeline.mjs`.
//
// CLI usage:
//   node scripts/run-daily.mjs [--no-llm] [--dry-run] [--config <p>] [--data <d>]
//
//   --no-llm    run the pipeline only; the runlog says `llm=absent(no-llm)`
//   --dry-run   print the five commands, fully quoted, and run nothing
//
// --config AND --data REACH THE MODEL TOO. The pipeline takes both as flags, but
// `runbooks/daily-agent.md` is written in terms of `data/work-order.json` and
// `node src/...` with no flags at all - so a run pointed at a scratch directory
// would have the window reading and writing the repo's own `data/` while every
// script around it used the other one. When either flag is given, ONE sentence
// naming them is appended to the prompt (`scopeSentence`). With neither, the
// prompt is byte-identical to the one the scheduled task sends.
//
// Exit codes:
//   0  phase 1 and phase 2 both ran, whatever their tokens say
//   1  `src/pipeline.mjs` itself could not be started - the one failure a
//      scheduled task should be told about
//   2  usage error (an unknown flag); nothing ran
//   3  config.json is present but unusable. ONE line naming the key, plus the
//      preflight to run; never a stack, and nothing ran. A MISSING config.json
//      is not an error - that is a first run before onboarding, and the shipped
//      defaults are the right answer.
//
// WINDOWS QUOTING. `claude` on Windows is `claude.cmd`, so it has to be started
// through the shell, and Node does not quote arguments for `shell: true` - it
// concatenates them. So this file builds the command line itself
// (`commandLine`/`quoteArg`) and hands `cmd.exe` one string. The quoter wraps in
// double quotes and doubles backslashes before a quote; it deliberately does not
// try to escape `%` or `!`, which `cmd` still expands inside quotes. No argument
// this file builds contains either, and none is taken from user data.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "../src/lib/config.mjs";
import { argFlag, argHas, configPath, dataDir, repoRoot } from "../src/lib/paths.mjs";

const ROOT = repoRoot();
const MAX_OUTPUT = 64 * 1024 * 1024; // the model window answers in one JSON blob

/** The model window's settings, with the shipped values as the fallback. */
export const LLM_DEFAULTS = Object.freeze({
  enabled: true,
  model: "claude-sonnet-5",
  effort: "medium",
  maxTurns: 20,
  maxBudgetUsd: 1,
  timeoutMinutes: 45,
});

/** The four tools the window gets. Everything else is denied, including MCP. */
export const LLM_TOOLS = "Bash,Read,Write,PushNotification";

/** The one sentence the window is started with. */
export const LLM_PROMPT = "Read runbooks/daily-agent.md and follow it exactly.";

export const llmSettings = (cfg) => ({ ...LLM_DEFAULTS, ...(cfg?.llm ?? {}) });

/**
 * The `--config` / `--data` this run was given, read back off the passthrough
 * the pipeline steps already receive. Deriving it from there rather than from
 * argv a second time is what makes the sentence the model reads and the flags
 * its siblings get impossible to disagree. PURE.
 */
export function scopeOf(passthrough = []) {
  const at = (flag) => {
    const i = passthrough.indexOf(flag);
    return i === -1 ? null : (passthrough[i + 1] ?? null);
  };
  return { config: at("--config"), data: at("--data") };
}

/**
 * The one sentence that tells the window this run is not pointed at the repo's
 * own `data/`, or "" when it is.
 *
 * `runbooks/daily-agent.md` names bare paths - `data/work-order.json`,
 * `node src/mail-triage.mjs --apply ...` - because that is what a scheduled run
 * uses and a runbook full of placeholders is a runbook nobody can read. Demo
 * mode, a hermetic smoke and every subprocess test move that directory, and the
 * window is the one participant the flags do not otherwise reach. PURE.
 */
export function scopeSentence({ config = null, data = null } = {}) {
  // NO DOUBLE QUOTES, ever. On win32 the whole prompt becomes one `"`-quoted
  // argument handed to `cmd.exe`, whose parser counts quotes and does not
  // understand the `\"` escaping that inner ones would need. A path carrying a
  // space would be ambiguous bare, so that one - and only that one - is single
  // quoted, which both shells are happy to see inside the prompt.
  const show = (p) => (/\s/.test(p) ? `'${p}'` : p);
  const flags = [...(config ? [`--config ${show(config)}`] : []), ...(data ? [`--data ${show(data)}`] : [])];
  if (!flags.length) return "";
  const named = flags.length === 2 ? `${flags[0]} and ${flags[1]}` : flags[0];
  const redirect = data
    ? `read the work order at ${data}/work-order.json, write every file the playbook names under data/ into ${data}/ instead, and `
    : "";
  return `This run uses ${named}: ${redirect}append ${flags.join(" ")} to every node command you run.`;
}

/** The prompt for this run: the fixed sentence, plus the scope one when there is one. PURE. */
export const promptFor = (scope) => [LLM_PROMPT, scopeSentence(scope)].filter(Boolean).join(" ");

/**
 * The `claude -p` argument list.
 *
 * `--tools` limits the built-in set and `--allowedTools` grants it: without the
 * second one every Write is denied under `--setting-sources project`.
 * `--strict-mcp-config` with no `--mcp-config` loads zero MCP servers, and
 * `--setting-sources project` skips user-level rules, hooks and skills, so the
 * window sees this repository and nothing else. `--max-turns` and
 * `--max-budget-usd` are hard caps: a run that hits either is a run to look at,
 * not a cap to widen. PURE.
 */
export function claudeArgs(cfg, scope = {}) {
  const llm = llmSettings(cfg);
  return [
    "-p", promptFor(scope),
    "--model", String(llm.model),
    "--effort", String(llm.effort),
    "--max-turns", String(llm.maxTurns),
    "--max-budget-usd", String(llm.maxBudgetUsd),
    "--tools", LLM_TOOLS,
    "--allowedTools", LLM_TOOLS,
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--output-format", "json",
  ];
}

/**
 * One argument, quoted for the platform's shell. PURE.
 *
 * win32: `cmd.exe` rules - wrap in double quotes, double every backslash that
 * precedes a quote or ends the string, escape the quote itself.
 * posix: single quotes, with `'\''` for an embedded quote.
 */
export function quoteArg(s, platform = process.platform) {
  const v = String(s ?? "");
  if (platform === "win32") {
    if (!v) return '""';
    if (!/[\s"^&|<>()%!,;=]/.test(v)) return v;
    return `"${v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  }
  if (!v) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** An executable and its arguments as one shell command line. PURE. */
export const commandLine = (exe, args, platform = process.platform) =>
  [exe, ...(args ?? [])].map((a) => quoteArg(a, platform)).join(" ");

/** The last non-empty line of a stream - what a one-line summary quotes. */
const lastLine = (text) =>
  String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";

const clip = (s, n = 160) => String(s ?? "").replace(/[^ -~]+/g, " ").trim().slice(0, n);

/**
 * The five steps, in order. `skip` is the reason a step will not run, which the
 * dry-run listing prints and the runner honours - the step is still in the list
 * either way, because "what would have happened" is the question a dry run
 * answers. PURE.
 */
export function buildPlan(cfg, { noLlm = false, passthrough = [], node = process.execPath, resultFile } = {}) {
  const llm = llmSettings(cfg);
  const phase = (name, ...args) => ({ name, exe: node, args: ["src/pipeline.mjs", ...args, ...passthrough], required: true });
  const skip = noLlm ? "llm=absent(no-llm)" : llm.enabled === false ? "llm=absent(disabled)" : null;
  return [
    phase("phase 1", "--phase", "1"),
    {
      name: "model window",
      exe: "claude",
      args: claudeArgs(cfg, scopeOf(passthrough)),
      shell: true,
      capture: resultFile,
      timeoutMs: Math.max(1, Number(llm.timeoutMinutes) || LLM_DEFAULTS.timeoutMinutes) * 60000,
      skip,
    },
    phase("phase 2", "--phase", "2"),
    phase("finish", "--finish"),
    phase("usage", "--usage", resultFile),
  ];
}

/**
 * Why the model window did not produce a result. `claude` missing, a non-zero
 * exit and a timeout all mean the same thing to the run: carry on without it.
 * PURE.
 */
export function llmOutcome(res) {
  if (res.error === "ENOENT" || res.status === 9009) return "llm=absent(missing)";
  if (res.error) return `llm=absent(${clip(res.error, 40)})`;
  if (res.timedOut) return "llm=absent(timeout)";
  if (res.status !== 0) return `llm=absent(exit-${res.status})`;
  return "llm=ran";
}

/**
 * One step's one-line summary for the console. The whole of what a step said is
 * in `data/runlog-stdout.txt` and its tokens are in `data/runlog.txt`; this is
 * the line a person watching the terminal reads. `pipeline.mjs` already names
 * the phase it is reporting, so the name is not printed twice. PURE.
 */
export function stepSummary(step, res) {
  if (step.capture) return llmOutcome(res);
  if (res.error === "ENOENT") return `${step.name}: NOT-STARTED(missing node)`;
  if (res.error) return `${step.name}: NOT-STARTED(${clip(res.error, 40)})`;
  if (res.timedOut) return `${step.name}: timeout`;
  const said = clip(lastLine(res.stdout) || lastLine(res.stderr) || `exit-${res.status}`, 200);
  return said.startsWith(`${step.name}:`) ? said : `${step.name}: ${said}`;
}

/**
 * Walk the plan. Every port is injected, so `test/run-daily.test.mjs` runs the
 * whole launcher without starting a process or touching a disk.
 *
 * @param {object} io  `{plan, spawn, appendLog, writeFile, log, now}`
 * @returns {{code:number, summaries:string[]}}
 */
export function runPlan({ plan, spawn, appendLog = () => {}, writeFile = () => {}, log = () => {}, now = () => new Date() }) {
  appendLog(`---- daily start ${now().toISOString()} ----\n`);
  const summaries = [];
  const ran = new Set();
  for (const step of plan) {
    if (step.skip) {
      summaries.push(step.skip);
      log(step.skip);
      continue;
    }
    const res = spawn(step);
    if (step.capture && res.stdout) writeFile(step.capture, res.stdout);
    appendLog(`$ ${step.name}\n${step.capture ? "" : res.stdout ?? ""}${res.stderr ?? ""}`);
    if (!res.error) ran.add(step.name);
    const line = stepSummary(step, res);
    summaries.push(line);
    log(line);
  }
  appendLog(`---- daily end ${now().toISOString()} ----\n`);
  return { code: ran.has("phase 1") && ran.has("phase 2") ? 0 : 1, summaries };
}

// --------------------------------------------------------------------- CLI

const KNOWN_FLAGS = new Set(["--no-llm", "--dry-run", "--config", "--data", "--help", "-h"]);

/** An unknown flag is a hard error, never a silent default. */
function unknownFlag(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;
    const name = a.split("=")[0];
    if (!KNOWN_FLAGS.has(name)) return a;
    if ((name === "--config" || name === "--data") && !a.includes("=")) i += 1;
  }
  return null;
}

function realSpawn(step, platform = process.platform) {
  const how = { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_OUTPUT, ...(step.timeoutMs ? { timeout: step.timeoutMs } : {}) };
  // `claude` is claude.cmd on Windows, so it needs a shell - and a shell needs a
  // command line this file quoted itself (see the header).
  const r = step.shell && platform === "win32"
    ? spawnSync(commandLine(step.exe, step.args, platform), [], { ...how, shell: true })
    : spawnSync(step.exe, step.args, how);
  return {
    status: r.status ?? null,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: r.error?.code === "ETIMEDOUT",
    error: r.error ? (r.error.code ?? "SPAWN-FAILED") : null,
  };
}

/**
 * The configuration, or null after saying why in ONE line.
 *
 * `loadConfig` tolerates an ABSENT config.json - a first run before onboarding
 * gets the defaults, which is right. It does not tolerate an INVALID one, and a
 * trailing comma used to reach the scheduled task as an unhandled stack: no
 * runlog line, nothing published, and the watchdogs dying on the same line,
 * which from outside is indistinguishable from a sleeping machine. Anything
 * that is not a `ConfigError` is a bug in this repo and still throws.
 */
export function loadRunConfig(argv, say = (m) => console.error(m)) {
  try {
    return loadConfig(null, { argv, warn: (m) => console.warn(m) });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    say(`config=FAILED(${clip(String(e.message).split(/\r?\n/)[0], 160)})`);
    say("fix: node scripts/validate-setup.mjs");
    return null;
  }
}

export function main(argv = []) {
  const bad = unknownFlag(argv);
  if (bad) {
    console.error(`run-daily: unknown flag ${bad}\nusage: node scripts/run-daily.mjs [--no-llm] [--dry-run] [--config <p>] [--data <d>]`);
    return 2;
  }
  if (argHas(argv, "help") || argv.includes("-h")) {
    console.log("usage: node scripts/run-daily.mjs [--no-llm] [--dry-run] [--config <p>] [--data <d>]");
    return 0;
  }

  // Before the transcript is opened or anything is spawned, so exit 3 leaves the
  // last good run's files exactly as they were.
  const cfg = loadRunConfig(argv);
  if (cfg === null) return 3;
  const dir = dataDir(argv, ROOT);
  const passthrough = [
    ...(argFlag(argv, "config") ? ["--config", configPath(argv, ROOT)] : []),
    ...(argFlag(argv, "data") ? ["--data", dir] : []),
  ];
  const resultFile = path.join(dir, "tmp", "llm-result.json");
  const plan = buildPlan(cfg, { noLlm: argHas(argv, "no-llm"), passthrough, resultFile });

  if (argHas(argv, "dry-run")) {
    for (const step of plan) {
      console.log(`${commandLine(step.exe, step.args)}${step.skip ? `   (skipped: ${step.skip})` : ""}`);
    }
    return 0;
  }

  const stdoutLog = path.join(dir, "runlog-stdout.txt");
  const { code } = runPlan({
    plan,
    spawn: (step) => realSpawn(step),
    appendLog: (text) => {
      try {
        fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
        fs.appendFileSync(stdoutLog, text.endsWith("\n") ? text : `${text}\n`);
      } catch {
        /* a transcript that cannot be written must never fail the run */
      }
    },
    writeFile: (file, text) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      } catch {
        /* the usage step will report `no-result-file` and the run carries on */
      }
    },
    log: (line) => console.log(line),
  });
  return code;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
