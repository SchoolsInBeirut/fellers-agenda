/* The inbound calendar, ROUTE A: `src/connectors/gcal-sync.mjs`. The feeds file,
 * the transport, stale tolerance, the exit codes and the one token the pipeline
 * reads off the last stdout line.
 *
 * The RFC 5545 parsing is `test/ics-parse.test.mjs`'s problem and the record
 * shape is `test/gcal-normalize.test.mjs`'s; what is tested here is the CLI
 * around them.
 *
 * NOTHING HERE REACHES THE NETWORK OR TOUCHES data/. The transport is injected -
 * `run(argv, {fetchImpl})` takes a function, and the tests hand it one - so no
 * socket is ever opened, not even a loopback one. Every subprocess run gets its
 * own `mkdtemp` directory through `--data`, and every feed that is not fetched
 * comes off disk through `--from-file`.
 *
 * THE COMPATIBILITY TEST at the bottom is the one that matters most: route A and
 * route B (`gcal-ingest.mjs`) write the SAME document, and `src/render.mjs` and
 * `src/focus-engine.mjs` read it without knowing which ran. So the two outputs
 * are built from the same calendar and compared key for key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { staleEventsFor as ingestStaleEventsFor, summaryLine as ingestSummaryLine } from "../src/connectors/gcal-ingest.mjs";
import { repoRoot } from "../src/lib/paths.mjs";
import {
  EXIT,
  FEEDS_NAME,
  SOURCE_FEED,
  STALE_MAX_MS,
  collateFeeds,
  eventsFromText,
  feedFingerprint,
  fetchIcsText,
  hostOf,
  inspectFeeds,
  normalizeFeeds,
  parseArgs,
  resolveFeed,
  rootOf,
  run,
  scrub,
  summaryLine,
  tokenLine,
  tokenText,
} from "../src/connectors/gcal-sync.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "src", "connectors", "gcal-sync.mjs");
const FIXTURES = join(ROOT, "fixtures", "gcal");
const INGEST = join(ROOT, "src", "connectors", "gcal-ingest.mjs");

const NOW = "2026-09-03T18:00:00.000Z";
const TZ = "America/New_York";
const WINDOW = { from: "2026-09-02", to: "2026-09-24" };
/** A plausible secret address. The token in it must never reach any output. */
const FEED_URL = "https://calendar.example.test/ical/private-notarealtoken/basic.ics";

const CRLF = "\r\n";
const ics = (...lines) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", ...lines.flat(), "END:VCALENDAR"].join(CRLF) + CRLF;
const vevent = (...lines) => ["BEGIN:VEVENT", ...lines.flat(), "END:VEVENT"];

// ------------------------------------------------------------------ harness

