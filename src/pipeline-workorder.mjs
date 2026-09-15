// pipeline-workorder.mjs - the one file the model reads, plus the small ports
// the rest of the pipeline shares.
//
// PURPOSE. Phase 1 ends by writing ONE compact briefing, `data/work-order.json`,
// and this file is the whole of that job: `collectWorkOrderData` reads what the
// earlier steps left on disk through the injected `ctx.fs` port, and
// `buildWorkOrder` shapes, caps and clips it into the only file the model is
// allowed to read. Split out of `src/pipeline.mjs` so every file in this feature
// stays well under 500 lines; `pipeline.mjs` re-exports the public names, so a
// caller only ever needs that one import.
//
// It is the BOTTOM of this feature's import graph - it imports `readItem`,
// `itemKey`, `standardsCourse` and `isValidZone` and nothing of its own - so the
// helpers both `pipeline.mjs` and `pipeline-steps.mjs` need (the local-time
// spellings, `dpath`, the tolerant JSON readers) live here and nothing here
// imports them back.
//
// WHAT IT READS (through `ctx.fs`, never through `node:fs`, and never the
// network): `latest.json`, `previous.json`, `diff.json`, `outlook-raw.json`,
// `outlook-mail.json`, `focus-plan.json`, `study-plan.json`, `snooze.json`,
// `auth-mfa.json`, `auth-locked.json`, `reauth-last-output.txt` - all under the
// run's data directory. The configuration arrives on `ctx.cfg`, already loaded.
//
// WHAT IT WRITES: nothing. `workOrderStep` in `pipeline-steps.mjs` owns the one
// write, so this file stays a pure function of what it was handed.
//
// CLI: none. Like `src/merge.mjs` this is a library, not a program, so it has no
// shebang and no exit codes.
//
// Nothing here throws on bad input and nothing mutates an argument: an
// unreadable or nonsense file lands as an empty list, never as a crash, because
// a missing side-file must never cost the run its briefing.
//
// TIME. There is no zone literal anywhere in this file. Every local-time
// spelling takes the zone the run resolved from `config.timezone`, and a config
// with no zone falls back to the machine's own - never to somebody else's.

import { readItem } from "./completion.mjs";
import { itemKey } from "./merge.mjs";
import { standardsCourse } from "./lib/config.mjs";
import { isValidZone } from "./lib/civil-time.mjs";

const PREVIEW_CAP = 1500; // nothing in the work order is a transcript
const UNSEEN_CAP = 25;
/** `seen:false` means "never shown on a card", not "new" - most of an inbox is
 *  unseen for ever - so the unseen list is bounded by a window as well as a cap. */
export const UNSEEN_WINDOW_HOURS = 36;
const ANN_BODY_CAP = 600, LIST_CAP = 25, GAP_CAP = 40, MAIL_CAP = 12, TAIL_LINES = 5, HOUR_MS = 3600 * 1000;

/** `config.leadTimeDays`, with the shipped values as the fallback. */
const DEFAULT_LEAD = Object.freeze({ exam: 7, project: 5, lab: 5, homework: 3, quiz: 2, default: 3 });

// ------------------------------------------------------------ time helpers

export const tryOr = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** The machine's own zone, or UTC when even that cannot be read. */
export const systemZone = () => tryOr(() => Intl.DateTimeFormat().resolvedOptions().timeZone, null) || "UTC";

/**
 * The zone this run speaks in: `config.timezone` when it is one `Intl` accepts,
 * otherwise the machine's. A bad zone in config is a config problem for the
 * preflight to report, never a reason for the pipeline to throw.
 */
export const zoneOf = (cfg) => (isValidZone(cfg?.timezone) ? String(cfg.timezone).trim() : systemZone());

/** ISO UTC without milliseconds - the spelling `src/stale-check.mjs` recognises. */
export const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

/** "2026-09-15 10:30:07" in the given zone. */
export function localStamp(d, tz) {
  const zone = isValidZone(tz) ? tz : systemZone();
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, hourCycle: "h23",
    }).formatToParts(d).map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export const localDay = (d, tz) => localStamp(d, tz).slice(0, 10);

export const localWeekday = (d, tz) =>
  new Intl.DateTimeFormat("en-US", { timeZone: isValidZone(tz) ? tz : systemZone(), weekday: "long" }).format(d);

// ----------------------------------------------------- the shared small ports
//
// `pipeline.mjs` and `pipeline-steps.mjs` import each other, so anything BOTH of
// them need has to live below the pair. That is this file, and these are those
// helpers: the file ports, and the text clipping every runlog token goes through.

