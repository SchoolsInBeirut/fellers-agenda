# Design note: three watchdogs, and why one is not enough

*Every alarm in this system assumes the run happens, and happens well. These three
exist for the cases where it does not.*

---

## The failure they exist for

If the machine sleeps through a boundary, or the scheduler gets disabled, or Node
dies on a malformed file, the agenda goes **silent**.

And silence is indistinguishable from "nothing is due."

That is the whole problem in one sentence. Every other failure in this system
announces itself: a scrape that fails logs a token, a Drive upload that fails
logs a token, a connector that cannot run contributes an `errors[]` line. But a
run that never starts produces nothing at all, and the user's evidence that
everything is fine is exactly the evidence that everything has stopped.

**No rule inside the pipeline can catch this, because the pipeline is what
stopped.** Whatever notices has to be outside it.

There are two ways to be outside it, and they catch different things. A third
watchdog covers a case neither of them can see: a run that happened, on time, and
failed at its first step.

---

## Watchdog 1 — the stale-run check (inside the machine)

`src/stale-check.mjs`, launched by `scripts/stale-check.vbs` from a fourth
scheduled task.

**Catches:** a machine that was merely *asleep* at the boundary.

This is by far the more common case. The laptop was shut at 07:03. `Start when
available` only rescues a run the scheduler itself *deferred* — not one the
machine slept clean through. So the run simply never happened, and there is no
record anywhere that it was supposed to.

### What it does

It reads two files, decides one thing, and usually does nothing at all.

The thing it decides: **was a run supposed to have happened by now, and did it
not?** If the newest heavy line in `data/runlog.txt` predates a boundary that has
already passed today, that run was missed.

When it decides yes, it starts **the same scheduled task the scheduler should
have started** — never the launcher script directly. That distinction is
load-bearing: going through the scheduler keeps the task's own single-instance
policy as the arbiter of whether a run may begin, so a rescue can never land on
top of a run that is already going.

### The four triggers

| # | Trigger | The case it covers |
|---|---|---|
| 1 | At logon | The lid opened onto a cold boot |
| 2 | On workstation unlock | The machine never shut down — it slept, and the user unlocked it. Much the most common |
| 3 | On resume from sleep | A lid opened on a session that was never locked, which trigger 2 misses entirely. Driven off the system power-troubleshooter event, which lands *after* the machine is usable |
| 4 | Daily, repeating every 30 minutes for 24 hours | The floor. Covers a machine that stays awake and logged in through a boundary while something else went wrong |

Triggers 2 and 3 cannot be expressed by `schtasks.exe` at all — it has no
`/SC ONUNLOCK` and no event-subscription syntax. That is why the installer goes
through PowerShell's scheduled-task API with CIM trigger instances rather than
the simpler command-line tool.

Trigger 4 is a *daily* trigger carrying a repetition borrowed from a throwaway
one-shot trigger. A one-shot trigger on its own would not do: its 24-hour window
expires and never reopens, so the watchdog would quietly stop after one day —
which is exactly the kind of failure a watchdog must not have.

### Why a VBScript wrapper

That task fires up to about **fifty times a day**, most of them while the user is
looking at the screen. Pointing it at `node.exe` or at a `.cmd` puts a console
window on the desktop for a fraction of a second every single time.

That flicker is precisely the kind of thing that gets a watchdog **disabled**,
and a disabled watchdog protects nothing. `wscript.exe` has no console of its
own, and running node from it with window style 0 starts it fully hidden. That is
the entire content of `scripts/stale-check.vbs`, and it is why the file exists.

### Two rescues per lane per day, and no more

The watchdog reads its own `STALE ` lines back to count how many times it has
already rescued each lane today, and stops at two — two morning rescues, two
evening, two sync, each independent.

The reason it **must** stop: the trigger for "the morning was missed" is "no
heavy line dated after the boundary today". A run that dies *before* it reaches
its logging step leaves that condition true forever, so the lane would re-fire
every twenty-five minutes until the next boundary. Two attempts is generous; a
third is a loop, not a rescue.

A capped lane goes quiet rather than falling through to a smaller one.

**The consequence for an agent: if you cannot complete a run, write your log line
anyway.** A run that logs why it stopped keeps the count honest and tells the user
what happened. Two `STALE ` lines for one lane in one day is the signal that
something is failing before the log step, and that needs a human.

