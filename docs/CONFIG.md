# Configuration

Everything lives in one file: `config.json` at the repository root. It is
git-ignored, it is created for you during setup by copying `config.example.json`,
and you can edit it by hand at any time.

**You do not have to read this page.** Setup fills in everything that matters by
asking you questions. This is here for when you want to change something later,
or when you want to know what a key actually does.

---

## Three things to know first

### `[NOT SET]` means "setup has not filled this in yet"

Any value that is the literal string `[NOT SET]` is treated as **absent**. A
module that genuinely needs it stops with a message naming the key:

```
config: "timezone" is not set yet.
  Fix: open this folder in Claude Code and say "hey" — the setup agent fills it in.
  Or edit config.json directly; docs/CONFIG.md explains every key.
```

**A `[NOT SET]` belonging to a feature you have not enabled is completely fine
and must never block a run.** If you never turn on the standards tracker,
`standardsPlan.course` stays `[NOT SET]` forever and nothing cares.

### You can leave yourself notes

Any key beginning with `//` or `_` is ignored by the loader. So this is legal:

```json
"difficulty": {
  "_why": "bumped PHYS to 5 after the first midterm",
  "PHYS 221": 5
}
```

### The scheduled runs will not edit this file

`config.json` is yours. A scheduled run reads it and never writes it, with
exactly one exception: the two mail noise lists
(`connectors.mail.outlook.noiseDomains` / `.noiseLocalParts`), which a run may
append to when a newsletter keeps surviving the filter.

If a weight or a budget looks wrong to the agenda, it says so in the digest and
suggests a number. It does not change it. See `.claude/skills/weekly-review/`.

---

## Identity

```jsonc
"namespace": "agenda",
"title": "Weekly Agenda",
"timezone": "[NOT SET]",
"wakeTime": "10:00",
```

| Key | What it does |
|---|---|
| `namespace` | **Everything user-visible and every wire identifier derives from this.** Change it and your Drive document titles, browser storage keys, calendar category and scheduled-task names all change together. Lowercase, `[a-z0-9-]`, 3–24 characters |
| `title` | The page's `<title>` and its heading |
| `timezone` | An IANA name, e.g. `America/New_York`. Every date in the system is stored as UTC and displayed in this zone. Setup fills it in |
| `wakeTime` | **A hard floor, not a preference.** Nothing is ever scheduled before this. It also bounds quiet hours: no push goes out between 23:30 and this time |

**About `namespace`:** the four Drive documents are `<ns>-data`,
`<ns>-mirror`, `<ns>-completions` and `<ns>-commands`. If you run two agendas
from one Google account — one for you, one for someone you are helping — give
them different namespaces or they will fight over the same documents.

---

## Institution

```jsonc
"institution": {
  "name": "[NOT SET]",
  "lmsHost": "[NOT SET]",
  "mailDomains": []
}
```

| Key | What it does |
|---|---|
| `name` | Appears in prose — digests, page copy — and is joined to `title` to name the calendar the **ICS sink** writes (`X-WR-CALNAME`, `src/connectors/calendar-ics.mjs`), which is what your phone's calendar app shows in its sidebar. `"Example University"` |
| `lmsHost` | Your school's LMS address, `lms.example.edu`. Two things read it: it is the fallback for `connectors.lms.canvas.baseUrl` when you leave that key unset, and it is the address `node scripts/reauth.mjs --probe` traces when it records the login chain. Setting it does not by itself connect anything |
| `mailDomains` | `["example.edu"]`. Mail from these domains is treated as "from a person at your school" rather than as a bulk sender. Only used by the optional mail connector |

---

## Courses

```jsonc
"courses": [
  { "id": 110001, "code": "PHYS 221", "name": "Classical Mechanics" },
  { "id": 110006, "code": "SEM 100", "name": "Department Seminar", "skip": true }
]
```

`id` is the **LMS course id**, not anything you make up. Setup fills these in by
asking the LMS for your enrolments, so you should never have to find one by hand.

`skip: true` keeps a course **visible in the LMS sweep** but out of:

