// pipeline.test.mjs - the orchestrator's tests.
//
// node --test  (run from the repository root)
//
// Nothing here touches the disk, the network, Drive, Outlook or an LMS: every
// step is exercised through the injected `spawn` and the in-memory `fs` of
// `harness()`, and the whole configuration is a literal. No test reads `data/`
// and no test starts a real process.
//
// The fake spawner keys a script on the first TWO argv words ("src/drive-rclone.mjs
// pull") and falls back to the first word alone ("src/scrape.mjs"), so a test can
// pin either a whole sub-command or a whole script.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PHASE1,
  PHASE2,
  calendarStep,
  digestStep,
  gcalStep,
  planStep,
  reauthMap,
  renderToken,
} from "../src/pipeline-steps.mjs";
import {
  PROTECTED_PREFIXES,
  RUNLOG_ORDER,
  UNSEEN_WINDOW_HOURS,
  buildReport,
  buildUsageRecord,
  buildWorkOrder,
  finishLine,
  loadRunConfig,
  main,
  newRunState,
  readRunState,
  runPhase,
  trimRunlog,
  writeRunlog,
} from "../src/pipeline.mjs";

const NOW = "2026-09-15T14:30:07Z"; // a Tuesday in UTC
const NOW_MS = new Date(NOW).getTime();
const hoursAgo = (h) => new Date(NOW_MS - h * 3600 * 1000).toISOString();

/** A configuration with every optional lane OFF, so a test turns on what it means. */
const baseConfig = () => ({
  namespace: "agenda",
  title: "Weekly Agenda",
  timezone: "UTC",
  wakeTime: "10:00",
  institution: { name: "Example University", mailDomains: ["example.edu"] },
  courses: [{ id: 1, code: "MATH 210", name: "Linear Algebra" }, { id: 2, code: "SEM 100", name: "Seminar", skip: true }],
  standardsPlan: { enabled: false, course: null, label: "Standards" },
  calendars: { gcal: { enabled: false } },
  connectors: {
    mail: { outlook: { enabled: false } },
    board: { github: { enabled: false } },
    materials: { enabled: false },
    calendar: { outlook: { enabled: false }, ics: { enabled: false } },
  },
  drive: { enabled: true, mirror: true },
  artifact: { url: null },
  notifications: { emailDigest: "off" },
});

/** Deep-merge a patch over `baseConfig()` - one level per nested object is enough. */
function withConfig(patch = {}) {
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
    }
    return out;
  };
  return merge(baseConfig(), patch);
}

function harness(script = {}, files = {}, { cfg = baseConfig(), platform = "win32", now = NOW } = {}) {
  const calls = [];
  const opts = [];
  const spawn = (argv, how = {}) => {
    calls.push(argv);
    opts.push(how);
    const k = argv.slice(0, 2).join(" ");
    const r = script[k] || script[argv[0]] || { status: 0, stdout: "" };
    return { status: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: !!r.timedOut };
  };
  const fs = {
    read: (p) => files[p],
    write: (p, t) => {
      files[p] = t;
    },
    exists: (p) => p in files,
    mtime: (p) => files[`${p}.mtime`] || new Date(0),
    copy: (a, b) => {
      files[b] = files[a];
    },
    append: (p, t) => {
      files[p] = `${files[p] ?? ""}${t}`;
    },
  };
  return {
    ctx: {
      now: new Date(now),
      cfg,
      tz: cfg.timezone ?? "UTC",
      titles: { data: "agenda-data", mirror: "agenda-mirror", completions: "agenda-completions", commands: "agenda-commands" },
      platform,
      data: "data",
      passthrough: [],
      spawn,
      fs,
      state: newRunState(new Date(now), cfg.timezone ?? "UTC"),
    },
    calls,
    opts,
    files,
  };
}

// scrape.mjs can finish its work and then hang in teardown. What it WROTE is the truth.
const latestJson = (scrapedAt, items = 97, errors = []) =>
  JSON.stringify({ scrapedAt, items: Array.from({ length: items }, (_, i) => ({ title: `i${i}` })), announcements: [], errors });

// ---------------------------------------------------------------- scrape

test("reauthMap follows the exit map in AGENTS.md", () => {
  assert.deepEqual(
    [0, 1, 2, 4, 5, 6, 7, 3].map(reauthMap),
    ["reauth=ok", "reauth=FAILED", "reauth=NO-CREDS", "reauth=USAGE", "reauth=BAD-CREDS", "reauth=MFA-PENDING", "reauth=NO-PACKAGE", "reauth=FAILED"],
  );
});

test("phase 1 runs every step in order and continues past failures", () => {
  const h = harness({ "src/study-model.mjs": { status: 1, stderr: "boom" } });
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(h.calls[0][0], "src/scrape.mjs");
  assert.match(r.tokens.studymodel, /^studymodel=FAILED/);
  assert.ok(r.tokens.behind);
});

test("scrape exit 2 triggers exactly one reauth and one re-scrape on success", () => {
  let n = 0;
  const h = harness();
  h.ctx.spawn = (argv) => {
    h.calls.push(argv);
    if (argv[0] === "src/scrape.mjs") return { status: n++ === 0 ? 2 : 0, stdout: "OK: 97 items" };
    return { status: 0, stdout: "" };
  };
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(h.calls.filter((c) => c[0] === "src/scrape.mjs").length, 2);
  assert.equal(h.calls.filter((c) => c[0] === "scripts/reauth.mjs").length, 1);
  assert.equal(r.tokens.reauth, "reauth=ok");
  assert.equal(h.ctx.state.phase1.scrapeOk, true);
});

test("a scrape that hangs in teardown is judged on the data it wrote", () => {
  const h = harness(
    { "src/scrape.mjs": { timedOut: true } },
    { "data/latest.json": latestJson("2026-09-15T14:40:26Z") },
    { cfg: withConfig({ connectors: { materials: { enabled: true } } }) },
  );
  const r = runPhase(PHASE1, h.ctx);
  assert.match(r.tokens.scrape, /^scrape=ok\(97-items;exit-not-observed\)$/);
  assert.equal(h.ctx.state.phase1.scrapeOk, true);
  assert.equal(h.ctx.state.phase1.scrapedAt, "2026-09-15T14:40:26Z");
  assert.ok(h.calls.some((c) => c[0] === "src/materials-sync.mjs"));
  assert.equal(h.calls.filter((c) => c[0] === "scripts/reauth.mjs").length, 0);
  assert.equal(h.opts[0].killSignal, "SIGTERM"); // the hung child is killed, not left running
});

test("a non-zero scrape exit with fresh, clean data is still a scrape", () => {
  const h = harness({ "src/scrape.mjs": { status: 1 } }, { "data/latest.json": latestJson("2026-09-15T14:40:26Z") });
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.scrape, "scrape=ok(97-items;exit-1)");
  assert.equal(r.tokens.reauth, "reauth=not-needed");
});

