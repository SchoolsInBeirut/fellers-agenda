#!/usr/bin/env node
// pipeline.mjs - the orchestrator of the daily run.
//
// Every mechanical part of the run happens here, in two phases around one small
// model window. Phase 1 fetches and ingests, then writes ONE compact briefing
// (`data/work-order.json`); the model does the few things only a model can do -
// triage, descriptions, the standards plan, the digest - and calls back; phase 2
// renders, publishes, arms the watchdogs and writes `data/run-report.json`;
// `--finish` appends the single runlog line for the run. No step here needs the
// model, so the page still updates when the model is unavailable, which is the
// whole point: `scripts/run-daily.mjs` completes the run without it and the
// runlog says `llm=absent`.
//
// The step tables live in `src/pipeline-steps.mjs` and the work order in
// `src/pipeline-workorder.mjs` (both re-exported here); this file owns the run
// state, the report, the runlog line, the usage ledger and the CLI. Everything
// is pure except the thin CLI layer at the bottom: steps reach the world only
// through `ctx.spawn` and `ctx.fs`, which `test/pipeline.test.mjs` fakes.
//
// WHAT IT READS   config.json (through `loadConfig`, tolerant of its absence and
//                 explicit about its being broken - see the exit codes),
//                 `data/run-state.json`, `data/llm-notes.json`, `data/runlog.txt`,
//                 and whatever the steps read.
// WHAT IT WRITES  `data/run-state.json`, `data/work-order.json`,
//                 `data/run-report.json`, `data/tmp/gaps.json`,
//                 `data/runlog.txt` (capped, `STALE ` and `AUTH ` lines never
//                 dropped), `data/llm-usage.jsonl`.
//
// CLI usage:
//   node src/pipeline.mjs --phase 1        fetch and ingest, write the work order
//   node src/pipeline.mjs --phase 2        render, publish, arm, write the report
//   node src/pipeline.mjs --finish         append the one runlog line for this run
//   node src/pipeline.mjs --usage <file>   record the model's cost from its JSON
//   ... --now <ISO>                        pretend "now" is this instant (tests)
//   ... --config <path> --data <dir>       as every CLI here takes; both are
//                                          passed on to every step it spawns
//
// Exit codes:
//   0  done - INCLUDING `already-done` (phase 2 or --finish repeated inside one
//      run id, which the launcher does on purpose) and every deliberate no-op of
//      --usage. A repeat is not an error.
//   2  usage error (no recognised flag, or a bad --now)
//   3  config.json is present but unusable. ONE line naming the key, plus the
//      preflight to run; never a stack, and nothing is written.
//   4  no-phase-1: no run state, or a phase 1 older than six hours. Phase 2
//      refuses rather than publish yesterday's fetch.
//
// A MISSING config.json is not an error at all - `loadConfig` yields the
// defaults, which is what a first run before onboarding should see. An INVALID
// one is exit 3: a trailing comma or a mistyped `llm.effort` used to reach the
// scheduled task as an unhandled stack with no runlog line and nothing
// published, which is indistinguishable from the machine being asleep.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ConfigError, derive, loadConfig } from "./lib/config.mjs";
import { argFlag, configPath, dataDir, repoRoot } from "./lib/paths.mjs";
import { PHASE1, PHASE2, TIMEOUT } from "./pipeline-steps.mjs";
import { clip, dpath, iso, localStamp, pick, readJson, tryOr, zoneOf } from "./pipeline-workorder.mjs";

// The work order and the local-time spellings live in pipeline-workorder.mjs;
// they are re-exported here so this file stays the one import a caller needs.
export {
  UNSEEN_WINDOW_HOURS, buildWorkOrder, iso, localDay, localStamp, localWeekday, zoneOf,
} from "./pipeline-workorder.mjs";

const ROOT = repoRoot();
const PHASE1_MAX_AGE_MS = 6 * 60 * 60 * 1000, RUNLOG_CAP = 500;

/** Runlog lines that are a watchdog's only record of itself, and are never trimmed. */
export const PROTECTED_PREFIXES = Object.freeze(["STALE ", "AUTH "]);

