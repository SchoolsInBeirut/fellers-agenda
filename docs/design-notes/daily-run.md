# Design note: one run a day, and why the model stopped carrying the bytes

*This rule exists because of a bill. Version 1.x ran a language model ten times a
day and spent most of that model on work a script does for free. 2.0.0 runs it
once, for eight to thirteen turns, and the page keeps updating even when the
model is unavailable.*

---

## What happened

The author's own installation ran the 1.x lanes for a fortnight: two heavy runs a
day and a light sync run every two hours, every session on the largest model at
the highest reasoning effort. 115 headless transcripts, deduplicated by message
id, say this:

| | heavy run (2/day) | light sync run (8/day) |
|---|---|---|
| Output tokens per run | 47k | 58k |
| **of which the model re-typing bytes** | **24k** | **52k** |
| Cache-read tokens per run | 2.9M | 1.5M |
| Wall time | 18–50 min | 14–36 min |

About **560,000 output tokens and 18 million cache-read tokens a day**. The
weekly usage limit tripped, and the agenda went dark for 35 hours — which, per
`docs/design-notes/watchdogs.md`, is the one failure mode that looks exactly like
"nothing is due".

**84% of that output was the model acting as a copy machine.** Three things, over
and over:

- `create_file` with a 19,000-character base64 payload in the argument. Base64
  costs roughly one token per character, so that is 19k output tokens to move a
  file the machine already had on disk.
- reading the new document back to verify it — the same bytes again, inbound.
- a 15,000-character dump from a calendar connector that returned **zero events**
  on every single run.

The scrape was never the expensive part. The scrape is a deterministic script and
the model never reads its output.

---

## The shape now

One scheduled task, `<prefix> Daily`, at `scheduler.dailyAt` (10:30 by default).
It runs `scripts/run-daily.mjs`, which does five things in order:

| # | Step | Who does it |
|---|---|---|
| 1 | `node src/pipeline.mjs --phase 1` | a script — scrape, mail, board, materials, the Drive pull of completions and commands, the inbound calendar, the study model, the gaps list, the behind verdict, and the **work order** |
| 2 | the model window | `claude -p "Read runbooks/daily-agent.md and follow it exactly."` |
| 3 | `node src/pipeline.mjs --phase 2` | a script — render, publish to Drive, mirror, calendar sink, digest, dead-man's switch, report |
| 4 | `node src/pipeline.mjs --finish` | a script — the one line in `data/runlog.txt` |
| 5 | `node src/pipeline.mjs --usage` | a script — the token ledger |

The model reads **one file**, `data/work-order.json`, which phase 1 built for it:
roughly ten kilobytes of exactly the questions a script cannot answer. It writes
its answers as small files — `data/tmp/triage.json`, `data/tmp/descriptions.json`,
`data/digest.md`, `data/llm-notes.json` — hands each to a validating CLI
(`mail-triage.mjs --apply`, `describe.mjs --apply`), runs phase 2 itself, checks
the report, and stops.

**Steps 3 and 4 are idempotent.** In a healthy run the model has already run
them, and the launcher's own calls print `already-done`. That redundancy is the
point: if `claude` is missing, exits non-zero, or times out, the launcher
finishes the run without it, the page still updates, and the run log carries
`llm=absent`. A model outage is no longer an agenda outage.

**Phase 1 is a hard dependency and phase 2 is not.** A run whose phase 1 never
happened exits 4 and publishes nothing, because publishing a render of stale
inputs is the failure this repository spends the most effort avoiding.

---

## Why rclone instead of the model

The 1.x transport had no upload API on the path it could reach, so the model
*was* the transport — it typed the payload into a `create_file` argument. That is
where 24k of a heavy run's 47k output tokens went, and it is why
`docs/PROTOCOL.md` spends a section on compression.

`rclone` is a command-line program that talks to Google Drive directly.
`src/drive-rclone.mjs` shells out to it, so the bytes go from a local file to a
Google Doc without passing through a context window at all. What that bought:

- **The payload costs zero tokens.** It is a file path in a command, not content
  in a message.
- **Update in place.** rclone's `copyto` replaces the body of the *same*
  document, keeping its id. The page finds it exactly as before — search by
  title, newest `modifiedTime`, read the body — so nothing on the page changed.
  The old create-then-trash dance is gone, and with it the duplicate documents it
  left behind whenever a run died between the two halves.
