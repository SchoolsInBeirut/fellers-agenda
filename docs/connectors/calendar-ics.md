# ICS calendar sink — deadline reminders on any platform

**Ships in the box, disabled by default. Works everywhere Node works.**

```jsonc
"connectors": {
  "calendar": {
    "outlook": { "enabled": false, ... },
    "ics":     { "enabled": false, "path": "data/agenda.ics" }
  }
}
```

The connector is `src/connectors/calendar-ics.mjs`. It writes one standard
iCalendar file. Your calendar app — Google Calendar, Apple Calendar, Outlook on
the web, anything that reads `.ics` — subscribes to or imports that file, and
the reminders ring on your phone from there.

This is the answer for **macOS, Linux, and any Windows machine without classic
Outlook**.

---

## What it writes

One `VEVENT` per upcoming deliverable, into the file at `path` (default
`data/agenda.ics`, which is git-ignored along with the rest of `data/`).

- Items due in the future, within a **21-day horizon** — the same window the
  Outlook sink uses — and not marked done. Courses marked `"skip": true` are
  excluded. The horizon is fixed; `path` is the only key you set.
- **Deadline items get a short block that ends at the due time**, so they land on
  the right calendar day rather than the day before.
- **Exams start at the exam time** and also get a separate **exam-prep event** a
  few days out, so the studying has a slot and not just the sitting.
- Each event carries a `VALARM` — an alarm your calendar app fires. The lead
  times come from the same table the Outlook sink uses: exam 24 h, quiz and
  email items 3 h, everything else 6 h, the exam-prep event 1 h.
- Approximate due dates get a `~` in the summary, the same as everywhere else.

- A runaway guard caps the file at 60 events, so a bug can never hand your
  calendar app hundreds.

The whole file is rewritten on every run. It is a **rendering of the current
plan**, not a store: nothing you edit inside it survives, and nothing outside it
is touched.

To write a copy somewhere else without changing your config — a synced folder,
say — the module runs on its own:

```
node src/connectors/calendar-ics.mjs --out <path>
```

It exits 0 when the file was written and 1 on a hard failure (no snapshot to
render, or an unwritable path).

---

## Setting it up

**1. Turn it on** in `config.json`:

```jsonc
"connectors": { "calendar": { "ics": { "enabled": true, "path": "data/agenda.ics" } } }
```

**2. Run once** so the file exists:

```
node src/scrape.mjs
node src/render.mjs
```

`data/agenda.ics` should now be there. Open it in a text editor if you want —
it is plain text and each `BEGIN:VEVENT` is one deadline.

**3. Get it into your calendar.** Two ways, and the difference matters.

### Import (a snapshot)

The file is copied in once. Nothing updates after that, and a re-import creates
duplicates unless you delete the old ones. **Use this only to try it out.**

**Google Calendar:** open <https://calendar.google.com> → the **gear icon**
(top right) → **Settings** → **Import & export** in the left sidebar → **Import**
→ **Select file from your computer** → pick `data/agenda.ics` → choose which
calendar to add to → **Import**.

**Apple Calendar (macOS):** **File → Import…** → pick `data/agenda.ics` →
choose a calendar → **OK**.

### Subscribe (stays current — what you actually want)

A subscription re-reads the file, so the next run's changes appear on their own.
Both apps subscribe to a **URL**, not to a path on your disk, so the file has to
be reachable at one. If you already keep the repository in a synced folder that
gives you a public direct link, point the subscription there; otherwise the
import path above, re-done occasionally, is the honest fallback.

**Google Calendar:** <https://calendar.google.com> → in the left sidebar, the
**+** beside **Other calendars** → **From URL** → paste the URL → **Add
calendar**. Google refreshes a subscribed URL on its own schedule, typically
**every 8–24 hours** — it is not immediate, and no setting makes it immediate.

**Apple Calendar (macOS):** **File → New Calendar Subscription…** → paste the
URL → **Subscribe** → set **Auto-refresh** to **Every hour** (or **Every day**)
→ **OK**.

**Apple Calendar (iPhone/iPad):** **Settings → Apps → Calendar → Calendar
Accounts → Add Account → Other → Add Subscribed Calendar** → paste the URL →
**Next** → **Save**.

**4. Check one deadline.** Open your calendar app and find any item you know is
due this week. If the alarm is there and the time is right, it works.

---

## What it does not do

**It does not host the dead-man's switch, and nothing on this path can.**

The dead-man's switch plants a calendar event about 30 hours out and relies on a
calendar *service* to ring it when this machine is gone — that is the entire
point of an off-machine watchdog. A file on the disk of a machine that is
switched off rings nothing, and a subscription that re-reads it every 8–24 hours
cannot be trusted to notice in time either.

So:

- **With the Outlook sink (Windows):** the switch arms, and a missed run
  eventually buzzes your phone. `docs/design-notes/watchdogs.md` explains the
  mechanism.
- **With the ICS sink, or no sink at all:** the switch stays unarmed and every
  run logs `deadman=SKIPPED(no-calendar-sink)`. That is an **expected** token,
  not a failure, and `docs/TROUBLESHOOTING.md` says so — but it does mean the
  alarm that fires when your whole machine is gone is not armed. The in-machine
  stale-run watchdog still covers a machine that merely slept.

There is no cross-platform substitute for this, and pretending otherwise would
be the worst kind of documentation: you would believe you had a safety net.

---

## Turning it off

Set `enabled: false`. The file stops being rewritten; delete it if you want it
gone. Any calendar that imported a snapshot keeps those events — remove them in
your calendar app, they are not this connector's to delete.

If you also unsubscribe, nothing else in the pipeline changes: the page, the
planner, the write-back buses and every other connector are unaffected.