- the calendar sink
- the materials download
- the error report

Use it for a zero-work seminar, or for a course whose content is access-denied by
design — those access-denied errors are expected and skipping stops them cluttering
every digest.

`code` is the string used everywhere else in the config (`difficulty`,
`schedule`) and on the page. Keep it short and keep it consistent.

---

## Difficulty

```jsonc
"difficulty": {
  "PHYS 221": 5, "MATH 210": 4, "CHEM 115": 4, "HIST 140": 3,
  "SEM 100": 0, "Research": 3, "Mail": 2
}
```

0 to 5, one entry per course code plus any non-course bucket.

**0 is a veto.** The study model will never allocate time to a bucket scored 0,
no matter what else is true about it. That is what `SEM 100` above is doing, and
it is the correct way to say "this course exists and I never need to work on it".

`Mail` and `Research` are built-in buckets. The side-project bucket is added
automatically from `sideProject.label`, so you do not list it here.

These numbers are a **prior**, not the final answer. The study model blends them
with grades, deadlines, backlog and observed pace to produce the allocations that
actually drive the planner. `difficulty` is what the model starts from and what it
falls back to for anything it has not scored.

---

## Timetable

```jsonc
"schedule": {
  "MATH 210": {
    "room": "LAB 110", "attend": true,
    "from": "2026-08-24", "until": "2026-12-09",
    "meets": [{ "days": ["Tue", "Thu"], "start": "13:30", "end": "14:45" }]
  }
}
```

| Key | What it does |
|---|---|
| `room` | Drawn on the page. Cosmetic |
| `attend` | **The one that changes the plan.** See below |
| `from` / `until` | The term dates for this course. Meetings outside this range are not drawn |
| `meets[]` | One entry per distinct meeting pattern. A course with a lecture and a separate lab gets two entries |

### `attend` is the important flag

- **`attend: true`** — you physically go. The planner will **never** book study
  time over those hours.
- **`attend: false`** — you do not go. The planner treats those hours as **free**,
  *and* the study model **boosts** that course, because self-study is replacing
  the lecture.

That second effect surprises people. It is deliberate: a course you are not
attending needs *more* independent work, not less, and the model says so.

---

## Study budget and the planner

```jsonc
"studyMinutes": {
  "weekday": 240, "weekend": 300,
  "weekdayWindow": ["10:30", "23:00"],
  "weekendWindow": ["10:30", "22:00"]
},
"leadTimeDays": { "exam": 7, "project": 5, "lab": 5, "homework": 3, "quiz": 2, "default": 3 },
"focus": {
  "tuning": {
    "maxBlocksPerDay": 3, "blockStepMinutes": 15, "breakMinutes": 15,
    "minBlockMinutes": 30, "maxBlockMinutes": 150,
    "dayStart": "08:00", "dayEnd": "23:00"
  }
},
"scrapeWindowDays": 60,
"announcementLookbackDays": 14
```

| Key | What it does |
|---|---|
| `studyMinutes.weekday` / `.weekend` | Total minutes a day may be filled with. **A day may come in under budget; it never comes in over** |
| `studyMinutes.weekdayWindow` / `.weekendWindow` | The local clock range the packer may use. Hard-clamped to `focus.tuning.dayStart`–`dayEnd` whatever you put here |
| `leadTimeDays` | How many days before a deadline the thing starts appearing as work to do. An exam shows up a week out; a quiz two days |
| `focus.tuning.*` | Sensible defaults. **Touch only if you know why.** A block is never shorter than `minBlockMinutes` or longer than `maxBlockMinutes`, and every start and length snaps to `blockStepMinutes` |
| `scrapeWindowDays` | How far ahead the scrape looks |
| `announcementLookbackDays` | How far back announcements are considered new |

**If you are drowning or coasting, `studyMinutes` is the knob** — not
`difficulty`. Difficulty changes *which* course gets the hours; `studyMinutes`
changes *how many hours there are*.

---

## Standards tracker (optional, off by default)

