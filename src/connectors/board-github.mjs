#!/usr/bin/env node
/**
 * board-github.mjs - the side-project board.
 *
 * Pulls the open GitHub work a user owns outside their coursework into the same
 * pipeline, so project time gets planned next to homework instead of competing
 * with it silently.
 *
 * WHAT IT PULLS (config `sideProject`: {org, repos[], min/maxDailyMinutes})
 *   - open ISSUES in scope assigned to you or created by you
 *   - open PRs in scope authored by you or with a review requested from you
 * Scope is the whole org when `sideProject.repos` is empty, otherwise just
 * those repos.
 *
 * WHAT IT EMITS (and writes to data/board-items.json when run standalone)
 *   {"generatedAt": ISO, "source": "github",
 *    "board": [BoardEntry],   // UNDATED open work, newest-updated first, capped
 *    "items": [Item]}         // only entries with a REAL deadline
 *
 * A "REAL deadline" is one of exactly two things, because this connector never
 * invents one:
 *   1. a GitHub milestone due date (milestone.dueOn), or
 *   2. an explicit deadline written in the title ("due 2026-09-15",
 *      "deadline Sep 15", "due by 9/15"). A cue word is REQUIRED; a bare date
 *      in a title is treated as undated board work.
 * Everything else stays on the board with no date attached. Guessing here would
 * put a fictional deadline on the user's calendar, which is worse than nothing.
 *
 * COST: 2 `gh` invocations total (resolve the login, then ONE GraphQL request
 * with four aliased searches). The whole run is capped at a wall-clock budget
 * (`connectors.board.github.budgetMs`, default 60 s) because a hung network
 * call must never hold up the rest of the agenda.
 *
 * USAGE (standalone; it is also a registry connector - see collect() below)
 *   node src/connectors/board-github.mjs            # write data/board-items.json
 *   node src/connectors/board-github.mjs --dry-run  # print the JSON, write nothing
 *
 * EXIT CODES (the pipeline depends on these)
 *   0  OK - file written (or printed under --dry-run).
 *   3  SKIP - gh is missing, unauthenticated, out of budget, or GitHub is
 *      unreachable. The reason is printed and any existing data/board-items.json
 *      is left EXACTLY as it was. The pipeline logs board=SKIPPED and carries
 *      on; a GitHub outage is never allowed to fail an agenda run.
 *   1  ERROR - a real fault on our side: unusable config, a malformed GraphQL
 *      query, or the output file could not be written.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normTitle } from "../merge.mjs";
import { derive, loadConfig } from "../lib/config.mjs";
import { dataDir as resolveDataDir, repoRoot } from "../lib/paths.mjs";

export const meta = {
  id: "board-github",
  kind: "board",
  label: "GitHub (side-project board)",
  configPath: "connectors.board.github",
  requires: { os: [], bin: ["gh"], mcp: [], app: ["GitHub CLI, authenticated (`gh auth login`)"] },
  // Tier 2: a local tool plus a token of its own. There IS a hosted GitHub MCP
  // server, and this connector deliberately does not use it - everything here
  // goes through `gh`, which the user has already authenticated once.
  tier: 2,
};

/**
 * Two switches, on purpose.
 *
 * `sideProject.enabled` is the feature: it decides whether the planner reserves
 * time for a side project at all. `connectors.board.github.enabled` is the
 * source: it decides where that project's work comes from. Turning the source
 * on while the feature is off produced a board full of issues that no block was
 * ever planned for - visible work with nowhere to do it - so both must be on.
 */
export function isEnabled(cfg) {
  return cfg?.sideProject?.enabled === true && cfg?.connectors?.board?.github?.enabled === true;
}

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_SKIP = 3;

export const DEFAULT_BUDGET_MS = 60000;
const MIN_CALL_BUDGET_MS = 2000;
const LOGIN_TIMEOUT_MS = 20000;
const BOARD_CAP = 15;
const SEARCH_PAGE = 50;
const BUCKET_COURSE_ID = 0;

/** gh could not give us an answer. Recoverable: the pipeline skips the board. */
class GhUnavailable extends Error {}
/** Our own fault: bad config, bad query, unwritable output. */
class RealError extends Error {}

// ---------------------------------------------------------------- utilities

/**
 * The wall-clock budget for one run, as a closure rather than module state, so
 * that a caller running this twice in one process (a health check, then a
 * collect) gets a fresh budget each time instead of an already-spent one.
 */