test("data health is not a rubber stamp: stale or error-carrying latest.json stays FAILED", () => {
  const stale = harness({ "src/scrape.mjs": { timedOut: true } }, { "data/latest.json": latestJson("2026-09-14T22:09:10.701Z") });
  const p1 = runPhase(PHASE1, stale.ctx);
  assert.equal(p1.tokens.scrape, "scrape=FAILED(timeout)");
  assert.equal(p1.tokens.materials, "materials=SKIPPED(stale-scrape)");
  assert.equal(stale.ctx.state.phase1.scrapeOk, false);

  const errs = harness({ "src/scrape.mjs": { timedOut: true } }, { "data/latest.json": latestJson(NOW, 97, ["lms-canvas: tree failed"]) });
  assert.equal(runPhase(PHASE1, errs.ctx).tokens.scrape, "scrape=FAILED(timeout)");

  const none = harness({ "src/scrape.mjs": { timedOut: true } });
  assert.equal(runPhase(PHASE1, none.ctx).tokens.scrape, "scrape=FAILED(timeout)");
});

test("the re-scrape after a good reauth is judged the same way", () => {
  let n = 0;
  const h = harness({}, { "data/latest.json": latestJson("2026-09-15T14:40:26Z") });
  h.ctx.spawn = (argv) => {
    h.calls.push(argv);
    if (argv[0] === "src/scrape.mjs") return n++ === 0 ? { status: 2, stdout: "" } : { status: 0, stdout: "", timedOut: true };
    return { status: 0, stdout: "" };
  };
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.reauth, "reauth=ok");
  assert.equal(r.tokens.scrape, "scrape=ok(97-items;exit-not-observed)");
});

test("stale scrape skips materials in phase 1 and render, publish in phase 2", () => {
  const h = harness({ "src/scrape.mjs": { status: 2 }, "scripts/reauth.mjs": { status: 6 } });
  const p1 = runPhase(PHASE1, h.ctx);
  assert.equal(p1.tokens.reauth, "reauth=MFA-PENDING");
  assert.equal(p1.tokens.materials, "materials=SKIPPED(stale-scrape)");
  const p2 = runPhase(PHASE2, h.ctx);
  assert.equal(p2.tokens.render, "render=SKIPPED(stale-scrape)");
  assert.equal(p2.tokens.drive, "drive=SKIPPED(no-render)");
});

test("a step's own OK line is the token, not the last warning it printed", () => {
  const h = harness(
    {
      "src/scrape.mjs": { status: 0, stdout: "OK: 97 items\nwarn: MATH 210 tree empty" },
      "src/materials-sync.mjs": { status: 0, stdout: "ERROR L5.pdf: 403\nOK: 5 new, 28.5 MB\ndone in 41s" },
    },
    {},
    { cfg: withConfig({ connectors: { materials: { enabled: true } } }) },
  );
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.materials, "materials=ok(OK:-5-new,-28.5-MB)");
  assert.equal(r.tokens.scrape, "scrape=ok(OK:-97-items)");
  for (const t of Object.values(r.tokens)) assert.equal(t.includes(" "), false, t);
});

test("a FAILED token quotes the reason a script refused, not the advice after it", () => {
  // `loadConfigured` prints the missing key first and two lines of advice after
  // it; the last of those says nothing about what is wrong.
  const refusal = 'config: "timezone" is not set yet.\n  Fix: open this folder in Claude Code and say "hey".\n  Or edit config.json directly; docs/CONFIG.md explains every key.';
  const h = harness({ "src/render.mjs": { status: 1, stderr: refusal } });
  h.ctx.state = { ...h.ctx.state, phase1: { scrapeOk: true } };
  assert.equal(runPhase(PHASE2, h.ctx).tokens.render, 'render=FAILED(config:-"timezone"-is-not-set-yet.)');
});

test("materials is SKIPPED(disabled) by config and by its own exit 3", () => {
  const off = harness({}, {});
  assert.equal(runPhase(PHASE1, off.ctx).tokens.materials, "materials=SKIPPED(disabled)");
  assert.equal(off.calls.filter((c) => c[0] === "src/materials-sync.mjs").length, 0);

  const on = harness({ "src/materials-sync.mjs": { status: 3 } }, {}, { cfg: withConfig({ connectors: { materials: { enabled: true } } }) });
  assert.equal(runPhase(PHASE1, on.ctx).tokens.materials, "materials=SKIPPED(disabled)");

  const auth = harness({ "src/materials-sync.mjs": { status: 2 } }, {}, { cfg: withConfig({ connectors: { materials: { enabled: true } } }) });
  assert.equal(runPhase(PHASE1, auth.ctx).tokens.materials, "materials=AUTH");
});

// ------------------------------------------- the connectors scrape already ran

test("the mail token is read off the file the connector wrote during THIS run", () => {
  const cfg = withConfig({ connectors: { mail: { outlook: { enabled: true } } } });
  const raw = (sweptAt, kept = 3) =>
    JSON.stringify({ sweptAt, scanned: 254, messages: Array.from({ length: kept }, (_, i) => ({ subj: `s${i}` })) });

  const fresh = harness({}, { "data/outlook-raw.json": raw("2026-09-15T14:31:00Z", 77) }, { cfg });
  assert.equal(runPhase(PHASE1, fresh.ctx).tokens.mail, "mail:ok(254-scanned-77-kept)");
  assert.equal(fresh.calls.filter((c) => /outlook/.test(c[0])).length, 0); // no spawn: the registry already ran it

  const stale = harness({}, { "data/outlook-raw.json": raw("2026-09-14T22:00:00Z") }, { cfg });
  assert.equal(runPhase(PHASE1, stale.ctx).tokens.mail, "mail:skipped(stale)");

  const off = harness({}, { "data/outlook-raw.json": raw("2026-09-15T14:31:00Z") });
  assert.equal(runPhase(PHASE1, off.ctx).tokens.mail, "mail:off");
});

test("a skipped connector quotes the scrape error that names it, space-free", () => {
  const cfg = withConfig({ connectors: { mail: { outlook: { enabled: true } } } });
  const h = harness(
    {},
    { "data/latest.json": JSON.stringify({ scrapedAt: NOW, items: [], errors: ["mail-outlook: Outlook (classic) is not running"] }) },
    { cfg },
  );
  const token = runPhase(PHASE1, h.ctx).tokens.mail;
  assert.equal(token, "mail:skipped(mail-outlook:-Outlook-classic-is-not-running)");
  assert.equal(token.includes(" "), false);
});

test("the board token counts entries, and is off when the connector is off", () => {
  const cfg = withConfig({ connectors: { board: { github: { enabled: true } } } });
  const file = JSON.stringify({ generatedAt: "2026-09-15T14:31:00Z", board: [{ t: "a" }, { t: "b" }] });

  const on = harness({}, { "data/board-items.json": file }, { cfg });
  assert.equal(runPhase(PHASE1, on.ctx).tokens.board, "board=ok(2)");

  const off = harness({}, { "data/board-items.json": file });
  assert.equal(runPhase(PHASE1, off.ctx).tokens.board, "board=off");
});

