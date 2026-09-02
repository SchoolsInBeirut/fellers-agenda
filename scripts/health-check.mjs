#!/usr/bin/env node
// ===========================================================================
//  health-check.mjs - ask every enabled connector whether it is actually alive
// ===========================================================================
//
//  WHY THIS EXISTS
//  ---------------
//  Every connector ships a `healthCheck()` - a cheap, credential-light probe
//  that proves a session is alive, a token is accepted, or a file can be
//  written - and `/agenda-doctor` is documented as running them. There was no
//  way to run one. Reaching them meant hand-building a connector context inside
//  an ad-hoc `node -e`, which is not something the audience of this repo can be
//  asked to do, and not something an agent should improvise either.
//
//  This is the other half of `validate-setup.mjs`. The preflight answers "is
//  this machine set up correctly?" without touching the network. This answers
//  "does the thing it is set up to talk to actually answer?", which needs the
//  network and the user's own credentials, and is therefore a separate command
//  that a person runs deliberately.
//
//  IT NEVER WRITES ANYTHING. No calendar event, no file, no scrape. A probe
//  with a side effect is a probe nobody dares run when something is wrong.
//
//  Usage:
//    node scripts/health-check.mjs [--config <path>] [--data <dir>] [--json]
//
//  EXIT CODES
//    0  every enabled connector answered, or nothing is enabled yet
//    1  at least one enabled connector could not answer; the reasons printed
// ===========================================================================

import { existsSync } from "node:fs";
import { loadConfig } from "../src/lib/config.mjs";
import { configPath, dataDir as resolveDataDir, argHas, repoRoot } from "../src/lib/paths.mjs";
import { makeContext, readMcpServers } from "../src/scrape.mjs";
import { satisfies, sinks, sources } from "../src/connectors/index.mjs";

/** One connector gets this long to answer before it is reported as hung. */
const PROBE_TIMEOUT_MS = 45000;

const withTimeout = (promise, ms, id) =>
  Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, detail: `no answer after ${Math.round(ms / 1000)}s`, fix: `check whether ${id}'s backend is reachable from this machine` }),
        ms,
      ).unref?.(),
    ),
  ]);

async function main() {
  const argv = process.argv.slice(2);
  const root = repoRoot();
  const asJson = argHas(argv, "json");
  const cfgFile = configPath(argv, root);

  if (!existsSync(cfgFile)) {
    // No config is the normal state before setup, and probing the defaults
    // would start a login nobody asked for.
    const message = "health-check: no config.json yet, so nothing is connected to check. Say \"hey\" in Claude Code to run setup.";
    console.log(asJson ? JSON.stringify({ ok: true, connectors: [], note: message }, null, 1) : message);
    return 0;
  }

  const cfg = loadConfig(null, { argv, warn: (m) => console.warn(m) });
  const dataDir = resolveDataDir(argv, root);
  const servers = readMcpServers(root);
  const enabled = [...sources(cfg), ...sinks(cfg)];

  if (!enabled.length) {
    const message = "health-check: no connector is enabled. `node scripts/validate-setup.mjs` says which one to turn on.";
    console.log(asJson ? JSON.stringify({ ok: true, connectors: [], note: message }, null, 1) : message);
    return 0;
  }

  const results = [];
  for (const mod of enabled) {
    const id = mod.meta.id;
    const can = satisfies(mod, { mcpServers: Object.keys(servers) });
    if (!can.ok) {
      // An enabled connector this machine cannot host is a configuration the
      // template supports, not a fault: one line, and no probe.
      results.push({ id, ok: null, detail: `skipped (${can.reason})`, fix: null });
      continue;
    }
    if (typeof mod.healthCheck !== "function") {
      results.push({ id, ok: null, detail: "declares no healthCheck()", fix: null });
      continue;
    }
    const ctx = makeContext({
      cfg,
      root,
      dataDir,
      now: new Date(),
      deadline: Date.now() + PROBE_TIMEOUT_MS,
      servers,
      log: () => {}, // a probe reports through its return value, not through stdout
    });
    let r;
    try {
      r = await withTimeout(Promise.resolve(mod.healthCheck(ctx)), PROBE_TIMEOUT_MS, id);
    } catch (e) {
      r = { ok: false, detail: String(e?.message ?? e).slice(0, 200), fix: null };
    }
    results.push({ id, ok: r?.ok === true, detail: r?.detail ?? "", fix: r?.fix ?? null });
  }

  const failed = results.filter((r) => r.ok === false);
  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, connectors: results }, null, 1));
    return failed.length ? 1 : 0;
  }

  const width = Math.max(...results.map((r) => r.id.length));
  console.log("");
  console.log("  connector health");
  console.log("  " + "-".repeat(width + 34));
  for (const r of results) {
    const level = r.ok === null ? "SKIP" : r.ok ? "OK" : "FAIL";
    console.log(`  ${level.padEnd(4)}  ${r.id.padEnd(width)}  ${r.detail}`);
    if (r.fix) console.log(`  ${" ".repeat(4)}  ${" ".repeat(width)}  -> ${r.fix}`);
  }
  console.log("  " + "-".repeat(width + 34));
  console.log(
    failed.length
      ? `  ${failed.length} connector(s) could not answer. Each line above says the one thing to do.`
      : "  every enabled connector answered.",
  );
  console.log("");
  return failed.length ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`health-check: ${e.message}`);
    process.exitCode = 1;
  });
