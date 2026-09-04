# Extending: adding, swapping and writing a source

Every source in this project is a swappable adapter. This page is how you add
one.

**The fastest route is to say `/add-source` in Claude Code** — it walks the whole
thing, picks the right server, writes the OS-correct configuration, copies the
template and runs the tests. This page is the specification it follows.

---

## 1. Pick a server — the tier table

Do not start with a web search. Start here, because the search results for "MCP
server for X" are full of packages that do not work and the difference costs an
afternoon.

### Tier 1 — hosted OAuth. One command, nothing to install.

The best case. No local process, no token to manage, works identically on
Windows, macOS and in the cloud.

| Source | Endpoint |
|---|---|
| Notion | `https://mcp.notion.com/mcp` |
| Todoist | `https://ai.todoist.net/mcp` |
| GitHub | `https://api.githubcopilot.com/mcp/` — **the shipped board connector does not use this**; it shells out to the `gh` CLI. See `docs/connectors/hosted-oauth.md` |
| Google Drive | Claude's own built-in connector |

```
claude mcp add --scope project --transport http notion https://mcp.notion.com/mcp
```

You will see the provider's own OAuth consent screen. That is their screen, not
this repo's — say so to the user before it appears.

### Tier 1, the other shape — a hosted API plus a token you hold

`tier: 1` means "nothing to install", and hosted OAuth is only one way to get
there. When the source has a plain HTTP API, a connector can call it directly:
no process, no `.mcp.json` entry, no trust prompt, and it works in a cloud
environment. Two shipped connectors are this shape.

| Connector | How | Where the credential lives |
|---|---|---|
| `lms-canvas` | `connectors.lms.canvas.baseUrl` + `.token` | `config.json`, which is git-ignored |
| `calendar-ics` | `connectors.calendar.ics.path` | nowhere — it writes a local file and has no credential at all |

### Tier 2 — a local server plus a token.

Works well, but it is a process on your machine, so it needs the right shape for
your operating system and it **cannot run in a cloud environment.**

| Source | Command | Upstream |
|---|---|---|
| Moodle | `uvx moodle-mcp` | `loyaniu/moodle-mcp` |
| Apple Calendar | `npx mcp-server-apple-events` | macOS only |
| Brightspace | `npx brightspace-mcp-server@latest` | `RohanMuppa/brightspace-mcp-server` |

### Tier 3 — expect failure. Documented, not stubbed.

| Source | Why |
|---|---|
| Google Classroom | Needs a school-admin allow-list. Most students cannot get one |
| Blackboard | **No viable general-purpose server exists.** See `docs/connectors/not-supported.md` |

These are not "hard". They are blocked on something you cannot fix from your side.
Say so plainly rather than letting someone spend an evening finding out.

### Known-dead packages — refuse these even though they rank highly

| Package | Status |
|---|---|
| `@abhiz123/todoist-mcp-server` | Dead. Use the hosted Todoist endpoint above |
| `apple-mcp` / `@dhravya/apple-mcp` | Dead |
| `faizan45640/google-classroom-mcp-server` | Dead |
| `@anthropic-ai/mcp-server-gdrive` | **Does not exist.** Google Drive is a built-in connector, not an npm package |

---

## 2. Register it

```
claude mcp add --scope project --transport http <name> <url>
```

or, for a local one:

```
claude mcp add-json <name> '<json>' --scope project
```

### `add-json` quoting, per shell

**That single-quoted form is bash / zsh only.** It does not work in PowerShell or
`cmd.exe`, which is a problem in a repo that otherwise assumes Windows. The same
registration, three ways:

```bash
# bash / zsh (macOS, Linux, Git Bash)
claude mcp add-json todoist '{"command":"npx","args":["-y","some-server"]}' --scope project
```

```powershell
# PowerShell - single quotes do not interpolate, and JSON quotes survive
claude mcp add-json todoist '{"command":"npx","args":["-y","some-server"]}' --scope project
```

```
:: cmd.exe - only double quotes exist, so the inner ones must be doubled
claude mcp add-json todoist "{""command"":""npx"",""args"":[""-y"",""some-server""]}" --scope project
```

If the quoting fights back, **edit `.mcp.json` directly** — it is a plain JSON
file at the repository root and `add-json` only writes to it. Either way,
**Claude Code reads `.mcp.json` at session start**, so a change is not live until
you restart the session.