- **Verification by read-back, without the read costing anything.** Every publish
  exports the document again and compares the envelope to the local file. A
  payload that fails that check is re-uploaded from `data/payload.last-good.txt`,
  so a torn publish self-heals rather than leaving the page reading half a week.
  When even that re-upload fails, the run log says `verify;restore-failed` rather
  than `verify;restored-last-good` — a repair that did not happen is not a repair
  the log may claim.
- **The write-back buses became moves, not deletions.** A consumed completions or
  commands document is *moved* into a `<ns>-consumed` folder and purged after
  seven days. If a run consumes a mark it should not have, the evidence is still
  there for a week.

The cost is one more thing to install, one browser consent click, and the caveat
below. `docs/connectors/google-drive.md` has the setup.

---

## Why the model gets four tools and no connectors

The model window is launched with exactly this tool set:

```
--tools "Bash,Read,Write,PushNotification" --allowedTools "Bash,Read,Write,PushNotification"
--strict-mcp-config --setting-sources project
```

- **`--tools` limits, `--allowedTools` grants.** Both are needed: without the
  second, every `Write` is denied and the run produces nothing.
- **`--strict-mcp-config` with no `--mcp-config` loads zero MCP servers.** No LMS
  server, no Drive connector, no calendar connector. The model therefore *cannot*
  scrape, authenticate, or touch Drive — those are properties of the launch, not
  promises in a runbook.
- **`--setting-sources project`** skips user-level rules, hooks and skills, so a
  scheduled run behaves the same on every machine.

The measured effect is larger than it looks. A headless session with every
connector loaded starts at roughly **37,000–40,000 tokens of context floor**
before it has read anything, because every connector's tool schema is loaded into
the window. With four built-in tools the floor is about **17,000**. That is paid
on every turn, so it is the single biggest lever in the whole design — and the
connector schemas were buying nothing, because phase 1 had already done the
fetching.

The rule that falls out: **a job that needs a connector is an interactive job.**
It is not a thing to widen a scheduled run for.

---

## The token ledger

Every run appends one record to `data/llm-usage.jsonl` — turns, output tokens,
cache reads, cost. It is the only honest answer to "is this getting expensive
again", and it is worth a look once a week.

The author's first live run of this design: **13 turns, 7,567 output tokens, 550k
cache-read, about $0.30.** For comparison, the same day's work under 1.x cost
roughly 560k output tokens.

| What you see | What it means |
|---|---|
| under ~10k output tokens, 8–13 turns | normal |
| **over 15k output tokens, or over 20 turns** | **a run to look at** |
| `llm=absent(...)` in the run log | the model never ran; the page updated anyway |

**A run that hits its caps is a run to investigate, not a cap to raise.**
`llm.maxTurns` (20) and `llm.maxBudgetUsd` (1) are hard stops, and hitting one
almost always means the model is looping on something a script should be doing —
which is the exact failure this rewrite exists to fix. Look at
`data/runlog-stdout.txt` for that run before touching either number.

The other lever is `drive.maxEmitChars`, and it is now much less interesting than
it used to be: the payload no longer passes through the model, so its size costs
storage and render time rather than tokens. See `docs/PROTOCOL.md`.

---

## The caveat you will eventually hit

rclone ships with a **shared Google client id**, and Google is retiring it during
2026. rclone already prints a notice about this on every call, which
`src/drive-rclone.mjs` filters out of its error reporting so that a routine
notice never becomes a fake failure reason.

When that day comes, publishes start failing with **authentication** errors
rather than with anything that mentions the notice. The fix is to make your own
client id — the procedure is on rclone's own site,
[rclone.org/drive](https://rclone.org/drive/#making-your-own-client-id) — and
then, once:

```
rclone config update <remote> client_id=<yours> client_secret=<yours>
node src/drive-rclone.mjs status
```

One more Allow click in a browser and it is done. Nothing in this repository
changes.

This is written down here rather than discovered later because a transport that
stops working on a date nobody remembers is exactly the kind of rot the
"Last verified working" line in the README exists to admit to.

---

## Related

- `runbooks/daily-agent.md` — what the model actually does, in order
- `runbooks/legacy/heavy-run.md` — the retired twice-daily runbook, kept because
  the triage, description and standards-plan rules were reasoned out there
- `docs/SCHEDULING.md` — the three tasks, the two plists, the two cron lines
- `docs/connectors/google-drive.md` — the transport, its setup, and the buses
- `docs/design-notes/watchdogs.md` — why silence is the failure mode that needs
  three independent alarms
