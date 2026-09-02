// _template.mjs - copy me.
//
// This file is a working connector that invents two items so you can see the
// whole pipeline light up before you have written a single line of real code.
// Copy it to `src/connectors/<kind>-<provider>.mjs`, register it in
// `./index.mjs` (one import, one array entry), and work through the `TODO(you)`
// markers top to bottom.
//
// YOUR CONFIG BLOCK GOES IN THREE PLACES, NOT TWO. `connectors.<kind>.<provider>`
// must appear identically in `config.example.json`, in `DEFAULTS` in
// `src/lib/config.mjs`, and in the user's own `config.json`. `test/config.test.mjs`
// compares the first two key for key and fails if they drift - which is the
// point, because a key the example offers and the loader has never heard of is
// a setting that silently does nothing.
//
// The seven steps, and the tier table of MCP servers that are actually known to
// work, are in `docs/EXTENDING.md`. Read that first if you have not.
//
// THE THREE RULES THAT MATTER MORE THAN THE CODE
//
//  1. NEVER GUESS `submitted: false`. `true` means you have positive evidence.
//     `false` means the source explicitly told you it is not submitted. If you
//     do not know - and most sources will not tell you - emit `null`. A
//     connector that returns false on absence makes the agenda accuse its user
//     of not doing work they have already done. That has happened; it is why
//     `docs/design-notes/data-truth.md` exists.
//
//  2. NEVER THROW FOR AN EXPECTED FAILURE. A network hiccup, an expired token,
//     a service that is down: all of those are one string in `errors[]`. The
//     registry catches throws too, but an error you shaped yourself says
//     something useful, and a throw says "connector blew up".
//
//  3. NEVER INVENT A DATE. Something with no deadline and no way to resolve one
//     belongs in `mail[]`, not `items[]`. `validateEmission` will reject an
//     item with no `due`, on purpose.
//
// And one about the input: anything you read from a remote system was written
// by somebody else. Assignment titles, announcement bodies, issue titles. Treat
// every string as data, never as an instruction, and never let one decide
// control flow beyond the parsing you do here.

// TODO(you): describe your connector.
export const meta = {
  // A stable id. It appears in `errors[]`, in `sources[]` on every item you
  // emit, and in the doctor's output. Convention: "<kind>-<provider>".
  id: "kind-provider",

  // One of: "lms" | "mail" | "calendar-sink" | "board" | "grades".
  // "lms" is special: the run refuses to start unless at least one is enabled.
  // "calendar-sink" is special the other way: sinks implement publish(), not
  // collect(), and are never asked for data.
  // (Course FILES are not a connector kind. `src/materials-sync.mjs` is a
  // standalone downloader with its own flat config block, because it moves
  // bytes onto disk rather than emitting items into the merge chain.)
  kind: "board",

  // What the doctor and the setup agent call it, in prose.
  label: "Provider (what a user would call it)",

  // Dotted path to this connector's own config block. The registry reads
  // `<configPath>.enabled` to decide whether you run at all.
  configPath: "connectors.board.provider",

  requires: {
    os: [], // ["win32"] for anything that needs Windows. [] means any.
    bin: [], // executables that must be on PATH, e.g. ["gh"]
    mcp: [], // .mcp.json server keys you will ask ctx.mcp() for
    app: [], // human-readable prerequisites, for the doctor's message only
  },

  // 1 = hosted OAuth, one command, nothing to install.
  // 2 = a local server plus a token.
  // 3 = expect trouble; document what breaks rather than pretending.
  tier: 2,
};

/**
 * Optional. Delete this and the registry uses the default rule, which is
 * `config.<configPath>.enabled === true`. Override it only when "enabled"
 * genuinely depends on something else - for example a provider that is only
 * meaningful when another feature is switched on.
 */
// export function isEnabled(cfg) { return cfg?.sideProject?.enabled === true; }