/** `<data>/tmp/gaps.json` from `ctx.data`, always with forward slashes. */
export const dpath = (ctx, ...parts) => [ctx.data, ...parts].join("/");

/** A file read through the injected port: missing or unreadable -> undefined. */
export const readText = (ctx, file) => tryOr(() => (ctx.fs.exists(file) ? ctx.fs.read(file) : undefined), undefined);

/** JSON text -> value, or null. Empty, missing and malformed are all null. */
export const parseJson = (text) => (text ? tryOr(() => JSON.parse(text), null) : null);

/** Parse a JSON file under `ctx.data`. Unreadable or unparseable -> null. */
export const readJson = (ctx, name) => parseJson(readText(ctx, dpath(ctx, name)));

/** The subset of `obj` whose keys are present - never a key holding `undefined`. */
export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

/** Everything a runlog token quotes is printable ASCII on one line, and short. */
export const clip = (s, n = 160) => String(s ?? "").replace(/[^ -~]+/g, " ").trim().slice(0, n);

/**
 * Text that came from somewhere else - a connector's error, an rclone message -
 * folded into one space-free, bracket-free phrase, so a token survives being
 * read out of the runlog by eye and by `grep`.
 */
export const phrase = (s, n = 60) => clip(s, n * 2).replace(/[()]/g, "").replace(/\s+/g, "-").slice(0, n) || "unknown";

export const textLines = (text) => String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** The last non-empty line of a stream - what a token quotes by default. */
export const lastLine = (text) => textLines(text).pop() ?? "";

/** The first stdout line matching `re`, or null. A timed-out step said nothing. */
export const findLine = (res, re) => (res?.timedOut ? null : (textLines(res?.stdout).find((l) => re.test(l)) ?? null));

/** How much of a foreign phrase a runlog token may carry. */
const DETAIL_CAP = 120;

/**
 * What went wrong, in ONE SPACE-FREE phrase: the last line of stdout, else the
 * FIRST line of stderr, else the exit code.
 *
 * The two halves are read from opposite ends on purpose. A script that ran
 * prints its verdict LAST, after whatever it narrated on the way. A script that
 * refused prints its reason FIRST and then the two lines of advice that follow
 * it - `loadConfigured` ends on "Or edit config.json directly", which as a
 * runlog token says nothing at all about which key was missing.
 *
 * It goes through `phrase`, not `clip`, because the runlog line is read by
 * splitting on spaces. `pipeline.mjs` enforces that for the model's own notes;
 * a step token quoting `scrape: no LMS source is enabled.` would break the same
 * readers just as thoroughly, and nothing downstream re-checks.
 */
export const detail = (res) =>
  phrase(res?.timedOut ? "timeout" : lastLine(res?.stdout) || textLines(res?.stderr)[0] || `exit-${res?.status}`, DETAIL_CAP);

/**
 * A step's OWN summary line: the first stdout line matching `re`, else whatever
 * `detail` can say. `scrape.mjs` and `materials-sync.mjs` both print their
 * `OK: ...` count and then keep talking (per-file errors, timings), so the LAST
 * line is noise and quoting it hides the one number the runlog is read for.
 * Hyphenated by `phrase` for the same reason `detail` is.
 */
export const summaryLine = (res, re) => {
  const hit = findLine(res, re);
  return hit ? phrase(hit, DETAIL_CAP) : detail(res);
};

/** `name=ok` when there is nothing to say, `name=ok(detail)` when there is. */
export const paren = (head, body) => (body ? `${head}(${body})` : head);

/** Drop the `[module] ` tag a connector prefixes its own lines with. */
export const unprefix = (s) => String(s ?? "").replace(/^\[[^\]]+\]\s*/, "");

/** `node src/render.mjs --gaps` tab rows -> the work order's gap entries. */
export function parseGaps(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .filter((l) => l.includes("\t"))
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 4)
    .map(([k, c, t, dueLocal, approx]) => ({ k, c, t, dueLocal, approx: approx === "approx" }));
}

/** `completion.mjs --ingest` output -> which docs may be consumed. */
export function parseIngest(stdout) {
  const all = String(stdout ?? "").split(/\r?\n/);
  const okIndexes = [];
  for (const line of all) {
    const m = /^doc (\d+): (ok|SKIPPED)/.exec(line.trim());
    if (m && m[2] === "ok") okIndexes.push(Number(m[1]) - 1);
  }
  const summary = all.find((l) => l.trim().startsWith("ingest:")) ?? "";
  const num = (re) => (re.test(summary) ? Number(re.exec(summary)[1]) : null);
  return { okIndexes, newMarks: num(/(\d+) new mark/) ?? 0, consumed: num(/(\d+) doc\(s\) consumed/) ?? okIndexes.length };
}

