// pipeline-steps.mjs - the two step tables of the daily run.
//
// PURPOSE. Every mechanical thing the daily run does lives here as one entry in
// PHASE1 (fetch and ingest, before the model) or PHASE2 (render, publish,
// watchdogs, after it). A step is `{ name, run(ctx) }` returning
// `{ token?, tokens?, state?, out?, exit? }`: `token` is this step's runlog token
// (keyed by the step name), `tokens` several at once (only `scrape`, which also
// settles `reauth`), `state` a NEW run state for the next step, `out` anything a
// later step needs. Nothing throws past its own step: `runPhase` in
// `src/pipeline.mjs` turns a throw into `<name>=FAILED(...)`, because one broken
// step must never cost the run the steps after it.
//
// WHAT IT READS AND WRITES. Nothing directly: every file goes through `ctx.fs`
// and every child through `ctx.spawn`, both injected, so `test/pipeline.test.mjs`
// exercises the whole table with no disk, no network and no subprocess. A step is
// spawned as `[process.execPath, "src/<script>.mjs", ...]` with the run's own
// `--config` / `--data` flags appended, so demo mode and a hermetic test reach it.
//
// CLI: none - imported by `src/pipeline.mjs` and the tests. No exit codes.
//
// IMPORT CYCLE: this file imports two names from `src/pipeline.mjs`, which
// imports PHASE1/PHASE2 from here. Safe: neither reads the other's bindings
// during evaluation - both uses are inside a `run()`. What they share lives in
// `pipeline-workorder.mjs`, which imports neither.

import { buildReport, serializeRunState } from "./pipeline.mjs";
import { derive } from "./lib/config.mjs";
import {
  buildWorkOrder, calendarCounts, clip, collectWorkOrderData, detail, dpath, findLine, iso, lastLine,
  paren, parseGaps, parseIngest, parseJson, parsePull, phrase, readJson, readText, summaryLine, unprefix,
} from "./pipeline-workorder.mjs";

// Re-exported: they live below the cycle, with the rest of the text helpers.
export { calendarCounts, parseGaps, parseIngest, parsePull } from "./pipeline-workorder.mjs";

// ----------------------------------------------------------- constants
// A scrape may wait on a browser login; re-auth waits on a second factor a human
// answers from another room. Everything else gets the flat three minutes.
export const TIMEOUT = Object.freeze({ scrape: 720000, materials: 900000, reauth: 360000, default: 180000 });

// `scripts/reauth.mjs --silent`, exactly as AGENTS.md documents it. Exit 3 is
// absent on purpose - that script never returns it, so it stays a plain failure.
const REAUTH_TOKENS = Object.freeze({
  0: "reauth=ok", 1: "reauth=FAILED", 2: "reauth=NO-CREDS", 4: "reauth=USAGE",
  5: "reauth=BAD-CREDS", 6: "reauth=MFA-PENDING", 7: "reauth=NO-PACKAGE",
});

/** exit code -> the `reauth=` token. Anything unmapped is a plain failure. */
export const reauthMap = (exit) => REAUTH_TOKENS[exit] ?? "reauth=FAILED";

// `command-ingest.mjs`: 0 applied, 5 refused, 4 stale, else error. Only the two settled verdicts are consumed; the rest are LEFT in Drive.
const CMD_OUTCOME = Object.freeze({ 0: "applied", 5: "refused", 4: "stale" });

/** The `OK: <summary>` line `scrape.mjs` and `materials-sync.mjs` each print. */
export const OK_LINE = /^OK: /;

// Every config gate is `=== true`, never a truthy test: a key a user has not
// written yet arrives as null or undefined, and "undefined is not false" is how
// an optional connector switches itself on by accident.
const on = (ctx, ...keys) => keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), ctx.cfg) === true;
const driveOn = (ctx) => on(ctx, "drive", "enabled");
const standardsOn = (ctx) => on(ctx, "standardsPlan", "enabled");

/** The four Drive titles for this namespace (`derive().docTitles`). */
const docTitle = (ctx, key) => (ctx.titles ?? derive(ctx.cfg ?? {}).docTitles)[key];

