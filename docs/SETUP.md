# Setup

**You do not have to read this page.**

Open the folder in Claude Code, type `hey`, and an agent does all of this with
you, one question at a time. This is the same thing written down — for when you
want to know what is coming, when you want to do a step yourself, or when
something went sideways and you need to see what *should* have happened.

**Time:** 5–10 minutes of your attention, plus up to 30 more the first time if
Node is not installed or your school's login is slow.

**You will be asked to approve things.** That is the feature, not friction —
this template deliberately ships with permission prompts on. Here is every
screen and prompt, in the order it arrives, so none of them is a surprise:

| # | What appears | When |
|---|---|---|
| 1 | **"Do you trust the MCP servers in this project?"** | **The moment Claude Code opens this folder**, before you type anything. It fires because `.mcp.json` exists. Say yes — it only ever reads |
| 2 | **Claude Code permission prompts**, one per new kind of command or file write | Throughout. `.claude/settings.json` pre-approves a short list of read-only commands — `node --version`, the preflight, demo mode, the health check, `reauth --probe` and the test suite. Everything else asks once: `node src/scrape.mjs`, `node src/render.mjs`, `claude mcp list`, and every write to `config.json` and `CLAUDE.md` |
| 3 | **A restart of Claude Code** | Step 5, on Windows, after `.mcp.json` is corrected — Claude Code reads that file at session start |
| 4 | **Your school's login page and a two-factor push** | Step 5, Brightspace only. Canvas skips this entirely |
| 5 | **A Google consent screen** | Step 9, after you have added the Drive connector to your Claude account |
| 6 | **`gh auth login`**, an interactive wizard you type into yourself | Step 10, and only if you want the GitHub board |

**None of these can be skipped or pre-granted by a repository**, and a template
claiming otherwise would be lying to you. The setup agent announces each one
before it appears, which is the only honest option available.

---

## Before you start

You need:

- **Node 22 or newer** — [nodejs.org](https://nodejs.org), take the LTS build.
  Nothing in this repo runs without it, including the preflight — so "the
  preflight will not run" and "Node is missing" are usually the same answer
- **Claude Code** — [claude.com/claude-code](https://claude.com/claude-code)
- **A school account** on Brightspace or Canvas. Both connectors ship; enable
  either or both

You do **not** need Windows, Outlook, Python, Gradescope, a GitHub organisation,
or anything paid beyond a Claude subscription.

### Get your own copy

`gh` has to be logged in first, and **`gh auth login` is an interactive wizard** —
it asks which protocol you want and then shows an eight-character code to paste
into github.com. Run it yourself, in your own terminal:

```
gh auth login
gh repo create my-agenda --template SchoolsInBeirut/fellers-agenda --private --clone
cd my-agenda
claude
```

No `gh`? Click the green **Use this template** button on the repository page →
**Create a new repository** → set visibility to **Private** → then `git clone`
your new repo.

> **Do not fork.** A fork of a public repository cannot be made private, and your
> agenda will hold your courses, your grades and your class schedule.

---

## Step 1 — preflight

```
node scripts/validate-setup.mjs
```

**What should have happened:** a short table with PASS, FAIL, WARN or NOTE
against each check — Node, your operating system, Claude Code, `git`, `gh`
(optional), the repository layout, the demo fixtures, whether `data/` is
writable, whether `config.json` exists yet **and loads with everything its
enabled features need**, whether an LMS source is enabled *and* configured,
`.mcp.json`, and on Windows whether classic Outlook is present.

A NOTE is context, not a problem. `config.json: not created yet` is the correct
state before setup.

**A half-finished `config.json` makes the preflight stricter, on purpose.** Once
the file exists, checks that were advisory become real — that is not a sign
something broke, it is the preflight telling you setup is not finished. Say
`hey` again and the agent resumes where it stopped.

**If Node fails, stop.** Install it and come back. Nothing else can work.

---

## Step 2 — the demo (this is the important one)

```
node scripts/demo.mjs
```

**No accounts. No configuration. No logins. No network.** It renders
`demo-agenda.html` from bundled fictional data at a fixed instant.

Open it:

| | |
|---|---|
| Windows | `start demo-agenda.html` |
| macOS | `open demo-agenda.html` |
| Linux | `xdg-open demo-agenda.html` |

**What should have happened:** a week grid with four courses, class meetings
drawn where the timetable puts them, timed study blocks in the gaps, cards for
each deliverable, a mail panel, a side-project board, and a few things ticked off.

It will say *"live refresh unavailable here"* somewhere. **That is correct** — a
local file has no Drive connector behind it.

The command output may end by suggesting `node src/render.mjs --gaps`. **That
hint is written for a configured repository, and it is not a step here** — there
is nothing to describe in fixture data, and running it before setup finishes only
prints the "timezone is not set yet" message.

Everything you are looking at becomes your real week once your school account is
connected.

> **If this fails, stop and file an issue.** Demo mode is the one thing in this
> repo that must never depend on an account, so a failure here is a bug in the
> template, not a problem with your setup. You have found that out in sixty
> seconds instead of after a login flow, which is exactly why this step is second.

**You can stop here and come back later.** The rest of setup does not expire.

---

## Step 3 — how do you want to be talked to

The agent asks:

> *"Are you comfortable in a terminal, or would you rather I just do everything
> and tell you what happened?"*

There is no wrong answer and "I've never used a terminal" is a completely normal
one. It goes into `CLAUDE.md` Part 2 as **User style**, and every later
conversation — with this agent and every future one — calibrates to it. Say "just
do it" and you will never be shown a command again.

---

## Step 4 — three questions

Each answer is written to `config.json` immediately, so nothing is lost if you
stop halfway.

| | Question | Example | Goes to |
|---|---|---|---|
| **Q2** | What timezone are you in? | `America/New_York` | `timezone` |
| **Q3** | What's the earliest you want anything scheduled? | `10:00` | `wakeTime` |
| **Q4** | What's your school called, and what's the web address you log into for classes? | Example University, `lms.example.edu` | `institution.name`, `institution.lmsHost` |

`wakeTime` is a **hard floor**, not a preference. Nothing will ever be planned
before it, and it also fixes the end of quiet hours — no push notification goes
out between 23:30 and this time, however urgent.

**What Q4 actually does, honestly:** `institution.name` is a **label** — it
appears in prose and reminds you later which school this copy belongs to.
`institution.lmsHost` is a label too, with one real job: if you use Canvas, it is
the fallback for `connectors.lms.canvas.baseUrl` when you leave that key unset.
Nothing else connects to it. Answering Q4 does not, on its own, connect anything
to your school. Step 5 does that.

`config.json` is created by copying `config.example.json`. It is git-ignored.

**The copy carries a placeholder cast** — five invented courses with invented
ids, a matching `difficulty` map and two sample timetable entries. Steps 6 and 7
**replace those blocks wholesale.** If you stop halfway the file will look
complete and will not be, which is why the preflight turns stricter once
`config.json` exists. Nothing is broken; setup is unfinished. Say `hey` again and
the agent resumes at the first unanswered question.

---

## Step 5 — connect your school

Two LMS connectors ship, and **either or both** can be enabled.

| | Brightspace | Canvas |
|---|---|---|
| What you need | A local MCP server plus a browser login | An API token you generate yourself |
| Screens | The trust prompt, then your school's login page and a two-factor push | None |
| Typical time | Minutes, occasionally an hour if the login chain has moved | About two minutes |
| Works in a cloud environment | **No** | **Yes** |

### If you use Canvas — start here

No server, no trust prompt, no login chain.

1. In Canvas: **Account → Settings → Approved Integrations → + New Access
   Token.** Name it something you will recognise, and give it an expiry you will
   remember.
2. Put it in `config.json`:

   ```jsonc
   "canvas": {
     "enabled": true,
     "baseUrl": "https://canvas.example.edu",
     "token": "<the token>",
     "courseFilter": []
   }
   ```

3. That file is git-ignored, so the token never leaves your machine and is never
   committed. **Do not put it in `.mcp.json` or `.env.example`** — both of those
   are committed.

If your institution has **disabled personal access tokens**, there will be no
"New Access Token" button, and any token you do have comes back `401`. That is an
institutional setting and no retry fixes it. `docs/connectors/canvas.md` says
what is left.

Skip ahead to Step 6 — none of the Brightspace screens below apply to you.

### If you use Brightspace — the screens, described before they appear

**Screen 1 — the trust prompt.**

> *"Do you trust the MCP servers in this project?"*

This is Claude Code asking whether this repository may talk to your school. **Say
yes.** It only ever reads.

**It usually fires when the folder is opened, not here.** A project containing a
`.mcp.json` raises it at session start, so you may well have answered it before
you typed `hey`. You cannot skip it and neither can the repository: the approval
is **per-user and per-project**, there is no configuration key that pre-grants
it, and a template that claimed to have one would be lying to you. If you
dismissed it, `claude mcp reset-project-choices` brings it back.

**Screen 2 — your school's login page.**

A browser window opens on your own institution's sign-in page, and your phone
will probably get a two-factor push. **Log in there.** The agent waits and asks
you to say when you are done. **Your password never passes through this
repository.**

### On Windows, one thing happens first

`.mcp.json` ships in the portable form:

```json
{ "command": "npx", "args": ["-y", "brightspace-mcp-server@latest"] }
```

On Windows an stdio `npx` server **must** be wrapped:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "brightspace-mcp-server@latest"] }
```

A bare `npx` entry **fails silently on Windows** — the server never starts,
nothing is raised, and the only symptom is an empty course list. The agent
rewrites this for you, and `validate-setup.mjs` checks for it too.

**Then restart Claude Code.** Claude Code reads `.mcp.json` when a session
starts, so the corrected entry is not live in the session that edited it. Close
it, run `claude` again, and say `continue setup`.

### Then

```
claude mcp list
```

and, if `brightspace` is pending, answer the dialog. Then the auth CLI:

| | |
|---|---|
| macOS / Linux | `npx -y brightspace-mcp-server auth` |
| Windows | `cmd /c npx -y brightspace-mcp-server@latest auth` |

**What should have happened:** the browser reached your school, you logged in,
you approved a push, and the window said you were done. Then `get_my_courses`
returns a list of your enrolments.

### If the login hangs on a fully rendered page

This is the one failure with a real cause and a real fix. The published package
waits for an older single-sign-on form; some institutions now delegate to
Microsoft Entra ID with a second-factor prompt, which it does not drive. It waits
forever on a page that works fine.

**Do not just retry.** `docs/connectors/brightspace.md` has both fixes: install
from upstream `main` (where the fix may already be merged), or apply
`vendor/brightspace-mcp-server/entra-duo-sso.patch`. If you want a diagnostic to
attach to an issue, `node scripts/reauth.mjs --probe` is read-only, opens no
login, and writes `data/auth-probe.json` with no credentials in it.

### If you are running in Cowork or another cloud environment

**A cloud session cannot reach a program on your laptop**, so the Brightspace
path above — a local stdio server — cannot work there at all. Canvas can, because
it needs only a token. If your school runs Brightspace, run setup and the heavy
runs on your own machine; `docs/SCHEDULING.md`'s Cowork section describes the
hybrid where only the light lane runs in the cloud.

### If your school uses something else

`docs/connectors/not-supported.md` is honest about which platforms have no viable
server. You can still stop at demo mode.

---

## Step 6 — your courses

The agent calls `get_my_courses` and shows the list.

**Q5:** *"Which of these should I actually plan work for? (say 'all', or list the
ones to drop)"*

Dropped courses are marked `"skip": true` rather than deleted. A skipped course
stays visible in the scrape but stays out of the calendar, the file downloads and
the error report. That is the right home for a zero-work seminar, or for a shell
course whose content is access-denied by design — those errors are expected and
skipping stops them cluttering every digest.

**Q6:** one message with a table:

> *"How hard is each one, 0-5? 0 means 'never plan time for it'. Here's my guess
> based on the course numbers — correct anything wrong."*

**0 is a veto.** A bucket scored 0 never gets study time, no matter what else is
true about it.

These numbers are a starting point, not the final answer. The study model blends
them with grades, deadlines, backlog and how fast you actually work.

---

## Step 7 — your timetable

**Q7:** *"Paste your class schedule however you have it — a screenshot's text, a
list, anything."*

It gets parsed into `schedule{}`. Then the question that actually changes the
plan:

> *"Which of these do you physically attend?"*

- **You attend it** → the planner will **never** book study time over those hours.
- **You don't attend it** → those hours are treated as **free**, *and* the study
  model **boosts** that course, because self-study is replacing the lecture.

That second effect surprises people. It is deliberate.

**What should have happened:** the demo re-renders with your real timezone and
your real class blocks drawn in. This is the first time you see something of your
own.

---

## Step 8 — your first real run

```
node src/scrape.mjs
node src/render.mjs
```

The scrape takes a few minutes the first time.

**What should have happened:** `agenda.html` opens on your own classes, your own
deadlines, your own week.

**This is the moment the product is delivered.** Everything after this step is
optional and you can stop here with a working thing.

---

## Step 9 — Google Drive, so your phone can read it

### 9.0 — no Google account?

That is a **supported configuration**, not a failure. Set `drive.enabled: false`
in `config.json` and skip to Step 10. `agenda.html` still renders on every run
with your whole week baked into it, and you open it from disk. What you lose is
*live* refresh and the phone write-back, so ticking things off on a phone no
longer reaches the pipeline. `docs/connectors/google-drive.md` has the detail.

### 9.1 — the prerequisite, first

**The Google Drive connector has to exist on your Claude account before any
consent screen can appear.** Open **claude.ai → Settings → Connectors** and add
**Google Drive** if it is not already there. That is on your Claude account, not
in this folder, and nothing in this repository can do it for you.

Skip it and the publish still succeeds — but the page's refresh control says
*"Drive connector not available"*, which is a confusing place to find out.

### 9.2 — the screen, described before it appears

> A **Google consent screen** asks Claude for Drive access.

That is **Google's** screen, not this repository's. The page only ever creates and
reads documents whose titles start with your namespace — `agenda-data`,
`agenda-completions`, `agenda-commands`, `agenda-mirror`. It never touches
anything else in your Drive, and it never deletes anything it did not create.

### 9.3 — publish

Follow [`docs/ARTIFACT.md`](ARTIFACT.md) §2, which has a numbered path for each
client — the agent publishing it for you in Claude Code, or you uploading it
yourself on claude.ai. Either way it ends with an artifact URL, which goes into
`artifact.url` in `config.json`.

**What should have happened:** the published page loads on your phone, and its
refresh control says *"refreshed from Drive"*. If it says anything else,
`docs/ARTIFACT.md` §6 has a row per message.

From then on the page fetches its own data. You never republish it unless the
page template itself changes.

---

## Step 10 — optional extras

Offered one at a time. Say no to any of them and nothing is lost.

| Extra | What it adds | Requires |
|---|---|---|
| **Outlook** | Mail triage, plus deadline events on an Exchange calendar that push to your phone, plus the dead-man's switch | Windows and **classic** Outlook. `docs/connectors/outlook.md` |
| **ICS calendar** | Deadline reminders on any platform: one standard `.ics` file your calendar app subscribes to | Nothing. `docs/connectors/calendar-ics.md`. It does **not** give you the dead-man's switch |
| **Side-project board** | Non-course work becomes visible so it stops losing silently to whatever the LMS is shouting about | A GitHub org, and `gh auth login` — see the warning below. `docs/connectors/github.md` |
| **Scheduling** | It runs by itself, twice a day plus a two-hourly sync | `scripts\install-tasks.cmd` on Windows; `docs/SCHEDULING.md` elsewhere, where the agent writes the files for you |
| **Gradescope** | Submission status from an external grading service | **Off by default.** Read `extras/gradescope/README.md` — including the part about checking your institution's and the service's terms — before enabling it |

### Two of these stop and wait for you to type

An agent cannot answer an interactive prompt from a tool call: it hangs, or the
command reads end-of-file and fails. **These are yours to run, in your own
terminal.**

- **`gh auth login`** (and `gh auth refresh -s repo,read:org` if your
  organisation needs wider scopes). It asks: GitHub.com or an enterprise host;
  HTTPS or SSH; and how to authenticate — choose **Login with a web browser**. It
  then prints an **eight-character code**, opens github.com, and waits for you to
  paste the code and approve. When it says you are logged in, come back; the
  agent verifies with `gh auth status` rather than taking your word for it.
- **`python extras/gradescope/gradescope.py --setup`**, only if you enable that
  extra. It asks for your full Gradescope email and then a **hidden password
  prompt** — the one place in this whole repository a password is stored. Setup
  does not do this for you and should not.

---

## Step 11 — done

`CLAUDE.md` Part 2 gets rewritten with your answers and every `[NOT SET]` it
filled is removed, so the setup agent stops triggering on a greeting:

```
**Configured:** yes, 2026-09-02
**Timezone:** America/New_York
**School:** Example University (lms.example.edu)
**Courses:** PHYS 221, MATH 210, CHEM 115, HIST 140 (SEM 100 skipped)
**User style:** just do it — prefers no commands shown
**Connectors on:** lms.brightspace, drive
```

From here:

| Say | And it |
|---|---|
| `/agenda-now` | Runs the full agenda now |
| `/agenda-doctor` | Runs the preflight and a live health probe of every enabled connector, then says what to fix |
| `/agenda-demo` | Re-renders the demo |
| `/add-source` | Walks you through adding a new data source |
| "how did last week go?" | Runs the weekly review **skill**. It is not a slash command — plain language is the trigger |

You can delete `demo-agenda.html` now.

---

## Starting over

Nothing here is destructive to your school account.

**One command, the same on every operating system:**

```
node scripts/reset.mjs
```

That **lists what it would delete and deletes nothing.** Read the list, and if it
is what you meant:

```
node scripts/reset.mjs --yes
```

It removes `config.json` and empties `data/` (keeping `.gitkeep`). It **never
touches `backups/`** — those local mirrors are the only copy of your state that
survives a reset, which is what makes running one safe. It does not edit
`CLAUDE.md` either; it prints the `[NOT SET]` block for you to paste back into
Part 2. Add `--keep-data` to forget your answers but keep the working directory.

Then `claude mcp reset-project-choices` to re-prompt the trust dialog, and `hey`.

Or just ask: *"reset my setup"* — the agent runs exactly this, and it is the one
route that needs no shell at all.

<details>
<summary>The same thing by hand, if you would rather see every step</summary>

**Windows (PowerShell):**

```powershell
# 1. forget your answers
Remove-Item config.json

