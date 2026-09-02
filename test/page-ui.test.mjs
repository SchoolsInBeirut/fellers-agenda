/* The browser half of the wire protocol.
 *
 * web/page-template.html is the one file in this repo that is not a module: it
 * is a static artifact, so nothing can import it and nothing can stub it. What
 * it CAN do is read four envelopes and it must never crash on a bad one - a
 * corrupted Drive document has to leave the page showing the copy it already
 * had, not a blank screen. So this suite does two things:
 *
 *   1. It lifts the page's own envelope code out of the file and runs it in a
 *      vm with browser globals (atob, TextDecoder, DecompressionStream - all of
 *      which Node has). No jsdom needed, and the code under test is the exact
 *      text that ships.
 *   2. If jsdom happens to be installed it boots the whole page once, to prove
 *      the build markers really do drive the title, the timezone line and the
 *      first paint. jsdom is NOT a dependency of this repo; when it is missing
 *      those tests skip and the suite still passes.
 *
 * The envelope vectors come from fixtures/envelope-vectors.json when it exists
 * (the same file test/envelope.test.mjs asserts against, so both halves of the
 * protocol are pinned to identical bytes). When it does not, they are built
 * here with node:zlib, which is what wrote the fixture in the first place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "web", "page-template.html");
const VECTORS = join(ROOT, "fixtures", "envelope-vectors.json");

const html = readFileSync(PAGE, "utf8");

/* ------------------------------------------------------------ the sandbox -- */
/* The envelope code is one contiguous run in the page, between the base64
   helpers and the display tables. Both ends are asserted below, so a refactor
   that moves them fails loudly instead of silently testing nothing. */
const SLICE_START = "function b64ToBytes(b64) {";
const SLICE_END = "\nvar TYPES = {";

function envelopeApi() {
  const a = html.indexOf(SLICE_START);
  const b = html.indexOf(SLICE_END, a);
  assert.ok(a > 0, "page-template.html lost its b64ToBytes anchor");
  assert.ok(b > a, "page-template.html lost its TYPES anchor");
  const src = html.slice(a, b);
  const ctx = vm.createContext({
    atob, btoa, TextDecoder, TextEncoder, JSON, Math, Date, Object, Array, String,
    Uint8Array, Uint32Array, DecompressionStream, console
  });
  return vm.runInContext(
    src +
    "\n({ crc32, b64ToBytes, jsonToB64, canGunzip, decodePayloadSync, decodePayload," +
    "   decodeCompletions, get decodeNote() { return decodeNote; } })",
    ctx
  );
}

/* ------------------------------------------------------------- the vectors -- */
function packPlain(kind, obj) {
  return kind + "1." + Buffer.from(JSON.stringify(obj), "utf8").toString("base64") + ".END";
}
function crc32Node(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return ("0000000" + ((crc ^ 0xFFFFFFFF) >>> 0).toString(16)).slice(-8);
}
function packGzip(kind, obj) {
  const gz = gzipSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 9 });
  return kind + "2." + crc32Node(gz) + "." + gz.toString("base64") + ".END";
}

const SAMPLE = {
  v: 4,
  scrapedAt: "2026-09-02T12:00:00.000Z",
  tz: "America/New_York",
  weights: { "MATH 210": 4.2, "Side Project": 3 },
  schedule: [], board: [], done: [], announcements: [], mail: [], errors: [],
  focus: [{ d: "2026-09-02", blocks: [{ c: "MATH 210", what: "Problem Set 4", why: "due Friday", mins: 60 }] }],
  items: [{
    k: "110002::homework::problem set 4", c: "MATH 210", cid: 110002,
    t: "Problem Set 4 — résumé of § 3", d: "2026-09-04T23:59:00.000Z",
    ty: "homework", s: null, src: ["dropbox"], u: null
  }]
};

function vectors() {
  if (existsSync(VECTORS)) {
    const f = JSON.parse(readFileSync(VECTORS, "utf8"));
    if (f && f.plain && f.gzip && f.plain.text && f.gzip.text) return { fixture: true, ...f };
  }
  return {
    fixture: false,
    plain: { text: packPlain("AGD", SAMPLE), json: SAMPLE },
    gzip: { text: packGzip("AGD", SAMPLE), json: SAMPLE },
    corrupt: { text: packGzip("AGD", SAMPLE).replace(/\.([A-Za-z0-9+/=]{20})/, ".AAAAAAAAAAAAAAAAAAAA") }
  };
}

/* =========================================================== 1. build markers */
test("the template still carries both build markers, exactly once each", () => {
  /* render.mjs substitutes by plain string replacement, so a second mention -
     in a comment, in a doc string, anywhere - would be filled in instead of the
     real one and the page would boot holding a placeholder. */
  assert.equal(html.split("__PAYLOAD__").length - 1, 1);
  assert.equal(html.split("__PAGE_CONFIG__").length - 1, 1);
  assert.match(html, /var EMBEDDED = "__PAYLOAD__";/);
  assert.match(html, /var CFG = __PAGE_CONFIG__;/);
  assert.ok(!html.includes("__LEAD_DAYS__"), "lead days now arrive inside __PAGE_CONFIG__");
});

