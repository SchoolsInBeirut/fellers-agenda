// The Canvas connector, against recorded responses.
//
// Canvas is a real HTTP API, which means this connector has two ways to fail
// that the MCP-backed one does not: it can lose half a course list to
// pagination and look like it worked, and it can leak a bearer token into a log
// line. Both are silent, so both are pinned here.
//
// Nothing in this file touches the network. `fixtures/canvas/` holds the shapes
// Canvas actually returns (an enrolment list across two pages, assignments with
// the student's own submission attached, announcements with HTML bodies), and
// the fake fetch below serves them with the Link headers Canvas sends. That is
// the same harness anybody adding a REST-backed source should copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, derive } from "../src/lib/config.mjs";
import { runSource, validateEmission } from "../src/connectors/index.mjs";
import * as canvas from "../src/connectors/lms-canvas.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "fixtures", "canvas", name), "utf-8"));

const BASE = "https://canvas.example.edu";
const TOKEN = "1234~notarealtokenatall";
const NOW = new Date("2026-09-14T13:00:00.000Z");

const cfgWith = (over = {}) => ({
  ...DEFAULTS,
  institution: { ...DEFAULTS.institution, lmsHost: "lms.example.edu" },
  courses: [
    { id: 110001, code: "PHYS 221", name: "Classical Mechanics" },
    { id: 110002, code: "MATH 210", name: "Linear Algebra" },
    { id: 110006, code: "SEM 100", name: "Department Seminar", skip: true },
  ],
  connectors: {
    ...DEFAULTS.connectors,
    lms: {
      ...DEFAULTS.connectors.lms,
      canvas: { enabled: true, baseUrl: BASE, token: TOKEN, courseFilter: [], ...over },
    },
  },
});

/**
 * A fetch that answers from the fixtures and paginates the course list exactly
 * the way Canvas does: page one carries a `Link` header and nothing in the body
 * says there is more.
 */
function fakeCanvas({ fail = null, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (fail && fail.when(u)) {
      return { ok: false, status: fail.status, headers: new Headers(), json: async () => ({}) };
    }
    const reply = (body, link = null) => ({
      ok: true,
      status: 200,
      headers: new Headers(link ? { link } : {}),
      json: async () => body,
    });
    if (u.pathname === "/api/v1/courses") {
      if (u.searchParams.get("page") === "2") return reply(fixture("courses.page2.json"));
      return reply(
        fixture("courses.page1.json"),
        `<${BASE}/api/v1/courses?page=2&per_page=100>; rel="next", <${BASE}/api/v1/courses?page=1&per_page=100>; rel="first"`,
      );
    }
    const assignments = /^\/api\/v1\/courses\/(\d+)\/assignments$/.exec(u.pathname);
    if (assignments) {
      try {
        return reply(fixture(`assignments-${assignments[1]}.json`));
      } catch {
        return reply([]);
      }
    }
    if (u.pathname === "/api/v1/announcements") {
      const code = u.searchParams.get("context_codes[]") ?? "";
      try {
        return reply(fixture(`announcements-${code.replace("course_", "")}.json`));
      } catch {
        return reply([]);
      }
    }
    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
  };
}

