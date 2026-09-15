# Calendar feeds — your own meetings, read in by a script

**Ships in the box, disabled by default. Works everywhere Node works. This is
the only inbound-calendar route a scheduled run can take.**

```jsonc
"calendars": {
  "gcal": {
    "enabled": true,
    "feed": "calendar",
    "label": "Calendar",
    "maxEvents": 200,
    "skipUidSuffix": "[NOT SET]",
    "skipDescriptionMarker": "Auto-created by the agenda."
  }
}
```

An hour that is already spoken for is not an hour of study. The planner needs to
know about your meetings, your appointments and the three-day conference in the
middle of next week — otherwise it books work straight over them and the week it
draws is fiction.

The connector is `src/connectors/gcal-sync.mjs`. It reads a small JSON file of
calendar addresses, fetches each one, parses the iCalendar text, and writes
`data/gcal-items.json`. `src/render.mjs` draws those events on the page as
`payload.meetings[]` and `src/focus-engine.mjs` treats them as busy time.

---

## Route A and route B

There are two ways meetings get in, and they write the **same file**.

| | Route A — **this page** | Route B — the connector route |
|---|---|---|
| Script | `src/connectors/gcal-sync.mjs` | `src/connectors/gcal-ingest.mjs` |
| Where the bytes come from | the calendar's secret iCal address, fetched by the script | a calendar connector in your own Claude account, called by an agent |
| Credentials here | none — the address is the whole secret | none — the agent borrows yours for one run |
| Works on a schedule | **yes** | no: a scheduled run has no connector to call |
| Works in a chat | yes | yes |

Route B is still there and still supported; it is what you use interactively,
and `docs/CONFIG.md` covers it. But the daily run is a script, and a script has
no Claude account, so **route A is what a scheduled run uses.** The daily run
picks between them by looking for the feeds file:

```
calendars.gcal.enabled is not true      -> gcal=SKIPPED(disabled)
data/gcal-feeds.json exists             -> gcal-sync.mjs        (route A)
data/tmp/gcal-raw.json exists           -> gcal-ingest.mjs      (route B)
neither                                 -> gcal=SKIPPED(no-feeds)
```

Because both routes produce byte-identical documents, nothing downstream knows
or cares which one ran, and switching from one to the other costs nothing.

---

## The secret address

Every calendar service that can be subscribed to publishes a private URL that
returns the calendar as iCalendar text. In **Google Calendar** it is:

> **Settings** (the gear icon, top right) → **Settings for my calendars** in the
> left sidebar → **click the calendar you want** → scroll to **Integrate
> calendar** → **Secret address in iCal format**.

Click the copy button beside it. Other services call it the same thing or close
to it — Outlook on the web calls it "Publish a calendar", Apple calls it a
"Public Calendar" link.

**That URL is a bearer secret.** Anyone holding it can read that calendar,
forever, without logging in to anything. So treat it the way you would treat a
password:

- It lives in **exactly one place**: `data/gcal-feeds.json`, which is
  git-ignored along with the rest of `data/`.
- `src/drive-bundle.mjs` refuses to put that file in the Drive mirror.
- `gcal-sync.mjs` never puts it in argv, in a log line, in an error message, in
  `data/gcal-items.json`, or in the payload. A feed is named in output by its
  **id**, its **host**, and `sha256(url)` cut to eight characters. Every error
  string is scrubbed of anything URL-shaped before it is printed or stored.

If it ever leaks, click **Reset** next to the secret address on that same
settings page and paste the new one in. The old address stops working
immediately.

---

## The feeds file

Copy `fixtures/gcal/feeds.example.json` to `data/gcal-feeds.json` and fill in
the address:

```jsonc
{
  "v": 1,
  "feeds": [
    { "id": "calendar", "label": "Calendar", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" },
    { "id": "team",     "label": "Team",     "url": "https://calendar.google.com/calendar/ical/.../basic.ics" }
  ]
}
```