function budget(totalMs) {
  const startedAt = Date.now();
  const remainingMs = () => totalMs - (Date.now() - startedAt);
  return {
    remainingMs,
    /** Clamp one call to whatever is left of the run budget. */
    forCall(cap) {
      const left = remainingMs();
      if (left < MIN_CALL_BUDGET_MS) {
        throw new GhUnavailable("ran out of the " + totalMs + " ms budget before finishing");
      }
      return Math.min(cap, left);
    },
  };
}

function runGh(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (err.code === "ENOENT") {
          return reject(new GhUnavailable("gh CLI not found on PATH"));
        }
        if (err.killed || err.signal) {
          return reject(new GhUnavailable("gh timed out after " + timeoutMs + " ms"));
        }
        const detail = String(stderr || err.message || "")
          .trim()
          .split(/\r?\n/)
          .slice(0, 3)
          .join(" | ");
        return reject(new GhUnavailable("gh exited with code " + err.code + ": " + detail));
      },
    );
  });
}

// ------------------------------------------------------------------- config

/**
 * The three things this connector needs out of the loaded config, validated.
 *
 * `org` and every entry of `repos` are interpolated straight into a GitHub
 * search qualifier, so they are checked against a strict character class here
 * rather than trusted: a value with a space in it would silently widen the
 * search instead of failing.
 */
export function boardScope(cfg) {
  const sideProject = cfg && cfg.sideProject;
  if (!sideProject || typeof sideProject !== "object") {
    throw new RealError('the config has no "sideProject" section');
  }
  const org = typeof sideProject.org === "string" ? sideProject.org.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(org)) {
    throw new RealError(
      "sideProject.org is not set to a usable GitHub org or user name: " + JSON.stringify(sideProject.org),
    );
  }
  const repos = Array.isArray(sideProject.repos)
    ? sideProject.repos.filter((r) => typeof r === "string" && r.trim() !== "").map((r) => r.trim())
    : [];
  for (const repo of repos) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(repo)) {
      throw new RealError("sideProject.repos contains an unusable repo name: " + JSON.stringify(repo));
    }
  }
  return { org, repos };
}

/** Repeated repo:/org: qualifiers OR together in GitHub search. */
function scopeQualifier(config) {
  if (config.repos.length === 0) return "org:" + config.org;
  return config.repos
    .map((r) => (r.includes("/") ? "repo:" + r : "repo:" + config.org + "/" + r))
    .join(" ");
}

// -------------------------------------------------------------- github pull

const SEARCH_QUERY = [
  "query($qIssueAssigned:String!,$qIssueAuthored:String!,$qPrAuthored:String!,$qPrReview:String!,$n:Int!){",
  "  issueAssigned: search(query:$qIssueAssigned, type:ISSUE, first:$n){ nodes{ ...Work } }",
  "  issueAuthored: search(query:$qIssueAuthored, type:ISSUE, first:$n){ nodes{ ...Work } }",
  "  prAuthored:    search(query:$qPrAuthored,    type:ISSUE, first:$n){ nodes{ ...Work } }",
  "  prReview:      search(query:$qPrReview,      type:ISSUE, first:$n){ nodes{ ...Work } }",
  "}",
  "fragment Work on SearchResultItem {",
  "  __typename",
  "  ... on Issue {",
  "    number title url updatedAt",
  "    repository { nameWithOwner }",
  "    milestone { title dueOn }",
  "  }",
  "  ... on PullRequest {",
  "    number title url updatedAt isDraft",
  "    repository { nameWithOwner }",
  "    milestone { title dueOn }",
  "  }",
  "}",
].join("\n");

const SEARCH_ALIASES = ["issueAssigned", "issueAuthored", "prAuthored", "prReview"];

async function resolveLogin(clock) {
  const out = await runGh(["api", "user", "--jq", ".login"], clock.forCall(LOGIN_TIMEOUT_MS));
  const login = out.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login)) {
    throw new GhUnavailable("gh did not return a usable GitHub login (not authenticated?)");
  }
  return login;
}

function buildQueries(scope, login) {
  const base = scope + " is:open archived:false";
  return {
    issueAssigned: base + " is:issue assignee:" + login,
    issueAuthored: base + " is:issue author:" + login,
    prAuthored: base + " is:pr author:" + login,
    prReview: base + " is:pr review-requested:" + login,
  };
}

