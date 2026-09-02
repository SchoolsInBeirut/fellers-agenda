// The connector registry and the emission contract.
//
// A connector is usually written by somebody adding their own school's system,
// with a recorded sample response and an afternoon. The most valuable thing the
// registry can do for them is refuse a malformed emission loudly, at the
// boundary, naming the exact field - rather than letting a bad shape travel
// into the merge chain and surface a week later as a card with no date.
//
// THE TRI-STATE RULE IS THE ONE THAT MATTERS. `submitted: false` means a source
// EXPLICITLY said "not submitted". If a connector does not know, it emits null.
// A connector that emits false on absence makes the agenda accuse its user of
// not doing work they have already done, and there is no way to tell from the
// outside that it is lying. Several tests below exist only to keep that
// distinction expensive to break.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/config.mjs";
import {
  ALL,
  EMPTY_EMISSION,
  EmissionError,
  atPath,
  hasLmsSource,
  isEnabled,
  runSource,
  satisfies,
  sinks,
  sources,
  validateEmission,
} from "../src/connectors/index.mjs";

const ISO = "2026-09-16T03:59:00.000Z";

/** A minimal well-formed connector, for testing the registry rather than a provider. */
const fake = (over = {}) => ({
  meta: {
    id: "board-fake",
    kind: "board",
    label: "Fake",
    configPath: "connectors.board.fake",
    requires: { os: [], bin: [], mcp: [], app: [] },
    tier: 1,
    ...(over.meta ?? {}),
  },
  collect: over.collect ?? (async () => ({ ...EMPTY_EMISSION })),
  healthCheck: over.healthCheck ?? (async () => ({ ok: true, detail: "fine", fix: null })),
});

const ctx = { cfg: DEFAULTS, now: new Date(ISO), deadline: Date.now() + 60000, log: () => {} };

// ---------------------------------------------------------------------------
// Enablement and platform gating
// ---------------------------------------------------------------------------

test("atPath reads a dotted config path and tolerates a missing branch", () => {
  assert.equal(atPath({ a: { b: { c: 1 } } }, "a.b.c"), 1);
  assert.equal(atPath({ a: {} }, "a.b.c"), undefined);
  assert.equal(atPath(null, "a.b"), undefined);
});

test("a connector runs only when its own config block says enabled: true", () => {
  const mod = fake();
  assert.equal(isEnabled(mod, { connectors: { board: { fake: { enabled: true } } } }), true);
  assert.equal(isEnabled(mod, { connectors: { board: { fake: { enabled: false } } } }), false);
  assert.equal(isEnabled(mod, { connectors: { board: {} } }), false, "absent means off");
  assert.equal(isEnabled(mod, {}), false, "an empty config enables nothing");
});

test("a connector may override the enable rule with its own isEnabled", () => {
  const mod = { ...fake(), isEnabled: (cfg) => cfg?.sideProject?.enabled === true };
  assert.equal(isEnabled(mod, { sideProject: { enabled: true } }), true);
  assert.equal(isEnabled(mod, { connectors: { board: { fake: { enabled: true } } } }), false);
});

test("satisfies: meta.requires.os is checked against the platform, and says which one", () => {
  const win = fake({ meta: { requires: { os: ["win32"] } } });
  assert.deepEqual(satisfies(win, { platform: "win32" }), { ok: true, reason: null });
  const onMac = satisfies(win, { platform: "darwin" });
  assert.equal(onMac.ok, false);
  assert.match(onMac.reason, /requires Windows/);
});

test("satisfies: an empty os list means any platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.equal(satisfies(fake(), { platform }).ok, true);
  }
});

test("satisfies: a missing executable is reported by name", () => {
  const needsGh = fake({ meta: { requires: { os: [], bin: ["gh"] } } });
  assert.equal(satisfies(needsGh, { hasBin: () => true }).ok, true);
  const without = satisfies(needsGh, { hasBin: (b) => b !== "gh" });
  assert.equal(without.ok, false);
  assert.match(without.reason, /"gh"/);
});

test("satisfies: a declared MCP server is only judged when the caller knows the list", () => {
  const needsServer = fake({ meta: { requires: { os: [], bin: [], mcp: ["canvas"] } } });
  assert.equal(satisfies(needsServer, {}).ok, true, "unknown server list means do not judge");
  assert.equal(satisfies(needsServer, { mcpServers: ["canvas"] }).ok, true);
  const missing = satisfies(needsServer, { mcpServers: ["brightspace"] });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /canvas/);
});

