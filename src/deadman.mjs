#!/usr/bin/env node
/**
 * deadman.mjs - the dead-man's switch.
 *
 * Every alarm in this system depends on the scheduled run actually running. If
 * the machine sleeps through a week, or the scheduler is disabled, or node dies
 * on a bad JSON file, the agenda goes SILENT - and silence is indistinguishable
 * from "nothing is due". That is the one failure mode no rule inside the
 * pipeline can catch, because the pipeline is what stopped.
 *
 * So every successful run plants a single calendar event about 26 hours out
 * that says the agenda has stopped, and the next successful run replaces it
 * before it can fire. The event only ever reaches the user's phone when a run
 * did NOT happen. They need no new app, no new habit, and no trust in this
 * script's uptime: the alarm lives on the calendar server, which is not this
 * machine.
 *
 * WHERE THE EVENT ACTUALLY GOES
 *
 * Nowhere in particular, as far as this file is concerned. It asks the
 * connector registry for the enabled CALENDAR SINK and hands it three calls -
 * create, find, delete. That indirection is the whole reason a Mac or a hosted
 * agent can run this pipeline at all: the sink might be a local Outlook
 * install, it might be a hosted calendar, and if there is no sink enabled the
 * watchdog says so and gets out of the way rather than failing a run that was
 * otherwise fine.
 *
 * INVARIANT - never leave zero events armed:
 *   1. create the replacement and VERIFY it came back from the sink by id
 *   2. only then delete the events this file previously tracked
 *   3. if the create or the verify fails, the OLD event stays exactly where it
 *      is and this script exits non-zero
 * The two steps are two separate calls so the ordering lives in JavaScript,
 * where it is unit-tested with a mock runner, rather than inside a sink where
 * no test can reach it. Do not reorder them.
 *
 * A delete that fails is NOT fatal: the watchdog is armed, so the run
 * succeeded. The stale id stays in data/deadman.json and the next run retries.
 *
 * SCOPE: this script touches events carrying the configured category whose id
 * it wrote down itself, and nothing else, ever. The calendar sink owns the
 * deadline events in that same category; the two never see each other's ids.
 *
 * Usage:
 *   node src/deadman.mjs --arm               plant/refresh the switch (~26h out)
 *   node src/deadman.mjs --arm --hours 26    same, explicit horizon (1-168)
 *   node src/deadman.mjs --status            what is armed right now
 *   ... plus --config <path> and --data <dir>, as every CLI here takes.
 *
 * Exit codes:
 *   0  armed, or --status found a live future event, or no calendar sink is
 *      enabled at all (`deadman=SKIPPED(no-calendar-sink)`) - an optional
 *      feature nobody turned on is not a failure.
 *   1  failed to arm - the previous event was LEFT IN PLACE, so the switch is
 *      still armed on the old timer (or: --status found nothing armed)
 *   2  the sink was reachable in principle but its backend was not. The caller
 *      logs `deadman=SKIPPED(com)` and continues: a watchdog that cannot be
 *      planted must never fail the run that was otherwise fine.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { derive, loadConfig } from "./lib/config.mjs";
import { argFlag, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";

export const DEFAULT_CATEGORY = "Agenda";
export const CATEGORY_COLOR = 4; // yellow, matching the calendar sink's own events
export const DEFAULT_HOURS = 26; // one daily run may be missed entirely; two may not
export const MIN_HOURS = 1;
export const MAX_HOURS = 168;
export const DURATION_MINUTES = 15;
export const REMINDER_MINUTES = 0; // fire AT the event: the event time IS the alarm
export const DEFAULT_TZ = "America/New_York";
const OL_FREE = 0;

/** The subject every watchdog event carries. It is also the delete guard: the
 *  sink refuses to remove an event in the category whose subject is not this. */
export function watchdogSubject(category = DEFAULT_CATEGORY) {
  return `${category} watchdog - the agenda has not run, check this computer`;
}

/** The category this run works in, from `connectors.calendar.outlook.category`. */
export function categoryOf(cfg) {
  return derive(cfg).category;
}

export const CATEGORY = DEFAULT_CATEGORY;
export const WATCHDOG_SUBJECT = watchdogSubject(DEFAULT_CATEGORY);

const EXIT = { ok: 0, failed: 1, com: 2 };
export { EXIT };

// ---------------------------------------------------------------- utilities