function workspace(t, gcal = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agenda-gcal-sync-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      namespace: "agenda",
      timezone: TZ,
      calendars: { gcal: { enabled: true, feed: "calendar", label: "Calendar", ...gcal } },
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const writeFeeds = (dir, feeds, wrap = (f) => ({ v: 1, feeds: f })) => {
  const p = join(dir, FEEDS_NAME);
  writeFileSync(p, JSON.stringify(wrap(feeds), null, 2));
  return p;
};

const writeIcs = (dir, name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

/** Run the real script as a subprocess. The exit code IS part of the contract. */
function cli(dir, args = [], { now = NOW, script = SCRIPT } = {}) {
  const r = spawnSync(process.execPath, [script, "--config", join(dir, "config.json"), "--data", dir, "--now", now, ...args], {
    encoding: "utf-8",
    timeout: 30000,
  });
  const stdout = r.stdout ?? "";
  const lines = stdout.trimEnd().split("\n");
  return {
    code: r.status,
    signal: r.signal ?? null,
    stdout,
    stderr: r.stderr ?? "",
    last: lines[lines.length - 1] ?? "",
    outPath: join(dir, "gcal-items.json"),
    exists: () => existsSync(join(dir, "gcal-items.json")),
    read: () => JSON.parse(readFileSync(join(dir, "gcal-items.json"), "utf-8")),
  };
}

/** Call `run()` in-process with an injected transport, capturing what it prints. */
async function inProcess(dir, args, fetchImpl) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    const code = await run(["--config", join(dir, "config.json"), "--data", dir, "--now", NOW, ...args], {
      root: dir,
      fetchImpl,
    });
    return { code, out, err, last: out[out.length - 1] ?? "" };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** The shape `fetchIcsText` expects back, without a socket anywhere near it. */
const response = (body, { status = 200, contentType = "text/calendar" } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
  text: async () => body,
});

/** A previous output file, for the stale-tolerance cases. */
function writePrevious(dir, { fetchedAt, events, status = "ok" }) {
  writeFileSync(
    join(dir, "gcal-items.json"),
    JSON.stringify({
      v: 1,
      generatedAt: fetchedAt,
      tz: TZ,
      window: WINDOW,
      feeds: [
        { id: "calendar", label: "Calendar", status, source: SOURCE_FEED, fetchedAt, events: events.length, skippedOwn: 0, warnings: [], error: null },
      ],
      events,
    }),
  );
}

const meeting = (n, day) => ({
  k: `calendar|u${n}@t|2026-09-${day}T10:00:00.000Z`,
  feed: "calendar",
  lbl: "Calendar",
  t: `Meeting ${n}`,
  s: `2026-09-${day}T10:00:00.000Z`,
  e: `2026-09-${day}T11:00:00.000Z`,
  ad: false,
  loc: null,
  desc: null,
  free: false,
  url: null,
});

// ======================================================= the feeds file

test("normalizeFeeds accepts a good file and never handles a bad one silently", () => {
  const ok = normalizeFeeds({
    v: 1,
    feeds: [{ id: "work", label: "Work", url: FEED_URL, skipUidSuffix: "@agenda.local" }],
  });
  assert.equal(ok.error, null);
  assert.deepEqual(ok.feeds, [{ id: "work", label: "Work", url: FEED_URL, skipUidSuffix: "@agenda.local" }]);

  // Actively wrong is an ERROR: ignoring it would hide a calendar the user
  // believes is connected, and an empty grid looks exactly like a free week.
  assert.ok(normalizeFeeds({ feeds: [{ id: "BAD ID", url: FEED_URL }] }).error);
  assert.ok(normalizeFeeds({ feeds: [{ id: "a", url: "http://insecure.test/x" }] }).error);
  assert.ok(normalizeFeeds({ feeds: [{ id: "a", url: FEED_URL }, { id: "a", url: FEED_URL }] }).error);
  assert.ok(normalizeFeeds({ feeds: [null] }).error);
  assert.ok(normalizeFeeds({ feeds: "nope" }).error);
  assert.ok(normalizeFeeds([]).error);
  assert.ok(normalizeFeeds(null).error);
});

test("the reserved feed id `fb` is refused, by the loader's own rule", () => {
  // `fb|<day>|<bucket>` already names study sessions, and `isSessKey()` is a
  // three-character test that nothing downstream re-checks. src/lib/config.mjs
  // owns that rule; this file asks it rather than keeping a second regex.
  const why = normalizeFeeds({ feeds: [{ id: "fb", url: FEED_URL }] }).error;
  assert.ok(why, "a feed called fb must not be accepted");
  assert.ok(why.includes("reserved"), why);
});

test("an empty url is a SKIP, not an error - the user has not filled it in yet", () => {
  const empty = normalizeFeeds({ feeds: [{ id: "a", label: "A", url: "" }] });
  assert.equal(empty.error, null);
  assert.deepEqual(empty.feeds, []);
  assert.deepEqual(normalizeFeeds({}).feeds, []);
});

test("an over-long label is trimmed; an absent one stays null so config can fill it", () => {
  const long = normalizeFeeds({ feeds: [{ id: "a", label: "L".repeat(40), url: FEED_URL }] });
  assert.equal(long.feeds[0].label.length, 24);
  assert.equal(normalizeFeeds({ feeds: [{ id: "a", url: FEED_URL }] }).feeds[0].label, null);
  assert.equal(normalizeFeeds({ feeds: [{ id: "a", url: FEED_URL }] }).feeds[0].skipUidSuffix, null);
});

test("resolveFeed falls back to calendars.gcal for the feed that config names", () => {
  const ctx = { feedId: "calendar", label: "Calendar", guards: { skipUidSuffix: "@agenda.agenda.local", skipDescriptionMarker: "M" } };
  const named = resolveFeed({ id: "calendar", label: null, url: FEED_URL, skipUidSuffix: null }, ctx);
  assert.equal(named.label, "Calendar");
  assert.deepEqual(named.guards, ctx.guards);
  // a SECOND feed names itself rather than borrowing the configured label
  assert.equal(resolveFeed({ id: "other", label: null, url: FEED_URL, skipUidSuffix: null }, ctx).label, "other");
  // and a per-feed suffix wins, including "" - which switches that guard off
  assert.equal(resolveFeed({ id: "x", label: null, url: FEED_URL, skipUidSuffix: "@mine" }, ctx).guards.skipUidSuffix, "@mine");
  assert.equal(resolveFeed({ id: "x", label: null, url: FEED_URL, skipUidSuffix: "" }, ctx).guards.skipUidSuffix, "");
  assert.equal(
    resolveFeed({ id: "x", label: null, url: FEED_URL, skipUidSuffix: "" }, ctx).guards.skipDescriptionMarker,
    "M",
    "switching one guard off must not switch the other off too",
  );
});

// ====================================================== the url is a secret

test("a feed url never survives a log line: only host and fingerprint do", () => {
  const url = "https://calendar.example.test/ical/x%40someone.test/private-supersecret/basic.ics";
  assert.equal(hostOf(url), "calendar.example.test");
  assert.equal(hostOf("not a url"), "?");
  const fp = feedFingerprint(url);
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.equal(fp, feedFingerprint(url), "the fingerprint is stable, so a log line can be followed");
  assert.notEqual(fp, feedFingerprint(`${url}2`));
  assert.equal(scrub(`request to ${url} failed`).includes("supersecret"), false);
  assert.equal(scrub(`request to ${url} failed`).includes("<url>"), true);
  assert.equal(scrub("plain message"), "plain message");
});

test("tokenText leaves nothing in a token that could split a runlog field", () => {
  assert.equal(tokenText("request failed (getaddrinfo ENOTFOUND)"), "request-failed-getaddrinfo-ENOTFOUND");
  assert.equal(tokenText(`fetch of ${FEED_URL} failed`).includes("notarealtoken"), false);
  assert.equal(/[\s()]/.test(tokenText("a (b) c")), false);
  assert.equal(tokenText(""), "error");
  assert.ok(tokenText("x".repeat(200)).length <= 60);
});

// ================================================================ arguments

test("parseArgs reads every documented flag and rejects a malformed --from-file", () => {
  const a = parseArgs(
    ["--dry-run", "--now", "2026-09-03T18:10:00Z", "--from-file", "work=/tmp/a.ics", "--feeds", "/tmp/f.json", "--out", "/tmp/o.json"],
    { feedsPath: "/default/f.json", outPath: "/default/o.json" },
  );
  assert.equal(a.dryRun, true);
  assert.equal(a.now.toISOString(), "2026-09-03T18:10:00.000Z");
  assert.equal(a.fromFile.get("work"), "/tmp/a.ics");
  assert.equal(a.feedsPath, "/tmp/f.json");
  assert.equal(a.outPath, "/tmp/o.json");
  assert.equal(a.error, null);
  assert.equal(parseArgs(["--validate"]).validate, true);
  assert.equal(parseArgs(["--help"]).help, true);
  // --config and --data belong to lib/paths.mjs and are skipped, not refused
  assert.equal(parseArgs(["--config", "/a.json", "--data", "/d", "--data=/e"]).error, null);
  assert.ok(parseArgs(["--from-file", "nonsense"]).error);
  assert.ok(parseArgs(["--now", "never"]).error);
  assert.ok(parseArgs(["--nonsense"]).error);
});

// ============================================================== the transport

test("the transport is injected: a good body comes back, and each failure is a FeedError", async () => {
  const body = ics(vevent("UID:http@t", "DTSTART:20260904T190000Z", "SUMMARY:Over the wire"));
  assert.equal(await fetchIcsText(FEED_URL, { fetchImpl: async () => response(body) }), body);

  const rejects = (fetchImpl, re) =>
    assert.rejects(() => fetchIcsText(FEED_URL, { fetchImpl }), (e) => e.name === "FeedError" && re.test(e.message));
  await rejects(async () => response("nope", { status: 404, contentType: "text/plain" }), /HTTP 404/);
  await rejects(async () => response('{"not":"a calendar"}', { contentType: "application/json" }), /content-type/);
  await rejects(async () => {
    throw new Error(`getaddrinfo ENOTFOUND for ${FEED_URL}`);
  }, /request failed/);
  await rejects(async () => ({ ok: true, status: 200, headers: { get: () => "text/calendar" }, text: async () => {
    throw new Error("socket hang up");
  } }), /body could not be read/);
  await rejects(undefined, /no fetcher available/);
});

test("a network error never carries the url into the message", async () => {
  await assert.rejects(
    () => fetchIcsText(FEED_URL, { fetchImpl: async () => {
      throw new Error(`request to ${FEED_URL} failed`);
    } }),
    (e) => !e.message.includes("notarealtoken") && e.message.includes("<url>"),
  );
});

test("a sign-in page with a cheerful 200 is a feed FAILURE, not an empty calendar", async () => {
  // What an expired or reset secret address actually returns. text/html passes
  // the content-type gate, so only the body check catches it - and anything that
  // trusted the status code would write an empty calendar and call it success.
  const html = readFileSync(join(FIXTURES, "expired-address.html"), "utf-8");
  const text = await fetchIcsText(FEED_URL, { fetchImpl: async () => response(html, { contentType: "text/html" }) });
  assert.throws(
    () => eventsFromText(text, { id: "calendar", label: "Calendar", guards: {} }, { tz: TZ, window: WINDOW }),
    (e) => e.name === "FeedError" && /VCALENDAR/.test(e.message),
  );
});

test("a fetched feed reaches the output file, with the transport injected", async (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const seen = [];
  const r = await inProcess(dir, [], async (url, init) => {
    seen.push({ url, agent: init?.headers?.["user-agent"] });
    return response(readFileSync(join(FIXTURES, "sample-feed.ics"), "utf-8"));
  });
  assert.equal(r.code, EXIT.ok, r.err.join("\n"));
  assert.deepEqual(
    seen.map((s) => s.url),
    [FEED_URL],
    "the url is passed to the transport and nowhere else",
  );
  assert.ok(seen[0].agent, "and a user-agent goes with it");
  assert.equal(r.last, "gcal=ok(10-events;1-feeds)");
  const data = JSON.parse(readFileSync(join(dir, "gcal-items.json"), "utf-8"));
  assert.equal(data.events.length, 10);
  assert.equal(data.feeds[0].skippedOwn, 1, "the agenda's own deadline is not re-imported");
});

// ========================================================= collate and summary

test("collateFeeds dedupes, sorts, caps, and tells every feed what it SHIPPED", () => {
  const many = Array.from({ length: 205 }, (_, i) => meeting(i, String((i % 20) + 3).padStart(2, "0")));
  const entries = [{ id: "calendar", label: "Calendar", status: "stale", events: 205, warnings: [] }];
  const { feeds, events } = collateFeeds(entries, many, 200);
  assert.equal(events.length, 200);
  assert.equal(feeds[0].events, 200, "the reported count must match what actually shipped, stale or not");
  assert.ok(feeds[0].warnings.some((w) => w.includes("cap")), "and the drop is named");
  // a duplicate key keeps the LAST record
  const dupe = collateFeeds([{ id: "calendar", warnings: [] }], [{ ...meeting(1, "05"), t: "first" }, { ...meeting(1, "05"), t: "last" }], 200);
  assert.deepEqual(dupe.events.map((e) => e.t), ["last"]);
  assert.equal(dupe.feeds[0].events, 1);
});

test("the token is space-free and says what happened; the summary line is for people", () => {
  const output = { window: WINDOW, events: [meeting(1, "05")], feeds: [{ id: "calendar", status: "ok", skippedOwn: 2, warnings: ["w"] }] };
  assert.equal(tokenLine(output), "gcal=ok(1-events;1-feeds)");
  assert.equal(
    summaryLine(output),
    "[gcal-sync] feeds=1 ok=1 stale=0 failed=0 events=1 skippedOwn=2 warnings=1 window=2026-09-02..2026-09-24",
  );
  const partial = { ...output, events: [], feeds: [{ id: "a", status: "stale", warnings: [] }, { id: "b", status: "failed", warnings: [] }] };
  assert.equal(tokenLine(partial), "gcal=PARTIAL(0-events;2-feeds;stale=1,failed=1)");
  assert.equal(/\s/.test(tokenLine(partial)), false, "a token with a space in it splits a runlog field in two");
});

test("STALE_MAX_MS is 48 hours, the same tolerance route B uses", () => {
  assert.equal(STALE_MAX_MS, 48 * 3600 * 1000);
});

// ========================================================== exit codes, CLI

test("exit 0: --from-file reads a feed off disk, writes the file, prints the token last", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL, skipUidSuffix: "@agenda.local" }]);
  const fixture = writeIcs(
    dir,
    "feed.ics",
    ics(
      vevent("UID:one@t", "DTSTART:20260904T190000Z", "DTEND:20260904T200000Z", "SUMMARY:Sprint planning", "LOCATION:Meeting room"),
      vevent("UID:own@agenda.local", "DTSTART:20260904T130000Z", "SUMMARY:Problem set due"),
    ),
  );
  const r = cli(dir, ["--from-file", `calendar=${fixture}`]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const data = r.read();
  assert.deepEqual(data.window, WINDOW);
  assert.equal(data.tz, TZ);
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].t, "Sprint planning");
  assert.equal(data.events[0].loc, "Meeting room");
  assert.equal(data.feeds[0].status, "ok");
  assert.equal(data.feeds[0].source, SOURCE_FEED);
  assert.equal(data.feeds[0].skippedOwn, 1);
  assert.equal(data.feeds[0].error, null);
  assert.equal(r.last, "gcal=ok(1-events;1-feeds)");
  assert.ok(r.stdout.includes("[gcal-sync] feeds=1 ok=1 stale=0 failed=0 events=1 skippedOwn=1 warnings=0 window="), r.stdout);
  // the file is pretty JSON ending in a newline, and never carries the url
  const raw = readFileSync(r.outPath, "utf-8");
  assert.ok(raw.endsWith("\n"));
  assert.equal(raw.includes("notarealtoken"), false);
  assert.equal((r.stdout + r.stderr).includes("notarealtoken"), false);
});