const ctxWith = (cfg, fetchImpl) => ({
  cfg,
  derived: derive(cfg),
  now: NOW,
  root: ROOT,
  dataDir: join(ROOT, "data"),
  deadline: Date.now() + 60000,
  log: () => {},
  fetch: fetchImpl,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("normalizeBaseUrl accepts what people actually paste, and refuses the rest", () => {
  assert.equal(canvas.normalizeBaseUrl("https://canvas.example.edu/"), BASE);
  assert.equal(canvas.normalizeBaseUrl("canvas.example.edu"), BASE);
  assert.equal(canvas.normalizeBaseUrl("https://canvas.example.edu/courses/1"), BASE);
  assert.equal(canvas.normalizeBaseUrl("  "), null);
  assert.equal(canvas.normalizeBaseUrl(null), null);
  assert.equal(canvas.normalizeBaseUrl("file:///etc/passwd"), null, "only http(s) may carry a bearer token");
});

test("normalizeBaseUrl falls back to institution.lmsHost, so one answer configures both", () => {
  assert.equal(canvas.normalizeBaseUrl(null, "lms.example.edu"), "https://lms.example.edu");
  assert.equal(canvas.settingsOf(cfgWith({ baseUrl: null })).baseUrl, "https://lms.example.edu");
});

test("parseLinkHeader finds rel=next, which is the only pointer to page two", () => {
  const link = `<${BASE}/api/v1/courses?page=2>; rel="next", <${BASE}/api/v1/courses?page=1>; rel="first"`;
  assert.equal(canvas.parseLinkHeader(link).next, `${BASE}/api/v1/courses?page=2`);
  assert.equal(canvas.parseLinkHeader("").next, undefined);
  assert.equal(canvas.parseLinkHeader(null).next, undefined);
});

test("redact removes the token from anything this connector can print", () => {
  const out = canvas.redact(`GET ${BASE} failed with ${TOKEN} in the message`, TOKEN);
  assert.ok(!out.includes(TOKEN));
  assert.equal(canvas.redact("nothing to hide", null), "nothing to hide");
  assert.equal(canvas.redact("short secrets are not redacted blindly", "ab"), "short secrets are not redacted blindly");
});

test("submissionEvidence is positive-only, with one explicit negative", () => {
  assert.equal(canvas.submissionEvidence({ submission: { submitted_at: "2026-09-08T22:14:03Z" } }), true);
  assert.equal(canvas.submissionEvidence({ submission: { attempt: 2 } }), true);
  assert.equal(canvas.submissionEvidence({ submission: { workflow_state: "graded", score: 18 } }), true);
  assert.equal(canvas.submissionEvidence({ submission: { missing: true } }), false, "Canvas states it, so it is a claim");
  assert.equal(canvas.submissionEvidence({ submission: { workflow_state: "unsubmitted" } }), null);
  assert.equal(
    canvas.submissionEvidence({ submission: { workflow_state: "graded", score: 0 } }),
    null,
    'a graded 0 cannot tell "never turned in" from "did badly" and must never be guessed',
  );
  assert.equal(canvas.submissionEvidence({}), null, "no submission object at all is unknown, not unsubmitted");
});

test("toItem never invents a date and never keeps an unparseable one", () => {
  const course = { id: 110002, code: "MATH 210" };
  const [hw3, , quiz, undated] = fixture("assignments-110002.json");
  assert.equal(canvas.toItem(course, undated), null, "no due date means it is not an item");
  assert.equal(canvas.toItem(course, { name: "x", due_at: "whenever" }), null);
  assert.equal(canvas.toItem(course, hw3).due, "2026-09-16T03:59:00.000Z");
  assert.equal(canvas.toItem(course, hw3).type, "homework");
  assert.equal(canvas.toItem(course, quiz).type, "quiz", "submission_types drives the type");
  assert.equal(canvas.toItem(course, hw3).sources[0], "canvas");
});

test("normalizeCourse prefers the code the user chose in config over Canvas's", () => {
  const cfg = { ...cfgWith(), courses: [{ id: 110002, code: "LINALG 210" }] };
  const c = canvas.normalizeCourse({ id: 110002, course_code: "MATH 210", name: "Linear Algebra" }, derive(cfg));
  assert.equal(c.code, "LINALG 210");
  assert.equal(canvas.normalizeCourse({ id: "nope" }), null);
});

test("courseFilter matches on code or id, and empty means every active enrolment", () => {
  const course = { id: 110002, code: "MATH 210" };
  assert.equal(canvas.courseMatches(course, []), true);
  assert.equal(canvas.courseMatches(course, ["math210"]), true, "spaces and case do not matter");
  assert.equal(canvas.courseMatches(course, ["110002"]), true);
  assert.equal(canvas.courseMatches(course, ["PHYS 221"]), false);
});

test("explainStatus names the cause AND the next action for every refusal", () => {
  assert.match(canvas.explainStatus(401, BASE), /revoked|expired/i);
  assert.match(canvas.explainStatus(401, BASE), /profile\/settings/);
  assert.match(canvas.explainStatus(403, BASE), /disable student API access/i);
  assert.match(canvas.explainStatus(429, BASE), /rate-limiting/i);
});

// ---------------------------------------------------------------------------
// precheck - the same rule the preflight uses
// ---------------------------------------------------------------------------

test("precheck refuses an enabled connector with no token, and says where to make one", () => {
  const missing = canvas.precheck(cfgWith({ token: null }));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /token is not set/);
  assert.match(missing.fix, /New Access Token/);
});

test("precheck refuses an enabled connector with no address anywhere", () => {
  const cfg = cfgWith({ baseUrl: null });
  cfg.institution = { ...cfg.institution, lmsHost: null };
  const missing = canvas.precheck(cfg);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /baseUrl is not set/);
});

test("precheck passes when both halves are present", () => {
  const ok = canvas.precheck(cfgWith());
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.baseUrl, BASE);
});

// ---------------------------------------------------------------------------
// The full collect path
// ---------------------------------------------------------------------------

test("collect walks every page of the enrolment list", async () => {
  const calls = [];
  const out = await canvas.collect(ctxWith(cfgWith(), fakeCanvas({ calls })));
  // Page two holds SEM 100. If the Link header were ignored, its sweep would
  // never happen and the failure would look exactly like an empty course.
  assert.ok(calls.some((u) => u.includes("page=2")), "rel=next was never followed");
  assert.ok(calls.some((u) => u.includes("/courses/110006/assignments")));
  assert.deepEqual(out.errors.filter((e) => !/announcements|assignments/.test(e)), []);
});