/** The runlog's token order, the model's own tokens included. */
export const RUNLOG_ORDER = Object.freeze([
  "scrape", "reauth", "mail", "board", "materials", "completions", "cmd", "gcal", "studymodel", "behind",
  "triage", "descriptions", "plan", "render", "drive", "mirror", "calendar", "digest", "deadman", "verify", "push",
  // Silent when healthy - they emit no token at all - but a FAILED one from any
  // of them is what a reader of the runlog most needs to see, so they end the line.
  "workorder", "gaps", "snapshot", "report",
]);

const REPORT_STEPS = Object.freeze(["plan", "render", "drive", "mirror", "calendar", "digest", "deadman"]);

// --------------------------------------------------------------- run state

/** A fresh run id. `--phase 1` always starts one and overwrites the file. */
export function newRunState(now, tz) {
  return { runId: iso(now), startedLocal: localStamp(now, tz), phase1: null, phase2: null, finished: false };
}

/**
 * Parse `data/run-state.json`. Returns null for anything unusable - a missing or
 * corrupt file is exactly the "no phase 1" case, not a crash. The result carries
 * `phase1Fresh(now)`: the six-hour rule that stops a rescued run from publishing
 * yesterday's fetch.
 */
export function readRunState(text) {
  const parsed = tryOr(() => JSON.parse(text), null);
  if (!parsed || typeof parsed !== "object" || typeof parsed.runId !== "string") return null;
  const at = Date.parse(parsed.phase1?.finishedAt ?? parsed.runId);
  return {
    ...parsed,
    phase1Fresh: (now) => !!parsed.phase1 && Number.isFinite(at) && new Date(now).getTime() - at <= PHASE1_MAX_AGE_MS,
  };
}

export const serializeRunState = (s) =>
  `${JSON.stringify({ runId: s.runId, startedLocal: s.startedLocal ?? null, phase1: s.phase1 ?? null, phase2: s.phase2 ?? null, finished: s.finished === true }, null, 1)}\n`;

// ----------------------------------------------------------------- runPhase

/**
 * Run one step table. Every step sees the tokens and outputs of the steps before
 * it; a step that throws is recorded as FAILED and the phase carries on -
 * nothing throws past its own step. The accumulated state is written back onto
 * `ctx.state` at the end: the one deliberate mutation here, because phase 2 and
 * the CLI both read the state phase 1 left behind.
 */
export function runPhase(steps, ctx) {
  let state = ctx.state;
  let tokens = {};
  let out = {};
  const results = [];
  for (const step of steps) {
    let res;
    try {
      res = step.run({ ...ctx, state, tokens, out }) ?? {};
    } catch (e) {
      // Hyphenated, like every other token: the runlog line is read by splitting
      // on spaces, and a thrown Error's message is the least predictable string
      // that can reach it.
      res = { token: `${step.name}=FAILED(${String(e?.message ?? e).trim().replace(/\s+/g, "-").slice(0, 120)})` };
    }
    if (res.tokens) tokens = { ...tokens, ...res.tokens };
    else if (res.token) tokens = { ...tokens, [step.name]: res.token };
    if (res.state) state = res.state;
    if (res.out !== undefined) out = { ...out, [step.name]: res.out };
    results.push({ name: step.name, ...res });
  }
  ctx.state = state;
  return { tokens, results, state, out };
}

// ------------------------------------------------------------------- report

/** `data/run-report.json`: what phase 2 did, in the model's own vocabulary. */
export function buildReport(ctx) {
  const state = ctx.state ?? {};
  const p1 = state.phase1 ?? {};
  const all = { ...(p1.tokens ?? {}), ...(state.phase2?.tokens ?? {}) };
  return {
    runId: state.runId ?? null, scrapeOk: p1.scrapeOk === true, scrapedAt: p1.scrapedAt ?? null,
    items: p1.items ?? null, previousItems: p1.previousItems ?? null,
    steps: pick(state.phase2?.tokens ?? {}, REPORT_STEPS),
    failed: Object.keys(all).filter((k) => /FAILED/.test(String(all[k]))),
  };
}

// --------------------------------------------------------- the runlog line

const NOTE_CAP = 80;

/**
 * The runlog line is read by splitting on spaces, so a model note may not carry
 * one: every run of whitespace - a newline the model wrapped a phrase on
 * included - becomes a single `-`, anything unprintable goes, and the value is
 * clipped. `runbooks/daily-agent.md` asks for tokens already in this shape; this
 * is the guard that means a note which is not cannot break the line.
 */