```jsonc
"standardsPlan": { "enabled": false, "course": "[NOT SET]", "label": "Standards" }
```

For a course graded on **mastered standards with retake sittings**, driven by
`data/study-plan.json`. If that means nothing to you, leave it disabled and the
whole subsystem no-ops — no card on the page, no section in the runbook, nothing.

`label` is what the card is called. `course` is the course code it tracks.

See `docs/design-notes/attendance-vs-announcement.md` for the rules about
sittings, which are the subtle part.

---

## Inbound calendar (optional, off by default)

```jsonc
"calendars": {
  "gcal": {
    "enabled": false,
    "calendarId": "primary",
    "feed": "calendar",
    "label": "Calendar",
    "maxEvents": 200,
    "skipUidSuffix": "[NOT SET]",
    "skipDescriptionMarker": "Auto-created by the agenda."
  }
}
```

**This is the direction nothing else in the config covers.** `connectors.calendar.*`
is a **sink**: it writes your deadlines *out*, to Outlook or to an `.ics` file.
This block is the opposite - it reads your own meetings *in*, so the planner
knows which hours are already spoken for and never books study on top of one.

It is off by default because it costs something the rest of the pipeline does
not: a calendar connector authorized in **your own** Claude account. The
pipeline holds no calendar credentials and never will. A scheduled run calls
that connector itself, saves the answer verbatim to a file, and hands the file
to `src/connectors/gcal-ingest.mjs`, which decides what it means.
`runbooks/heavy-run.md` section 7.0 is the exact step.

| Key | What it does |
|---|---|
| `enabled` | The switch, and it must be `true` or `false` - not `"true"`. Absent or `false` and the whole route is dormant: no connector call, an empty `meetings[]`, and a page that renders exactly as it did before |
| `calendarId` | What you pass the connector. Usually `primary`; a specific calendar's address works too |
| `feed` | Prefixes every meeting key (`<feed>\|<uid>\|<start>`). Lowercase letters, digits and hyphens, at most 24 characters. **`fb` is refused**: that prefix already names study sessions (`fb\|<day>\|<bucket>`) |
| `label` | What the page shows on the meeting band and in the day head. 1 to 24 characters |
| `maxEvents` | How many meetings one document may carry, **earliest-start first** - the events are sorted by start and the first `maxEvents` are kept, so it is the far end of the window that falls off. A whole number from 1 to 5000; the default 200 is a payload-size guard, not an opinion about your week |
| `skipUidSuffix` | **The loop guard.** `[NOT SET]` means "derive it from `namespace`", which is what you want. `""` switches the rule off |
| `skipDescriptionMarker` | The second, independent loop guard - the literal every ICS-sink event's body ends with |

Every one of those is checked when the config loads: a wrong type, a feed id
outside the charset or a `maxEvents` of `0` is a `ConfigError` naming the key,
not a value that loads quietly and then behaves as though you had left it out.
An unknown key under `calendars.gcal` warns, exactly as an unknown top-level key
does.

**The switch is read by the code, not only by the runbook.** `render.mjs` opens
`data/gcal-items.json` only while `enabled` is `true`, so turning the route off
empties `meetings[]` on the next render even if the file is still there; and
`gcal-ingest.mjs`, run while the block is off, prints one `skipped=disabled`
line, writes nothing and exits 0. A scheduled step that fires anyway is
therefore harmless, and the two halves can never disagree about what is on disk.

### The loop guard, and why there are two of them

If you also run the ICS sink, your calendar already contains this agenda's own
deadlines. Read them straight back in and every deadline is drawn twice, and the
planner refuses to plan around a block it invented itself.

So two rules mark an event as one of ours, and either alone is enough:

- **the UID.** `src/connectors/calendar-ics.mjs` writes
  `<hash>-<role>@<namespace>.agenda.local`, and a calendar that imported the file
  keeps that UID inside its own event id. This one is **proof**.
- **the description.** Every sink event's body ends with
  `Auto-created by the agenda.` This one is a **heuristic** - it can hit a real
  meeting whose body happens to quote an agenda invite - so an event skipped by
  this rule *alone* is counted and warned about rather than dropped silently.