| Key | Meaning |
|---|---|
| `id` | `[a-z0-9-]`, 1–24 characters, unique. It prefixes every meeting key, so it is part of the wire format. `fb` is **refused** — that prefix already names study sessions |
| `label` | what the page shows, 24 characters or fewer. Leave it out and the feed whose id matches `calendars.gcal.feed` takes `calendars.gcal.label`; any other feed is labelled with its own id |
| `url` | **https only.** An empty string means "not set up yet" and is a clean skip, not an error |
| `skipUidSuffix` | optional, per feed. Overrides `calendars.gcal.skipUidSuffix`; `""` switches that guard off for this one feed |

A feed that is **actively wrong** — a bad or reserved id, a duplicate id, a
`http://` url — stops the whole run with exit 1 and nothing is written. That is
deliberate: silently ignoring one entry would hide a calendar you believe is
connected, and an empty grid looks exactly like a free week.

### Checking the file: `--validate`

```
node src/connectors/gcal-sync.mjs --validate
```

**This is the safe thing to run and paste to someone.** It fetches nothing,
writes nothing, and prints one line per feed with the id, the label and the
**host** — never the url. A feed whose `url` is still blank is listed too, as
`no url yet`, because a half-finished setup is exactly what you are looking for.

It runs **before** every other gate in the script, which is the point:

- **The file will not parse?** It says so, scrubbed of anything URL-shaped (a
  JSON syntax error quotes the input, and the input is a secret), and exits 1.
- **One entry is wrong?** It lists every entry it *could* read and reports every
  problem beside them, then exits 1 — so one typo among four calendars tells you
  about the other three. (A run is stricter: any problem stops it.)
- **`calendars.gcal.enabled` is not `true`?** It still validates the file and
  adds a line saying the route is off. Turning the switch on and filling the file
  in are two steps, and you should be able to do them in either order.
- **No feeds file at all?** That is an answer, not a problem: it says route A is
  not set up and exits **0**.

Last line is `gcal=ok(validate;<n>-feeds)`, or `gcal=FAILED(validate;<reason>)`
with exit 1 when there was a problem.

---

## The loop guard

If you also run a **calendar sink** (`docs/connectors/calendar-ics.md` or
`docs/connectors/outlook.md`), your calendar already contains this agenda's own
deadlines. Importing them back would draw every deadline twice and let the
planner refuse to plan around a block it invented itself.

Two independent rules stop that, and they are the same two both inbound routes
use:

- **`skipUidSuffix`** — the ICS sink writes UIDs ending
  `@<namespace>.agenda.local`, and an importer keeps the original UID inside its
  own event id. This rule is **proof**, and it is silent.
- **`skipDescriptionMarker`** — the literal every sink event's body ends with,
  `Auto-created by the agenda.` by default. This rule is a **heuristic**: it can
  hit a real meeting whose body quotes an agenda invite. So a description-only
  skip is still dropped, but it is **counted and warned about** rather than
  silent, and the warning reaches `data/gcal-items.json`.

Both default from `calendars.gcal`; `skipUidSuffix: "[NOT SET]"` means "derive
it from `namespace`", which is right unless you have renamed things. Set either
to `""` to switch it off.

An event dropped by a guard is counted in `skippedOwn` and never appears in
`events[]`.

---

## What it never does

**It never writes to a calendar.** An iCal address is read-only by construction:
there is no verb to write with and no credential that could authorize one. This
repository's golden rule 9 says the inbound calendar is read-only, and route A
is the version of that rule you can check by reading the protocol rather than
the code.

**It never logs the address**, in any form, anywhere — see "The secret address".

**It never invents a meeting.** A recurrence rule this parser cannot honour
(`BYSETPOS`, an unsupported `FREQ`) produces the **first instance only** plus a
warning, because a half-right expansion puts phantom meetings on your grid and a
phantom meeting becomes phantom busy time. Expansion is also bounded: a runaway
or unsatisfiable rule stops at 2,000 candidates and says so.

**It never blanks your week over an outage.** If a feed fails and the previous
`data/gcal-items.json` holds that feed's events with a `fetchedAt` newer than
**48 hours**, those events are kept, the feed is marked `status: "stale"` with
its *original* `fetchedAt` so the age stays honest, and the page's error strip
says how old they are. Older than that and the feed is `status: "failed"` with
zero events. Either way the file is written, so the page shows the truth.

---

## Setting it up

**1. Turn the route on** in `config.json`:

```jsonc
"calendars": { "gcal": { "enabled": true } }
```