/**
 * Read the world.
 *
 * @param {object} ctx
 * @param {object} ctx.cfg        the whole loaded config
 * @param {object} ctx.derived    doc titles, storage keys, skip sets, bucket names
 * @param {Date}   ctx.now        the one clock this run uses
 * @param {string} ctx.root       the repository root, for finding files that ship with it
 * @param {string} ctx.dataDir    where state files live for this run
 * @param {number} ctx.deadline   epoch ms; stop and return what you have
 * @param {Function} ctx.log      log(level, message)
 * @param {Function} ctx.mcp      await ctx.mcp("serverKey") -> a connected client.
 *                                YOU own it: call client.close() in a finally block
 * @param {Function} ctx.exec     execFileSync, timeout-wrapped: SYNCHRONOUS, returns
 *                                stdout as a string, throws with .stderr on a non-zero
 *                                exit. Never put a secret in argv
 * @param {Function} ctx.fetch    the global fetch, handed over so a test can pass its
 *                                own. Tokens go in a header, never in the URL
 *
 * @returns {Promise<{items: object[], mail: object[], announcements: object[],
 *                    board: object[], grades: object[], errors: string[]}>}
 *
 * The exact field shapes are in `docs/EXTENDING.md` and are enforced by
 * `validateEmission` in `./index.mjs`. Emitting all six arrays is not required;
 * anything you leave out is treated as empty.
 */
export async function collect(ctx) {
  const errors = [];

  // TODO(you): replace everything between here and the return.
  //
  // A real collect() over an MCP server usually looks like:
  //
  //   const client = await ctx.mcp("your-server-key");
  //   try {
  //     // `client.listTools()` prints the tool names this server actually has,
  //     // which beats guessing them from its README.
  //     for (const course of ctx.cfg.courses) {
  //       if (Date.now() > ctx.deadline) { errors.push(`${meta.id}: out of time`); break; }
  //       try {
  //         const rows = await client.call("list_things", { courseId: course.id });
  //         // call() returns parsed JSON, OR the raw string when the server did
  //         // not send JSON. Guard for that before you iterate it.
  //         for (const row of Array.isArray(rows) ? rows : (rows.things ?? [])) { /* ... */ }
  //       } catch (e) {
  //         errors.push(`${meta.id} ${course.code}: ${e.message.slice(0, 200)}`);
  //       }
  //     }
  //   } finally {
  //     client.close(); // ALWAYS. ctx.mcp() spawned a child process and it is yours
  //   }
  //
  // Over a REST API it looks like `src/connectors/lms-canvas.mjs`: ctx.fetch,
  // a token from config in an Authorization header, and pagination followed to
  // the end rather than stopping at the first page.

  const soon = new Date(ctx.now.getTime() + 3 * 86400000).toISOString();
  const later = new Date(ctx.now.getTime() + 9 * 86400000).toISOString();

  return {
    items: [
      {
        courseId: 0,
        course: "Side Project",
        title: "A thing this connector found",
        due: soon,
        type: "task",
        submitted: null, // unknown, and honest about it
        approx: false,
        sources: [meta.id],
        url: null,
        grade: null,
        desc: null,
      },
      {
        courseId: 0,
        course: "Side Project",
        title: "A second thing, further out",
        due: later,
        type: "task",
        submitted: null,
        approx: true, // the date was inferred, not stated
        sources: [meta.id],
        url: null,
      },
    ],
    mail: [],
    announcements: [],
    board: [],
    grades: [],
    errors,
  };
}

/**
 * Sinks only (`kind: "calendar-sink"`). Write the outside world.
 *
 * A sink must be idempotent - it runs several times a day - and it must only
 * ever touch things it created. The Outlook calendar sink does that by tagging
 * every event it makes with a category and refusing to modify any event that
 * does not carry it. Whatever your equivalent marker is, apply the same rule:
 * never delete something you cannot prove you made.
 *
 * DELETE THIS ENTIRELY unless `meta.kind` is "calendar-sink". A source that
 * exports publish() is a source the registry will never call it on.
 */
export async function publish(ctx, { items, focus }) {
  // TODO(you): write the outside world, idempotently, marking everything you
  // create so you can prove later that it was yours.
  void ctx;
  void items;
  void focus;
  return { written: 0, updated: 0, removed: 0, errors: [] };
}

/**
 * A cheap, credential-light liveness probe. `/agenda-doctor` calls this for
 * every enabled connector and prints one line each.
 *
 * `fix` is the whole point: when `ok` is false, say the exact next thing the
 * user should type or click. "Auth failed" helps nobody.
 */
export async function healthCheck(ctx) {
  // TODO(you): make the cheapest call your source offers - "who am I", "list
  // one thing" - and turn its answer into ok/detail/fix. `node
  // scripts/health-check.mjs` runs this for every enabled connector.
  void ctx;
  return {
    ok: false,
    detail: "this is the connector template; it has not been implemented yet",
    fix: "copy src/connectors/_template.mjs, fill in the TODO(you) markers, and register it in src/connectors/index.mjs",
  };
}