test("a file with no stamp of its own falls back to its mtime", () => {
  const cfg = withConfig({ connectors: { board: { github: { enabled: true } } } });
  const h = harness({}, { "data/board-items.json": JSON.stringify({ board: [{ t: "a" }] }) }, { cfg });
  h.files["data/board-items.json.mtime"] = new Date("2026-09-15T14:31:00Z");
  assert.equal(runPhase(PHASE1, h.ctx).tokens.board, "board=ok(1)");
});

// -------------------------------------------------------------- Drive lanes

test("completions: pull, ingest, consume only docs reported ok", () => {
  const pulled = JSON.stringify({
    docs: [{ id: "A1", path: "data/tmp/agenda-completions-A1.txt" }, { id: "B2", path: "data/tmp/agenda-completions-B2.txt" }],
  });
  const h = harness({
    "src/drive-rclone.mjs pull": { stdout: pulled },
    "src/completion.mjs --ingest": {
      stdout:
        "doc 1: ok - v2, 2 mark(s), 0 cleared\ndoc 2: SKIPPED - not a decodable AGC1 envelope\ningest: 1 doc(s) consumed, 1 skipped; 2 new mark(s), 0 revoked, 0 changed state",
    },
  });
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.completions, "completions=ok(2;1)");
  const consumed = h.calls
    .filter((c) => c[0] === "src/drive-rclone.mjs" && c[1] === "consume" && c[4] === "agenda-completions")
    .map((c) => c[2]);
  assert.deepEqual(consumed, ["A1"]);
  // the title comes from derive().docTitles, never from a literal
  const pull = h.calls.find((c) => c[1] === "pull");
  assert.equal(pull[2], "agenda-completions");
});

test("a consume that fails is named in the completions token and counted as a stale doc", () => {
  const pulled = JSON.stringify({ docs: [{ id: "A1", path: "data/tmp/a1.txt" }, { id: "B2", path: "data/tmp/b2.txt" }] });
  const h = harness({
    "src/drive-rclone.mjs pull": { stdout: pulled },
    "src/drive-rclone.mjs consume": { status: 1, stderr: "rclone: directory not found" },
    "src/completion.mjs --ingest": {
      stdout: "doc 1: ok - v2, 1 mark(s), 0 cleared\ndoc 2: ok - v2, 1 mark(s), 0 cleared\ningest: 2 doc(s) consumed, 0 skipped; 2 new mark(s), 0 revoked",
    },
    "src/command-ingest.mjs --apply": { status: 0 },
  });
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.completions, "completions=ok(2;2;consume-failed=2)");
  assert.equal(r.out.completions.staleDocs, 2);
  // behind.mjs sees every doc still sitting in Drive: 2 stuck here, and 2 in the
  // commands lane, which pulls the same two fake docs in this harness.
  assert.equal(h.calls.find((c) => c[0] === "src/behind.mjs").join(" "), "src/behind.mjs --check --stale-docs 4");
});

test("cmd counts every outcome and consumes only the applied and refused docs", () => {
  const pulled = JSON.stringify({
    docs: [{ id: "C1", path: "data/tmp/c1.txt" }, { id: "C2", path: "data/tmp/c2.txt" }, { id: "C3", path: "data/tmp/c3.txt" }],
  });
  let n = 0;
  const h = harness();
  h.ctx.spawn = (argv) => {
    h.calls.push(argv);
    const k = argv.slice(0, 2).join(" ");
    if (k === "src/drive-rclone.mjs pull" && argv[2] === "agenda-commands") return { status: 0, stdout: pulled };
    if (k === "src/command-ingest.mjs --apply") return { status: [0, 5, 4][n++], stdout: "" };
    return { status: 0, stdout: "" };
  };
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.cmd, "cmd=applied=1,refused=1,stale=1");
  const consumed = h.calls.filter((c) => c[0] === "src/drive-rclone.mjs" && c[1] === "consume").map((c) => c[2]);
  assert.deepEqual(consumed, ["C1", "C2"]);
  // the doc IS the envelope: command-ingest is handed the pulled path directly
  assert.equal(h.calls.find((c) => c[1] === "--apply")[2], "data/tmp/c1.txt");
  assert.ok(h.calls.some((c) => c[0] === "src/drive-rclone.mjs" && c[1] === "purge"));
});

test("cmd calls a command-ingest error an error, and names a stuck consume", () => {
  const pulled = JSON.stringify({ docs: [{ id: "C1", path: "data/tmp/c1.txt" }, { id: "C2", path: "data/tmp/c2.txt" }] });
  let n = 0;
  const h = harness();
  h.ctx.spawn = (argv) => {
    h.calls.push(argv);
    const k = argv.slice(0, 2).join(" ");
    if (k === "src/drive-rclone.mjs pull" && argv[2] === "agenda-commands") return { status: 0, stdout: pulled };
    if (k === "src/command-ingest.mjs --apply") return { status: [0, 1][n++], stdout: "" };
    if (k === "src/drive-rclone.mjs consume") return { status: 1, stdout: "" };
    return { status: 0, stdout: "" };
  };
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.cmd, "cmd=applied=1,refused=0,stale=0,error=1,consume-failed=1");
  assert.equal(r.out.cmd.staleDocs, 2);
});

test("drive.enabled false skips both bus lanes and both publishes, and spawns no rclone", () => {
  const cfg = withConfig({ drive: { enabled: false } });
  const h = harness({}, {}, { cfg });
  const p1 = runPhase(PHASE1, h.ctx);
  assert.equal(p1.tokens.completions, "completions=SKIPPED(drive-off)");
  assert.equal(p1.tokens.cmd, "cmd=SKIPPED(drive-off)");

  h.ctx.state = { ...h.ctx.state, phase1: { scrapeOk: true } };
  const p2 = runPhase(PHASE2, h.ctx);
  assert.equal(p2.tokens.drive, "drive=SKIPPED(drive-off)");
  assert.equal(p2.tokens.mirror, "mirror=SKIPPED(off)");
  assert.equal(h.calls.filter((c) => c[0] === "src/drive-rclone.mjs").length, 0);
});

test("an rclone pull that cannot answer is a SKIPPED token, never a crash", () => {
  const h = harness({ "src/drive-rclone.mjs pull": { status: 5, stdout: JSON.stringify({ error: "auth failed (token expired)" }) } });
  const r = runPhase(PHASE1, h.ctx);
  assert.equal(r.tokens.completions, "completions=SKIPPED(auth-failed-token-expired)");
  assert.equal(r.tokens.cmd, "cmd=SKIPPED(auth-failed-token-expired)");
});

// ----------------------------------------------------- the inbound calendar