/* ====================================================== 2. nothing hardcoded */
test("no identity string is hardcoded: every one comes from CFG", () => {
  /* Shapes, not names. The point is that NO literal of these kinds survives in
     the template, whatever it might be called - a page that hardcodes even one
     of them points a differently-namespaced install at the wrong documents. */
  const banned = [
    [/"[a-z0-9][a-z0-9-]*-(data|completions|commands|mirror)"/, "a Drive document title"],
    [/"[A-Za-z0-9]+\.(marks|blocks|completions)\.v[0-9]"/, "a localStorage key"],
    [/\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+/,
      "an IANA timezone"],
    [/console\.log\("\[/, "a bracketed console prefix"]
  ];
  for (const [re, what] of banned) {
    const m = html.match(re);
    assert.equal(m, null, `page still hardcodes ${what}: ${m && m[0]}`);
  }
  for (const src of ["CFG.docTitles.data", "CFG.docTitles.completions", "CFG.docTitles.commands",
                     "CFG.storageKeys.marks", "CFG.storageKeys.blocks", "CFG.buckets.side",
                     "CFG.timezone", "CFG.leadTimeDays", "CFG.driveConnector"])
    assert.ok(html.includes(src), `page never reads ${src}`);
});

/* ================================================= 3. the envelopes it emits */
test("the page writes AGC1 marks and AGQ1 commands, and no legacy envelope", () => {
  assert.match(html, /var body = "AGC1\." \+ jsonToB64\(compForWrite\(\)\) \+ "\.END";/);
  assert.match(html, /var body = "AGQ1\." \+ jsonToB64\(\{ v: 1, issuedAt: stamp, commands: cmds \}\) \+ "\.END";/);
  for (const dead of ["FC1.", "FC2.", "FCMD1.", "BA1.", "BAK1."])
    assert.ok(!html.includes(dead), `page still mentions the retired envelope ${dead}`);
});

/* ================================================================= 4. crc32 */
test("crc32 matches the standard IEEE vectors", () => {
  const api = envelopeApi();
  const enc = (s) => new Uint8Array(Buffer.from(s, "utf8"));
  assert.equal(api.crc32(enc("123456789")), "cbf43926");
  assert.equal(api.crc32(enc("")), "00000000");
  assert.equal(api.crc32(enc("a")), "e8b7be43");
  assert.equal(api.crc32(enc("The quick brown fox jumps over the lazy dog")), "414fa339");
  /* eight lowercase hex, always - a short crc would break the AGD2 regex */
  assert.match(api.crc32(enc("x")), /^[0-9a-f]{8}$/);
});

/* ====================================================== 5. the plain reader */
test("decodePayloadSync reads AGD1 and only AGD1", async () => {
  const api = envelopeApi();
  const v = vectors();
  assert.deepEqual(api.decodePayloadSync(v.plain.text), v.plain.json);
  assert.equal(api.decodePayloadSync(v.gzip.text), null, "the sync reader must not see AGD2");
  assert.equal(api.decodePayloadSync(""), null);
  assert.equal(api.decodePayloadSync(null), null);
});

/* ==================================================== 6. the gzip reader */
test("decodePayload reads both AGD1 and AGD2", async () => {
  const api = envelopeApi();
  const v = vectors();
  assert.deepEqual(await api.decodePayload(v.plain.text), v.plain.json);
  assert.deepEqual(await api.decodePayload(v.gzip.text), v.gzip.json);
});

/* ================================================ 7. Google Docs whitespace */
test("a Doc's soft line breaks do not stop either reader", async () => {
  const api = envelopeApi();
  const v = vectors();
  const wrap = (t) => t.replace(/([A-Za-z0-9+/=]{80})/g, "$1\n");
  assert.deepEqual(api.decodePayloadSync(wrap(v.plain.text)), v.plain.json);
  assert.deepEqual(await api.decodePayload(wrap(v.gzip.text)), v.gzip.json);
});

/* ============================================================ 8. corruption */
test("a flipped character fails the checksum instead of parsing garbage", async () => {
  const api = envelopeApi();
  const v = vectors();
  const text = v.corrupt && v.corrupt.text ? v.corrupt.text : null;
  assert.ok(text, "vectors carry a corrupt case");
  const out = await api.decodePayload(text);
  assert.equal(out, null);
  assert.equal(api.decodeNote, "data doc unreadable (checksum)");
});

/* ============================================================ 9. truncation */
test("a truncated document is refused, not half-read", async () => {
  const api = envelopeApi();
  const v = vectors();
  const cut = v.gzip.text.slice(0, v.gzip.text.length - 44) + ".END";
  const out = await api.decodePayload(cut);
  assert.equal(out, null);
  assert.equal(api.decodeNote, "data doc unreadable (checksum)");
});

/* ================================================ 10. malformed and unknown */
test("an unknown prefix, a missing .END and an empty body all decode to null", async () => {
  const api = envelopeApi();
  const v = vectors();
  assert.equal(await api.decodePayload("XYZ9.abcdef.END"), null);
  assert.equal(await api.decodePayload(v.gzip.text.replace(".END", "")), null);
  assert.equal(await api.decodePayload("AGD2..END"), null);
  assert.equal(await api.decodePayload(""), null);
  assert.equal(await api.decodePayload("just some prose someone typed into the doc"), null);
});

/* ============================================== 11. the payload version gate */
test("only payload v4 is accepted; an older or newer schema is refused", async () => {
  const api = envelopeApi();
  for (const v of [1, 2, 3, 5, "4", null, undefined]) {
    const obj = Object.assign({}, SAMPLE, { v });
    assert.equal(api.decodePayloadSync(packPlain("AGD", obj)), null, `v=${String(v)} must be refused`);
    assert.equal(await api.decodePayload(packGzip("AGD", obj)), null, `v=${String(v)} must be refused`);
  }
  assert.ok(api.decodePayloadSync(packPlain("AGD", SAMPLE)), "v=4 is accepted");
});

/* ================================================== 12. the marks bus, AGC1 */
test("decodeCompletions reads the AGC1 tri-state and normalises it", () => {
  const api = envelopeApi();
  const doc = packPlain("AGC", {
    v: 1,
    marks: {
      "110002::homework::problem set 4": { at: "2026-09-02T10:00:00.000Z", via: "user", state: "done" },
      "fb|2026-09-02|MATH 210": { at: "2026-09-02T11:00:00.000Z", via: "page", state: "cancelled" },
      "110003::lab::lab 2": { at: "2026-09-02T09:00:00.000Z" }
    },
    cleared: { "110004::quiz::quiz 1": { at: "2026-09-02T12:00:00.000Z", via: "user" } }
  });
  const out = api.decodeCompletions(doc);
  assert.equal(out.marks["110002::homework::problem set 4"].state, "done");
  assert.equal(out.marks["fb|2026-09-02|MATH 210"].state, "cancelled");
  assert.equal(out.marks["110003::lab::lab 2"].via, "page", "an absent via falls back to the page");
  assert.equal(out.cleared["110004::quiz::quiz 1"].via, "user");
  assert.equal(Object.keys(out.marks).length, 3);
});

test("decodeCompletions refuses every envelope that is not AGC1", () => {
  const api = envelopeApi();
  assert.equal(api.decodeCompletions(packPlain("AGD", SAMPLE)), null);
  assert.equal(api.decodeCompletions(packPlain("AGQ", { v: 1, commands: [] })), null);
  assert.equal(api.decodeCompletions("FC2." + Buffer.from("{}").toString("base64") + ".END"), null);
  assert.equal(api.decodeCompletions('AGC1.' + Buffer.from("[1,2,3]").toString("base64") + ".END"), null,
    "an array is not a completions envelope");
  assert.equal(api.decodeCompletions(""), null);
});

/* ============================== 13. the browser that cannot decompress */
test("without DecompressionStream the page says so instead of throwing", async () => {
  const a = html.indexOf(SLICE_START);
  const b = html.indexOf(SLICE_END, a);
  const ctx = vm.createContext({
    atob, btoa, TextDecoder, TextEncoder, JSON, Math, Date, Object, Array, String,
    Uint8Array, Uint32Array, console   /* deliberately no DecompressionStream */
  });
  const api = vm.runInContext(
    html.slice(a, b) +
    "\n({ decodePayload, decodePayloadSync, get decodeNote() { return decodeNote; } })", ctx);
  const v = vectors();
  assert.equal(await api.decodePayload(v.gzip.text), null);
  assert.equal(api.decodeNote, "this browser cannot read compressed data");
  /* and the plain form still works, so the embedded copy is unaffected */
  assert.deepEqual(await api.decodePayload(v.plain.text), v.plain.json);
});

/* ======================================= 14. the shared fixture, when it exists */
test("fixtures/envelope-vectors.json decodes with the page's own reader", async (t) => {
  if (!existsSync(VECTORS)) return t.skip("fixtures/envelope-vectors.json not present");
  const f = JSON.parse(readFileSync(VECTORS, "utf8"));
  const api = envelopeApi();
  assert.deepEqual(api.decodePayloadSync(f.plain.text), f.plain.json);
  assert.deepEqual(await api.decodePayload(f.gzip.text), f.gzip.json);
  if (f.corrupt && f.corrupt.text) {
    assert.equal(await api.decodePayload(f.corrupt.text), null);
    assert.ok(api.decodeNote, "a refusal always says why");
  }
});

/* ============================================ 15-16. the page itself (jsdom) */
async function loadJsdom() {
  try { return (await import("jsdom")).JSDOM; } catch (e) { return null; }
}
/* The page kicks off refresh(), pullCompletions() and pushBlocksOnLoad() at the
   bottom of its script. With no window.claude every one of them resolves to
   null and repaints, but they do it a microtask later - so let them land before
   asserting, and only then close the window (which is what stops its clock). */
const settle = () => new Promise((r) => setTimeout(r, 80));

const PAGE_CONFIG = {
  ns: "agenda",
  timezone: "America/New_York",
  title: "Weekly Agenda",
  leadTimeDays: { exam: 7, project: 5, lab: 5, homework: 3, quiz: 2, default: 3 },
  docTitles: { data: "agenda-data", completions: "agenda-completions", commands: "agenda-commands" },
  storageKeys: { marks: "agenda.marks.v1", blocks: "agenda.blocks.v1" },
  buckets: { side: "Side Project", mail: "Mail", research: "Research" },
  standardsPlan: { enabled: false, course: null, label: "Standards" },
  wakeTime: "10:00",
  maxWeight: 5,
  driveConnector: "Google Drive"
};

function build(payload, cfg) {
  return html
    .replace('"__PAYLOAD__"', JSON.stringify(packPlain("AGD", payload)))
    .replace("__PAGE_CONFIG__", JSON.stringify(cfg));
}

test("the page boots with no window.claude and paints the week", async (t) => {
  const JSDOM = await loadJsdom();
  if (!JSDOM) return t.skip("jsdom is not installed (it is not a dependency)");
  const errors = [];
  const dom = new JSDOM(build(SAMPLE, PAGE_CONFIG), {
    runScripts: "dangerously", url: "https://example.invalid/agenda",
    virtualConsole: new (await import("jsdom")).VirtualConsole().on("jsdomError", (e) => errors.push(e))
  });
  const doc = dom.window.document;
  await settle();
  assert.deepEqual(errors.map((e) => e.message), [], "the page threw while booting");
  assert.equal(doc.title, "Weekly Agenda", "the title comes from CFG.title");
  assert.equal(doc.getElementById("pageTitle").textContent, "Weekly Agenda");
  assert.match(doc.getElementById("tzNote").textContent, /America\/New_York/);
  assert.ok(doc.getElementById("app").innerHTML.includes("MATH 210"), "the week rendered");
  assert.ok(!doc.getElementById("app").innerHTML.includes("Loading the week"));
  dom.window.close();
});

test("the standards card needs BOTH the build switch and a plan in the payload", async (t) => {
  const JSDOM = await loadJsdom();
  if (!JSDOM) return t.skip("jsdom is not installed (it is not a dependency)");
  const plan = { metF: 4, metA: 2, focusNames: ["S3 Kinematics"], nextSitting: { date: "2026-09-12" } };
  const withPlan = Object.assign({}, SAMPLE, { standardsPlan: plan });

  /* switched off in the build: the payload may carry a plan and the card stays away */
  let dom = new JSDOM(build(withPlan, PAGE_CONFIG), { runScripts: "dangerously", url: "https://example.invalid/a" });
  await settle();
  assert.ok(!dom.window.document.getElementById("app").innerHTML.includes("standards"));
  dom.window.close();

  /* switched on, and labelled by the build rather than by a course code in the page */
  const on = Object.assign({}, PAGE_CONFIG, {
    standardsPlan: { enabled: true, course: "PHYS 221", label: "PHYS 221" }
  });
  dom = new JSDOM(build(withPlan, on), { runScripts: "dangerously", url: "https://example.invalid/a" });
  await settle();
  assert.ok(dom.window.document.getElementById("app").innerHTML.includes("PHYS 221 standards"));
  dom.window.close();

  /* switched on but the term sent no plan: still no card, and no crash */
  dom = new JSDOM(build(SAMPLE, on), { runScripts: "dangerously", url: "https://example.invalid/a" });
  await settle();
  assert.ok(!dom.window.document.getElementById("app").innerHTML.includes("standards"));
  dom.window.close();
});

/* ===================================== 17. ONE FRAME: the trimmed weekly grid
 *
 * The week is drawn in the hours it actually uses; the dead time either side is
 * folded behind two rails that open on a tap or under a drag. Three things have
 * to hold and each is asserted below:
 *   1. the RANGE is right - trimmed outside, never inside (a gap between two
 *      tasks is real information and stays on screen, to scale);
 *   2. the SCALE is still exact - gpct() and colMinuteAt() are inverses over
 *      the trimmed window, so a drag lands on the minute under the pointer;
 *   3. the folded hours stay REACHABLE - by tap, and by pushing a block at the
 *      edge of the canvas, which must open the fold without dropping the drag.
 *
 * HARNESS NOTES for whoever extends this.
 *   * The page reads the real clock, so these tests pin it: `beforeParse`
 *     swaps in a Date whose `now` is fixed. Without that, "now widens the
 *     frame" makes the rendered range depend on what time the suite runs.
 *   * jsdom has no layout, so `getBoundingClientRect` is stubbed on
 *     Element.prototype - NOT on the nodes. dragRelay() redraws the grid
 *     mid-gesture and node stubs would die with the nodes they were put on.
 *     The stub is sized so one pixel is one minute at this fixture's frame.
 *   * jsdom has no PointerEvent; pev() builds a MouseEvent and defines
 *     pointerId/pointerType on it, which is all the handlers read.
 *   * Column x matters: COL_X keeps a move-drag inside today's column, or it
 *     silently becomes a cross-day drag.
 */

const NO_EDGE = { up: false, dn: false };
/* jsdom's window is 1024x768 and lays nothing out, so every offsetHeight is 0:
   fitGrid() sees the whole viewport minus its own reserve. */
const AVAIL = 768 - 132;
/* 18:00Z is 14:00 in the fixture's America/New_York, comfortably inside the
   planned day, so `now` never widens the frame and the range is the fixture's. */
const FIXED = Date.parse("2026-09-02T18:00:00.000Z");
const TODAY = "2026-09-02";
const dayAfter = (n) => new Date(Date.parse(TODAY + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/* 08:30-10:00 and 20:00-21:00 today, plus four 11:59 PM deadlines across the
   week. That gives a frame of 08:00-22:00 - 840 minutes - with eight hours
   folded above it, two below, and four closing-bell deadlines on the foot rail. */
const FRAME_SAMPLE = {
  v: 4,
  scrapedAt: "2026-09-02T12:00:00.000Z",
  tz: "America/New_York",
  weights: { "MATH 210": 4.2, "PHYS 221": 4 },
  schedule: [], board: [], done: [], announcements: [], mail: [], errors: [],
  focus: [{
    d: TODAY,
    blocks: [
      { c: "MATH 210", what: "Problem Set 4", why: "due Friday", t: "08:30", mins: 90 },
      { c: "PHYS 221", what: "Lab writeup", why: "due Friday", t: "20:00", mins: 60 }
    ]
  }],
  items: [0, 1, 2, 3].map((i) => ({
    k: `11000${i}::homework::task ${i}`,
    c: i % 2 ? "PHYS 221" : "MATH 210",
    cid: 110000 + i,
    t: `Task ${i}`,
    d: `${dayAfter(i)}T23:59:00.000-04:00`,
    ty: "homework", s: null, src: ["dropbox"], u: null
  }))
};
/* the evening block: draggable, sized, the only one of its course that day */
const DRAG_KEY = `fb::${TODAY}::1`;

/** A pointer event jsdom will carry. It has no PointerEvent, and the handlers
 *  only ever read these five fields off it. */
function pev(win, type, x, y, opts = {}) {
  const e = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(e, "pointerId", { value: opts.id === undefined ? 7 : opts.id });
  Object.defineProperty(e, "pointerType", { value: opts.type || "mouse" });
  return e;
}

/** Give the columns a box on the PROTOTYPE, one minute per pixel at the
 *  fixture's 840-minute frame, so an assertion reads directly. */
function stubLayout(win, height) {
  const real = win.Element.prototype.getBoundingClientRect;
  win.Element.prototype.getBoundingClientRect = function () {
    const cl = this.classList;
    if (cl && cl.contains("tg-col")) {
      const cols = Array.prototype.slice.call(this.parentNode.querySelectorAll(".tg-col"));
      const i = cols.indexOf(this);
      return { top: 0, bottom: height, height, left: i * 100, right: i * 100 + 100, width: 100, x: i * 100, y: 0 };
    }
    if (cl && cl.contains("tg-scroll"))
      return { top: 0, bottom: height, height, left: 0, right: 700, width: 700, x: 0, y: 0 };
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
  };
  return () => { win.Element.prototype.getBoundingClientRect = real; };
}

/** Boot the page on a frozen clock, collecting anything it threw or logged. */
async function bootFrame(t, payload = FRAME_SAMPLE, cfg = PAGE_CONFIG) {
  const JSDOM = await loadJsdom();
  if (!JSDOM) return null;
  const { VirtualConsole } = await import("jsdom");
  const errors = [];
  const dom = new JSDOM(build(payload, cfg), {
    runScripts: "dangerously",
    url: "https://example.invalid/agenda",
    virtualConsole: new VirtualConsole().on("jsdomError", (e) => errors.push(e.message)),
    beforeParse(w) {
      const Real = w.Date;
      class Frozen extends Real {
        constructor(...a) { super(...(a.length ? a : [FIXED])); }
        static now() { return FIXED; }
      }
      w.Date = Frozen;
    }
  });
  t.after(() => dom.window.close());
  await settle();
  return { win: dom.window, doc: dom.window.document, errors };
}

const q = (doc, sel) => doc.querySelector(sel);
const qa = (doc, sel) => Array.prototype.slice.call(doc.querySelectorAll(sel));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const rail = (doc, side) => q(doc, `.tg-edge[data-edge="${side}"]`);
const gridHours = (doc) => {
  const g = q(doc, ".tgrid");
  return g ? g.style.getPropertyValue("--hours").trim() : null;
};
/* today's column index decides the x a move-drag has to stay inside */
const colX = (doc) => qa(doc, ".tg-col[data-dk]").findIndex((c) => c.getAttribute("data-dk") === TODAY) * 100 + 50;

/* ------------------------------------------------------------- the range -- */

test("range: an empty week gets a working day, not a sliver", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  /* 08:00 to 21:00 - GRID_DEF_END is 20:00 and lands flush on an hour line, so
     the foot buys one more row for a block's resize grip */
  const r = b.win.computeGridRange([], [], null, NO_EDGE);
  assert.equal(r.s, 480);
  assert.equal(r.e, 1260);
  assert.equal(r.span, 780);
  assert.ok(r.span >= 240, "and never narrower than the four-hour minimum");
});

test("range: items at 09:10 and 22:00 both fit, and the dead ends are trimmed", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const r = b.win.computeGridRange([[550, 610], [1260, 1320]], [], null, NO_EDGE);
  assert.equal(r.s, 540, "09:00 - rounded out to the hour below 09:10");
  assert.equal(r.e, 1380, "23:00 - the 22:00 foot lands on a line, so it gets its grip row");
  assert.ok(r.s <= 550 && r.e >= 1320, "both items are inside the frame");
  assert.equal(r.hidLo, 540, "the nine dead early-morning hours are folded");
  assert.equal(r.hidHi, 60, "and the dead hour before midnight");
  assert.equal(r.span, 840);
});

test("range: a gap BETWEEN two tasks stays on screen, and to scale", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  /* 10:00-12:00 and 15:00-17:00: the 12:00-15:00 gap is not dead time, it is
     three hours of the user's day and the whole point of a calendar. Collapsing
     it would also have broken gpct/colMinuteAt's exact inverse. */
  const r = b.win.computeGridRange([[600, 720], [900, 1020]], [], null, NO_EDGE);
  assert.deepEqual([r.s, r.e, r.span], [600, 1080, 480]);
  assert.equal(b.win.gpct(r, 720), 25, "12:00 sits a quarter of the way down");
  assert.equal(b.win.gpct(r, 900), 62.5, "15:00 at five eighths");
  assert.equal(b.win.gpct(r, 900) - b.win.gpct(r, 720), 37.5,
    "and the three-hour gap is three of the frame's eight hours");
});

test("range: an 11:59 PM deadline pins to the foot rail, not into three empty hours", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const r = b.win.computeGridRange([[600, 1200]], [1439], null, NO_EDGE);
  assert.equal(r.e, 1260, "the frame ends just past the last real block, not at midnight");
  assert.equal(r.pinned, 1, "and the closing-bell deadline is counted on the rail");
  assert.equal(r.hidHi, 180, "three hours folded that held nothing but that one line");
  assert.equal(b.win.gpct(r, 1439), 100, "it renders on the foot of the frame, still visible");
  /* a deadline that is NOT the closing bell opens the frame like anything else */
  const r2 = b.win.computeGridRange([[600, 1200]], [1290], null, NO_EDGE);
  assert.equal(r2.e, 1320, "21:30 is a real slot in the evening, so the frame reaches it");
  assert.equal(r2.pinned, 0);
});