# 2. put the [NOT SET] block back so the setup agent triggers again
#    (edit CLAUDE.md Part 2 by hand -- the block is quoted in Step 11 above,
#     with every value replaced by the literal string [NOT SET])

# 3. re-prompt for the MCP trust dialog
claude mcp reset-project-choices

# 4. optional: clear the working directory, keeping the marker file
Get-ChildItem data -Exclude .gitkeep | Remove-Item -Recurse -Force
```

**macOS / Linux:**

```bash
rm config.json
# edit CLAUDE.md Part 2 back to [NOT SET], as above
claude mcp reset-project-choices
find data -mindepth 1 ! -name .gitkeep -delete     # optional
```

</details>

Then `claude`, and `hey`.

**What this does not touch:** your Drive documents (trash them yourself if you
want a truly clean slate), your published Artifact, your calendar events (delete
everything in the agenda category — that category is the ownership marker and the
next run rebuilds what it needs), and your LMS session.

---

## What setup will never do

- Ask for your password. You type it into your school's own page.
- Store a credential inside this repository.
- Skip, suppress or pre-grant a permission dialog. It **pre-announces** them
  instead, which is the only honest option available.
- Commit anything. `data/`, `config.json`, `.env` and `agenda.html` are all
  git-ignored.
- Improvise past a failed login. If something breaks it stops and tells you what
  broke.
