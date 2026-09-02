# The wire protocol

Everything in this repo is either a **pipeline** that runs on your computer or a
**page** that runs in a browser somewhere else. They never talk to each other
directly. They pass plain-text documents through Google Drive, and this file is
the contract for those documents.

Read this if you are changing `src/render.mjs`, `src/completion.mjs`,
`src/command-ingest.mjs`, `src/lib/envelope.mjs` or `web/page-template.html` —
those five files are the only ones that touch the wire. Everything else works on
JSON that has already been decoded.

Two conventions run through the whole document:

- **`<ns>` is `config.namespace`**, default `agenda`. Every document title,
  browser storage key, calendar category and scheduled-task name derives from
  it. Change the namespace and all of them move together. Nothing on the wire
  ever contains the project's name.
- **The user's agent is the transport.** Nothing here makes a network call of
  its own. The pipeline writes a file; an agent reads that file and types its
  contents into a Drive document; the page reads that document with the viewer's
  own connector. That is why size is a hard budget and why every envelope is
  designed to be transcribed by something that can make mistakes.

---

## 1. The four documents

| Title | Written by | Read by | Envelope | Trashed by |
|---|---|---|---|---|
| `<ns>-data` | the agent, after `render.mjs` | the page | `AGD2` | the agent, after a successful create |
| `<ns>-mirror` | the agent, after `drive-bundle.mjs --pack` | you, in a disaster | `AGM2` | the agent |
| `<ns>-completions` | the page | `completion.mjs --ingest` | `AGC1` | the pipeline, after it consumes one |
| `<ns>-commands` | the page | `command-ingest.mjs --apply` | `AGQ1` | the pipeline, after it consumes one |

Three rules hold for every write, and breaking any of them loses data:

1. **Create, then trash. Never the other way round.** The Drive connector's
   `update_file` is metadata-only — it cannot replace a document's body — so a
   new version is always a *new document*. Create the new one first; only then
   trash the older ones with the same title, matched **by id**. A crash between
   the two steps leaves a duplicate, which readers handle. A crash the other way
   round leaves nothing.
2. **Match by title exactly.** `<ns>-data`, `<ns>-completions` and
   `<ns>-commands` are three different titles. Trashing a completions document
   while cleaning up data documents destroys an unconsumed mark.
3. **The page only ever creates.** It has no way to know whether the pipeline
   has already consumed a document, so it never trashes one. Cleanup is the
   pipeline's job.

---

## 2. The envelopes

An envelope is one line of text. It has to survive being pasted into a Google
Doc, which means it can contain only characters a document will not "helpfully"
reformat, and readers must strip whitespace before decoding — a Doc inserts soft
line breaks wherever it likes.

```
AGD1.<base64(utf8(json))>.END                            plain
AGD2.<crc32>.<base64(gzip(utf8(json)))>.END              gzipped
AGM1.<base64(utf8(json))>.END                            plain, state mirror
AGM2.<crc32>.<base64(gzip(utf8(json)))>.END              gzipped, state mirror
AGC1.<base64(utf8(json))>.END                            marks bus
AGQ1.<base64(utf8(json))>.END                            command bus
```

`<crc32>` is exactly **eight lowercase hex characters**: standard IEEE CRC-32,
computed over the **gzip bytes**, before base64. The canonical check value is
`crc32("123456789") === "cbf43926"`.

### Why gzip, and why only on two of them

`render.mjs` produces roughly 48 KB of JSON. As plain base64 that is about
65,000 characters, and an agent has to *read that file and emit every one of
those characters* into a `create_file` call — well over a hundred thousand
tokens in each direction, which does not fit in one context window. Gzip on JSON
with highly repeated keys compresses about six times, so the same payload
becomes roughly 6,700 characters: about 2,000 tokens, and it fits in one message
with room to spare.

`AGC1` and `AGQ1` stay plain and uncompressed because no agent is in their path:
the page writes them itself through its Drive connector, and they are small.
A browser can gzip, but making it do so would buy nothing and cost the ability
to eyeball a document when something goes wrong.

### Why a checksum

The realistic corruption here is not a bit flip on the wire — it is a
transcription that was truncated or subtly altered, because a language model
typed it. **A truncated gzip stream still starts decompressing.** Without the
checksum, a document that lost its last 500 characters would decode into a
partial JSON string, fail to parse, and be reported as "unreadable" if you were
lucky — or, with a different truncation point, parse into a *shorter week* that
looks entirely plausible. The CRC turns every one of those into the same loud,
unambiguous refusal.