This is also why `STALE ` lines are the one lane that is **never trimmed** from
the run log. They are the rarest lane (a good week produces zero), they cost
nothing, and trimming one would silently refill a lane's ration. The rule is
load-bearing, not tidy.

---

## Watchdog 2 — the dead-man's switch (outside the machine)

`src/deadman.mjs`, armed as the last action of every successful run.

**Catches:** a machine that is *gone*. Powered off for a week. Stolen. Broken.
Left at a parent's house. The scheduler disabled by a Windows update.

Watchdog 1 cannot catch any of those, because watchdog 1 also runs on that
machine.

### What it does

Each successful run plants **one** calendar event about 26 hours out, through a
calendar sink that can host it, with a reminder set at the event time. The next
successful run deletes it and plants the next one.

**Only the Outlook sink can host it, so this watchdog is Windows-only.** That is
not an oversight, it is the definition doing its work: the switch has to ring
from something that is *not this machine*. The ICS sink writes a file on the
machine that stopped, and a calendar app re-reads a subscribed file on its own
schedule — typically every 8 to 24 hours — so an event planted 26 hours out is
not something it can be trusted to deliver on time. A watchdog you cannot trust
is worse than none, because you stop watching yourself.

So in normal operation the event is created and destroyed twice a day and the
user never sees it. They see it exactly once: **when a run did not happen.** And
it fires from a calendar service, which is not this machine — so it reaches the
user's phone even if the laptop is at the bottom of a lake.

### The ordering invariant

**Create the replacement, verify it, and only then delete the previous one.**

This is not an optimisation and it must not be reordered. If you delete first and
the create then fails, there is a window — potentially a permanent one — with
**zero** events armed, and the watchdog has silently disarmed itself at exactly
the moment something was already going wrong.

Done in the right order, a failed create leaves the previous event exactly where
it is, and the switch stays armed on the old timer. Worst case you get an alarm
26 hours after the last *successful* run instead of the last *attempted* one,
which is the correct behaviour.

### It is optional and says so

If nothing here can host the switch, `deadman.mjs` exits `0` and logs
`deadman=SKIPPED(no-calendar-sink)`. A feature that cannot apply is not a
failure, so it does not get a failure code: it is the **expected** outcome on
most installations, never a reason to push or retry.

Be honest with yourself about what that token means, though. It is not "this is
fine and covered elsewhere" — it is **"the off-machine watchdog is not armed"**.
On macOS, on Linux, and on Windows without classic Outlook, the stale-run check
below is the only watchdog you have, and it cannot see a machine that is gone.
The remaining backstop is a person occasionally reading `data/runlog.txt`.

Exit `2` is a different thing entirely — a sink that *can* host it is enabled but
its backend could not be reached (Outlook COM), logged as `deadman=SKIPPED(com)`.
That one means "ask again later"; exit `0` means "there was never anything to
do".

---

## Watchdog 3 - the auth lane (a different question entirely)

`src/auth-retry.mjs`, launched by `scripts/auth-retry.vbs` from a fifth scheduled
task, on the same logon / unlock / resume triggers as the stale-run check but on
an hourly floor instead of a half-hourly one.

**The two above ask "did a run happen?". This one asks "can we still log in?"**
That distinction is the entire reason it exists, and it is easy to miss until you
have watched it fail.

Consider the sequence that produced it. The morning run fires exactly on time.
It reads its runbook, calls `src/scrape.mjs`, and the scrape hits an expired
session and exits 2. Per the runbook it tries `scripts/reauth.mjs --silent`
exactly once - correctly, because a run that hammers a login is a run that locks
an account - and that attempt fails. The run stops, writes its log line, and does
not publish stale data. All of that is right.

Now look at what the other two watchdogs see.

- The stale-run check asks whether a run happened by the morning boundary. **It
  did.** The check is satisfied and stays silent, which is the correct behaviour
  for the question it is asking. No amount of tuning its grace period, its
  debounce or its daily cap would have caught this, because nothing it measures
  went wrong.
- The dead-man's switch asks whether this machine is still alive. **It is.** It
  is re-armed by the next lane that runs, so it never rings.

So the agenda sits unauthenticated until the evening run, eleven hours later,
which tries once more and stops for the same reason. Without this lane, the
retry interval for a failed login is *half a day*.

### What makes it free on a healthy machine