test("range: `now` widens the frame only when it is near what is planned", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const spans = [[600, 720]];
  assert.equal(b.win.computeGridRange(spans, [], 120, NO_EDGE).s, 600,
    "opening the page at 02:00 does not stretch the week to 22 hours");
  assert.equal(b.win.computeGridRange(spans, [], 540, NO_EDGE).s, 540,
    "but 09:00 against a 10:00 start is the same morning");
});

test("range: opening a rail widens the live frame and leaves the folded one alone", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const spans = [[600, 1200]];
  const shut = b.win.computeGridRange(spans, [], null, NO_EDGE);
  const down = b.win.computeGridRange(spans, [], null, { up: false, dn: true });
  const both = b.win.computeGridRange(spans, [], null, { up: true, dn: true });
  assert.equal(down.e, 1440, "the foot rail opens to midnight");
  assert.equal(down.s, shut.s, "and does not disturb the head");
  assert.deepEqual([both.s, both.e], [0, 1440], "both rails open the whole day");
  /* the folded frame is remembered, so the rails still know what they hold */
  assert.deepEqual([both.fs, both.fe], [shut.s, shut.e]);
  assert.equal(both.hidLo, shut.s);
  assert.equal(both.hidHi, 1440 - shut.e);
});

/* ---------------------------------------------------------- the rendered -- */

