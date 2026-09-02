#!/usr/bin/env node
/**
 * calendar-ics.mjs - the calendar sink that works everywhere.
 *
 * WHY THIS EXISTS. The Outlook sink needs Windows and a running copy of classic
 * Outlook. That is a perfectly good answer for the machines that have both and
 * no answer at all for everyone else, and "your deadlines are only on the page"
 * is a real loss: a calendar is the thing that already has the user's attention
 * at 8am. So this sink writes the one calendar format every client on every
 * platform can read - RFC 5545 - to a file, and the user imports it once or
 * subscribes to it. No account, no API, no platform requirement, no network.
 *
 * WHAT IT IS NOT. A file cannot push a notification by itself and cannot host
 * the dead-man's switch: `src/deadman.mjs` needs a calendar it can plant an
 * event in and read back later, which is a live backend, not a file this
 * pipeline overwrites. Enabling this sink therefore still leaves the dead-man's
 * switch reporting `no-calendar-sink`, and that is honest rather than broken.
 * Reminders themselves DO work: each event carries a VALARM, and the calendar
 * app that imported it is what rings.
 *
 * THE SAME SEMANTICS AS THE OUTLOOK SINK, ON PURPOSE. Horizon, candidacy,
 * collapse and reminder lead times all come from `src/lib/calendar-items.mjs`,
 * which both sinks share. A user who moves from one to the other gets the same
 * reminders at the same times, and a user who runs both gets two calendars that
 * agree.
 *
 * IDEMPOTENCE. Every event's UID is a hash of the item key and its role, so it
 * is stable for the life of the item. Re-importing the file updates the events
 * already there instead of duplicating them, which is the difference between a
 * calendar you keep and one you delete after a week. A run that finds nothing
 * changed rewrites nothing.
 *
 * Usage:
 *   node src/connectors/calendar-ics.mjs                 write the file
 *   node src/connectors/calendar-ics.mjs --dry-run       print the plan, write nothing
 *   node src/connectors/calendar-ics.mjs --out <path>    write somewhere else
 *   node src/connectors/calendar-ics.mjs --now <ISO> --config <path> --data <dir>
 *
 * Exit codes: 0 = clean, 1 = hard failure (no snapshot, unwritable path).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derive, loadConfig } from "../lib/config.mjs";
import { argFlag, argHas, dataDir as resolveDataDir, repoRoot } from "../lib/paths.mjs";
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
  localLabel,
  minutesFor,
} from "../lib/calendar-items.mjs";

export const meta = {
  id: "calendar-ics",
  kind: "calendar-sink",
  label: "ICS calendar file (any platform)",
  configPath: "connectors.calendar.ics",
  requires: { os: [], bin: [], mcp: [], app: [] },
  // Tier 1: nothing to install, nothing to authorise, nothing that can expire.
  tier: 1,
};

export const DEFAULTS = Object.freeze({
  path: "data/agenda.ics",
  horizonDays: 21, // the same window the Outlook sink uses
  maxEvents: 60, // runaway guard: never write a calendar nobody asked for
});

/** Everything this sink needs out of the config, resolved once. */
export function settingsOf(cfg, derived = null) {
  const own = cfg?.connectors?.calendar?.ics ?? {};
  const d = derived ?? derive(cfg ?? {});
  const institution = typeof cfg?.institution?.name === "string" ? cfg.institution.name.trim() : "";
  return {
    tz: cfg?.timezone || "UTC",
    ns: d.ns,
    // The name calendar apps show for the imported calendar. `institution.name`
    // is the reason a user with two of these can tell them apart.
    calendarName: ascii([cfg?.title || "Weekly Agenda", institution].filter(Boolean).join(" - ")),
    path: typeof own.path === "string" && own.path.trim() ? own.path.trim() : DEFAULTS.path,
    horizonDays: DEFAULTS.horizonDays,
    maxEvents: DEFAULTS.maxEvents,
    skipCodes: d.skipCodes ?? new Set(),
    skipIds: d.skipIds ?? new Set(),
    agendaUrl: typeof cfg?.artifact?.url === "string" ? cfg.artifact.url : "",
  };
}