/** The counts line both calendar sinks end on. */
export const CAL_LINE = /^\[calendar-[a-z-]+\] (created|written)=/;

// Those counts and ONLY those: the ICS line ends `file=<path>`, which is a home
// directory, and a runlog line is the thing a user pastes into an issue.
const CAL_COUNTS = /\b(created|written|updated|deleted|removed|unchanged|skipped|errors)=(\d+)/g;

/** `[calendar-ics] written=4 updated=1 removed=0 file=...` -> `written=4;updated=1;removed=0`. */
export function calendarCounts(res) {
  const line = findLine(res, CAL_LINE);
  return line ? [...line.matchAll(CAL_COUNTS)].map((m) => `${m[1]}=${m[2]}`).join(";") : "";
}

/** `drive-rclone.mjs pull` prints one JSON line: `{docs:[...]}` or `{error}`. */
export function parsePull(res) {
  if (res?.timedOut) return { docs: [], error: "timeout" };
  const parsed = parseJson(lastLine(res?.stdout));
  if (!parsed || typeof parsed !== "object") return { docs: [], error: `no-json(exit-${res?.status})` };
  if (parsed.error) return { docs: [], error: phrase(parsed.error) };
  if (res.status !== 0) return { docs: [], error: `exit-${res.status}` };
  return { docs: Array.isArray(parsed.docs) ? parsed.docs : [], error: null };
}

// -------------------------------------------------------------- work order

/**
 * A snapshot item or a payload item -> the v2 short-key shape the wire uses
 * (`k c cid t d ty s approx`). `readItem` normalises the two shapes;
 * `itemKey` is the fallback when neither shape carried a key of its own, so the
 * model and `describe.mjs` always see the same identity string.
 */
const toV2 = (it) => {
  const r = readItem(it);
  const k = r.key ?? (r.title ? itemKey({ courseId: r.courseId ?? 0, type: r.type, title: r.title }) : null);
  return { k, c: r.course, cid: r.courseId, t: r.title, d: r.due, ty: r.type, s: r.submitted, approx: it?.approx === true };
};

const dueMs = (i) => Date.parse(i?.d ?? "");
const byDue = (a, b) => dueMs(a) - dueMs(b);

/**
 * The four lists the digest is written from. `s !== true` is what "not done"
 * means everywhere in this codebase: `false` is a claim and `null` is silence,
 * so neither is ever read as proof of completion (AGENTS.md golden rule 5).
 * `startNow` is the lead window from `config.leadTimeDays`: work whose runway
 * has opened but which is not yet inside the 48-hour band.
 */
function dueBlock(items, now, tz, lead) {
  const nowMs = now.getTime();
  const today = localDay(now, tz);
  const open = (i) => i.s !== true;
  const day = (i) => localDay(new Date(dueMs(i)), tz);
  const leadMs = (i) => (lead[i.ty] ?? lead.default ?? DEFAULT_LEAD.default) * 24 * HOUR_MS;
  const cap = (list) => list.sort(byDue).slice(0, LIST_CAP);
  const dated = items.filter((i) => Number.isFinite(dueMs(i)));
  return {
    today: cap(dated.filter((i) => day(i) === today)),
    in48h: cap(dated.filter((i) => day(i) !== today && dueMs(i) >= nowMs && dueMs(i) <= nowMs + 48 * HOUR_MS)),
    overdueNotDone: cap(dated.filter((i) => open(i) && dueMs(i) < nowMs)),
    startNow: cap(dated.filter((i) => open(i) && dueMs(i) > nowMs + 48 * HOUR_MS && dueMs(i) <= nowMs + leadMs(i))),
  };
}

/**
 * Unseen mail from the last `UNSEEN_WINDOW_HOURS` only, newest first, capped,
 * every preview clipped. The window is what makes the list mean "since the last
 * run" (one missed day included). Mail with no parseable `recv` cannot be shown
 * to be recent, so it is left out rather than guessed at.
 */
