// Course-material sync: walks each course's content tree, downloads every NEW
// downloadable file, and files it under
//   <connectors.materials.root>/<COURSE-DASHED>/<Category>/<sanitized-name.ext>
// e.g. ~/Documents/Coursework/PHYS-221/Lecture Notes/Lecture-01-Introduction.pdf
//
// Run once per scheduled run, right after scrape.mjs - it reuses the same LMS
// session, so a run that scraped cleanly will sync cleanly.
//
// Exit codes (same discipline as scrape.mjs):
//   0 = ok (including "nothing new")
//   1 = real error
//   2 = the LMS session expired -> reauth hint printed, caller must stop
//   3 = skipped (connectors.materials.enabled is not true)
//
// Flags:
//   --dry-run              list what would download, touch nothing
//   --course "PHYS 221"    limit to one course (case/space insensitive)
//   --config <path>        use another config file
//   --data <dir>           use another data directory
//   --tree-cache <file>    DIAGNOSTIC, --dry-run only: read content trees from a
//                          cached get_course_content dump ({courseId: result})
//                          instead of the LMS. Lets the classifier be verified
//                          without spending a session.
//
// ---------------------------------------------------------------------------
// CLASSIFICATION RULESET
// ---------------------------------------------------------------------------
// Every downloadable topic gets exactly one category out of
// connectors.materials.categories. Two inputs are considered, in this order:
//
//   PASS 1 - the FILE TITLE (the topic title, e.g. "PHYS22100_Practice_Set")
//   PASS 2 - the MODULE PATH (all ancestor module titles joined with " > ",
//            e.g. "PHYS 221 > Information about Standards")
//
// The file title wins because it is the more specific signal. That is what puts
// "PHYS22100_Practice_Set" in Example Problems even though its module is
// "Information about Standards" (which would otherwise say Exams).
//
// Within each pass the rules are tried in this fixed priority order, first
// match wins. All matching is case-insensitive.
//
//   1. Syllabus         "syllabus"
//   2. Lecture Notes    "lecture", "notes", "slides", /week\s*\d+/
//   3. Example Problems "example", "practice", "worked", "sample problem"
//   4. Homework         /\bhw\b/ (digit-adjacent ok: HW1), "homework",
//                       "assignment", "problem set", /\bpset\b/
//   5. Books            "book", "textbook", "reading"
//   6. Exams            "exam", "midterm", "final", "sitting", "standard"
//   7. Other            nothing matched in either pass
//
// The order is load-bearing in three places, do not shuffle it:
//   - "example" CONTAINS "exam", so Example Problems must be tested before
//     Exams or every practice set would land in Exams.
//   - "problem set" is Homework, so Example Problems deliberately does NOT
//     match a bare "problem" (only "sample problem").
//   - "standard" -> Exams is what routes standards-based-grading material
//     (equation sheets, sitting standards) to Exams, which is where a student
//     studies for a sitting from.
//
// Representative outcomes, all of them real shapes a content tree produces:
// "PHYS 221 Lecture 3" -> Lecture Notes, "PHYS22100_Practice_Set" -> Example
// Problems, "MATH 210 HW1" -> Homework, "Unit 4 Lecture PDF" -> Lecture Notes,
// "Exam 2 Study Guide" -> Exams, "Office Hours" -> Other.
//
// A category that is not present in connectors.materials.categories degrades to
// "Other" rather than inventing a folder.
//
// ---------------------------------------------------------------------------
// WHAT IS DOWNLOADED
// ---------------------------------------------------------------------------
// Only content topics with topicType "file". Link topics ("link") and embedded
// media topics ("other" - streaming video, for instance) are not files and are
// skipped. Dropbox submission/feedback attachments are out of scope here.
//
// Courses marked `"skip": true` in config are never even asked about. A course
// nobody expects to do work for typically also denies content access, and the
// resulting 403 is noise that trains everyone to ignore the error list. Any
// other course that answers access-denied is skipped the same way, non-fatally.
//
// A per-file download failure is logged and NEVER recorded in the manifest, so
// it retries on the next run. That is what keeps a course's unreleased lecture
// PDFs ("Resource not found") coming back automatically the day the professor
// releases them, with no bookkeeping from anyone.
//
// ---------------------------------------------------------------------------
// FILENAMES
// ---------------------------------------------------------------------------
// The download name arrives RFC 5987 encoded and must be run through
// decodeDownloadName() BEFORE sanitizeFilename() - see the long note on that
// function. Getting this backwards produces a directory full of
// "UTF-8Lecture-2001-20-20Introduction.pptx". That damage is not reversible
// from disk: sanitizing has already turned every "%" into "-", and
// "Equation-20Sheet-...-2026-08-28" is genuinely ambiguous about which "-20"
// was an escape. The only repair is to download everything again.
//
// ---------------------------------------------------------------------------
// THE MANIFEST - data/materials-map.json
// ---------------------------------------------------------------------------
//   { "<topicId>": { course, path, bytes, seen } }        content downloads
//   { "mail:<entryId>:<filename>": { ... } }              mail attachments
//                                                          (written by a
//                                                           scheduled run)
// A key already in the manifest is NEVER downloaded again - that is the whole
// point of the file, and it is what keeps a twice-daily run from re-pulling the
// same 40 PDFs. Nothing here ever overwrites a local file: if the target name
// already exists with a DIFFERENT size the new copy is written as name-v2.ext
// (then -v3, ...); if it exists with the SAME size the download is discarded as
// a duplicate and the manifest simply points at the file already on disk.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { connect } from "./lib/mcp-client.mjs";
import { derive, loadConfig } from "./lib/config.mjs";
import { argFlag, dataDir as resolveDataDir, repoRoot } from "./lib/paths.mjs";