async function fetchWork(queries, clock, warn) {
  const args = ["api", "graphql", "-f", "query=" + SEARCH_QUERY, "-F", "n=" + SEARCH_PAGE];
  for (const alias of SEARCH_ALIASES) {
    args.push("-f", "q" + alias.charAt(0).toUpperCase() + alias.slice(1) + "=" + queries[alias]);
  }

  const stdout = await runGh(args, clock.forCall(clock.remainingMs()));
  let body;
  try {
    body = JSON.parse(stdout);
  } catch (err) {
    throw new GhUnavailable("gh returned output that is not JSON: " + err.message);
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const msgs = body.errors.map((e) => (e && e.message) || String(e)).join(" | ");
    // Partial data still beats nothing; a total failure means our query is wrong.
    if (!body.data) throw new RealError("GraphQL query rejected: " + msgs);
    warn("partial GraphQL result: " + msgs);
  }
  const data = body.data || {};
  const byUrl = new Map();
  for (const alias of SEARCH_ALIASES) {
    const nodes = (data[alias] && data[alias].nodes) || [];
    for (const node of nodes) {
      if (!node || typeof node.url !== "string") continue;
      if (!byUrl.has(node.url)) byUrl.set(node.url, node);
    }
  }
  return [...byUrl.values()];
}

// ---------------------------------------------------------- deadline parsing

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_ALT = Object.keys(MONTHS).join("|");
const DATE_ALT = [
  "(?<iso>\\d{4}-\\d{1,2}-\\d{1,2})",
  "(?<num>\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)",
  "(?<mdy>(?:" + MONTH_ALT + ")[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?)",
  "(?<dmy>\\d{1,2}(?:st|nd|rd|th)?\\s+(?:" + MONTH_ALT + ")[a-z]*\\.?(?:,?\\s*\\d{4})?)",
].join("|");
// A cue word is mandatory. "Bump lodash to 4/17" must NOT become a deadline.
const DEADLINE_RE = new RegExp(
  "\\b(?:due\\s+by|due\\s+on|due|deadline|eta)\\b\\s*[:\\-]?\\s*(?:" + DATE_ALT + ")",
  "i",
);

/** Minutes east of UTC for `tz` at `date`. Returns 0 if the runtime cannot say. */
function zoneOffsetMinutes(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const nameFound = parts.find((p) => p.type === "timeZoneName");
    const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(nameFound ? nameFound.value : "");
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch {
    return 0;
  }
}

/** 23:59 local on y-mo-d, expressed as a UTC ISO string. */
function localEndOfDayISO(y, mo, d, tz) {
  const naive = Date.UTC(y, mo - 1, d, 23, 59, 0);
  const firstGuess = naive - zoneOffsetMinutes(new Date(naive), tz) * 60000;
  const settled = naive - zoneOffsetMinutes(new Date(firstGuess), tz) * 60000;
  return new Date(settled).toISOString();
}