test("exit 0: the route off writes nothing at all and says so in one token", (t) => {
  const dir = workspace(t, { enabled: false });
  writeFeeds(dir, [{ id: "calendar", url: FEED_URL }]);
  const r = cli(dir);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.last, "gcal=SKIPPED(disabled)");
  assert.equal(r.exists(), false, "a step that fires while the route is off must cost nothing");
});

test("exit 2: no feeds file - an honest EMPTY document is written anyway", (t) => {
  const dir = workspace(t);
  const r = cli(dir);
  assert.equal(r.code, EXIT.noFeeds);
  assert.equal(r.code, 2);
  assert.ok(r.stdout.includes("[gcal-sync] no feeds configured"), r.stdout);
  const data = r.read();
  assert.deepEqual(data.feeds, []);
  assert.deepEqual(data.events, []);
  assert.equal(data.v, 1);
  assert.equal(data.tz, TZ);
  assert.equal(r.last, "gcal=SKIPPED(no-feeds)");
});

test("exit 2: an empty feeds[] is a skip, and so is a feed whose url is blank", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, []);
  assert.equal(cli(dir).code, EXIT.noFeeds);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: "" }]);
  const b = cli(dir);
  assert.equal(b.code, EXIT.noFeeds);
  assert.deepEqual(b.read().events, []);
});