/** Spawn one step, with the run's own `--config` / `--data` flags appended. */
export const spawnStep = (ctx, argv, opts = {}) => ctx.spawn([...argv, ...(ctx.passthrough ?? [])], opts);

// ----------------------------------------------- the token builders
/** `behind.mjs --check` verdict -> `behind=notice(B3,B6)`. */
export function behindToken(verdict) {
  if (!verdict || typeof verdict.level !== "string") return "behind=FAILED(no-verdict)";
  const ids = (Array.isArray(verdict.rules) ? verdict.rules : []).map((r) => r?.id).filter(Boolean);
  return paren(`behind=${verdict.level}`, ids.join(","));
}

/** `render.mjs`'s two summary lines -> `render=ok(107;AGD2-6712;tier1)`. */
export function renderToken(res) {
  if (res.status !== 0 || res.timedOut) return `render=FAILED(${detail(res)})`;
  const out = String(res.stdout ?? "");
  const items = /payload v\d+: (\d+) items/.exec(out)?.[1] ?? "?";
  const up = /upload: (\d+) chars \(budget \d+, tier (\d+)(, OVER)?\)/.exec(out);
  return `render=ok(${items};AGD2-${up?.[1] ?? "?"};tier${up?.[2] ?? "?"}${up?.[3] ? ";OVER" : ""})`;
}

/** `gcal-sync.mjs` / `gcal-ingest.mjs`: 0 ok, 2 no feeds, 3 partial, else failed.
 *  Route A ends on the WHOLE token - the string calendar-feeds.md tells a user
 *  to grep for - so it is taken verbatim, never wrapped into
 *  `gcal=ok(gcal=ok(...))`. Route B ends on a detail and still needs wrapping. */
export function gcalToken(res) {
  if (res.timedOut) return "gcal=FAILED(timeout)";
  const line = lastLine(res.stdout);
  if (line.startsWith("gcal=")) return clip(line, 200);
  if (res.status === 2) return "gcal=SKIPPED(no-feeds)";
  if (res.status === 3) return `gcal=PARTIAL(${detail(res)})`;
  return res.status === 0 ? paren("gcal=ok", detail(res)) : `gcal=FAILED(${detail(res)})`;
}

/** A publish step quotes `drive-rclone.mjs`'s own last line, which IS the token. */
const driveToken = (name, res) => {
  const line = res.timedOut ? "" : lastLine(res.stdout);
  return line.startsWith(`${name}=`) ? clip(line, 200) : `${name}=FAILED(${detail(res)})`;
};

/** One spawned step. `when(ctx)` returns null to run the command or the whole
 *  SKIPPED token to skip it; `token(res, ctx)` turns the result into the token. */
export function cmdStep(name, argv, { timeoutMs = TIMEOUT.default, when = null, token } = {}) {
  return Object.freeze({
    name, argv: Object.freeze([...argv]), timeoutMs,
    run(ctx) {
      const skip = when ? when(ctx) : null;
      if (skip) return { token: skip, skipped: true };
      const res = spawnStep(ctx, argv, { timeoutMs });
      return { token: token(res, ctx), exit: res.status, timedOut: !!res.timedOut };
    },
  });
}

// SIGTERM is spawnSync's default, but the teardown hang is why this step has a
// timeout at all, so the kill is spelled out.
const SCRAPE_OPTS = Object.freeze({ timeoutMs: TIMEOUT.scrape, killSignal: "SIGTERM" });
const scrapeOkOf = (ctx) => ctx.state?.phase1?.scrapeOk === true;
const withPhase1 = (state, patch) => ({ ...state, phase1: { ...(state?.phase1 ?? {}), ...patch } });

// ------------------------------------------- phase 1: scrape + reauth
/** A scrape can finish its work and then hang in teardown, so a timeout - or any
 *  non-zero exit that is not the auth one - is not evidence that it failed. The
 *  rule is "exit code never observed: proceed on data health": a `latest.json`
 *  written during THIS run, with items and an EMPTY `errors[]`, is a good scrape
 *  whatever the process did after. Anything older, unparseable or carrying errors
 *  keeps the FAILED token - a data-health rule that never says no is a stamp. */
