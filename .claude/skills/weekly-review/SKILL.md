---
name: weekly-review
description: Review the past week against what was planned and retune the weights. Use when the
  user asks how last week went, says the plan feels wrong, says a course is getting too much or
  too little time, or asks for a weekly review. Reads the ledgers and the model's own evidence
  strings, then proposes config changes for the user to approve.
---

# Weekly review

A once-a-week conversation: what was planned, what actually happened, and which
one number to change. It is deliberately a **conversation**, not a script. You
gather evidence, you propose, the user decides.

## The one rule

**You never edit `config.json` yourself in this skill.** `difficulty`,
`studyMinutes` and `focus.tuning` are the user's knobs. Propose a change, say
what evidence supports it, and wait for a yes. A planner that quietly retunes
itself is a planner nobody can trust — and if the user cannot predict what the
page will say tomorrow, they stop reading it.

The study model's automatic scoring is a different thing and is not yours to
touch either. It recomputes itself every run and explains every number.

---

## Step 1 — gather, silently

Read these. Do not narrate the reading.

| Source | What you are looking for |
|---|---|
| `data/study-model.json` | The current allocation per bucket (0-5) **and `courses.<bucket>.evidence[]`** — every score explains itself in plain strings. Also the 30-entry history: which way each bucket has been drifting |
| `data/user-completions.json` | What was actually marked done, cancelled, or un-marked, and when |
| `data/study-log.json` | Minutes the user *reported* working. Empty is the normal state and means "no evidence", never "no effort" |
| `data/focus-plan.json` | What the planner shipped for the last seven days |
| `data/block-edits.json` | `edits[]` = blocks the user moved. `history[]` = the learning corpus. **This is the highest-signal file in the repo** |
| `data/latest.json` | Open backlog per course, and what is coming in the next two weeks |
| `data/runlog.txt` | Which runs happened, which skipped, and any `STALE ` lines |

Then run, and read the output rather than re-deriving it:

```
node src/behind.mjs --check
node src/completion.mjs --list
```

## Step 2 — compare plan against reality, per bucket

For each course and bucket, work out three numbers and one judgement:

1. **Planned minutes** last week, from `focus-plan.json`.
2. **Marked-done work** in that window, from `user-completions.json`.
3. **Reported minutes**, from `study-log.json` — if there are any. Absent is not
   zero.
4. **Did the user move its blocks?** A course whose blocks get dragged later
   every single time is telling you something the model cannot see.

Then bucket each course into one of four states:

- **Under-served** — backlog grew, deadlines got close, planned minutes were
  low. The allocation is too low, or the difficulty prior is.
- **Over-served** — planned generously, finished early, blocks went unused or
  got dragged away. The allocation is too high.
- **Mis-timed** — the right amount of time in the wrong hours. **This is not a
  weights problem.** The fix is `studyMinutes.weekdayWindow` /
  `weekendWindow`, or simply letting the block-edit learning keep doing its job.
- **Fine.** Say nothing about it. Most courses will be here most weeks.

## Step 3 — read the drags, and do not overreact to them

`block-edits.json` `history[]` is the most honest record in the repo: it is what
the user did with their hands, not what they said.

The engine already learns from it — after the **same** course has been edited
twice, clamped hard. So a pattern you can see may already be being corrected. Say
so rather than proposing a change on top of a correction that is already
happening.

What is worth raising:

- A course dragged later, consistently, more than four times → the window is
  wrong for their life, not for that course.
- Blocks routinely made **shorter** → the daily budget is too high, or blocks are
  too long. Look at `focus.tuning.maxBlockMinutes` before touching `difficulty`.
- Blocks routinely made **longer** → the opposite, and it is a happier problem.
- A pinned block that keeps getting re-pinned to the same slot week after week →
  that is a standing commitment the timetable does not know about. The real fix
  is a `schedule{}` entry, not a weight.

**Never propose moving a pinned block back to where the engine wanted it.** The
whole point of that file is that the user's hand beats the packer's arithmetic.

## Step 4 — propose exactly one change

One. Not a list.

The user came for a week's worth of judgement, not a tuning session, and a single
change is the only kind whose effect you can actually observe next week. Say:

- **What to change** — the exact key and the exact new value.
- **Why** — one sentence, naming the evidence, ideally quoting the model's own
  `evidence[]` string.
- **What will visibly happen** — "PHYS 221 gets roughly 45 more minutes a week,
  mostly on Tuesday and Thursday."
- **How to undo it** — the old value, so reverting is trivial.

Then ask. If they say yes, make the edit, re-run:

```
node src/study-model.mjs --refresh
node src/render.mjs
```

and show them the new week.

If they say no, drop it entirely. Do not re-propose it next week unless the
evidence got stronger.

## Step 5 — the honest close

Say one true sentence about the week. If it was a good week, say that and stop.
If a deadline was missed, say which one and do not soften it — but use the
tri-state rule: an item at `submitted: null` that is past due is *"past due —
check whether it's still open"*, never *"you missed it"*.

If nothing needs changing, the correct output of this whole skill is:

> "Last week looks fine. Nothing worth changing."

That is a success, not a wasted run.

---

## Things to watch for

- **An empty study log is normal.** Most people never use `--log`. It means "no
  evidence", and the model treats it that way. Do not read it as laziness and do
  not nag about filling it in.
- **A bucket at 0 is a veto, and it is deliberate.** `difficulty` 0 means "never
  plan time for this" — that is what the zero-work seminar is for. Never propose
  raising a 0 unless the user asks.
- **Never invent a study-log entry.** Do not infer minutes from focus blocks
  (those are a plan, not a fact), from calendar events, or from something
  becoming submitted.
- **Two `STALE ` lines for one lane in one day** is not a planning problem. It
  means runs are failing before they reach their log step. Point at
  `docs/design-notes/watchdogs.md` and `/agenda-doctor`, and do not try to fix it
  from here.