test("exit 1: a malformed feeds file is a hard failure that writes nothing", (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, FEEDS_NAME), "{ this is not json");
  const r = cli(dir);
  assert.equal(r.code, EXIT.error);
  assert.equal(r.code, 1);
  assert.equal(r.exists(), false, "the previous file is left exactly as it was");
  assert.ok(r.stderr.includes("[gcal-sync] error"), r.stderr);
  assert.match(r.last, /^gcal=FAILED\(\S+\)$/);
});

test("exit 1: a non-https url is refused, and the url is nowhere in the refusal", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", url: "http://insecure.test/private-notarealtoken/basic.ics" }]);
  const r = cli(dir);
  assert.equal(r.code, EXIT.error);
  assert.equal((r.stdout + r.stderr).includes("notarealtoken"), false);
});

test("exit 1: a bad argument is refused before anything is read", (t) => {
  const dir = workspace(t);
  const r = cli(dir, ["--nonsense"]);
  assert.equal(r.code, EXIT.error);
  assert.match(r.last, /^gcal=FAILED\(/);
  assert.equal(r.exists(), false);
});

test("exit 3 stale: a failed feed keeps events younger than 48 h and says so", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fetchedAt = "2026-09-03T06:00:00.000Z"; // twelve hours before --now
  writePrevious(dir, { fetchedAt, events: [meeting(1, "04")] });
  const r = cli(dir, ["--from-file", `calendar=${join(dir, "missing.ics")}`]);
  assert.equal(r.code, EXIT.partial);
  assert.equal(r.code, 3);
  const data = r.read();
  assert.equal(data.feeds[0].status, "stale");
  assert.equal(data.feeds[0].fetchedAt, fetchedAt, "the ORIGINAL time, so the age stays honest");
  assert.equal(data.events.length, 1);
  assert.ok(data.feeds[0].error.includes("12h ago"), data.feeds[0].error);
  assert.equal(r.last, "gcal=PARTIAL(1-events;1-feeds;stale=1,failed=0)");
});