**2. Copy the example and paste your address:**

```
cp fixtures/gcal/feeds.example.json data/gcal-feeds.json
```

Then edit `url`. Delete the `_readme` block if you like; it is ignored.

**3. Check the file, then run it:**

```
node src/connectors/gcal-sync.mjs --validate
node src/connectors/gcal-sync.mjs
```

**4. Look at what landed:**

```
node src/connectors/gcal-sync.mjs --dry-run
```

`--dry-run` prints the summary and writes nothing, which is the safe way to try
a change to the feeds file.

**5. Rebuild the page** and check a meeting you know about:

```
node src/render.mjs
```

---

## The daily run

Phase 1, step 7 of `src/pipeline.mjs` runs this and reads **one token off the
last stdout line**:

| Token | What happened |
|---|---|
| `gcal=ok(<n>-events;<k>-feeds)` | every feed answered |
| `gcal=PARTIAL(<n>-events;<k>-feeds;stale=<n>,failed=<n>)` | at least one feed is stale or failed; the file was written with whatever we have |
| `gcal=SKIPPED(no-feeds)` | no feeds configured — the file was rewritten as an honest empty |
| `gcal=SKIPPED(disabled)` | `calendars.gcal.enabled` is not `true`; nothing was read or written |
| `gcal=FAILED(<reason>)` | a malformed feeds file, an unwritable output, or a bad argument |

`--validate` is not a step the pipeline runs, but it speaks the same language:
`gcal=ok(validate;<n>-feeds)` or `gcal=FAILED(validate;<reason>)`.

The exit codes behind those are **0** ok, **1** hard failure, **2** no feeds,
**3** partial. The human-readable line is printed just above the token:

```
[gcal-sync] feeds=1 ok=1 stale=0 failed=0 events=7 skippedOwn=2 warnings=0 window=2026-09-02..2026-09-24
```

`gcal` is one of the tokens a `FAILED` is tolerated in when the model verifies a
run: a calendar outage is insurance failing, not the agenda failing.

---

## What it reads, precisely

The window is **local days `[today-1, today+21]`**, the same window route B uses,
in the zone `config.timezone` names. Inside it:

- `DTSTART`/`DTEND` as a timed event with a `TZID`, as UTC (a trailing `Z`), as
  floating (read in your configured zone, never in the machine's), and as
  `VALUE=DATE` (all-day, with an **exclusive** end).
- `DURATION` instead of `DTEND`. Neither gives 60 minutes for a timed event and
  one day for an all-day one.
- `RRULE` with `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`,
  `BYDAY` (plain and ordinal, `2TU`, `-1FR`), `BYMONTHDAY`, `BYMONTH`, `WKST`.
- `EXDATE` and `RDATE`, in every form a real exporter writes them.
- `RECURRENCE-ID` overrides — a moved or renamed instance, or a cancelled one.
- `STATUS:CANCELLED` on a master: the series is gone.
- `TRANSP:TRANSPARENT` → `free: true`, so the planner may use the hour.
- `SUMMARY`, `LOCATION`, `DESCRIPTION` (trimmed to 300 characters) and `URL`.

`VTODO`, `VJOURNAL`, `VFREEBUSY` and `VALARM` are ignored. **Attendees are never
read at all**, so nobody's address can reach the payload, the page or a Drive
document.

Each recurring instance keeps `DTSTART`'s **wall clock** and is converted on its
own day, which is why a weekly 13:30 meeting is 17:30Z in October and 18:30Z in
November. Anything that added seven days of milliseconds would be an hour wrong,
twice a year, for six months.

---

## Turning it off

Set `calendars.gcal.enabled` to `false`. The route writes nothing and
`src/render.mjs` stops reading the file, so `meetings[]` is empty on the next
render — the two read the same key, so they cannot disagree.

To drop one calendar but keep the others, delete its entry from
`data/gcal-feeds.json` (or blank its `url`) and run once: the file is rewritten
from scratch every time, so its meetings leave the grid immediately rather than
lingering as a snapshot nobody owns.

Delete `data/gcal-feeds.json` and the daily run falls back to route B, or to
`gcal=SKIPPED(no-feeds)` if there is nothing saved for it either.
