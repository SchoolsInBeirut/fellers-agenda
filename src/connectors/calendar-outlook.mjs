#!/usr/bin/env node
/**
 * calendar-outlook.mjs - the agenda's calendar sink.
 *
 * OPTIONAL, AND OFF BY DEFAULT. It needs Windows and a running copy of classic
 * Outlook. Without it the pipeline is unchanged; deadlines simply live on the
 * page instead of also being on a calendar, and the dead-man's switch reports
 * that it has no host.
 *
 * Creates, updates and deletes one Outlook (Exchange) calendar event per
 * upcoming agenda item, so reminders reach the phone through Outlook's own
 * sync rather than through anything this repo has to run.
 *
 * THE CATEGORY GUARD IS THE SAFETY RULE OF THIS FILE. Every event it creates
 * carries the configured category (`connectors.calendar.outlook.category`,
 * default "Agenda"). Events WITHOUT that category are NEVER modified and NEVER
 * deleted - not by a bug, not by a stale id, not by a map file that has drifted.
 * This connector writes to a calendar a person actually depends on; the guard is
 * what makes that acceptable. If a stored id resolves to an event that is not
 * ours, the operation is skipped and the id is forgotten.
 *
 * Usage:
 *   node src/connectors/calendar-outlook.mjs                  normal run
 *   node src/connectors/calendar-outlook.mjs --dry-run        plan only, no writes
 *   node src/connectors/calendar-outlook.mjs --items <path>   alternate items file
 *   node src/connectors/calendar-outlook.mjs --map <path>     alternate dedupe map
 *   node src/connectors/calendar-outlook.mjs --now <ISO>      pretend "now" is this instant
 *   node src/connectors/calendar-outlook.mjs --config <path> --data <dir>
 *
 * Exit codes: 0 = clean, 1 = hard failure (Outlook unreachable / bad input),
 *             2 = ran but one or more calendar operations failed.
 */