test("frame: the week is drawn trimmed, and both rails say what they hold", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  assert.deepEqual(
    { s: win.state.win.s, e: win.state.win.e, pinned: win.state.win.pinned },
    { s: 480, e: 1320, pinned: 4 });
  assert.equal(gridHours(doc), "14", "fourteen hours on the canvas, not the old sixteen");
  assert.equal(qa(doc, ".tg-hr").length, 14, "one label per hour in the frame");
  assert.equal(txt(qa(doc, ".tg-hr")[0]), "8 AM");
  assert.equal(txt(qa(doc, ".tg-hr")[13]), "9 PM");

  const up = rail(doc, "up"), dn = rail(doc, "dn");
  assert.ok(up && dn, "both ends are folded, so both rails are offered");
  assert.match(txt(up), /8 earlier hours/);
  assert.match(txt(dn), /2 later hours/);
  assert.match(txt(dn), /4 due 11:59 PM/, "the fold names the deadlines sitting on it");
  assert.equal(up.getAttribute("aria-expanded"), "false");
  assert.match(dn.getAttribute("aria-label"), /Show 2 later hours, holding 4 deadlines due at 11:59 PM/);
  /* pinned deadlines land on the foot and stack their chips upward, not off it */
  assert.equal(qa(doc, ".mk").length, 4);
  assert.equal(qa(doc, ".mk.up").length, 4);
  assert.deepEqual(b.errors, []);
});