function scrapeHealth(ctx, res) {
  const latest = readJson(ctx, "latest.json");
  const at = Date.parse(latest?.scrapedAt ?? "");
  const runAt = Date.parse(ctx.state?.runId ?? "");
  if (!Array.isArray(latest?.items) || !Array.isArray(latest?.errors) || latest.errors.length) return null;
  if (!Number.isFinite(at) || !Number.isFinite(runAt) || at < runAt) return null;
  const why = res.timedOut ? "exit-not-observed" : `exit-${res.status}`;
  return { scrapedAt: latest.scrapedAt, token: `scrape=ok(${latest.items.length}-items;${why})` };
}

function scrapeResultTokens(ctx, res, reauth) {
  if (res.status === 0 && !res.timedOut) {
    const state = withPhase1(ctx.state, { scrapeOk: true, scrapedAt: readJson(ctx, "latest.json")?.scrapedAt ?? null });
    return { tokens: { scrape: paren("scrape=ok", summaryLine(res, OK_LINE)), reauth }, state };
  }
  const health = res.status !== 2 || res.timedOut ? scrapeHealth(ctx, res) : null;
  if (health) return { tokens: { scrape: health.token, reauth }, state: withPhase1(ctx.state, { scrapeOk: true, scrapedAt: health.scrapedAt }) };
  const token = res.status === 2 && !res.timedOut ? "scrape=AUTH(exit-2)" : `scrape=FAILED(${detail(res)})`;
  return { tokens: { scrape: token, reauth }, state: withPhase1(ctx.state, { scrapeOk: false, scrapedAt: null }) };
}

/** Steps 1 and 1b. On exit 2 the automated re-auth runs ONCE and only a
 *  `reauth=ok` earns the single re-scrape; every other outcome leaves the run on
 *  stale data, which is what makes phase 2 skip render and publish.
 *  `src/auth-retry.mjs` owns every retry after this one. */
export const scrapeStep = Object.freeze({
  name: "scrape",
  run(ctx) {
    const first = spawnStep(ctx, ["src/scrape.mjs"], SCRAPE_OPTS);
    if (first.status !== 2 || first.timedOut) return scrapeResultTokens(ctx, first, "reauth=not-needed");

    const auth = spawnStep(ctx, ["scripts/reauth.mjs", "--silent"], { timeoutMs: TIMEOUT.reauth });
    const reauth = auth.timedOut ? "reauth=FAILED" : reauthMap(auth.status);
    if (reauth !== "reauth=ok") return scrapeResultTokens(ctx, first, reauth);
    return scrapeResultTokens(ctx, spawnStep(ctx, ["src/scrape.mjs"], SCRAPE_OPTS), reauth);
  },
});

// --------------------------------- phase 1: the connectors scrape ran
/** The stamp a connector wrote into its own file, else that file's mtime. */
function stampOf(ctx, file, json, key) {
  const declared = Date.parse(json?.[key] ?? "");
  if (Number.isFinite(declared)) return declared;
  const mtime = ctx.fs.mtime(dpath(ctx, file));
  return mtime instanceof Date ? mtime.getTime() : Number.NaN;
}

/** Why this connector has nothing fresh: its own error from the scrape, or `stale`. */
const skipReason = (ctx, re) => {
  const errs = readJson(ctx, "latest.json")?.errors;
  const named = (Array.isArray(errs) ? errs : []).map(String).find((e) => re.test(e));
  return named ? phrase(named) : "stale";
};

/** A connector `src/scrape.mjs` already ran through the registry: nothing is left
 *  to spawn, so the token is read off the file it wrote. A file stamped during
 *  THIS run is its own report; older is last run's, and calling that `ok` is a
 *  lie the runlog keeps for 500 lines. */
export function fileStep(name, { sep = "=", file, stamp, gate, match, summary }) {
  return Object.freeze({
    name,
    run(ctx) {
      if (!on(ctx, ...gate)) return { token: `${name}${sep}off` };
      const json = readJson(ctx, file);
      const at = stampOf(ctx, file, json, stamp);
      const runAt = Date.parse(ctx.state?.runId ?? "");
      if (!json || !Number.isFinite(at) || !Number.isFinite(runAt) || at < runAt) {
        return { token: `${name}${sep}skipped(${skipReason(ctx, match)})` };
      }
      return { token: `${name}${sep}ok(${summary(json)})` };
    },
  });
}

