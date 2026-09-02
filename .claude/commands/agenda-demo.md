---
description: Render a complete demo agenda from bundled sample data — no accounts, no config
argument-hint: "[--open]"
allowed-tools: Bash, Read
---

Render the demo agenda and tell the user how to look at it.

```
node scripts/demo.mjs
```

This reads `fixtures/demo/` — a fictional four-course term with study blocks,
mail, a side-project board, a standards card and a few done and cancelled marks
— and writes `demo-agenda.html` at a **fixed instant**, so the output is
byte-reproducible and can be diffed.

It requires **no `config.json`, no MCP approval and no accounts of any kind.**
It writes nothing into `data/` and does not read `config.json`. If it fails,
that is a real bug in this repo, not a configuration problem on the user's
machine — report the exact error rather than suggesting they set something up.

Then tell them to open `demo-agenda.html`:

- Windows: `start demo-agenda.html`, or double-click it in the folder
- macOS: `open demo-agenda.html`
- Linux: `xdg-open demo-agenda.html`

If `$ARGUMENTS` contains `--open`, open it for them with the right command for
their platform instead of telling them how.

**Do not follow the command's own closing hint.** The output may end by
suggesting `node src/render.mjs --gaps`; that line is written for a configured
repository, and here it only prints "timezone is not set yet". There is nothing
to describe in fixture data. Do not run it and do not pass it on.

Say what they are looking at, in one short paragraph: four courses across a week
grid, class meetings drawn where the timetable puts them, timed study blocks
packed into the gaps, cards for each deliverable, a mail panel and a
side-project board. Point out that the page will say *"live refresh unavailable
here"* rather than erroring — that is correct, because a local file has no Drive
connector behind it.

Finish by saying the one thing they can do next. If `CLAUDE.md` Part 2 still
contains `[NOT SET]`, that next thing is: *"say `hey` and I'll connect your real
classes."*