test("frame: tapping the foot rail makes the folded hours addressable again", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  assert.equal(win.gpct(win.state.win, 1380), 100, "23:00 is off the frame, clamped to its foot");

  rail(doc, "dn").click();
  await settle();
  assert.equal(win.state.win.e, 1440, "the fold opened to midnight");
  assert.equal(gridHours(doc), "16");
  assert.equal(win.gpct(win.state.win, 1380), 93.75, "and 23:00 now has a real place on it");
  const dn = rail(doc, "dn");
  assert.equal(dn.getAttribute("aria-expanded"), "true");
  assert.match(txt(dn), /Fold the late hours away/);
  assert.equal(rail(doc, "up").getAttribute("aria-expanded"), "false", "the head rail is untouched");

  dn.click();
  await settle();
  assert.equal(win.state.win.e, 1320, "and it folds back");
  assert.equal(gridHours(doc), "14");
  assert.deepEqual(b.errors, []);
});

test("frame: a new week re-folds the rails", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  rail(doc, "dn").click();
  await settle();
  assert.equal(win.state.edge.dn, true);
  q(doc, '[data-nav="1"]').click();
  await settle();
  /* state.edge is a jsdom-realm object, so compare fields rather than deepEqual */
  assert.equal(win.state.edge.up, false);
  assert.equal(win.state.edge.dn, false);
});

