// demo.mjs - a complete agenda, from made-up data, with no accounts at all.
//
// WHY THIS EXISTS AND WHY IT MATTERS MORE THAN IT LOOKS
//
// Setting this repository up means connecting a school account through a
// browser login and a two-factor push. That is the longest, most fragile step,
// and it is the first thing a new user would otherwise hit. If it goes wrong
// they have seen nothing, so they have no idea what they are debugging towards.
//
// Demo mode moves the first success to the front. It renders the whole product
// - four courses, a week of study blocks, mail, a side-project board, the
// standards card, done and cancelled marks - from `fixtures/demo/`, in about a
// second, with no config.json, no MCP approval and no account of any kind.
// After this the user knows exactly what they are being asked to log in FOR.
//
// It is also the pipeline's own smoke test. Demo mode exercises the real
// `src/render.mjs`, the real planner and the real envelope code; if it breaks,
// something downstream is genuinely broken.
//
// TWO RULES IT MUST KEEP
//
//   1. It writes NOTHING into `data/` and reads NO config.json. The fixtures are
//      copied into a scratch directory first, so a user who already has a real
//      agenda can run the demo without touching a byte of their own state.
//   2. It is byte-reproducible. The clock is fixed, so two runs produce
//      identical output and the difference between them can be diffed.
//
// Usage:
//   node scripts/demo.mjs [--out <file>] [--now <ISO>] [--keep]
import { cpSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { argFlag, argHas, outPath, repoRoot } from "../src/lib/paths.mjs";

// Monday 09:00 in the demo timezone. Fixed on purpose: a demo whose output
// moves with the wall clock cannot be diffed, and a screenshot of it goes stale
// the moment it is taken.
export const DEMO_NOW = "2026-09-14T13:00:00.000Z";

const argv = process.argv.slice(2);
const root = repoRoot();
const fixtures = join(root, "fixtures", "demo");
const out = outPath(argv, root, "demo-agenda.html");
const now = argFlag(argv, "now") ?? DEMO_NOW;

if (!existsSync(join(fixtures, "config.demo.json"))) {
  console.error(`demo: ${fixtures} is missing - this checkout is incomplete.`);
  process.exit(1);
}

// The scratch copy is the whole reason this is safe to run at any time.
const scratch = mkdtempSync(join(tmpdir(), "agenda-demo-"));
try {
  cpSync(join(fixtures, "data"), scratch, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      join(root, "src", "render.mjs"),
      "--config",
      join(fixtures, "config.demo.json"),
      "--data",
      scratch,
      "--out",
      out,
      "--now",
      now,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );

  // The render's own "next command" hints are written for a configured repo
  // pointed at real data. Demo mode's data lives in a scratch directory that is
  // deleted three lines below, so forwarding them hands the user - or the agent
  // reading this output - a command that cannot work. Everything else the render
  // says is true here and passes straight through.
  if (result.stdout) {
    process.stdout.write(
      result.stdout
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("run `node src/render.mjs --gaps"))
        .join("\n"),
    );
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error("\ndemo: the render failed. Nothing was written outside the scratch directory.");
    process.exit(result.status ?? 1);
  }

  console.log(
    `\nThat is a complete agenda, built from made-up data: four courses, a week of\n` +
      `study blocks, mail, a side-project board. Open it in a browser:\n\n` +
      `  ${out}\n\n` +
      `Everything you see there becomes your real week once a source is connected.\n` +
      `Live refresh will say it is unavailable - that part needs the published page.`,
  );
} finally {
  if (!argHas(argv, "keep")) rmSync(scratch, { recursive: true, force: true });
  else console.log(`\ndemo: scratch data kept at ${scratch}`);
}