import { existsSync, writeFileSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { derive, loadConfig } from "../lib/config.mjs";
import { dataDir as resolveDataDir, repoRoot } from "../lib/paths.mjs";
// The four questions every calendar sink answers the same way. They live in one
// library so this sink and the ICS one can never drift apart on which items
// deserve a reminder, or on how long before the deadline it fires.
import {
  DURATION_MINUTES,
  EXAM_PREP_DURATION,
  EXAM_PREP_LEAD_MS,
  EXAM_PREP_REMINDER,
  REMINDER_MINUTES,
  ascii,
  collapse,
  isCandidate,
  loadCalendarItems,
  localDate,
  localLabel,
  minutesFor,
  readJson,
} from "../lib/calendar-items.mjs";

export { localDate };

export const meta = {
  id: "calendar-outlook",
  kind: "calendar-sink",
  label: "Outlook calendar (classic, Windows)",
  configPath: "connectors.calendar.outlook",
  requires: { os: ["win32"], bin: [], mcp: [], app: ["Outlook (classic)"] },
  tier: 2,
};

const ROOT = repoRoot();
const CATEGORY_COLOR = 4; // olCategoryColorYellow - matches the page's gold accent
const PAST_MAP_RETENTION_DAYS = 45;

export const DEFAULTS = Object.freeze({
  category: "Agenda",
  horizonDays: 21,
  maxEvents: 60, // runaway guard: never spam the calendar
});

/**
 * Everything this connector needs out of the config, resolved once.
 *
 * The skip sets come from `courses[].skip === true`: a zero-work seminar stays
 * visible in the LMS sweep but never reaches the calendar, because a reminder
 * for something the user has decided not to do is pure noise.
 */
export function settingsOf(cfg, derived = null) {
  const own = cfg?.connectors?.calendar?.outlook ?? {};
  const d = derived ?? derive(cfg ?? {});
  return {
    tz: cfg?.timezone || "UTC",
    category: own.category || d.category || DEFAULTS.category,
    horizonDays: Number(own.horizonDays) || DEFAULTS.horizonDays,
    maxEvents: Number(own.maxEvents) || DEFAULTS.maxEvents,
    skipCodes: d.skipCodes ?? new Set(),
    skipIds: d.skipIds ?? new Set(),
    agendaUrl: typeof cfg?.artifact?.url === "string" ? cfg.artifact.url : "",
  };
}

const OL_FREE = 0;
const OL_BUSY = 2;

// ---------------------------------------------------------------- utilities

function fingerprint(parts) {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function parseArgs(argv) {
  const dataDir = resolveDataDir(argv, ROOT);
  const args = {
    items: path.join(dataDir, "latest.json"),
    outlookItems: path.join(dataDir, "outlook-items.json"),
    map: path.join(dataDir, "calendar-map.json"),
    dryRun: false,
    now: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--items") args.items = path.resolve(argv[++i] ?? "");
    else if (a === "--outlook-items") args.outlookItems = path.resolve(argv[++i] ?? "");
    else if (a === "--map") args.map = path.resolve(argv[++i] ?? "");
    else if (a === "--now") args.now = argv[++i] ?? null;
    else if (a === "--config" || a === "--data") i += 1; // handled by src/lib/paths.mjs
    else if (a.startsWith("--config=") || a.startsWith("--data=")) continue;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// -------------------------------------------------------------- event shape

function buildBody(item, settings) {
  const { tz, category, agendaUrl } = settings;
  const lines = [
    `${item.course} - ${item.title}`,
    `${item.type === "exam" ? "Starts" : "Due"}: ${localLabel(item.due, tz)}${item.approx ? " (approximate date)" : ""}`,
  ];
  if (item.desc) lines.push("", item.desc);
  if (item.altDues && item.altDues.length) {
    lines.push(
      "",
      `Heads up: the agenda data lists more than one date for this item (also ${item.altDues
        .map((d) => localLabel(new Date(d), tz))
        .join("; ")}). The earliest is used here.`,
    );
  }
  const src = item.sources.length ? item.sources.join(", ") : "unknown";
  lines.push("", `Type: ${item.type} | Source: ${src}`);
  if (item.url) lines.push(`Link: ${item.url}`);
  if (agendaUrl) lines.push(`Agenda: ${agendaUrl}`);
  lines.push("", `Auto-created by the agenda (category "${category}"). Manual edits are overwritten on the next sync.`);
  return ascii(lines.join("\n"));
}

/**
 * Desired Outlook events for one item.
 * Deadline items get a block that ENDS at the due time (stays on the right day).
 * Exams start at the exam time and get an extra "study" nudge 3 days out.
 */
function desiredEvents(item, settings, existing, now) {
  const isExam = item.type === "exam";
  const duration = minutesFor(DURATION_MINUTES, item.type);
  const end = new Date(item.due);
  end.setUTCSeconds(0, 0);
  const start = isExam ? new Date(end) : new Date(end.getTime() - duration * 60000);
  const finish = isExam ? new Date(end.getTime() + duration * 60000) : end;
  const prefix = item.approx ? "~" : "";
  // Titles that already end in "due" (common for mail-derived items) must not
  // become "... due due".
  const shortTitle = item.title.replace(/[\s:,-]+due\s*$/i, "").trim() || item.title;
  const subject = isExam
    ? `${prefix}${item.course}: ${shortTitle}`
    : `${prefix}${item.course}: ${shortTitle} due`;

  const events = [
    {
      role: "main",
      subject: ascii(subject),
      body: buildBody(item, settings),
      location: ascii(item.course),
      start: start.toISOString(),
      end: finish.toISOString(),
      reminder: minutesFor(REMINDER_MINUTES, item.type),
      busy: isExam ? OL_BUSY : OL_FREE,
    },
  ];

  if (isExam) {
    const prepStart = new Date(item.due.getTime() - EXAM_PREP_LEAD_MS);
    prepStart.setUTCSeconds(0, 0);
    // Keep an existing prep event alive even once its own start has passed,
    // so the 72h boundary never causes create/delete churn.
    const wantPrep = prepStart > now || Boolean(existing && existing.prepEventId);
    if (wantPrep) {
      events.push({
        role: "prep",
        subject: ascii(`${prefix}${item.course}: study for ${item.title} (3 days out)`),
        body: ascii(
          [
            `Study block for ${item.course} - ${item.title}.`,
            `The exam itself: ${localLabel(item.due, settings.tz)}.`,
            "",
            `Auto-created by the agenda (category "${settings.category}").`,
          ].join("\n"),
        ),
        location: ascii(item.course),
        start: prepStart.toISOString(),
        end: new Date(prepStart.getTime() + EXAM_PREP_DURATION * 60000).toISOString(),
        reminder: EXAM_PREP_REMINDER,
        busy: OL_FREE,
      });
    }
  }
  return events;
}

// ------------------------------------------------------------- COM bridge

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
  "function Set-Fields($ap, $op, [string]$catName) {",
  "  $ap.Subject = [string]$op.subject",
  "  $ap.Start = ConvertTo-LocalTime ([string]$op.start)",
  "  $ap.End = ConvertTo-LocalTime ([string]$op.end)",
  "  $ap.Body = [string]$op.body",
  "  $ap.Location = [string]$op.location",
  "  $ap.AllDayEvent = $false",
  "  $ap.BusyStatus = [int]$op.busy",
  "  $ap.ReminderSet = $true",
  "  $ap.ReminderMinutesBeforeStart = [int]$op.reminder",
  "  $ap.Categories = $catName",
  "  $ap.Save()",
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
  "  $r = [ordered]@{ id = [string]$op.id; action = 'noop'; ok = $false; entryId = $null; error = $null; reason = $null }",
  "  try {",
  "    if ($op.action -eq 'create') {",
  "      $ap = $app.CreateItem(1)",
  "      Set-Fields $ap $op $catName",
  "      $r.entryId = [string]$ap.EntryID; $r.action = 'created'; $r.ok = $true",
  "    } elseif ($op.action -eq 'update') {",
  "      $ap = $null",
  "      try { $ap = $ns.GetItemFromID([string]$op.entryId) } catch { $ap = $null }",
  "      if ($null -eq $ap) {",
  "        $ap = $app.CreateItem(1)",
  "        Set-Fields $ap $op $catName",
  "        $r.entryId = [string]$ap.EntryID; $r.action = 'recreated'; $r.ok = $true; $r.reason = 'event missing from calendar'",
  "      } elseif (([string]$ap.Categories) -notlike ('*' + $catName + '*')) {",
  "        $r.action = 'skipped'; $r.ok = $true; $r.reason = ('category guard: this event is not tagged ' + $catName); $r.entryId = [string]$op.entryId",
  "      } else {",
  "        Set-Fields $ap $op $catName",
  "        $r.entryId = [string]$ap.EntryID; $r.action = 'updated'; $r.ok = $true",
  "      }",
  "    } elseif ($op.action -eq 'delete') {",
  "      $ap = $null",
  "      try { $ap = $ns.GetItemFromID([string]$op.entryId) } catch { $ap = $null }",
  "      if ($null -eq $ap) {",
  "        $r.action = 'already-gone'; $r.ok = $true",
  "      } elseif (([string]$ap.Categories) -notlike ('*' + $catName + '*')) {",
  "        $r.action = 'skipped'; $r.ok = $true; $r.reason = ('category guard: this event is not tagged ' + $catName)",
  "      } else {",
  "        $ap.Delete(); $r.action = 'deleted'; $r.ok = $true",
  "      }",
  "    } elseif ($op.action -eq 'find') {",
  // Search by subject, but only ever look at events carrying our category, so a
  // find can never hand back an id the caller is then allowed to delete.
  "      $cal = $ns.GetDefaultFolder(9)",
  "      $found = $null",
  "      $wanted = [string]$op.subject",
  "      foreach ($ap in $cal.Items) {",
  "        if (([string]$ap.Subject) -ne $wanted) { continue }",
  "        if (([string]$ap.Categories) -notlike ('*' + $catName + '*')) { continue }",
  "        $found = $ap; break",
  "      }",
  "      if ($null -eq $found) {",
  "        $r.action = 'not-found'; $r.ok = $true",
  "      } else {",
  "        $r.action = 'found'; $r.ok = $true; $r.entryId = [string]$found.EntryID",
  "        $r.reason = ([datetime]$found.Start).ToUniversalTime().ToString('o')",
  "      }",
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

/**
 * Runs the plan through Outlook COM. Throws on hard failure.
 *
 * The script and the plan both go through a private temp directory that is
 * created for the call and removed afterwards - never through argv, which is
 * visible to every other process on the machine, and never through a file that
 * outlives the call.
 */
function runOps(ops, settings) {
  const dir = mkdtempSync(path.join(tmpdir(), "agenda-cal-"));
  const planPath = path.join(dir, "plan.json");
  const outPath = path.join(dir, "result.json");
  const scriptPath = path.join(dir, "com-bridge.ps1");
  try {
    writeFileSync(
      planPath,
      JSON.stringify({ category: settings.category, categoryColor: CATEGORY_COLOR, ops }),
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
      throw new Error(`COM bridge produced no result (${detail})`);
    }
    const payload = readJson(outPath);
    if (payload.fatal) throw new Error(payload.fatal);
    const results = Array.isArray(payload.results) ? payload.results : [payload.results].filter(Boolean);
    return { mode: payload.mode ?? 0, results };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

// ------------------------------------------------------------------- main

/**
 * One full sync. Returns an exit code; every side effect goes through runOps,
 * which the caller can stub in a test.
 */
function sync(args, settings, log) {
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`bad --now value: ${args.now}`);
  const horizon = new Date(now.getTime() + settings.horizonDays * 86400000);
  const { tz } = settings;

  const warnings = [];
  const notes = [];
  const { items, snapshotCount, outlookCount } = loadCalendarItems(args, warnings);
  const agendaUrl = ascii(settings.agendaUrl ?? "");

  const candidates = collapse(items.filter((i) => isCandidate(i, now, horizon, settings)), notes);
  const present = new Map(items.map((i) => [i.key, i]));

  let map = {};
  if (existsSync(args.map)) {
    try {
      map = readJson(args.map);
    } catch (err) {
      warnings.push(`calendar-map.json unreadable, starting fresh: ${err.message}`);
      map = {};
    }
  }

  if (candidates.length > settings.maxEvents) {
    throw new Error(`refusing to sync ${candidates.length} events (max ${settings.maxEvents}) - check the input data`);
  }

  // ---- plan
  const ops = [];
  const planned = new Map(); // opId -> {key, role, events, fp, existed}
  const wanted = new Set();
  let unchanged = 0;

  for (const item of candidates) {
    wanted.add(item.key);
    const existing = map[item.key] ?? null;
    const events = desiredEvents(item, { ...settings, agendaUrl }, existing, now);
    const fp = fingerprint(events);
    if (existing && existing.fp === fp && existing.eventId && (events.length < 2 || existing.prepEventId)) {
      unchanged += 1;
      if (existing.past) map[item.key] = { ...existing, past: false };
      continue;
    }
    for (const ev of events) {
      const entryId = ev.role === "main" ? existing?.eventId : existing?.prepEventId;
      const id = `${item.key}||${ev.role}`;
      ops.push({ id, action: entryId ? "update" : "create", entryId: entryId ?? "", ...ev });
      planned.set(id, { key: item.key, role: ev.role, fp, due: item.dueIso, item });
    }
  }

  // ---- deletions: submitted, vanished, or pushed out past the horizon
  const retentionCutoff = new Date(now.getTime() - PAST_MAP_RETENTION_DAYS * 86400000);
  for (const [key, entry] of Object.entries(map)) {
    if (wanted.has(key)) continue;
    const item = present.get(key);
    const dueDate = entry.due ? new Date(entry.due) : null;
    const isPast = Boolean(dueDate && !Number.isNaN(dueDate.getTime()) && dueDate <= now);
    const gone = !item;
    const submitted = Boolean(item && item.submitted === true);

    if (isPast && !gone && !submitted) {
      // Deadline already passed: keep the event as history, stop touching it.
      if (!entry.past) map[key] = { ...entry, past: true };
      if (dueDate < retentionCutoff) delete map[key];
      continue;
    }
    if (entry.past) {
      if (dueDate && dueDate < retentionCutoff) delete map[key];
      continue; // already archived; never re-delete history
    }
    const reason = submitted ? "submitted" : gone ? "no longer in agenda" : `outside the ${settings.horizonDays}-day window`;
    if (entry.eventId) {
      ops.push({ id: `${key}||main`, action: "delete", entryId: entry.eventId, reason });
      planned.set(`${key}||main`, { key, role: "main", remove: true, reason });
    }
    if (entry.prepEventId) {
      ops.push({ id: `${key}||prep`, action: "delete", entryId: entry.prepEventId, reason });
      planned.set(`${key}||prep`, { key, role: "prep", remove: true, reason });
    }
    if (!entry.eventId && !entry.prepEventId) delete map[key];
  }

  // ---- report the plan
  const inputLabel = path.relative(ROOT, args.items).replace(/\\/g, "/") || args.items;
  log(
    `[calendar-outlook] now=${now.toISOString()} tz=${tz} horizon=${settings.horizonDays}d input=${inputLabel}` +
      ` items=${snapshotCount}+${outlookCount}(outlook) candidates=${candidates.length}`,
  );
  for (const note of notes) log(`[calendar-outlook]   note: ${note}`);
  for (const w of warnings) log(`[calendar-outlook]   warn: ${w}`);

  if (ops.length === 0) {
    log(`[calendar-outlook] created=0 updated=0 deleted=0 unchanged=${unchanged} skipped=0 errors=0 (no-op)`);
    writeJsonAtomic(args.map, sortMap(map));
    return { code: 0, written: 0, updated: 0, removed: 0, unchanged, errors: [] };
  }

  if (args.dryRun) {
    for (const op of ops) {
      const p = planned.get(op.id);
      log(
        `[calendar-outlook]   DRY ${op.action.padEnd(6)} ${op.subject ?? p?.reason ?? ""} ` +
          (op.start ? `@ ${localLabel(new Date(op.start), tz)} reminder=${op.reminder}m` : ""),
      );
    }
    log(`[calendar-outlook] dry-run: ${ops.length} operation(s) planned, unchanged=${unchanged}`);
    return { code: 0, written: 0, updated: 0, removed: 0, unchanged, errors: [] };
  }

  // ---- execute
  const { mode, results } = runOps(ops, settings);
  const counts = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
  const failures = [];

  for (const res of results) {
    const p = planned.get(res.id);
    if (!p) continue;
    if (res.error) {
      counts.errors += 1;
      failures.push(`${p.key} (${p.role}): ${ascii(res.error)}`);
      log(`[calendar-outlook]   ERROR ${p.key} (${p.role}): ${ascii(res.error)}`);
      continue;
    }
    if (res.action === "created" || res.action === "recreated" || res.action === "updated") {
      const prev = map[p.key] ?? {};
      const next = { ...prev, due: p.due, fp: p.fp, past: false };
      if (p.role === "main") next.eventId = res.entryId;
      else next.prepEventId = res.entryId;
      if (!next.created) next.created = now.toISOString();
      if (res.action === "updated" || res.action === "recreated") next.updated = now.toISOString();
      map[p.key] = next;
      if (res.action === "updated") counts.updated += 1;
      else counts.created += 1;
      log(
        `[calendar-outlook]   ${res.action} ${p.role === "prep" ? "[prep] " : ""}${p.key} -> ${localLabel(new Date(p.item.due), tz)}` +
          (res.reason ? ` (${ascii(res.reason)})` : ""),
      );
    } else if (res.action === "deleted" || res.action === "already-gone") {
      counts.deleted += res.action === "deleted" ? 1 : 0;
      const entry = map[p.key];
      if (entry) {
        if (p.role === "main") delete entry.eventId;
        else delete entry.prepEventId;
        if (!entry.eventId && !entry.prepEventId) delete map[p.key];
      }
      log(`[calendar-outlook]   ${res.action} ${p.role === "prep" ? "[prep] " : ""}${p.key} (${ascii(p.reason ?? "")})`);
    } else if (res.action === "skipped") {
      counts.skipped += 1;
      log(`[calendar-outlook]   skipped ${p.key} (${ascii(res.reason ?? "")})`);
      // Guarded event is not ours: forget it so we stop poking at it.
      const entry = map[p.key];
      if (entry) {
        if (p.role === "main") delete entry.eventId;
        else delete entry.prepEventId;
        if (!entry.eventId && !entry.prepEventId) delete map[p.key];
      }
    }
  }

  writeJsonAtomic(args.map, sortMap(map));
  log(
    `[calendar-outlook] created=${counts.created} updated=${counts.updated} deleted=${counts.deleted}` +
      ` unchanged=${unchanged} skipped=${counts.skipped} errors=${counts.errors} exchangeMode=${mode}`,
  );
  return {
    code: counts.errors > 0 ? 2 : 0,
    written: counts.created,
    updated: counts.updated,
    removed: counts.deleted,
    unchanged,
    errors: failures,
  };
}

function sortMap(map) {
  const out = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

// -------------------------------------------------------- registry connector

/**
 * The sink entry point. `items` and `focus` are accepted for symmetry with the
 * adapter contract, but this sink reads the snapshot files itself: the calendar
 * must reflect what is actually on disk after a merge, not one caller's slice
 * of it.
 */
export async function publish(ctx, { items, focus } = {}) {
  void items;
  void focus;
  const settings = settingsOf(ctx.cfg, ctx.derived);
  const args = {
    items: path.join(ctx.dataDir, "latest.json"),
    outlookItems: path.join(ctx.dataDir, "outlook-items.json"),
    map: path.join(ctx.dataDir, "calendar-map.json"),
    dryRun: false,
    now: ctx.now ? ctx.now.toISOString() : null,
  };
  try {
    const r = sync(args, settings, (msg) => ctx.log("info", msg));
    return { written: r.written, updated: r.updated, removed: r.removed, errors: r.errors };
  } catch (err) {
    return { written: 0, updated: 0, removed: 0, errors: [`${meta.id}: ${String(err.message).slice(0, 200)}`] };
  }
}

// ------------------------------- the dead-man's switch uses this as its host

/**
 * The three primitives `src/deadman.mjs` needs to plant, verify and remove one
 * event of its own.
 *
 * Every one of them goes through the same COM bridge and the same category
 * guard as the sync does. `findEvent` will only ever return an event carrying
 * the configured category, which is what makes it safe for the caller to hand
 * the id straight back to `deleteEvent`.
 */
function oneOp(op, settings) {
  const { results } = runOps([op], settings);
  const res = results[0];
  if (!res) throw new Error("the COM bridge returned no result");
  if (res.error) throw new Error(ascii(res.error));
  return res;
}

export function createEvent(ctx, { subject, start, end, body, location, reminderMinutes }) {
  const settings = settingsOf(ctx.cfg, ctx.derived);
  const res = oneOp(
    {
      id: "deadman||create",
      action: "create",
      subject: ascii(subject),
      body: ascii(body ?? ""),
      location: ascii(location ?? ""),
      start: new Date(start).toISOString(),
      end: new Date(end ?? new Date(new Date(start).getTime() + 30 * 60000)).toISOString(),
      reminder: Number(reminderMinutes) || 0,
      busy: OL_FREE,
    },
    settings,
  );
  return { id: res.entryId ?? null };
}

export function findEvent(ctx, { subject }) {
  const settings = settingsOf(ctx.cfg, ctx.derived);
  const res = oneOp({ id: "deadman||find", action: "find", subject: ascii(subject) }, settings);
  if (res.action !== "found" || !res.entryId) return null;
  return { id: res.entryId, subject: ascii(subject), start: res.reason ?? null };
}

export function deleteEvent(ctx, { id }) {
  const settings = settingsOf(ctx.cfg, ctx.derived);
  const res = oneOp({ id: "deadman||delete", action: "delete", entryId: String(id) }, settings);
  return { ok: res.action === "deleted" || res.action === "already-gone", action: res.action };
}

export async function healthCheck(ctx) {
  if (process.platform !== "win32") {
    return {
      ok: false,
      detail: "this sink needs Windows and classic Outlook",
      fix: "set connectors.calendar.outlook.enabled to false, or use a hosted calendar connector - see docs/EXTENDING.md",
    };
  }
  const settings = settingsOf(ctx.cfg, ctx.derived);
  try {
    // A find for a subject nothing uses is the cheapest possible round trip
    // that still proves COM is alive and the category exists.
    oneOp({ id: "health||find", action: "find", subject: `${settings.category} health probe` }, settings);
    return { ok: true, detail: `Outlook answered; events are tagged "${settings.category}"`, fix: null };
  } catch (err) {
    return {
      ok: false,
      detail: String(err.message).slice(0, 200),
      fix: "start classic Outlook and sign in, then re-run - or disable this sink; it is optional",
    };
  }
}

// ---------------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cfg = loadConfig(null, { argv });
  const settings = settingsOf(cfg);
  return sync(args, settings, (msg) => console.log(msg)).code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`[calendar-outlook] FAILED: ${ascii(err && err.message ? err.message : String(err))}`);
    process.exitCode = 1;
  }
}
