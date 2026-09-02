// The wire format, pinned down.
//
// Everything that leaves this machine for the published page, and everything
// that comes back, passes through src/lib/envelope.mjs. The page implements the
// reading half of it in about fifteen lines of browser JavaScript, and the two
// have to agree exactly - a change here that the page cannot parse silently
// strands every already-published artifact, with no error anywhere.
//
// So the golden vectors in fixtures/envelope-vectors.json are asserted from
// BOTH sides: this suite decodes them in Node, and test/page-ui.test.mjs
// decodes the same strings through the page's own decoder. If the two ever
// disagree, one of these two files fails.
//
// The corruption tests are the ones that earn their keep. The realistic failure
// here is not a bug, it is a transcription: an agent types ten thousand base64
// characters into a document and one of them is wrong, or the last line is
// missing. A truncated gzip stream still starts decompressing, so without the
// checksum the failure surfaces halfway through as unreadable JSON, or worse,
// as a partial object. Every one of those must be a loud refusal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  EnvelopeError,
  KINDS,
  budgetOf,
  crc32,
  pack,
  packWithinBudget,
  slimTiers,
  unpack,
} from "../src/lib/envelope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf-8"));
const VECTORS = readJson("fixtures/envelope-vectors.json");

// ---------------------------------------------------------------------------
// crc32 - standard IEEE, and the vectors everybody checks against
// ---------------------------------------------------------------------------

test("crc32: the canonical check value", () => {
  assert.equal(crc32("123456789"), "cbf43926");
});

test("crc32: three more known vectors, including the empty string", () => {
  for (const [input, expected] of Object.entries(VECTORS.crc32)) {
    assert.equal(crc32(input), expected, `crc32(${JSON.stringify(input)})`);
  }
});

test("crc32: always eight lowercase hex characters", () => {
  for (const s of ["", "a", "é中", "x".repeat(5000)]) {
    assert.match(crc32(s), /^[0-9a-f]{8}$/);
  }
});

test("crc32: a Buffer and its UTF-8 string agree", () => {
  const s = "réduction par lignes";
  assert.equal(crc32(s), crc32(Buffer.from(s, "utf-8")));
});