const ROOT = repoRoot();
const ARGV = process.argv.slice(2);
const DATA = resolveDataDir(ARGV, ROOT);
const MAP_PATH = join(DATA, "materials-map.json");

const ACCESS_DENIED = /403|forbidden|access denied|not authorized|no permission|not enrolled/i;

// Ordered [category, matchers]. See the ruleset comment above - order matters.
const RULES = [
  ["Syllabus", [/syllabus/i]],
  ["Lecture Notes", [/lecture/i, /notes/i, /slides/i, /week\s*\d+/i]],
  ["Example Problems", [/example/i, /practice/i, /worked/i, /sample\s+problem/i]],
  ["Homework", [/(^|[^a-z])hw([^a-z]|$)/i, /homework/i, /assignment/i, /problem\s*set/i, /(^|[^a-z])pset([^a-z]|$)/i]],
  ["Books", [/textbook/i, /book/i, /reading/i]],
  ["Exams", [/exam/i, /midterm/i, /final/i, /sitting/i, /standard/i]],
];

/** The LMS session died. Kept deliberately narrow - see the note below. */
function isAuthError(e) {
  const msg = String(e?.message ?? "");
  // mcp-client appends the server's stderr tail to every error. That tail
  // routinely contains "Attempting auto-reauthentication", so matching /auth/
  // against the whole string turns a slow download into a fake auth failure.
  // Judge the head; only an explicitly FAILED reauth in the tail counts.
  const head = msg.split("stderr:")[0];
  if (/401|unauthorized|not authenticated|authentication failed|session (expired|invalid)|token expired/i.test(head)) return true;
  return /reauthentication (failed|.{0,20}failed)|run .{0,30}brightspace-auth/i.test(msg);
}

const isTimeout = (e) => /timeout on /i.test(String(e?.message ?? ""));

/** "PHYS 221" -> "PHYS-221", the folder name under the materials root. */
const courseFolder = (code) => String(code).trim().replace(/\s+/g, "-");

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/**
 * Category for one topic. title = topic title, modulePath = ancestor titles.
 * File title first, module path second, "Other" if neither says anything.
 */
export function classify(title, modulePath, allowed) {
  const ok = (cat) => (!allowed || allowed.includes(cat) ? cat : "Other");
  for (const text of [String(title ?? ""), String(modulePath ?? "")]) {
    if (!text.trim()) continue;
    for (const [category, matchers] of RULES) {
      if (matchers.some((re) => re.test(text))) return ok(category);
    }
  }
  return ok("Other");
}