test("exit 3 failed: previous data older than 48 h is not kept", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  writePrevious(dir, { fetchedAt: "2026-08-31T06:00:00.000Z", events: [meeting(1, "04")] });
  const r = cli(dir, ["--from-file", `calendar=${join(dir, "missing.ics")}`]);
  assert.equal(r.code, EXIT.partial);
  const data = r.read();
  assert.equal(data.feeds[0].status, "failed");
  assert.deepEqual(data.events, []);
  assert.equal(r.last, "gcal=PARTIAL(0-events;1-feeds;stale=0,failed=1)");
});

test("a clock that stepped BACKWARD does not disable stale tolerance", (t) => {
  // A negative age is data from the FUTURE, not data that is too old. Throwing
  // it away would blank the user's meetings for exactly the reason stale
  // tolerance exists, triggered by an NTP correction rather than by anything real.
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  writePrevious(dir, { fetchedAt: "2026-09-03T20:00:00.000Z", events: [meeting(1, "04")] });
  const r = cli(dir, ["--from-file", `calendar=${join(dir, "missing.ics")}`]);
  assert.equal(r.code, EXIT.partial);
  assert.equal(r.read().feeds[0].status, "stale");
  assert.equal(r.read().events.length, 1, "the meetings survive a backward clock step");
});

test("exit 3: a body that is not an iCalendar document is a feed failure, not a crash", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fixture = writeIcs(dir, "feed.ics", readFileSync(join(FIXTURES, "expired-address.html"), "utf-8"));
  const r = cli(dir, ["--from-file", `calendar=${fixture}`]);
  assert.equal(r.code, EXIT.partial);
  assert.ok(r.read().feeds[0].error.includes("VCALENDAR"), r.read().feeds[0].error);
});

test("--dry-run prints the summary and the token and writes nothing", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fixture = writeIcs(dir, "feed.ics", ics(vevent("UID:one@t", "DTSTART:20260904T190000Z", "SUMMARY:X")));
  const r = cli(dir, ["--from-file", `calendar=${fixture}`, "--dry-run"]);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.exists(), false);
  assert.equal(r.last, "gcal=ok(1-events;1-feeds)");
});

test("--validate prints the ids and hosts, never a url, and writes nothing", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const r = cli(dir, ["--validate"]);
  assert.equal(r.code, EXIT.ok);
  assert.ok(r.stdout.includes("calendar"), r.stdout);
  assert.ok(r.stdout.includes("calendar.example.test"), r.stdout);
  assert.equal(r.stdout.includes("notarealtoken"), false);
  assert.equal(r.exists(), false);
  assert.equal(r.last, "gcal=ok(validate;1-feeds)");
});

test("--validate on an unparseable file still says WHY, scrubbed, and exits 1", (t) => {
  // This is the command docs/TROUBLESHOOTING.md sends a user to after a
  // gcal=FAILED, and the commonest cause of that token is the feeds file. A
  // diagnostic that refused the same way the run did would tell them nothing
  // they did not already know.
  const dir = workspace(t);
  writeFileSync(join(dir, FEEDS_NAME), `{{{ "url": "${FEED_URL}"`);
  const r = cli(dir, ["--validate"]);
  assert.equal(r.code, EXIT.error);
  assert.ok(r.stderr.includes("not valid JSON"), r.stderr);
  assert.equal((r.stdout + r.stderr).includes("notarealtoken"), false, "a JSON error quotes the input; the input is a secret");
  assert.match(r.last, /^gcal=FAILED\(validate;\S+\)$/);
  assert.equal(r.exists(), false);
});