/** Step 2. The mail connector's own sweep report. Step 3 reads the board the same way. */
export const mailStep = fileStep("mail", {
  sep: ":", file: "outlook-raw.json", stamp: "sweptAt", gate: ["connectors", "mail", "outlook", "enabled"], match: /mail/i,
  summary: (raw) => `${Number(raw.scanned) || 0}-scanned-${(Array.isArray(raw.messages) ? raw.messages : []).length}-kept`,
});

export const boardStep = fileStep("board", {
  file: "board-items.json", stamp: "generatedAt", gate: ["connectors", "board", "github", "enabled"], match: /board/i,
  summary: (json) => String((Array.isArray(json.board) ? json.board : []).length),
});

// ---------------------------------------- phase 1: the Drive lanes
/** Move one doc out of the Drive root, returning its exit code - which the CALLER
 *  must look at. A failed consume leaves the doc for the next run to pull again,
 *  so it is still unconsumed for the behind rules and belongs in the token. */
const consume = (ctx, id, title) => {
  const r = spawnStep(ctx, ["src/drive-rclone.mjs", "consume", id, "--title", title], { timeoutMs: TIMEOUT.default });
  return r.timedOut ? 1 : (r.status ?? 1);
};

const pullDocs = (ctx, title) =>
  parsePull(spawnStep(ctx, ["src/drive-rclone.mjs", "pull", title, "--out", dpath(ctx, "tmp")], { timeoutMs: TIMEOUT.default }));

/** Step 5. Pull every completions doc, hand them all to `completion.mjs` in one
 *  call, consume ONLY the docs it reported `ok`. A SKIPPED doc stays in Drive. */
export const completionsStep = Object.freeze({
  name: "completions",
  run(ctx) {
    if (!driveOn(ctx)) return { token: "completions=SKIPPED(drive-off)", out: { staleDocs: 0 } };
    const title = docTitle(ctx, "completions");
    const pull = pullDocs(ctx, title);
    if (pull.error) return { token: `completions=SKIPPED(${pull.error})`, out: { staleDocs: 0 } };
    if (!pull.docs.length) return { token: "completions=none", out: { staleDocs: 0 } };

    const res = spawnStep(ctx, ["src/completion.mjs", "--ingest", ...pull.docs.map((d) => d.path)], { timeoutMs: TIMEOUT.default });
    if (res.status !== 0 || res.timedOut) {
      return { token: `completions=SKIPPED(ingest-${phrase(detail(res))})`, out: { staleDocs: pull.docs.length } };
    }
    const { okIndexes, newMarks, consumed } = parseIngest(res.stdout);
    let stuck = 0;
    for (const i of okIndexes) if (pull.docs[i]?.id && consume(ctx, pull.docs[i].id, title) !== 0) stuck += 1;
    return {
      token: `completions=ok(${newMarks};${consumed}${stuck ? `;consume-failed=${stuck}` : ""})`,
      out: { staleDocs: pull.docs.length - okIndexes.length + stuck },
    };
  },
});

/** Step 6, plus the retention sweep of the consumed folder. The pulled file IS
 *  the AGQ1 envelope and `command-ingest.mjs --apply` reads one directly, so
 *  nothing here decodes anything: the envelope stays the callee's problem. */