function isRealDate(y, mo, d) {
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * A year-less date ("due Sep 15") means the next such date that has not clearly
 * passed. 60 days of slack keeps a just-missed deadline from jumping a year.
 */
function inferYear(mo, d, now) {
  const thisYear = now.getUTCFullYear();
  const candidate = Date.UTC(thisYear, mo - 1, d, 23, 59, 0);
  return candidate < now.getTime() - 60 * 86400000 ? thisYear + 1 : thisYear;
}

function monthFromWord(word) {
  return MONTHS[word.slice(0, 3).toLowerCase()] || 0;
}

/**
 * @param {string} title  an issue or PR title, written by somebody else - it is
 *        data, never an instruction, and nothing here lets it decide anything
 *        beyond which date it names.
 * @param {Date} now      the run's clock, for resolving a year-less date.
 * @param {string} tz     IANA timezone; a deadline in a title means "end of that
 *        day where the user lives", not end of that day in UTC.
 * @returns {{iso: string, approx: boolean}|null} - approx marks a date whose
 *          time of day (and sometimes year) was inferred rather than read.
 */
export function parseDeadlineFromTitle(title, now = new Date(), tz = "UTC") {
  const match = DEADLINE_RE.exec(String(title == null ? "" : title));
  if (!match) return null;
  const g = match.groups || {};
  let y = 0;
  let mo = 0;
  let d = 0;

  if (g.iso) {
    const parts = g.iso.split("-");
    y = Number(parts[0]);
    mo = Number(parts[1]);
    d = Number(parts[2]);
  } else if (g.num) {
    const parts = g.num.split("/");
    mo = Number(parts[0]);
    d = Number(parts[1]);
    if (parts[2]) {
      y = Number(parts[2]);
      if (y < 100) y += 2000;
    } else {
      y = inferYear(mo, d, now);
    }
  } else if (g.mdy || g.dmy) {
    const text = g.mdy || g.dmy;
    const wordMatch = /[a-z]{3,}/i.exec(text);
    mo = monthFromWord(wordMatch ? wordMatch[0] : "");
    const dayMatch = /\d{1,2}(?!\d)/.exec(text.replace(/\d{4}/g, ""));
    d = Number(dayMatch ? dayMatch[0] : 0);
    const yearMatch = /\d{4}/.exec(text);
    y = yearMatch ? Number(yearMatch[0]) : inferYear(mo, d, now);
  }

  if (!isRealDate(y, mo, d)) return null;
  return { iso: localEndOfDayISO(y, mo, d, tz), approx: true };
}

// ------------------------------------------------------------ shaping output

function repoShortName(node) {
  const full = (node && node.repository && node.repository.nameWithOwner) || "";
  return full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
}

function kindOf(node) {
  return node.__typename === "PullRequest" ? "pr" : "issue";
}

/** null when the work carries no real deadline. */
export function deadlineOf(node, now, tz) {
  const dueOn = node && node.milestone && node.milestone.dueOn;
  if (typeof dueOn === "string" && !Number.isNaN(Date.parse(dueOn))) {
    return { iso: new Date(dueOn).toISOString(), approx: false };
  }
  const parsed = parseDeadlineFromTitle(node && node.title, now, tz);
  return parsed || null;
}

function toBoardEntry(node) {
  return {
    repo: repoShortName(node),
    n: node.number,
    t: node.title,
    kind: kindOf(node),
    u: node.url,
    upd: node.updatedAt,
  };
}

/**
 * GitHub never tells us whether a piece of work is "submitted" - the concept
 * does not exist there - so `submitted` is always null. Null is "unknown", and
 * unknown is the truth here.
 */
function toItem(node, deadline, bucket) {
  return {
    courseId: BUCKET_COURSE_ID,
    course: bucket,
    title: node.title,
    due: deadline.iso,
    type: "task",
    submitted: null,
    approx: deadline.approx === true,
    sources: ["github"],
    url: node.url,
  };
}

/**
 * Split the pulled work into a board (undated) and items (dated), in the
 * emission shapes the registry validates.
 *
 * @param {object[]} nodes  GraphQL search results
 * @param {Date} now
 * @param {{tz: string, bucket: string, boardCap?: number}} opts
 */
export function buildPayload(nodes, now, opts = {}) {
  const tz = opts.tz || "UTC";
  const bucket = opts.bucket || "Side Project";
  const cap = Number.isFinite(opts.boardCap) ? opts.boardCap : BOARD_CAP;

  const dated = [];
  const undated = [];
  for (const node of nodes) {
    const deadline = deadlineOf(node, now, tz);
    if (deadline) dated.push({ node, deadline });
    else undated.push(node);
  }

  const board = undated
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .slice(0, cap)
    .map(toBoardEntry);

  // One key per deliverable: if two issues normalize to the same key, the
  // earlier deadline is the one that actually constrains the calendar. The key
  // is built with merge.mjs's normTitle so it matches every other source
  // exactly - a mismatch here would show the same task twice after the merge.
  const byKey = new Map();
  for (const entry of dated) {
    const item = toItem(entry.node, entry.deadline, bucket);
    const key = BUCKET_COURSE_ID + "::task::" + normTitle(item.title);
    const existing = byKey.get(key);
    if (!existing || Date.parse(item.due) < Date.parse(existing.due)) byKey.set(key, item);
  }
  const items = [...byKey.values()].sort((a, b) => Date.parse(a.due) - Date.parse(b.due));

  return {
    payload: { generatedAt: now.toISOString(), source: "github", board, items },
    stats: {
      total: nodes.length,
      dated: dated.length,
      undated: undated.length,
      dropped: Math.max(0, undated.length - board.length),
    },
  };
}

/**
 * Pretty JSON with every non-ASCII character escaped as \uXXXX. GitHub titles
 * carry em dashes and Portuguese accents; the repo's data files are all plain
 * ASCII, and \u escapes keep them that way without losing a single character
 * (any JSON parser reconstitutes the original title exactly).
 */
function toAsciiJson(value) {
  const raw = JSON.stringify(value, null, 2);
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    out += code < 128 ? raw[i] : "\\u" + code.toString(16).padStart(4, "0");
  }
  return out;
}

// -------------------------------------------------------------------- report