test("--validate lists the readable feeds BESIDE the problems, and exits 1", (t) => {
  // The old branch stopped at the first bad entry and printed no feed list at
  // all, so a user with one typo among four calendars learned nothing about the
  // other three.
  const dir = workspace(t);
  writeFeeds(dir, [
    { id: "calendar", label: "Calendar", url: FEED_URL },
    { id: "fb", label: "Reserved", url: FEED_URL },
    { id: "team", label: "Team", url: `${FEED_URL}2` },
    { id: "team", label: "Duplicate", url: `${FEED_URL}3` },
    { id: "later", label: "Not set up yet", url: "" },
    { id: "plain", label: "Insecure", url: "http://insecure.test/x" },
  ]);
  const r = cli(dir, ["--validate"]);
  assert.equal(r.code, EXIT.error);
  for (const id of ["calendar", "team", "later"]) {
    assert.ok(r.stdout.includes(`feed ${id} `), `${id} is readable and must still be listed:\n${r.stdout}`);
  }
  assert.ok(r.stdout.includes("no url yet"), "an unfilled feed is named as unfilled, not hidden");
  assert.ok(r.stderr.includes("reserved"), r.stderr);
  assert.ok(r.stderr.includes("duplicate feed id"), r.stderr);
  assert.ok(r.stderr.includes("must be https"), r.stderr);
  assert.ok(r.stdout.includes("3 problem(s), 2 usable feed(s)"), r.stdout);
  assert.equal((r.stdout + r.stderr).includes("notarealtoken"), false);
  assert.equal(r.exists(), false);
});

test("--validate works while the route is OFF, and says the route is off", (t) => {
  // Turning `enabled` on is step one and filling the file in is step two; a user
  // doing them in the other order must be able to check their work.
  const dir = workspace(t, { enabled: false });
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const r = cli(dir, ["--validate"]);
  assert.equal(r.code, EXIT.ok);
  assert.ok(r.stdout.includes("calendar.example.test"), r.stdout);
  assert.ok(r.stdout.includes("the route is OFF"), r.stdout);
  assert.ok(r.stdout.includes("calendars.gcal.enabled"), r.stdout);
  assert.equal(r.last, "gcal=ok(validate;1-feeds)");
  assert.equal(r.exists(), false);
});

test("--validate with no feeds file says route A is not set up, and exits 0", (t) => {
  // Route B is a legitimate way to run, so the absence of the file is not a
  // problem to report - it is an answer.
  const dir = workspace(t);
  const r = cli(dir, ["--validate"]);
  assert.equal(r.code, EXIT.ok);
  assert.ok(r.stdout.includes("no feeds file at"), r.stdout);
  assert.ok(r.stdout.includes("route A is not set up"), r.stdout);
  assert.equal(r.last, "gcal=ok(validate;0-feeds)");
  assert.equal(r.exists(), false);
});

test("inspectFeeds keeps going where normalizeFeeds stops at the first problem", () => {
  const raw = {
    v: 1,
    feeds: [{ id: "good", url: FEED_URL }, { id: "fb", url: FEED_URL }, { id: "also-good", url: `${FEED_URL}2` }, 7],
  };
  const scan = inspectFeeds(raw);
  assert.deepEqual(scan.feeds.map((f) => f.id), ["good", "also-good"]);
  assert.equal(scan.problems.length, 2);
  assert.ok(scan.problems[0].includes("reserved"), scan.problems[0]);
  assert.ok(scan.problems[1].includes("entry 3 is not an object"), scan.problems[1]);
  // the strict reader the RUN uses is unchanged: first problem, no feeds
  const strict = normalizeFeeds(raw);
  assert.deepEqual(strict.feeds, []);
  assert.equal(strict.error, scan.problems[0]);
  // and a structurally broken file is one problem, not a crash
  assert.deepEqual(inspectFeeds(null), { feeds: [], problems: ["feeds file is not an object"] });
  assert.equal(inspectFeeds({ feeds: "nope" }).problems.length, 1);
  // an unfilled feed is visible to --validate and invisible to the run
  assert.deepEqual(inspectFeeds({ feeds: [{ id: "later", url: "" }] }).feeds.map((f) => f.id), ["later"]);
  assert.deepEqual(normalizeFeeds({ feeds: [{ id: "later", url: "" }] }).feeds, []);
});

test("the data directory hangs off the REPO root, never the working directory", () => {
  // `cd src/connectors && node gcal-sync.mjs` must not read and write
  // src/connectors/data/. It is invisible from the pipeline, which spawns with
  // cwd already at the root, which is exactly why it needs pinning here.
  assert.equal(rootOf(), repoRoot());
  assert.equal(rootOf({}), repoRoot());
  assert.equal(rootOf({ root: "/elsewhere" }), "/elsewhere", "and the seam a test points at a mkdtemp dir still works");
  assert.equal(join(rootOf(), "data"), join(ROOT, "data"));
  // The prose above `rootOf` names `process.cwd()` to say what it is NOT, so the
  // guard reads the CODE rather than the comments.
  const code = readFileSync(SCRIPT, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(code.includes("process.cwd("), false, "every other CLI in this repo resolves from repoRoot()");
});

test("--help explains itself and exits 0 without reading anything", (t) => {
  const dir = workspace(t);
  const r = cli(dir, ["--help"]);
  assert.equal(r.code, EXIT.ok);
  assert.ok(r.stdout.includes("gcal-sync.mjs"), r.stdout);
  assert.equal(r.exists(), false);
});

test("the output is rewritten from scratch: yesterday's events do not survive a good run", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  writePrevious(dir, { fetchedAt: "2026-09-03T06:00:00.000Z", events: [meeting(9, "04")] });
  const fixture = writeIcs(dir, "feed.ics", ics(vevent("UID:one@t", "DTSTART:20260904T190000Z", "SUMMARY:Fresh")));
  const r = cli(dir, ["--from-file", `calendar=${fixture}`]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(r.read().events.map((e) => e.t), ["Fresh"]);
});

test("warnings from the parser reach the feed entry, the summary count and nothing else", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fixture = writeIcs(
    dir,
    "feed.ics",
    ics(vevent("UID:warn0001@t", "DTSTART:20260904T190000Z", "RRULE:FREQ=DAILY;BYSETPOS=1", "SUMMARY:X")),
  );
  const r = cli(dir, ["--from-file", `calendar=${fixture}`]);
  assert.equal(r.code, EXIT.ok);
  const data = r.read();
  assert.equal(data.feeds[0].warnings.length, 1);
  assert.ok(data.feeds[0].warnings[0].includes("BYSETPOS"));
  assert.match(r.stdout, / warnings=1 /);
});

