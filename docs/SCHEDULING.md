# Scheduling: making it run by itself

An agenda you have to remember to run is a to-do list with extra steps. This page
sets up the **one daily run** — and the two watchdogs that notice when it did not
happen, or could not log in — so it runs without you.

**You can skip this entirely.** `/agenda-now` on demand works perfectly well, and
plenty of people run it that way for a term before automating anything.

---

## The three tasks

| Task | What it runs | When |
|---|---|---|
| `<prefix> Daily` | `scripts\run-daily.cmd` | Daily at `scheduler.dailyAt` (10:30) |
| `<prefix> StaleCheck` | `src/stale-check.mjs` | Logon, unlock, resume, and every 30 min |
| `<prefix> AuthRetry` | `src/auth-retry.mjs` | Logon, unlock, resume, and every hour |

`<prefix>` is `config.json` → `scheduler.taskPrefix`, default `Agenda`.

**One run a day is the whole schedule.** Version 1.x had five tasks — a morning
and an evening heavy run plus a two-hourly sync — and it cost about 560,000 model
output tokens a day, most of it spent re-typing bytes a script can move for free.
`docs/design-notes/daily-run.md` has the measurements and the argument. If you
upgraded from 1.x, the old `<prefix> Morning`, `<prefix> Evening` and
`<prefix> Sync` tasks are still registered until you remove them; see
["Removing the 1.x tasks"](#removing-the-1x-tasks) below.

**The last two are watchdogs, and they ask different questions.** StaleCheck asks
*"was the run supposed to have happened by now?"*. AuthRetry asks *"can we still
log in?"*. A run that fires on time, scrapes, hits an expired session and exits 2
*has happened* — so StaleCheck is right to stay silent, and no amount of tuning it
would catch that. AuthRetry is the lane that does.

AuthRetry is free on a healthy machine: it fires a login only when there is no
session file at all, or when the session is unusable **and** the last thing that
happened was a failure. An expired session with nothing outstanding is the
pipeline's normal resting state between runs, and it is left alone. See
`docs/design-notes/auth-hardening.md` for the whole decision table.

### What the daily task actually starts

`scripts\run-daily.cmd` is a three-line wrapper. It `cd`s to the repository and
runs `node scripts/run-daily.mjs`, which does five things in order:

```
node src/pipeline.mjs --phase 1     scrape, mail, board, materials, Drive pull,
                                    calendar, study model, behind, work order
claude -p "Read runbooks/daily-agent.md and follow it exactly."   the model window
node src/pipeline.mjs --phase 2     render, publish, mirror, calendar, digest, deadman
node src/pipeline.mjs --finish      the run log line
node src/pipeline.mjs --usage       the token ledger
```

Three things are worth knowing before you schedule it:

- **It is Node, not an agent session.** The launcher starts `claude` itself, for
  one window, with four tools and no connectors. Nothing in a plist or a crontab
  line needs an `--allowedTools` list any more.
- **A missing or failing model is not a failed run.** If `claude` is not
  installed, exits non-zero, or runs past `llm.timeoutMinutes`, the launcher
  completes the run without it: the page still updates and the run log says
  `llm=absent(<reason>)`.
- **Open the folder in Claude Code once, interactively.** A checkout that has
  never been trusted makes headless `claude` print `Ignoring N permissions.allow
  entries ... workspace has not been trusted` into `data/runlog-stdout.txt`. The
  run still works - the launcher grants its four tools directly - but accepting
  the trust dialog once is what makes that line go away.

See it without running anything:

```
node scripts/run-daily.mjs --dry-run
```

which prints the five commands — including the fully quoted `claude` line — and
runs none of them.

---

## Windows

```
scripts\install-tasks.cmd
```

`npm run setup` offers to run exactly this for you, as its last step, after
listing the three tasks and telling you no administrator rights are needed.
Either way it is the same installer, and running it twice is harmless. It:

- reads `scheduler` from `config.json` (falling back to the shipped defaults)
- **verifies every target file exists before registering anything** — `schtasks`
  does not do this, which is why a task can look installed for a month while
  executing nothing
- registers all three with the right triggers and settings
- prints what it did and what is now scheduled
- **never runs a task**, and never deletes one you did not ask it to replace

It is **idempotent.** Run it twice, run it ten times, the end state is identical.
Run it again after you move the repository, after a Windows feature update, or
any time `/agenda-doctor` says a task looks wrong.

**No administrator rights are needed.** Every task runs as your user with an
interactive token and least privilege. Nothing is written to machine-wide
registry keys and no password is stored.

### Removing the 1.x tasks

If `<prefix> Morning`, `<prefix> Evening` or `<prefix> Sync` still exist from a
1.x install, the installer **prints one notice per task it finds and leaves them
alone.** They point at launchers that no longer exist, so they fail harmlessly —
but they are noise in the Task Scheduler and they will keep waking your machine.

To delete them:

```
scripts\install-tasks.cmd /remove-legacy
```

The installer never deletes a task it was not explicitly asked to delete. That is
why the flag exists rather than it simply tidying up: a task you did not create
may not be one this repository should remove.

### To change the times

Edit `scheduler` in `config.json`, then re-run the installer. **Do not edit a
task by hand in the Task Scheduler UI** — the next run of the installer asserts
your config back over it, and then you have two sources of truth that disagree.

### Settings the installer sets, and why

| Setting | Daily | StaleCheck | AuthRetry |
|---|---|---|---|
| Start when available | **yes** | yes | yes |
| Wake the computer | **yes** | **no** | **no** |
| Time limit | 2 h | 5 min | 15 min |
| Restart on failure | 3× / 10 min | no | no |
| Multiple instances | ignore new | ignore new | ignore new |
| Run on battery | yes | yes | yes |
| Repeats | — | every 30 min from 00:05 | every hour from 00:04 |

- **Start when available** is the important one. Without it, a run missed because
  the laptop was closed is simply *lost*, with no digest that day and nothing to
  show why.
- **Wake the computer** is true for the daily run and false for the watchdogs.
  There is one run a day now, so missing it means missing the day; waking a
  machine to ask "did anything get missed" is the exact opposite of what a
  watchdog is for.
- **Two hours** rather than the default, because a wedged run must not hold the
  slot for days while "ignore new" silently drops every run behind it. The run
  itself has an inner cap: the model window stops at `llm.timeoutMinutes`
  (45 by default) and the launcher carries on without it.
- **Restart 3× / 10 min** on the daily run, because there is no second chance
  later in the day. Phase 1 is the expensive part and it is skipped as
  `already-done` when it already succeeded within six hours, so a restart is
  cheap.
- **AuthRetry never wakes the machine, and that is the point.** Its login can
  raise a two-factor prompt, and firing one at a sleeping user's phone is the
  failure it exists to prevent, not a feature. The logon/unlock/resume triggers
  cover the lid opening in the morning, which is when the prompt can actually be
  answered.
- **AuthRetry ticks at :04, not :05,** so the two watchdogs do not fire in
  lockstep on the same waking second.
- **Fifteen minutes for AuthRetry** rather than the watchdog's five: on the rare
  tick where it fires it is waiting on a real login. `src/auth-retry.mjs` caps its
  own child at seven minutes, so the task limit is only the outer wall.

### Seeing why a task did not fire

The Task Scheduler operational log is off by default on Windows Home. With it
off there is no record of *why* a task did not fire — only that it did not, which
is exactly the evidence you need. Turn it on once, in an elevated terminal:

```
wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true
```

It is a bounded ring buffer, so it cannot grow without limit.

---

## macOS

**There is no installer here — `npm run setup` writes these files for you.** Its
last step prints both plists with **your** clone's absolute path already
substituted for the `$HOME/my-agenda` placeholder, and offers to write them into
`~/Library/LaunchAgents/` and `launchctl load` each one. Say no and it prints the
`launchctl` commands instead.

You can also ask the agent — say *"set up scheduling"* in Claude Code — or do it
by hand from what follows. All three routes produce the same files, and the
substituted path is the point: a `launchd` job with a wrong `cd` fails silently
and looks perfectly installed.

Two `launchd` agents. The first is
`~/Library/LaunchAgents/com.agenda.daily.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agenda.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd "$HOME/my-agenda" &amp;&amp; node scripts/run-daily.mjs &gt;&gt; data/runlog-stdout.txt 2&gt;&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

**`$HOME/my-agenda` is a placeholder** — replace it with the absolute path of
your own clone, in both plists. A `launchd` job with a wrong `cd` fails silently
and looks perfectly installed. The hour and minute come from
`scheduler.dailyAt`; change one, change both.

**There is no `--allowedTools` list here any more.** The launcher is a plain Node
script and it starts the model window itself, with the tool list from
`docs/design-notes/daily-run.md`. If you are reading this after upgrading from
1.x, that long allow-list is not missing — it moved into `scripts/run-daily.mjs`,
where it can be unit-tested.

The second is `~/Library/LaunchAgents/com.agenda.auth.plist` — the auth lane.
It runs a plain Node script too, and it needs no Claude session at all:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agenda.auth</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd "$HOME/my-agenda" &amp;&amp; node src/auth-retry.mjs</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

`RunAtLoad` is **true** here and false on the daily one: this lane is nearly
always a silent no-op, and the moment you most want it to check is the moment you
log back in. The same absolute-`cd` warning applies verbatim.

**There is no `WakeToRun` equivalent to worry about, and that is the behaviour we
want.** `launchd` will not wake a sleeping Mac for a `StartInterval` job — so it
cannot fire a two-factor prompt at a phone nobody is holding. It *does* run a
missed `StartCalendarInterval` job when the Mac wakes, so the "laptop opened at
noon" case is covered without any extra triggers, and that matters more now that
there is only one run to miss.

Then load both and check:

```
launchctl load ~/Library/LaunchAgents/com.agenda.daily.plist
launchctl load ~/Library/LaunchAgents/com.agenda.auth.plist
launchctl list | grep com.agenda
```

If you are upgrading, unload the 1.x agents first — they point at runbooks
nothing reads any more:

```
launchctl unload ~/Library/LaunchAgents/com.agenda.heavy.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.agenda.sync.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.agenda.heavy.plist ~/Library/LaunchAgents/com.agenda.sync.plist
```

**`launchd` runs a missed job when the Mac wakes**, which covers most of what the
Windows stale-run watchdog does. It does **not** cover a Mac that stays awake
through the boundary while something else fails — and on macOS **there is no
dead-man's switch to fall back on**, because that watchdog needs the Windows
Outlook sink. Read `data/runlog.txt` occasionally; it is the backstop you have.

**The Windows-only connectors stay off.** Mail, the Exchange calendar sink and
the email digest need a local desktop program that does not exist here. For
deadline reminders, enable `connectors.calendar.ics` and subscribe your calendar
app to the file — `docs/connectors/calendar-ics.md` has the click-path for Google
Calendar and Apple Calendar.

---

## Linux

**`npm run setup` prints this block for you**, with `AGENDA=` already set to this
clone's absolute path and the time taken from your `scheduler` config. Paste it
into `crontab -e`. (It prints rather than installs: a crontab is a single
per-user file that may already hold other people's jobs, and appending to it
behind your back is not a thing a setup script should do.)

You can also ask the agent — say *"set up scheduling"* — or write it by hand from
what follows.

`cron` with an explicit `PATH`, because cron's environment is nearly empty and
`node` and `claude` will not be found otherwise:

```cron
PATH=/usr/local/bin:/usr/bin:/bin:/home/you/.local/bin
AGENDA="/home/you/my-agenda"

30 10 * * * cd "$AGENDA" && node scripts/run-daily.mjs >> data/runlog-stdout.txt 2>&1
4  *  * * * cd "$AGENDA" && node src/auth-retry.mjs >> data/runlog-stdout.txt 2>&1
```

Two lines. `AGENDA` is filled in for you by `npm run setup`; `PATH` is still a
placeholder — widen it if your `node` or `claude` lives somewhere else, such as
`~/.local/bin`. Install it with `crontab -e`, and check it took with `crontab -l`.
If you are upgrading from 1.x, delete the three old `claude -p "Read
runbooks/..."` lines while you are in there.

**Both quotes matter.** cron word-splits an unquoted assignment, so a clone in
`~/my agenda` becomes `AGENDA=/home/you/my` with a stray `agenda`, `cd` then
fails on a path that does not exist, and `&&` swallows the rest of the line. The
crontab looks perfectly installed and no digest ever arrives. If you write these
lines by hand, keep `AGENDA="…"` and `cd "$AGENDA"` exactly as they are.

The second line is the auth lane. It needs no Claude session at all; on all but a
handful of ticks it decides in milliseconds and writes one heartbeat field.

**`cron` does not catch up.** A job whose time passed while the machine was
asleep is gone — so on Linux, unlike Windows and macOS, a machine asleep at 10:30
waits until tomorrow rather than running on wake. **With one run a day that is a
whole day lost**, so if your machine sleeps, use a `systemd` timer with
`Persistent=true` instead (`OnCalendar=10:30` for the run, `OnCalendar=hourly`
for the auth lane), or `anacron`.

There is **no dead-man's switch here either** — it needs the Windows Outlook
sink. Every run logs `deadman=SKIPPED(no-calendar-sink)`, which is expected and
is not a fault, but it does mean nothing is watching for the machine being gone.

---

## Cowork and other cloud environments

**The daily run cannot be scheduled in the cloud, and this section is honest
about that rather than working around it.**

Two of its steps are local by construction:

> **The publish needs `rclone` on the machine that runs it**, with a Google Drive
> remote you authorised once in a browser.
>
> **The schedule needs a local scheduler** — Task Scheduler, `launchd` or `cron`.
> There is nothing in a cloud workspace to register a daily task with.

So a cloud environment is a place to run the agenda **by hand**, not a place to
host it. What works there:

```
/agenda-now
```

with Canvas configured (it needs only a token, no local MCP server). That runs
phase 1 and the model's own steps in the session you are sitting in. Nothing is
scheduled, nothing fires tomorrow, and when you close the workspace the agenda
stops updating until the next time you open one.

The rest of the cloud limitation is unchanged, and it is one sentence:

> **A cloud task cannot reach a program running on your laptop.**

| | Works in the cloud |
|---|---|
| **Canvas** — a token, no server | **yes** |
| LMS via a **hosted** MCP server (Tier 1), if your school offers one | yes |
| **Brightspace** — a local `npx` server (Tier 2) | **no** |
| Reading a Drive document through your Claude account's connector | yes |
| **Publishing over `rclone`** | **no** — it is a local program |
| Outlook mail, the email digest, the Exchange calendar sink, the dead-man's switch | **no** |
| The ICS calendar sink | yes — but the file lands in the cloud workspace, so it is only useful if you can reach it from there |
| Gradescope extra (local Python) | **no** |
| The planner, the page, both write-back buses | yes |

**Do not walk a cloud-only user into the Brightspace setup.** It cannot work
there, and finding that out after a login attempt is the worst possible order.

---

## About `--dangerously-skip-permissions`

The shipped launcher **does not use it**, and it no longer needs to.

In 1.x the scheduled run was an agent session with a long `--allowedTools` list,
and the honest tradeoff was "prompt-free but unrestricted" against "restricted
but able to wedge on a prompt". 2.0.0 does not have that tradeoff, because the
model window is launched with four built-in tools and nothing else:

```
--tools "Bash,Read,Write,PushNotification" --allowedTools "Bash,Read,Write,PushNotification"
--strict-mcp-config --setting-sources project
```

- **`--tools` limits the set; `--allowedTools` grants it.** Both are present on
  purpose: without the second, every `Write` in the window is denied and the run
  produces nothing.
- **`--strict-mcp-config` with no `--mcp-config` loads zero MCP servers**, so the
  window has no LMS server, no Drive connector and no calendar connector. It
  cannot scrape, cannot authenticate and cannot touch Drive — those are
  properties of how it was started, not promises in a runbook.
- **`--setting-sources project`** skips your user-level rules, hooks and skills,
  so a scheduled run behaves the same on your machine as on anyone else's.

Nothing in that window raises a permission prompt in normal operation, and
anything outside the four tools is refused rather than executed. Adding
`--dangerously-skip-permissions` would widen a window that is deliberately
narrow, on a personal laptop, reading text written by other people. If you decide
you want it anyway, it goes in `scripts/run-daily.mjs` where the arguments are
built — please read `SECURITY.md` first, particularly the section on why
LMS-authored text is untrusted input.

---

## Verifying it actually works

```
node scripts/run-daily.mjs --dry-run
node scripts/validate-setup.mjs
node src/auth-retry.mjs --status
```

and in Claude Code, `/agenda-doctor`, which reports when each task last ran and
next runs, and summarises the last seven runs' token usage.

`--dry-run` prints the five commands the launcher would run, fully quoted, and
executes none of them. `--status` is the one-command check that the auth lane
sees what you think it sees: it prints the session file it resolved, whether that
session is still valid, the newest success and failure it knows about, whether a
bad-credentials lock is in force, and the verdict it would reach. **It writes
nothing and starts no login.**

Then read the log after a day:

```
tail -5 data/runlog.txt
```

The daily run's line starts with an ISO timestamp, watchdog rescues start with
`STALE`, and auth-lane fires start with `AUTH`. So:

```
grep -v -e ^STALE -e ^AUTH -e ^SYNC data/runlog.txt | tail -3   # the last daily runs
grep ^STALE data/runlog.txt                                     # every rescue, ever
grep ^AUTH  data/runlog.txt                                     # every login attempt
```

`SYNC ` lines are 1.x leftovers. Nothing writes them any more and the watchdog
reads them as noise rather than as evidence that a run happened.

An `AUTH` line appears **only when the lane actually fired a login** — a quiet
check writes nothing here, because this lane ticks 24 times a day and a heartbeat
would bury the other two within a fortnight. `data/auth-retry.json`'s
`lastCheckAt` is the heartbeat instead.

**Two `STALE` lines in one day** means the watchdog rescued the daily run twice
and has now stopped by design. That is the signal that something is failing
before a run reaches its log step, and it needs a human.
`docs/design-notes/watchdogs.md` explains the whole mechanism.

The other file worth knowing about is `data/llm-usage.jsonl`: one record per run,
with turns, output tokens and cost. A normal run is 8–13 turns and under 10,000
output tokens. `docs/design-notes/daily-run.md` says what to do when it climbs.
