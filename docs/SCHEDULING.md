# Scheduling: making it run by itself

An agenda you have to remember to run is a to-do list with extra steps. This page
sets up the two lanes so they run without you.

**You can skip this entirely.** `/agenda-now` on demand works perfectly well, and
plenty of people run it that way for a term before automating anything.

---

## The four tasks

| Task | What it runs | When |
|---|---|---|
| `<prefix> Morning` | `runbooks/heavy-run.md` | Daily at `scheduler.morningAt` (07:03) |
| `<prefix> Evening` | `runbooks/heavy-run.md` | Daily at `scheduler.eveningAt` (18:07) |
| `<prefix> Sync` | `runbooks/sync-run.md` | Every 2 h inside `scheduler.syncWindow` |
| `<prefix> StaleCheck` | `src/stale-check.mjs` | Logon, unlock, resume, and every 30 min |

`<prefix>` is `config.json` → `scheduler.taskPrefix`, default `Agenda`.

The odd minutes are deliberate. Round times are congested on a Windows desktop —
backup software, update checks and antivirus scans all fire at :00 — and a run
that starts three minutes late is a run that starts.

---

## Windows

```
scripts\install-tasks.cmd
```

That is the whole thing. It:

- reads `scheduler` from `config.json` (falling back to the shipped defaults)
- **verifies every target file exists before registering anything** — `schtasks`
  does not do this, which is why a task can look installed for a month while
  executing nothing
- registers all four with the right triggers and settings
- prints what it did and what is now scheduled
- **never runs a task**, and never deletes one you did not ask it to replace

It is **idempotent.** Run it twice, run it ten times, the end state is identical.
Run it again after you move the repository, after a Windows feature update, or
any time `/agenda-doctor` says a task looks wrong.

**No administrator rights are needed.** Every task runs as your user with an
interactive token and least privilege. Nothing is written to machine-wide
registry keys and no password is stored.

### To change the times

Edit `scheduler` in `config.json`, then re-run the installer. **Do not edit a
task by hand in the Task Scheduler UI** — the next run of the installer asserts
your config back over it, and then you have two sources of truth that disagree.

### Settings the installer sets, and why

| Setting | Heavy runs | Sync | Watchdog |
|---|---|---|---|
| Start when available | **yes** | yes | yes |
| Wake the computer | **yes** | no | **no** |
| Time limit | 2 h | 30 min | 5 min |
| Restart on failure | 3× / 10 min | no | no |
| Multiple instances | ignore new | ignore new | ignore new |
| Run on battery | yes | yes | yes |

- **Start when available** is the important one. Without it, a run missed because
  the laptop was closed is simply *lost*, with no digest that day and nothing to
  show why.
- **Wake the computer** is true for the heavy runs and false for the others. The
  morning digest is worth waking a sleeping laptop for; a light sync is not, and
  waking a machine to ask "did anything get missed" is the exact opposite of what
  the watchdog is for.
- **Two hours** rather than the default, because a wedged run must not hold the
  slot for days while "ignore new" silently drops every run behind it.
- **No restart for the sync lane.** The next fire is only two hours away, and a
  retry storm on a run that may push a notification is worse than one skipped
  sync.

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

**There is no installer here, so ask the agent to write these files for you.**
Say *"set up scheduling"* in Claude Code: it knows the repository's real path,
it can substitute it, and it can write both plists and run `launchctl` for you.
Everything below is what it produces, and what to check if you would rather do
it by hand.

Two `launchd` agents. The first is
`~/Library/LaunchAgents/com.agenda.heavy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agenda.heavy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd "$HOME/my-agenda" &amp;&amp; claude -p "Read runbooks/heavy-run.md and follow its instructions exactly." --allowedTools "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__brightspace__*,mcp__claude_ai_Google_Drive__*,mcp__claude_ai_Gmail__*" >> data/runlog-stdout.txt 2>&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>3</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>7</integer></dict>
  </array>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

**`$HOME/my-agenda` is a placeholder** — replace it with the absolute path of
your own clone, in both plists. A `launchd` job with a wrong `cd` fails silently
and looks perfectly installed.

The second is `~/Library/LaunchAgents/com.agenda.sync.plist`. Here it is in
full, rather than described:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agenda.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd "$HOME/my-agenda" &amp;&amp; claude -p "Read runbooks/sync-run.md and follow its instructions exactly." --allowedTools "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__claude_ai_Google_Drive__*" >> data/runlog-stdout.txt 2>&amp;1</string>
  </array>
  <key>StartInterval</key><integer>7200</integer>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

The sync lane's tool list is deliberately **smaller**: it never scrapes, so it
has no reason to be able to reach the LMS or a mailbox.

Then load both and check:

```
launchctl load ~/Library/LaunchAgents/com.agenda.heavy.plist
launchctl load ~/Library/LaunchAgents/com.agenda.sync.plist
launchctl list | grep com.agenda
```

**`launchd` runs a missed job when the Mac wakes**, which covers most of what the
Windows stale-run watchdog does. It does **not** cover a Mac that stays awake
through a boundary while something else fails — and on macOS **there is no
dead-man's switch to fall back on**, because that watchdog needs the Windows
Outlook sink. Read `data/runlog.txt` occasionally; it is the backstop you have.

**The Windows-only connectors stay off.** Mail and the Exchange calendar sink
need a local desktop program that does not exist here. For deadline reminders,
enable `connectors.calendar.ics` and subscribe your calendar app to the file —
`docs/connectors/calendar-ics.md` has the click-path for Google Calendar and
Apple Calendar.

---

## Linux

**Ask the agent to write this for you** — say *"set up scheduling"*. It knows the
clone's real path and can produce the block with `AGENDA` already filled in.
What follows is what it writes.

`cron` with an explicit `PATH`, because cron's environment is nearly empty and
`claude` will not be found otherwise:

```cron
PATH=/usr/local/bin:/usr/bin:/bin:/home/you/.local/bin
AGENDA=/home/you/my-agenda