The obvious rule - "retry whenever the session is expired" - is wrong, and
expensively so. An LMS token lives about an hour and the heavy runs are eleven
hours apart, so **an expired session is the pipeline's normal resting state for
most of the day.** Firing on that alone would mean two dozen headless logins a
day on a machine where nothing is wrong, each one able to raise a second-factor
prompt at somebody who did not ask for one.

The rule that works has two clauses, and only the second one is interesting:

> **Unhealthy when there is no session file at all, or when the newest failure
> is newer than the newest success.**

The first clause is the trivial case: nothing to be authorised with. The second
is what makes the lane free. Newest success is the session file's own
`createdAt` - its mtime only as a fallback, when the JSON will not parse. Newest
failure is `data/auth-failure.json`, which `src/scrape.mjs` writes the moment a
source comes back 401. Either side may also be a success or failure this lane
recorded itself. Expired *and* the last thing that happened was a failure means
something is genuinely broken; expired with nothing outstanding is a machine
resting between runs, and is left alone.

### The one state it never retries

Exit 5 - the school rejected the password. Institutions lock accounts after a
handful of bad attempts, so an hourly retry against a rejected password converts
"my agenda is stale" into "I cannot log in to anything". That case writes
`data/auth-locked.json` and the lane stops permanently. The tombstone's
*existence* is the lock - there is no boolean anywhere else, so the two cannot
drift, and a tombstone that will not parse reads as still locked rather than as
no lock. Every other exit code retries hourly.

`docs/design-notes/auth-hardening.md` carries the full table, and the
number-matching argument - which is where "retry" and "relay" turn out to be one
feature rather than two.

---

## Why all three

| | Stale-run check | Dead-man's switch | Auth lane |
|---|---|---|---|
| **Asks** | Did a run happen? | Is this machine alive? | Can we still log in? |
| **Runs on** | This machine | A calendar service | This machine |
| **Catches** | A machine that was asleep at the boundary | A machine that is gone | A run that happened and failed at step one |
| **Notices within** | Seconds of the machine becoming usable | About 26 hours | An hour, or seconds of the machine waking |
| **Acts by** | Starting the missed run | Ringing the user's phone | Retrying the login, and relaying any prompt it raises |
| **Fails silently if** | The machine never wakes | Every run fails before it can arm | Never - a credential rejection stops it loudly and on purpose |

Each one's blind spot is another one's whole purpose. The first catches a machine
that was merely asleep at 07:03; the second catches a machine that is not coming
back; the third catches the case both of the others are *right* to ignore. None
is sufficient, and together they cover the space.

---

## Things not to do

- **Never edit the watchdog from inside a run.** A run that can modify the
  watchdog that started it is a run that can hide its own lateness.
- **Never `schtasks /Run`, `/Change` or `/Delete` an agenda task from a run.**
- **Never rewrite `data/stale-check.json`.** It is the debounce record —
  logon, unlock and resume can all land within one second, and nothing fires
  twice inside the debounce window. Rewriting `lastFiredAt` disarms the watchdog
  for that window; clearing it may cause a second run to start on top of yours.
- **Never make a watchdog log a heartbeat into the run log.** At fifty and
  twenty-four checks a day respectively they would bury the run lanes inside a
  day. `lastCheckAt` in `data/stale-check.json` and in `data/auth-retry.json` is
  the heartbeat, and it is the only proof each watchdog is alive.
- **Never delete `data/auth-locked.json`.** It is a deliberate, permanent stop
  after a credential rejection. Deleting it restarts hourly attempts against a
  password that has already been refused, which is the one failure mode in this
  document that costs the user something they cannot undo themselves.
- **Never run `src/auth-retry.mjs` from inside a run.** It drives the same
  persistent browser profile the run's own re-auth uses, and two headless
  browsers on one profile crash each other. Its scheduled task and its in-flight
  marker already handle the timing.

---

## Diagnosing

Neither of these needs a scrape to inspect:

```
node src/stale-check.mjs --dry-run --verbose   # the current verdict, changes nothing
node src/deadman.mjs --status                  # what is armed right now
node src/auth-retry.mjs --status               # what the auth lane sees, and its verdict
```

And in the run log: `STALE ` lines are the rescues that happened, and
`lastCheckAt` in `data/stale-check.json` says whether the watchdog is still
checking at all.