/* ----------------------------------------------------------- the fitting -- */

test("one frame: the hour is sized from the viewport, with a readability floor", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { doc } = b;
  const grid = q(doc, ".tgrid"), sc = q(doc, ".tg-scroll");
  /* 14 hours into the space one screen leaves: comfortably above the floor */
  assert.equal(grid.style.getPropertyValue("--pxh"), Math.round((AVAIL / 14) * 1000) / 1000 + "px");
  assert.equal(sc.style.maxHeight, AVAIL + "px", "the canvas is capped at one frame");
  assert.ok(AVAIL / 14 >= 30 && AVAIL / 14 <= 64, "no clamp was needed here");

  /* open both rails: 24 hours will not fit legibly, so the FLOOR wins and the
     canvas keeps its own scrollbar rather than squashing the rows */
  rail(doc, "up").click();
  await settle();
  rail(doc, "dn").click();
  await settle();
  assert.equal(gridHours(doc), "24");
  assert.equal(q(doc, ".tgrid").style.getPropertyValue("--pxh"), "30px",
    "the readability floor holds instead of squashing to illegibility");
  assert.equal(q(doc, ".tg-scroll").style.maxHeight, AVAIL + "px",
    "and the overflow becomes an explicit scroller - the documented fallback");
});

test("one frame: a short week is not stretched into stripes", async (t) => {
  /* one 15-minute block on the whole week: the range floors at four hours and
     the hour ceilings at PXH_MAX rather than growing to a sixth of the screen */
  const short = Object.assign({}, FRAME_SAMPLE, {
    items: [],
    focus: [{ d: TODAY, blocks: [{ c: "MATH 210", what: "Standup", t: "13:00", mins: 15 }] }]
  });
  const b = await bootFrame(t, short);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  assert.equal(b.win.state.win.span, 240, "the four-hour minimum frame");
  assert.equal(q(b.doc, ".tgrid").style.getPropertyValue("--pxh"), "64px", "clamped at the ceiling");
});

