// envelope.mjs - the wire format for everything that travels through a Google Doc.
//
// WHY THERE IS AN ENVELOPE AT ALL
//
// The published page cannot reach this machine, and this machine cannot reach
// the published page. The only channel between them is a Google Doc that an
// agent (going out) and the page itself (coming back) can both touch. A Doc is
// a rich-text document, not a file: it wraps long lines, it can pick up a
// stray space, and anything that reads it back gets prose. So every message is
// wrapped in a prefix, a body of base64, and a literal `.END`, and every reader
// strips whitespace before it decodes. The prefix says what the message is and
// which form it is in; `.END` says the transcription was not cut short.
//
// WHY SOME OF THEM ARE COMPRESSED
//
// Going out, the bytes are typed by a language model - it reads the payload
// file and passes its exact contents as a tool argument. That makes size a real
// budget rather than a nicety: an uncompressed payload costs more tokens to
// move than a whole context window has. Gzip on JSON with highly repeated keys
// wins about 6x, which turns a run that could not finish into one that finishes
// with room to spare. Coming back, the page writes its own docs directly and no
// model is in the path, so those stay plain and stay small.
//
// WHY THERE IS A CHECKSUM
//
// The realistic corruption mode here is a truncated or mistyped transcription,
// and a truncated gzip stream can still start decompressing - it fails late,
// deep inside something that looks like data. The CRC32 is computed over the
// gzip bytes BEFORE base64 so a reader can refuse the whole message up front,
// cheaply, and say why. Standard IEEE CRC-32: crc32("123456789") is "cbf43926".
//
// THE FIVE FORMS
//
//   AGD1.<base64(utf8(json))>.END                          payload, plain
//   AGD2.<crc32>.<base64(gzip(utf8(json)))>.END            payload, compressed
//   AGM1. / AGM2.                                          state mirror, same two forms
//   AGC1.<base64(utf8(json))>.END                          completions bus (page -> pipeline)
//   AGQ1.<base64(utf8(json))>.END                          command bus (page -> pipeline)
//
// The page implements the reading half of this file in about fifteen lines of
// browser JavaScript. Keep the two in step: a change here that the page cannot
// parse silently strands every already-published artifact.
import { gunzipSync, gzipSync } from "node:zlib";

/** The four message kinds and their three-letter prefixes. */
export const KINDS = Object.freeze({
  data: "AGD",
  mirror: "AGM",
  completions: "AGC",
  commands: "AGQ",
});

/** Kinds the page writes: always plain, because no model moves those bytes. */
const PLAIN_ONLY = new Set(["completions", "commands"]);

const PREFIX_TO_KIND = Object.freeze(
  Object.fromEntries(Object.entries(KINDS).map(([kind, prefix]) => [prefix, kind])),
);

export class EnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvelopeError";
  }
}

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3, reflected, poly 0xEDB88320) - table built once, lazily.
// ---------------------------------------------------------------------------
let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  TABLE = t;
  return t;
}

/**
 * CRC32 of a Buffer / Uint8Array / string, as eight lowercase hex characters.
 * Strings are measured as UTF-8, which is the only encoding this file uses.
 */
