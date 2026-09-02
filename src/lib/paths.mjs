// paths.mjs - where things live, and how the command line may move them.
//
// Every CLI in this repo answers the same three questions before it does
// anything: which config, which data directory, which output file. Answering
// them in one place is what makes two other things possible:
//
//   * demo mode - `scripts/demo.mjs` points the whole pipeline at
//     `fixtures/demo/` and a scratch directory, with no config.json and no
//     accounts anywhere;
//   * hermetic tests - a test can run the real script as a subprocess against a
//     `mkdtemp` directory instead of the user's live state.
//
// Nothing here touches the filesystem except to resolve a path. Reading is the
// caller's job, so an absent file stays the caller's decision rather than a
// throw from a path helper.
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: two levels up from this file (src/lib/paths.mjs). */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Read `--name <value>` or `--name=<value>` out of an argv slice.
 * Returns null when the flag is absent; returns null when it is present but
 * has nothing after it, so a caller can tell "not asked for" from "asked for
 * badly" only if it wants to - most callers just fall back to the default.
 */
export function argFlag(argv, name) {
  const long = `--${name}`;
  const eq = `${long}=`;
  const i = argv.findIndex((a) => a === long || a.startsWith(eq));
  if (i === -1) return null;
  const raw = argv[i].startsWith(eq) ? argv[i].slice(eq.length) : argv[i + 1];
  const value = String(raw ?? "").trim();
  return value && !value.startsWith("--") ? value : null;
}

/** True when a bare switch such as `--gaps` or `--dry-run` is present. */
export function argHas(argv, name) {
  return argv.includes(`--${name}`);
}

const under = (root, p) => (isAbsolute(p) ? p : resolve(root, p));

/**
 * The data directory for this run: `--data <dir>`, else `$AGENDA_DATA`, else
 * `<repoRoot>/data`. Relative paths resolve against the process working
 * directory the same way a shell would, which is what a user typing
 * `--data ./tmp` expects.
 */
export function dataDir(argv = [], root = repoRoot()) {
  const flag = argFlag(argv, "data") ?? (process.env.AGENDA_DATA || null);
  return flag ? under(process.cwd(), flag) : join(root, "data");
}

/**
 * The config file for this run: `--config <path>`, else `$AGENDA_CONFIG`, else
 * `<repoRoot>/config.json`. The file may not exist; `loadConfig` decides what
 * that means.
 */
export function configPath(argv = [], root = repoRoot()) {
  const flag = argFlag(argv, "config") ?? (process.env.AGENDA_CONFIG || null);
  return flag ? under(process.cwd(), flag) : join(root, "config.json");
}

/** The output file for a build step: `--out <path>`, else `<root>/<fallback>`. */
export function outPath(argv = [], root = repoRoot(), fallback = "agenda.html") {
  const flag = argFlag(argv, "out");
  return flag ? under(process.cwd(), flag) : join(root, fallback);
}

/**
 * The one clock a run uses, for everything: which day is today, which hours of
 * it are already behind the user, and how far back a completion window reaches.
 * Taken once so the run is internally consistent, and overridable with
 * `--now <ISO>` (or `--now=<ISO>`) so a past run can be reproduced from its own
 * log line.
 *
 * A bad `--now` is a hard stop rather than a shrug: silently planning against
 * the real clock when the operator asked for another one would make the
 * diagnosis lie, and this is the one argument that changes what gets published.
 */
export function argNow(argv = [], label = "run") {
  const i = argv.findIndex((a) => a === "--now" || a.startsWith("--now="));
  if (i === -1) return new Date();
  const raw = argv[i].startsWith("--now=") ? argv[i].slice(6) : argv[i + 1];
  const at = new Date(String(raw ?? ""));
  if (!raw || Number.isNaN(at.getTime())) {
    console.error(`${label}: bad --now value: ${raw ?? "(missing)"} - expected an ISO instant`);
    process.exit(1);
  }
  return at;
}