/* -------------------------------------------------------------- the drag -- */

test("drag: pointer-to-minute is computed at the TRIMMED scale", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  /* the frame is 840 minutes; give the column 840px so one pixel is one minute */
  t.after(stubLayout(win, 840));
  assert.deepEqual([win.state.win.s, win.state.win.span], [480, 840]);
  /* the scale is live, not a constant: half way down a 14-hour frame is 15:00,
     where a hardcoded 16-hour one would have read 16:00 */
  assert.equal(Math.round(win.colMinuteAt(q(doc, ".tg-col"), 420)), 900);

  const x = colX(doc);
  const el = q(doc, `.tblock[data-drag][data-bc="PHYS 221"]`);
  assert.ok(el, "the block under test is on the grid");
  el.dispatchEvent(pev(win, "pointerdown", x, 720));          // 480 + 720 = 20:00
  doc.dispatchEvent(pev(win, "pointermove", x, 660));         // 480 + 660 = 19:00
  doc.dispatchEvent(pev(win, "pointerup", x, 660));
  await settle();

  const cmds = win.blockCommands();
  assert.equal(cmds.length, 1);
  assert.deepEqual({ op: cmds[0].op, day: cmds[0].day, c: cmds[0].c, t: cmds[0].t, mins: cmds[0].mins },
    { op: "block", day: TODAY, c: "PHYS 221", t: "19:00", mins: 60 },
    "the block landed on the minute the pointer was over, at the trimmed scale");
  assert.deepEqual(b.errors, []);
});

test("drag: the bottom edge resizes at the trimmed scale too", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  t.after(stubLayout(win, 840));
  const x = colX(doc);
  const grip = q(doc, `.tblock[data-drag][data-bc="PHYS 221"]`).querySelector(".tbgrip");
  assert.ok(grip, "the block offers a resize grip");
  grip.dispatchEvent(pev(win, "pointerdown", x, 780));        // 480 + 780 = 21:00, its foot
  doc.dispatchEvent(pev(win, "pointermove", x, 840));         // 480 + 840 = 22:00
  doc.dispatchEvent(pev(win, "pointerup", x, 840));
  await settle();

  const cmds = win.blockCommands();
  assert.equal(cmds.length, 1);
  assert.deepEqual({ day: cmds[0].day, c: cmds[0].c, t: cmds[0].t, mins: cmds[0].mins },
    { day: TODAY, c: "PHYS 221", t: "20:00", mins: 120 },
    "the foot followed the pointer; the head never moved");
  assert.deepEqual(b.errors, []);
});