test("crc32: one flipped bit changes the sum", () => {
  assert.notEqual(crc32("hello world"), crc32("hello worle"));
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

const SAMPLE = { v: 4, items: [{ k: "1::homework::x", t: "Homework 1" }], errors: [] };

test("pack/unpack: every kind round-trips", () => {
  for (const kind of Object.keys(KINDS)) {
    const out = unpack(pack(kind, SAMPLE));
    assert.equal(out.kind, kind);
    assert.deepEqual(out.data, SAMPLE);
  }
});

test("pack: data and mirror compress by default; completions and commands never do", () => {
  assert.ok(pack("data", SAMPLE).startsWith("AGD2."));
  assert.ok(pack("mirror", SAMPLE).startsWith("AGM2."));
  assert.ok(pack("completions", SAMPLE).startsWith("AGC1."));
  assert.ok(pack("commands", SAMPLE).startsWith("AGQ1."));
});

test("pack: the page's two buses stay plain even when asked to compress", () => {
  // No language model is in that path, the documents are small, and the page
  // has to write them synchronously. Compressing them would buy nothing and
  // cost the page a compression stream.
  assert.ok(pack("completions", SAMPLE, { compress: true }).startsWith("AGC1."));
  assert.ok(pack("commands", SAMPLE, { compress: true }).startsWith("AGQ1."));
});

test("pack: compress:false yields the plain form for data", () => {
  const text = pack("data", SAMPLE, { compress: false });
  assert.ok(text.startsWith("AGD1."));
  assert.ok(text.endsWith(".END"));
  const out = unpack(text);
  assert.equal(out.version, 1);
  assert.equal(out.compressed, false);
  assert.deepEqual(out.data, SAMPLE);
});

test("pack: the compressed form carries an eight-hex checksum before the body", () => {
  const text = pack("data", SAMPLE);
  const m = text.match(/^AGD2\.([0-9a-f]{8})\./);
  assert.ok(m, "AGD2 must be prefix, checksum, body");
});

test("unpack: the checksum is over the gzip bytes, not the base64", () => {
  const json = JSON.stringify(SAMPLE);
  const gz = gzipSync(Buffer.from(json, "utf-8"), { level: 9 });
  const text = `AGD2.${crc32(gz)}.${gz.toString("base64")}.END`;
  assert.deepEqual(unpack(text).data, SAMPLE);
});

test("round trip: non-ASCII titles survive both forms", () => {
  const payload = { t: "Homework 3 — réduction par lignes · 作業" };
  assert.deepEqual(unpack(pack("data", payload)).data, payload);
  assert.deepEqual(unpack(pack("data", payload, { compress: false })).data, payload);
});

test("round trip: an empty object and an empty array are both legal payloads", () => {
  assert.deepEqual(unpack(pack("data", {})).data, {});
  assert.deepEqual(unpack(pack("commands", [])).data, []);
});

// ---------------------------------------------------------------------------
// The golden vectors, shared with the page's own decoder
// ---------------------------------------------------------------------------

test("vectors: the plain vector decodes to its recorded JSON", () => {
  const out = unpack(VECTORS.plain.text);
  assert.equal(out.version, 1);
  assert.deepEqual(out.data, VECTORS.plain.json);
});

test("vectors: the gzip vector decodes to its recorded JSON", () => {
  const out = unpack(VECTORS.gzip.text);
  assert.equal(out.version, 2);
  assert.equal(out.compressed, true);
  assert.deepEqual(out.data, VECTORS.gzip.json);
});

test("vectors: the plain and gzip vectors carry the same payload", () => {
  assert.deepEqual(unpack(VECTORS.plain.text).data, unpack(VECTORS.gzip.text).data);
});

test("vectors: the recorded strings are exactly what pack() produces today", () => {
  // This is the regression guard on the format itself. If it fails, the wire
  // format changed - and the page, which asserts against these same strings,
  // is now out of step with this file.
  assert.equal(pack("data", VECTORS.plain.json, { compress: false }), VECTORS.plain.text);
  assert.equal(pack("data", VECTORS.gzip.json), VECTORS.gzip.text);
});

// ---------------------------------------------------------------------------
// Whitespace: a Google Doc inserts soft line breaks wherever it likes
// ---------------------------------------------------------------------------

test("unpack: newlines injected every 80 characters still decode", () => {
  const text = pack("data", SAMPLE);
  const wrapped = text.replace(/(.{80})/g, "$1\n");
  assert.deepEqual(unpack(wrapped).data, SAMPLE);
});

test("unpack: leading, trailing and interior whitespace of every kind is stripped", () => {
  const text = pack("data", SAMPLE);
  const messy = "  \n\t" + text.slice(0, 40) + " \r\n " + text.slice(40) + "\n\n";
  assert.deepEqual(unpack(messy).data, SAMPLE);
});

test("unpack: the plain form tolerates the same mangling", () => {
  const text = pack("completions", { v: 1, marks: {}, cleared: {} });
  assert.deepEqual(unpack(text.replace(/(.{20})/g, "$1\n")).data, { v: 1, marks: {}, cleared: {} });
});

// ---------------------------------------------------------------------------
// Corruption - the failure mode this format actually exists to catch
// ---------------------------------------------------------------------------

const rejects = (text, why) => {
  assert.throws(() => unpack(text), (e) => e instanceof EnvelopeError && e.name === "EnvelopeError", why);
};

test("corruption: the recorded corrupt vector is refused", () => {
  rejects(VECTORS.corrupt.text, VECTORS.corrupt.why);
});

test("corruption: the recorded truncated vector is refused", () => {
  rejects(VECTORS.truncated.text, VECTORS.truncated.why);
});

test("corruption: one flipped base64 character anywhere in the body is refused", () => {
  const text = pack("data", { items: Array.from({ length: 40 }, (_, i) => ({ k: `k${i}`, t: `Item ${i}` })) });
  const body = text.length - 20;
  const flipped = text.slice(0, body) + (text[body] === "A" ? "B" : "A") + text.slice(body + 1);
  rejects(flipped, "a mistyped character must never decode to a plausible payload");
});

test("corruption: dropping the last 40 characters is refused", () => {
  const text = pack("data", { items: Array.from({ length: 40 }, (_, i) => ({ k: `k${i}` })) });
  rejects(text.slice(0, -44) + ".END", "a truncated gzip stream still starts decompressing");
});

test("corruption: a checksum that does not match the body names both values", () => {
  const text = pack("data", SAMPLE);
  const wrong = text.replace(/^AGD2\.[0-9a-f]{8}\./, "AGD2.deadbeef.");
  assert.throws(
    () => unpack(wrong),
    (e) => e instanceof EnvelopeError && /deadbeef/.test(e.message) && /truncated or edited/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test("malformed: an unknown prefix is refused", () => {
  rejects("XYZ1.aGVsbG8=.END");
  rejects("BA1.aGVsbG8=.END", "an older, foreign format is still unknown");
});

test("malformed: a missing .END terminator is refused", () => {
  assert.throws(
    () => unpack("AGD1.eyJhIjoxfQ=="),
    (e) => e instanceof EnvelopeError && /\.END/.test(e.message),
  );
});

test("malformed: an empty body is refused in both forms", () => {
  rejects("AGD1..END");
  rejects("AGD2.cbf43926..END");
});

test("malformed: an empty string and a non-string are refused", () => {
  rejects("");
  rejects("   \n  ");
  rejects(null);
  rejects(42);
});

test("malformed: a checksum that is not eight hex characters is refused", () => {
  rejects("AGD2.xyz.aGVsbG8=.END");
  rejects("AGD2.cbf4392.aGVsbG8=.END");
});

test("malformed: a body that is valid base64 but not JSON is refused", () => {
  rejects("AGD1." + Buffer.from("not json at all", "utf-8").toString("base64") + ".END");
});

test("malformed: a body that is not base64 at all is refused", () => {
  rejects("AGD1.***not-base64***.END");
});

test("malformed: a version 2 body that is not a gzip stream is refused", () => {
  const bytes = Buffer.from("this is not gzip", "utf-8");
  rejects(`AGD2.${crc32(bytes)}.${bytes.toString("base64")}.END`);
});

test("pack: an unknown kind is refused", () => {
  assert.throws(() => pack("nonsense", {}), (e) => e instanceof EnvelopeError);
});

// ---------------------------------------------------------------------------
// Budget and slim tiers
// ---------------------------------------------------------------------------

test("budgetOf: reads the configured caps and falls back to the documented defaults", () => {
  assert.equal(budgetOf({ drive: { maxEmitChars: 9000, maxMirrorChars: 15000 } }, "data"), 9000);
  assert.equal(budgetOf({ drive: { maxEmitChars: 9000, maxMirrorChars: 15000 } }, "mirror"), 15000);
  assert.equal(budgetOf({}, "data"), 12000);
  assert.equal(budgetOf(null, "mirror"), 20000);
});

test("slimTiers: there are four tiers, numbered 0 to 3, and tier 0 changes nothing", () => {
  assert.equal(slimTiers.length, 4);
  assert.deepEqual(slimTiers.map((t) => t.tier), [0, 1, 2, 3]);
  const p = { items: [{ k: "a", d: "2026-01-01T00:00:00.000Z", desc: "keep me" }] };
  assert.deepEqual(slimTiers[0].apply(p, new Date()), p);
});

test("slimTiers: tier 1 drops descriptions outside the -14d..+21d window and keeps the rest", () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const payload = {
    items: [
      { k: "near", d: "2026-09-16T00:00:00.000Z", desc: "stays" },
      { k: "far", d: "2026-12-01T00:00:00.000Z", desc: "goes" },
      { k: "old", d: "2026-06-01T00:00:00.000Z", desc: "goes" },
      { k: "nodesc", d: "2026-12-01T00:00:00.000Z" },
    ],
  };
  const out = slimTiers[1].apply(payload, now);
  assert.equal(out.items[0].desc, "stays");
  assert.equal(out.items[1].desc, undefined);
  assert.equal(out.items[2].desc, undefined);
  assert.equal(out.items.length, 4, "tier 1 drops blurbs, never items");
  assert.equal(payload.items[1].desc, "goes", "the input payload is never mutated");
});

test("slimTiers: tier 2 drops old announcements and caps mail at eight", () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const out = slimTiers[2].apply(
    {
      announcements: [{ p: "2026-09-13T00:00:00.000Z" }, { p: "2026-08-01T00:00:00.000Z" }],
      mail: Array.from({ length: 12 }, (_, i) => ({ subj: `m${i}` })),
    },
    now,
  );
  assert.equal(out.announcements.length, 1);
  assert.equal(out.mail.length, 8);
});

test("slimTiers: tier 3 shortens the done window and caps the board at five", () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const out = slimTiers[3].apply(
    {
      done: [{ at: "2026-09-12T00:00:00.000Z" }, { at: "2026-09-02T00:00:00.000Z" }],
      board: Array.from({ length: 10 }, (_, i) => ({ repo: "r", n: i })),
    },
    now,
  );
  assert.equal(out.done.length, 1);
  assert.equal(out.board.length, 5);
});

test("packWithinBudget: a small payload needs tier 0", () => {
  const r = packWithinBudget("data", SAMPLE, { budget: 12000, now: new Date() });
  assert.equal(r.tier, 0);
  assert.equal(r.over, false);
  assert.ok(r.text.startsWith("AGD2."));
});

test("packWithinBudget: it climbs the tiers only as far as it must", () => {
  const now = new Date("2026-09-14T13:00:00.000Z");
  const payload = {
    items: Array.from({ length: 60 }, (_, i) => ({
      k: `k${i}`,
      d: "2027-06-01T00:00:00.000Z",
      // Random-ish text so gzip cannot collapse it to nothing.
      desc: `blurb ${i} ${Math.PI * i} ${(i * 7919).toString(36).repeat(4)}`,
    })),
  };
  const full = pack("data", payload).length;
  const r = packWithinBudget("data", payload, { budget: full - 1, now });
  assert.equal(r.tier, 1, "dropping far-future blurbs is the first thing that gives");
  assert.ok(!r.over);
  assert.ok(r.text.length <= full - 1);
});

test("packWithinBudget: an impossible budget reports over, and never truncates", () => {
  const r = packWithinBudget("data", { items: Array.from({ length: 200 }, (_, i) => ({ k: `k${i}` })) }, {
    budget: 10,
    now: new Date(),
  });
  assert.equal(r.over, true);
  assert.equal(r.tier, 3, "it reports the last tier it tried");
  // The text is still a complete, decodable envelope - the caller writes it to
  // an oversize file and the page falls back to its embedded copy.
  assert.ok(unpack(r.text).data.items.length === 200);
});

// ---------------------------------------------------------------------------
// The golden size test: the regression guard for the whole transport fix
// ---------------------------------------------------------------------------

/** Build the payload the demo term produces, without running the renderer. */
function demoPayload() {
  const latest = readJson("fixtures/demo/data/latest.json");
  const descriptions = readJson("fixtures/demo/data/descriptions.json");
  const model = readJson("fixtures/demo/data/study-model.json");
  const board = readJson("fixtures/demo/data/board-items.json");
  const mail = readJson("fixtures/demo/data/outlook-mail.json");
  const norm = (t) =>
    t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const key = (i) => `${i.courseId}::${i.type}::${norm(i.title)}`;
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2026, 8, 14 + i)).toISOString().slice(0, 10),
  );
  return {
    v: 4,
    scrapedAt: latest.scrapedAt,
    tz: "America/New_York",
    weights: Object.fromEntries(Object.entries(model.courses).map(([k, v]) => [k, v.alloc])),
    schedule: [],
    board: board.board,
    done: [],
    items: latest.items.map((i) => ({
      k: key(i),
      c: i.course,
      cid: i.courseId,
      t: i.title,
      d: i.due,
      ty: i.type,
      s: i.submitted,
      src: i.sources,
      ...(descriptions[key(i)] ? { desc: descriptions[key(i)] } : {}),
      u: i.url,
    })),
    announcements: latest.announcements.map((a) => ({ c: a.course, t: a.title, p: a.posted })),
    mail: mail.mail,
    focus: days.map((d) => ({
      d,
      blocks: [
        { c: "PHYS 221", what: "Problem Set 3", why: "due soon", t: "10:30", mins: 90 },
        { c: "MATH 210", what: "Homework 3", why: "due soon", t: "12:15", mins: 75 },
        { c: "CHEM 115", what: "Lab Report 2", why: "due soon", t: "19:30", mins: 90 },
      ],
    })),
    errors: [],
  };
}