test("gcal picks route A when there is a feed file, route B when there is a saved result", () => {
  const cfg = withConfig({ calendars: { gcal: { enabled: true } } });
  assert.equal(gcalStep.run(harness({}, {}, { cfg }).ctx).token, "gcal=SKIPPED(no-feeds)");

  // Route A ends on the WHOLE token - which is the string
  // docs/connectors/calendar-feeds.md tells a user to grep for - so it is taken
  // verbatim rather than wrapped into gcal=ok(gcal=ok(...)).
  const feeds = harness(
    { "src/connectors/gcal-sync.mjs": { stdout: "fetching 1 feed(s)\ngcal=ok(7-events;1-feeds)" } },
    { "data/gcal-feeds.json": "{}" },
    { cfg },
  );
  assert.equal(gcalStep.run(feeds.ctx).token, "gcal=ok(7-events;1-feeds)");
  assert.equal(feeds.calls[0][0], "src/connectors/gcal-sync.mjs");

  // Route B ends on a detail, which still needs wrapping.
  const saved = harness({ "src/connectors/gcal-ingest.mjs": { stdout: "feed=calendar 3 event(s)" } }, { "data/tmp/gcal-raw.json": "{}" }, { cfg });
  assert.equal(gcalStep.run(saved.ctx).token, "gcal=ok(feed=calendar-3-events)");
  assert.deepEqual(saved.calls[0], ["src/connectors/gcal-ingest.mjs", "--in", "data/tmp/gcal-raw.json"]);

  const off = harness({}, { "data/gcal-feeds.json": "{}" });
  assert.equal(gcalStep.run(off.ctx).token, "gcal=SKIPPED(disabled)");
  assert.equal(off.calls.length, 0);
});

test("gcal maps the exit codes, and route A own token wins at every one of them", () => {
  const cfg = withConfig({ calendars: { gcal: { enabled: true } } });
  const token = (script) => gcalStep.run(harness({ "src/connectors/gcal-sync.mjs": script }, { "data/gcal-feeds.json": "{}" }, { cfg }).ctx).token;

  assert.equal(token({ status: 3, stdout: "partial=1-of-2-feeds" }), "gcal=PARTIAL(partial=1-of-2-feeds)");
  assert.equal(token({ status: 1, stderr: "bad feed id" }), "gcal=FAILED(bad-feed-id)");
  assert.equal(token({ status: 2, stdout: "" }), "gcal=SKIPPED(no-feeds)");
  assert.equal(token({ status: 3, stdout: "gcal=PARTIAL(4-events;1-of-2-feeds)" }), "gcal=PARTIAL(4-events;1-of-2-feeds)");
  assert.equal(token({ status: 1, stdout: "gcal=FAILED(no-feed-answered)" }), "gcal=FAILED(no-feed-answered)");
  // a timeout means the child said nothing we can trust, whatever is in the buffer
  assert.equal(token({ status: 0, stdout: "gcal=ok(x)", timedOut: true }), "gcal=FAILED(timeout)");
});

// ------------------------------------------------------------- the work order

const emptyWorkOrder = {
  latest: { items: [], announcements: [] },
  diff: { newItems: [], changedDates: [], nowSubmitted: [], newAnnouncements: [] },
  gaps: [],
  behind: { level: "clear", rules: [] },
  focus: [],
  studyPlan: { weeks: [], sittings: [] },
  previousItems: 0,
  mail: [],
  raw: { messages: [], replies: {} },
};

test("work order caps unseen mail at 25 and previews at 1500 chars", () => {
  const msgs = Array.from({ length: 40 }, (_, i) => ({
    entryId: `e${i}`, from: "X", addr: "x@y", subj: `s${i}`, recv: hoursAgo(i * 0.5), preview: "p".repeat(3000), seen: false,
  }));
  const wo = buildWorkOrder(harness().ctx, { ...emptyWorkOrder, raw: { messages: msgs, replies: {} } });
  assert.equal(wo.mail.unseen.length, 25);
  assert.equal(wo.mail.unseen[0].preview.length, 1500);
});

test("work order keeps only the unseen mail inside the 36 hour window, newest first", () => {
  assert.equal(UNSEEN_WINDOW_HOURS, 36);
  const msgs = Array.from({ length: 40 }, (_, i) => ({
    entryId: `e${i}`, from: "X", addr: "x@y", subj: `s${i}`, recv: hoursAgo(i < 10 ? i * 2 : 48 + i), preview: "p", seen: false,
  }));
  const wo = buildWorkOrder(harness().ctx, { ...emptyWorkOrder, raw: { messages: msgs, replies: {} } });
  assert.equal(wo.mail.unseen.length, 10);
  assert.deepEqual(wo.mail.unseen.map((m) => m.subj), Array.from({ length: 10 }, (_, i) => `s${i}`));
});

test("unseen mail with no usable recv is left out - it cannot be shown to be recent", () => {
  const msgs = [
    { entryId: "a", subj: "dated", recv: hoursAgo(1), preview: "p", seen: false },
    { entryId: "b", subj: "undated", recv: null, preview: "p", seen: false },
    { entryId: "c", subj: "seen", recv: hoursAgo(1), preview: "p", seen: true },
  ];
  const wo = buildWorkOrder(harness().ctx, { ...emptyWorkOrder, raw: { messages: msgs, replies: {} } });
  assert.deepEqual(wo.mail.unseen.map((m) => m.subj), ["dated"]);
});

test("the work order names no institution, zone or course of its own - all four come from config", () => {
  const h = harness();
  const wo = buildWorkOrder(h.ctx, emptyWorkOrder);
  assert.equal(wo.timezone, "UTC");
  assert.equal(wo.title, "Weekly Agenda");
  assert.equal(wo.wakeTime, "10:00");
  assert.deepEqual(wo.institution, { name: "Example University", mailDomains: ["example.edu"] });
  assert.deepEqual(wo.courses, [
    { code: "MATH 210", id: 1, name: "Linear Algebra", skip: false },
    { code: "SEM 100", id: 2, name: "Seminar", skip: true },
  ]);
  assert.equal(wo.nowLocal, "2026-09-15 14:30");
  assert.equal(wo.weekday, "Tuesday");
});

test("the work order spells local times in the configured zone, not the machine's", () => {
  const h = harness({}, {}, { cfg: withConfig({ timezone: "Asia/Tokyo" }) });
  const wo = buildWorkOrder(h.ctx, emptyWorkOrder);
  assert.equal(wo.nowLocal, "2026-09-15 23:30");
  assert.equal(wo.weekday, "Tuesday");
  assert.equal(wo.timezone, "Asia/Tokyo");
});

test("items reach the wire as the v2 short keys, with a key even when the source had none", () => {
  const h = harness();
  const wo = buildWorkOrder(h.ctx, {
    ...emptyWorkOrder,
    latest: { items: [{ courseId: 7, course: "MATH 210", title: "Homework 2", due: hoursAgo(-2), type: "homework", submitted: null }], announcements: [] },
  });
  assert.equal(wo.items, 1);
  const [item] = wo.due.today;
  assert.deepEqual(Object.keys(item).sort(), ["approx", "c", "cid", "d", "k", "s", "t", "ty"]);
  assert.equal(item.k, "7::homework::homework 2");
  assert.equal(item.s, null); // tri-state: nobody knows is never `false`
});