Set `skipUidSuffix` to `""` to switch the UID rule off entirely. There is
normally no reason to.

### What it never does

It never writes to your calendar. `gcal-ingest.mjs` has no network access at all
- it reads one local file and writes one local file - and the runbook step is
restricted to the connector's **list** and **get** tools. It also never stores
attendee data: `attendees`, `organizer`, `creator` and conference details are
not read, so they cannot reach the payload, the page, or a Drive document.

---

## Side project (optional)

```jsonc
"sideProject": {
  "enabled": false,
  "label": "Side Project",
  "provider": "github",
  "org": "[NOT SET]",
  "repos": [],
  "minDailyMinutes": 60,
  "maxDailyMinutes": 180
}
```

A non-course bucket fed by a work board. It appears as its own bucket everywhere
in the UI, under whatever `label` you give it.

| Key | What it does |
|---|---|
| `enabled` | **Half of the switch, and it is off by default.** The board runs only when this *and* `connectors.board.github.enabled` are both `true`. This flag is the feature — whether the planner reserves time for a side project at all; the connector flag is the source — where that project's work comes from. Turning on only the source gives you a board full of issues with no blocks planned for them |
| `label` | The bucket name everywhere. This is what you see on the page |
| `org` | The GitHub organisation. **Required whenever the board connector is on** — the connector throws without it, and that is the key to check first if the board is empty |
| `repos` | **Empty means every repo in the org you touch.** List them to narrow it |
| `minDailyMinutes` / `maxDailyMinutes` | Bounds on how much time the planner may hand this bucket on a day with open work |

Why this exists: work outside coursework competes for the same hours. Invisible,
it loses silently to whatever the LMS happens to be shouting about.

---

## Connectors

**Every one is off unless you turn it on.** Setup turns on what it verifies.

```jsonc
"connectors": {
  "lms": {
    "brightspace": { "enabled": true, "mcpServer": "brightspace", "package": "brightspace-mcp-server@latest" },
    "canvas": { "enabled": false, "baseUrl": "[NOT SET]", "token": "[NOT SET]", "courseFilter": [] }
  },
  "mail": {
    "outlook": {
      "enabled": false, "sentItemsScan": true, "windowDays": 14,
      "noiseDomains": ["news.example.edu", "events.example.edu"],
      "noiseLocalParts": ["newsletter", "no-reply", "digest"],
      "keepDomains": [],
      "dropAddrs": []
    }
  },
  "calendar": {
    "outlook": { "enabled": false, "category": "Agenda", "horizonDays": 21, "maxEvents": 60 },
    "ics":     { "enabled": false, "path": "data/agenda.ics" }
  },
  "board":  { "github": { "enabled": false, "budgetMs": 60000 } },
  "grades": { "gradescope": { "enabled": false, "python": "python", "termLabel": "[NOT SET]" } },
  "materials": {
    "enabled": false,
    "root": "[NOT SET]",
    "categories": ["Syllabus", "Lecture Notes", "Example Problems", "Homework", "Books", "Exams", "Other"],
    "maxFileMB": 300
  }
}
```