/** Relative paths resolve against the repository root, like the default does. */
export function resolveIcsPath(p, root) {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

// ---------------------------------------------------------------- ICS syntax

/**
 * Escape one TEXT value (RFC 5545 section 3.3.11).
 * Backslash first, or the escapes we add get escaped again.
 */
export function escapeText(value) {
  return ascii(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Fold a content line to 75 octets, continuing with a single leading space
 * (RFC 5545 section 3.1). Everything here is ASCII by the time it arrives, so
 * octets and characters are the same thing and the fold can never split a
 * multi-byte character.
 */
export function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  if (rest.length) parts.push(` ${rest}`);
  return parts.join("\r\n");
}

/** "20260916T035900Z" - UTC everywhere, so no VTIMEZONE has to ship. */
export function icsDate(date) {
  return new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A UID that is the same on every run for the same item.
 *
 * This is the whole of the re-import story: a calendar client treats a repeated
 * UID as the same event and updates it, and a changed UID as a new one. Hashing
 * the item key keeps it stable across renames of everything else, and keeps the
 * user's course codes and assignment titles out of a string that ends up in
 * other people's calendar files if they ever share one.
 */
export function uidFor(itemKeyValue, role, ns) {
  const hash = createHash("sha1").update(`${itemKeyValue}||${role}`).digest("hex").slice(0, 20);
  return `${hash}-${role}@${ns}.agenda.local`;
}

// -------------------------------------------------------------- event shape

function buildBody(item, settings) {
  const { tz, agendaUrl } = settings;
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
  lines.push("", "Auto-created by the agenda. Edits here are replaced the next time the file is written.");
  return lines.join("\n");
}

/**
 * The events one item wants: the deadline itself, plus - for an exam - the same
 * "study three days out" nudge the Outlook sink plants. Deadline items END at
 * the due time so they stay on the right day; exams START at it.
 */
export function desiredEvents(item, settings, now) {
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

  const events = [
    {
      uid: uidFor(item.key, "main", settings.ns),
      role: "main",
      summary: isExam ? `${prefix}${item.course}: ${shortTitle}` : `${prefix}${item.course}: ${shortTitle} due`,
      description: buildBody(item, settings),
      location: item.course,
      start: start.toISOString(),
      end: finish.toISOString(),
      reminder: minutesFor(REMINDER_MINUTES, item.type),
      busy: isExam,
      url: item.url || "",
    },
  ];

  if (isExam) {
    const prepStart = new Date(item.due.getTime() - EXAM_PREP_LEAD_MS);
    prepStart.setUTCSeconds(0, 0);
    if (prepStart > now) {
      events.push({
        uid: uidFor(item.key, "prep", settings.ns),
        role: "prep",
        summary: `${prefix}${item.course}: study for ${item.title} (3 days out)`,
        description: [
          `Study block for ${item.course} - ${item.title}.`,
          `The exam itself: ${localLabel(item.due, settings.tz)}.`,
          "",
          "Auto-created by the agenda.",
        ].join("\n"),
        location: item.course,
        start: prepStart.toISOString(),
        end: new Date(prepStart.getTime() + EXAM_PREP_DURATION * 60000).toISOString(),
        reminder: EXAM_PREP_REMINDER,
        busy: false,
        url: "",
      });
    }
  }
  return events;
}

/** One VEVENT, folded and CRLF-joined. */
export function renderEvent(ev, stamp) {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${icsDate(stamp)}`,
    `DTSTART:${icsDate(ev.start)}`,
    `DTEND:${icsDate(ev.end)}`,
    `SUMMARY:${escapeText(ev.summary)}`,
    `DESCRIPTION:${escapeText(ev.description)}`,
    `LOCATION:${escapeText(ev.location)}`,
    `TRANSP:${ev.busy ? "OPAQUE" : "TRANSPARENT"}`,
    "STATUS:CONFIRMED",
  ];
  if (ev.url) lines.push(`URL:${escapeText(ev.url)}`);
  if (ev.reminder > 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(ev.summary)}`,
      `TRIGGER:-PT${ev.reminder}M`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT");
  return lines.map(foldLine).join("\r\n");
}

/** The whole file: one VCALENDAR wrapping every VEVENT, CRLF throughout. */
export function renderCalendar(events, settings, stamp) {
  const head = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${settings.ns}//agenda//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(settings.calendarName)}`,
    `X-WR-TIMEZONE:${escapeText(settings.tz)}`,
  ].map(foldLine);
  const body = events.map((ev) => renderEvent(ev, stamp));
  return [...head, ...body, "END:VCALENDAR", ""].join("\r\n");
}

/** Every UID in an existing file, so a run can report what actually changed. */
export function uidsIn(text) {
  return new Set([...String(text ?? "").matchAll(/^UID:(.+)$/gm)].map((m) => m[1].trim()));
}

/**
 * Compare two renderings while ignoring DTSTAMP, which moves every run by
 * definition. Without this, a file whose content is identical would be rewritten
 * (and re-synced by every subscribed client) twice a day forever.
 */
export function sameCalendar(a, b) {
  const strip = (t) => String(t ?? "").replace(/^DTSTAMP:.*$/gm, "");
  return strip(a) === strip(b);
}

// ------------------------------------------------------------------- sync

/**
 * One full write. Returns counts plus the text, so the CLI, the sink entry
 * point and the tests all share one implementation.
 */
export function buildCalendar({ itemsPath, outlookItemsPath, settings, now }) {
  const warnings = [];
  const notes = [];
  const horizon = new Date(now.getTime() + settings.horizonDays * 86400000);
  const { items, snapshotCount, outlookCount } = loadCalendarItems(
    { items: itemsPath, outlookItems: outlookItemsPath },
    warnings,
  );
  const candidates = collapse(items.filter((i) => isCandidate(i, now, horizon, settings)), notes);
  if (candidates.length > settings.maxEvents) {
    throw new Error(`refusing to write ${candidates.length} events (max ${settings.maxEvents}) - check the input data`);
  }
  const events = candidates.flatMap((item) => desiredEvents(item, settings, now));
  return {
    text: renderCalendar(events, settings, now),
    events,
    warnings,
    notes,
    snapshotCount,
    outlookCount,
    candidates: candidates.length,
  };
}

function sync(args, settings, log) {
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`bad --now value: ${args.now}`);

  const built = buildCalendar({
    itemsPath: args.items,
    outlookItemsPath: args.outlookItems,
    settings,
    now,
  });

  for (const note of built.notes) log(`[calendar-ics]   note: ${note}`);
  for (const w of built.warnings) log(`[calendar-ics]   warn: ${w}`);
  log(
    `[calendar-ics] now=${now.toISOString()} tz=${settings.tz} horizon=${settings.horizonDays}d` +
      ` items=${built.snapshotCount}+${built.outlookCount}(mail) candidates=${built.candidates}` +
      ` events=${built.events.length} -> ${args.out}`,
  );

  const before = existsSync(args.out) ? readFileSync(args.out, "utf8") : null;
  if (before !== null && sameCalendar(before, built.text)) {
    log(`[calendar-ics] written=0 updated=0 removed=0 unchanged=${built.events.length} (no-op)`);
    return { code: 0, written: 0, updated: 0, removed: 0, errors: [] };
  }

  const had = uidsIn(before);
  const has = new Set(built.events.map((e) => e.uid));
  const written = [...has].filter((u) => !had.has(u)).length;
  const removed = [...had].filter((u) => !has.has(u)).length;
  const updated = has.size - written;

  if (args.dryRun) {
    for (const ev of built.events) {
      log(`[calendar-ics]   DRY ${ev.role.padEnd(4)} ${ev.summary} @ ${localLabel(new Date(ev.start), settings.tz)} reminder=${ev.reminder}m`);
    }
    log(`[calendar-ics] dry-run: ${built.events.length} event(s) would be written to ${args.out}`);
    return { code: 0, written: 0, updated: 0, removed: 0, errors: [] };
  }

  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, built.text, "utf8");
  log(`[calendar-ics] written=${written} updated=${updated} removed=${removed} file=${args.out}`);
  if (before === null) {
    log(
      "[calendar-ics] first write - import this file into your calendar once, or subscribe to it" +
        " if it lives somewhere your calendar can reach. See docs/connectors/calendar-ics.md",
    );
  }
  return { code: 0, written, updated, removed, errors: [] };
}

