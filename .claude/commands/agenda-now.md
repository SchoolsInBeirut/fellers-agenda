---
description: Run one full agenda run right now — scrape, plan, render, publish
allowed-tools: Task, Bash, Read, Write, PushNotification
---

Run the agenda now.

**`Task` is here because this command delegates**, and the rest of the list
mirrors `.claude/agents/agenda-runner.md` and the model window that
`scripts/run-daily.mjs` starts. A run started this way must do exactly what the
10:30 scheduled run does. **There are deliberately no connector tools**: the
scrape, the Drive publish and everything else mechanical happen inside scripts,
not through tool calls. `docs/design-notes/daily-run.md` says why.

**First, check setup.** If `CLAUDE.md` Part 2 still contains `[NOT SET]`, stop
and say: *"Setup hasn't run yet — say `hey` and I'll do it. It takes about ten
minutes and the first five need no accounts."* Do not attempt a run against an
unconfigured repo; it will fail in a confusing place.

**If the user passed `light`**, say so plainly and continue with the full run:
*"There is no light run any more — 2.0.0 has one daily run that does everything.
Running that."* The old two-hourly sync lane is retired; `docs/SCHEDULING.md`
explains what replaced it.

**Then delegate to the `agenda-runner` agent**, which:

1. runs `node src/pipeline.mjs --phase 1` — scrape, materials, mail, board, the
   Drive pull of your marks and commands, the inbound calendar, the study model,
   the behind check, and the work order
2. follows `runbooks/daily-agent.md` — mail triage, descriptions, the digest,
   and then `--phase 2` (render, publish, mirror, calendar, deadman) and
   `--finish`

Phase 1 takes several minutes, most of it in the scrape. Say so **before**
starting it, and run the long steps in the background rather than leaving the
user watching a frozen prompt.

**Two things worth offering instead, when they fit what was asked:**

- `node scripts/run-daily.mjs --no-llm` — everything except the judgement work.
  Right when somebody is debugging a connector and does not need descriptions.
- `node scripts/run-daily.mjs --dry-run` — prints what a scheduled run would do
  and does none of it.

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