### The Windows npx wrapper

**On Windows an stdio `npx` server must be wrapped:**

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "<pkg>"] }
```

A Mac-shaped `npx` entry **fails silently on Windows.** The server never starts,
no error is raised, and the only symptom is that the connector returns nothing.
This is the single most common cross-platform break in this project. Detect the
platform and write the correct block; do not copy a Mac example from a README.

### The trust prompt cannot be pre-granted

A project-scoped MCP server requires a **per-user, per-project** trust approval.
A repository cannot grant it on your behalf, there is no configuration key that
skips it, and looking for one is looking for a hole. Tell the user the dialog is
coming, what it is asking, and what to click. `claude mcp reset-project-choices`
re-prompts if they dismissed it.

**No secrets in `.mcp.json`.** Use `${VAR}` interpolation and put the value in
`.env`, which is git-ignored.

---

## 3. The adapter contract

Copy `src/connectors/_template.mjs`. It is heavily commented, and the places
that need a decision from you are marked `TODO(you)`. Those markers are a
starting point, not a checklist: **`healthCheck()` and `publish()` carry none and
still have to be written**, and every field of `meta` has to be replaced. When
you are done, search the file for `template` and `provider` — anything still
saying either is something you have not filled in.

```js
// src/connectors/<kind>-<provider>.mjs

export const meta = {
  id: "mail-outlook",
  // One of: "lms" | "mail" | "calendar-sink" | "board" | "grades"
  kind: "mail",
  label: "Outlook (classic, Windows)",
  configPath: "connectors.mail.outlook",     // dotted path into config
  requires: {
    os: ["win32"],                            // [] = any
    bin: [],                                  // must be on PATH, e.g. ["gh"]
    mcp: [],                                  // .mcp.json keys, e.g. ["brightspace"]
    app: ["Outlook (classic)"]                // human-readable, for the doctor
  },
  tier: 2                                     // 1 hosted-OAuth · 2 local+token · 3 expect trouble
};

export function isEnabled(cfg) { /* default: cfg at configPath has enabled === true */ }

// SOURCES: read the world, emit the shapes below. Must never throw for an
// expected failure — return it in errors[]. Must respect ctx.deadline.
export async function collect(ctx) {
  return { items: [], mail: [], announcements: [], board: [], grades: [], errors: [] };
}

// SINKS (kind: "calendar-sink"): write the world.
export async function publish(ctx, { items, focus }) {
  return { written: 0, updated: 0, removed: 0, errors: [] };
}

// Every connector: a cheap, credential-light liveness probe for /agenda-doctor.
export async function healthCheck(ctx) {
  return { ok: true, detail: "12 courses visible", fix: null };
}
```

`ctx` is, exactly (see `src/scrape.mjs`, where it is built):

```js
{ root, cfg, derived, now, dataDir, deadline,
  log(level, msg), mcp(serverKey), exec(bin, args, opts), fetch }
```

| Field | What it is |
|---|---|
| `root` | The repository root, absolute. **Easy to miss and frequently needed** — `grades-gradescope.mjs` uses it to locate its Python shim. Anything outside `data/` is found from here, never from `process.cwd()` |
| `cfg` / `derived` | The loaded config, and every name derived from `namespace` |
| `now` | The run's instant. **Use this, never `new Date()`** — it is what makes demo mode byte-reproducible |
| `dataDir` | Where state goes. Respects `--data` |
| `deadline` | An epoch-millisecond budget. Past it, give up and return what you have |
| `log(level, msg)` | The run's log channel |
| `mcp(serverKey)` | Returns a **connected** MCP client handle, spawning a child process for a stdio server. **You must `close()` it** — see §8 |
| `exec(bin, args, opts)` | A timeout-wrapped `execFileSync`: **synchronous**, returns stdout as a string, and **throws** on a non-zero exit with the error's `.stderr` carrying the detail. It never puts a secret in `argv` |
| `fetch` | `globalThis.fetch`, handed over on the ctx so a test can substitute one. This is what a **hosted-API connector with a token and no MCP server** uses; `lms-canvas.mjs` calls it as `ctx.fetch ?? globalThis.fetch`, and you should too |

### Three rules the contract enforces

1. **Never throw for an expected failure.** A server being down, a token being
   stale, a tool returning nothing — all of those are `errors[]` entries. A
   connector that throws takes the whole sweep with it, and one flaky source must
   never cost the user their whole agenda.
2. **Respect `ctx.deadline`.** A source that hangs must give up. The light run
   has a two-minute budget and the heavy run has users waiting.
3. **`healthCheck()` must be cheap, and it must write nothing.**
   `node scripts/health-check.mjs` runs it for every enabled connector, with a
   45-second budget each, and `/agenda-doctor` runs that. It proves a session is
   alive; it does not prove a full sweep would succeed, and it should not try to.
   A probe with a side effect is a probe nobody dares run when something is
   already wrong — so no writes, no scrape, no calendar event.

---

## 4. The emission shapes

```jsonc
Item  { courseId:0, course:"MATH 210", title:"Problem Set 4", due:"ISO",
        type:"exam|project|lab|quiz|homework|email|task|other",
        submitted:true|false|null,          // null = UNKNOWN. Never guess false.
        approx:false, sources:["dropbox"], url:null, grade:null, desc:null }