export const commandsStep = Object.freeze({
  name: "cmd",
  run(ctx) {
    if (!driveOn(ctx)) return { token: "cmd=SKIPPED(drive-off)", out: { staleDocs: 0 } };
    const title = docTitle(ctx, "commands");
    const pull = pullDocs(ctx, title);
    const purge = () => spawnStep(ctx, ["src/drive-rclone.mjs", "purge"], { timeoutMs: TIMEOUT.default });
    if (pull.error || !pull.docs.length) {
      purge();
      return { token: pull.error ? `cmd=SKIPPED(${pull.error})` : "cmd=none", out: { staleDocs: 0 } };
    }

    const counts = { applied: 0, refused: 0, stale: 0, error: 0 };
    let stuck = 0;
    for (const doc of pull.docs) {
      const res = spawnStep(ctx, ["src/command-ingest.mjs", "--apply", doc.path], { timeoutMs: TIMEOUT.default });
      const outcome = res.timedOut ? "error" : (CMD_OUTCOME[res.status] ?? "error");
      counts[outcome] += 1;
      if ((outcome === "applied" || outcome === "refused") && consume(ctx, doc.id, title) !== 0) stuck += 1;
    }
    purge();
    const extra = `${counts.error ? `,error=${counts.error}` : ""}${stuck ? `,consume-failed=${stuck}` : ""}`;
    return {
      token: `cmd=applied=${counts.applied},refused=${counts.refused},stale=${counts.stale}${extra}`,
      out: { staleDocs: counts.stale + counts.error + stuck },
    };
  },
});

/** Step 7. Route A is the feed list (`data/gcal-feeds.json`, fetched by
 *  `gcal-sync.mjs`); route B is a connector result somebody saved interactively.
 *  With neither there is nothing to ingest, and that is not a failure. */
export const gcalStep = Object.freeze({
  name: "gcal",
  run(ctx) {
    if (!on(ctx, "calendars", "gcal", "enabled")) return { token: "gcal=SKIPPED(disabled)" };
    const raw = dpath(ctx, "tmp", "gcal-raw.json");
    const argv = ctx.fs.exists(dpath(ctx, "gcal-feeds.json"))
      ? ["src/connectors/gcal-sync.mjs"]
      : ctx.fs.exists(raw)
        ? ["src/connectors/gcal-ingest.mjs", "--in", raw]
        : null;
    if (!argv) return { token: "gcal=SKIPPED(no-feeds)" };
    const res = spawnStep(ctx, argv, { timeoutMs: TIMEOUT.default });
    return { token: gcalToken(res), exit: res.status };
  },
});

// ------------------------------------- phase 1: the pure read-outs
/** Step 9. The gap list feeds the model's description pass; no runlog token. */
export const gapsStep = Object.freeze({
  name: "gaps",
  run(ctx) {
    const res = spawnStep(ctx, ["src/render.mjs", "--gaps"], { timeoutMs: TIMEOUT.default });
    const gaps = parseGaps(res.stdout);
    // `describe.mjs` validates `keys[]`; `gaps[]` is the work order's richer view.
    const file = { at: iso(ctx.now), keys: gaps.map((g) => g.k), gaps };
    ctx.fs.write(dpath(ctx, "tmp", "gaps.json"), `${JSON.stringify(file, null, 1)}\n`);
    return { out: gaps, exit: res.status };
  },
});

/** Step 10. `--stale-docs` is what steps 5 and 6 could not consume. */
export const behindStep = Object.freeze({
  name: "behind",
  run(ctx) {
    const stale = (ctx.out?.completions?.staleDocs ?? 0) + (ctx.out?.cmd?.staleDocs ?? 0);
    const res = spawnStep(ctx, ["src/behind.mjs", "--check", "--stale-docs", String(stale)], { timeoutMs: TIMEOUT.default });
    const verdict = parseJson(res.stdout);
    return { token: behindToken(verdict), out: verdict };
  },
});

/** Step 11. The copy phase 2 restores if the model breaks the standards plan. */
export const snapshotStep = Object.freeze({
  name: "snapshot",
  run(ctx) {
    const src = dpath(ctx, "study-plan.json");
    if (!standardsOn(ctx) || !ctx.fs.exists(src)) return { out: { copied: false } };
    ctx.fs.copy(src, dpath(ctx, "tmp", "study-plan.pre.json"));
    return { out: { copied: true } };
  },
});

/** Step 12. The one file the model reads. */
export const workOrderStep = Object.freeze({
  name: "workorder",
  run(ctx) {
    const wo = buildWorkOrder(ctx, collectWorkOrderData(ctx));
    ctx.fs.write(dpath(ctx, "work-order.json"), `${JSON.stringify(wo, null, 1)}\n`);
    return {
      out: { items: wo.items, previousItems: wo.previousItems },
      state: withPhase1(ctx.state, { items: wo.items, previousItems: wo.previousItems }),
    };
  },
});