Readers must therefore:

1. strip all whitespace from the base64 body;
2. base64-decode;
3. verify the CRC against the decoded bytes **before** attempting to decompress;
4. only then gunzip and parse.

A mismatch is an error, never a fallback to "try parsing anyway".

### Reader tolerance

| Input | Correct behaviour |
|---|---|
| Unknown prefix | refuse |
| Missing `.END` | refuse |
| Empty body | refuse |
| Whitespace inside the base64 | accept, strip it |
| CRC mismatch | refuse, and say *checksum* |
| Truncated body | refuse (the CRC catches it) |
| `AGD2` where a synchronous reader is used | refuse (see §3) |
| Payload `v` that is not `4` | refuse |

The page's readers return `null` for every one of these. They never throw out of
`refresh()`, because a bad document must leave the page showing the copy it
already had.

### Size budget

`render.mjs` applies **slim tiers** in order until the packed `AGD2` string fits
`config.drive.maxEmitChars` (default 12,000):

| Tier | Dropped |
|---|---|
| 0 | nothing |
| 1 | `desc` on items due outside `[now-14d, now+21d]` |
| 2 | announcements older than 7 days; `mail[]` capped 12 → 8 |
| 3 | `done[]` window 14 d → 7 d; `board[]` cap 10 → 5 |

If it is still over budget after tier 3 the payload is **not truncated**.
`render.mjs` writes `data/payload.oversize.txt`, prints a loud warning, and the
runbook logs `drive=SKIPPED(oversize)`. The copy embedded in the HTML is always
complete, so the page keeps working — it just stops getting live updates until
the week shrinks or the budget is raised.

---

## 3. The build interface

The page is a static artifact. It cannot read `config.json`, it cannot read
`data/`, and it cannot make a network call before its first paint. `render.mjs`
therefore substitutes two markers in `web/page-template.html`, by plain string
replacement:

```js
var EMBEDDED = "__PAYLOAD__";      // an AGD1 string, quotes included
var CFG = __PAGE_CONFIG__;         // a JSON object, no quotes
```

**Each marker appears exactly once in the template — not even a comment may
spell one again.** A plain `String.replace` fills in the first occurrence, so a
second mention would be substituted instead of the real one and the page would
boot holding a placeholder. `test/page-ui.test.mjs` asserts the count.

The embedded copy is **`AGD1`, never `AGD2`**. It is decoded synchronously by
`decodePayloadSync` so the first paint needs neither a network round trip nor a
promise; gunzipping is asynchronous in a browser and would make the page flash
empty on every open. `AGD2` exists only in Drive, where the read is already
asynchronous.

### `__PAGE_CONFIG__`

```jsonc
{
  "ns": "agenda",
  "timezone": "America/New_York",
  "title": "Weekly Agenda",              // the <title> and the <h1>
  "leadTimeDays": { "exam": 7, "project": 5, "lab": 5, "homework": 3, "quiz": 2, "default": 3 },
  "docTitles": {
    "data": "agenda-data",
    "completions": "agenda-completions",
    "commands": "agenda-commands"
  },
  "storageKeys": { "marks": "agenda.marks.v1", "blocks": "agenda.blocks.v1" },
  "buckets": { "side": "Side Project", "mail": "Mail", "research": "Research" },
  "standardsPlan": { "enabled": false, "course": null, "label": "Standards" },
  "wakeTime": "10:00",
  "maxWeight": 5,
  "driveConnector": "Google Drive"
}
```

`src/lib/config.mjs` produces this object from `config.json` via `pageConfig()`.
The page falls back to the defaults above for any missing key, so a half-written
object cannot white-screen it, but a *wrong* one silently points the page at the
wrong documents — which is why `derive()` is the single place these names are
computed and nothing re-derives them.

### Browser storage

The page keeps two keys in `localStorage`, both named by the build:

| Key | Holds |
|---|---|
| `<ns>.marks.v1` | `{ "v": 1, "marks": {...}, "cleared": {...} }` — this browser's optimistic marks and tombstones |
| `<ns>.blocks.v1` | block edits this browser has made, with their sync state |

Two agendas with different namespaces never share a key, so one person can run a
term agenda and a project agenda in the same browser.