test("the standards block is dormant unless the feature is on, and its plan is Mondays only", () => {
  const off = harness();
  assert.equal(buildWorkOrder(off.ctx, emptyWorkOrder).standards, null);

  const cfg = withConfig({ standardsPlan: { enabled: true, course: "MATH 210" } });
  const data = {
    ...emptyWorkOrder,
    latest: { items: [{ course: "MATH 210", title: "Standard 3", grade: "M", due: null }], announcements: [{ course: "MATH 210", title: "Sitting 2", body: "b" }] },
    studyPlan: { weeks: [{ start: "2026-09-14", focus: ["S3"], note: "" }], sittings: [{ date: "2026-09-18", label: "Sitting 2" }] },
  };
  const tue = buildWorkOrder(harness({}, {}, { cfg }).ctx, data);
  assert.equal(tue.standards.course, "MATH 210");
  assert.equal(tue.standards.week.week, "2026-09-14");
  assert.equal(tue.standards.plan, null);

  const mon = buildWorkOrder(harness({}, {}, { cfg, now: "2026-09-14T14:30:07Z" }).ctx, data);
  assert.equal(mon.standards.plan.grades.length, 1);
  assert.equal(mon.standards.plan.announcements.length, 1);
});

test("the work order carries the agenda page link from config", () => {
  const h = harness({}, {}, { cfg: withConfig({ artifact: { url: "https://claude.ai/public/artifacts/abc" } }) });
  assert.equal(buildWorkOrder(h.ctx, emptyWorkOrder).artifactUrl, "https://claude.ai/public/artifacts/abc");
  assert.equal(buildWorkOrder(harness().ctx, emptyWorkOrder).artifactUrl, null);
});

test("the gaps file carries the key list describe.mjs validates", () => {
  const rows = [
    "1632000::exam::exam 1\tPHYS 221\tExam 1\tWed 2026-09-16 09:00 am\tapprox",
    "1631000::homework::hw 3\tMATH 210\tHW 3\tFri 2026-09-18 11:59 pm",
    "",
    "2 item key(s) missing a description (2 of 2 occurrences are still upcoming).",
  ].join("\n");
  const h = harness({ "src/render.mjs --gaps": { stdout: rows } });
  runPhase(PHASE1, h.ctx);
  const file = JSON.parse(h.files["data/tmp/gaps.json"]);
  assert.deepEqual(file.keys, ["1632000::exam::exam 1", "1631000::homework::hw 3"]);
  assert.deepEqual(file.gaps.map((g) => g.k), file.keys);
  assert.equal(file.gaps[0].approx, true);
  assert.equal(file.gaps[1].approx, false);
});

test("the snapshot is only taken when the standards plan is on", () => {
  const off = harness({}, { "data/study-plan.json": "{}" });
  runPhase(PHASE1, off.ctx);
  assert.equal(off.ctx.fs.exists("data/tmp/study-plan.pre.json"), false);

  const on = harness({}, { "data/study-plan.json": "{}" }, { cfg: withConfig({ standardsPlan: { enabled: true, course: "MATH 210" } }) });
  runPhase(PHASE1, on.ctx);
  assert.equal(on.files["data/tmp/study-plan.pre.json"], "{}");
});

// ------------------------------------------------------------------ phase 2

test("render=ok quotes the item count, the envelope size and the tier", () => {
  const stdout = "payload v4: 107 items (90 described), 3 announcements\nupload: 6712 chars (budget 12000, tier 1) + brief 800 chars, 20 lines";
  assert.equal(renderToken({ status: 0, stdout }), "render=ok(107;AGD2-6712;tier1)");
  assert.match(renderToken({ status: 1, stderr: "boom" }), /^render=FAILED\(boom\)$/);
});

test("an OVER payload is still a render, and it stops the publish", () => {
  const over = "payload v4: 400 items\nupload: 19000 chars (budget 12000, tier 3, OVER)";
  const h = harness({ "src/render.mjs": { status: 0, stdout: over } });
  h.ctx.state = { ...h.ctx.state, phase1: { scrapeOk: true } };
  const r = runPhase(PHASE2, h.ctx);
  assert.equal(r.tokens.render, "render=ok(400;AGD2-19000;tier3;OVER)");
  assert.equal(r.tokens.drive, "drive=SKIPPED(oversize)");
});

test("a publish quotes drive-rclone's own last line, which IS the token", () => {
  const h = harness({ "src/render.mjs": { status: 0, stdout: "payload v4: 12 items\nupload: 900 chars (budget 12000, tier 0)" } });
  const inner = h.ctx.spawn;
  h.ctx.spawn = (argv, how) => {
    const res = inner(argv, how);
    if (argv[0] === "src/drive-rclone.mjs" && argv[1] === "publish") {
      return { ...res, stdout: `uploading...\n${argv[2] === "mirror" ? "mirror=ok(48KB;rclone;verified)" : "drive=ok(7KB;rclone;verified)"}` };
    }
    return res;
  };
  h.ctx.state = { ...h.ctx.state, phase1: { scrapeOk: true } };
  const r = runPhase(PHASE2, h.ctx);
  assert.equal(r.tokens.drive, "drive=ok(7KB;rclone;verified)");
  assert.equal(r.tokens.mirror, "mirror=ok(48KB;rclone;verified)");

  // a publish that says anything else is a failure, never a quoted stranger
  const odd = harness({ "src/drive-rclone.mjs publish": { status: 1, stderr: "rclone: quota exceeded" } });
  odd.ctx.state = { ...odd.ctx.state, phase1: { scrapeOk: true } };
  assert.equal(runPhase(PHASE2, odd.ctx).tokens.mirror, "mirror=FAILED(rclone:-quota-exceeded)");
});

test("the mirror is packed before it is published, and a bundle over the cap is not a failure", () => {
  const tooBig = harness({ "src/drive-bundle.mjs": { status: 3 } });
  assert.equal(runPhase(PHASE2, tooBig.ctx).tokens.mirror, "mirror=SKIPPED(too-big)");
  assert.equal(tooBig.calls.filter((c) => c[1] === "publish" && c[2] === "mirror").length, 0);

  const off = harness({}, {}, { cfg: withConfig({ drive: { enabled: true, mirror: false } }) });
  assert.equal(runPhase(PHASE2, off.ctx).tokens.mirror, "mirror=SKIPPED(off)");
});

test("the calendar sink is chosen from config: Outlook, else ICS, else none", () => {
  const none = harness();
  assert.equal(calendarStep.run(none.ctx).token, "calendar=SKIPPED(no-sink)");
  assert.equal(none.calls.length, 0);

  // The ICS line ends `file=<path>`, which is a home directory, and a runlog
  // line is the thing a user pastes into an issue: the token keeps the counts.
  const ics = harness(
    { "src/connectors/calendar-ics.mjs": { status: 0, stdout: "[calendar-ics]   note: x\n[calendar-ics] written=4 updated=1 removed=0 file=C:\\Users\\First Last\\agenda.ics" } },
    {},
    { cfg: withConfig({ connectors: { calendar: { ics: { enabled: true } } } }) },
  );
  const icsToken = calendarStep.run(ics.ctx).token;
  assert.equal(icsToken, "calendar=ok(written=4;updated=1;removed=0)");
  assert.equal(/file=|Users/.test(icsToken), false);
  assert.equal(ics.calls[0][0], "src/connectors/calendar-ics.mjs");

  const both = harness(
    { "src/connectors/calendar-outlook.mjs": { status: 2, stdout: "[calendar-outlook] created=1 updated=0 deleted=0 unchanged=9 skipped=0 errors=1 exchangeMode=cached" } },
    {},
    { cfg: withConfig({ connectors: { calendar: { outlook: { enabled: true }, ics: { enabled: true } } } }) },
  );
  assert.equal(calendarStep.run(both.ctx).token, "calendar=PARTIAL(created=1;updated=0;deleted=0;unchanged=9;skipped=0;errors=1)");
  assert.equal(both.calls[0][0], "src/connectors/calendar-outlook.mjs");
});