test("drag: pushing a block past the foot opens the folded hours, and keeps the gesture", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  t.after(stubLayout(win, 840));
  assert.equal(win.state.win.e, 1320, "22:00 is the foot of the folded frame");
  assert.equal(win.state.edge.dn, false);

  const x = colX(doc);
  q(doc, `.tblock[data-drag][data-bc="PHYS 221"]`).dispatchEvent(pev(win, "pointerdown", x, 720));
  /* 900px is past the 840px canvas: the pointer is reaching for 23:00, which is
     not currently drawn. The fold has to open rather than refuse the move. */
  doc.dispatchEvent(pev(win, "pointermove", x, 900));
  assert.equal(win.state.edge.dn, true, "the foot rail opened under the drag");
  assert.equal(win.state.win.e, 1440, "and the frame now reaches midnight");
  assert.ok(win.drag && win.drag.armed,
    "the gesture survived the redraw - a rail that dropped the block would be worse than none");
  assert.equal(rail(doc, "dn").getAttribute("aria-expanded"), "true");

  doc.dispatchEvent(pev(win, "pointerup", x, 900));
  await settle();
  const cmds = win.blockCommands();
  assert.equal(cmds.length, 1, "and the drop committed");
  const landed = parseInt(cmds[0].t.slice(0, 2), 10) * 60 + parseInt(cmds[0].t.slice(3), 10);
  assert.ok(landed >= 1320, `the block landed in the hours that had been folded away, at ${cmds[0].t}`);
  assert.ok(landed <= win.DAY_END_MAX - cmds[0].mins, "still inside what the ingester accepts");
  assert.deepEqual(b.errors, []);
});

test("drag: the head rail opens the same way, and only once per gesture", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  t.after(stubLayout(win, 840));
  const x = colX(doc);
  q(doc, `.tblock[data-drag][data-bc="PHYS 221"]`).dispatchEvent(pev(win, "pointerdown", x, 720));
  doc.dispatchEvent(pev(win, "pointermove", x, -60));         // above the canvas: before 08:00
  assert.equal(win.state.edge.up, true, "the head rail opened");
  assert.equal(win.state.win.s, 0, "and the frame reaches back to midnight");
  assert.ok(win.drag && win.drag.armed, "the gesture is still live");
  /* a second reach at the same end is a no-op, not another redraw */
  const before = win.state.win.span;
  doc.dispatchEvent(pev(win, "pointermove", x, -80));
  assert.equal(win.state.win.span, before, "the rail latches: one open per side per drag");
  doc.dispatchEvent(pev(win, "pointerup", x, -60));
  await settle();
  assert.deepEqual(b.errors, []);
});

test("frame: trimming changed the layout and nothing else about the blocks", async (t) => {
  const b = await bootFrame(t);
  if (!b) return t.skip("jsdom is not installed (it is not a dependency)");
  const { win, doc } = b;
  /* the trimmed frame draws exactly what the untrimmed one did */
  assert.equal(qa(doc, ".tblock[data-drag]").length, 2);
  assert.equal(qa(doc, ".tbgrip").length, 2);
  assert.equal(qa(doc, ".tgrid [data-day]").length, 0, "the rails use [data-edge], not [data-day]");

  /* a keyboard-sized nudge into folded territory still commits, and the frame follows */
  assert.equal(win.commitBlockEdit(DRAG_KEY, TODAY, 1365, 60), true);   // 22:45
  win.render();
  await settle();
  assert.ok(win.state.win.e >= 1425, "a block placed late pulls the frame down to hold it");
  assert.equal(win.blockCommands().length, 1);
  assert.deepEqual(b.errors, []);
});

test("an empty mail list and an empty board hide their panels rather than break", async (t) => {
  const JSDOM = await loadJsdom();
  if (!JSDOM) return t.skip("jsdom is not installed (it is not a dependency)");
  const cfg = Object.assign({}, PAGE_CONFIG, { title: "My Term", ns: "term" });
  const dom = new JSDOM(build(Object.assign({}, SAMPLE, { mail: [], board: [] }), cfg), {
    runScripts: "dangerously", url: "https://example.invalid/agenda"
  });
  const doc = dom.window.document;
  await settle();
  const app = doc.getElementById("app").innerHTML;
  assert.equal(doc.title, "My Term");
  assert.ok(!app.includes("klist"), "no board panel without board entries");
  assert.ok(app.includes("MATH 210"), "the rest of the week still renders");
  /* the marks store is namespaced by CFG, so two agendas never share a key */
  assert.equal(dom.window.MARK_LS, "agenda.marks.v1");
  assert.equal(dom.window.LOGP, "[term]");
  dom.window.close();
});