// ---------------------------------------------------------------------------
// runSource - a connector never fails the run
// ---------------------------------------------------------------------------

test("an enabled but unsatisfiable connector yields exactly one errors[] line and no throw", async () => {
  const win = fake({ meta: { id: "mail-outlook", requires: { os: ["win32"] } } });
  const out = await runSource(win, ctx, { platform: "darwin" });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^mail-outlook: skipped \(requires Windows\)$/);
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.mail, []);
});

test("a collect() that throws is caught and converted into one errors[] line", async () => {
  const boom = fake({
    collect: async () => {
      throw new Error("the network fell over");
    },
  });
  const out = await runSource(boom, ctx);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /board-fake: the network fell over/);
  assert.deepEqual(out.items, []);
});

test("a collect() that emits a malformed shape is caught, and the message names the field", async () => {
  const bad = fake({
    collect: async () => ({ items: [{ course: "MATH 210", title: "x", type: "homework" }] }),
  });
  const out = await runSource(bad, ctx);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /items\[0\]\.due/);
});

test("a well-formed emission comes back normalised to all six arrays", async () => {
  const good = fake({
    collect: async () => ({ items: [{ courseId: 1, course: "MATH 210", title: "Homework 3", due: ISO, type: "homework", submitted: null }] }),
  });
  const out = await runSource(good, ctx);
  assert.deepEqual(Object.keys(out).sort(), ["announcements", "board", "errors", "grades", "items", "mail"]);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.errors, []);
});

// ---------------------------------------------------------------------------
// validateEmission - the emission shapes
// ---------------------------------------------------------------------------

const item = (over = {}) => ({
  courseId: 110002,
  course: "MATH 210",
  title: "Homework 3",
  due: ISO,
  type: "homework",
  submitted: null,
  sources: ["dropbox"],
  ...over,
});

const rejects = (kind, out, fieldRe) =>
  assert.throws(
    () => validateEmission(kind, out),
    (e) => {
      assert.ok(e instanceof EmissionError, `expected an EmissionError, got ${e}`);
      assert.match(e.message, fieldRe);
      return true;
    },
  );

test("validateEmission: a missing due is refused - undated things belong in mail[]", () => {
  const noDue = { ...item() };
  delete noDue.due;
  rejects("lms-x", { items: [noDue] }, /items\[0\]\.due/);
});

test("validateEmission: a non-ISO due is refused", () => {
  rejects("lms-x", { items: [item({ due: "2026-09-16" })] }, /items\[0\]\.due/);
  rejects("lms-x", { items: [item({ due: "next Tuesday" })] }, /items\[0\]\.due/);
  rejects("lms-x", { items: [item({ due: "2026-13-45T00:00:00.000Z" })] }, /items\[0\]\.due/);
});

test("validateEmission: an unknown type is refused and the message lists the legal ones", () => {
  rejects("lms-x", { items: [item({ type: "assignment" })] }, /items\[0\]\.type/);
  assert.throws(
    () => validateEmission("lms-x", { items: [item({ type: "assignment" })] }),
    (e) => /homework/.test(e.message) && /quiz/.test(e.message),
  );
});

test("validateEmission: submitted must be tri-state, and a truthy string is refused", () => {
  rejects("lms-x", { items: [item({ submitted: "yes" })] }, /items\[0\]\.submitted/);
  rejects("lms-x", { items: [item({ submitted: 1 })] }, /items\[0\]\.submitted/);
  assert.throws(
    () => validateEmission("lms-x", { items: [item({ submitted: "yes" })] }),
    (e) => /never a guess/.test(e.message),
  );
});

test("validateEmission: submitted null is accepted, and so are true and false", () => {
  for (const submitted of [null, true, false, undefined]) {
    assert.doesNotThrow(() => validateEmission("lms-x", { items: [item({ submitted })] }));
  }
});

test("validateEmission: an empty title or course is refused", () => {
  rejects("lms-x", { items: [item({ title: "  " })] }, /items\[0\]\.title/);
  rejects("lms-x", { items: [item({ course: "" })] }, /items\[0\]\.course/);
});