// D2L sends the download name in an RFC 5987 Content-Disposition parameter:
//   Content-Disposition: attachment; filename*=UTF-8''Lecture%2001%20-%20Intro.pptx
// The MCP server hands that value through with the charset marker still glued
// to the front and the octets still percent-encoded, so the raw name on disk is
// "UTF-8Lecture%2001%20-%20Intro.pptx". Sanitizing that directly produces
// "UTF-8Lecture-2001-20-20Intro.pptx": "%" is not a legal filename character,
// so it becomes "-", turning every "%20" into "-20". Strip the marker and
// percent-decode BEFORE sanitizing, never after.
const RFC5987_PREFIX = /^(?:utf-8|iso-8859-1|us-ascii)(?:'[^']*')?/i;

/**
 * Undo the RFC 5987 wrapper on a download name. Handles both the spec form
 * ("UTF-8''name") and the quote-stripped form the server actually emits
 * ("UTF-8name"). Malformed escapes are left literal rather than throwing, so a
 * weird name still yields a usable file instead of failing the download.
 */
export function decodeDownloadName(raw) {
  const s = String(raw ?? "").trim();
  // Decode whole RUNS of escapes at once: a multi-byte character arrives as
  // "%C3%A9" and decoding those two bytes separately would corrupt it.
  const pct = (x) => x.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try { return decodeURIComponent(m); } catch { return m; }
  });
  const stripped = s.replace(RFC5987_PREFIX, "");
  if (stripped === s) return pct(s); // no marker to remove
  // Accept the strip only when a real stem follows the marker, judged AFTER
  // decoding - a name that begins with a non-ASCII character arrives as
  // "%E2%82%AC..." and would fail a pre-decode test. Leading "." or "-" means
  // we ate part of a genuine name ("utf-8.pdf", "utf-8-guide.pdf"), so back off.
  const decoded = pct(stripped);
  return decoded && !/^[.-]/.test(decoded) ? decoded : pct(s);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * ASCII-safe filename, original extension preserved. Accents are folded rather
 * than dropped (Lang -> Lang, resume -> resume), everything else outside
 * [A-Za-z0-9._-] becomes a dash.
 */
