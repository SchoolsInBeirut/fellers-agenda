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