function mailBlock(raw, mail, now) {
  const msgs = Array.isArray(raw?.messages) ? raw.messages : [];
  const since = now.getTime() - UNSEEN_WINDOW_HOURS * HOUR_MS;
  const unseen = msgs
    .filter((m) => m?.seen === false && (Date.parse(m?.recv ?? "") || 0) >= since)
    .sort((a, b) => (Date.parse(b?.recv ?? "") || 0) - (Date.parse(a?.recv ?? "") || 0))
    .slice(0, UNSEEN_CAP)
    .map((m) => ({
      entryId: m.entryId ?? null, from: m.from ?? "", addr: m.addr ?? "", subj: m.subj ?? "",
      recv: m.recv ?? null, preview: String(m.preview ?? "").slice(0, PREVIEW_CAP),
    }));
  const r = raw?.replies ?? {};
  return {
    unseen,
    replies: { answeredMail: r.answeredMail ?? [], answeredItems: r.answeredItems ?? [], candidates: r.candidates ?? [] },
    currentMail: Array.isArray(mail) ? mail.slice(0, MAIL_CAP) : [],
  };
}

const announcement = (a) => ({
  c: a?.course ?? a?.c ?? "", t: a?.title ?? a?.t ?? "", p: a?.posted ?? a?.p ?? null,
  body: String(a?.body ?? "").slice(0, ANN_BODY_CAP),
});

function diffBlock(diff) {
  const d = diff ?? {};
  const list = (a) => (Array.isArray(a) ? a.slice(0, LIST_CAP).map(toV2) : []);
  return {
    newItems: list(d.newItems), changedDates: list(d.changedDates), nowSubmitted: list(d.nowSubmitted),
    newAnnouncements: (Array.isArray(d.newAnnouncements) ? d.newAnnouncements : []).slice(0, LIST_CAP).map(announcement),
  };
}

/** The second-factor number is only useful while it is live; an expired one is noise. */
function authBlock(auth, now) {
  const a = auth ?? {};
  const mfa = a.mfa ?? null;
  const fresh = !!mfa && Date.parse(mfa.expiresAboutAt ?? "") > now.getTime();
  return {
    locked: a.locked === true,
    mfa: { number: fresh ? (mfa.number ?? null) : null, expiresAboutAt: mfa?.expiresAboutAt ?? null },
    lastOutputTail: String(a.tail ?? "").split(/\r?\n/).filter(Boolean).slice(-TAIL_LINES),
  };
}

function behindBlock(verdict, snooze, now) {
  const v = verdict ?? {};
  const until = v.snooze?.until ?? snooze?.until ?? null;
  return {
    level: typeof v.level === "string" ? v.level : "unknown",
    rules: (Array.isArray(v.rules) ? v.rules : []).map((r) => ({ id: r?.id ?? "", summary: String(r?.summary ?? "").slice(0, 200) })),
    snoozedUntil: until && Date.parse(until) > now.getTime() ? until : null,
  };
}

function focusBlock(focus, now, tz) {
  const day = (Array.isArray(focus) ? focus : []).find((d) => d?.d === localDay(now, tz));
  if (!day || !Array.isArray(day.blocks)) return [];
  return day.blocks.slice(0, LIST_CAP).map((b) => ({ c: b?.c ?? "", what: b?.what ?? "", t: b?.t ?? null, mins: b?.mins ?? null }));
}

/** This week of the standards plan, and the next retake sitting. */
function standardsWeek(plan, now, tz) {
  const today = localDay(now, tz);
  const weeks = Array.isArray(plan?.weeks) ? plan.weeks : [];
  const week = [...weeks].reverse().find((w) => typeof w?.start === "string" && w.start <= today) ?? null;
  const next = (Array.isArray(plan?.sittings) ? plan.sittings : []).find((s) => typeof s?.date === "string" && s.date >= today) ?? null;
  if (!week && !next) return null;
  return {
    week: week?.start ?? null, standards: Array.isArray(week?.focus) ? week.focus : [], note: week?.note ?? "",
    nextSitting: next ? { date: next.date, label: next.label ?? "" } : null,
  };
}

const sameCourse = (value, course) => String(value ?? "").trim().toLowerCase() === String(course).trim().toLowerCase();

/** Mondays only: what the model needs to edit `data/study-plan.json` honestly. */
const standardsPlanInput = (latest, course) => ({
  announcements: (latest?.announcements ?? []).filter((a) => sameCourse(a?.course, course)).slice(0, LIST_CAP).map(announcement),
  grades: (latest?.items ?? [])
    .filter((i) => sameCourse(i?.course, course) && i?.grade !== null && i?.grade !== undefined)
    .slice(0, LIST_CAP)
    .map((i) => ({ t: i.title, grade: i.grade, d: i.due ?? null })),
});