test("validateEmission: mail, announcements, board and grades are checked too", () => {
  rejects("mail-x", { mail: [{ subj: "", recv: ISO }] }, /mail\[0\]\.subj/);
  rejects("mail-x", { mail: [{ subj: "hi", recv: "soon" }] }, /mail\[0\]\.recv/);
  rejects("mail-x", { mail: [{ subj: "hi", recv: ISO, tag: "urgent" }] }, /mail\[0\]\.tag/);
  rejects("lms-x", { announcements: [{ course: "MATH 210", title: "x", posted: "yesterday" }] }, /announcements\[0\]\.posted/);
  rejects("board-x", { board: [{ repo: "r", t: "x", kind: "task" }] }, /board\[0\]\.kind/);
  rejects("lms-x", { grades: [{ title: "Homework 1" }] }, /grades\[0\]\.display/);
});

test("validateEmission: a non-array where an array belongs is refused by name", () => {
  rejects("lms-x", { items: "nope" }, /lms-x\.items/);
  rejects("lms-x", { errors: [42] }, /lms-x\.errors\[0\]/);
  rejects("lms-x", [], /lms-x/);
});

test("validateEmission: an empty emission is legal and normalises to six empty arrays", () => {
  assert.deepEqual(validateEmission("lms-x", {}), {
    items: [],
    mail: [],
    announcements: [],
    board: [],
    grades: [],
    errors: [],
  });
});

// ---------------------------------------------------------------------------
// The real registry
// ---------------------------------------------------------------------------

test("every registered connector declares a complete meta block", () => {
  // Course files are deliberately NOT a kind: src/materials-sync.mjs is a
  // standalone downloader with a flat config block, because it moves bytes onto
  // disk instead of emitting items into the merge chain.
  const kinds = new Set(["lms", "mail", "calendar-sink", "board", "grades"]);
  const seen = new Set();
  for (const mod of ALL) {
    const m = mod.meta;
    assert.ok(m, "a registered module with no meta cannot be filtered or reported on");
    assert.match(m.id, /^[a-z0-9-]+$/, `bad connector id ${JSON.stringify(m.id)}`);
    assert.ok(!seen.has(m.id), `duplicate connector id ${m.id}`);
    seen.add(m.id);
    assert.ok(kinds.has(m.kind), `${m.id} has an unknown kind ${JSON.stringify(m.kind)}`);
    assert.equal(typeof m.label, "string");
    assert.match(m.configPath, /^connectors\./);
    assert.ok([1, 2, 3].includes(m.tier), `${m.id} must declare a tier of 1, 2 or 3`);
    assert.equal(typeof mod.healthCheck, "function", `${m.id} needs a healthCheck for the doctor`);
    if (m.kind === "calendar-sink") assert.equal(typeof mod.publish, "function", `${m.id} is a sink and needs publish()`);
    else assert.equal(typeof mod.collect, "function", `${m.id} is a source and needs collect()`);
  }
});

test("sources(cfg) excludes sinks", () => {
  const cfg = {
    connectors: {
      lms: { brightspace: { enabled: true } },
      calendar: { outlook: { enabled: true } },
    },
  };
  const ids = sources(cfg).map((m) => m.meta.id);
  assert.ok(ids.includes("lms-brightspace"));
  assert.ok(!ids.includes("calendar-outlook"), "a sink is never asked for data");
  assert.deepEqual(sinks(cfg).map((m) => m.meta.id), ["calendar-outlook"]);
});

test("the defaults enable exactly one source, and it is the LMS", () => {
  assert.deepEqual(sources(DEFAULTS).map((m) => m.meta.id), ["lms-brightspace"]);
  assert.deepEqual(sinks(DEFAULTS), []);
});

test("every optional connector is off by default - nothing runs until it is asked to", () => {
  for (const mod of ALL) {
    if (mod.meta.kind === "lms") continue;
    assert.equal(isEnabled(mod, DEFAULTS), false, `${mod.meta.id} must default to disabled`);
  }
});

test("the zero-LMS case is detected, and it is the only hard requirement", () => {
  assert.equal(hasLmsSource(DEFAULTS), true);
  const none = { connectors: { lms: { brightspace: { enabled: false }, canvas: { enabled: false } } } };
  assert.equal(hasLmsSource(none), false);
  assert.equal(hasLmsSource({}), false);
  // Everything else being off is a perfectly healthy configuration.
  assert.equal(hasLmsSource({ connectors: { lms: { brightspace: { enabled: true } } } }), true);
});

