# GitHub — the side-project board

**Tier 2 — a local tool plus a token of its own. Runs on the `gh` CLI. Disabled
by default.** `src/connectors/board-github.mjs` declares `tier: 2`.

It needs `gh` on your `PATH` and authenticated, and **it makes no MCP calls at
all** — `requires: { bin: ["gh"], mcp: [] }`. GitHub does publish a hosted MCP
endpoint (`https://api.githubcopilot.com/mcp/`), and the tier tables in
`docs/EXTENDING.md` and `docs/connectors/hosted-oauth.md` list it; **registering
that server does nothing for this connector.** If the board is empty and you
have just added an MCP server, that is why.

```jsonc
"sideProject": {
  "enabled": false,
  "label": "Side Project",
  "provider": "github",
  "org": "[NOT SET]",
  "repos": [],
  "minDailyMinutes": 60,
  "maxDailyMinutes": 180
},
"connectors": { "board": { "github": { "enabled": false, "budgetMs": 60000 } } }
```

**Two flags switch this on, and both are off by default.** The connector runs
only when `sideProject.enabled` *and* `connectors.board.github.enabled` are both
`true` — `isEnabled()` in `src/connectors/board-github.mjs` requires the pair.
Turning on only one of them is a silent no-op: no error, no skip line, an empty
board. That is the first thing to check when the board does not appear.

The split is deliberate. `sideProject.enabled` is **the feature** — whether the
planner reserves any hours for a side project. `connectors.board.github.enabled`
is **the source** — where that project's work comes from. Switching the source on
while the feature was off used to produce a board full of issues that no study
block was ever planned for: visible work with nowhere to do it.

| Key | Effect |
|---|---|
| `sideProject.enabled` | **Half of the switch.** True → the planner reserves time for the bucket |
| `connectors.board.github.enabled` | **The other half.** True → the connector fetches the work |
| `sideProject.org` | **Required when the connector runs.** With no organisation there is nothing to query, and the connector fails rather than guessing |
| `sideProject.label` | The bucket's name everywhere — page, planner, `difficulty`, command bus |

---

## Why this exists

Work outside coursework competes for **the same hours** as coursework.

If the agenda cannot see it, it does not exist to the planner — so the planner
confidently books your whole Tuesday evening for a problem set, on an evening
where you have a release to ship. And then the side project loses, silently, to
whatever the LMS happened to be shouting about that day.

That is the exact failure this system was built to prevent, so leaving a whole
category of your work invisible would be self-defeating.

Making it visible has a second effect that is easy to miss: **it becomes
schedulable.** `minDailyMinutes` / `maxDailyMinutes` bound how much time the
planner may hand the bucket on a day with open work, so it gets a real slot
rather than the leftovers.

---

## What it collects

Two `gh` invocations. First one to resolve your login, then a single GraphQL
query with four aliased searches:

- open **issues** assigned to you
- open **issues** you created
- open **pull requests** you authored
- open **pull requests** with a review requested from you

Scoped by `sideProject.org`, narrowed by `sideProject.repos` (**empty means every
repo in the org you touch**).

Output goes to `data/board-items.json` in two piles:

| Pile | What | Where it appears |
|---|---|---|
| `board[]` | **Undated** open work, newest-updated first | The side-project column on the page |
| `items[]` | Work with a **real deadline** | Merged and scheduled exactly like an assignment |

---

## Deadlines: never invented

**Undated is a fact about the work, not a gap to fill.**

The connector dates an item only when GitHub says so in exactly two ways:

1. a **milestone due date**
2. an **explicit deadline in the title** carrying a cue word — `due 2026-09-15`,
   `deadline Sep 15`, `due by 9/15`

That is the whole list. A bare date in a title — `Bump the parser to 4/17` — is
**not** a deadline and stays on the board. No guessing from bodies, labels,
project columns, or how urgent the title sounds.

The reason is asymmetric cost, the same one that runs through the rest of this
repo:

> **A wrong deadline displaces real coursework and teaches you to distrust the
> agenda. A missing deadline costs one board entry that you can see anyway.**

If a task genuinely needs a date, set a milestone in GitHub. That is a
thirty-second edit in the place the fact belongs, and it is authoritative
afterwards.

---

## Setup