| Key | What it does |
|---|---|
| `lms.brightspace.mcpServer` | **Must match a key in `.mcp.json`.** This is how the connector finds its server |
| `lms.brightspace.package` | **The fallback re-auth command.** `scripts/reauth.mjs` prefers the matching `.mcp.json` entry and derives the command from that; this key is what it falls back to when there is no such entry — a patched build, or a server registered outside the project. Normally you change the package by editing `.mcp.json` and this key just records your intent — see `docs/connectors/brightspace.md` |
| `lms.canvas.baseUrl` | Your Canvas address, e.g. `https://canvas.example.edu`. Falls back to `institution.lmsHost` when unset |
| `lms.canvas.token` | A personal access token from **Canvas → Account → Settings → Approved Integrations**. It carries your full permissions, so treat it like a password. **`config.json` is the only place it goes** — that file is git-ignored; `.mcp.json` and `.env.example` are committed |
| `lms.canvas.courseFilter` | Limits the sweep to these course codes or ids. **Empty means every active enrolment** |
| `mail.outlook.sentItemsScan` | Enables reply detection, which is what closes email items when you have already answered |
| `mail.outlook.windowDays` | How many days of inbox the sweep considers (14). Older *unread* mail is pulled in separately when it names a current course or comes from a known contact. **Widening this is almost always the wrong fix** — in a real mailbox `unread` is close to meaningless, and a bigger window mostly buys noise |
| `mail.outlook.noiseDomains` / `.noiseLocalParts` | The filter lists. **The one part of this file a scheduled run may append to** |
| `mail.outlook.keepDomains` | Optional. Domains that always survive the filter whatever the subject says — a course-discussion or grading service whose mail carries real homework detail. Checked *before* the drop lists |
| `mail.outlook.dropAddrs` | Optional. Individual addresses to silence, for the one-off sender no domain or local-part rule catches |
| `calendar.outlook.category` | **The ownership marker.** The sink refuses to touch any event that does not carry this category, so it can never delete something you created |
| `calendar.outlook.horizonDays` | How far ahead events are created. Beyond it, the event is deleted and recreated when the deadline comes closer |
| `calendar.outlook.maxEvents` | A runaway guard. If a bug ever tried to create hundreds of events, this stops it |
| `calendar.ics.path` | Where the `.ics` file is written, relative to the repository root (`data/agenda.ics`). The file is **rewritten whole on every run** — it is a rendering, not a store. `docs/connectors/calendar-ics.md` |
| `board.github.budgetMs` | Hard time budget. Over it, the connector gives up and reports `SKIPPED` |
| `grades.gradescope.python` | The Python executable. Checked for existence before anything is run |
| `grades.gradescope.termLabel` | **Which term to read**, e.g. `"Fall 2026"`. `adapterArgs()` passes it to the Python adapter as `--term`. Leave it unset and the adapter falls back to the system clock, which is wrong on a quarter system, wrong over a summer term, and wrong whenever you open last term's gradebook in January |
| `materials.root` | Where downloaded course files go, e.g. `~/Documents/Coursework`. One folder per course, one subfolder per category |
| `materials.categories` | The classifier's vocabulary. Judged from the file title first, the module path second |
| `materials.maxFileMB` | Skip anything bigger. Lecture videos will fill a disk |

**`connectors.materials` has no provider level and no adapter.** It is a flat
block driving the standalone `src/materials-sync.mjs`, not a connector in the
registry — which is why it does not follow the
`connectors.<kind>.<provider>.enabled` shape everything else does.

**At least one LMS connector must be enabled and configured.** Either or both is
fine — running Brightspace and Canvas together is supported, and `merge.mjs`
deduplicates anything that appears in both. With none, `scrape.mjs` exits 1 with
`scrape: no LMS source is enabled.` plus a four-line fix — not a stack trace. The
preflight fails on the same condition.

A connector that is enabled but cannot run on this machine (Outlook on macOS,
say) produces **one** line in the error list and is otherwise a no-op. It never
fails a run.

Adding a connector of your own: `docs/EXTENDING.md`, or say `/add-source`.

---

## Transport

```jsonc
"drive": {
  "enabled": true,
  "connectorName": "Google Drive",
  "maxEmitChars": 12000,
  "maxMirrorChars": 20000,
  "mirror": true
}
```

| Key | What it does |
|---|---|
| `connectorName` | The display name your Claude account shows for its Drive connector. The page also probes for one that has the right tools, so this is a hint rather than a hard requirement |
| `maxEmitChars` | **A real budget, not a guess.** The agent has to *type* the payload into a document, so its size costs tokens. `render.mjs` applies slim tiers until it fits and then prints which tier it used |
| `maxMirrorChars` | The same cap for the state mirror. Over it, the pack exits 3 naming the biggest contributors |
| `mirror` | Whether heavy runs push a full state mirror |