test("every shipped LMS provider has a connector behind it", () => {
  // The failure this prevents: a provider named in config.example.json with no
  // module registered. Turning it on then passes every config check and fails
  // at the scrape with "no LMS source is enabled", which sends the user in a
  // circle - switch off the one that works, switch on the one that does not.
  const registered = new Set(ALL.filter((m) => m.meta.kind === "lms").map((m) => m.meta.configPath.split(".").pop()));
  for (const provider of Object.keys(DEFAULTS.connectors.lms)) {
    assert.ok(registered.has(provider), `connectors.lms.${provider} is offered in the config with no connector behind it`);
  }
});

test("every shipped calendar sink has a connector behind it", () => {
  const registered = new Set(ALL.filter((m) => m.meta.kind === "calendar-sink").map((m) => m.meta.configPath.split(".").pop()));
  for (const provider of Object.keys(DEFAULTS.connectors.calendar)) {
    assert.ok(registered.has(provider), `connectors.calendar.${provider} is offered in the config with no sink behind it`);
  }
});

test("canvas alone satisfies the hard requirement - nobody has to switch off a working LMS", () => {
  const canvasOnly = { connectors: { lms: { brightspace: { enabled: false }, canvas: { enabled: true } } } };
  assert.equal(hasLmsSource(canvasOnly), true);
  assert.deepEqual(sources(canvasOnly).map((m) => m.meta.id), ["lms-canvas"]);
});

test("both LMS sources may run in the same sweep", () => {
  const both = { connectors: { lms: { brightspace: { enabled: true }, canvas: { enabled: true } } } };
  assert.deepEqual(sources(both).map((m) => m.meta.id), ["lms-brightspace", "lms-canvas"]);
});

test("the ICS sink is the cross-platform one, and it is a sink", () => {
  const cfg = { connectors: { calendar: { ics: { enabled: true } } } };
  assert.deepEqual(sinks(cfg).map((m) => m.meta.id), ["calendar-ics"]);
  assert.deepEqual(sources(cfg), [], "a sink is never asked for data");
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.equal(satisfies(sinks(cfg)[0], { platform }).ok, true, `the ICS sink must work on ${platform}`);
  }
});

test("the side-project board needs the feature on as well as the source", () => {
  const board = ALL.find((m) => m.meta.id === "board-github");
  const sourceOnly = { sideProject: { enabled: false }, connectors: { board: { github: { enabled: true } } } };
  const featureOnly = { sideProject: { enabled: true }, connectors: { board: { github: { enabled: false } } } };
  const both = { sideProject: { enabled: true }, connectors: { board: { github: { enabled: true } } } };
  assert.equal(isEnabled(board, sourceOnly), false, "a board with no planned time is issues nobody will work on");
  assert.equal(isEnabled(board, featureOnly), false);
  assert.equal(isEnabled(board, both), true);
});

test("an authentication failure is the one error a connector may take the run down with", async () => {
  const dead = fake({
    collect: async () => {
      throw new Error("401 unauthorized: the session expired");
    },
  });
  await assert.rejects(() => runSource(dead, ctx), /401 unauthorized/);
  // Everything else is still one line and a continuing run.
  const flaky = fake({
    collect: async () => {
      throw new Error("the network fell over");
    },
  });
  assert.equal((await runSource(flaky, ctx)).errors.length, 1);
});

test("a malformed emission is never mistaken for an auth failure", async () => {
  // "unauthorized" can appear in an assignment title. A validation error must
  // stay a validation error, or one badly-named row takes the run down.
  const bad = fake({
    collect: async () => ({ items: [{ course: "MATH 210", title: "unauthorized session expired", type: "homework" }] }),
  });
  const out = await runSource(bad, ctx);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /items\[0\]\.due/);
});

test("the Windows-only connectors declare it, so a Mac never tries to reach them", () => {
  const winOnly = ALL.filter((m) => (m.meta.requires?.os ?? []).includes("win32")).map((m) => m.meta.id);
  assert.ok(winOnly.includes("mail-outlook"));
  assert.ok(winOnly.includes("calendar-outlook"));
  for (const mod of ALL) {
    if (winOnly.includes(mod.meta.id)) continue;
    assert.equal(satisfies(mod, { platform: "darwin" }).ok, true, `${mod.meta.id} must work off Windows`);
  }
});