test("an unsatisfiable RRULE terminates the run rather than wedging it", (t) => {
  // Every one of these yields zero candidates in every period. Before the bound
  // counted empty periods the run never finished and never wrote a file.
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  for (const rrule of ["FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=WEEKLY;BYMONTH=13", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"]) {
    const fixture = writeIcs(
      dir,
      "hang.ics",
      ics(vevent("UID:hang@t", "DTSTART;TZID=America/New_York:20260907T090000", `RRULE:${rrule}`, "SUMMARY:Malformed")),
    );
    const r = cli(dir, ["--from-file", `calendar=${fixture}`]);
    assert.equal(r.signal, null, `${rrule}: the process had to be killed - it never terminated`);
    assert.equal(r.code, EXIT.ok, `${rrule}: expected a clean exit, got ${r.code}\n${r.stderr}`);
    assert.equal(r.read().events.length, 1, `${rrule}: DTSTART is still an instance of its own rule`);
  }
});

test("two feeds are independent: one can fail while the other ships", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [
    { id: "calendar", label: "Calendar", url: FEED_URL },
    { id: "team", label: "Team", url: `${FEED_URL}2` },
  ]);
  const good = writeIcs(dir, "good.ics", ics(vevent("UID:one@t", "DTSTART:20260904T190000Z", "SUMMARY:Ships")));
  const r = cli(dir, ["--from-file", `calendar=${good}`, "--from-file", `team=${join(dir, "missing.ics")}`]);
  assert.equal(r.code, EXIT.partial);
  const data = r.read();
  assert.equal(data.feeds.length, 2);
  assert.equal(data.feeds.find((f) => f.id === "calendar").status, "ok");
  assert.equal(data.feeds.find((f) => f.id === "team").status, "failed");
  assert.deepEqual(data.events.map((e) => e.feed), ["calendar"]);
  assert.equal(r.last, "gcal=PARTIAL(1-events;2-feeds;stale=0,failed=1)");
  assert.equal(data.feeds.find((f) => f.id === "team").label, "Team");
});

test("one clock: generatedAt and every fetchedAt are the same instant", (t) => {
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fixture = writeIcs(dir, "feed.ics", ics(vevent("UID:one@t", "DTSTART:20260904T190000Z", "SUMMARY:X")));
  const data = cli(dir, ["--from-file", `calendar=${fixture}`]).read();
  assert.equal(data.generatedAt, NOW);
  assert.equal(data.feeds[0].fetchedAt, NOW, "two clocks in one file is one clock too many");
});

test("calendars.gcal.maxEvents is the cap route A honours too", (t) => {
  const dir = workspace(t, { maxEvents: 3 });
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fixture = writeIcs(
    dir,
    "feed.ics",
    ics(vevent("UID:many@t", "DTSTART:20260904T190000Z", "RRULE:FREQ=DAILY;COUNT=10", "SUMMARY:X")),
  );
  const r = cli(dir, ["--from-file", `calendar=${fixture}`]);
  assert.equal(r.code, EXIT.ok);
  const data = r.read();
  assert.equal(data.events.length, 3);
  assert.equal(data.feeds[0].events, 3);
  assert.ok(data.feeds[0].warnings.some((w) => w.includes("3-event cap")), JSON.stringify(data.feeds[0].warnings));
});

// ============================================== route A == route B on the wire

test("the shipped fixtures/gcal/feeds.example.json is a valid feeds file with a placeholder url", () => {
  const example = JSON.parse(readFileSync(join(FIXTURES, "feeds.example.json"), "utf-8"));
  assert.equal(example.v, 1);
  const norm = normalizeFeeds(example);
  assert.equal(norm.error, null);
  assert.equal(norm.feeds.length, 1);
  assert.ok(norm.feeds[0].url.startsWith("https://"), "https only, in the example as everywhere else");
  assert.ok(norm.feeds[0].url.includes("REPLACE"), "the example must never look like a working address");
  assert.ok(norm.feeds[0].url.includes("example.test"), "and must point at a reserved test domain");
});

