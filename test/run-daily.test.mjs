// run-daily.test.mjs - the launcher's tests.
//
// node --test  (run from the repository root)
//
// The launcher's whole job is to finish the run whether or not the model window
// opens, so most of these tests are about the ways that window can fail: the
// binary is missing, it times out, it exits non-zero, config switched it off, or
// the operator said `--no-llm`. Every one of them must still leave phase 1 and
// phase 2 run and the process exiting 0.
//
// Nothing here starts a process: `runPlan` takes its spawn port as an argument
// and the only disk this file touches is one `mkdtemp` directory, which the
// `--dry-run` case writes nothing into.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LLM_DEFAULTS,
  LLM_PROMPT,
  LLM_TOOLS,
  buildPlan,
  claudeArgs,
  commandLine,
  llmOutcome,
  llmSettings,
  loadRunConfig,
  main,
  promptFor,
  quoteArg,
  runPlan,
  scopeOf,
  scopeSentence,
  stepSummary,
} from "../scripts/run-daily.mjs";

const NODE = "/usr/bin/node";
const RESULT = "/tmp/d/tmp/llm-result.json";
const plan = (cfg = {}, opts = {}) => buildPlan(cfg, { node: NODE, resultFile: RESULT, ...opts });
const ok = { status: 0, stdout: "phase 1: scrape=ok(97-items)", stderr: "", timedOut: false, error: null };

/** A spawn port that answers from a table keyed on the step name. */
function fakeSpawn(byName = {}) {
  const seen = [];
  const spawn = (step) => {
    seen.push(step);
    return { ...ok, ...(byName[step.name] ?? {}) };
  };
  return { spawn, seen };
}

// ------------------------------------------------------------ the arguments

test("claudeArgs is built from config, with the shipped values as the fallback", () => {
  assert.deepEqual(llmSettings({}), LLM_DEFAULTS);
  assert.deepEqual(claudeArgs({}), [
    "-p", LLM_PROMPT,
    "--model", "claude-sonnet-5",
    "--effort", "medium",
    "--max-turns", "20",
    "--max-budget-usd", "1",
    "--tools", LLM_TOOLS,
    "--allowedTools", LLM_TOOLS,
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--output-format", "json",
  ]);

  const tuned = claudeArgs({ llm: { model: "claude-opus-5", effort: "high", maxTurns: 8, maxBudgetUsd: 0.5 } });
  assert.equal(tuned[tuned.indexOf("--model") + 1], "claude-opus-5");
  assert.equal(tuned[tuned.indexOf("--effort") + 1], "high");
  assert.equal(tuned[tuned.indexOf("--max-turns") + 1], "8");
  assert.equal(tuned[tuned.indexOf("--max-budget-usd") + 1], "0.5");
});