Mail  { id, from, addr, subj, recv:"ISO", tag:"research|course|action|info", gist, ask, replyBy }
Ann   { course, title, posted:"ISO" }
Board { repo, n, t, kind:"issue|pr", u, upd:"ISO" }
Grade { courseId, title, display:"92 %", numeric:0.92 }
```

`validateEmission(kind, out)` in `src/connectors/index.mjs` checks these and
throws with the **field path** on a violation, so a mistake is a named error
rather than a mysterious empty page.

### The tri-state rule is the contract's most important line

> **`submitted: false` means a source *explicitly said* "not submitted". If you
> do not know, emit `null`.**

A connector that emits `false` on absence will make the agenda **accuse the user
of not doing work they have done.** That is a real incident, it produced
`docs/design-notes/data-truth.md`, and it is the one bug in this repo that
destroys the product's entire value in a single notification.

```js
// WRONG - maps every unknown to a false accusation
submitted: Boolean(row.submittedAt)

// RIGHT - only a positive statement changes it from unknown
let submitted = null;
if (/^submitted$/i.test(row.status)) submitted = true;
else if (/^no submission$/i.test(row.status)) submitted = false;
```

**Read that design note before you write a `collect()`.** It is four minutes and
it is the difference between a connector that helps and one that has to be
reverted.

### Two more never-do-this rules

- **Never invent a date.** No deadline and no way to resolve one means the thing
  belongs in `mail[]`, not `items[]`. A wrong deadline displaces real coursework
  and teaches the user to distrust the agenda.
- **`approx: true` when you estimated.** If a source gave you "sometime next
  week" and you resolved it to Friday 23:59, say so. The page renders approximate
  dates with a `~` and the planner treats them more loosely.

---

## 5. Enable / disable semantics

- A connector runs **iff** the block at its own `meta.configPath` has
  `enabled === true` **and** every `meta.requires` entry is satisfiable on this
  machine.
- **`configPath` is the authority, not the kind.** The two usually match
  (`connectors.mail.outlook` for `kind: "mail"`), and there is one standing
  exception: a `kind: "calendar-sink"` connector lives under
  `connectors.calendar.<provider>` — `connectors.calendar.outlook`,
  `connectors.calendar.ics`. There is no `connectors.calendar-sink` and looking
  for one is the mistake this bullet exists to prevent.
- An enabled-but-unsatisfiable connector produces **one** `errors[]` line
  (`outlook: skipped (requires Windows)`) and is otherwise a no-op. **It never
  fails the run.**
- **The only hard requirement:** at least one `kind: "lms"` source is enabled
  *and* configured. Otherwise `scrape.mjs` exits 1 with, verbatim:

  ```
  scrape: no LMS source is enabled.
    Every other source is optional; this one is not - without it there is
    nothing to build an agenda from.
    Fix: set connectors.lms.<provider>.enabled to true in config.json,
    or add a source of your own - docs/EXTENDING.md walks through it.
  ```

  `node scripts/validate-setup.mjs` fails on the same condition, so you find out
  before the scrape rather than after it.
- **A calendar has two directions and they are different features.** A
  `kind: "calendar-sink"` connector under `connectors.calendar.<provider>` writes
  the agenda's deadlines OUT. Reading the user's own meetings IN is not a
  registry connector at all: it is `calendars.gcal` in the config and
  `src/connectors/gcal-ingest.mjs` on disk, because the bytes arrive through a
  connector the user authorized in their own Claude account and the pipeline has
  no credential to fetch them with. See "Agent-fed sources" below.
- **`materials` is not a connector kind.** `connectors.materials` is a flat
  config block (`enabled`, `root`, `categories`, `maxFileMB`) driving the
  standalone `src/materials-sync.mjs`. There is no provider level, no registry
  slot and no adapter — an agent asked to "add a materials source" should say so
  rather than inventing one.
- Demo mode bypasses the registry entirely — it renders from fixtures.

**A new connector ships with `"enabled": false`.** The user turns it on once it
has been verified against their account, not before.

---

## 5b. Agent-fed sources - when the pipeline cannot hold the credential

Most sources here are adapters: the pipeline calls something and gets data back.
Some sources cannot work that way, and the inbound calendar is the worked
example.

A personal calendar needs OAuth against an account the user owns. Putting those
credentials on the user's machine means a token store, a refresh flow and a
consent screen a scheduled run cannot answer at 07:03. But the user has already
authorized a calendar connector in their own Claude account - and the scheduled
run **is** a Claude agent. So the agent borrows that authorization for the length
of one step.

The shape, and it generalises to any source in this position:

1. **The runbook** tells the agent exactly which tool to call, with which
   arguments, and to save the result **VERBATIM** to a file under `data/tmp/`.
   No reformatting, no trimming, no summarising. The agent is a transport.
2. **A deterministic script** reads that file and decides everything: what the
   fields mean, which records are in the window, what an offset-less time is, and
   what happens when the file is missing. `src/connectors/gcal-ingest.mjs` is
   this half, and `gcal-normalize.mjs` is its pure core.
3. **The exit code is the contract.** 0 ingested, 3 partial (the previous run's
   data stands in for up to 48 hours, and the file is written either way so
   nothing on disk is lying), 1 hard failure with the previous file untouched.
4. **The runbook maps the code to one log token** and continues. A source like
   this never fails a run.

**The agent copies bytes; the script decides.** Everything that is a judgement
lives in code a unit test can pin down, which is the same rule the rest of this
repository runs on - it is just applied to a fetch instead of to a plan.

Three rules that come with the shape:

- **Direction is declared and enforced.** The runbook restricts the agent to the
  connector's read tools, and the script cannot reach the network at all, so
  "inbound only" is not a promise - it is a property of a script that has no
  socket.
- **The raw file is a secret.** It may hold attendee addresses, meeting bodies
  and conference PINs. Nothing from it is printed: a warning names a record by
  eight characters of its id, a parse failure is reported as a byte count and
  never a snippet, and the temp file is deleted by the step that made it.
- **Never call `authenticate`.** A connector the user has not authorized is a
  `SKIPPED` token and a line in the digest. A scheduled run that opens a consent
  screen leaves a browser waiting on somebody who is asleep.

---

## 6. The seven steps

1. **Pick a server** from the tier table above — or establish that the source has
   a plain HTTP API and a token, which needs no server at all.
2. **Register it**, with the OS-correct shape. Skip this for a token-only source.
3. **Copy `src/connectors/_template.mjs`** to
   `src/connectors/<kind>-<provider>.mjs`. Fill `meta`, implement `collect()`
   returning the shapes above, implement `healthCheck()`.

   **To find out what the server actually calls its tools, ask it.**
   `src/lib/mcp-client.mjs` exposes `listTools()` for exactly this: connect once
   and print the list, rather than guessing names off a README.

   ```
   node -e "import('./src/lib/mcp-client.mjs').then(async m => { \
     const c = await m.connect({ command: 'npx', args: ['-y', '<pkg>'] }); \
     console.log((await c.listTools()).map(t => t.name).join('\n')); await c.close(); })"
   ```

   Every tool name in a connector should have come from that output.
4. **Register it in `src/connectors/index.mjs`** — one import, one array entry.
   The list is static on purpose: no dynamic globbing, so the registry stays
   analysable and dependency-free.
5. **Add its config block in THREE places, not two.** All three are checked
   against each other by `test/config.test.mjs`, which asserts the defaults and
   the example agree key for key — so getting this wrong **breaks the test suite
   in the next step**:

   | Place | Why |
   |---|---|
   | `src/lib/config.mjs` → `DEFAULTS` | The loader's own defaults. **This is the one people forget** |
   | `config.example.json` | The committed template, with `"enabled": false` |
   | `config.json` | Your own working copy, if you have one |

   Then document every key in `docs/CONFIG.md`.
6. **Add a test.** `test/connectors.test.mjs` covers the registry itself; a
   provider gets its own file. **The shipped precedent is Canvas** —
   `test/lms-canvas.test.mjs` reads recorded responses from `fixtures/canvas/`
   (`courses.page1.json`, `assignments-110001.json`, …) and feeds them through a
   stub `ctx.fetch`. Copy that shape: `fixtures/<provider>/` for anything you
   recorded, `test/<connector-id>.test.mjs` for the assertions.

   For one or two small rows, an **inline** literal is still the right call — no
   fixture file earns its keep for a five-line object:

   ```js
   const sample = { items: [ /* one realistic row, pasted from a real response */ ] };
   const out = mapRows(sample);                       // your pure mapping function
   assert.doesNotThrow(() => validateEmission("<kind>", out));
   assert.throws(() => validateEmission("<kind>", { ...out, items: [{}] }),
                 /items\[0\]/);                        // a missing field names its path
   ```

   Keep the mapping in a small exported pure function so the test never needs a
   network, a token or a `ctx`. **Redact the sample** before you commit it — no
   real names, ids, emails or institution names, per `CONTRIBUTING.md`.
7. **Verify end to end:**
   ```
   node scripts/validate-setup.mjs
   node src/scrape.mjs
   # check data/latest.json has items with sources: ["<provider>"]
   node src/render.mjs
   ```
   Report what appeared on the page that was not there before. That is the only
   proof that matters.

---

## 7. Swapping a source

Both LMS connectors ship. Swapping is a config change and nothing else — no
connector to write, no file to add.

**Brightspace → Canvas:**

```jsonc
"connectors": {
  "lms": {
    "brightspace": { "enabled": false, ... },
    "canvas": {
      "enabled": true,
      "baseUrl": "https://canvas.example.edu",
      "token": "[NOT SET]",
      "courseFilter": []
    }
  }
}
```

Fill in `baseUrl` and a personal access token, and you are done — no server, no
`.mcp.json` entry, no trust prompt. **Either or both may be enabled**; with both
on, `merge.mjs` deduplicates by item key and an item present in each ends up with
`sources: ["brightspace", "canvas"]`. `docs/connectors/canvas.md` has the token
walkthrough, and the honest note about institutions that disable tokens.

**Dropping Outlook** (moving to a Mac, say): set
`connectors.mail.outlook.enabled` and `connectors.calendar.outlook.enabled` to
`false`. That is the whole change. The page renders correctly with `mail: []` and
the mail panel hides itself.

For deadline reminders, enable `connectors.calendar.ics` and subscribe your
calendar app to the file — `docs/connectors/calendar-ics.md` has the click-path.
**That does not bring back the dead-man's switch**, which needs a calendar
service that can ring when your machine is off, and reports
`deadman=SKIPPED(no-calendar-sink)` on every other configuration.

| Capability | With Outlook (Windows) | Without Outlook |
|---|---|---|
| Mail triage → deadline items | `mail-outlook` sweep | disabled; the mail panel hides itself |
| Deadline events with reminders | `calendar-outlook` sink | `calendar-ics` sink, subscribed from Google or Apple Calendar |
| Dead-man's switch | a calendar event 26 h out | **not available.** `deadman=SKIPPED(no-calendar-sink)`, an expected token |
| Everything else — LMS, board, planner, page, buses | identical | **identical** |

---

## 8. A worked example: Todoist as a `board` source

Suppose you keep non-course work in Todoist instead of on a GitHub board.

**Step 1 — server.** Todoist is Tier 1:

```
claude mcp add --scope project --transport http todoist https://ai.todoist.net/mcp
```

You will see Todoist's OAuth screen. **Not** `@abhiz123/todoist-mcp-server`,
which is dead despite ranking well.

**Step 2 — the connector.**

```js
// src/connectors/board-todoist.mjs
export const meta = {
  id: "board-todoist",
  kind: "board",
  label: "Todoist",
  configPath: "connectors.board.todoist",
  requires: { os: [], bin: [], mcp: ["todoist"], app: [] },
  tier: 1
};

