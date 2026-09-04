// node --test test/behind.test.mjs   (run from the repository root)
//
// Every rule in behind.mjs gets a positive test AND the negative that matters,
// because a "behind" alarm that cries wolf is worse than no alarm: the user stops
// reading it, and the one week it is right is the week it gets ignored.
//
// The false-positive case that matters most - an item due in a few hours that is
// ALREADY in data/user-completions.json - has its own test, as does the
// structural fact that `s === false` is never itself a trigger.
//
// Nothing here reads `data/`. Every input is built in the test, so the suite is
// green on a bare checkout with an empty working directory.
import test from "node:test";
import assert from "node:assert/strict";
import { pack } from "../src/lib/envelope.mjs";
import {
  computeBehind,
  buildContext,
  confirmedKeys,
  isConfirmed,
  effectiveDue,
  overridesMap,
  snoozeState,
  levelOf,
  weekOf,
  weekElapsed,
  minutesLoggedInWeek,
  sittingsWithin,
  doneFromPayload,
  ruleOverdue,
  ruleDueToday,
  ruleDueSoon,
  ruleStudyWeekStalled,
  ruleSurveyWeekend,
  ruleExamStandardsGap,
  ruleStalePipeline,
  SEVERITY,
  LEVEL,
  FALLBACK_TZ,
  B5_FIRE_ON_DECLINED,
} from "../src/behind.mjs";

// The zone every test reckons local days in. behind.mjs has no opinion of its
// own any more - it reads config.timezone, and takes UTC only when nobody said.
const TZ = "America/New_York";
const CONFIG = { timezone: TZ };

// Monday 2026-08-31, 18:00 local = 22:00Z. Week 1 of the study plan.
const MON = new Date("2026-08-31T22:00:00.000Z");
// Friday 2026-09-04, 18:00 local: 4.75/7 = 68% of the study week gone.
const FRI = new Date("2026-09-04T22:00:00.000Z");
// Saturday 2026-09-05, 12:00 local: the signup survey closes tomorrow 23:59.
const SAT = new Date("2026-09-05T16:00:00.000Z");

const hours = (from, n) => new Date(from.getTime() + n * 3600 * 1000).toISOString();

/** Every context and verdict in this file is built in a known zone. */
const ctxOf = (o = {}) => buildContext({ config: CONFIG, ...o });
const verdictOf = (o = {}) => computeBehind({ config: CONFIG, ...o });

/** A compact payload item. `s` defaults to null, as most real items do. */
function item(over = {}) {
  const t = over.t ?? "Homework 2";
  const cid = over.cid ?? 110005;
  const ty = over.ty ?? "homework";
  return {
    k: over.k ?? `${cid}::${ty}::${t.toLowerCase()}`,
    c: over.c ?? "ART 101",
    cid,
    t,
    d: over.d ?? hours(MON, 72),
    ty,
    s: "s" in over ? over.s : null,
    src: over.src ?? ["content"],
  };
}