**Raising `maxEmitChars` is usually the wrong fix.** If a run reports a high
tier every time, the payload is genuinely large — many courses, many
descriptions — and the honest answers are to reduce `scrapeWindowDays` or accept
that far-off items lose their blurbs. See `docs/PROTOCOL.md` for what each tier
drops.

---

## Output and notifications

```jsonc
"artifact": { "url": "[NOT SET]" },
"notifications": {
  "calendar": false,
  "emailDigest": "off",
  "digestTo": "[NOT SET]",
  "push": { "newAssignments": true, "dueSoonUnsubmittedHours": 48 }
}
```

| Key | What it does |
|---|---|
| `artifact.url` | Filled after you publish the page once. See `docs/ARTIFACT.md` |
| `notifications.emailDigest` | `"off"` · `"morning-only"` · `"every-run"`. **`"every-run"` is almost always a mistake** |
| `notifications.digestTo` | Where the digest goes |
| `push.newAssignments` | Whether a genuinely new item within 7 days may earn the run's one push |
| `push.dueSoonUnsubmittedHours` | The window for a "this closes soon" push |

**At most one push and one email per run, ever.** That cap is not configurable,
and being behind buys *priority inside* it, never an extra send. Zero
notifications is the expected outcome of a run, and silence is the goal.

Quiet hours are fixed at 23:30 to `wakeTime`: **no push at all** in that window,
however urgent. Calendar alarms are never suppressed — you set those up to be
un-ignorable, and "stop nagging me" is not "let me miss my exam".

---

## Scheduling (Windows)

```jsonc
"scheduler": {
  "taskPrefix": "Agenda",
  "morningAt": "07:03", "eveningAt": "18:07",
  "quietUntil": "07:23",
  "syncWindow": ["09:00", "23:00"], "syncGapHours": 3,
  "graceMinutes": 20, "debounceMinutes": 25, "maxRescuesPerLane": 2
}
```

| Key | What it does |
|---|---|
| `taskPrefix` | Task names become `<prefix> Morning`, `<prefix> Evening`, `<prefix> Sync`, `<prefix> StaleCheck`, `<prefix> AuthRetry` |
| `morningAt` / `eveningAt` | When the two heavy runs fire. The odd minutes are deliberate — round times are congested |
| `quietUntil` | The heavy lane never fires between midnight and this time. A full run at 03:00 can send mail |
| `syncWindow` / `syncGapHours` | When the light lane runs, and how long a gap counts as "gone quiet" |
| `graceMinutes` | How late a run may be before the watchdog calls it missed |
| `debounceMinutes` | Logon, unlock and resume can all land within one second. Nothing fires twice inside this window |
| `maxRescuesPerLane` | **Two.** Two attempts is generous; a third is a loop, not a rescue. See `docs/design-notes/watchdogs.md` |

Change these here, then re-run `scripts\install-tasks.cmd` — it reads this block
and re-asserts every task. **Do not edit a task by hand in the Task Scheduler
UI**, because the next run of the installer will assert it back.

macOS and Linux scheduling is in `docs/SCHEDULING.md`.

---

## `authRetry` — the hourly "can we still log in?" lane

```jsonc
"authRetry": {
  "enabled": true,
  "sessionFiles": [".brightspace-mcp/session.json", ".d2l-session/session.json"],
  "minIntervalMinutes": 50,
  "pushHook": "[NOT SET]"
}
```

| Key | What it does |
|---|---|
| `enabled` | `false` switches the lane off entirely. It then reports `lane-disabled` and touches nothing. The scheduled task can stay registered |
| `sessionFiles` | Paths **relative to your home directory** that the LMS auth CLI mints a session into. The first one that exists is read; only `createdAt`, `expiresAt` and the file's mtime are ever looked at. **An empty list opts the lane out** — see below |
| `minIntervalMinutes` | The floor between two login ATTEMPTS. Default 50, against an hourly tick, so it never blocks the intended cadence — it collapses a burst (logon + unlock + resume + the hourly tick can all land in one second) into one fire |
| `pushHook` | Optional path to a script run when a number-matching prompt appears. Relative paths resolve against the repo root. Unset means the platform default: `data/push-hook.cmd` on Windows, `data/push-hook.sh` elsewhere |