function summarize(nodes, payload, stats, cap) {
  const lines = [];
  const perRepo = new Map();
  for (const node of nodes) {
    const repo = repoShortName(node);
    const cur = perRepo.get(repo) || { issue: 0, pr: 0 };
    perRepo.set(repo, { ...cur, [kindOf(node)]: cur[kindOf(node)] + 1 });
  }
  lines.push(
    "board: " + stats.total + " open item(s) - " + payload.board.length + " on board, " +
      payload.items.length + " with a real deadline" +
      (stats.dropped > 0 ? ", " + stats.dropped + " beyond the board cap of " + cap : ""),
  );
  for (const entry of [...perRepo.entries()].sort()) {
    lines.push("board:   " + entry[0] + ": " + entry[1].issue + " issue(s), " + entry[1].pr + " PR(s)");
  }
  for (const item of payload.items) {
    lines.push("board:   deadline " + item.due + " - " + item.title);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ the pull

/**
 * The whole GitHub round trip, shared by `collect()` and the standalone CLI.
 * Throws GhUnavailable (recoverable, skip) or RealError (our fault).
 */
async function pull({ cfg, now, bucket, budgetMs, warn }) {
  const scope = boardScope(cfg);
  const clock = budget(budgetMs);
  const login = await resolveLogin(clock);
  const nodes = await fetchWork(buildQueries(scopeQualifier(scope), login), clock, warn);
  return { nodes, ...buildPayload(nodes, now, { tz: cfg.timezone || "UTC", bucket }) };
}

// -------------------------------------------------------- registry connector

export async function collect(ctx) {
  const budgetMs = Number(ctx.cfg?.connectors?.board?.github?.budgetMs) || DEFAULT_BUDGET_MS;
  const bucket = ctx.derived?.sideBucket || "Side Project";
  try {
    const built = await pull({
      cfg: ctx.cfg,
      now: ctx.now,
      bucket,
      // Never outlive the registry's own deadline for this connector.
      budgetMs: Math.max(MIN_CALL_BUDGET_MS, Math.min(budgetMs, ctx.deadline - Date.now())),
      warn: (msg) => ctx.log("warn", meta.id + ": " + msg),
    });
    return { board: built.payload.board, items: built.payload.items, errors: [] };
  } catch (err) {
    // A GitHub outage is never allowed to fail an agenda run: one line, and the
    // rest of the week still gets planned.
    const why = err && err.message ? err.message : String(err);
    return { board: [], items: [], errors: [meta.id + ": " + why.slice(0, 200)] };
  }
}

export async function healthCheck(ctx) {
  const fix = "run `gh auth login`, then set sideProject.org in config.json";
  try {
    boardScope(ctx.cfg);
  } catch (err) {
    return { ok: false, detail: err.message, fix: "set sideProject.org (and optionally sideProject.repos) in config.json" };
  }
  try {
    const login = await resolveLogin(budget(LOGIN_TIMEOUT_MS));
    return { ok: true, detail: "authenticated to GitHub as " + login, fix: null };
  } catch (err) {
    return { ok: false, detail: (err && err.message ? err.message : String(err)).slice(0, 200), fix };
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const root = repoRoot();
  const cfg = loadConfig(null, { argv });
  const outPath = path.join(resolveDataDir(argv, root), "board-items.json");

  const built = await pull({
    cfg,
    now: new Date(),
    bucket: derive(cfg).sideBucket,
    budgetMs: Number(cfg.connectors?.board?.github?.budgetMs) || DEFAULT_BUDGET_MS,
    warn: (msg) => process.stdout.write("board: WARN " + msg + "\n"),
  });
  const json = toAsciiJson(built.payload) + "\n";
  const report = summarize(built.nodes, built.payload, built.stats, BOARD_CAP);

  if (dryRun) {
    process.stdout.write(json);
    process.stdout.write(report + "\nboard: dry run, nothing written\n");
    return;
  }
  try {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, json, "utf8");
  } catch (err) {
    throw new RealError("cannot write " + outPath + ": " + err.message);
  }
  process.stdout.write(report + "\nboard: wrote " + outPath + "\n");
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    () => {
      process.exitCode = EXIT_OK;
    },
    (err) => {
      if (err instanceof GhUnavailable) {
        process.stdout.write("board: SKIPPED - " + err.message + "\n");
        process.stdout.write("board: the existing board-items.json is left untouched\n");
        process.exitCode = EXIT_SKIP;
        return;
      }
      process.stderr.write("board: ERROR - " + (err && err.message ? err.message : String(err)) + "\n");
      process.exitCode = EXIT_ERROR;
    },
  );
}