test("deadman: armed, its own skip line, or a failure", () => {
  const armed = harness({ "src/deadman.mjs": { status: 0, stdout: "[deadman] armed for 2026-09-16 20:30" } });
  assert.equal(runPhase(PHASE2, armed.ctx).tokens.deadman, "deadman=armed");

  const noSink = harness({ "src/deadman.mjs": { status: 0, stdout: "[deadman] deadman=SKIPPED(no-calendar-sink)" } });
  assert.equal(runPhase(PHASE2, noSink.ctx).tokens.deadman, "deadman=SKIPPED(no-calendar-sink)");

  const broken = harness({ "src/deadman.mjs": { status: 1, stdout: "[deadman] could not create the event" } });
  assert.equal(runPhase(PHASE2, broken.ctx).tokens.deadman, "deadman=FAILED([deadman]-could-not-create-the-event)");
});

const digestConfig = () => withConfig({ notifications: { emailDigest: "outlook" } });
const freshDigest = (h, when = "2026-09-15T14:31:00Z") => {
  h.files["data/digest.md"] = "Weekly Agenda - Tuesday\n";
  h.files["data/digest.md.mtime"] = new Date(when);
};

test("the digest is sent only when the model wrote it during THIS run", () => {
  const stale = harness({ "src/send-digest.mjs": { stdout: "digest=sent" } }, {}, { cfg: digestConfig() });
  freshDigest(stale, "2026-09-14T22:40:00Z");
  assert.equal(digestStep.run(stale.ctx).token, "digest=none");
  assert.equal(stale.calls.length, 0);

  const fresh = harness({ "src/send-digest.mjs": { stdout: "digest=sent" } }, {}, { cfg: digestConfig() });
  freshDigest(fresh);
  assert.equal(digestStep.run(fresh.ctx).token, "digest=sent");
  assert.equal(fresh.calls[0].join(" "), `src/send-digest.mjs --since ${NOW}`);
});

test("the digest is SKIPPED(off) with no sink configured and SKIPPED(no-mail-sink) off Windows", () => {
  const off = harness({}, {}, {});
  freshDigest(off);
  assert.equal(digestStep.run(off.ctx).token, "digest=SKIPPED(off)");

  const posix = harness({}, {}, { cfg: digestConfig(), platform: "linux" });
  freshDigest(posix);
  assert.equal(digestStep.run(posix.ctx).token, "digest=SKIPPED(no-mail-sink)");
  assert.equal(posix.calls.length, 0);
});

test("a digest that was sent is never sent twice, even if phase 2 is re-run", () => {
  const h = harness({ "src/send-digest.mjs": { stdout: "digest=sent" } }, {}, { cfg: digestConfig() });
  freshDigest(h);
  const first = digestStep.run(h.ctx);
  assert.equal(first.token, "digest=sent");
  // the window is on disk BEFORE the steps after this one run, so an interrupted
  // phase 2 that the launcher re-runs finds it
  assert.ok(first.state.phase2.digestSentAt);
  assert.ok(JSON.parse(h.files["data/run-state.json"]).phase2.digestSentAt);

  const again = harness({ "src/send-digest.mjs": { stdout: "digest=sent" } }, h.files, { cfg: digestConfig() });
  again.ctx.state = { ...again.ctx.state, phase2: { digestSentAt: first.state.phase2.digestSentAt } };
  assert.equal(digestStep.run(again.ctx).token, "digest=SKIPPED(already-sent)");
  assert.equal(again.calls.length, 0);
});

test("no study plan at all is silent - it is not the same fact as a lost snapshot", () => {
  // Every run of a fresh standards install, up to the first Monday the model
  // writes a plan, has no data/study-plan.json. Saying SKIPPED(no-snapshot)
  // there makes the string mean two things and the real alarm unreadable.
  const cfg = withConfig({ standardsPlan: { enabled: true, course: "MATH 210" } });
  const fresh = harness({}, {}, { cfg });
  assert.equal(fresh.ctx.fs.exists("data/study-plan.json"), false);
  assert.deepEqual(planStep.run(fresh.ctx), {});

  // a plan that EXISTS and will not parse, with no snapshot, is the real alarm
  const broken = harness({}, { "data/study-plan.json": "{ not json" }, { cfg });
  assert.equal(planStep.run(broken.ctx).token, "plan=SKIPPED(no-snapshot)");
});

test("plan puts the pre-run study plan back when the model broke its shape", () => {
  const cfg = withConfig({ standardsPlan: { enabled: true, course: "MATH 210" } });
  const pre = JSON.stringify({ weeks: [{ start: "2026-09-14", focus: ["S1"] }], sittings: [] });

  const unparseable = harness({}, { "data/study-plan.json": "{ not json", "data/tmp/study-plan.pre.json": pre }, { cfg });
  assert.equal(planStep.run(unparseable.ctx).token, "plan=restored(bad-shape)");
  assert.equal(unparseable.files["data/study-plan.json"], pre);

  const noSittings = harness({}, { "data/study-plan.json": JSON.stringify({ weeks: [] }), "data/tmp/study-plan.pre.json": pre }, { cfg });
  assert.equal(noSittings.ctx.fs.exists("data/tmp/study-plan.pre.json"), true);
  assert.equal(planStep.run(noSittings.ctx).token, "plan=restored(bad-shape)");

  const noSnapshot = harness({}, { "data/study-plan.json": "{ not json" }, { cfg });
  assert.equal(planStep.run(noSnapshot.ctx).token, "plan=SKIPPED(no-snapshot)");

  const good = harness({}, { "data/study-plan.json": pre }, { cfg });
  assert.deepEqual(planStep.run(good.ctx), {});

  const dormant = harness({}, { "data/study-plan.json": "{ not json" });
  assert.deepEqual(planStep.run(dormant.ctx), {});
});

test("phase 2 writes the run report and names every failed step", () => {
  const h = harness();
  h.ctx.state.phase1 = {
    tokens: { scrape: "scrape=ok(x)", gcal: "gcal=FAILED(boom)" },
    scrapeOk: true, scrapedAt: "2026-09-15T14:09:00Z", items: 107, previousItems: 108,
  };
  h.ctx.state.phase2 = { tokens: { render: "render=ok(107;AGD2-6712;tier1)", mirror: "mirror=FAILED(quota)" } };
  const rep = buildReport(h.ctx);
  assert.equal(rep.scrapeOk, true);
  assert.equal(rep.items, 107);
  assert.equal(rep.steps.render, "render=ok(107;AGD2-6712;tier1)");
  assert.deepEqual(rep.failed, ["gcal", "mirror"]);
});