---

## 4. Payload v4

`v` is `4` and readers refuse anything else. There is no compatibility window:
the pipeline and the page are published together.

```jsonc
{
  "v": 4,
  "scrapedAt": "2026-09-02T12:00:00.000Z",
  "tz": "America/New_York",
  "weights": { "MATH 210": 4.2, "Side Project": 3.0 },
  "schedule": [ ClassMeeting ],
  "board":    [ BoardEntry ],
  "done":     [ { "k": "...", "at": "ISO", "via": "user", "state": "cancelled|cleared" } ],
  "items":    [ Item ],
  "announcements": [ { "c": "PHYS 221", "t": "Office hours moved", "p": "ISO" } ],
  "mail":     [ Mail ],
  "standardsPlan": { ... },      // omitted entirely when the feature is off
  "focus":    [ { "d": "2026-09-02", "blocks": [ Block ], "note": "optional" } ],
  "errors":   [ "lms: get_my_grades timed out for MATH 210" ]
}
```

```jsonc
Item  { k, c, cid, t, d, ty, s, a?, src[], g?, desc?, u }
Block { c, what, why, t?, mins, pinned?, kept? }
ClassMeeting { c, attend, room, days[], start, end, from, until }
BoardEntry   { repo, n, t, kind, u, upd }
Mail  { id?, from, addr, subj, recv, tag, gist, ask, replyBy }
```

Field notes that are easy to get wrong:

- **`weights`** are what `study-model.mjs` *allocated*, on a 0–`maxWeight` scale,
  as fractions. `config.difficulty` is only the prior that feeds the model, and
  only the fallback when the model has not run.
- **`s` on an Item is tri-state.** `true` = a source said it was submitted.
  `false` = a source explicitly said it was **not**. `null` = *unknown*. Never
  emit `false` because a field was absent — see §6.
- **`a`** marks a date the instructor gave only to the week, not to a day. The
  page draws it with a `~`.
- **`focus`** is exactly seven days, today first.
- **`standardsPlan`** is absent, not null, when the feature is off. The page
  additionally requires `CFG.standardsPlan.enabled === true`, so the card cannot
  appear because of a stale payload.
- **`board`** is empty when no board connector is enabled. The page hides the
  panel. The same is true of `mail`.

---

## 5. Key spaces

There are exactly two, and they can never collide.

**Deliverable key** — one per thing that can be handed in:

```
${courseId}::${type}::${normTitle(title)}
```

`normTitle` lowercases, collapses whitespace and strips punctuation, so a title
that gains a comma between two scrapes keeps its key. Items that came from mail
rather than the LMS use `courseId = 0`.

**Session key** — one per *study session*, meaning one bucket on one day:

```
fb|${YYYY-MM-DD}|${bucket}
```

A session key always starts `fb|`; a deliverable key never can. `isSessKey()` is
a three-character prefix test, and that is the whole distinction.

This separation is load-bearing. **Ticking a study block closes that session.
Ticking a card closes the deliverable.** Conflating them means one tick on one
block marks the deadline, which strikes through every other block, its grid chip
and its card — the user says "I did an hour of this" and the agenda hears "this
is handed in". The tie between a block and the deadline it serves survives, but
only in the direction that is correct: marking the *deliverable* paints its
blocks; marking a *block* paints nothing but that block.

The bucket in a session key may itself contain a `|` only if a course code did,
which `config.json` forbids — but parsers join the tail anyway rather than
truncating.

---

## 6. The completion ledger

### Three states, not two

| State | Meaning |
|---|---|
| `done` | finished |
| `cancelled` | "won't do" — settled, but nothing was accomplished |
| *absent* | still owed. A key with no surviving entry is simply not marked. |

`cancelled` is not cosmetic. Without it the only way to clear something you have
decided to skip is to lie and call it done, which then feeds back into the study
model as work completed.

### Six inputs, one rule

Marks arrive from six places — three carrying marks and three carrying
tombstones:

| Input | Carries |
|---|---|
| `payload.done[]` entries | what the pipeline has recorded |
| `payload.done[]` entries with `state: "cleared"` | revocations the pipeline knows about |
| Drive `AGC1` documents, `marks` | what earlier bus documents already hold |
| Drive `AGC1` documents, `cleared` | tombstones from other devices |
| `localStorage` `marks` | this browser's optimistic marks |
| `localStorage` `cleared` | this browser's revocations |