/** Printable ASCII only - the PowerShell/Outlook bridge stays ASCII-safe. */
export function ascii(s) {
  return String(s ?? "")
    .replace(/[^\x20-\x7e\n]/g, "")
    .trim();
}

const FMT_CACHE = new Map();

function labelFormatter(tz) {
  const zone = tz || DEFAULT_TZ;
  if (!FMT_CACHE.has(zone)) {
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      });
    } catch {
      // An unset or misspelled timezone must not stop the watchdog from being
      // planted; the label is decoration, the event time is the alarm.
      fmt = labelFormatter(DEFAULT_TZ);
    }
    FMT_CACHE.set(zone, fmt);
  }
  return FMT_CACHE.get(zone);
}

/** "Wed, Sep 2, 8:00 PM EDT", in the user's own timezone. */
export function localLabel(value, tz = DEFAULT_TZ) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return ascii(labelFormatter(tz).format(d));
}

function watchdogBody(now, hours, tz) {
  return ascii(
    [
      "This reminder means the agenda has not completed a run since",
      `${localLabel(now, tz)} (about ${hours} hours ago).`,
      "",
      "Nothing on the agenda page, in the digest, or on the calendar can be",
      "trusted to be current until a run succeeds - no news is NOT good news here.",
      "",
      "Check, in order:",
      "  1. is the computer awake and online",
      "  2. the scheduler: did the agenda task run, and what did it exit",
      "  3. data/runlog.txt: the last line says how far the last run got",
      "",
      "A successful run deletes this event and plants the next one automatically.",
    ].join("\n"),
  );
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------- pure planning

/** Normalize whatever is in data/deadman.json into the shape the code expects. */
export function readState(raw) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  return {
    armedAt: typeof raw?.armedAt === "string" ? raw.armedAt : null,
    events: events.filter((e) => e && typeof e.entryId === "string" && e.entryId),
  };
}

/**
 * What --arm intends to do: one event to create, and every previously tracked
 * event id to delete AFTERWARDS. PURE.
 *
 * `subject` and `tz` come from config at the CLI boundary; the defaults keep
 * this callable with three arguments from a test that does not care.
 */
export function planArm(state, now, hours = DEFAULT_HOURS, opts = {}) {
  const subject = opts.subject ?? WATCHDOG_SUBJECT;
  const tz = opts.tz ?? DEFAULT_TZ;
  const start = new Date(now.getTime() + hours * 3600000);
  const end = new Date(start.getTime() + DURATION_MINUTES * 60000);
  return {
    create: {
      id: "arm",
      action: "create-verified",
      subject,
      start: start.toISOString(),
      end: end.toISOString(),
      body: watchdogBody(now, hours, tz),
      location: opts.location ?? "Agenda watchdog",
      busy: OL_FREE,
      reminder: REMINDER_MINUTES,
    },
    deleteIds: readState(state).events.map((e) => e.entryId),
  };
}

/**
 * The state file after a successful arm: the new event, plus any old event whose
 * deletion did not take (so the next run retries it). PURE - never mutates.
 */
export function nextState(state, created, keptEvents, now) {
  return {
    armedAt: now.toISOString(),
    events: [
      { entryId: created.entryId, subject: created.subject, start: created.start, armedAt: now.toISOString() },
      ...keptEvents,
    ],
  };
}

/**
 * The whole --arm decision, with the COM bridge injected. PURE with respect to
 * disk and Outlook: `runner(ops)` is the only way out, so the ordering invariant
 * (create, verify, THEN delete) is testable without an Exchange account.
 *
 * Returns {state, exitCode, lines, created}.
 */