// ------------------------------------------------- run state and the runlog

test("readRunState rejects a phase 1 older than 6 hours, accepts one inside it, rejects junk", () => {
  const old = readRunState(JSON.stringify({ runId: "2026-09-15T02:00:00Z", phase1: { finishedAt: "2026-09-15T02:10:00Z" }, phase2: null }));
  assert.equal(old.phase1Fresh(new Date("2026-09-15T14:30:00Z")), false);

  const fresh = readRunState(JSON.stringify({ runId: NOW, phase1: { finishedAt: "2026-09-15T14:33:00Z" }, phase2: null }));
  assert.equal(fresh.phase1Fresh(new Date("2026-09-15T18:00:00Z")), true);
  assert.equal(readRunState("not json"), null);
  assert.equal(readRunState(undefined), null);
});

test("a step that throws is recorded as FAILED and the phase carries on", () => {
  const h = harness();
  const boom = { name: "boom", run: () => { throw new Error("kaboom"); } };
  const r = runPhase([boom, ...PHASE2.filter((s) => s.name === "deadman")], h.ctx);
  assert.match(r.tokens.boom, /^boom=FAILED\(kaboom\)/);
  assert.equal(r.tokens.deadman, "deadman=armed");
});

test("finish line starts with an ISO Z timestamp and fills the llm-absent tokens", () => {
  const h = harness();
  h.ctx.state.phase1 = { tokens: { scrape: "scrape=ok(x)" }, scrapeOk: true };
  h.ctx.state.phase2 = { tokens: { render: "render=ok(1;AGD2-10;tier0)" } };
  const line = finishLine(h.ctx, null);
  assert.match(line, /^2026-09-15T14:30:07Z run=daily\(started-14:30:07-local\)/);
  assert.match(line, /triage=SKIPPED\(llm-absent\) descriptions=SKIPPED\(llm-absent\)/);
  assert.match(line, /verify=SKIPPED\(llm-absent\) push=0\(llm-absent\) llm=absent errors=0$/);
});

test("the finish line carries every token in RUNLOG_ORDER, the model's own included", () => {
  const h = harness();
  h.ctx.state.phase1 = { tokens: { scrape: "scrape=ok(x)", mail: "mail:ok(254-scanned-77-kept)", board: "board=off" }, scrapeOk: true };
  h.ctx.state.phase2 = { tokens: { render: "render=ok(1;AGD2-10;tier0)", drive: "drive=ok(7KB;rclone;verified)" } };
  const line = finishLine(h.ctx, { triage: "+1item,+2mail", descriptions: "descriptions=+3", verify: "ok", push: "0(quiet-hours)" });
  assert.match(line, /scrape=ok\(x\) reauth=not-needed mail:ok\(254-scanned-77-kept\) board=off/);
  assert.match(line, /triage=\+1item,\+2mail descriptions=\+3 render=ok\(1;AGD2-10;tier0\) drive=ok\(7KB;rclone;verified\)/);
  assert.match(line, /verify=ok push=0\(quiet-hours\) llm=ran errors=0$/);
  // every name the line can print is in the published order, and only once
  assert.equal(new Set(RUNLOG_ORDER).size, RUNLOG_ORDER.length);
});

test("every llm-notes value reaches the runlog with no space, newline or run of whitespace", () => {
  const h = harness();
  h.ctx.state.phase1 = { tokens: { scrape: "scrape=ok(x)" }, scrapeOk: true };
  const line = finishLine(h.ctx, { triage: "+1item, +2mail", descriptions: "+3", verify: "ok", push: "1(PHYS 221 Exam 1\nopens Wed)" });
  assert.match(line, /triage=\+1item,-\+2mail/);
  assert.match(line, /push=1\(PHYS-221-Exam-1-opens-Wed\)/);
  const long = finishLine(h.ctx, { verify: `FAILED(${"x".repeat(200)})` });
  assert.equal(long.split(" ").find((t) => t.startsWith("verify=")).length, "verify=".length + 80);
});

test("a failed workorder, gaps, snapshot or report step still reaches the finish line", () => {
  const h = harness();
  const boom = (name) => ({ name, run: () => { throw new Error(`${name} kaboom`); } });
  const r = runPhase([boom("workorder"), boom("gaps"), boom("snapshot"), boom("report")], h.ctx);
  h.ctx.state.phase1 = { tokens: { workorder: r.tokens.workorder, gaps: r.tokens.gaps } };
  h.ctx.state.phase2 = { tokens: { snapshot: r.tokens.snapshot, report: r.tokens.report } };
  const line = finishLine(h.ctx, null);
  for (const name of ["workorder", "gaps", "snapshot", "report"]) assert.match(line, new RegExp(`${name}=FAILED\\(${name}-kaboom\\)`));
  assert.match(line, /errors=4$/);
});

test("trimRunlog caps at 500 and never drops a STALE or an AUTH line", () => {
  assert.deepEqual([...PROTECTED_PREFIXES], ["STALE ", "AUTH "]);
  const lines = [
    "STALE 2026-09-01T00:00:00Z fired=daily reason=missed-daily",
    "AUTH 2026-09-01T01:00:00Z token=MFA-PENDING",
    ...Array.from({ length: 600 }, (_, i) => `2026-09-0${1 + (i % 9)}T00:00:00Z run=daily n=${i}`),
  ];
  const out = trimRunlog(lines, 500);
  assert.equal(out.length, 500);
  assert.equal(out[0].startsWith("STALE "), true);
  assert.equal(out[1].startsWith("AUTH "), true);
  assert.deepEqual(trimRunlog(["STALE a", "AUTH b"], 1), ["STALE a", "AUTH b"]);
});

test("a runlog that exists but will not read is appended to, never rewritten", () => {
  const h = harness();
  const appended = [];
  const written = [];
  h.ctx.fs = { ...h.ctx.fs, read: () => undefined, exists: () => true, append: (p, t) => appended.push([p, t]), write: (p, t) => written.push([p, t]) };
  assert.equal(writeRunlog(h.ctx, "2026-09-15T14:30:07Z run=daily x=1"), "runlog=append-only(read-failed)");
  assert.deepEqual(appended, [["data/runlog.txt", "2026-09-15T14:30:07Z run=daily x=1\n"]]);
  assert.deepEqual(written, []);
});

test("a runlog that reads is rewritten, trimmed, with the new line last", () => {
  const h = harness({}, { "data/runlog.txt": "2026-09-14T10:00:00Z run=daily n=1\n" });
  assert.equal(writeRunlog(h.ctx, "2026-09-15T14:30:07Z run=daily n=2"), null);
  assert.equal(h.files["data/runlog.txt"], "2026-09-14T10:00:00Z run=daily n=1\n2026-09-15T14:30:07Z run=daily n=2\n");
});