**The resolution rule, everywhere:** for a given key, the entry with the newest
`at` wins, across marks and tombstones together. **On an exact tie the mark beats
the tombstone.** An unparseable or missing `at` sorts as the oldest thing there
is, so the tie rule hands the key to the mark — the conservative direction.

**The one exception is origin.** A completion whose `via` is `grade`,
`gradescope` or `reply` is a pipeline *observation*, not a user decision. It is
pinned before resolution runs and can never be cleared or cancelled from the
page or the chat panel. Only `via: "user"` and `via: "page"` are revocable. This
is what stops a stale browser from arguing away something the gradebook said.

A mark the **user** made is theirs to take back for as long as it exists,
whether or not it has synced. Users are allowed to be wrong about their own work.

### Tombstones, and why `done[]` republishes them

Clearing a mark writes a **tombstone**, not a deletion, because **absence never
means removal**. Every store here is merged from several sources; a key that has
simply vanished from one of them is indistinguishable from a key that source
never had.

This creates a specific failure that `done[]` exists to prevent. Suppose you
mark something done on your phone, the pipeline absorbs it into
`data/user-completions.json`, and then you take the mark back in chat on your
laptop. The pipeline now knows the mark is revoked. But `done[]` can otherwise
only ever say what *is* marked — and your phone's `localStorage` still holds its
own copy of the original mark, which it will keep re-asserting forever.

So **`done[]` is a ledger, not a list.** It republishes the last 14 days of
tombstones alongside the marks, as entries with `state: "cleared"`. That is the
only channel the pipeline has for saying "this was revoked", and without it a
revoked mark is immortal on any browser that ever saw it.

A `cleared` entry can only ever *be* a tombstone: it never becomes a mark, it
never enters the pinned set, and it therefore can never unpin a gradebook
observation. Readers route it by `state`, not by `via`, so a malformed entry
still cannot do harm.

Page-born tombstones age out of `localStorage` after 30 days once they have
synced, which is comfortably longer than the 14-day republication window.

### The `AGC1` body

```jsonc
{
  "v": 1,
  "marks": {
    "110002::homework::problem set 4": { "at": "ISO", "via": "user", "state": "done" },
    "fb|2026-09-02|MATH 210":          { "at": "ISO", "via": "page", "state": "cancelled" }
  },
  "cleared": {
    "110003::quiz::quiz 1": { "at": "ISO", "via": "user" }
  }
}
```

The page writes the **full page-born set on every save**, never a delta. A
document that lands twice is therefore harmless, and a document that is lost
costs nothing as long as a later one arrives. The pipeline reads every matching
document, merges by the rule above, and trashes what it consumed.

Entries the page received *from* the payload are excluded from what it writes
back: echoing them would be the page telling the pipeline something the pipeline
just told the page. Tombstones the user made *here* always go, including for a
mark that has already round-tripped — that is precisely the case the bus exists
to serve.

The page batches saves on a **4-second debounce**: one document per burst of
clicks, never one per click. Every mark is in `localStorage` before any of this
runs, so a failed save costs the delay and nothing else. A rejected write is
**not** proof the document was not created, so retry is a button and never
automatic.

---

## 7. The command bus

`AGQ1` carries edits made on the page — currently block drags — plus anything an
agent has been asked to apply on the user's behalf. It is strictly one-way: the
page creates these documents and never reads, searches or trashes one.

```jsonc
{ "v": 1, "issuedAt": "2026-09-02T15:04:05.000Z", "commands": [ /* … */ ] }
```

### Fail closed, in two phases

**Phase 1 validates every command** — structure, arguments, and state guards
(does that item exist, is that a real bucket, is there a sitting on that date).
If *any* command is bad, **nothing** is applied and the whole document is refused
with every offender named. Phase 2 applies a document already known to be good.
`--validate` is phase 1 with phase 2 skipped.

The alternative — apply what parses, refuse the rest — means a document written
on a phone with one typo half-lands and the user has no way to know which half.
A refused document is re-sent in ten seconds; a half-applied one is a mystery for
a week.

### The seven ops

Everything not on this list is refused **by name**.

