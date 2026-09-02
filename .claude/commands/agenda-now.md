---
description: Run one full agenda run right now — scrape, plan, render, publish
argument-hint: "[light]"
allowed-tools: Task, Bash, PowerShell, Read, Write, Edit, Glob, Grep, ToolSearch, mcp__brightspace__*, mcp__outlook__*, mcp__claude_ai_Google_Drive__*, mcp__claude_ai_Gmail__*
---

Run the agenda now.

**`Task` is here because this command delegates**, and the rest of the list
mirrors `.claude/agents/agenda-runner.md` and `scripts/run-heavy.cmd`. A run
started this way must be able to do everything a 07:03 scheduled run does —
including the Drive upload. If it cannot, the page silently stops updating and
nothing says why.

**First, check setup.** If `CLAUDE.md` Part 2 still contains `[NOT SET]`, stop
and say: *"Setup hasn't run yet — say `hey` and I'll do it. It takes about ten
minutes and the first five need no accounts."* Do not attempt a run against an
unconfigured repo; it will fail in a confusing place.

**Then delegate to the `agenda-runner` agent**, with the runbook chosen like
this:

- `$ARGUMENTS` contains `light` → `runbooks/sync-run.md` (about two minutes; no
  scrape; picks up marks and commands from the page, re-renders, re-publishes)
- otherwise → `runbooks/heavy-run.md` (the full run: scrape, materials, mail,
  board, descriptions, study model, behind check, render, Drive, mirror,
  calendar, digest)

A heavy run takes several minutes, most of it in the scrape. Say so **before**
starting it, and run the long steps in the background rather than leaving the
user watching a frozen prompt.

## While it runs

Report progress in plain English at each major step, not as raw status tokens.
"Scraped 31 items across four courses" beats `items=31`.

## When it finishes

Report, in this order and no more than about six lines:

1. What changed since the last run — new items, moved deadlines, anything that
   flipped to done.
2. What today looks like — the focus blocks, in local time.
3. The behind verdict, using the summary strings the check produced, **as
   written**. They are phrased for a human and they respect the tri-state rule.
   `clear` means say nothing at all about it.
4. Anything that skipped or failed, once, with the token.
5. Whether the page was republished, and the upload size line
   (`upload: 6,712 chars (budget 12,000, tier 1)`).

Never call a cancelled item done. Never describe a finished study session as a
finished assignment. If a run applied one of the user's block edits, say so once
in their terms and in local time — "MATH 210 is where you put it tonight,
8:15-9:45" — and do not repeat it on later runs.

If the run stopped early, say which step, what the token was, and the single
next thing to try. Do not attempt a second full run on your own.