export function armWithRunner(state, { now = new Date(), hours = DEFAULT_HOURS, runner, subject, tz, location }) {
  const current = readState(state);
  const plan = planArm(current, now, hours, { subject, tz, location });
  const lines = [];

  let createResult;
  try {
    createResult = runner([plan.create]);
  } catch (e) {
    lines.push(`could not reach the calendar: ${ascii(e.message)}`);
    lines.push(`the previous watchdog (${current.events.length} event(s)) was left in place`);
    return { state: current, exitCode: e.comUnavailable ? EXIT.com : EXIT.failed, lines, created: null };
  }

  const created = (createResult?.results ?? [])[0];
  if (!created?.ok || !created.entryId) {
    lines.push(`could not plant the watchdog: ${ascii(created?.error ?? "no result from the calendar sink")}`);
    lines.push(`the previous watchdog (${current.events.length} event(s)) was left in place - still armed on the old timer`);
    return { state: current, exitCode: EXIT.failed, lines, created: null };
  }
  lines.push(`armed: ${localLabel(plan.create.start, tz)} (${hours}h out), id ${created.entryId.slice(0, 12)}...`);

  // Armed. From here nothing can fail the run - only leave litter for next time.
  let deleteResults = [];
  if (plan.deleteIds.length) {
    try {
      deleteResults = runner(plan.deleteIds.map((id) => ({ id, action: "delete", entryId: id }))).results ?? [];
    } catch (e) {
      lines.push(`could not remove the previous watchdog: ${ascii(e.message)} (will retry next run)`);
    }
  }
  const kept = current.events.filter((e) => {
    const r = deleteResults.find((x) => x.id === e.entryId);
    return !(r && r.ok);
  });
  const removed = plan.deleteIds.length - kept.length;
  if (plan.deleteIds.length) {
    lines.push(`removed ${removed}/${plan.deleteIds.length} previous watchdog event(s)`);
    if (kept.length) lines.push(`${kept.length} stale id(s) kept in data/deadman.json for the next run to retry`);
  }

  return {
    state: nextState(current, { entryId: created.entryId, subject: plan.create.subject, start: plan.create.start }, kept, now),
    exitCode: EXIT.ok,
    lines,
    created: { entryId: created.entryId, subject: plan.create.subject, start: plan.create.start },
  };
}

/** --status with the bridge injected. PURE apart from `runner`. */
export function statusWithRunner(state, { now = new Date(), runner, tz }) {
  const current = readState(state);
  const lines = [];
  if (!current.events.length) {
    lines.push("NOT ARMED: data/deadman.json tracks no watchdog event");
    return { exitCode: EXIT.failed, lines, live: [] };
  }
  let results = [];
  try {
    results = runner(current.events.map((e) => ({ id: e.entryId, action: "check", entryId: e.entryId }))).results ?? [];
  } catch (e) {
    lines.push(`could not reach the calendar: ${ascii(e.message)}`);
    for (const e2 of current.events) lines.push(`  tracked ${localLabel(e2.start, tz)} (${e2.entryId.slice(0, 12)}...) - unverified`);
    return { exitCode: e.comUnavailable ? EXIT.com : EXIT.failed, lines, live: [] };
  }

  const live = [];
  for (const tracked of current.events) {
    const r = results.find((x) => x.id === tracked.entryId);
    const present = !!(r && r.ok && r.exists);
    const future = new Date(tracked.start).getTime() > now.getTime();
    if (present && future) live.push(tracked);
    lines.push(
      `  ${present ? (future ? "ARMED  " : "expired") : "MISSING"} ${localLabel(tracked.start, tz)}  ` +
        `${tracked.entryId.slice(0, 12)}...${present && r.subject ? `  "${ascii(r.subject).slice(0, 46)}"` : ""}`,
    );
  }
  lines.unshift(
    live.length
      ? `ARMED: ${live.length} future watchdog event(s), next at ${localLabel(live[0].start, tz)}`
      : "NOT ARMED: no tracked event is both present on the calendar and in the future",
  );
  return { exitCode: live.length ? EXIT.ok : EXIT.failed, lines, live };
}

// -------------------------------------------------------- the calendar sink
//
// deadman needs three calls and nothing else. The sink shape below is what
// `src/connectors/calendar-outlook.mjs` exposes; any other sink that offers the
// same three can host the watchdog without this file changing.
//
//   createEvent(event) -> { ok, entryId, subject?, start?, error? }
//   findEvent(id)      -> { ok, exists, subject?, start?, error? }
//   deleteEvent(id)    -> { ok, action?, reason?, error? }
//
// They are SYNCHRONOUS on purpose. The runner seam is what makes the
// create-verify-then-delete ordering unit-testable without a calendar account,
// and a promise in the middle of it would put the ordering back out of reach.

/**
 * Find the enabled calendar sink, if there is one.
 *
 * The registry is imported LAZILY - a watchdog that will not load because some
 * unrelated connector has a syntax error is a watchdog that silently protects
 * nothing. `opts.sinks` lets a test supply the list directly.
 *
 * @returns {Promise<{sink: object|null, reason: string|null}>}
 */