test("COMPATIBILITY: route A writes exactly what route B writes, for the same calendar", (t) => {
  // `src/render.mjs` and `src/focus-engine.mjs` read data/gcal-items.json without
  // knowing which route produced it. So the same four meetings go in through the
  // connector route (a saved connector result) and through route A (an ICS feed),
  // and the two documents are compared.
  const a = workspace(t);
  const b = workspace(t);

  writeFeeds(a, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fixture = writeIcs(
    a,
    "equivalent.ics",
    ics(
      vevent(
        "UID:hand-1",
        "DTSTART:20260904T180000Z",
        "DTEND:20260904T183000Z",
        "SUMMARY:Advisor meeting",
        "LOCATION:Office 210",
        "URL:https://calendar.example.com/event?eid=hand-1",
      ),
      vevent("UID:hand-2", "DTSTART;VALUE=DATE:20260912", "SUMMARY:Reading day"),
      vevent("UID:hand-3", "DTSTART:20260905T170000", "DTEND:20260905T180000", "TRANSP:TRANSPARENT", "SUMMARY:Optional talk"),
      vevent("UID:hand-4", "DTSTART:20260906T150000Z", "SUMMARY:No end given"),
    ),
  );
  const routeA = cli(a, ["--from-file", `calendar=${fixture}`]);
  assert.equal(routeA.code, EXIT.ok, routeA.stderr);

  const routeB = cli(b, ["--in", join(FIXTURES, "transcribed.json")], { script: INGEST });
  assert.equal(routeB.code, 0, routeB.stderr);

  const A = routeA.read();
  const B = routeB.read();

  assert.deepEqual(Object.keys(A), Object.keys(B), "the top-level shape must be identical, key for key and in order");
  assert.deepEqual(Object.keys(A.feeds[0]), Object.keys(B.feeds[0]), "and so must a feed entry");
  assert.deepEqual(A.window, B.window);
  assert.equal(A.v, B.v);
  assert.equal(A.tz, B.tz);
  // The events are the same meetings, so they must be the same RECORDS - same
  // keys, same order of keys, same values, same order of events.
  assert.equal(A.events.length, 4);
  assert.deepEqual(A.events, B.events, "route A and route B must mint identical records");
  for (const e of A.events) assert.deepEqual(Object.keys(e), ["k", "feed", "lbl", "t", "s", "e", "ad", "loc", "desc", "free", "url"]);
});

test("COMPATIBILITY: route B's own readers accept a document route A wrote", (t) => {
  // Not a re-implementation of the shape check: these are the functions
  // gcal-ingest.mjs itself uses on the file it finds on disk. If route A's
  // output did not satisfy them, a run that switched routes would lose its
  // stale tolerance silently.
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const fixture = writeIcs(
    dir,
    "feed.ics",
    ics(vevent("UID:one@t", "DTSTART:20260904T190000Z", "DTEND:20260904T200000Z", "SUMMARY:Sprint planning")),
  );
  const output = cli(dir, ["--from-file", `calendar=${fixture}`]).read();

  const kept = ingestStaleEventsFor(output, "calendar", Date.parse("2026-09-04T06:00:00Z"), WINDOW);
  assert.ok(kept, "route B must be able to inherit route A's events");
  assert.equal(kept.events.length, 1);
  assert.equal(kept.fetchedAt, NOW);
  assert.equal(kept.ageHours, 12);
  assert.equal(ingestStaleEventsFor(output, "calendar", Date.parse("2026-09-08T06:00:00Z"), WINDOW), null, "and to age it out");

  assert.equal(
    ingestSummaryLine(output),
    "[gcal-ingest] feed=calendar source=ics events=1 skippedOwn=0 warnings=0 window=2026-09-02..2026-09-24",
  );
});

test("COMPATIBILITY: every event carries the fields render.mjs reads off the file", (t) => {
  // meetingsInHorizon() in src/render.mjs keeps an event only when `k` and `s`
  // are strings, and then reads feed, lbl, t, e, ad, loc, free and url. A record
  // missing one of those is not a crash - it is a meeting that quietly loses its
  // title or its room on the page.
  const dir = workspace(t);
  writeFeeds(dir, [{ id: "calendar", label: "Calendar", url: FEED_URL }]);
  const r = cli(dir, ["--from-file", `calendar=${join(FIXTURES, "sample-feed.ics")}`]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const data = r.read();
  assert.equal(data.events.length, 10);
  for (const e of data.events) {
    assert.equal(typeof e.k, "string");
    assert.equal(typeof e.s, "string");
    assert.equal(e.feed, "calendar");
    assert.equal(e.lbl, "Calendar");
    assert.equal(typeof e.t, "string");
    assert.equal(typeof e.e, "string");
    assert.equal(typeof e.ad, "boolean");
    assert.equal(typeof e.free, "boolean");
    assert.ok(e.loc === null || typeof e.loc === "string");
    assert.ok(e.url === null || typeof e.url === "string");
    assert.equal(e.k, `calendar|${e.k.split("|")[1]}|${e.s}`, "the key is feed|uid|start");
  }
  const allDay = data.events.find((e) => e.ad);
  assert.equal(allDay.s, "2026-09-14");
  assert.equal(allDay.e, "2026-09-17", "an all-day end is EXCLUSIVE, the way the page reads it");
});