const sanitiseNote = (v) => String(v).replace(/[^ -~]+/g, " ").trim().replace(/\s+/g, "-").slice(0, NOTE_CAP);

/** A model note is a token with or without its own name; both are accepted. */
const noteToken = (key, notes, fallback) => {
  const v = notes && typeof notes[key] === "string" ? sanitiseNote(notes[key]) : "";
  return !v ? fallback : v.startsWith(`${key}=`) ? v : `${key}=${v}`;
};

/**
 * The single daily line. It starts with the ISO instant so `src/stale-check.mjs`
 * still recognises it as a run. `notes` is `data/llm-notes.json` for THIS run id,
 * or null - and null is not a failure, it is `llm=absent` plus the four
 * `llm-absent` tokens, because a run without the model still ran.
 */
export function finishLine(ctx, notes) {
  const state = ctx.state ?? {};
  const ran = !!notes && typeof notes === "object";
  const all = {
    reauth: "reauth=not-needed",
    ...(state.phase1?.tokens ?? {}),
    ...(state.phase2?.tokens ?? {}),
    triage: noteToken("triage", notes, "triage=SKIPPED(llm-absent)"),
    descriptions: noteToken("descriptions", notes, "descriptions=SKIPPED(llm-absent)"),
    verify: noteToken("verify", notes, "verify=SKIPPED(llm-absent)"),
    push: noteToken("push", notes, "push=0(llm-absent)"),
  };
  const started = String(state.startedLocal ?? "").split(" ")[1] ?? "";
  return [
    iso(ctx.now),
    started ? `run=daily(started-${started}-local)` : "run=daily",
    ...RUNLOG_ORDER.map((k) => all[k]).filter(Boolean),
    ran ? "llm=ran" : "llm=absent",
    `errors=${Object.values(all).filter((v) => /FAILED/.test(String(v))).length}`,
  ].join(" ");
}

/**
 * Trim `data/runlog.txt` to `cap` lines from the top, NEVER dropping a `STALE `
 * or `AUTH ` line: those are the only record either watchdog keeps of what it
 * did, and AGENTS.md says in as many words that they are not to be dropped. A
 * log made only of protected lines is returned untouched.
 */
export function trimRunlog(lines, cap = RUNLOG_CAP) {
  const all = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === "string" && l.length);
  if (all.length <= cap) return [...all];
  let drop = all.length - cap;
  const kept = [];
  for (const line of all) {
    if (drop > 0 && !PROTECTED_PREFIXES.some((p) => line.startsWith(p))) drop -= 1;
    else kept.push(line);
  }
  return kept;
}

/**
 * Append `line` to `data/runlog.txt`, trimmed. A runlog that EXISTS but reads
 * back undefined (a locked file, a read that failed) is APPENDED to instead:
 * rewriting it from what was read would silently throw away up to 500 lines of
 * history, every protected line included, which is the one thing this file is
 * kept for. Returns the note to print in that case, else null.
 */
export function writeRunlog(ctx, line) {
  const runlog = dpath(ctx, "runlog.txt");
  const existing = ctx.fs.read(runlog);
  if (existing === undefined && ctx.fs.exists(runlog)) {
    ctx.fs.append(runlog, `${line}\n`);
    return "runlog=append-only(read-failed)";
  }
  ctx.fs.write(runlog, `${trimRunlog([...String(existing ?? "").split(/\r?\n/), line]).join("\n")}\n`);
  return null;
}

// ------------------------------------------------------------ usage ledger

/**
 * One line of `data/llm-usage.jsonl` from `claude -p --output-format json`. The
 * run's model is the `modelUsage` entry that wrote the most - NOT the first key,
 * which is the CLI's own small internal call - while `outputTokensAll` keeps the
 * sum over every entry, so the ledger still adds up. The cost is the run's own
 * total. Anything missing lands as null rather than as a wrong number.
 */
