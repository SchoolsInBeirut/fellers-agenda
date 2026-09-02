# Hosted OAuth connectors — Tier 1

**The best case.** No local process, no token to store, no operating-system
differences, and they work in a cloud environment where local servers cannot.

If a source you want is available this way, take it.

---

## What "Tier 1" buys you

| | Tier 1 (hosted) | Tier 2 (local) |
|---|---|---|
| Install | Nothing | A runtime, a package, sometimes a build |
| Credential | OAuth, held by the provider | A token you store and rotate yourself |
| Windows / macOS differences | **None** | The `cmd /c npx` wrapper trap |
| Works in a cloud environment | **Yes** | **No** — a cloud task cannot reach your laptop |
| Breaks when | The provider changes their API | Any of: the package, the runtime, your token, your OS |

That last row is the real argument. A Tier 2 connector has four independent
things that can break it; a Tier 1 connector has one.

---

## The catalogue

| Source | How | Useful as |
|---|---|---|
| **Notion** | `https://mcp.notion.com/mcp` | A `board` source, if you plan in Notion |
| **Todoist** | `https://ai.todoist.net/mcp` | A `board` source. **Use the hosted endpoint** |
| **GitHub** | `https://api.githubcopilot.com/mcp/` | Nothing, **as shipped**. See the warning below |
| **Google Drive** | Claude's built-in connector | The transport. Already used — see `docs/connectors/google-drive.md` |

> **The GitHub row is a trap and is listed here to defuse it.** The endpoint is
> real and it is genuinely Tier 1 — but **the board connector this repo ships
> does not use it.** `src/connectors/board-github.mjs` declares
> `requires: { bin: ["gh"], mcp: [] }` and shells out to the `gh` CLI; it never
> makes an MCP call. Registering the hosted server changes nothing, and the
> board still fails with `gh CLI not found on PATH` until `gh` is installed and
> authenticated. See `docs/connectors/github.md`. If you want to *write* an
> MCP-backed board connector, that endpoint is the right starting point and
> `docs/EXTENDING.md` §8 is the worked example.

### Adding one

```
claude mcp add --scope project --transport http notion https://mcp.notion.com/mcp
```

Two things will happen, and **both should be announced before they appear:**

1. **The MCP trust prompt** — Claude Code asking whether you trust the servers in
   this project. Per-user, per-project, and **no repository can pre-grant it.**
   `claude mcp reset-project-choices` re-prompts if you dismiss it.
2. **The provider's OAuth consent screen** — Notion's, Todoist's, Google's.
   **That is their screen, not this repo's.** Say so. An unannounced consent
   screen from a stranger's repository is exactly where people quit, and they are
   right to.

Google Drive is not declared in `.mcp.json` at all — it comes from **your own
Claude account's connectors**, and you authorise it there
(claude.ai → Settings → Connectors).

---

## There is no hosted calendar sink

Worth stating plainly, because it is the thing people look for here.

The two calendar sinks this repo ships are `calendar-outlook` (Windows, classic
Outlook, local COM) and `calendar-ics` (a standard `.ics` file, every platform).
**Neither is a hosted connector**, and no hosted calendar sink exists in this
repo — a Tier 1 endpoint you register in `.mcp.json` is not wired to anything on
the calendar side.

For deadline reminders on macOS, Linux, or Windows without classic Outlook, use
the ICS sink and subscribe to the file: `docs/connectors/calendar-ics.md` has the
exact click-path for Google Calendar and Apple Calendar.

**The dead-man's switch is Outlook-only.** It needs a calendar service that can
ring when this machine is gone, and a local `.ics` file cannot. On every other
configuration a run logs `deadman=SKIPPED(no-calendar-sink)`, which is an
expected token rather than a fault — see `docs/design-notes/watchdogs.md`.

---

## Notion or Todoist as a board source

Both slot into the `board` kind, exactly where GitHub sits by default. The whole
point of the adapter layer is that the planner does not care where the bucket's
contents came from.

`docs/EXTENDING.md` has a **complete worked example** for Todoist — the config,
the connector, the health check and the test. Copy it.

The two decisions that matter, and they are the same for every board source:

1. **A due date the source stated is a fact.** Use it.
2. **Undated is also a fact, not a gap to fill.** It goes on the board and never
   becomes a dated item. A wrong deadline displaces real coursework and teaches
   you to distrust the agenda.

And, as always: `submitted` is `true` only when the source *said* the thing is
done. Never `false` on absence. See `docs/design-notes/data-truth.md`.

---

## Known-dead packages — refuse these

They rank highly in search and they will waste your afternoon.

| Package | Status | Use instead |
|---|---|---|
| `@abhiz123/todoist-mcp-server` | Dead | The hosted Todoist endpoint above |
| `apple-mcp` / `@dhravya/apple-mcp` | Dead | `npx mcp-server-apple-events` on macOS (Tier 2) |
| `faizan45640/google-classroom-mcp-server` | Dead | Nothing. See `docs/connectors/not-supported.md` |
| `@anthropic-ai/mcp-server-gdrive` | **Does not exist** | Google Drive is a built-in connector, not an npm package |

`/add-source` refuses these by name, and so should you.

---

## What Tier 1 cannot give you

**An LMS.** Almost no learning-management system offers a hosted MCP endpoint,
and that single fact is why the Brightspace connector needs a local server.

The practical escape is not Tier 1 at all — it is **Canvas**, which needs only an
API token and no server of any kind, so it runs in a cloud environment as
happily as on a laptop. `docs/connectors/canvas.md`. If your school runs Canvas,
a cloud-only configuration is genuinely available to you.

If your school runs Brightspace, `docs/SCHEDULING.md`'s Cowork section explains
the workable hybrid: run the heavy lane on your laptop where the local server
lives, and the light lane in the cloud, which only needs Drive.