export function crc32(input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  const t = table();
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ t[(c ^ bytes[i]) & 0xff];
  return ((c ^ -1) >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// pack / unpack
// ---------------------------------------------------------------------------

/**
 * Wrap an object as an envelope string.
 *
 * @param {"data"|"mirror"|"completions"|"commands"} kind
 * @param {unknown} obj              anything JSON.stringify accepts
 * @param {{compress?: boolean}} [opts]  compress defaults to true for the two
 *        kinds a model has to carry, and is ignored for the two the page writes.
 */
export function pack(kind, obj, opts = {}) {
  const prefix = KINDS[kind];
  if (!prefix) throw new EnvelopeError(`unknown envelope kind: ${String(kind)}`);
  const json = JSON.stringify(obj);
  if (typeof json !== "string") throw new EnvelopeError(`kind ${kind}: value is not serialisable`);

  const compress = PLAIN_ONLY.has(kind) ? false : opts.compress !== false;
  if (!compress) {
    return `${prefix}1.${Buffer.from(json, "utf-8").toString("base64")}.END`;
  }
  const gz = gzipSync(Buffer.from(json, "utf-8"), { level: 9 });
  // Byte 9 of a gzip header records the OS that produced it, so the same
  // payload would differ between Windows and Linux. Pin it (0x03, the de facto
  // standard) so pack() is byte-identical everywhere; no reader looks at it.
  gz[9] = 0x03;
  return `${prefix}2.${crc32(gz)}.${gz.toString("base64")}.END`;
}

/**
 * The envelope at the head of a document, and nothing after it.
 *
 * The `<ns>-data` document carries the `AGD2` line, a blank line, and then a
 * plain-text brief for a phone to read (`src/brief.mjs`). Every MACHINE reader
 * has to stop at the first `.END` - the brief is prose written from untrusted
 * strings, and a reader that kept going would be parsing it.
 *
 * Whitespace is stripped first, because a Doc inserts soft line breaks wherever
 * it likes and one landing inside `.END` would otherwise hide the terminator.
 * The first `.END` is unambiguous: base64 has no `.`, so the only dots in an
 * envelope are its own separators.
 *
 * A document with no `.END` at all comes back unchanged, so `unpack` is the one
 * that refuses it and says why. This function never validates and never
 * decodes - it only decides where the message ends.
 *
 * @param {unknown} text the whole document body
 * @returns {string} the envelope, terminator included
 */
export function sliceEnvelope(text) {
  const s = String(text ?? "").replace(/\s+/g, "");
  const end = s.indexOf(".END");
  return end === -1 ? s : s.slice(0, end + 4);
}

/**
 * Read an envelope back. Throws EnvelopeError - never a silent bad parse - on
 * an unknown prefix, a missing terminator, an empty body, a bad checksum, a
 * corrupt gzip stream or JSON that does not parse.
 *
 * @returns {{kind: string, version: 1|2, compressed: boolean, data: unknown}}
 */
export function unpack(text) {
  if (typeof text !== "string") throw new EnvelopeError("envelope is not a string");
  // A Google Doc inserts soft line breaks wherever it likes, and a copy/paste
  // round trip adds its own. None of them are part of the message.
  const s = text.replace(/\s+/g, "");
  if (!s) throw new EnvelopeError("envelope is empty");

  const m = s.match(/^(AGD|AGM|AGC|AGQ)([12])\.(.*)\.END$/);
  if (!m) {
    const head = s.slice(0, 8);
    throw new EnvelopeError(
      s.includes(".END") ? `unknown envelope prefix: ${head}` : "envelope is missing its .END terminator",
    );
  }
  const [, prefix, versionText, rest] = m;
  const kind = PREFIX_TO_KIND[prefix];
  const version = Number(versionText);

  if (version === 1) {
    if (!rest) throw new EnvelopeError(`${prefix}1: body is empty`);
    return { kind, version: 1, compressed: false, data: parse(decode(rest, prefix), prefix) };
  }

  // Version 2: <crc32>.<base64(gzip)>
  const dot = rest.indexOf(".");
  if (dot === -1) throw new EnvelopeError(`${prefix}2: missing the checksum separator`);
  const sum = rest.slice(0, dot).toLowerCase();
  const body = rest.slice(dot + 1);
  if (!/^[0-9a-f]{8}$/.test(sum)) throw new EnvelopeError(`${prefix}2: checksum is not 8 hex characters`);
  if (!body) throw new EnvelopeError(`${prefix}2: body is empty`);

  const gz = decodeBytes(body, prefix);
  const actual = crc32(gz);
  if (actual !== sum) {
    throw new EnvelopeError(
      `${prefix}2: checksum mismatch (document says ${sum}, bytes are ${actual}) - the text was truncated or edited`,
    );
  }
  let json;
  try {
    json = gunzipSync(gz).toString("utf-8");
  } catch (e) {
    throw new EnvelopeError(`${prefix}2: could not decompress (${e.message})`);
  }
  return { kind, version: 2, compressed: true, data: parse(json, prefix) };
}

function decodeBytes(b64, prefix) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new EnvelopeError(`${prefix}: body is not base64`);
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) throw new EnvelopeError(`${prefix}: body decoded to nothing`);
  // Buffer.from is lenient; a body whose length does not round-trip lost bytes.
  if (bytes.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
    throw new EnvelopeError(`${prefix}: body is not valid base64`);
  }
  return bytes;
}