export async function resolveCalendarSink(cfg, opts = {}) {
  let list = opts.sinks ?? null;
  if (!list) {
    try {
      const registry = await import("./connectors/index.mjs");
      list = registry.sinks(cfg);
    } catch (e) {
      return { sink: null, reason: `the connector registry could not be loaded: ${ascii(e.message)}` };
    }
  }
  if (!Array.isArray(list) || list.length === 0) return { sink: null, reason: "no-calendar-sink" };
  // Being a calendar sink is not the same as being able to HOST the watchdog.
  // The ICS sink writes a file: it can carry deadlines and alarms perfectly
  // well, and it cannot plant an event and read it back tomorrow, which is the
  // whole mechanism here. Say which sink was skipped and why, then let the
  // caller exit clean - a feature that cannot work on this setup is not a fault.
  const hosts = list.filter((m) => typeof m.createEvent === "function");
  if (!hosts.length) {
    return { sink: null, reason: `no-calendar-sink(${list.map((m) => m.meta?.id ?? "?").join(", ")} cannot host a watchdog event)` };
  }
  return { sink: hosts[0], reason: null };
}

/** Turn a calendar sink into the `runner(ops)` the arming logic takes. */
export function runnerFromSink(sink) {
  const need = (name) => {
    const fn = sink?.[name];
    if (typeof fn !== "function") {
      const id = sink?.meta?.id ?? "the calendar sink";
      throw new Error(`${id} does not implement ${name}() and cannot host the watchdog`);
    }
    return fn;
  };
  const sync = (value, name) => {
    if (value && typeof value.then === "function") {
      throw new Error(`${name}() returned a promise; the watchdog needs a synchronous calendar sink`);
    }
    return value ?? {};
  };

  return (ops) => ({
    mode: 1,
    results: ops.map((op) => {
      if (op.action === "create-verified") {
        const r = sync(need("createEvent")(op), "createEvent");
        return {
          id: op.id,
          action: r.ok ? "created" : "create-unverified",
          ok: r.ok === true && !!r.entryId,
          entryId: r.entryId ?? null,
          exists: r.ok === true,
          subject: r.subject ?? op.subject,
          start: r.start ?? op.start,
          error: r.error ?? null,
        };
      }
      if (op.action === "delete") {
        const r = sync(need("deleteEvent")(op.entryId), "deleteEvent");
        return { id: op.id, action: r.action ?? (r.ok ? "deleted" : "skipped"), ok: r.ok === true, reason: r.reason ?? null, error: r.error ?? null };
      }
      const r = sync(need("findEvent")(op.entryId), "findEvent");
      return { id: op.id, action: "checked", ok: r.ok !== false, exists: r.exists === true, subject: r.subject ?? null, start: r.start ?? null };
    }),
  });
}

// ------------------------------------------------------------- COM bridge
//
// The fallback host, used when the enabled sink does not offer the three calls
// above. Same shape as the Outlook calendar sink: a plan file in, a result file
// out, one PowerShell process, no state kept in the shell. The category guard
// is repeated here rather than shared, because an event this script did not
// create must survive a bug in this script.