test("the window is granted exactly four tools, no MCP server and project settings only", () => {
  const args = claudeArgs({});
  assert.deepEqual(LLM_TOOLS.split(","), ["Bash", "Read", "Write", "PushNotification"]);
  // --tools limits the built-in set; without --allowedTools every Write is denied
  assert.equal(args.filter((a) => a === LLM_TOOLS).length, 2);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args.includes("--mcp-config"), false);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

// ------------------------------------------------------- the scope sentence

const CFG = "/repo/fixtures/demo/config.demo.json";
const DIR = "/scratch/run";

test("with no --config and no --data the prompt is byte-identical to the scheduled one", () => {
  assert.equal(scopeSentence(), "");
  assert.equal(scopeSentence({}), "");
  assert.equal(scopeSentence({ config: null, data: null }), "");
  assert.equal(promptFor({}), LLM_PROMPT);
  assert.equal(claudeArgs({})[1], LLM_PROMPT);
  assert.equal(buildPlan({}, { node: NODE, resultFile: RESULT })[1].args[1], LLM_PROMPT);
});

test("--data alone redirects the work order and every file the playbook names", () => {
  assert.equal(
    scopeSentence({ data: DIR }),
    `This run uses --data ${DIR}: read the work order at ${DIR}/work-order.json, ` +
      `write every file the playbook names under data/ into ${DIR}/ instead, and ` +
      `append --data ${DIR} to every node command you run.`,
  );
});

test("--config alone only asks for the flag to be passed on - there is no directory to move", () => {
  assert.equal(scopeSentence({ config: CFG }), `This run uses --config ${CFG}: append --config ${CFG} to every node command you run.`);
  assert.equal(scopeSentence({ config: CFG }).includes("work-order.json"), false);
});

test("both flags are named once in the sentence and once in the line to append", () => {
  const s = scopeSentence({ config: CFG, data: DIR });
  assert.equal(
    s,
    `This run uses --config ${CFG} and --data ${DIR}: read the work order at ${DIR}/work-order.json, ` +
      `write every file the playbook names under data/ into ${DIR}/ instead, and ` +
      `append --config ${CFG} --data ${DIR} to every node command you run.`,
  );
  assert.equal(promptFor({ config: CFG, data: DIR }), `${LLM_PROMPT} ${s}`);
});

test("no argument the launcher builds contains a double quote - cmd.exe cannot parse an escaped one", () => {
  // On win32 the whole prompt becomes ONE "-quoted argument handed to cmd.exe,
  // whose parser counts quotes and does not understand \\".
  for (const scope of [{}, { config: CFG }, { data: DIR }, { config: CFG, data: DIR }]) {
    for (const arg of claudeArgs({}, scope)) assert.equal(String(arg).includes('"'), false, String(arg));
  }
  // a path with a space would be ambiguous bare, so THAT one is single-quoted
  const spaced = scopeSentence({ data: "C:\\Users\\First Last\\scratch" });
  assert.ok(spaced.includes("--data 'C:\\Users\\First Last\\scratch'"), spaced);
  assert.equal(spaced.includes('"'), false);
});

test("the scope is read back off the passthrough, so the prompt and the flags cannot disagree", () => {
  assert.deepEqual(scopeOf([]), { config: null, data: null });
  assert.deepEqual(scopeOf(["--data", DIR]), { config: null, data: DIR });
  assert.deepEqual(scopeOf(["--config", CFG, "--data", DIR]), { config: CFG, data: DIR });

  const steps = buildPlan({}, { node: NODE, resultFile: RESULT, passthrough: ["--config", CFG, "--data", DIR] });
  assert.equal(steps[1].args[1], promptFor({ config: CFG, data: DIR }));
  // whatever the sentence says, the pipeline steps really are given
  assert.deepEqual(steps[0].args.slice(-4), ["--config", CFG, "--data", DIR]);
});

test("the whole sentence travels inside the ONE quoted prompt argument, on both platforms", () => {
  const prompt = promptFor({ config: CFG, data: DIR });
  const args = claudeArgs({}, { config: CFG, data: DIR });

  // posix: one single-quoted run, and the prompt carries no ' of its own
  const posix = commandLine("claude", args, "linux");
  assert.equal(posix.split("'").length, 3);
  assert.equal(posix.split("'")[1], prompt);
  assert.ok(posix.split("'")[2].startsWith(" --model"));

  // win32: one double-quoted run with NOTHING to escape inside it, because the
  // prompt carries no double quote of its own
  const win = commandLine("claude", args, "win32");
  assert.ok(win.startsWith('claude -p "'));
  assert.equal(win.slice('claude -p "'.length, win.indexOf('" --model')), prompt);
  assert.equal(win.split('" --model').length, 2);
  assert.equal(win.includes('\\"'), false);
});

// --------------------------------------------------------------- quoting

test("quoteArg follows cmd.exe rules on win32", () => {
  assert.equal(quoteArg("plain", "win32"), "plain");
  assert.equal(quoteArg("", "win32"), '""');
  assert.equal(quoteArg("Bash,Read,Write", "win32"), '"Bash,Read,Write"');
  assert.equal(quoteArg("Read runbooks/daily-agent.md", "win32"), '"Read runbooks/daily-agent.md"');
  assert.equal(quoteArg('say "hi"', "win32"), '"say \\"hi\\""');
  assert.equal(quoteArg("C:\\Program Files\\nodejs\\node.exe", "win32"), '"C:\\Program Files\\nodejs\\node.exe"');
  // a trailing backslash would escape the closing quote, so it is doubled
  assert.equal(quoteArg("C:\\dir with space\\", "win32"), '"C:\\dir with space\\\\"');
});

test("quoteArg follows POSIX shell rules elsewhere", () => {
  assert.equal(quoteArg("plain", "linux"), "plain");
  assert.equal(quoteArg("Bash,Read,Write", "linux"), "Bash,Read,Write");
  assert.equal(quoteArg("", "darwin"), "''");
  assert.equal(quoteArg("two words", "linux"), "'two words'");
  assert.equal(quoteArg("it's", "linux"), "'it'\\''s'");
});

test("commandLine quotes every word of the model window, on both platforms", () => {
  const win = commandLine("claude", claudeArgs({}), "win32");
  assert.ok(win.startsWith('claude -p "Read runbooks/daily-agent.md and follow it exactly."'));
  assert.ok(win.includes('--tools "Bash,Read,Write,PushNotification"'));

  const posix = commandLine("claude", claudeArgs({}), "linux");
  assert.ok(posix.startsWith("claude -p 'Read runbooks/daily-agent.md and follow it exactly.'"));
  assert.ok(posix.includes("--tools Bash,Read,Write,PushNotification"));
});

// ------------------------------------------------------------------ the plan

test("the plan is the five commands, in order, with the passthrough flags on the pipeline ones", () => {
  const steps = plan({}, { passthrough: ["--config", "/tmp/c.json", "--data", "/tmp/d"] });
  assert.deepEqual(steps.map((s) => s.name), ["phase 1", "model window", "phase 2", "finish", "usage"]);
  assert.deepEqual(steps[0].args, ["src/pipeline.mjs", "--phase", "1", "--config", "/tmp/c.json", "--data", "/tmp/d"]);
  assert.deepEqual(steps[2].args.slice(0, 3), ["src/pipeline.mjs", "--phase", "2"]);
  assert.deepEqual(steps[3].args.slice(0, 2), ["src/pipeline.mjs", "--finish"]);
  assert.deepEqual(steps[4].args.slice(0, 3), ["src/pipeline.mjs", "--usage", RESULT]);
  for (const s of [steps[0], steps[2], steps[3], steps[4]]) assert.equal(s.exe, NODE);
  assert.equal(steps[1].exe, "claude");
  assert.equal(steps[1].shell, true);
  assert.equal(steps[1].timeoutMs, 45 * 60000);
});

test("--no-llm and llm.enabled false both skip the window, and say which", () => {
  assert.equal(plan({}, { noLlm: true })[1].skip, "llm=absent(no-llm)");
  assert.equal(plan({ llm: { enabled: false } })[1].skip, "llm=absent(disabled)");
  assert.equal(plan({})[1].skip, null);
  // the step stays in the plan either way - a dry run answers "what would happen"
  assert.equal(plan({}, { noLlm: true }).length, 5);
});

test("llm.timeoutMinutes sets the window's cap, and a nonsense value falls back", () => {
  assert.equal(plan({ llm: { timeoutMinutes: 10 } })[1].timeoutMs, 600000);
  assert.equal(plan({ llm: { timeoutMinutes: "nonsense" } })[1].timeoutMs, LLM_DEFAULTS.timeoutMinutes * 60000);
});

// -------------------------------------------------------------- the outcomes

test("a missing, timed-out or failing window is llm=absent, never a run failure", () => {
  assert.equal(llmOutcome({ ...ok, error: "ENOENT" }), "llm=absent(missing)");
  assert.equal(llmOutcome({ ...ok, status: 9009 }), "llm=absent(missing)"); // cmd.exe for "not recognized"
  assert.equal(llmOutcome({ ...ok, timedOut: true }), "llm=absent(timeout)");
  assert.equal(llmOutcome({ ...ok, status: 1 }), "llm=absent(exit-1)");
  assert.equal(llmOutcome({ ...ok, error: "EACCES" }), "llm=absent(EACCES)");
  assert.equal(llmOutcome(ok), "llm=ran");
});

test("a step's summary is its own last line, and its name is never printed twice", () => {
  const step = { name: "phase 1" };
  assert.equal(stepSummary(step, { ...ok, stdout: "noise\nphase 1: scrape=ok(97-items) behind=clear\n" }), "phase 1: scrape=ok(97-items) behind=clear");
  assert.equal(stepSummary(step, { ...ok, stdout: "already-done" }), "phase 1: already-done");
  assert.equal(stepSummary(step, { ...ok, stdout: "", stderr: "", status: 4 }), "phase 1: exit-4");
  assert.equal(stepSummary(step, { ...ok, error: "ENOENT" }), "phase 1: NOT-STARTED(missing node)");
  assert.equal(stepSummary(step, { ...ok, timedOut: true }), "phase 1: timeout");
});

// --------------------------------------------------------------- the runner

test("a run with no model window still runs both phases and exits 0", () => {
  const { spawn, seen } = fakeSpawn();
  const log = [];
  const res = runPlan({ plan: plan({}, { noLlm: true }), spawn, log: (l) => log.push(l) });
  assert.equal(res.code, 0);
  assert.deepEqual(seen.map((s) => s.name), ["phase 1", "phase 2", "finish", "usage"]);
  assert.ok(log.includes("llm=absent(no-llm)"));
});

test("a window that will not start is reported and the run carries on to exit 0", () => {
  const { spawn, seen } = fakeSpawn({ "model window": { error: "ENOENT", status: null } });
  const res = runPlan({ plan: plan({}), spawn });
  assert.equal(res.code, 0);
  assert.deepEqual(seen.map((s) => s.name), ["phase 1", "model window", "phase 2", "finish", "usage"]);
  assert.ok(res.summaries.includes("llm=absent(missing)"));
});

test("pipeline.mjs itself failing to start is the one failure the task hears about", () => {
  const notStarted = { error: "ENOENT", status: null };
  assert.equal(runPlan({ plan: plan({}), spawn: fakeSpawn({ "phase 1": notStarted }).spawn }).code, 1);
  assert.equal(runPlan({ plan: plan({}), spawn: fakeSpawn({ "phase 2": notStarted }).spawn }).code, 1);
  // a phase that RAN and said no is still a run: `--finish` gets its chance
  assert.equal(runPlan({ plan: plan({}), spawn: fakeSpawn({ "phase 2": { ...ok, status: 4, stdout: "no-phase-1" } }).spawn }).code, 0);
});

test("the window's stdout is captured to the result file, not to the transcript", () => {
  const json = '{"num_turns":8,"total_cost_usd":0.3}';
  const { spawn } = fakeSpawn({ "model window": { ...ok, stdout: json, stderr: "one warning\n" } });
  const written = [];
  const logged = [];
  runPlan({ plan: plan({}), spawn, writeFile: (f, t) => written.push([f, t]), appendLog: (t) => logged.push(t) });
  assert.deepEqual(written, [[RESULT, json]]);
  const transcript = logged.join("");
  assert.equal(transcript.includes(json), false); // 19k of base64 does not belong in the log
  assert.ok(transcript.includes("one warning"));
});

test("the transcript is bracketed by the start and end markers a human greps for", () => {
  const { spawn } = fakeSpawn();
  const logged = [];
  runPlan({ plan: plan({}, { noLlm: true }), spawn, appendLog: (t) => logged.push(t), now: () => new Date("2026-09-15T14:30:07.000Z") });
  assert.equal(logged[0], "---- daily start 2026-09-15T14:30:07.000Z ----\n");
  assert.equal(logged.at(-1), "---- daily end 2026-09-15T14:30:07.000Z ----\n");
});

// ------------------------------------------------------------------- the CLI

/** `--dry-run` needs a config path that certainly does not exist, so the run is
 *  the shipped defaults on every machine, and a data dir nothing writes into. */
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-daily-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function capture(fn) {
  const out = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => out.push(a.join(" "));
  try {
    return { code: fn(), out };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

test("--dry-run prints the five commands, the model window fully quoted, and runs nothing", () => {
  withTempDir((dir) => {
    const argv = ["--dry-run", "--config", path.join(dir, "no-such-config.json"), "--data", dir];
    const { code, out } = capture(() => main(argv));
    assert.equal(code, 0);
    assert.equal(out.length, 5);
    assert.match(out[0], /src[/\\]pipeline\.mjs.* --phase 1/);
    assert.ok(out[1].startsWith("claude -p "));
    assert.ok(out[1].includes("--output-format json"));
    // the window is told, in its own prompt, where this run's files live
    assert.ok(out[1].includes(`${dir}/work-order.json`), out[1]);
    assert.ok(out[1].includes("append --config"), out[1]);
    assert.ok(out[1].includes(path.join(dir, "no-such-config.json")), out[1]);
    // exactly two double quotes on that line: the ones this file put round the
    // whole prompt. Nothing inside it is quoted, so cmd.exe can parse it.
    assert.equal((out[1].match(/"/g) ?? []).length, 6); // prompt + --tools + --allowedTools
    assert.match(out[2], /--phase 2/);
    assert.match(out[3], /--finish/);
    assert.match(out[4], /--usage/);
    // the flags this run was given reach the pipeline it spawns
    for (const line of [out[0], out[2], out[3], out[4]]) assert.ok(line.includes("--config"), line);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("--dry-run with --no-llm says so on the window's own line", () => {
  withTempDir((dir) => {
    const { out } = capture(() => main(["--dry-run", "--no-llm", "--config", path.join(dir, "nope.json"), "--data", dir]));
    assert.equal(out.length, 5);
    assert.ok(out[1].endsWith("(skipped: llm=absent(no-llm))"));
  });
});

test("--data on its own puts an absolute directory in the prompt and names no config", () => {
  withTempDir((dir) => {
    // no --config flag, so `loadConfig` would fall back to the repo's own
    // config.json; point it at nothing instead, and the run is the defaults
    // on every machine without the passthrough gaining a --config.
    const before = process.env.AGENDA_CONFIG;
    process.env.AGENDA_CONFIG = path.join(dir, "no-such-config.json");
    const { out } = capture(() => main(["--dry-run", "--data", dir]));
    if (before === undefined) delete process.env.AGENDA_CONFIG;
    else process.env.AGENDA_CONFIG = before;
    assert.equal(out.length, 5);
    assert.ok(out[1].includes(`--data ${dir}:`), out[1]);
    assert.ok(out[1].includes(`${dir}/work-order.json`), out[1]);
    assert.equal(out[1].includes("--config"), false);
    // and the pipeline steps get --data but not --config either
    assert.ok(out[0].endsWith(`--data ${quoteArg(dir)}`), out[0]);
  });
});

test("a config.json that will not parse is one line and exit 3, never a stack", () => {
  withTempDir((dir) => {
    const bad = path.join(dir, "config.json");
    fs.writeFileSync(bad, '{ "llm": { "effort": "medium" }, }'); // the trailing comma a human leaves behind
    const said = [];
    assert.equal(loadRunConfig(["--config", bad], (m) => said.push(m)), null);
    assert.equal(said.length, 2);
    assert.match(said[0], /^config=FAILED\(config: .*is not valid JSON/);
    assert.equal(said[1], "fix: node scripts/validate-setup.mjs");
    assert.equal(said.join("\n").includes("    at "), false); // no stack frames

    // ... and nothing ran and nothing was written
    const data = path.join(dir, "d");
    fs.mkdirSync(data);
    const { code, out } = capture(() => main(["--config", bad, "--data", data]));
    assert.equal(code, 3);
    assert.match(out[0], /^config=FAILED\(/);
    assert.deepEqual(fs.readdirSync(data), []);
  });
});

test("a config.json that is merely ABSENT is not an error - that is a first run", () => {
  withTempDir((dir) => {
    const cfg = loadRunConfig(["--config", path.join(dir, "nope.json")], () => {
      throw new Error("should not have said anything");
    });
    assert.deepEqual(llmSettings(cfg), LLM_DEFAULTS);
  });
});

test("an unknown flag is a usage error, never a silent default", () => {
  const { code, out } = capture(() => main(["--dry-runn"]));
  assert.equal(code, 2);
  assert.match(out.join("\n"), /unknown flag --dry-runn/);
});
