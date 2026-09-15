---
description: Guided walkthrough for adding a new data source to the agenda
argument-hint: "[what you want to connect]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch
---

Add a new source to the agenda. `$ARGUMENTS` is what the user asked for, if
anything.

**Read `docs/EXTENDING.md` first.** It carries the tier table, the adapter
contract, the emission shapes and the seven steps. Everything below is the
walkthrough; that file is the specification.

## Step 1 — what and which slot

Ask, one question at a time:

1. *"What do you want to connect? (example: Notion, Todoist, Moodle, your
   university's own portal)"*
2. *"What should it feed?"* — the contract has **five** kinds:
   `lms`, `mail`, `calendar-sink`, `board`, `grades`. Pick the closest and say
   which you picked and why.

   **`materials` is not one of them.** `connectors.materials` is a flat config
   block driving the standalone `src/materials-sync.mjs`; there is no provider
   level, no registry slot and no adapter. If the user wants a materials source,
   say that plainly rather than inventing a shape that will not load.

   **`calendar-sink` is the one kind whose config path does not match its name:**
   it lives under `connectors.calendar.<provider>`, alongside `outlook` and
   `ics`. There is no `connectors.calendar-sink`.

## Step 2 — find a server, and be honest about the tier

Check `docs/EXTENDING.md`'s tier table before searching the web.

- **Tier 1 — hosted OAuth, one command, nothing to install.** Notion
  (`https://mcp.notion.com/mcp`), Todoist (`https://ai.todoist.net/mcp`), and
  Google Drive via Claude's own built-in connector. GitHub has a hosted endpoint
  too — but **the board connector this repo ships never calls MCP**; it shells
  out to the `gh` CLI, so registering that server changes nothing.
- **Tier 1, the other shape — a plain HTTP API plus a token, no server at all.**
  `tier: 1` means "nothing to install", and a direct API call qualifies just as
  much as hosted OAuth: no `.mcp.json` entry, no trust prompt, works in a cloud
  environment. The Canvas LMS connector is built this way (`baseUrl` + `token`
  in `config.json`), and so is the ICS calendar sink, which needs no credential
  at all.
- **Tier 2 — a local server plus a token.** Moodle (`uvx moodle-mcp`), Apple
  Calendar (`npx mcp-server-apple-events`, macOS only), Brightspace
  (`npx brightspace-mcp-server@latest`).
- **Tier 3 — expect failure, and say so before they spend an hour.** Google
  Classroom needs a school-admin allow-list. Blackboard has **no viable
  general-purpose server**. See `docs/connectors/not-supported.md`.

**Refuse these even though they rank highly in search.** They are dead, and
recommending one wastes the user's afternoon:
`@abhiz123/todoist-mcp-server`, `apple-mcp` / `@dhravya/apple-mcp`,
`faizan45640/google-classroom-mcp-server`, and `@anthropic-ai/mcp-server-gdrive`
(which does not exist at all).

If nothing suitable exists, say so plainly and stop. A connector with no server
behind it is not a small amount of work; it is a different project.

## Step 3 — register the server

```
claude mcp add --scope project --transport http <name> <url>
```

or, for a local one:

```
claude mcp add-json <name> '<json>' --scope project
```

**That single-quoted form is bash / zsh only.** In PowerShell the same single
quotes work; in `cmd.exe` only double quotes exist and the inner ones must be
doubled:

```
claude mcp add-json <name> "{""command"":""npx"",""args"":[""-y"",""<pkg>""]}" --scope project
```

If the quoting fights back, **edit `.mcp.json` directly** — that is the only file
`add-json` writes.

