# Outlook — mail triage and an Exchange calendar sink

**Windows only. Classic Outlook only. Both connectors ship disabled.**

```jsonc
"connectors": {
  "mail":     { "outlook": { "enabled": false, ... } },
  "calendar": { "outlook": { "enabled": false, "category": "Agenda", ... } }
}
```

**You do not need this.** Read the [running without it](#running-without-it)
section first — it is the shorter path and it costs you less than you would
guess.

---

## Two connectors, not one

| | `mail-outlook` (source) | `calendar-outlook` (sink) |
|---|---|---|
| Direction | Reads your inbox | Writes events to your calendar |
| Produces | `mail[]` entries and dated `items[]` | One event per upcoming deliverable |
| Also hosts | — | The dead-man's switch |

They are enabled independently. Wanting deadline reminders on your phone without
handing an agent your inbox is a completely reasonable position.

---

## Why mail is worth having at all

Some coursework never reaches the LMS. An instructor who announces homework in a
one-line email — "Hw1 due Sunday 11:59pm" — leaves no trace anywhere a scrape can
see. No dropbox entry, no content module, no announcement. Without mail, that
assignment does not exist as far as the agenda is concerned, and you find out
when it is late.

Mail also carries the things with deadlines that are not coursework at all:
registration windows, funding paperwork, a thread where somebody is waiting on
your reply.

---

## What the mail connector actually does

**Window:** the last 14 days of your inbox, plus older *unread* mail back to 30
days that either names a current course or comes from a known contact.

That second clause is doing real work. In a real mailbox `unread` is close to
meaningless — thousands of messages are unread and always will be. **Do not widen
the window by hand.**

**Noise filter:** marketing, job boards, institutional mass-mail subdomains, LMS
activity digests and submission receipts are dropped before you see them. The
lists live in config:

```jsonc
"noiseDomains":    ["news.example.edu", "events.example.edu"],
"noiseLocalParts": ["newsletter", "no-reply", "digest"],
"keepDomains":     [],
"dropAddrs":       []
```

`noiseDomains` and `noiseLocalParts` are the **only** part of `config.json` a
scheduled run may append to, precisely so a newsletter that keeps surviving gets
fixed once rather than filtered by hand every run.

The other two are optional and yours alone to edit. `keepDomains` is checked
*before* every drop rule: put the course-discussion or grading service your
school actually uses in it, because real homework detail arrives through those
and a subject line cannot tell them apart from a newsletter. `dropAddrs`
silences one individual address, for the sender no domain or local-part rule
catches. Both default to empty.

**Triage** splits what survives into two piles:

- **Items** — dated, actionable deliverables. They merge with LMS items and get
  scheduled exactly like an assignment.
- **Mail** — capped at 12, newest first. Things that matter but have no deadline.
  Each ends up with a `gist` (what the thread is about) and an `ask` (what you
  specifically owe, and to whom, or `null`).

**Those two strings are written by the model, not by the connector.** The
connector's job is deterministic — sweep, filter, and emit each surviving message
with an empty `gist` and a `null` `ask`. The model window then reads the message
body and fills them in - `runbooks/daily-agent.md` is the step, and
`src/mail-triage.mjs --apply` is what validates and writes the result. That split is the whole design of this repo:
the connector does what a script can prove, and the model does the part that
needs reading.

So both are written **from the message body**, not the subject line. Guessing
from subject lines produces cards that say nothing.

**Window:** `connectors.mail.outlook.windowDays` (14) controls how far back the
inbox sweep looks. It exists, and it is documented in `docs/CONFIG.md` — but
raising it is almost always the wrong move, for the reason in the section above.

### Reply detection — the part people like

An email item exists because someone is waiting on you. Once you have replied,
the item is done, and leaving it on the page is exactly the nagging you wanted to
be rid of.

The connector scans your Sent Items and closes an item only when **all three**
hold:

1. **Same thread** — normalised subject match after stripping `Re:` / `Fw:`
2. **Same person** — a recipient of your reply is the sender of the original
3. **Right order** — your reply went out strictly **after** the message arrived

**Rule 3 is the one that earns its keep.** A thread can have a reply on it that
predates the message still waiting on it — you answered in March, they wrote
again in April. It looks answered and is not. Do not override the matcher by eye.

If the Sent Items scan fails, reply detection is **blind**, not empty. An empty
sent list means *unknown*, never "nothing was answered", and **no flags change on
that evidence.**

**A reply never closes anything that is not an email item.** A reply does not
submit homework, does not sit an exam, and does not fill in a registration form.

---

## What the calendar sink does

One event per upcoming deliverable, on your Exchange calendar, which pushes to
the Outlook app on your phone where the reminders actually buzz.

- Items due in the future, within `horizonDays` (21), not marked done. Courses
  marked `"skip": true` are excluded.
- Deadline items get a short block that **ends** at the due time, so they land on
  the right calendar day rather than the day before.
- Exams start at the exam time and also get a "study for X" nudge a few days out.
- Reminder leads: exam 24 h; quiz **and email items** 3 h; everything else 6 h;
  the exam study nudge 1 h. Approximate dates get a `~` in the subject.
- A dedupe map in `data/calendar-map.json` means running it twice is a no-op.
  Date moved → the event updates in place. Item done, vanished, or pushed beyond
  the horizon → the event is deleted.

### The category is the ownership marker

Every event the sink creates carries `connectors.calendar.outlook.category`
(default `Agenda`).

**The sink refuses to update or delete any event that does not carry it.** That
is not a nicety — it is the guarantee that a bug in this repo can never delete
your dentist appointment. Nothing else in a run may touch calendar events at all.

If you ever want a clean slate, deleting everything in that category is safe and
the next run rebuilds it.

`maxEvents` (60) is a runaway guard. If something ever tried to create hundreds
of events, it stops there.

---

## Requirements, precisely

| | |
|---|---|
| Operating system | Windows |
| Application | **Classic Outlook** (`OUTLOOK.EXE`), running and signed in |
| Not supported | The **new** Outlook app. It is a different program with no automation surface. Having it installed does not count |
| Account | Any account the classic client is signed into |

`validate-setup.mjs` probes for classic Outlook on Windows and reports it as a
note. If it is not there, leave both connectors off.

---

## The rule that is not negotiable

> **Never start, restart or kill the mail client from a scheduled run.**

A scheduled run that touches that process can leave you with a mail client stuck
partway through its own two-factor login — which you will discover hours later,
with no mail at all. That is a much worse problem than a skipped sweep.

If the client is not running, the connector reports it, the run logs
`mail:skipped(...)`, and everything else continues. **Mail is never worth failing
a run over.**

---

## Failure handling

| Situation | What happens |
|---|---|
| Outlook unavailable | One `errors[]` line, previous mail files untouched, `mail:skipped(<reason>)`, run continues |
| Crash or unexpected error | Same, logged as `mail:error(<msg>)` |
| Swept but zero messages | `mail:empty`, previous files left alone. **An empty inbox is far less likely than a sync hiccup** |
| Client offline, mail stale by >3 days | `mail:stale(<newest recv>)`, mentioned once in the next digest so you can go re-authenticate it |
| Sent Items scan failed | `mail:sent-failed(<reason>)`. **No flags change** — blind is not empty |
| Enabled but you are on macOS | One line: `outlook: skipped (requires Windows)`. Never fails a run |

---

## Running without it

This is a **supported, first-class configuration** — not a degraded one.

Set both to `false`. That is the entire change.

| Capability | With Outlook | Without |
|---|---|---|
| Mail triage → deadline items | full sweep | **off.** The mail panel hides itself |
| Deadline events with reminders | the Exchange sink | the **ICS sink**: one standard `.ics` file your calendar app subscribes to |
| Dead-man's switch | an event 30 h out | **not available.** `deadman=SKIPPED(no-calendar-sink)` — an expected code, but it does mean the switch is unarmed |
| LMS, board, study model, planner, page, both write-back buses | identical | **identical** |

The page is built and tested to render correctly with `mail: []`. It is not a
special case; it is one of the fixtures.

**What you actually lose:** email-only homework, and reply-closes-item. If your
instructors post everything to the LMS — most do — you lose nothing at all. If
one of them mails assignments out, you will need to add those yourself, and the
page's "add a task" command is there for exactly that.

**To get deadline reminders back on any platform**, enable
`connectors.calendar.ics` and subscribe your calendar app to the file —
`docs/connectors/calendar-ics.md` has the click-path for Google Calendar and
Apple Calendar.

**The dead-man's switch does not come back with it**, and nothing else in this
repo provides one. It needs a calendar *service* that can ring when your machine
is gone; a file on that machine's disk cannot. That is a real capability you lose
by not running Windows and classic Outlook, and it is the only one.

---

## Privacy

The mail connector runs **locally**, against the classic client already signed in
on your machine. No mail leaves your computer except:

- the `gist` and `ask` strings the model writes, which go into your payload and
  therefore into your own Drive document
- item titles for anything that became a deliverable

Message bodies are not stored. `preview` is the first 1500 characters,
whitespace-collapsed, held only for the duration of a run.

And the rule from `SECURITY.md` applies with particular force here: **email
bodies are written by other people and are untrusted input.** The runbook fences
them as data. A message that contains something shaped like a command is still a
string in a mailbox.