const PS_BRIDGE = [
  "param([Parameter(Mandatory=$true)][string]$PlanPath,[Parameter(Mandatory=$true)][string]$OutPath)",
  "$ErrorActionPreference = 'Stop'",
  "function New-OutlookCtx {",
  "  $app = New-Object -ComObject Outlook.Application",
  "  $ns = $app.GetNamespace('MAPI')",
  "  $null = $ns.CurrentUser.Name",
  "  return [pscustomobject]@{ App = $app; NS = $ns }",
  "}",
  "function ConvertTo-LocalTime([string]$iso) {",
  "  $styles = [System.Globalization.DateTimeStyles]::RoundtripKind",
  "  $dt = [datetime]::Parse($iso, [System.Globalization.CultureInfo]::InvariantCulture, $styles)",
  "  if ($dt.Kind -eq [System.DateTimeKind]::Utc) { return $dt.ToLocalTime() }",
  "  return $dt",
  "}",
  "$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json",
  "$catName = [string]$plan.category",
  "$ctx = $null",
  "try { $ctx = New-OutlookCtx } catch { Start-Sleep -Seconds 3; try { $ctx = New-OutlookCtx } catch { $ctx = $null; $fatal = $_.Exception.Message } }",
  "if ($null -eq $ctx) {",
  "  $err = @{ fatal = ('outlook COM unavailable: ' + $fatal) } | ConvertTo-Json",
  "  [System.IO.File]::WriteAllText($OutPath, $err, (New-Object System.Text.UTF8Encoding($false)))",
  "  exit 3",
  "}",
  "$app = $ctx.App",
  "$ns = $ctx.NS",
  "$mode = 0",
  "try { $mode = [int]$ns.ExchangeConnectionMode } catch { $mode = -1 }",
  "$catFound = $false",
  "foreach ($c in $ns.Categories) { if ($c.Name -eq $catName) { $catFound = $true } }",
  "if (-not $catFound) { $null = $ns.Categories.Add($catName, [int]$plan.categoryColor) }",
  "$results = New-Object System.Collections.ArrayList",
  "foreach ($op in $plan.ops) {",
  "  $r = [ordered]@{ id = [string]$op.id; action = 'noop'; ok = $false; entryId = $null; exists = $false; subject = $null; start = $null; error = $null; reason = $null }",
  "  try {",
  "    if ($op.action -eq 'create-verified') {",
  "      $ap = $app.CreateItem(1)",
  "      $ap.Subject = [string]$op.subject",
  "      $ap.Start = ConvertTo-LocalTime ([string]$op.start)",
  "      $ap.End = ConvertTo-LocalTime ([string]$op.end)",
  "      $ap.Body = [string]$op.body",
  "      $ap.Location = [string]$op.location",
  "      $ap.AllDayEvent = $false",
  "      $ap.BusyStatus = [int]$op.busy",
  "      $ap.ReminderSet = $true",
  "      $ap.ReminderMinutesBeforeStart = [int]$op.reminder",
  "      $ap.Categories = $catName",
  "      $ap.Save()",
  "      $id = [string]$ap.EntryID",
  "      $check = $null",
  "      try { $check = $ns.GetItemFromID($id) } catch { $check = $null }",
  "      if ($null -eq $check) {",
  "        $r.action = 'create-unverified'; $r.error = 'saved but not readable back by EntryID'",
  "      } elseif (([string]$check.Subject) -ne ([string]$op.subject)) {",
  "        $r.action = 'create-unverified'; $r.error = 'EntryID came back with a different subject'",
  "      } else {",
  "        $r.action = 'created'; $r.ok = $true; $r.entryId = $id; $r.exists = $true",
  "        $r.subject = [string]$check.Subject; $r.start = ([datetime]$check.Start).ToString('o')",
  "      }",
  "    } elseif ($op.action -eq 'delete') {",
  "      $ap = $null",
  "      try { $ap = $ns.GetItemFromID([string]$op.entryId) } catch { $ap = $null }",
  "      if ($null -eq $ap) {",
  "        $r.action = 'already-gone'; $r.ok = $true",
  "      } elseif (([string]$ap.Categories) -notlike ('*' + $catName + '*')) {",
  "        $r.action = 'skipped'; $r.ok = $false; $r.reason = ('category guard: not a ' + $catName + ' event')",
  "      } elseif (([string]$ap.Subject) -ne $plan.watchdogSubject) {",
  "        $r.action = 'skipped'; $r.ok = $false; $r.reason = 'subject guard: not a watchdog event'",
  "      } else {",
  "        $ap.Delete(); $r.action = 'deleted'; $r.ok = $true",
  "      }",
  "    } elseif ($op.action -eq 'check') {",
  "      $ap = $null",
  "      try { $ap = $ns.GetItemFromID([string]$op.entryId) } catch { $ap = $null }",
  "      $r.action = 'checked'; $r.ok = $true",
  "      if ($null -ne $ap) { $r.exists = $true; $r.subject = [string]$ap.Subject; $r.start = ([datetime]$ap.Start).ToString('o') }",
  "    } else {",
  "      $r.error = ('unknown action ' + [string]$op.action)",
  "    }",
  "  } catch {",
  "    $r.error = $_.Exception.Message",
  "  }",
  "  $null = $results.Add([pscustomobject]$r)",
  "}",
  "$payload = [ordered]@{ mode = $mode; results = @($results) }",
  "$json = ConvertTo-Json -InputObject $payload -Depth 6",
  "[System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding($false)))",
  "exit 0",
].join("\n");