### Why an empty `sessionFiles` is an opt-out, not a bug

Without a session file this lane cannot tell "the token expired" from "nobody
ever logged in". It would land on `no-session` every hour, forever, firing
logins that nothing asked for. So a connector that keeps no readable session file
must opt **out**: set `"sessionFiles": []` and the lane reports
`no-session-source` and stays quiet. Canvas is the shipped example — it
authenticates with a token in `config.json` and has no session to expire.

### The push hook, and what to put in it

When the school's second factor is **number matching**, the sign-in page renders
a short number that the user has to type into their authenticator app within
about 60-90 seconds. A headless login raises that prompt where nobody can see it,
so the lane relays the number the instant it appears, over three channels:

1. `data/auth-mfa.json` — always, first, because it cannot fail.
2. An on-screen alert on the machine itself — a `WScript.Shell` popup on Windows,
   `osascript` on macOS, `notify-send` on Linux. No network, no configuration.
3. **The push hook, if you wrote one.** This is the seam for a real *phone*
   notification, and it is the only channel that reaches you when you are not at
   the machine.

The hook is run fire-and-forget with the message as `%1` / `$1` and the number as
`%2` / `$2`. It must return immediately — the login is sitting in a ninety-second
window and nothing may block it. On Windows the hook is invoked **through
`cmd.exe`**, so a `.cmd` or `.bat` file works (a batch file cannot be spawned
directly on current Node), and it is **not** run as a detached child — a detached,
console-less Windows process is reaped before `curl` finishes its network write,
so the push would be silently lost.

**The recommended implementation is one line of `curl` to
[ntfy](https://ntfy.sh)** — a free push service with no account to create. Install
the ntfy app on your phone, subscribe to one long random topic name, and post to
it:

`data/push-hook.cmd` (Windows):

```bat
@echo off
curl.exe -s -m 8 -H "Title: Agenda login" -H "Priority: high" -d "%~1" https://ntfy.sh/your-long-random-topic-name
```

`data/push-hook.sh` (macOS / Linux, `chmod +x`):

```sh
#!/bin/sh
curl -fsS -m 8 -H "Title: Agenda login" -H "Priority: high" -d "$1" https://ntfy.sh/your-long-random-topic-name >/dev/null 2>&1
```

That delivers *"Agenda login: enter 42 in your authenticator app"* to your phone
in under a second. **The topic name is the only secret** — anyone who knows it can
read and post to it — so make it long and random. It is a *low-value* secret: an
MFA number is useless to a stranger and expires in about ninety seconds. If you
would rather not use the public server, ntfy self-hosts, and **Pushover or a
Telegram bot drop into the same hook** unchanged — the `pushHook` seam does not
care which you pick, and no provider is hard-coded anywhere.

> **Not the Claude `PushNotification` tool.** A `claude -p … --allowedTools
> PushNotification` one-liner looks tempting, but it does **not** work as a
> background push hook: `PushNotification` only reaches your phone through a live
> Remote-Control-connected Claude session, and a hook spawned fresh from the
> scheduler has no such connection — it reports success and delivers nothing. Use
> the `curl` hook above.

Nothing in this repository hard-codes a provider, and `data/` is git-ignored, so
whatever you put in the hook stays on your machine.

**If the number never arrives at all**, the capture selector in
`vendor/brightspace-mcp-server/entra-duo-sso.patch` is the place to look —
`docs/TROUBLESHOOTING.md` has the procedure, and that selector is flagged
unverified in production for a reason.

---

## Environment variables

`.mcp.json` supports `${VAR}` and `${VAR:-default}` interpolation in `command`,
`args`, `env`, `url` and `headers`. `.env` backs it and is git-ignored;
`.env.example` is the committed template.

You only need this if you point at a self-hosted or token-authenticated server.
The default configuration uses none.

**Never commit `.env`. Never put a token in `config.json` or `.mcp.json`.**