| Op | Arguments | What it does |
|---|---|---|
| `defer` | `{k, to, why}` | Records an override: this item is now due later. **Never for `ty: "exam"`** — the institution sets that date, not a phone. `to` must be later than the current effective due, so a defer can only buy time, never manufacture an alarm. Written to `data/overrides.json`; the scraped date in `data/latest.json` is never rewritten, so the override is reversible by deleting one key. |
| `add` | `{c, t, d, ty, desc}` | A task the phone knows about and the LMS does not. A real ISO `d` is mandatory (undated things are not items) and `ty` must be `"task"` — deliverables come from the scrape, never from a thumb. Appended to `data/phone-items.json` with `cid: 0` and `src: ["phone"]`. |
| `note` | `{day, text}` | One line appended to `data/focus-note.txt`. 90 characters, because it has to fit on a focus strip. |
| `logstudy` | `{c, mins, note}` | Routed through `study-model.mjs --log` as a child process. The bus never hand-edits the study log: the bucket check, the append semantics and the mirror into the materials tree live in one place. |
| `attending` | `{date, value}` | Evidence about a standards sitting, written onto the matching `data/study-plan.json` entry. Refused when no sitting has that date — inventing a sitting from a phone is exactly the phantom exam the rules forbid. |
| `snooze` | `{hours, why}` | `data/snooze.json`. Suppresses **pushes only**. It never suppresses a calendar alarm: those are already on the phone, the user set them up to be un-ignorable, and a snooze means "stop nagging me", not "let me miss my exam". |
| `block` | `{day, c, t, mins, prev?}` | A focus block the user dragged or resized on the published grid. Written to `data/block-edits.json` and nothing else: a block is a plan for an hour, not a fact about one, so it never touches items, marks or the study log. `prev` is what the engine had shipped for that `(day, c)` before the drag — the learning sample — and is optional, because a block the user invented has no "before". |

**`done` is refused, explicitly.** Completion is not expressible on this bus.
Marks travel on `AGC1`, or through `completion.mjs --done "<query>"`. One channel
for "it is finished", forever, so the append-only guarantee on
`data/user-completions.json` has exactly one door.

### Global guards

| Condition | Result |
|---|---|
| `v !== 1` | refuse (exit 5) |
| `issuedAt` unreadable | refuse (exit 5) |
| `issuedAt` older than 72 h | refuse as **stale** (exit 4) — it describes a world that has moved on |
| more than 25 commands | refuse — a runaway document is not a user |
| this `issuedAt` already in `data/command-log.json` | refuse — a document that lands twice must not apply twice |
| any unknown op | refuse the **whole** document, naming the offender |

Every applied command appends `{at, op, args, result, doc}` to
`data/command-log.json`. Refusals are printed, not logged: the log is the record
of what changed on disk, and nothing changed.

### Block guards

In order, and every one refuses the whole document:

1. `c` is a focus bucket — `config.difficulty[c] > 0`, or the side-project label.
   A zero-difficulty course is never a focus bucket, so a drag cannot give it an
   hour either.
2. `day` is a real `YYYY-MM-DD` inside `[today-1, today+7]` **local**. Yesterday
   is in range on purpose: a block moved at 00:30 is usually about the day that
   just ended.
3. `t` and `mins` are **snapped to 15 minutes** (round to nearest) *before* any
   range check, so `20:22`/`97` is judged as `20:15`/`90`. The page snaps too,
   but the page's snap is a courtesy — this one is the guarantee, because the
   page is the one part of the pipeline that a stale browser tab can run an old
   copy of.
4. After snapping, `mins` is in `[15, 240]`. Seven minutes snaps to zero and is
   refused; that is the intended reading of "snap, then check".
5. After snapping, the block occupies no minute before 08:00 and none after
   23:59. `23:00 + 60` ends the day and is legal; `23:30 + 60` would spill into
   tomorrow and is not. This window is deliberately wider than the planner's own,
   because a user who drags a block to 23:00 has decided something the planner is
   only allowed to guess at.
6. `prev`, when present, obeys the same clock and snapping rules. A `prev.mins`
   of 0 would make the learning ratio infinite, so a `prev` outside `[15, 240]`
   is malformed rather than merely odd.

Nothing here consults the timetable: a block that overlaps a class meeting is
**accepted**. The user chose that slot on a grid where the meeting was visible,
and the user wins. That premise still holds under the trimmed one-frame grid, and
is in fact stronger there: the frame is computed to include every class meeting
in the week, so a meeting is not merely drawable but guaranteed on screen.