test("collect normalises assignments into the emission the merge chain expects", async () => {
  const out = await canvas.collect(ctxWith(cfgWith(), fakeCanvas()));
  assert.doesNotThrow(() => validateEmission("lms-canvas", out));

  const hw3 = out.items.find((i) => i.title === "Homework 3");
  assert.deepEqual(
    { course: hw3.course, courseId: hw3.courseId, type: hw3.type, submitted: hw3.submitted },
    { course: "MATH 210", courseId: 110002, type: "homework", submitted: null },
  );
  const hw2 = out.items.find((i) => i.title === "Homework 2");
  assert.equal(hw2.submitted, true, "a submitted_at is proof");
  const hw1 = out.items.find((i) => i.title === "Homework 1");
  assert.equal(hw1.submitted, false, "Canvas said missing: true, which is a claim");
  assert.ok(!out.items.some((i) => i.title.startsWith("Participation")), "undated work is not an item");
  assert.ok(!out.items.some((i) => i.title === "Lab 2 report"), "an unparseable due date is dropped, never guessed");
});

test("collect carries the gradebook rows, which are the completion signal", async () => {
  const out = await canvas.collect(ctxWith(cfgWith(), fakeCanvas()));
  const graded = out.grades.find((g) => g.title === "Homework 2");
  assert.deepEqual(graded, { courseId: 110002, title: "Homework 2", display: "18", numeric: 18 });
  assert.ok(!out.grades.some((g) => g.title === "Homework 3"), "ungraded work has no grade row");
});

test("collect strips HTML out of announcements and treats their text as data", async () => {
  const out = await canvas.collect(ctxWith(cfgWith(), fakeCanvas()));
  const ann = out.announcements.find((a) => a.id === "880301");
  assert.equal(ann.course, "MATH 210");
  assert.equal(ann.body, "This week only, office hours are in LAB 220 & start at 3pm.");
  const hostile = out.announcements.find((a) => /previous instructions/.test(a.title));
  assert.ok(hostile, "a hostile title is quoted verbatim, never obeyed and never dropped");
});

test("collect honours courseFilter and sweeps nothing else", async () => {
  const calls = [];
  const out = await canvas.collect(ctxWith(cfgWith({ courseFilter: ["MATH 210"] }), fakeCanvas({ calls })));
  assert.ok(calls.some((u) => u.includes("/courses/110002/assignments")));
  assert.ok(!calls.some((u) => u.includes("/courses/110001/assignments")));
  assert.ok(out.items.every((i) => i.course === "MATH 210"));
});

test("a 401 on the course list stops the sweep so a re-auth can be offered once", async () => {
  const fail = { status: 401, when: (u) => u.pathname === "/api/v1/courses" };
  await assert.rejects(
    () => canvas.collect(ctxWith(cfgWith(), fakeCanvas({ fail }))),
    (e) => {
      assert.match(e.message, /revoked|expired/i);
      assert.match(e.message, /profile\/settings/);
      assert.ok(!e.message.includes(TOKEN), "the token must never reach an error message");
      return true;
    },
  );
});

test("a 403 says the institution may have disabled student API access", async () => {
  const fail = { status: 403, when: (u) => u.pathname === "/api/v1/courses" };
  await assert.rejects(
    () => canvas.collect(ctxWith(cfgWith(), fakeCanvas({ fail }))),
    (e) => /disable student API access/i.test(e.message),
  );
});

test("one course's assignments failing costs that course one line, never the run", async () => {
  const fail = { status: 500, when: (u) => u.pathname === "/api/v1/courses/110001/assignments" };
  const out = await canvas.collect(ctxWith(cfgWith(), fakeCanvas({ fail })));
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^PHYS 221 assignments: /);
  assert.ok(out.items.some((i) => i.course === "MATH 210"), "the other courses still ran");
});

test("an enabled connector with no token yields one errors[] line, not a throw", async () => {
  const out = await runSource(
    canvas,
    ctxWith(cfgWith({ token: null }), fakeCanvas()),
    { platform: "darwin" },
  );
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /lms-canvas: connectors\.lms\.canvas\.token is not set/);
  assert.deepEqual(out.items, []);
});

test("a token that sees no matching course says so instead of returning silence", async () => {
  const out = await canvas.collect(ctxWith(cfgWith({ courseFilter: ["ART 101"] }), fakeCanvas()));
  assert.equal(out.items.length, 0);
  assert.match(out.errors[0], /no active course matched/);
  assert.match(out.errors[0], /ART 101/);
});

test("the deadline is honoured between pages, and reported by name", async () => {
  const ctx = { ...ctxWith(cfgWith(), fakeCanvas()), deadline: Date.now() - 1 };
  const out = await canvas.collect(ctx);
  assert.match(out.errors[0], /lms-canvas: ran out of time/);
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

test("healthCheck counts the courses the token can actually see", async () => {
  const r = await canvas.healthCheck(ctxWith(cfgWith(), fakeCanvas()));
  assert.equal(r.ok, true);
  assert.match(r.detail, /3 active course\(s\)/);
});

test("healthCheck turns a revoked token into the one action that fixes it", async () => {
  const fail = { status: 401, when: () => true };
  const r = await canvas.healthCheck(ctxWith(cfgWith(), fakeCanvas({ fail })));
  assert.equal(r.ok, false);
  assert.match(r.fix, /fresh token/);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});
