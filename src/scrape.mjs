// scrape.mjs - run every enabled source, merge what they say, write the snapshot.
//
// This file owns two things and delegates everything else:
//
//   1. THE REGISTRY RUN. Load the config, ask `connectors/index.mjs` which
//      sources are enabled and satisfiable on this machine, give each one a
//      context and a deadline, and concatenate what comes back. A connector
//      that throws contributes one errors[] line and nothing more. The only
//      hard requirement in the whole pipeline is that at least ONE learning-
//      management source is enabled - with none, there is no agenda to build,
//      and the run says so in one sentence instead of a stack trace.
//
//   2. THE MERGE CHAIN, in this exact order:
//
//        dedupe -> reconcileApprox -> collapseCalendarTwins -> applyGrades
//        -> applyGradescopeStatus
//
//      The order is load-bearing. Grades are applied LAST, after the twin
//      collapse: a grade is item-level truth and must not feed the "which twin
//      is corroborated" vote, because it would corroborate both of them and the
//      ghost would survive.
//
// A REAL INCIDENT THIS FILE STILL CARRIES THE SCARS OF: a course whose content
// tree the connector could not read produced a per-course error every run, and
// because it was a course the user had told us to skip, the error was pure
// noise that trained everyone to ignore the error list. Skipped courses are
// therefore filtered out of the report, not out of the sweep - the data is
// still there if anything else wants it.
//
// Usage:
//   node src/scrape.mjs [--config <path>] [--data <dir>] [--now <ISO>]
//
// Exit codes: 0 ok · 1 error · 2 authentication failure (session expired).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, derive } from "./lib/config.mjs";
import { argNow, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";
import { connect } from "./lib/mcp-client.mjs";
import { applyGradescopeStatus, loadGradescopeAssignments } from "./completion.mjs";
import {
  applyGrades,
  collapseCalendarTwins,
  dedupe,
  diffSnapshots,
  gradeIndex,
  reconcileApprox,
} from "./merge.mjs";
import { hasLmsSource, runSource, sources } from "./connectors/index.mjs";

/** How long one connector gets before the run stops waiting for it. */
export const PER_CONNECTOR_MS = 180000;

/** Auth failures read the same from every layer of this stack. */
export const isAuthError = (e) => /401|auth|session|expired|unauthorized/i.test(String(e?.message ?? ""));

/**
 * Read `.mcp.json` so a connector can ask for a server by the same key the
 * user's editor uses. Absent or unreadable is not fatal - a connector that
 * needs a server it cannot find will say so itself, with a better message than
 * this function could write.
 */
export function readMcpServers(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"));
    return raw?.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** The context every connector receives. Pure construction; nothing runs here. */
export function makeContext({ cfg, root, dataDir, now, deadline, servers, log }) {
  return {
    cfg,
    derived: derive(cfg),
    now,
    root,
    dataDir,
    deadline,
    log: log ?? ((level, msg) => (level === "error" ? console.error(msg) : console.log(msg))),
    async mcp(key) {
      const entry = servers[key];
      if (!entry) {
        throw new Error(`no MCP server named "${key}" in .mcp.json - see docs/SETUP.md`);
      }
      return connect({ command: entry.command, args: entry.args ?? [], env: entry.env, cwd: root });
    },
    // Never put a secret in argv: it is visible to every other process on the
    // machine. Anything sensitive goes on stdin, which is what the connectors
    // that need one actually do.
    exec(bin, args, opts = {}) {
      return execFileSync(bin, args, { timeout: opts.timeout ?? 120000, encoding: "utf-8", ...opts });
    },
    // The global fetch, handed over rather than reached for, so a connector that
    // talks to a REST API can be tested against recorded responses without a
    // network. A token belongs in a header this function sends, never in a URL.
    fetch: globalThis.fetch,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const root = repoRoot();
  const cfg = loadConfig(null, { argv });
  const derived = derive(cfg);
  const dataDir = resolveDataDir(argv, root);
  const now = argNow(argv, "scrape");

  if (!hasLmsSource(cfg)) {
    console.error(
      "scrape: no LMS source is enabled.\n" +
        "  Every other source is optional; this one is not - without it there is\n" +
        "  nothing to build an agenda from.\n" +
        "  Fix: set connectors.lms.<provider>.enabled to true in config.json,\n" +
        "  or add a source of your own - docs/EXTENDING.md walks through it.",
    );
    process.exit(1);
  }
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const servers = readMcpServers(root);
  const enabled = sources(cfg);
  const collected = { items: [], mail: [], announcements: [], board: [], grades: [], errors: [] };

  for (const mod of enabled) {
    const ctx = makeContext({
      cfg,
      root,
      dataDir,
      now,
      deadline: Date.now() + PER_CONNECTOR_MS,
      servers,
    });
    let out;
    try {
      out = await runSource(mod, ctx, { mcpServers: Object.keys(servers) });
    } catch (e) {
      // runSource catches everything a connector can throw. The one exception
      // that must still reach here is an expired session: retrying three more
      // sources against dead credentials produces three confusing errors
      // instead of one actionable one.
      if (isAuthError(e)) {
        writeFileSync(
          join(dataDir, "auth-failure.json"),
          JSON.stringify({ at: now.toISOString(), connector: mod.meta?.id ?? "?", error: e.message }, null, 1),
        );
        console.error("AUTH FAILURE - run: node scripts/reauth.mjs");
        process.exit(2);
      }
      throw e;
    }
    for (const key of Object.keys(collected)) collected[key] = collected[key].concat(out[key]);
  }

  // Caches an agent maintains between runs: schedules it parsed out of a
  // syllabus, tasks it lifted out of mail. Both are ordinary items[] once read.
  for (const [cache, src] of [
    ["parsed-items.json", "syllabus"],
    ["outlook-items.json", "outlook"],
  ]) {
    const cachePath = join(dataDir, cache);
    if (!existsSync(cachePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
      for (const x of parsed.items ?? []) {
        if (!x?.due || !x?.title) continue;
        const at = new Date(x.due);
        if (Number.isNaN(at.getTime())) continue;
        collected.items.push({
          courseId: x.courseId ?? 0,
          course: x.course ?? "Mail",
          title: String(x.title).trim(),
          due: at.toISOString(),
          type: x.type ?? "task",
          sources: [src],
          submitted: x.submitted ?? null,
          approx: x.approx ?? false,
          url: x.url ?? null,
        });
      }
    } catch (e) {
      collected.errors.push(`${cache}: ${String(e.message).slice(0, 200)}`);
    }
  }

  // Grades, indexed the way merge.applyGrades wants them.
  const gradesByCourse = new Map();
  for (const g of collected.grades) {
    const rows = gradesByCourse.get(g.courseId) ?? [];
    rows.push({ name: g.title, displayGrade: g.display, pointsNumerator: g.numeric });
    gradesByCourse.set(g.courseId, rows);
  }
  const gradeIdx = new Map([...gradesByCourse].map(([id, rows]) => [id, gradeIndex(rows)]));

  const items = applyGradescopeStatus(
    applyGrades(collapseCalendarTwins(reconcileApprox(dedupe(collected.items))), gradeIdx),
    loadGradescopeAssignments(dataDir),
  );

  // Errors about courses the user asked us to skip are noise, and noise is how
  // a real error gets ignored. The sweep still happened; only the report is
  // filtered.
  const reportable = collected.errors.filter(
    (e) => ![...derived.skipCodes].some((code) => code && String(e).includes(code)),
  );

  const snapshot = {
    scrapedAt: now.toISOString(),
    items,
    announcements: collected.announcements.sort((a, b) => String(b.posted).localeCompare(String(a.posted))),
    errors: reportable,
  };

  const latestPath = join(dataDir, "latest.json");
  const prev = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, "utf-8")) : null;
  if (prev) copyFileSync(latestPath, join(dataDir, "previous.json"));
  writeFileSync(latestPath, JSON.stringify(snapshot, null, 1));
  writeFileSync(join(dataDir, "diff.json"), JSON.stringify(diffSnapshots(prev, snapshot), null, 1));

  if (collected.mail.length) {
    writeFileSync(join(dataDir, "outlook-mail.json"), JSON.stringify({ mail: collected.mail }, null, 1));
  }
  if (collected.board.length) {
    const boardPath = join(dataDir, "board-items.json");
    const existing = existsSync(boardPath) ? JSON.parse(readFileSync(boardPath, "utf-8")) : {};
    writeFileSync(
      boardPath,
      JSON.stringify({ ...existing, board: collected.board }, null, 1),
    );
  }

  console.log(
    `OK: ${items.length} items, ${snapshot.announcements.length} announcements, ` +
      `${enabled.length} source(s), ${reportable.length} source error(s)`,
  );
  if (reportable.length) console.log("source errors:\n- " + reportable.join("\n- "));
}

// Run only when this file is the entry point, so a test may import makeContext
// and readMcpServers without kicking off a live sweep.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  });
}