3  7  * * * cd $AGENDA && claude -p "Read runbooks/heavy-run.md and follow its instructions exactly." --allowedTools "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__brightspace__*,mcp__claude_ai_Google_Drive__*" >> data/runlog-stdout.txt 2>&1
7 18  * * * cd $AGENDA && claude -p "Read runbooks/heavy-run.md and follow its instructions exactly." --allowedTools "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__brightspace__*,mcp__claude_ai_Google_Drive__*" >> data/runlog-stdout.txt 2>&1
0 9-23/2 * * * cd $AGENDA && claude -p "Read runbooks/sync-run.md and follow its instructions exactly." --allowedTools "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__claude_ai_Google_Drive__*" >> data/runlog-stdout.txt 2>&1
```

Both `PATH` and `AGENDA` are placeholders. Install it with `crontab -e`, and
check it took with `crontab -l`.

**`cron` does not catch up.** A job whose time passed while the machine was
asleep is gone. If your machine sleeps, use `systemd` timers with
`Persistent=true` instead, or `anacron`.

There is **no dead-man's switch here either** — it needs the Windows Outlook
sink. Every run logs `deadman=SKIPPED(no-calendar-sink)`, which is expected and
is not a fault, but it does mean nothing is watching for the machine being gone.

---

## Cowork and other cloud environments

Cloud scheduling works, with **one hard limitation you must plan around**:

> **A cloud task cannot reach a program running on your laptop.**

That rules out every stdio MCP server and every local desktop application. In
practice:

| | Works in the cloud |
|---|---|
| **Canvas** — a token, no server | **yes** |
| LMS via a **hosted** MCP server (Tier 1), if your school offers one | yes |
| **Brightspace** — a local `npx` server (Tier 2) | **no** |
| Google Drive (a hosted connector on your Claude account) | yes |
| Outlook mail, the Exchange calendar sink, the dead-man's switch | **no** |
| The ICS calendar sink | yes — but the file lands in the cloud workspace, so it is only useful if you can reach it from there |
| Gradescope extra (local Python) | **no** |
| The planner, the page, both write-back buses | yes |

So a cloud configuration is: **Canvas** (or a hosted LMS server, if your school
is one of the rare ones that offers one), Drive for transport, and everything
Windows-shaped turned off. If your school runs Canvas, a fully cloud-hosted setup
is genuinely available to you.

If your school runs **Brightspace**, the honest answer is a hybrid: run the
**heavy** lane on your laptop, where the local server lives, and the **light**
lane in the cloud, which only needs Drive. The light lane never scrapes, so it
needs none of the local pieces.

**Do not walk a cloud-only user into the Brightspace setup.** It cannot work
there, and finding that out after a login attempt is the worst possible order.

---

## About `--dangerously-skip-permissions`

The shipped launchers **do not use it**, and that is a deliberate choice made on
your behalf that you are free to reverse.

The tradeoff, honestly:

- **With it:** an unattended run never stops on a permission prompt. Nothing can
  wedge waiting for input nobody will give it.
- **Without it:** the `--allowedTools` allow-list in the launchers is narrow
  enough that a normal run completes without prompting anyway, and anything
  *outside* that list is refused rather than executed.

The reason the default is "without": this is a template a stranger on the
internet wrote, aimed at students, that runs twice a day, unattended, on a
personal laptop, and reads text written by other people. A repository that turns
off your permission prompts in that setting is a supply-chain footgun, and it is
not a decision a README should make for you.

If you decide the convenience is worth it on your own machine, add the flag to
`scripts\run-heavy.cmd` and `scripts\run-sync.cmd` yourself. Please read
`SECURITY.md` first, particularly the section on why LMS-authored text is
untrusted input.

---

## Verifying it actually works

```
node scripts/validate-setup.mjs
```

and in Claude Code, `/agenda-doctor`, which reports when each task last ran and
next runs.

Then read the log after a day:

```
tail -5 data/runlog.txt
```

Heavy lines start with an ISO timestamp, sync lines start with `SYNC`, and
watchdog rescues start with `STALE`. So:

```
grep -v -e ^SYNC -e ^STALE data/runlog.txt | tail -3   # the last heavy runs
grep ^STALE data/runlog.txt                            # every rescue, ever
```

**Two `STALE` lines for the same lane on one day** means the watchdog rescued it
twice and has now stopped by design. That is the signal that something is failing
before a run reaches its log step, and it needs a human.
`docs/design-notes/watchdogs.md` explains the whole mechanism.