/**
 * The standards block, or null when the feature is dormant. `plan` is present
 * only on Mondays, because that is the one day the model is asked to edit the
 * plan; every other day the week is read-only context.
 */
function standardsBlock(cfg, data, now, tz) {
  const course = standardsCourse(cfg);
  if (!course) return null;
  const week = standardsWeek(data.studyPlan, now, tz);
  const plan = localWeekday(now, tz) === "Monday" ? standardsPlanInput(data.latest ?? {}, course) : null;
  if (!week && !plan) return null;
  return { course, week, plan };
}

/** `config.courses` -> the four fields the model may quote back. */
const courseList = (cfg) =>
  (Array.isArray(cfg?.courses) ? cfg.courses : [])
    .filter((c) => c && typeof c === "object")
    .slice(0, LIST_CAP)
    .map((c) => ({ code: c.code ?? null, id: c.id ?? null, name: c.name ?? null, skip: c.skip === true }));

/** The tokens phase 1 hands over, in the order the runlog prints them. */
export const WORK_ORDER_TOKENS = Object.freeze(["mail", "board", "materials", "completions", "cmd", "gcal", "studymodel"]);

/**
 * The one file the model reads. `data` is what phase 1 already has in hand
 * (`collectWorkOrderData`); everything here is pure shaping, capping and
 * clipping, so the briefing stays small on purpose.
 */
export function buildWorkOrder(ctx, data) {
  const now = ctx.now;
  const tz = ctx.tz ?? zoneOf(ctx.cfg);
  const cfg = ctx.cfg ?? {};
  const state = ctx.state ?? {};
  const latest = data.latest ?? {};
  const items = (latest.items ?? []).map(toV2);
  return {
    runId: state.runId ?? iso(now),
    title: cfg.title ?? null,
    timezone: tz,
    wakeTime: cfg.wakeTime ?? null,
    nowLocal: localStamp(now, tz).slice(0, 16),
    weekday: localWeekday(now, tz),
    institution: {
      name: cfg.institution?.name ?? null,
      mailDomains: Array.isArray(cfg.institution?.mailDomains) ? cfg.institution.mailDomains : [],
    },
    courses: courseList(cfg),
    scrape: {
      ok: state.phase1?.scrapeOk === true,
      scrapedAt: latest.scrapedAt ?? state.phase1?.scrapedAt ?? null,
      token: data.tokens?.scrape ?? null,
    },
    auth: authBlock(data.auth, now),
    diff: diffBlock(data.diff),
    due: dueBlock(items, now, tz, { ...DEFAULT_LEAD, ...(cfg.leadTimeDays ?? {}) }),
    mail: mailBlock(data.raw, data.mail, now),
    gaps: (Array.isArray(data.gaps) ? data.gaps : []).slice(0, GAP_CAP),
    behind: behindBlock(data.behind, data.snooze, now),
    focusToday: focusBlock(data.focus, now, tz),
    standards: standardsBlock(cfg, data, now, tz),
    artifactUrl: cfg.artifact?.url ?? null,
    previousItems: Number(data.previousItems ?? 0),
    items: items.length,
    tokens: pick(data.tokens ?? {}, WORK_ORDER_TOKENS),
  };
}

/** Everything `buildWorkOrder` needs, read off disk once. Unreadable -> empty. */
export function collectWorkOrderData(ctx) {
  const latest = readJson(ctx, "latest.json") ?? { items: [], announcements: [] };
  const previous = readJson(ctx, "previous.json") ?? {};
  return {
    raw: readJson(ctx, "outlook-raw.json") ?? { messages: [], replies: {} },
    latest,
    diff: readJson(ctx, "diff.json") ?? { newItems: [], changedDates: [], nowSubmitted: [], newAnnouncements: [] },
    gaps: Array.isArray(ctx.out?.gaps) ? ctx.out.gaps : [],
    behind: ctx.out?.behind ?? null,
    focus: readJson(ctx, "focus-plan.json")?.focus ?? [],
    studyPlan: readJson(ctx, "study-plan.json") ?? { weeks: [], sittings: [] },
    mail: readJson(ctx, "outlook-mail.json")?.mail ?? [],
    previousItems: Array.isArray(previous.items) ? previous.items.length : 0,
    snooze: readJson(ctx, "snooze.json"),
    auth: {
      locked: ctx.fs.exists(dpath(ctx, "auth-locked.json")),
      mfa: readJson(ctx, "auth-mfa.json"),
      tail: readText(ctx, dpath(ctx, "reauth-last-output.txt")),
    },
    tokens: ctx.tokens ?? {},
  };
}