export async function collect(ctx) {
  const errors = [];
  const board = [];
  const items = [];
  let client = null;
  try {
    client = await ctx.mcp("todoist");
    // The tool names came from listTools(), not from a README. See step 3.
    const raw = await client.call("get_tasks", {
      project_id: ctx.cfg.connectors.board.todoist.projectId
    });

    // call() returns JSON.parse(text) OR the raw string when the body is not
    // JSON. Iterating a string yields characters and every field is undefined,
    // which then throws inside the loop -- breaking rule 1. Guard first.
    if (!Array.isArray(raw)) {
      errors.push(`todoist: expected a task list, got ${typeof raw}`);
      return { items, mail: [], announcements: [], board, grades: [], errors };
    }
    const tasks = raw;

    for (const t of tasks) {
      // A due date is a FACT the source stated. Undated is also a fact, not a
      // gap to fill: it stays on the board and never becomes a dated item.
      if (t.due?.date) {
        items.push({
          courseId: 0,
          course: ctx.derived.sideBucket,
          title: t.content,
          due: new Date(t.due.date).toISOString(),
          type: "task",
          submitted: t.is_completed === true ? true : null,   // never false
          approx: t.due.is_recurring === true,
          sources: ["todoist"],
          url: t.url ?? null, grade: null, desc: null
        });
      } else {
        board.push({
          repo: t.project_name ?? "todoist",
          n: t.id, t: t.content, kind: "issue",
          u: t.url ?? null, upd: t.updated_at ?? null
        });
      }
    }
  } catch (err) {
    // Expected failure -> errors[], never a throw.
    errors.push(`todoist: ${err.message}`);
  } finally {
    // ctx.mcp() spawned a child process. Nothing else closes it, so a
    // connector that forgets this leaks one npx process per run, forever.
    await client?.close();
  }
  return { items, mail: [], announcements: [], board, grades: [], errors };
}