test("buildUsageRecord takes the modelUsage entry with the largest outputTokens", () => {
  const rec = buildUsageRecord(
    {
      num_turns: 8,
      total_cost_usd: 0.42,
      modelUsage: { "claude-haiku-4-5": { outputTokens: 13, cacheReadInputTokens: 0 }, "claude-sonnet-5": { outputTokens: 7567, cacheReadInputTokens: 120000 } },
    },
    NOW,
  );
  assert.deepEqual(rec, { runId: NOW, model: "claude-sonnet-5", turns: 8, outputTokens: 7567, outputTokensAll: 7580, cacheRead: 120000, costUsd: 0.42 });
  const one = buildUsageRecord({ num_turns: 8, total_cost_usd: 0.42, modelUsage: { "claude-sonnet-5": { outputTokens: 9123 } } }, NOW);
  assert.equal(one.outputTokensAll, 9123);
  assert.equal(buildUsageRecord(null, "x"), null);
});

// ------------------------------------------------- one token, one word, always

test("every token a full run can emit is one space-free word", () => {
  // The runlog line is read by splitting on spaces. `finishLine` enforces that
  // for the model's own notes; a step token quoting a script's prose - and every
  // one of these quotes one - would break the same readers just as thoroughly.
  const noisy = (stdout, status = 0) => ({ status, stdout });
  const h = harness(
    {
      "src/scrape.mjs": noisy("OK: 97 items, 4 announcements, 2 source(s), 1 source error(s)\nwarn: slow"),
      "src/materials-sync.mjs": noisy("ERROR L5.pdf: 403\nOK: 5 new, 28.5 MB"),
      "src/study-model.mjs": noisy("cannot read data/latest.json - run node src/scrape.mjs first", 1),
      "src/drive-rclone.mjs pull": noisy(JSON.stringify({ error: "auth failed (token expired)" }), 5),
      "src/connectors/gcal-sync.mjs": noisy("feed calendar: 3 event(s) over 1 feed(s)"),
      "src/render.mjs": noisy("render: something went badly wrong, at length", 1),
      "src/drive-bundle.mjs": noisy("pack: the bundle could not be written", 1),
      "src/connectors/calendar-ics.mjs": noisy("[calendar-ics] FAILED: cannot write the file", 1),
      "src/deadman.mjs": noisy("[deadman] the calendar refused the event", 1),
    },
    { "data/gcal-feeds.json": "{}", "data/latest.json": latestJson(NOW) },
    {
      cfg: withConfig({
        calendars: { gcal: { enabled: true } },
        connectors: { materials: { enabled: true }, calendar: { ics: { enabled: true } } },
      }),
    },
  );
  const p1 = runPhase(PHASE1, h.ctx);
  h.ctx.state = { ...h.ctx.state, phase1: { scrapeOk: true } };
  const p2 = runPhase(PHASE2, h.ctx);

  const tokens = { ...p1.tokens, ...p2.tokens };
  assert.ok(Object.keys(tokens).length >= 10);
  for (const [name, token] of Object.entries(tokens)) {
    assert.equal(token.includes(" "), false, `${name} carries a space: ${token}`);
    assert.equal(/[\r\n\t]/.test(token), false, `${name} carries whitespace: ${token}`);
  }
  // and the whole line still splits into exactly as many words as it has tokens
  h.ctx.state = { runId: NOW, startedLocal: "2026-09-15 14:30:07", phase1: { tokens: p1.tokens }, phase2: { tokens: p2.tokens } };
  const line = finishLine(h.ctx, null);
  assert.equal(line.split(" ").length, line.trim().split(/\s+/).length);
});

// -------------------------------------------------------- a broken config

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a config.json that will not parse is one line and exit 3, never a stack", () => {
  withTempDir((dir) => {
    const bad = path.join(dir, "config.json");
    fs.writeFileSync(bad, '{ "timezone": "UTC", }'); // the trailing comma a human leaves behind
    const said = [];
    assert.equal(loadRunConfig(["--config", bad], (m) => said.push(m)), null);
    assert.equal(said.length, 2);
    assert.match(said[0], /^config=FAILED\(config: .*is not valid JSON/);
    assert.equal(said[1], "fix: node scripts/validate-setup.mjs");
    assert.equal(said.join("\n").includes("    at "), false); // no stack frames

    // ... and nothing at all is written on that path
    const dataDir = path.join(dir, "d");
    fs.mkdirSync(dataDir);
    const realErr = console.error;
    console.error = () => {};
    let code;
    try {
      code = main(["--phase", "1", "--config", bad, "--data", dataDir]);
    } finally {
      console.error = realErr;
    }
    assert.equal(code, 3);
    assert.deepEqual(fs.readdirSync(dataDir), []);
  });
});

test("a config.json that is merely ABSENT is not an error - that is a first run", () => {
  withTempDir((dir) => {
    const cfg = loadRunConfig(["--config", path.join(dir, "no-such-config.json")], () => {
      throw new Error("should not have said anything");
    });
    assert.equal(cfg.namespace, "agenda"); // the shipped defaults
  });
});

test("a usage error is still exit 2, and it is reached without reading any config", () => {
  withTempDir((dir) => {
    const bad = path.join(dir, "config.json");
    fs.writeFileSync(bad, "{ not json at all");
    const realLog = console.log;
    console.log = () => {};
    let code;
    try {
      code = main(["--bogus", "--config", bad]);
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 2);
  });
});

// ------------------------------------------------------------- passthrough

test("the run's --config and --data flags reach every single spawn", () => {
  const pass = ["--config", "/tmp/c.json", "--data", "/tmp/d"];
  const h = harness(
    {
      "src/drive-rclone.mjs pull": { stdout: JSON.stringify({ docs: [{ id: "A1", path: "/tmp/d/tmp/a1.txt" }] }) },
      "src/completion.mjs --ingest": { stdout: "doc 1: ok - v2, 1 mark(s), 0 cleared\ningest: 1 doc(s) consumed, 0 skipped; 1 new mark(s)" },
      "src/connectors/gcal-sync.mjs": { stdout: "feed=calendar 1 event(s)" },
    },
    { "data/gcal-feeds.json": "{}", "data/study-plan.json": "{}", "data/digest.md": "x" },
    { cfg: withConfig({ calendars: { gcal: { enabled: true } }, connectors: { materials: { enabled: true }, calendar: { ics: { enabled: true } } }, notifications: { emailDigest: "outlook" } }) },
  );
  h.ctx.passthrough = pass;
  h.files["data/digest.md.mtime"] = new Date("2026-09-15T14:31:00Z");
  runPhase(PHASE1, h.ctx);
  h.ctx.state = { ...h.ctx.state, phase1: { scrapeOk: true } };
  runPhase(PHASE2, h.ctx);
  assert.ok(h.calls.length > 10);
  for (const argv of h.calls) assert.deepEqual(argv.slice(-4), pass, `missing passthrough: ${argv.join(" ")}`);
});