export function buildUsageRecord(result, runId) {
  if (!result || typeof result !== "object") return null;
  const usage = result.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : {};
  const entries = Object.entries(usage);
  const outOf = (e) => Number(e?.[1]?.outputTokens) || 0;
  const [model, m] = entries.reduce((a, b) => (outOf(b) > outOf(a) ? b : a), entries[0]) ?? [null, {}];
  return {
    runId, model: model ?? null, turns: result.num_turns ?? null,
    outputTokens: m?.outputTokens ?? result.usage?.output_tokens ?? null,
    outputTokensAll: entries.length ? entries.reduce((sum, e) => sum + outOf(e), 0) : (result.usage?.output_tokens ?? null),
    cacheRead: m?.cacheReadInputTokens ?? result.usage?.cache_read_input_tokens ?? null,
    costUsd: result.total_cost_usd ?? m?.costUSD ?? null,
  };
}

// --------------------------------------------------------------------- CLI

const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

/** The real world, behind the same two ports the tests fake. */
const REAL_FS = Object.freeze({
  read: (p) => tryOr(() => fs.readFileSync(abs(p), "utf8"), undefined),
  exists: (p) => fs.existsSync(abs(p)),
  mtime: (p) => tryOr(() => fs.statSync(abs(p)).mtime, new Date(0)),
  // Temp file then rename: a run killed mid-write must never leave
  // data/run-state.json or data/work-order.json half written on disk.
  write: (p, text) => {
    const full = abs(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, full);
    } catch (e) {
      tryOr(() => fs.rmSync(tmp, { force: true }), undefined);
      throw e;
    }
  },
  append: (p, text) => {
    fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
    fs.appendFileSync(abs(p), text);
  },
  copy: (a, b) => {
    fs.mkdirSync(path.dirname(abs(b)), { recursive: true });
    fs.copyFileSync(abs(a), abs(b));
  },
});