export const PHASE1 = Object.freeze([
  scrapeStep,
  mailStep,
  boardStep,
  cmdStep("materials", ["src/materials-sync.mjs"], {
    timeoutMs: TIMEOUT.materials,
    when: (ctx) =>
      !scrapeOkOf(ctx) ? "materials=SKIPPED(stale-scrape)" : on(ctx, "connectors", "materials", "enabled") ? null : "materials=SKIPPED(disabled)",
    token: (res) => {
      if (res.timedOut) return "materials=FAILED(timeout)";
      if (res.status === 3) return "materials=SKIPPED(disabled)";
      if (res.status === 2) return "materials=AUTH";
      return res.status === 0 ? paren("materials=ok", summaryLine(res, OK_LINE)) : `materials=FAILED(${detail(res)})`;
    },
  }),
  completionsStep,
  commandsStep,
  gcalStep,
  cmdStep("studymodel", ["src/study-model.mjs", "--refresh"], {
    token: (res) => (res.status === 0 && !res.timedOut ? "studymodel=ok" : `studymodel=FAILED(${detail(res)})`),
  }),
  gapsStep,
  behindStep,
  snapshotStep,
  workOrderStep,
]);

// -------------------------------------------------------------- phase 2
/** A usable standards plan is one that parses and still has both lists. */
const planShapeOk = (t) => [parseJson(t)].every((p) => Array.isArray(p?.sittings) && Array.isArray(p?.weeks));

/** Step 1. The model may edit `data/study-plan.json` on Mondays; if what it left
 *  behind no longer parses or lost `sittings`/`weeks`, the pre-run copy goes
 *  back - a broken plan silently empties the focus strip for a week.
 *  NO PLAN AT ALL IS SILENT: a fresh standards install has none until the first
 *  Monday, and "nothing to restore" is not the fact `SKIPPED(no-snapshot)`
 *  states. One string for both makes the real alarm unreadable. */
export const planStep = Object.freeze({
  name: "plan",
  run(ctx) {
    if (!standardsOn(ctx)) return {};
    const plan = dpath(ctx, "study-plan.json");
    const pre = dpath(ctx, "tmp", "study-plan.pre.json");
    if (!ctx.fs.exists(plan)) return {};
    if (planShapeOk(readText(ctx, plan))) return {};
    if (!planShapeOk(readText(ctx, pre))) return { token: "plan=SKIPPED(no-snapshot)" };
    ctx.fs.copy(pre, plan);
    return { token: "plan=restored(bad-shape)" };
  },
});

const renderTokenOf = (ctx) => String(ctx.tokens?.render ?? "");
const renderOk = (ctx) => renderTokenOf(ctx).startsWith("render=ok");
const renderOver = (ctx) => /;OVER\)$/.test(renderTokenOf(ctx));

/** Step 4. Pack the local bundle first; only a packed bundle can be published. */
export const mirrorStep = Object.freeze({
  name: "mirror",
  run(ctx) {
    if (!driveOn(ctx) || !on(ctx, "drive", "mirror")) return { token: "mirror=SKIPPED(off)" };
    const pack = spawnStep(ctx, ["src/drive-bundle.mjs", "--pack"], { timeoutMs: TIMEOUT.default });
    if (pack.status === 3 && !pack.timedOut) return { token: "mirror=SKIPPED(too-big)" };
    if (pack.status !== 0 || pack.timedOut) return { token: `mirror=FAILED(pack;${phrase(detail(pack))})` };
    return { token: driveToken("mirror", spawnStep(ctx, ["src/drive-rclone.mjs", "publish", "mirror"], { timeoutMs: TIMEOUT.default })) };
  },
});

