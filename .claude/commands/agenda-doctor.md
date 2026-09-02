---
description: Check everything — prerequisites, configuration, and every enabled connector's health
allowed-tools: Bash, Read, Glob, Grep
---

Diagnose this installation. Run the checks below in order, collect every result,
and then report **once**, as a short table. Do not fix anything without asking.

## 1. Preflight

```
node scripts/validate-setup.mjs
```

Node ≥22, `git`, `gh` (optional), `claude`, write access to `data/`, whether
`config.json` exists, the OS, and — Windows only — classic Outlook. It prints a
fix link for every failure and never throws.

## 2. Configuration

Read `config.json`. Report:

- Any `[NOT SET]` value that belongs to an **enabled** feature. That is a real
  problem and the message tells them exactly which key.
- Any `[NOT SET]` that belongs to a **disabled** feature. That is fine and must
  never be reported as a fault — say nothing about it.
- Whether `timezone` is a real IANA name.
- Whether every course in `schedule{}` also appears in `courses[]`.
- Whether `difficulty` covers every non-skipped course.
- Whether `artifact.url` is filled (if not, the page has not been published yet
  — that is a step, not a bug).
- **Whether setup simply has not finished.** If `CLAUDE.md` Part 2 still has
  `[NOT SET]` fields, or `courses[]` still holds the placeholder cast from
  `config.example.json` (`PHYS 221` / `MATH 210` / `CHEM 115` / `HIST 140` /
  `SEM 100` with ids in the 110000s), then **lead with that** and stop
  cataloguing downstream failures. They are all the same failure. The fix is one
  sentence: say `hey`, and the setup agent resumes from the first unanswered
  question.

## 3. Per-connector health

```
node scripts/health-check.mjs
```

This asks every **enabled** connector's `healthCheck()` whether its backend
actually answers, and prints `ok`, the detail string, and a `fix` string per
failure. It **writes nothing** — no calendar event, no file, no scrape — and each
probe is given 45 seconds before it is reported as hung. Exit 0 = everyone
answered, or nothing is enabled yet; exit 1 = at least one could not, with the
reasons printed. `--json` gives you the machine-readable form.

It needs the network and the user's own credentials, which is exactly why it is
a separate command from the preflight rather than folded into it. **Do not
hand-build a connector context in an ad-hoc `node -e`** — that is the thing this
script exists to replace.

Then report **two more things you can establish without any call at all:**

1. **Is it configured?** Every key its own docs list as required has a real
   value — not `[NOT SET]`, not the placeholder from `config.example.json`.
   `connectors.lms.canvas` needs `baseUrl` and `token`;
   `connectors.board.github` needs `sideProject.org`; and so on.
2. **Can it run here?** Read `meta.requires` from the module in
   `src/connectors/` and check each part against this machine — the operating
   system, the executables on `PATH`, the `.mcp.json` keys. An enabled connector
   that cannot run here is **not an error**: it produces one `errors[]` line and
   is otherwise a no-op. Say that plainly rather than alarming.

**A probe is not a sweep.** `healthCheck()` proves a session is alive; it does
not prove a full scrape would succeed, and it does not try to. If every probe is
green and the user still suspects a connector, the next step is
`node src/scrape.mjs`, which reaches the real service for real data.

**The one hard requirement:** at least one connector of kind `lms` must be
enabled **and configured**. If none is, `node scripts/validate-setup.mjs` fails
on it in step 1 and `node src/scrape.mjs` exits 1 with, verbatim:

```
scrape: no LMS source is enabled.
```

followed by a four-line fix. That is the first thing to fix.

## 4. MCP servers

```
claude mcp list
```

Report any server that is pending approval. **A repository cannot pre-grant that
approval** — it is per-user and per-project. If one is pending, tell them the
dialog is waiting and what it is for. `claude mcp reset-project-choices`
re-prompts if they dismissed it.

On Windows, check `.mcp.json`: an stdio `npx` entry must be wrapped as
`"command": "cmd", "args": ["/c", "npx", "-y", "<pkg>"]`. A bare `npx` entry
fails silently on Windows and is the most common cross-platform break. Flag it.

## 5. Recent runs

Read the last few lines of `data/runlog.txt` if it exists. Report:

- When the last heavy run and the last light run were.
- Any `FAILED(...)` or `SKIPPED(...)` token that appears in more than one of the
  last five runs — a token that repeats is a real problem; a token that appeared
  once is usually weather.
- Any `STALE ` lines from today. Those are the watchdog rescuing a missed run,
  and **two of them for one lane in one day means something is failing before
  the run reaches its log step** and needs a human.

## 6. Scheduling (only if they set it up)

Windows: report whether the four tasks exist and when each last ran and next
runs. Do not create, change, run or delete a task from this command — say what
is wrong and let them run `scripts\install-tasks.cmd`, which is idempotent.

macOS/Linux: check for the `launchd` plist or the `cron` entries described in
`docs/SCHEDULING.md`.

## Report

One table: **check · result · what to do**. Lead with anything actually broken.
For every failure give exactly one next action and a link into
`docs/TROUBLESHOOTING.md`.

If everything passes, say so in one line and stop. Do not pad a clean bill of
health.