// process.execPath, not "node": a scheduled task must run the same Node this
// process runs, whatever PATH the service account happens to have. cwd is the
// repo root so every step's relative script path resolves the same way.
const realSpawn = (argv, opts = {}) => {
  const r = spawnSync(process.execPath, argv, {
    cwd: ROOT, encoding: "utf8", timeout: opts.timeoutMs ?? TIMEOUT.default, killSignal: opts.killSignal ?? "SIGTERM",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
};

const USAGE =
  "usage: node src/pipeline.mjs --phase 1 | --phase 2 | --finish | --usage <file>\n" +
  "       [--now <ISO>] [--config <path>] [--data <dir>]";

function parseArgs(argv) {
  const val = (flag) => (argv.indexOf(flag) === -1 ? undefined : argv[argv.indexOf(flag) + 1]);
  return {
    argv,
    phase: val("--phase") === undefined ? null : Number(val("--phase")),
    finish: argv.includes("--finish"),
    usage: argv.includes("--usage") ? val("--usage") : undefined,
    now: argFlag(argv, "now"),
  };
}

/** `--config` / `--data`, resolved, and only when this run was actually given them. */
export function passthroughFlags(argv) {
  return [
    ...(argFlag(argv, "config") ? ["--config", configPath(argv, ROOT)] : []),
    ...(argFlag(argv, "data") ? ["--data", dataDir(argv, ROOT)] : []),
  ];
}

/**
 * The configuration, or null after saying why in ONE line.
 *
 * `loadConfig` tolerates an ABSENT config.json - that is a first run before
 * onboarding and the defaults are the right answer. It does not tolerate an
 * INVALID one, and a trailing comma used to reach the scheduled task as an
 * unhandled stack: no runlog line, nothing published, and both watchdogs dying
 * on the same line, which from the outside looks exactly like a sleeping
 * machine. Anything that is not a `ConfigError` is a bug in this repo and still
 * throws.
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

function makeCtx(args, cfg) {
  return {
    now: args.now ? new Date(args.now) : new Date(),
    cfg,
    tz: zoneOf(cfg),
    titles: derive(cfg).docTitles,
    platform: process.platform,
    data: dataDir(args.argv, ROOT),
    passthrough: passthroughFlags(args.argv),
    spawn: realSpawn,
    fs: REAL_FS,
    state: null,
  };
}

const statePath = (ctx) => dpath(ctx, "run-state.json");
const doneAt = (args, ctx) => iso(args.now ? ctx.now : new Date()); // a phase ends when it ends
const loadState = (ctx) => readRunState(ctx.fs.read(statePath(ctx)));
const say = (text, code = 0) => (console.log(text), code);
const summary = (label, tokens) => `${label}: ${RUNLOG_ORDER.map((k) => tokens[k]).filter(Boolean).join(" ") || "(no tokens)"}`;

function cmdPhase1(args, cfg) {
  const ctx = makeCtx(args, cfg);
  ctx.state = newRunState(ctx.now, ctx.tz);
  ctx.fs.write(statePath(ctx), serializeRunState(ctx.state));
  const { tokens, state } = runPhase(PHASE1, ctx);
  ctx.fs.write(statePath(ctx), serializeRunState({ ...state, phase1: { ...(state.phase1 ?? {}), finishedAt: doneAt(args, ctx), tokens } }));
  return say(summary("phase 1", tokens));
}

function cmdPhase2(args, cfg) {
  const ctx = makeCtx(args, cfg);
  const state = loadState(ctx);
  if (!state || !state.phase1Fresh(ctx.now)) return say("no-phase-1", 4);
  if (state.phase2?.finishedAt) return say("already-done"); // a phase 2 that only got as far as the digest is resumable
  ctx.state = state;
  const { tokens, state: after } = runPhase(PHASE2, ctx);
  ctx.fs.write(statePath(ctx), serializeRunState({ ...after, phase2: { ...(after.phase2 ?? {}), finishedAt: doneAt(args, ctx), tokens } }));
  return say(summary("phase 2", tokens));
}

/** `data/llm-notes.json` counts only when it belongs to THIS run id. */
function readNotes(ctx, state) {
  const notes = readJson(ctx, "llm-notes.json");
  if (!notes || typeof notes !== "object") return null;
  if (typeof notes.runId === "string") return notes.runId === state.runId ? notes : null;
  return ctx.fs.mtime(dpath(ctx, "llm-notes.json")).getTime() >= Date.parse(state.runId) ? notes : null;
}

function cmdFinish(args, cfg) {
  const ctx = makeCtx(args, cfg);
  const state = loadState(ctx);
  if (!state || !state.phase1Fresh(ctx.now)) return say("no-phase-1", 4);
  if (state.finished) return say("already-done");
  ctx.state = state;
  const line = finishLine(ctx, readNotes(ctx, state));
  const note = writeRunlog(ctx, line);
  ctx.fs.write(statePath(ctx), serializeRunState({ ...state, finished: true }));
  if (note) console.log(note);
  return say(line);
}

function cmdUsage(args, cfg) {
  const ctx = makeCtx(args, cfg);
  const state = loadState(ctx);
  const file = args.usage;
  const skip = (why) => say(`usage=SKIPPED(${why})`);
  if (!state) return skip("no-run-state");
  if (!file || !ctx.fs.exists(file)) return skip("no-result-file");
  if (ctx.fs.mtime(file).getTime() < Date.parse(state.runId)) return skip("older-run");
  const record = buildUsageRecord(tryOr(() => JSON.parse(ctx.fs.read(file)), null), state.runId);
  if (!record) return skip("unparseable");
  const ledger = dpath(ctx, "llm-usage.jsonl");
  const existing = String(ctx.fs.read(ledger) ?? "");
  if (existing.includes(`"runId":"${state.runId}"`)) return say("usage=already-recorded");
  ctx.fs.write(ledger, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${JSON.stringify(record)}\n`);
  return say(`usage=recorded(${record.model};${record.outputTokens} out;$${record.costUsd})`);
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.now && Number.isNaN(new Date(args.now).getTime())) return say(`bad --now value: ${args.now}`, 2);
  const known = argv.includes("--usage") || args.finish || args.phase === 1 || args.phase === 2;
  if (!known) return say(USAGE, 2);
  // Read the config BEFORE anything is written, so exit 3 leaves the run state
  // and the runlog exactly as the last good run left them.
  const cfg = loadRunConfig(args.argv);
  if (cfg === null) return 3;
  if (argv.includes("--usage")) return cmdUsage(args, cfg);
  if (args.finish) return cmdFinish(args, cfg);
  if (args.phase === 1) return cmdPhase1(args, cfg);
  return cmdPhase2(args, cfg);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