**The layout does not reach the wire.** The grid's hour range, its edge rails and
its fold are presentation only. A block dropped in hours that were folded a
moment earlier emits exactly the same `{day, c, t, mins, prev?}` as any other,
and is clamped by the same rules above.

The page batches block edits on a **3-second debounce** and marks them *sent*,
not *confirmed*. Only a payload that comes back carrying the slot proves the
engine accepted it; until then the page holds its own overlay, for up to 24 hours.

---

## 8. Exit codes

Every CLI in this repo treats its exit code as the contract. Callers act on the
code and never parse the output.

| Command | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| `src/scrape.mjs` | ok | error | LMS auth failure | — | — | — | — |
| `src/render.mjs` | ok | error | — | — | — | — | — |
| `src/completion.mjs` | recorded / cleared / already in that state / listed / ingested | — | usage | `data/latest.json` missing or unwritable store | ambiguous query, candidates printed | no match | refused — a transition the protocol disallows |
| `src/command-ingest.mjs` | applied (or validated clean) | apply failed after validation passed | usage | — | **stale** document, nothing applied | **refused** document, nothing applied | — |
| `src/drive-bundle.mjs` | packed or restored | error | usage | over the size cap — nothing written, caller logs a skip | — | — | — |
| `src/behind.mjs` | a verdict was printed, *including* "behind" | — | usage | — | — | — | — |
| `src/study-model.mjs` | ok | — | usage | a required input is missing | `--log` bucket is not a known bucket | — | — |
| `src/stale-check.mjs` | a decision was reached, including "fired nothing" | the watchdog itself is broken | — | — | — | — | — |
| `src/auth-retry.mjs` | a decision was reached, **including a login that failed** | the lane itself is broken | — | — | — | — | — |
| `src/deadman.mjs` | armed, **or** skipped because no calendar sink is enabled | failed to arm — the previous event was **left in place** | the calendar backend is unavailable (`SKIPPED(com)`) | — | — | — | — |
| `src/materials-sync.mjs` | ok, including "nothing new" | error | LMS session expired | skipped (disabled in config) | — | — | — |
| `src/connectors/board-github.mjs` | file written | error on our side | — | skip — `gh` missing, unauthenticated, out of budget, or the service is unreachable | — | — | — |
| `src/connectors/mail-outlook.mjs` | ok | error | — | mail platform unavailable — caller skips mail, never fails | — | — | — |
| `src/connectors/calendar-outlook.mjs` | clean | hard failure | ran, but one or more calendar operations failed | — | — | — | — |
| `src/connectors/calendar-ics.mjs` | the file was written | could not write it | — | — | — | — | — |
| `scripts/reauth.mjs` | `ok` | `FAILED` — anything else | `NO-CREDS` — nothing saved yet | — | **usage** — an unknown or conflicting flag; *nothing was run* | `BAD-CREDS` — rejected password | `MFA-PENDING` — push never approved |

`reauth.mjs` is the one script here that reaches past 6: **exit 7 is
`NO-PACKAGE`**, the LMS server package is not installed. Its full row, all eight
codes wide, is in `AGENTS.md` → "Exit codes".

Two of these deserve emphasis:

- **`behind.mjs` exits 0 when the verdict is "behind".** A verdict is not an
  error, so a caller never has to distinguish bad news from a broken script.
- **`auth-retry.mjs` exits 0 when the login it fired failed.** Same principle: a
  failed login is that lane working, not that lane broken. Exit 1 means the lane
  itself could not reach a decision. What it *did* is on the `AUTH ` line it
  appended to `data/runlog.txt`, and only when it actually fired.
- **`deadman.mjs` exit 1 leaves the previous event in place.** A failed re-arm
  must not disarm the switch you already had.
- **`reauth.mjs` uses 5, 6 and 7 and skips 3 and 4.** The gaps are deliberate:
  the codes were chosen so that a runbook can branch on "retry later" (6) versus
  "a human must fix the account" (5) versus "install something" (7) without
  parsing any output. The full table, with its token per code, is in `AGENTS.md`.
  Unknown flags are a hard error rather than a silent fall-through to the
  default behaviour.

---

## 9. State files

Everything under `data/` is generated, git-ignored, and safe to delete — you
lose history, not correctness, except for the two marked **append-only**.