**1. Install and authenticate `gh`** — [cli.github.com](https://cli.github.com).

```
gh auth login
```

> **This is an interactive wizard, and it is yours to run.** An agent cannot
> answer it: called from a tool it either hangs waiting for input nobody is
> giving, or reads end-of-file and fails. Run it **in your own terminal**.
>
> It asks, in order: **GitHub.com or an enterprise host**; **HTTPS or SSH**;
> whether to authenticate `git` with your GitHub credentials; and **how to log
> in — choose "Login with a web browser"**. It then prints an **eight-character
> one-time code**, opens github.com, and waits while you paste the code in and
> approve.
>
> When it says you are logged in, come back. Verify with `gh auth status`, which
> is non-interactive and safe for an agent to run.

**2. Check your scopes.** Organisation work needs `repo` and `read:org`:

```
gh auth refresh -s repo,read:org
```

**Also interactive**, and also yours: it prints a fresh one-time code and waits
for the same browser approval. Same rule — you type it, then `gh auth status`
confirms it.

Without `read:org`, the org-wide search returns nothing and it does not look like
an error — it looks like you have no open work.

**3. Fill in the config:**

```jsonc
"sideProject": {
  "enabled": true,
  "label": "Side Project",
  "org": "example-org",
  "repos": ["example-api", "example-web"],
  "minDailyMinutes": 60,
  "maxDailyMinutes": 180
},
"connectors": { "board": { "github": { "enabled": true, "budgetMs": 60000 } } }
```

Also give the bucket a difficulty, using **exactly the `label` string**:

```jsonc
"difficulty": { "Side Project": 4, ... }
```

The bucket takes its name from `label` everywhere — the page, the planner, the
command bus, the study model. Change `label` and change `difficulty` in the same
edit, or the model will score a bucket that no longer exists and refuse to
schedule the one that does.

**4. Verify:**

```
node src/scrape.mjs
node src/render.mjs
```

Your board should appear as its own column.

---

## Exit codes and failure handling

| exit | meaning | what happens |
|---|---|---|
| 0 | fine | the file is used |
| **3** | `gh` missing, unauthenticated, GitHub unreachable, or out of budget | `board=SKIPPED(<reason>)`. **The previous file is reused**, so yesterday's board is shown rather than an empty one. The run continues |
| 1 | bad config, or the output could not be written | `board=ERROR(<msg>)`, continue on the previous file, mention it if it repeats |

`budgetMs` (60 s) is a hard ceiling. Over it, the connector gives up and reports
`SKIPPED` — a board is never worth holding up a run.

**Never fix `gh` authentication from a scheduled run.** If a skip reason mentions
scopes or org access, that earns one line in the digest and nothing more.
Authentication is a thing you do, at a terminal, once.

---

## The bucket in the planner

Once visible, the side project behaves like any other bucket, with two
differences:

- **It is exempt from the difficulty-map requirement in the command bus.** You
  can drag a side-project block onto any day without it having been scored, which
  matters because side-project work arrives unpredictably.
- **The study model gets a board term.** Open work raises the allocation; an
  empty board lowers it. So a quiet week on the project automatically hands those
  hours back to coursework, without you doing anything.

Everything else is identical: `difficulty` 0 is still a veto, blocks are still
draggable and pinnable, and ticking a study block still closes that session
rather than the work.

---

## Other providers

Nothing about the `board` kind is GitHub-specific — it is one adapter behind a
generic slot. `docs/EXTENDING.md` has a **complete worked example** adding
Todoist as a board source, including the config, the connector and the test.

**Todoist is Tier 1** (hosted OAuth at `https://ai.todoist.net/mcp`), so it is
strictly easier to set up than this one — no CLI, no interactive login, no
scopes. Use the hosted endpoint; `@abhiz123/todoist-mcp-server` is dead despite
ranking well in search.

---

## Privacy

`gh` runs locally with your own credentials, held in its own credential store or
your OS keychain. **Nothing about your repositories is stored in this repo.**

What ends up in the payload — and therefore in your own Drive document — is issue
and pull-request **titles**, numbers, repository names and links. No bodies, no
diffs, no code.

If a title is sensitive, it will appear on your agenda page. That page is private
to you, but it is worth knowing before you turn this on for a work organisation.