/** Step 5. One sink at a time: Outlook when it is on, else the ICS file. */
export const calendarStep = Object.freeze({
  name: "calendar",
  run(ctx) {
    const argv = on(ctx, "connectors", "calendar", "outlook", "enabled")
      ? ["src/connectors/calendar-outlook.mjs"]
      : on(ctx, "connectors", "calendar", "ics", "enabled")
        ? ["src/connectors/calendar-ics.mjs"]
        : null;
    if (!argv) return { token: "calendar=SKIPPED(no-sink)" };
    const res = spawnStep(ctx, argv, { timeoutMs: TIMEOUT.default });
    if (res.timedOut) return { token: "calendar=FAILED(timeout)", exit: res.status };
    const counts = calendarCounts(res);
    if (res.status === 2) return { token: `calendar=PARTIAL(${counts || detail(res)})`, exit: 2 };
    return { token: res.status === 0 ? paren("calendar=ok", counts) : `calendar=FAILED(${detail(res)})`, exit: res.status };
  },
});

/** Step 6. Only a digest the model wrote THIS run is sent: an older
 *  `data/digest.md` is yesterday's mail, and sending it twice is worse than
 *  sending nothing. A sent digest is recorded in `data/run-state.json` IMMEDIATELY,
 *  before the steps after it: phase 2 can be killed between here and its own final
 *  write, and the re-run must not mail the same digest twice. That window is the
 *  one piece of run state a step owns, and why this is not a `cmdStep`. */
export const digestStep = Object.freeze({
  name: "digest",
  run(ctx) {
    if (ctx.state?.phase2?.digestSentAt) return { token: "digest=SKIPPED(already-sent)", skipped: true };
    if (ctx.cfg?.notifications?.emailDigest !== "outlook") return { token: "digest=SKIPPED(off)", skipped: true };
    if ((ctx.platform ?? "") !== "win32") return { token: "digest=SKIPPED(no-mail-sink)", skipped: true };
    const runId = ctx.state?.runId;
    const written = ctx.fs.mtime(dpath(ctx, "digest.md"));
    if (!runId || !(written instanceof Date) || written.getTime() <= new Date(runId).getTime()) {
      return { token: "digest=none", skipped: true };
    }
    const res = spawnStep(ctx, ["src/send-digest.mjs", "--since", runId], { timeoutMs: TIMEOUT.default });
    const line = res.timedOut ? "" : lastLine(res.stdout);
    const token = line.startsWith("digest=") ? clip(line, 200) : `digest=FAILED(${detail(res)})`;
    if (res.status !== 0 || res.timedOut) return { token, exit: res.status };
    const state = { ...ctx.state, phase2: { ...(ctx.state?.phase2 ?? {}), digestSentAt: iso(ctx.now), tokens: { ...ctx.tokens, digest: token } } };
    ctx.fs.write(dpath(ctx, "run-state.json"), serializeRunState(state));
    return { token, exit: res.status, state };
  },
});

/** Step 8. The model's side of the handover. */
export const reportStep = Object.freeze({
  name: "report",
  run(ctx) {
    const state = { ...ctx.state, phase2: { ...(ctx.state?.phase2 ?? {}), tokens: { ...ctx.tokens } } };
    const report = buildReport({ ...ctx, state });
    ctx.fs.write(dpath(ctx, "run-report.json"), `${JSON.stringify(report, null, 1)}\n`);
    return { out: report };
  },
});

export const PHASE2 = Object.freeze([
  planStep,
  cmdStep("render", ["src/render.mjs"], { when: (ctx) => (scrapeOkOf(ctx) ? null : "render=SKIPPED(stale-scrape)"), token: renderToken }),
  cmdStep("drive", ["src/drive-rclone.mjs", "publish", "payload"], {
    when: (ctx) =>
      !driveOn(ctx) ? "drive=SKIPPED(drive-off)" : !renderOk(ctx) ? "drive=SKIPPED(no-render)" : renderOver(ctx) ? "drive=SKIPPED(oversize)" : null,
    token: (res) => driveToken("drive", res),
  }),
  mirrorStep,
  calendarStep,
  digestStep,
  cmdStep("deadman", ["src/deadman.mjs", "--arm", "--hours", "30"], {
    token: (res) => {
      if (res.timedOut) return "deadman=FAILED(timeout)";
      if (res.status === 2) return "deadman=SKIPPED(com)";
      if (res.status !== 0) return `deadman=FAILED(${detail(res)})`;
      const skip = findLine(res, /deadman=SKIPPED\(/);
      return skip ? clip(unprefix(skip), 60) : "deadman=armed";
    },
  }),
  reportStep,
]);