// -------------------------------------------------------- registry connector

/**
 * The sink entry point. Like the Outlook sink it reads the snapshot files
 * itself: the calendar must reflect what is on disk after a merge, not one
 * caller's slice of it.
 */
export async function publish(ctx, { items, focus } = {}) {
  void items;
  void focus;
  const settings = settingsOf(ctx.cfg, ctx.derived);
  const args = {
    items: path.join(ctx.dataDir, "latest.json"),
    outlookItems: path.join(ctx.dataDir, "outlook-items.json"),
    out: resolveIcsPath(settings.path, ctx.root ?? repoRoot()),
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

export async function healthCheck(ctx) {
  const settings = settingsOf(ctx.cfg, ctx.derived);
  const out = resolveIcsPath(settings.path, ctx.root ?? repoRoot());
  try {
    mkdirSync(path.dirname(out), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      detail: `cannot create ${path.dirname(out)}: ${err.message}`,
      fix: "point connectors.calendar.ics.path somewhere this account can write",
    };
  }
  const snapshot = path.join(ctx.dataDir ?? "", "latest.json");
  if (!existsSync(snapshot)) {
    return {
      ok: false,
      detail: "no data/latest.json yet, so there is nothing to write",
      fix: "run `node src/scrape.mjs` once; the calendar is written from the snapshot it produces",
    };
  }
  return {
    ok: true,
    detail: existsSync(out) ? `${out} exists and will be refreshed` : `${out} will be created on the next run`,
    fix: null,
  };
}

// ---------------------------------------------------------------------- main

function parseArgs(argv, root) {
  const dataDir = resolveDataDir(argv, root);
  const args = {
    items: path.join(dataDir, "latest.json"),
    outlookItems: path.join(dataDir, "outlook-items.json"),
    out: null,
    dryRun: argHas(argv, "dry-run"),
    now: argFlag(argv, "now"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") continue;
    else if (a === "--items") args.items = path.resolve(argv[++i] ?? "");
    else if (a === "--outlook-items") args.outlookItems = path.resolve(argv[++i] ?? "");
    else if (a === "--out") args.out = path.resolve(argv[++i] ?? "");
    else if (a === "--now" || a === "--config" || a === "--data") i += 1;
    else if (a.startsWith("--now=") || a.startsWith("--config=") || a.startsWith("--data=")) continue;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const root = repoRoot();
  const args = parseArgs(argv, root);
  const cfg = loadConfig(null, { argv });
  const settings = settingsOf(cfg);
  args.out = args.out ?? resolveIcsPath(settings.path, root);
  return sync(args, settings, (msg) => console.log(msg)).code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`[calendar-ics] FAILED: ${err && err.message ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