test("golden size: the demo payload packs well under the default budget", () => {
  const text = pack("data", demoPayload());
  assert.ok(text.length < 12000, `packed demo payload is ${text.length} chars, budget is 12000`);
});

test("golden size: compression is worth at least 4x on the demo payload", () => {
  const payload = demoPayload();
  const plain = pack("data", payload, { compress: false }).length;
  const gz = pack("data", payload).length;
  assert.ok(plain / gz >= 4, `ratio was ${(plain / gz).toFixed(2)} (plain ${plain}, gzip ${gz})`);
});

test("golden size: at production scale the ratio passes 5x, which is what the transport rests on", () => {
  // A full term is several times the demo's size, and the extra volume is more
  // of the same keys - which is exactly what gzip is good at. This is the
  // number the whole design depends on: without it the payload does not fit in
  // one message and a scheduled run cannot finish.
  const base = demoPayload();
  const payload = {
    ...base,
    items: Array.from({ length: 5 }, (_, term) =>
      base.items.map((it) => ({ ...it, k: `${it.k}-${term}` })),
    ).flat(),
  };
  const plain = pack("data", payload, { compress: false }).length;
  const gz = pack("data", payload).length;
  assert.ok(plain > 40000, `the scaled payload should be production-sized, was ${plain}`);
  assert.ok(plain / gz >= 5, `ratio was ${(plain / gz).toFixed(2)} (plain ${plain}, gzip ${gz})`);
});