export function sanitizeFilename(name) {
  const raw = String(name ?? "").trim();
  const ext = extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const clean = (s) => fold(s)
    .replace(/[^\x20-\x7e]/g, "")       // non-ASCII
    .replace(/[<>:"/\\|?*]/g, "-")      // illegal on Windows
    .replace(/[^A-Za-z0-9._ -]/g, "-")  // anything else odd
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  let base = clean(stem).slice(0, 120);
  let suffix = clean(ext.replace(/^\./, "")).slice(0, 12);
  if (!base) base = "file";
  if (RESERVED.test(base)) base = base + "-file";
  return suffix ? `${base}.${suffix}` : base;
}

/** Flatten the content tree into downloadable file topics with their module path. */
export function collectFileTopics(nodes, modulePath = "", out = []) {
  for (const n of nodes ?? []) {
    if (n.isHidden) continue;
    if (n.type === "topic" && n.topicType === "file") {
      out.push({
        topicId: n.topicId ?? n.id,
        title: n.title ?? "untitled",
        modulePath,
      });
    }
    if (n.children) {
      collectFileTopics(n.children, modulePath ? `${modulePath} > ${n.title}` : String(n.title ?? ""), out);
    }
  }
  return out;
}

function loadManifest() {
  if (!existsSync(MAP_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(MAP_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    throw new Error(`data/materials-map.json is unreadable (${e.message}). Fix or delete it before syncing.`);
  }
}

function saveManifest(manifest) {
  const tmp = `${MAP_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 1));
  renameSync(tmp, MAP_PATH);
}

/**
 * Pick a destination that never clobbers an existing file.
 * Returns { path, duplicateOf } - duplicateOf set when an identical-size file
 * is already sitting there, in which case the staged copy is thrown away.
 */
export function resolveTarget(dir, filename, bytes) {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  for (let v = 1; v <= 50; v++) {
    const candidate = join(dir, v === 1 ? filename : `${stem}-v${v}${ext}`);
    if (!existsSync(candidate)) return { path: candidate, duplicateOf: null };
    if (statSync(candidate).size === bytes) return { path: candidate, duplicateOf: candidate };
  }
  throw new Error(`too many versions of ${filename}`);
}

/** Find what download_file actually wrote, whatever shape it answered with. */
function locateDownload(response, stageDir, before) {
  const guesses = [];
  if (response && typeof response === "object") {
    for (const k of ["path", "filePath", "savedTo", "destination", "fullPath", "file"]) {
      if (typeof response[k] === "string") guesses.push(response[k]);
    }
    for (const k of ["filename", "fileName", "name"]) {
      if (typeof response[k] === "string") guesses.push(join(stageDir, basename(response[k])));
    }
  } else if (typeof response === "string") {
    const m = response.match(/[A-Za-z]:\\[^\r\n"']+|\/[^\r\n"']+\.[A-Za-z0-9]{1,8}/);
    if (m) guesses.push(m[0].trim());
  }
  for (const g of guesses) {
    if (g && existsSync(g) && statSync(g).isFile()) return g;
  }
  // Fall back to "which file appeared in the staging directory". Downloads are
  // strictly sequential, so this is unambiguous.
  const after = existsSync(stageDir) ? readdirSync(stageDir) : [];
  const fresh = after.filter((f) => !before.includes(f));
  if (fresh.length === 1) return join(stageDir, fresh[0]);
  if (fresh.length > 1) {
    const newest = fresh
      .map((f) => ({ f, m: statSync(join(stageDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    return join(stageDir, newest.f);
  }
  return null;
}

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The MCP server descriptor for the enabled LMS, read out of `.mcp.json` by the
 * key config names. The client spawns whatever it is handed, so a Canvas server
 * on a Mac and a Brightspace server on Windows are the same code path here -
 * only the `.mcp.json` entry differs, which is exactly where a user can see and
 * fix it.
 */
function lmsServer(config) {
  const key = config.connectors?.lms?.brightspace?.mcpServer ?? "brightspace";
  let servers = {};
  try {
    servers = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf-8")).mcpServers ?? {};
  } catch {
    /* absent or unreadable .mcp.json is reported below, with the key named */
  }
  const entry = servers[key];
  if (!entry?.command) {
    throw new Error(`no MCP server named "${key}" in .mcp.json - see docs/SETUP.md`);
  }
  return { command: entry.command, args: entry.args ?? [], env: entry.env, cwd: ROOT };
}

function parseArgs(argv) {
  const out = { dryRun: false, course: null, treeCache: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--course") out.course = argv[++i] ?? null;
    else if (a.startsWith("--course=")) out.course = a.slice(9);
    else if (a === "--tree-cache") out.treeCache = argv[++i] ?? null;
    else if (a.startsWith("--tree-cache=")) out.treeCache = a.slice(13);
    else if (a === "--config" || a === "--data") i++; // resolved by src/lib/paths.mjs
    else if (a.startsWith("--config=") || a.startsWith("--data=")) { /* same, `--flag=value` form */ }
    else throw new Error(`unknown flag: ${a}`);
  }
  if (out.treeCache && !out.dryRun) throw new Error("--tree-cache is only allowed with --dry-run");
  return out;
}

async function main() {
  const args = parseArgs(ARGV);
  const config = loadConfig(argFlag(ARGV, "config") ?? null, { argv: ARGV });
  const derived = derive(config);
  const materials = config.connectors?.materials ?? null;

  if (!materials || materials.enabled !== true) {
    console.log("SKIPPED: connectors.materials.enabled is not true - nothing to download");
    process.exit(3);
  }

  const categories = Array.isArray(materials.categories) && materials.categories.length
    ? materials.categories
    : ["Other"];
  const maxBytes = Math.max(1, Number(materials.maxFileMB ?? 300)) * 1024 * 1024;
  const materialsRoot = materials.root;
  if (!materialsRoot) {
    throw new Error(
      'config: "connectors.materials.root" is not set yet.\n' +
        '  Fix: open this folder in Claude Code and say "hey" - the setup agent fills it in.\n' +
        "  Or edit config.json directly; docs/CONFIG.md explains every key.",
    );
  }

  // Courses the user marked `"skip": true` are never asked about. Matching on
  // both the code and the id, because either may be the one config carries.
  const courses = (config.courses ?? []).filter((c) => {
    if (derived.skipCodes.has(c.code) || derived.skipIds.has(Number(c.id))) return false;
    if (args.course && norm(c.code) !== norm(args.course)) return false;
    return true;
  });
  if (!courses.length) throw new Error(`no courses matched${args.course ? ` --course "${args.course}"` : ""}`);

  const manifest0 = loadManifest();
  let manifest = manifest0;
  const errors = [];
  const downloaded = [];     // {course, category, filename, bytes}
  let skippedKnown = 0, skippedLarge = 0, duplicates = 0;

  const cachedTrees = args.treeCache
    ? JSON.parse(readFileSync(args.treeCache, "utf-8"))
    : null;

  const stageDir = join(tmpdir(), `materials-sync-${process.pid}`);
  let client = null;

  const bail = (msg) => {
    if (client) client.close();
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    console.error(msg);
    console.error("AUTH FAILURE - run: node scripts/reauth.mjs");
    process.exit(2);
  };

  if (!cachedTrees) {
    client = await connect(lmsServer(config));
    // Fail fast and cheap rather than discovering it on the first download.
    try {
      const auth = await client.call("check_auth", {});
      const text = typeof auth === "string" ? auth : JSON.stringify(auth);
      if (/not authenticated|authentication failed|reauthentication .{0,25}failed|unauthorized|401/i.test(text)) {
        bail(`the LMS check_auth says: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      // A timeout HERE is auth, not slowness: check_auth does no I/O worth
      // waiting on, but a freshly spawned server whose session is dead blocks
      // in its auto-relaunch path and never answers - a two-minute stall that
      // looks like a slow network and is not. Bailing now costs one call;
      // guessing costs two minutes per course, every course.
      if (isAuthError(e) || isTimeout(e)) bail(`check_auth failed: ${e.message.split("stderr:")[0].trim()}`);
      errors.push(`check_auth: ${e.message.slice(0, 160)}`); // non-fatal, keep going
    }
    mkdirSync(stageDir, { recursive: true });
  }

  try {
    for (const course of courses) {
      let tree = null;
      if (cachedTrees) {
        const cached = cachedTrees[String(course.id)];
        if (!cached) { console.log(`- ${course.code}: not in tree cache, skipped`); continue; }
        tree = cached.contentTree ?? [];
      } else {
        try {
          const c = await client.call("get_course_content", { courseId: course.id });
          tree = c.contentTree ?? [];
        } catch (e) {
          if (isAuthError(e)) throw e;
          if (ACCESS_DENIED.test(e.message)) { console.log(`- ${course.code}: no content access, skipped`); continue; }
          errors.push(`${course.code} content: ${e.message.slice(0, 160)}`);
          continue;
        }
      }

      const topics = collectFileTopics(tree);
      for (const t of topics) {
        const key = String(t.topicId);
        if (manifest[key]) { skippedKnown++; continue; }

        const category = classify(t.title, `${course.code} > ${t.modulePath}`, categories);
        const destDir = join(materialsRoot, courseFolder(course.code), category);

        if (args.dryRun) {
          console.log(`WOULD GET  ${course.code}  ${category}  ${t.title}  -> ${destDir}`);
          downloaded.push({ course: course.code, category, filename: t.title, bytes: 0 });
          continue;
        }

        let staged = null;
        try {
          const before = readdirSync(stageDir);
          const resp = await client.call("download_file", {
            courseId: course.id,
            topicId: t.topicId,
            downloadPath: stageDir,
          });
          staged = locateDownload(resp, stageDir, before);
          if (!staged) throw new Error(`download produced no file (server said: ${String(typeof resp === "string" ? resp : JSON.stringify(resp)).slice(0, 160)})`);
        } catch (e) {
          if (isAuthError(e)) throw e;
          if (isTimeout(e)) {
            // Disambiguate a dead session from a genuinely slow file.
            try {
              const a = await client.call("check_auth", {});
              const text = typeof a === "string" ? a : JSON.stringify(a);
              if (/not authenticated|authentication failed|unauthorized/i.test(text)) throw new Error("session expired mid-run (check_auth)");
            } catch (inner) { if (isAuthError(inner) || /session expired mid-run/.test(inner.message)) throw inner; }
          }
          errors.push(`${course.code} "${t.title}": ${e.message.slice(0, 160)}`);
          continue;
        }

        try {
          const bytes = statSync(staged).size;
          if (bytes > maxBytes) {
            rmSync(staged, { force: true });
            skippedLarge++;
            console.log(`TOO LARGE  ${course.code}  ${t.title}  (${kb(bytes)} > ${materials.maxFileMB} MB cap)`);
            continue; // not recorded: a raised cap should retry it
          }
          const filename = sanitizeFilename(decodeDownloadName(basename(staged)));
          mkdirSync(destDir, { recursive: true });
          const { path: target, duplicateOf } = resolveTarget(destDir, filename, bytes);
          if (duplicateOf) {
            rmSync(staged, { force: true });
            duplicates++;
          } else {
            copyFileSync(staged, target);
            rmSync(staged, { force: true });
            downloaded.push({ course: course.code, category, filename: basename(target), bytes });
            console.log(`${course.code}  ${category}  ${basename(target)}  (${kb(bytes)})`);
          }
          manifest = {
            ...manifest,
            [key]: {
              course: course.code,
              path: (duplicateOf ?? target).replace(/\\/g, "/"),
              bytes,
              seen: new Date().toISOString(),
            },
          };
          saveManifest(manifest);
        } catch (e) {
          if (staged && existsSync(staged)) rmSync(staged, { force: true });
          errors.push(`${course.code} "${t.title}" filing: ${e.message.slice(0, 160)}`);
        }
      }
    }
  } catch (e) {
    if (isAuthError(e) || /session expired mid-run/.test(e.message)) bail(`FATAL: ${e.message.slice(0, 200)}`);
    if (client) client.close();
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    throw e;
  }

  if (client) client.close();
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });

  // ---- summary -------------------------------------------------------------
  const byCourse = new Map();
  let totalBytes = 0;
  for (const d of downloaded) {
    if (!byCourse.has(d.course)) byCourse.set(d.course, new Map());
    const cats = byCourse.get(d.course);
    cats.set(d.category, (cats.get(d.category) ?? 0) + 1);
    totalBytes += d.bytes;
  }
  console.log(args.dryRun ? "--- dry run, nothing written ---" : "--- materials sync ---");
  for (const [code, cats] of byCourse) {
    const parts = [...cats].map(([c, n]) => `${c} ${n}`).join(", ");
    console.log(`  ${code}: ${parts}`);
  }
  const mb = (totalBytes / 1048576).toFixed(1);
  console.log(
    `OK: ${downloaded.length} ${args.dryRun ? "pending" : "new"} file(s), ${mb} MB` +
    `; already had ${skippedKnown}, duplicates ${duplicates}, too large ${skippedLarge}, errors ${errors.length}`,
  );
  if (errors.length) console.log("errors:\n- " + errors.join("\n- "));

  // Force the process down. client.close() kills the `cmd /c npx ...` shell,
  // but on Windows the node grandchild survives with its stdio pipes attached,
  // so the event loop never drains and this script hangs FOREVER after printing
  // its summary - work complete in ninety seconds, process still alive four
  // minutes later. A scheduled run that waits on it would stall every time. The
  // unref'd timer gives buffered stdout a moment to flush, then exits anyway.
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 100).unref();
}

// Run only when this file is the entry point, so a test may import `classify`
// and the filename helpers without starting a download.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
}