function decode(b64, prefix) {
  return decodeBytes(b64, prefix).toString("utf-8");
}

function parse(json, prefix) {
  try {
    return JSON.parse(json);
  } catch (e) {
    throw new EnvelopeError(`${prefix}: body is not JSON (${e.message})`);
  }
}

/**
 * How many characters this kind is allowed to occupy in a Doc.
 *
 * The payload budget is what an agent can realistically emit in one message;
 * the mirror budget is larger because a heavy run carries it alone. Both are
 * config, because "realistically" moves as models change.
 */
export function budgetOf(cfg, kind) {
  const drive = cfg?.drive ?? {};
  if (kind === "mirror") return Number(drive.maxMirrorChars) || 20000;
  return Number(drive.maxEmitChars) || 12000;
}

// ---------------------------------------------------------------------------
// Slim tiers
// ---------------------------------------------------------------------------
//
// When the packed payload is still over budget, product has to give - but in a
// fixed, announced order, so a reader of the log always knows exactly what the
// page is missing. Tier 0 is the whole payload; each later tier drops one more
// band of context and nothing else. Nothing here truncates items[]: a short
// agenda that lies about what is due is worse than a fat one that will not
// upload, and the copy embedded in the HTML is always complete.

/** The tier ladder, in the order render.mjs walks it. */
export const slimTiers = Object.freeze([
  { tier: 0, label: "full payload", apply: (p) => p },
  {
    tier: 1,
    label: "descriptions outside the -14d..+21d window",
    apply: (p, now) => {
      const from = new Date(now.getTime() - 14 * 86400000).toISOString();
      const to = new Date(now.getTime() + 21 * 86400000).toISOString();
      return {
        ...p,
        items: (p.items ?? []).map((it) => {
          if (!it.desc) return it;
          const d = String(it.d ?? "");
          if (d >= from && d <= to) return it;
          const { desc, ...rest } = it;
          return rest;
        }),
      };
    },
  },
  {
    tier: 2,
    label: "announcements older than 7 days, mail capped at 8",
    apply: (p, now) => {
      const cut = new Date(now.getTime() - 7 * 86400000).toISOString();
      return {
        ...p,
        announcements: (p.announcements ?? []).filter((a) => String(a.p ?? "") >= cut),
        mail: (p.mail ?? []).slice(0, 8),
      };
    },
  },
  {
    tier: 3,
    label: "done[] window 7 days, board capped at 5",
    apply: (p, now) => {
      const cut = new Date(now.getTime() - 7 * 86400000).toISOString();
      return {
        ...p,
        done: (p.done ?? []).filter((d) => String(d.at ?? "") >= cut),
        board: (p.board ?? []).slice(0, 5),
      };
    },
  },
]);

/**
 * Walk the tiers until the packed string fits, and report which one was needed.
 * `over: true` means even tier 3 was too big - the caller writes the oversize
 * file, warns loudly, and lets the page fall back to its embedded copy.
 *
 * @returns {{tier:number, label:string, text:string, payload:object, over:boolean}}
 */
export function packWithinBudget(kind, payload, { budget, now = new Date() }) {
  let last = null;
  for (const step of slimTiers) {
    const slimmed = step.apply(payload, now);
    const text = pack(kind, slimmed);
    last = { tier: step.tier, label: step.label, text, payload: slimmed, over: text.length > budget };
    if (!last.over) return last;
  }
  return last;
}