export async function healthCheck(ctx) {
  let client = null;
  try {
    client = await ctx.mcp("todoist");
    const projects = await client.call("get_projects", {});
    const n = Array.isArray(projects) ? projects.length : 0;
    return { ok: true, detail: `${n} project(s) visible`, fix: null };
  } catch {
    return { ok: false, detail: "cannot reach Todoist", fix: "Re-approve the Todoist connector in Claude." };
  } finally {
    await client?.close();
  }
}
```

Note the four decisions that matter:

- `submitted` is `true` only when Todoist *said* the task is complete, and `null`
  otherwise. Never `false`.
- An undated task goes on the **board**, not into `items[]`. Undated is
  information, and inventing a date for it would displace real coursework.
- **Every `ctx.mcp()` handle is closed in a `finally`.** The shipped connectors
  do this (`lms-brightspace.mjs`); the cost of forgetting is a stray child
  process on every run, twice a day, forever.
- **A tool result is not guaranteed to be an array.** `call()` parses JSON when
  it can and hands back the raw string when it cannot, so the shape is checked
  before it is iterated. `lms-brightspace.mjs` guards the same way.

**Step 3 — register.** In `src/connectors/index.mjs`:

```js
import * as boardTodoist from "./board-todoist.mjs";
export const ALL = [ ..., boardTodoist ];
```

**Step 4 — config.** In **all three** places from §6 step 5 — `DEFAULTS` in
`src/lib/config.mjs`, `config.example.json`, and your own `config.json`:

```jsonc
"board": {
  "github":  { "enabled": false, "budgetMs": 60000 },
  "todoist": { "enabled": false, "projectId": "[NOT SET]" }
}
```

and document `projectId` in `docs/CONFIG.md`. Miss `DEFAULTS` and
`test/config.test.mjs` fails on the very next step, which is the point of it.

**Step 5 — test.** In `test/connectors.test.mjs`, write an inline sample task
list, assert `validateEmission("board", out)` passes, and assert that a task with
a malformed `due` produces a named error rather than a silent skip.

**Step 6 — verify.** Turn it on, run the scrape, and check that the side-project
column on the page now shows Todoist work.

---

## 9. Contributing it back

A working connector is the most useful contribution this project can receive. See
`CONTRIBUTING.md` for the checklist — and if a source turned out to be
impossible, `docs/connectors/not-supported.md` takes additions too. Recording
what does not work saves the next person an evening.