| File | Written by | Shape |
|---|---|---|
| `latest.json` | `scrape.mjs` | `{ scrapedAt, items[], mail[], announcements[], board[], grades[], errors[] }` |
| `previous.json` | `scrape.mjs` | the previous `latest.json`, verbatim |
| `diff.json` | `scrape.mjs` | `{ added[], removed[], changed[] }` |
| `descriptions.json` | the LMS connector | `{ "<itemKey>": "text" }` |
| `user-completions.json` | `completion.mjs` | **append-only.** `{ v, completions: {"<k>": {at, via, state}}, cleared: {"<k>": {at, via}} }` — `v` is the on-disk format number and is unrelated to the payload and envelope versions |
| `block-edits.json` | `command-ingest.mjs` | `{ edits[], history[] }`. `edits[]` holds the live overrides, latest per `(day, c)`, pruned before `today-1`; `history[]` is **append-only**, newest 200 kept, and is the learning corpus |
| `overrides.json` | `command-ingest.mjs` | `{ "<itemKey>": { to, why, at } }` |
| `phone-items.json` | `command-ingest.mjs` | `[ Item ]` with `cid: 0`, `src: ["phone"]` |
| `command-log.json` | `command-ingest.mjs` | `[ { at, op, args, result, doc } ]` — the record of what changed on disk |
| `focus-note.txt` | `command-ingest.mjs` | one `"<day>: <text>"` line per note |
| `snooze.json` | `command-ingest.mjs` | `{ until, why }` |
| `study-model.json` | `study-model.mjs` | `{ generatedAt, alloc: {"<bucket>": 0..maxWeight}, why: {...} }` |
| `study-log.json` | `study-model.mjs --log` | `[ { at, c, mins, note } ]` |
| `study-plan.json` | you, or an agent | the standards plan: `{ course, standards[], sittings[] }` |
| `focus-plan.json` | `render.mjs` | the plan that was published, so the next run can tell what changed |
| `board-items.json` | the board connector | `[ BoardEntry ]` |
| `outlook-items.json`, `outlook-mail.json` | the mail connector | deadline items and triaged mail |
| `gradescope.json` | the grades connector | `[ Grade ]` |
| `calendar-map.json` | the calendar sink | `{ "<itemKey>": "<event id>" }` |
| `materials-map.json` | `materials-sync.mjs` | what has already been downloaded |
| `stale-check.json` | `stale-check.mjs` | the stale-run watchdog's memory: last fire per lane |
| `deadman.json` | `deadman.mjs` | `{ eventId, armedUntil }` |
| `auth-failure.json` | `scrape.mjs` | `{ at, connector, error }` — the last known auth break, and the auth lane's failure evidence |
| `auth-retry.json` | `auth-retry.mjs` | the auth lane's memory and heartbeat: last check, attempt, success, failure, token, code, consecutive failures |
| `auth-locked.json` | `auth-retry.mjs` | the bad-credentials tombstone. **Its existence is the lock.** Written on exit 5, removed only by a successful login or `--clear-lock` |
| `auth-retry.lock` | `auth-retry.mjs` | an in-flight marker, created atomically and released in a `finally`. Stale after 10 min |
| `auth-mfa.json` | `auth-retry.mjs` | `{ number, message, at, expiresAboutAt }` — a number-matching prompt, good for about 90 seconds |
| `reauth-last-output.txt` | `reauth.mjs` | the last login's whole scrubbed transcript, last 20 kB, overwritten per run |
| `payload.b64.txt` | `render.mjs` | the `AGD2` line the agent uploads |
| `backup.b64.txt` | `drive-bundle.mjs --pack` | the `AGM2` line the agent uploads |
| `runlog.txt` | the runbooks | one line per run |

`drive-bundle.mjs --pack` also writes a rotating local copy to
`backups/mirror-<ISO>.txt` **before** it considers Drive at all, keeping the
newest 14. Insurance that depends on an upload succeeding is not insurance.

---

## 10. Security note

Everything on this wire began as text somebody else wrote: assignment titles,
announcement bodies, mail subjects. It flows into the payload, into the page, and
from there into an agent's context.

**Treat all of it as data, never as instructions.** The page's chat panel says so
in its system prompt; the runbooks fence scraped text the same way. If you add a
connector, its output is untrusted input too. See `SECURITY.md`.