/** Run one batch of ops through Outlook COM. Throws; `.comUnavailable` marks exit 2. */
export function runOps(ops, { category = DEFAULT_CATEGORY, subject = watchdogSubject(category) } = {}) {
  if (process.platform !== "win32") {
    const err = new Error("the Outlook bridge needs Windows; enable a calendar sink your platform supports");
    err.comUnavailable = true;
    throw err;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "agenda-deadman-"));
  const planPath = path.join(dir, "plan.json");
  const outPath = path.join(dir, "result.json");
  const scriptPath = path.join(dir, "com-bridge.ps1");
  try {
    writeFileSync(
      planPath,
      JSON.stringify({ category, categoryColor: CATEGORY_COLOR, watchdogSubject: subject, ops }),
      "utf8",
    );
    writeFileSync(scriptPath, PS_BRIDGE, "utf8");
    const proc = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-PlanPath", planPath, "-OutPath", outPath],
      { encoding: "utf8", timeout: 5 * 60 * 1000, windowsHide: true },
    );
    if (!existsSync(outPath)) {
      const detail = ascii((proc.stderr || proc.stdout || `exit ${proc.status}`).slice(0, 600));
      const err = new Error(`COM bridge produced no result (${detail})`);
      err.comUnavailable = true; // no result file at all = the bridge never ran
      throw err;
    }
    const payload = readJson(outPath, {});
    if (payload.fatal) {
      const err = new Error(ascii(payload.fatal));
      err.comUnavailable = true;
      throw err;
    }
    return { mode: payload.mode ?? 0, results: Array.isArray(payload.results) ? payload.results : [payload.results].filter(Boolean) };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

// --------------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const args = { arm: argv.includes("--arm"), status: argv.includes("--status"), hours: DEFAULT_HOURS, error: null };
  const at = argv.indexOf("--hours");
  if (at !== -1) {
    const value = Number(argv[at + 1]);
    if (!Number.isFinite(value) || value < MIN_HOURS || value > MAX_HOURS) {
      args.error = `bad --hours value: ${argv[at + 1]} (expected ${MIN_HOURS}-${MAX_HOURS})`;
    } else {
      args.hours = value;
    }
  }
  return args;
}

/**
 * @param {string[]} argv
 * @param {object} [opts] injection seams for the tests: `runner`, `sinks`,
 *        `cfg`, `now`, `dataDir`, `log`.
 */
export async function cliMain(argv, opts = {}) {
  const say = opts.log ?? ((m) => console.log(`[deadman] ${m}`));
  const now = opts.now ?? new Date();
  const args = parseArgs(argv);
  if (args.error) {
    say(args.error);
    return EXIT.failed;
  }
  if (!args.arm && !args.status) {
    say("usage: node src/deadman.mjs --arm [--hours 26] | --status");
    return EXIT.failed;
  }

  const root = opts.dir ?? repoRoot();
  const cfg = opts.cfg ?? loadConfig(argFlag(argv, "config") ?? null, { argv, warn: () => {} });
  const category = categoryOf(cfg);
  const subject = watchdogSubject(category);
  const tz = cfg.timezone ?? DEFAULT_TZ;
  const stateFile = path.join(opts.dataDir ?? resolveDataDir(argv, root), "deadman.json");

  // An optional feature nobody turned on is not a failure. Say so plainly and
  // exit clean, so the calling runbook logs one honest token and moves on.
  let runner = opts.runner ?? null;
  if (!runner) {
    const { sink, reason } = await resolveCalendarSink(cfg, { sinks: opts.sinks });
    if (!sink) {
      say(`deadman=SKIPPED(${reason})`);
      return EXIT.ok;
    }
    // resolveCalendarSink only ever returns a sink that offers the three
    // primitives, so there is no second guess to make here.
    runner = runnerFromSink(sink);
  }

  const state = readState(readJson(stateFile, {}));

  if (args.status) {
    const result = statusWithRunner(state, { now, runner, tz });
    for (const line of result.lines) say(line);
    return result.exitCode;
  }

  const result = armWithRunner(state, { now, hours: args.hours, runner, subject, tz });
  if (result.exitCode === EXIT.ok) writeFileSync(stateFile, JSON.stringify(result.state, null, 2) + "\n");
  for (const line of result.lines) say(line);
  if (result.exitCode === EXIT.com) say("the calendar backend is unavailable - log deadman=SKIPPED(com) and continue");
  return result.exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  cliMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.log(`[deadman] BROKEN: ${err?.stack ?? err}`);
      process.exit(EXIT.failed);
    },
  );
}