**On Windows an stdio `npx` server must be wrapped:**

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "<pkg>"] }
```

Writing a Mac-shaped `npx` entry is the single most common cross-platform break
in this whole project. Detect the platform and write the correct block; do not
copy the example from a README.

**Pre-announce both screens before either appears:**

1. **The MCP trust prompt** — Claude Code asking whether the user trusts the
   servers in this project. Per-user, per-project, and **no repository can
   pre-grant it.** If they dismiss it, `claude mcp reset-project-choices`
   re-prompts; that is the recovery, and it is the thing most likely to be
   needed mid-walkthrough.
2. **The provider's own OAuth consent screen** — Notion's, Todoist's, whoever's.
   **That is their screen, not this repo's.** Say so. An unannounced consent
   screen from a stranger's repository is exactly where people quit, and they
   are right to.

**Then tell them to restart Claude Code.** `.mcp.json` is read at session start,
so a server you just registered is not live in this session. Nothing works around
that; say it rather than debugging a server that was never loaded.

## Step 4 — write the connector

Copy the template — use Read and Write rather than a shell copy, so it works the
same on every platform (`cp` is not a command in `cmd.exe`):

- Read `src/connectors/_template.mjs`
- Write it to `src/connectors/<kind>-<provider>.mjs`

Fill in `meta` (`id`, `kind`, `label`, `configPath`, `requires`, `tier`), then
implement `collect()` and `healthCheck()`. The template is heavily commented and
the places needing a decision are marked `TODO(you)` — but those markers are a
starting point, not a checklist: **`healthCheck()` and `publish()` carry none**
and still have to be written.

**Find the server's real tool names before you write a single `call()`.**
`src/lib/mcp-client.mjs` exposes `listTools()` for exactly this. Connect once,
print the list, and use those names. Every tool name in a shipped connector came
from that output, not from a README.

**Close every client you open.** `ctx.mcp()` spawns a child process and nothing
else cleans it up, so a `finally { await client?.close(); }` is not optional — a
connector without one leaks a process on every run, every day, forever.

**Guard the shape of a tool result.** `call()` returns parsed JSON when it can
and the **raw string** when it cannot. Iterating a string yields characters and
throws inside your loop, which breaks the never-throw rule below. Check
`Array.isArray()` first and push an `errors[]` line if it is not.

### The rule you must not get wrong

`submitted` is **tri-state**:

- `true` — a source gave positive evidence the work is done.
- `false` — a source *explicitly said* it is not done.
- `null` — you do not know.

**If you do not know, emit `null`.** A connector that emits `false` on absence
makes the agenda accuse the user of not doing work they have already done. That
is a real incident and it is written up in
`docs/design-notes/data-truth.md`. Read it before writing `collect()`.

Two more that the contract enforces:

- **Never throw for an expected failure.** Return it as an `errors[]` entry. A
  connector that throws takes the whole sweep with it.
- **Respect `ctx.deadline`.** A source that hangs must give up, not hold the run.

## Step 5 — register it

`src/connectors/index.mjs`: one import line, one entry in `ALL`. The list is
static on purpose — no dynamic globbing, so the registry stays analysable and
dependency-free.

## Step 6 — config and docs

Add the block in **three** places, not two. `test/config.test.mjs` asserts the
defaults and the example agree key for key, so missing one breaks the suite in
the very next step:

| Place | Why |
|---|---|
| `src/lib/config.mjs` → `DEFAULTS` | The loader's own defaults. **This is the one that gets forgotten** |
| `config.example.json` | The committed template, with `"enabled": false` |
| `config.json` | The user's working copy, if it exists |

A new source ships off; the user turns it on once it has been verified against
their account. Then document every key in `docs/CONFIG.md`.

## Step 7 — test it

`test/connectors.test.mjs` covers the registry; a provider gets its own file.
**Copy the shipped precedent:** `test/lms-canvas.test.mjs` reads recorded
responses out of `fixtures/canvas/` and feeds them through a stub `ctx.fetch`.
Do the same with `fixtures/<provider>/` and `test/<connector-id>.test.mjs` — or,
for one or two small rows, write the sample **inline** as a literal object shaped
like a response you actually saw. Either way: keep the mapping in a small pure
function so the test needs no network or `ctx`, assert
`validateEmission("<kind>", out)` passes, and assert that a **missing field
produces a named error** carrying its field path.

**Redact the sample before committing it**: no real names, ids, emails or
institution names. `CONTRIBUTING.md` has the placeholder cast. Then:

```
npm test
node scripts/validate-setup.mjs
node src/scrape.mjs
```

Check `data/latest.json` has items carrying `sources: ["<provider>"]`, then:

```
node src/render.mjs
```

Report what appeared on the page that was not there before. That is the only
proof that matters.

## Finally

Offer to open a pull request against the upstream template. A working connector
is the most useful contribution this project can receive, and `CONTRIBUTING.md`
has the checklist.