const PLAN = {
  course: "PHYS 221",
  standards: {
    C1: { name: "Isentropic area-Mach relations", status: "todo" },
    C3: { name: "Fanno flow", status: "todo" },
    C2: { name: "Normal shocks", status: "todo" },
  },
  sittings: [],
  weeks: [{ start: "2026-08-31", focus: ["C1", "C3"], note: "" }],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- the basics

test("nothing to say is a clear verdict, and clear is a normal answer", () => {
  const v = verdictOf({ now: MON, items: [item({ d: hours(MON, 24 * 30) })] });
  assert.equal(v.level, LEVEL.clear);
  assert.deepEqual(v.rules, []);
  assert.equal(v.counts.fired, 0);
  assert.equal(v.counts.open, 1);
  assert.equal(v.computedAt, MON.toISOString());
});

test("levelOf: one high is behind, medium or low alone is only a notice", () => {
  assert.equal(levelOf([]), LEVEL.clear);
  assert.equal(levelOf([{ severity: SEVERITY.low }]), LEVEL.notice);
  assert.equal(levelOf([{ severity: SEVERITY.medium }]), LEVEL.notice);
  assert.equal(levelOf([{ severity: SEVERITY.medium }, { severity: SEVERITY.high }]), LEVEL.behind);
});

// -------------------------------------------------- confirmed() / false positives

test("confirmed by any of the three channels: s:true, user-completions, payload done[]", () => {
  const keys = confirmedKeys({ completions: { "a::hw::one": { at: "2026-08-30T00:00:00Z" } } }, [
    { k: "b::hw::two", at: "2026-08-29T00:00:00Z", via: "page" },
  ]);
  assert.ok(keys.has("a::hw::one"));
  assert.ok(keys.has("b::hw::two"));
  assert.ok(isConfirmed(item({ s: true, k: "z::hw::z" }), keys));
  assert.ok(isConfirmed(item({ k: "a::hw::one" }), keys));
  assert.ok(!isConfirmed(item({ k: "c::hw::three" }), keys));
});

test("FALSE POSITIVE GUARD: an item due in 3h that the user already marked done stays silent", () => {
  const it = item({ k: "110005::quiz::async quiz 3", ty: "quiz", t: "Async Quiz 3", d: hours(MON, 3) });
  const noisy = verdictOf({ now: MON, items: [it] });
  assert.equal(noisy.level, LEVEL.behind, "sanity: unconfirmed, this SHOULD fire");

  const quiet = verdictOf({
    now: MON,
    items: [it],
    completions: { completions: { "110005::quiz::async quiz 3": { at: "2026-08-31T12:00:00Z", via: "page" } } },
  });
  assert.equal(quiet.level, LEVEL.clear);
  assert.deepEqual(quiet.rules, []);
  assert.equal(quiet.counts.confirmed, 1);
  assert.equal(quiet.counts.open, 0);
});

test("the payload done[] set silences an item just as the completions file does", () => {
  const it = item({ k: "110005::quiz::async quiz 3", d: hours(MON, 3) });
  const v = verdictOf({ now: MON, items: [it], done: [{ k: "110005::quiz::async quiz 3", at: "x", via: "user" }] });
  assert.equal(v.level, LEVEL.clear);
});

test("s === false is never a trigger by itself - only the absence of a due date being met is", () => {
  // Far-future item, explicitly not submitted. Nothing may fire off `false`.
  const v = verdictOf({ now: MON, items: [item({ s: false, d: hours(MON, 24 * 20) })] });
  assert.equal(v.level, LEVEL.clear, "an item marked false but not yet due is not a behind signal");
  // And `false` never counts as confirmed either - it is still an open item.
  assert.equal(v.counts.open, 1);
  assert.equal(v.counts.confirmed, 0);
});

test("an item with no readable due date cannot fire a date rule", () => {
  const v = verdictOf({ now: MON, items: [item({ d: "not a date" }), { t: "", d: hours(MON, 1) }] });
  assert.equal(v.level, LEVEL.clear);
  assert.equal(v.counts.open, 0);
});

// ------------------------------------------------------------------- B1/B2/B3

test("B1: past due with nothing recorded as done is high, and names the items", () => {
  const ctx = ctxOf({
    now: MON,
    items: [item({ t: "Homework 1", d: hours(MON, -50) }), item({ t: "Worksheet 2", d: hours(MON, -3) })],
  });
  const r = ruleOverdue(ctx);
  assert.equal(r.id, "B1");
  assert.equal(r.severity, SEVERITY.high);
  assert.equal(r.itemKeys.length, 2);
  assert.match(r.summary, /2 item\(s\) past due/);
  assert.match(r.summary, /oldest 2 day\(s\) ago/);
  assert.match(r.summary, /Homework 1/);
});

test("B1 stays silent when the overdue item is confirmed done", () => {
  const ctx = ctxOf({ now: MON, items: [item({ s: true, d: hours(MON, -50) })] });
  assert.equal(ruleOverdue(ctx), null);
});

test("B2: inside 24h is high and reports the hours left", () => {
  const ctx = ctxOf({ now: MON, items: [item({ d: hours(MON, 6) })] });
  const r = ruleDueToday(ctx);
  assert.equal(r.id, "B2");
  assert.equal(r.severity, SEVERITY.high);
  assert.match(r.summary, /due within 24h \(next in ~6h\)/);
  assert.equal(ruleDueSoon(ctx), null, "B2 owns the inner window; B3 must not double-count it");
});

test("B3: the 24h-48h band only, and it is medium", () => {
  const ctx = ctxOf({ now: MON, items: [item({ d: hours(MON, 36) })] });
  assert.equal(ruleDueToday(ctx), null);
  const r = ruleDueSoon(ctx);
  assert.equal(r.id, "B3");
  assert.equal(r.severity, SEVERITY.medium);
  const v = verdictOf({ now: MON, items: [item({ d: hours(MON, 36) })] });
  assert.equal(v.level, LEVEL.notice, "medium alone is a notice, never a push-worthy behind");
});

test("a defer override moves the effective due date and can only ever silence", () => {
  const it = item({ k: "110005::homework::homework 2", d: hours(MON, 3) });
  const overrides = { "110005::homework::homework 2": { deferTo: hours(MON, 24 * 6), why: "sick", at: "x" } };
  assert.equal(verdictOf({ now: MON, items: [it] }).level, LEVEL.behind);
  const v = verdictOf({ now: MON, items: [it], overrides });
  assert.equal(v.level, LEVEL.clear);
  assert.equal(v.counts.deferred, 1);
});

test("overridesMap tolerates the bare map and the wrapped shape; junk is dropped", () => {
  assert.deepEqual(overridesMap({ "a::b::c": { deferTo: "x" } }), { "a::b::c": { deferTo: "x" } });
  assert.deepEqual(overridesMap({ overrides: { "a::b::c": { deferTo: "x" } } }), { "a::b::c": { deferTo: "x" } });
  assert.deepEqual(overridesMap({ "a::b::c": "nope" }), {});
  assert.deepEqual(overridesMap(null), {});
});

test("effectiveDue falls back to the scraped date when the override is unreadable", () => {
  const view = { key: "k", due: "2026-09-01T00:00:00.000Z" };
  assert.deepEqual(effectiveDue(view, { k: { deferTo: "garbage" } }), { due: view.due, deferred: false });
  assert.deepEqual(effectiveDue(view, {}), { due: view.due, deferred: false });
});

// ------------------------------------------------------------------------ B4

test("weekOf / weekElapsed: the plan week containing today, and how much of it is gone", () => {
  assert.equal(weekOf(PLAN, "2026-08-31").start, "2026-08-31");
  assert.equal(weekOf(PLAN, "2026-09-06").start, "2026-08-31");
  assert.equal(weekOf(PLAN, "2026-09-07"), null);
  assert.ok(weekElapsed({ offset: 0 }, MON) < 0.6);
  assert.ok(weekElapsed({ offset: 4 }, FRI) >= 0.6);
});

test("B4: 68% of the week gone, both focus standards todo, zero minutes logged", () => {
  const ctx = ctxOf({ now: FRI, plan: PLAN, studyLog: { entries: [] } });
  const r = ruleStudyWeekStalled(ctx);
  assert.equal(r.id, "B4");
  assert.equal(r.severity, SEVERITY.medium);
  assert.match(r.summary, /PHYS 221: week of 2026-08-31 is 68% gone, C1\/C3 still todo, 0 minutes logged/);
});

test("B4 needs all three silences: early in the week, or a met standard, or logged minutes clears it", () => {
  assert.equal(ruleStudyWeekStalled(ctxOf({ now: MON, plan: PLAN })), null, "monday is too early to judge");

  const progressed = clone(PLAN);
  progressed.standards.C1.status = "met";
  assert.equal(ruleStudyWeekStalled(ctxOf({ now: FRI, plan: progressed })), null);

  const logged = {
    entries: [{ at: "2026-09-02T20:00:00.000Z", c: "PHYS 221", mins: 90, note: "fanno" }],
  };
  assert.equal(ruleStudyWeekStalled(ctxOf({ now: FRI, plan: PLAN, studyLog: logged })), null);
});

test("B4 cannot fire on a week whose focus is prose ('retries', 'Synthesis prep')", () => {
  const prose = { ...PLAN, weeks: [{ start: "2026-08-31", focus: ["retries"], note: "" }] };
  assert.equal(ruleStudyWeekStalled(ctxOf({ now: FRI, plan: prose })), null);
});

test("minutesLoggedInWeek only counts the right bucket inside the right seven days", () => {
  const log = {
    entries: [
      { at: "2026-09-02T20:00:00.000Z", c: "PHYS 221", mins: 90 },
      { at: "2026-09-02T20:00:00.000Z", c: "MATH 210", mins: 60 },
      { at: "2026-08-30T20:00:00.000Z", c: "PHYS 221", mins: 120 },
      { at: "2026-09-02T20:00:00.000Z", c: "PHYS 221", mins: -5 },
    ],
  };
  assert.equal(minutesLoggedInWeek(log, "PHYS 221", "2026-08-31"), 90);
  assert.equal(minutesLoggedInWeek(log, "MATH 210", "2026-08-31"), 60);
  assert.equal(minutesLoggedInWeek({ entries: [] }, "PHYS 221", "2026-08-31"), 0);
});

// ------------------------------------------------------------------------ B5

const REASSESS = (over = {}) => ({
  date: "2026-09-09",
  label: "Reassessment Sitting",
  kind: "reassessment",
  targets: ["C1"],
  ...over,
});

test("B5: on a weekend, an opt-in sitting inside 7 days with no signup on record is HIGH", () => {
  const plan = { ...PLAN, sittings: [REASSESS()] };
  const r = ruleSurveyWeekend(ctxOf({ now: SAT, plan }));
  assert.equal(r.id, "B5");
  assert.equal(r.severity, SEVERITY.high);
  assert.match(r.summary, /Standard Selection Survey closes Sunday 23:59/);
  assert.match(r.summary, /2026-09-09/);
  assert.equal(r.detail.atRisk.length, 1);
  assert.equal(verdictOf({ now: SAT, plan }).level, LEVEL.behind);
});

test("B5 is a weekend rule: the same plan on Monday says nothing", () => {
  const plan = { ...PLAN, sittings: [REASSESS()] };
  assert.equal(ruleSurveyWeekend(ctxOf({ now: MON, plan })), null);
});

test("B5 stays silent once attending:true is on record", () => {
  const plan = { ...PLAN, sittings: [REASSESS({ attending: true })] };
  assert.equal(ruleSurveyWeekend(ctxOf({ now: SAT, plan })), null);
});

test("B5 does not nag a sitting the user explicitly declined, but still reports it", () => {
  const plan = { ...PLAN, sittings: [REASSESS({ attending: false })] };
  const r = ruleSurveyWeekend(ctxOf({ now: SAT, plan }));
  if (B5_FIRE_ON_DECLINED) {
    assert.equal(r.severity, SEVERITY.high);
    return;
  }
  assert.equal(r, null);
  // ...and with a second, undecided sitting present, the declined one is listed.
  const mixed = { ...PLAN, sittings: [REASSESS({ attending: false }), REASSESS({ date: "2026-09-10" })] };
  const r2 = ruleSurveyWeekend(ctxOf({ now: SAT, plan: mixed }));
  assert.equal(r2.detail.atRisk.length, 1);
  assert.equal(r2.detail.declined.length, 1);
  assert.equal(r2.detail.declined[0].date, "2026-09-09");
});

test("B5 ignores whole-class exams: they are not opt-in, so no survey can be missed", () => {
  const plan = { ...PLAN, sittings: [{ date: "2026-09-09", label: "Evening Exam 1", kind: "exam", targets: ["C1"] }] };
  assert.equal(ruleSurveyWeekend(ctxOf({ now: SAT, plan })), null);
});

test("sittingsWithin respects the forward window and resolves attendance", () => {
  const plan = { sittings: [REASSESS({ date: "2026-09-04" }), REASSESS({ date: "2026-09-30" }), REASSESS({ date: "2026-08-01" })] };
  const found = sittingsWithin(plan, "2026-09-01", 7, "reassessment");
  assert.equal(found.length, 1);
  assert.equal(found[0].inDays, 3);
  assert.equal(found[0].attendance, "unknown");
});

// ------------------------------------------------------------------------ B6

test("B6: a sitting the user IS sitting, inside 14 days, with under half the standards met", () => {
  const plan = {
    ...PLAN,
    sittings: [{ date: "2026-09-10", label: "Evening Exam 1", kind: "exam", targets: ["C1", "C2", "C3"] }],
  };
  const r = ruleExamStandardsGap(ctxOf({ now: MON, plan }));
  assert.equal(r.id, "B6");
  assert.equal(r.severity, SEVERITY.medium);
  assert.match(r.summary, /Evening Exam 1 in 10 day\(s\)/);
  assert.match(r.summary, /0\/3 target standards met/);
  assert.deepEqual(r.detail.sittings[0].missing, ["C1", "C2", "C3"]);
});

test("B6 clears at half the standards, and ignores sittings past the 14-day horizon", () => {
  const half = clone(PLAN);
  half.standards.C1.status = "met";
  half.standards.C2.status = "met";
  half.sittings = [{ date: "2026-09-10", label: "Evening Exam 1", kind: "exam", targets: ["C1", "C2", "C3"] }];
  assert.equal(ruleExamStandardsGap(ctxOf({ now: MON, plan: half })), null);

  const far = { ...PLAN, sittings: [{ date: "2026-10-28", label: "Evening Exam 2", kind: "exam", targets: ["C1", "C2"] }] };
  assert.equal(ruleExamStandardsGap(ctxOf({ now: MON, plan: far })), null);
});

test("B6 skips a reassessment the user is not signed up for, and unmeasurable targets", () => {
  const optIn = { ...PLAN, sittings: [REASSESS({ date: "2026-09-05", targets: ["C1", "C2"] })] };
  assert.equal(ruleExamStandardsGap(ctxOf({ now: MON, plan: optIn })), null, "unknown signup drives no urgency");

  const prose = { ...PLAN, sittings: [{ date: "2026-09-10", label: "Final week", kind: "exam", targets: ["retries"] }] };
  assert.equal(ruleExamStandardsGap(ctxOf({ now: MON, plan: prose })), null);
});

// ------------------------------------------------------------------------ B7

test("B7: stale Drive docs are low severity and blame the pipeline, not the user", () => {
  const ctx = ctxOf({ now: MON, staleDocs: { count: 2, oldest: hours(MON, -9) } });
  const r = ruleStalePipeline(ctx);
  assert.equal(r.id, "B7");
  assert.equal(r.severity, SEVERITY.low);
  assert.match(r.summary, /pipeline behind, not user/);
  assert.equal(r.detail.ageHours, 9);
  assert.equal(verdictOf({ now: MON, staleDocs: { count: 2, oldest: hours(MON, -9) } }).level, LEVEL.notice);
});

test("B7 stays quiet for docs younger than the 6h threshold, and when the caller says nothing", () => {
  assert.equal(ruleStalePipeline(ctxOf({ now: MON, staleDocs: { count: 3, oldest: hours(MON, -2) } })), null);
  assert.equal(ruleStalePipeline(ctxOf({ now: MON, staleDocs: { count: 0 } })), null);
  assert.equal(ruleStalePipeline(ctxOf({ now: MON })), null);
  // No timestamp given: the caller already applied the 6h filter, so trust the count.
  assert.ok(ruleStalePipeline(ctxOf({ now: MON, staleDocs: { count: 1 } })));
});

// ------------------------------------------------------------- verdict envelope

test("a snooze is reported but never changes the verdict - suppression is the caller's call", () => {
  const v = verdictOf({
    now: MON,
    items: [item({ d: hours(MON, 2) })],
    snooze: { until: hours(MON, 5), why: "exam tonight" },
  });
  assert.equal(v.level, LEVEL.behind);
  assert.equal(v.snooze.active, true);
  assert.equal(v.snooze.why, "exam tonight");
  assert.equal(snoozeState({ until: hours(MON, -1) }, MON).active, false);
  assert.equal(snoozeState(null, MON).active, false);
});

test("counts describe the whole picture, not just what fired", () => {
  const v = verdictOf({
    now: MON,
    items: [
      item({ t: "A", d: hours(MON, -5) }),
      item({ t: "B", d: hours(MON, 5) }),
      item({ t: "C", d: hours(MON, 30) }),
      item({ t: "D", d: hours(MON, 500), s: true }),
    ],
  });
  assert.deepEqual(
    { ...v.counts, fired: v.counts.fired },
    {
      fired: 3,
      high: 2,
      medium: 1,
      low: 0,
      items: 4,
      confirmed: 1,
      open: 3,
      overdue: 1,
      due24h: 1,
      due48h: 2,
      deferred: 0,
    },
  );
});

test("rules[] is ranked worst-first, so rules[0] is what a single push leads with", () => {
  // B3 (medium, due in 36h) fires before B5 (high, weekend survey) in rule order.
  // A caller with room for ONE line must still get the high one.
  const plan = { ...PLAN, sittings: [REASSESS()] };
  const v = verdictOf({ now: SAT, items: [item({ d: hours(SAT, 36) })], plan });
  assert.equal(v.level, LEVEL.behind);
  // That Saturday is also 79% through a stalled study week, so B4 rides along -
  // which is exactly why ranking matters: three flags, one line of push.
  assert.deepEqual(v.rules.map((r) => r.id), ["B5", "B3", "B4"]);
  assert.equal(v.rules[0].severity, SEVERITY.high);

  // Within one severity, rule order still decides.
  const two = verdictOf({ now: MON, items: [item({ t: "A", d: hours(MON, -5) }), item({ t: "B", d: hours(MON, 5) })] });
  assert.deepEqual(two.rules.map((r) => r.id), ["B1", "B2"]);
});

test("computeBehind never mutates what it was handed", () => {
  const items = [item({ d: hours(MON, -5) })];
  const plan = clone(PLAN);
  const before = JSON.stringify({ items, plan });
  verdictOf({ now: FRI, items, plan, completions: { completions: {} } });
  assert.equal(JSON.stringify({ items, plan }), before);
});

const DONE = [{ k: "a::b::c", at: "2026-08-30T00:00:00.000Z", via: "user" }];

test("doneFromPayload reads both payload envelopes", () => {
  // AGD1 is the plain copy embedded in the page; AGD2 is the compressed,
  // checksummed one that actually travels to Drive. Both must decode here.
  assert.deepEqual(doneFromPayload(pack("data", { v: 4, done: DONE }, { compress: false })), DONE);
  assert.deepEqual(doneFromPayload(pack("data", { v: 4, done: DONE })), DONE);
});

test("doneFromPayload survives a Google Doc's soft line breaks", () => {
  const raw = pack("data", { v: 4, done: DONE });
  const wrapped = raw.replace(/(.{60})/g, "$1\n");
  assert.deepEqual(doneFromPayload(wrapped), DONE, "whitespace is not part of the message");
});

test("doneFromPayload shrugs at anything it cannot trust, and never throws", () => {
  const good = pack("data", { v: 4, done: DONE });
  // A single mistyped character fails the checksum rather than half-decoding.
  const flipped = good.slice(0, 40) + (good[40] === "A" ? "B" : "A") + good.slice(41);
  assert.deepEqual(doneFromPayload(flipped), []);
  // Truncation: the tail, and with it the terminator, is gone.
  assert.deepEqual(doneFromPayload(good.slice(0, good.length - 40)), []);
  // The wrong kind of envelope is not a payload, however well formed it is.
  assert.deepEqual(doneFromPayload(pack("completions", { v: 1, marks: {}, cleared: {} })), []);
  assert.deepEqual(doneFromPayload("XYZ1.@@@@.END"), []);
  assert.deepEqual(doneFromPayload("not an envelope at all"), []);
  assert.deepEqual(doneFromPayload(""), []);
  assert.deepEqual(doneFromPayload(null), []);
  // A payload with no done[] is a payload, not a failure.
  assert.deepEqual(doneFromPayload(pack("data", { v: 4 })), []);
});

test("a payload decoded from the wire silences work exactly as an in-memory list does", () => {
  const k = "110005::quiz::async quiz 3";
  const it = item({ k, d: hours(MON, 3) });
  const wire = pack("data", { v: 4, done: [{ k, at: "2026-08-31T12:00:00.000Z", via: "page" }] });
  assert.equal(verdictOf({ now: MON, items: [it], done: doneFromPayload(wire) }).level, LEVEL.clear);
});

// ------------------------------------------------- timezone comes from the config

test("the verdict reckons local days in config.timezone, and UTC only when unasked", () => {
  // Friday 18:00 in the configured zone is 68% through the study week; the same
  // instant read as UTC is 22:00, which is 70%. The summary must say which.
  const configured = ruleStudyWeekStalled(ctxOf({ now: FRI, plan: PLAN }));
  assert.match(configured.summary, /is 68% gone/);

  const unasked = ruleStudyWeekStalled(buildContext({ now: FRI, plan: PLAN }));
  assert.match(unasked.summary, /is 70% gone/, "no timezone given means UTC, never the machine's zone");

  const explicit = ruleStudyWeekStalled(buildContext({ now: FRI, plan: PLAN, tz: TZ }));
  assert.match(explicit.summary, /is 68% gone/, "an explicit tz beats the config");
  assert.equal(buildContext({ now: FRI }).tz, FALLBACK_TZ);
  assert.equal(ctxOf({ now: FRI }).tz, TZ);
});

// ------------------------------------- the standards plan is optional and may be off

test("B4 is dormant when no standards course is configured and the plan names none", () => {
  const anonymous = { ...PLAN };
  delete anonymous.course;
  assert.equal(
    ruleStudyWeekStalled(ctxOf({ now: FRI, plan: anonymous })),
    null,
    "with no course to measure minutes against, the rule must not guess one",
  );
});

test("B4 takes the course from config.standardsPlan when the plan file does not name one", () => {
  const anonymous = { ...PLAN };
  delete anonymous.course;
  const config = { timezone: TZ, standardsPlan: { enabled: true, course: "PHYS 221", label: "Standards" } };
  const r = ruleStudyWeekStalled(buildContext({ now: FRI, plan: anonymous, config }));
  assert.equal(r.id, "B4");
  assert.match(r.summary, /^PHYS 221: week of 2026-08-31/);
  assert.equal(r.detail.bucket, "PHYS 221");

  // Disabled means dormant, even with a course written into the config.
  const off = { timezone: TZ, standardsPlan: { enabled: false, course: "PHYS 221", label: "Standards" } };
  assert.equal(ruleStudyWeekStalled(buildContext({ now: FRI, plan: anonymous, config: off })), null);
});

test("the plan file's own course still wins over the configured one", () => {
  const config = { timezone: TZ, standardsPlan: { enabled: true, course: "MATH 210", label: "Standards" } };
  const r = ruleStudyWeekStalled(buildContext({ now: FRI, plan: PLAN, config }));
  assert.match(r.summary, /^PHYS 221:/, "the plan names its own course");
});

// -------------------------------------------------- cancelled, and unchecked

test("cancelled work is never behind - the user decided, and a decision is not a debt", () => {
  const it = item({ k: "110005::quiz::async quiz 3", ty: "quiz", t: "Async Quiz 3", d: hours(MON, 3) });
  const v = verdictOf({
    now: MON,
    items: [it],
    completions: {
      v: 2,
      completions: { "110005::quiz::async quiz 3": { at: "2026-08-31T12:00:00Z", via: "page", state: "cancelled" } },
      cleared: {},
    },
  });
  assert.equal(v.level, LEVEL.clear);
  assert.equal(v.counts.open, 0);
});

test("an item the payload already flags cancelled:true is not behind either", () => {
  const it = { ...item({ k: "110005::quiz::async quiz 3", d: hours(MON, 3) }), cancelled: true };
  assert.equal(verdictOf({ now: MON, items: [it] }).level, LEVEL.clear);
  assert.ok(isConfirmed(it, new Set()));
});

test("UNCHECKING a mark makes the work open again - a tombstone is a real revocation", () => {
  const it = item({ k: "110005::quiz::async quiz 3", ty: "quiz", t: "Async Quiz 3", d: hours(MON, 3) });
  const store = {
    v: 2,
    completions: { "110005::quiz::async quiz 3": { at: "2026-08-31T12:00:00Z", via: "page" } },
    cleared: { "110005::quiz::async quiz 3": { at: "2026-08-31T13:00:00Z", via: "user" } },
  };
  assert.ok(!confirmedKeys(store, []).has("110005::quiz::async quiz 3"));
  assert.equal(verdictOf({ now: MON, items: [it], completions: store }).level, LEVEL.behind);
});

test("session keys never enter the confirmed set - they close a block, not a deliverable", () => {
  const keys = confirmedKeys(
    { completions: { "fb|2026-08-31|CHEM 115": { at: "2026-08-31T12:00:00Z", via: "page" } } },
    [{ k: "fb|2026-09-01|CHEM 115", at: "2026-08-31T12:00:00Z", via: "page" }],
  );
  assert.equal(keys.size, 0, "a finished study session says nothing about any deliverable");
});


test("a payload tombstone RE-OPENS work rather than silencing it", () => {
  // done[] is the completion ledger now: it also carries the last 14 days of
  // revocations. Reading one as a completion would make --undone a no-op for
  // every rule in this file - the exact opposite of what the user asked for.
  const k = "110005::quiz::async quiz 3";
  const keys = confirmedKeys({}, [
    { k, at: "2026-08-31T13:00:00Z", via: "user", state: "cleared" },
    { k: "110005::homework::homework 2", at: "2026-08-31T12:00:00Z", via: "page" },
    { k: "110005::homework::homework 1", at: "2026-08-31T12:00:00Z", via: "user", state: "cancelled" },
  ]);
  assert.ok(!keys.has(k), "a revocation is not a completion");
  assert.ok(keys.has("110005::homework::homework 2"), "a plain entry still is");
  assert.ok(keys.has("110005::homework::homework 1"), "and so is a cancellation");

  const it = item({ k, ty: "quiz", t: "Async Quiz 3", d: hours(MON, 3) });
  const v = verdictOf({ now: MON, items: [it], done: [{ k, at: "2026-08-31T13:00:00Z", state: "cleared" }] });
  assert.equal(v.level, LEVEL.behind, "unchecked work due in 3h is behind again");
});


// ---------------------------------------------------------------------------
// The brief that rides after the envelope
// ---------------------------------------------------------------------------

test("doneFromPayload reads a document that carries a brief after the envelope", () => {
  // What render.mjs actually writes: the envelope, a blank line, the brief.
  const doc =
    pack("data", { v: 4, done: DONE }) +
    "\n\n--- BRIEF (plain text for the phone; the blob above is the page's) ---\n" +
    "DUE IN 48H\n  Fri Sep 4 11:59 PM  MATH 210 HW 1  #a::b::c\n" +
    "--- END BRIEF ---\n";
  assert.deepEqual(doneFromPayload(doc), DONE);
});

test("nothing in the brief is ever parsed, however envelope-shaped it looks", () => {
  // The brief is prose assembled from strings other people wrote. An assignment
  // title that reads like a wire message must stay a title.
  const decoy = pack("data", { v: 4, done: [{ k: "decoy", at: "2026-08-30T00:00:00.000Z", via: "user" }] }, { compress: false });
  const doc = pack("data", { v: 4, done: DONE }) + "\n\n" + decoy + "\n";
  assert.deepEqual(doneFromPayload(doc), DONE);
});

test("a corrupt AGD2 with a perfectly good brief under it is still refused", () => {
  const good = pack("data", { v: 4, done: DONE });
  const flipped = good.replace(/^AGD2\.[0-9a-f]{8}\./, "AGD2.00000000.");
  const doc = flipped + "\n\n--- BRIEF ---\nDUE IN 48H\n  (none)\n--- END BRIEF ---\n";
  assert.deepEqual(doneFromPayload(doc), [], "a checksum failure has no fallback");
});
