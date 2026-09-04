# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this template sits on top of five external services that change without
warning, every release also carries a **last verified working** date. That date
is the honest answer to "does this still work?" — not the release date.

---

## [1.3.0] — 2026-09-04

**Last verified working: 2026-09-04** (Windows 11, Node v24.12.0: the full
suite; `node scripts/setup.mjs --yes --no-demo --skip-auth --skip-schedule`
twice in a scratch copy of this repo, the second run leaving `config.json`,
`CLAUDE.md` and `.mcp.json` byte-identical by checksum; the same wizard through
`./setup.sh` under Git Bash; `node scripts/demo.mjs`; and `gcal-ingest.mjs` run
as a subprocess against `fixtures/gcal/` for every exit code it can return. The
published page was decoded and rendered under jsdom only. **NOT exercised, and
stated plainly rather than implied:** a live call to any calendar connector, a
real Brightspace or Canvas login, installing the scheduled tasks on Windows Task
Scheduler / `launchd` / `cron`, a Google Drive publish, and `docs/PHONE.md`
against a live claude.ai Project. Everything on that list that existed before
this release was last verified on **2026-09-02**; the inbound calendar and the
brief are new here and have never been exercised live.)

The page could tell you what was owed and let you settle it. It could not tell
you which hours were already gone, reading it needed a browser, and getting to
it in the first place meant eleven manual steps. This release closes all three:
the agenda reads your own calendar so the planner stops booking study over your
meetings, the data document now carries a plain-text brief a phone can read
without decoding anything, and `npm run setup` does the mechanical half of
first-time setup in one idempotent command that stops at every step which
genuinely needs a human.

### Added — your own calendar, read inbound

- **`calendars.gcal`, off by default.** A new config block, and the direction
  nothing else in this repo covered: `connectors.calendar.*` writes your
  deadlines *out*, this reads your meetings *in*. Absent or disabled and the
  whole route is dormant — no connector call, an empty `meetings[]`, and a page
  that renders exactly as it did before. The switch is read by the code and not
  only by the runbook: `render.mjs` does not open `data/gcal-items.json` while
  the block is off, and `gcal-ingest.mjs` run anyway writes nothing and exits 0,
  so a file left behind by a term when the route was on cannot put meetings back
  on your page.
- **`src/connectors/gcal-ingest.mjs`**, with its pure half in
  `gcal-normalize.mjs`. The pipeline holds no calendar credentials and never
  will, so a scheduled run calls the calendar connector *you* authorized in your
  own Claude account, saves the answer verbatim to a file, and hands the file to
  this script. **The agent copies bytes; the script decides.** It reads one local
  file, writes one local file, and has no network access of any kind — so
  "inbound only" is a property rather than a promise.
- **`payload.meetings[]`**, additive: `v` stays `4`, and a page that has never
  heard of the key renders exactly as before. Documented in `docs/PROTOCOL.md`
  §4a, including the two things easiest to get wrong — an all-day event's `e` is
  an **exclusive** day key, and a meeting key is a third key space that can never
  collide with a deliverable's or a session's — which takes a named rule, not a
  charset: `fb` is a legal feed id to look at, so it is on a reserved list both
  the config loader and `--feed` check.
- **Meetings are busy time.** `focus-engine.mjs` puts every timed meeting into
  the same `busy[]` array the timetable uses, so every packing path honours it
  and there is no fourth place to forget. Two kinds deliberately are **not**
  busy: an event the source calendar marked transparent (you said you were
  available) and an all-day event (a conference day is a label on the day, not
  four blank hours — treating it as busy would delete a reading day's entire
  study plan).
- **Meetings on the page.** A bracketed, hatched band in the day column with an
  `MTG` tag, so a meeting and a class never read alike at a glance even in a cell
  clipped to nothing; a chip in the day head for an all-day run, one per day it
  covers, each saying which part of the run it is; a row in today's plan in clock
  order with the study blocks. One frame still includes them, so a 07:30 standup
  cannot be folded off screen.
- **Two independent loop guards**, so an agenda that also runs the ICS sink does
  not re-import its own deadlines and then refuse to plan around them. The UID
  rule is proof and is derived from your `namespace`; the description-marker rule
  is a heuristic, and an event skipped by that rule *alone* is counted and warned
  about rather than dropped silently.
- **Stale tolerance, and an honest empty.** A failed fetch keeps the previous
  run's meetings for 48 hours as `status: "stale"` and exits 3; past that it
  writes zero meetings rather than showing last week's. The page's error strip
  says how old the data is, because a lane that has silently stopped looks
  exactly like a calendar with nothing on it.
- **No attendee data, ever.** `attendees`, `organizer`, `creator` and conference
  details are not read at any point, so they cannot reach the payload, the page
  or a Drive document. Warnings name an event by eight characters of its id; a
  malformed file is reported as a byte count and never a snippet.
- Runbook steps in `runbooks/heavy-run.md` §7.0 and `runbooks/sync-run.md` §4.0,
  with the `gcal=ok(...)` / `PARTIAL` / `FAILED` / `SKIPPED(connector-unauthorized)`
  tokens, and the standing rule that a scheduled run **never** calls
  `authenticate` — it cannot answer a consent screen, so an unauthorized
  connector is a log token and a line in the digest.

### Added — a plain-text brief for your phone

- **`src/brief.mjs`.** After the `AGD2.` envelope, the `<ns>-data` document now
  carries a blank line and a brief in plain English: today's plan, what is due in
  48 hours, what is overdue, tomorrow's meetings, and today's note. It is built
  from the object the envelope actually carries, slim tier and all, so the two
  halves of one document can never describe two different weeks.
- **`docs/PHONE.md`** — instructions to paste into a claude.ai Project so a phone
  can answer "what am I behind on?" and write marks and commands back, without
  decoding anything. Entirely optional.
- **Item keys inline.** Every row you can act on ends with ` #<itemKey>`, whole
  or not at all, and it is the **only** ` #` on that row — a title like
  "Homework #3" is printed "Homework No.3", so untrusted text can never look like
  a key. **No key beats a truncated or altered key:** a phone quotes it verbatim,
  and a stub the completions bus cannot match marks nothing while telling you it
  did.
- **A budget that adds up.** At most 60 lines of at most 100 columns, all
  printable ASCII through one `finishLine()` choke point, and the per-section
  caps total exactly the line budget (`briefBudget()`) — so the closing marker
  can never be the line that gets dropped on the busiest day of the term.
- **`sliceEnvelope()`** in `src/lib/envelope.mjs`: the one place the boundary
  between the machine-readable half of a document and the prose after it is
  drawn. Both machine readers go through it — the page's refresh path and
  `behind.mjs` — so the brief can say anything at all, including something that
  looks exactly like an envelope, without any risk of being parsed as data.
- **A read-back before the rotate.** The runbooks now `read_file_content` the
  document they just created and check it starts with `AGD2.`, contains `.END`
  and is within 1% of the file's size **before** trashing the previous one. A
  truncated gzip stream still starts decompressing, so a document that lost its
  tail can parse into a shorter, entirely plausible week; this catches it while
  the last good document is still there. The log token is now `drive=ok(<KB>)`.

### Added — one-command setup

- `npm run setup` — a one-command, idempotent first-time setup wizard
  (`scripts/setup.mjs`, zero dependencies). It checks the machine, writes
  `config.json` from the example, fills `CLAUDE.md` Part 2 the way the
  onboarding agent does, rewrites `.mcp.json` into the Windows `cmd` wrapper,
  runs the preflight, renders the demo, offers the LMS login, and installs the
  scheduled tasks — stopping at every step that genuinely needs a human.
  Flags: `--yes --agent --reset --schedule --skip-auth --skip-schedule
  --no-demo --help`. An unknown flag is a hard error.
- `setup.cmd` (Windows double-click) and `setup.sh` (macOS/Linux) entry points.
- On macOS and Linux the wizard generates the `launchd` plists and crontab block
  documented in `docs/SCHEDULING.md` with this checkout's absolute path already
  substituted, and offers to install the plists.

### Changed — setup docs

- README's first screen is now a Quick Start plus an honest "setup does this /
  you do this by hand" table.
- `docs/SETUP.md` gains a Fast path section mapping all eleven steps to what the
  wizard does, starts, or leaves to you. The manual walkthrough is unchanged.
- `CLAUDE.md` Part 2 documents the `"not … yet"` convention the wizard writes
  into fields it cannot answer.

### Changed — setup internals

- `scripts/setup.mjs` lost its terminal seam and its Step 1 to
  `scripts/lib/setup-io.mjs` and `scripts/lib/setup-machine.mjs`. Every write to
  the terminal, every child process, the one exit path and the whole machine
  check now take their side effects as arguments, so all four are unit-tested
  rather than only reachable by a human typing.
- `AGENTS.md` gains a `setup.mjs` row in the exit-code table: 0 done · 1 a step
  failed, a bad flag, or an unexpected preflight failure · 2 a prerequisite
  blocks (Node too old, no terminal, stdin ended at a question).

### Fixed — the page and the Drive write path

- **The Drive connector's name comes from the build, in every write path.** Three
  functions spelled `"Google Drive"` into nine separate sentences, so a user
  whose connector is called anything else read nine instructions naming one they
  do not have. One `connectorMessage()` helper now says it once, from
  `CFG.driveConnector`.
- **The page no longer names a learning-management system.** Six leftover
  mentions, one of them user-visible on every pipeline-origin completion ("…has
  it as submitted"). The page is published once and serves whatever the pipeline
  was pointed at, so a literal source name is wrong for somebody, always.
- **An `AGD2.` document that fails validation is refused, never retried as
  something else.** It could previously fall through to the plain-envelope
  matcher, which would have accepted an older payload sitting further down the
  same file — publishing a stale week that looks entirely plausible, which is
  precisely what the checksum exists to prevent.

### Fixed — the inbound calendar and the brief

- **`calendars.gcal.enabled` is now read by the code, not only by the runbook.**
  The switch was documented as the one thing that turns the inbound calendar on,
  and nothing checked it: a `data/gcal-items.json` left behind by a term when the
  route was on still put meetings into `payload.meetings[]`, into the planner's
  busy hours, and a stale-calendar warning onto the page's error strip — for a
  user whose config did not mention calendars at all. `render.mjs` now opens that
  file only while the block is `true`, and `gcal-ingest.mjs` reads the same key:
  run while the route is off it prints one `skipped=disabled` line, writes
  nothing and exits 0, so a scheduled step that fires anyway is harmless and the
  two halves can never disagree about what is on disk.
- **A `#` in an assignment title can no longer mint a phantom item key.** The
  phone reads the brief and takes an item key from everything after the last
  ` #` on a row (`docs/PHONE.md`); a focus block called "Review Homework #3
  notes" therefore handed it a key that matched nothing, and a mark it made
  silently no-opped while telling the user the work was done. Block text, item
  titles and meeting locations are all written by other people, so the sequence
  is spent before a row is built: `toAscii()` rewrites a `#` that follows a space
  as `No.`, which makes the key lead-in the only ` #` any row can carry. A key
  the ASCII pass would itself have to change is not printed at all — the same
  rule a key that does not fit already followed.
- **`fb` is refused as a feed id.** `docs/PROTOCOL.md` §4a claimed the charset
  `[a-z0-9-]{1,24}` kept a meeting key from colliding with a study session's
  `fb|<day>|<bucket>`. It does not — `fb` is two perfectly legal characters, and
  `--feed fb` minted meeting keys that `isSessKey()`, a three-character prefix
  test, reads as sessions. `feedIdError()` in `src/lib/config.mjs` now holds the
  reserved list, and the config loader and `gcal-ingest.mjs --feed` both ask it:
  a `ConfigError` naming `calendars.gcal.feed`, or exit 1 with the same sentence,
  before a key is ever built.
- **Every value under `calendars.gcal` is validated when the config loads.**
  `enabled: "true"` (a string, and truthy to everything but a `=== true` test), a
  feed id outside the charset, a negative or fractional `maxEvents` and a
  non-string label all used to load in silence and then behave as though the key
  had been left out. Each is now a `ConfigError` naming the key, in the same
  style as `namespace`; an unknown key under `calendars.gcal` warns, exactly as
  an unknown top-level key does.
- **An all-day meeting with no end is one day long, not zero.** An all-day `e` is
  an *exclusive* day key, so a missing one defaulted to `s` made the span
  `s <= day < s` — empty — and the event vanished from the payload and from the
  brief while still sitting in `data/gcal-items.json`. Both readers now default
  to the day after the start, which is what the page already did.
- **One spelling of the Drive log token.** `drive=ok(<KB>)` and
  `drive=OK(<chars>)` were both in circulation, in the same runbook. `ok(<KB>)`
  is the one, everywhere.
- **`localToUtc()` describes what it actually does at a spring-forward gap.** The
  docstring said a non-existent local time resolves one offset *later*; the
  correction pass resolves it one offset *earlier* — 02:30 on 2026-03-08 in
  America/New_York is `06:30Z`, not `07:30Z`. The behaviour is unchanged and
  `test/civil-time.test.mjs` now pins it, along with the fall-back choice beside
  it, so the two cannot drift apart again.
- **`maxEvents` keeps the earliest meetings, not the newest.** `capEvents()`
  sorts ascending by start and keeps the first `maxEvents`, so it is the far end
  of the window that falls off. `docs/CONFIG.md` said the opposite.
- **Two dead exports removed.** `render.mjs` imported `MAX_LINES` from
  `brief.mjs` and never used it; `parsePoint()` returned a `wall` field derived
  back from the instant that no production code read. An instant is the one
  truth about when an event is, and a second spelling of the same fact is a
  second thing to keep in step.
- **The brief's worst case is stated honestly.** Both runbooks said it "adds at
  most 6,000 more" characters; 60 lines of at most 100 columns and their
  newlines is 6,059, plus the blank line between the two halves. They now say
  **about 6 KB**, with the arithmetic.

### Fixed — the setup wizard

- **A generated crontab quotes the clone path.** `AGENDA=<path>` and `cd $AGENDA`
  were both bare, so a clone in `~/my agenda` produced `AGENDA=/home/you/my`
  with a stray `agenda` argument; `cd` then failed on a path that does not exist
  and `&&` swallowed the rest of every line. Nothing is written anywhere when
  that happens — the crontab looks perfectly installed and no digest ever
  arrives. It is now `AGENDA="…"` and `cd "$AGENDA"`, in the generator and in
  `docs/SCHEDULING.md`. The `launchd` plists already quoted; Windows delegates to
  `install-tasks.cmd` and never builds a shell line.
- **A namespace already in `config.json` is kept, always.** A re-run compared it
  against the literal `"agenda"` and, finding a match, replaced it with a slug of
  the folder name — renaming all four Drive documents at once, so a page that had
  already been published went on reading a `<old>-data` nothing writes any more.
  Silently, because from a phone a missing document and an idle pipeline look
  identical. The wizard now asks for a namespace only on a checkout that has no
  `config.json`.
- **Ctrl+D at a question stops at exit 2 instead of reporting success.**
  `readline/promises` resolves `question()` when a line arrives and does nothing
  at all when the stream closes first, so the `await` never returned, the
  `finally` never ran, and Node exited 0 over a wizard that had written no files
  and printed no error. The close event now rejects, and the wizard says
  `setup stopped: no answer given` with the `--yes` route out.
- **`npm run setup --yes` is refused rather than ignored.** npm keeps a flag
  given without the `--` separator and exports it as `npm_config_yes` instead;
  `process.argv` arrives empty and the wizard ran interactively while the user
  believed they had asked for every default. It now spots the seven flags npm can
  swallow and prints one line — `you passed --yes to npm, not to setup - run: npm
  run setup -- --yes` — then stops. It never acts on the environment variable:
  guessing intent from npm's leftovers is the thing being fixed.
- **The closing summary no longer calls an unexpected preflight failure
  "closed by a numbered step above".** Step 4 already told the user that a
  missing `fixtures/demo` was UNEXPECTED; four screens later the summary folded
  it back in with the expected handovers and the wizard exited 0 over a broken
  clone. The two lists are now printed apart, and an unexpected failure exits 1.
- **A duplicated `CLAUDE.md` Part 2 line is a hard error.** `fillSentinels` wrote
  into the first match and `hasSentinels` inspected the same one, so a second
  copy carrying `[NOT SET]` survived the wizard, re-triggered the onboarding
  agent on the next greeting, and run 2 reported "already filled in". Both now
  refuse, with the same `git checkout CLAUDE.md` fix line the missing-line error
  carries.
- **The preflight has a line for the inbound calendar.** `calendars.gcal` was the
  one config block with no row in the table, and the only one whose failure mode
  is silence — an empty `meetings[]` looks exactly like a calendar with nothing
  on it. It now reports off (naming the opt-in), or on with the feed id and
  whether a run has written `data/gcal-items.json` yet and what that file's
  status says. Shape validation stays where it belongs, in `src/lib/config.mjs`.
- **`connectorsOn()` counts the inbound calendar.** It walked `cfg.connectors`
  only, and `calendars.gcal` is deliberately not under there — so an enabled
  inbound calendar never appeared on `CLAUDE.md`'s **Connectors on:** line. The
  preflight's "Connectors turned on" note now calls the same function instead of
  repeating the walk, so the two cannot drift.
- **`./setup.sh` with no arguments runs on stock macOS.** `set -u` plus a bare
  `"$@"` is an unbound-variable error on bash 3.2, which is what macOS ships — so
  the documented way to run the launcher died on line one and never reached npm.
  It forwards with `${1+"$@"}` now, which expands to nothing when there is
  nothing.
- **`package.json` `files` ships what setup reads.** `config.example.json`
  (setup hard-fails without it), `AGENTS.md`, `CLAUDE.md` and `.claude/` were all
  omitted. Latent while the package is `private`, wrong the moment it is not.

### Testing

- `npm test`: **806 → 1078** tests, all passing. New suites:
  `test/setup.test.mjs` (100), `test/brief.test.mjs` (38),
  `test/gcal-normalize.test.mjs` (33), `test/gcal-ingest.test.mjs` (36, every one
  running the real script as a subprocess because the exit code is the contract)
  and `test/civil-time.test.mjs` (4, pinning both daylight-saving corrections),
  plus meeting, brief, connector-name and add-queue-cap cases in the render,
  focus-engine, envelope, config, behind and page suites.
- `ADD_MAX` is now tested: the cap is reached and not passed, the refusal names
  the number, and a *refused* entry may still be replaced at the cap.

### Notes

- **No RRULE expander.** Every connector this route supports returns single
  instances. A recurring *master* that reaches the ingest anyway is warned about
  by name and skipped rather than expanded — a half-right expansion across a
  daylight-saving boundary puts phantom meetings on the grid, which is worse than
  a warning that says exactly what to ask the calendar tool for.

---

## [1.2.0] — 2026-09-03

**Last verified working: 2026-09-03** (Node 22.x and 24.x, Windows 11: the
full suite, including the jsdom-booted page cases and the command-bus round
trip against the real `validateAdd`. The live path through the published page's
`mcp` and `sample` capabilities was NOT exercised for this release — the
connector-consent prompt is the owner's to accept — so the last live
verification of the Drive write machinery this feature reuses remains 1.1.1's.)

The page could read a week and settle work; it could not create any. This
release closes that: the "Ask" panel can add a task, and the task goes out on
the command bus the page already writes.

### Added — the Ask panel can add a task

- **A fourth chat tool, `add_item`.** Ask for a task with a title and a due date
  and it appears on the grid immediately, badged *pending sync*, and joins the
  agenda properly on the next pipeline run. It refuses a bucket the payload does
  not name, a date outside `[today-7, today+365]`, a title that normalises to
  nothing, and a twin of something already on the agenda or already queued — and
  it says which, in words the panel can read back to you.
- **A pending-sync overlay, `<ns>.adds.v1`.** Its own `localStorage` key, never
  the marks or blocks one, capped at fifty entries. Queued adds are merged into
  the item list at data-normalisation time rather than patched into the DOM, so
  they survive a re-render and a reload, and every renderer, count and briefing
  sees one list.
- **A badge that says what is true rather than what is convenient.** *Pending
  sync* — including after the command document is written, because a write that
  resolved is proof a document exists, not proof the pipeline accepted it.
  *Sync failed*, with a Retry, because a rejected write is not proof the document
  was not created and an unattended retry is how one task becomes four. *Not
  accepted by sync*, with a Dismiss, when a payload generated more than ten
  minutes after the write comes back without it.
- **No tick on a queued add, anywhere.** No ring, no Done, no Won't do, no Undo —
  on the chip, in the open card, in the Later list or in the plan — and the three
  mark tools refuse the key outright. There is nothing on the far side to mark
  yet, and a completion written for a key no pipeline has heard of would never
  resolve against anything.
- The due time is worked out through `Intl` **at the instant in question**, so a
  build in a zone that observes daylight saving stores the right instant in
  December as well as in September. A runtime that cannot resolve
  `config.timezone` refuses the add rather than storing a time computed in
  whatever zone the laptop happens to be in.

### Protocol — no pipeline change was needed

- `add` has been one of the seven ops on the `AGQ1` command bus since the bus
  existed, and `command-ingest.mjs` already appends it to `data/phone-items.json`
  with `cid: 0` and `src: ["phone"]`. **No `*.mjs`, no runbook and no config key
  changed in this release** — the page simply started emitting a command the bus
  already accepted. `docs/PROTOCOL.md` §3 and §7 now document the browser key and
  the page's own validation; `docs/ARTIFACT.md` §3 notes the fourth tool needs
  the `mcp` block's `create_file`.
- Adds and block drags never share a document. Validation is fail-closed per
  document, so one refused add would take an unrelated drag down with it: two
  queues, two flushes, one document per kind.

### Fixed

- `web/page-template.html` is now byte-for-byte ASCII. Eight characters (two
  triangles, two en dashes, one em dash, three ellipses) inside JS string
  literals are the exactly equivalent `\uXXXX` escapes.

---

## [1.1.1] — 2026-09-02

**Last verified working: 2026-09-02.** The auth watchdog's MFA-number relay was
exercised end to end for the first time — a cold login all the way through a
Microsoft Authenticator number-match, with the number reaching a phone and the
session restored. That live run surfaced three defects that every mock-based
test had hidden, all fixed here.

### Fixed — the MFA-number relay actually reaches the phone now

- **A Windows `.cmd` push hook is spawned through `cmd.exe`.** Spawning a batch
  file directly throws `EINVAL` on modern Node (the CVE-2024-27980 hardening),
  so the hook silently never ran. It now goes through `cmd.exe /d /c`; a POSIX
  `.sh` hook is still spawned directly.
- **The push child is no longer `detached`.** A detached, console-less child on
  Windows never completes a `curl` network write, so the push dropped while the
  on-screen alert (which tolerates detachment) masked the failure. The push hook
  now uses `stdio: "ignore"` + `unref()` and is never detached.
- **The push channel example is `ntfy`, not `claude -p`.** A headless
  `claude -p --allowedTools PushNotification` cannot deliver to a phone from a
  background scheduled job — Claude's push needs a live connected session, so it
  reports success and delivers nothing. `docs/CONFIG.md` now leads with a
  one-line `curl` to ntfy, with Pushover/Telegram/self-host as drop-in
  equivalents through the same seam.
- Hardened the reauth output seam against a future regression: an exported
  `streamCollector` guarantees the login's `MFA-NUMBER:` line is forwarded to
  the relay per-chunk, never buffered until exit, with a test that proves it.

## [1.1.0] — 2026-09-02

**Last verified working: 2026-09-02** (Node 22.x and 24.x, Windows 11 and macOS
14, Claude Code, Brightspace via `brightspace-mcp-server@latest`, Google Drive
through the Claude connector.)

### Added — an hourly auth watchdog

- **`src/auth-retry.mjs`, a third watchdog, on a fifth scheduled task.** The two
  existing watchdogs ask *"did a run happen?"* and *"is this machine alive?"*.
  Neither can see the case where a run fires exactly on time, hits an expired
  session, tries its one permitted re-auth, and stops — because that run *did*
  happen and the machine *is* alive. Both are right to stay silent, and until now
  nothing retried the login until the next heavy run, half a day later.
- It is **free on a healthy machine.** An LMS token lives about an hour, so an
  expired session is the pipeline's normal resting state between runs; firing on
  that alone would mean two dozen pointless headless logins a day. It fires only
  when there is no session file at all, or when the session is unusable **and**
  the newest failure is newer than the newest success.
- **Exit 5 is the only stop, and it is permanent.** A rejected password writes
  `data/auth-locked.json` and the lane never fires again, because retrying one an
  institution has already refused locks accounts. Every other code — including
  exit 4, which means the lane called `reauth.mjs` wrongly — retries hourly and
  lets a failure counter climb. Nothing unrecognised can reach the stop state.
- **Number matching is handled as one feature with the retry, not as a separate
  one.** Where an identity provider renders a number to type into an
  authenticator app rather than sending an approve/deny push, a headless login
  raises a prompt nobody can see — so retrying without relaying the number just
  repeats an unanswerable prompt forever. The vendored login patch now captures
  that number and prints it; the lane reads the login's output **line by line as
  it arrives** and relays it within seconds to `data/auth-mfa.json`, an on-screen
  alert, and an optional push hook. Streaming rather than buffering is the whole
  point: the prompt is worth about ninety seconds. There is a test that proves
  the number reaches the relay while the login is still running.
- **A documented push-hook seam, with no provider hard-coded.** `docs/CONFIG.md`
  ships a worked example — a one-line `curl` to [ntfy](https://ntfy.sh) that
  reaches the phone in under a second — with Pushover, Telegram or a self-hosted
  server dropping into the same hook unchanged. On Windows the hook runs through
  `cmd.exe` and is never a detached child, so a `curl` push actually completes.
- **`data/reauth-last-output.txt`.** Every login now leaves its whole
  password-scrubbed transcript, last 20 kB, overwritten per run. One exit code
  and one last line cannot tell a crashed auth CLI apart from an unanswered
  second factor, and those have opposite fixes.
- New config block `authRetry` (`enabled`, `sessionFiles`, `minIntervalMinutes`,
  `pushHook`). **An empty `sessionFiles` opts the lane out entirely**, which is
  the correct answer for a connector that keeps no session file — Canvas, for
  one. Without that branch the lane would fire hourly forever.

### Changed — the page is one frame

- **The weekly grid is drawn only in the hours the week actually uses**, and the
  dead time above and below folds behind two rails that name what they hold. On a
  phone this is the difference between a page that scrolls and a week that fits
  the screen. It is a layout change: density, chips, marks, hues, sizes and the
  wire protocol are all untouched.
- **A deadline at or after 23:00 pins to the foot rail** instead of dragging
  empty hours into the frame. Most course deadlines land at 11:59pm, so honouring
  them literally would mean the frame never trimmed at the bottom and the whole
  feature did nothing. A deadline at 21:30 still opens the frame normally, and
  the fold is always stated — *"2 later hours · 4 due 11:59 PM"*.
- **A gap between two tasks stays visible, and to scale.** The frame remains a
  plain linear window rather than a segmented one, which is why the drag maths
  needed no changes at all: position and pointer-to-minute are still exact
  inverses.
- **Dragging a block past the edge opens the fold under the pointer** and hands
  the live gesture to the redrawn nodes, so a trimmed grid is never an
  unreachable one.
- The hour is sized from the viewport between a 30px readability floor and a 64px
  ceiling. When the floor cannot be honoured the canvas keeps its own scrollbar —
  an explicit, documented fallback rather than illegible rows.
- Task names gained a fifth: `<prefix> AuthRetry`. `scripts/install-tasks.cmd`
  registers and verifies it, and now warns loudly instead of silently if a
  credential lockout is in force. `docs/SCHEDULING.md` carries the `launchd` and
  `cron` equivalents.

### Notes

- The number-matching capture selector is **flagged unverified in production** in
  every place it is documented. It is the element the identity provider ships
  today and the code path is unit-tested end to end, but no run here has yet met a
  live number-matching prompt. If it is wrong the fix is one selector, and the
  transcript file and the read-only probe are the two diagnostics for it.

---

## [1.0.0] — 2026-09-02

**Last verified working: 2026-09-02** (Node 22.x and 24.x, Windows 11 and macOS
14, Claude Code, Brightspace via `brightspace-mcp-server@latest`, Google Drive
through the Claude connector.)

First public release.

### The pipeline

- Deterministic merge chain: dedupe, approximate-date reconciliation, calendar
  twin collapse, gradebook overlay, optional external-grades overlay.
- A study model that scores every bucket 0–5 from difficulty, grades, exam
  proximity, open backlog, observed pace and attendance, and explains each score.
- A focus engine that packs timed study blocks into the gaps in a real class
  timetable, respects a wake-time floor, honours blocks the user has dragged, and
  learns from the drags.
- A seven-rule `clear` / `notice` / `behind` verdict that never accuses the user
  of missing work on the basis of absent evidence.
- A completion ledger with three states, user-owned tombstones, and a refusal
  lane that makes "one finished study session closed a whole assignment"
  impossible.

### Setup and first run

- **Demo mode.** `node scripts/demo.mjs` renders a complete agenda from bundled
  fictional data with no accounts, no configuration and no connectors. It is the
  first thing setup does.
- A conversational onboarding agent that triggers on a greeting, runs a
  preflight, shows the demo, and then connects one real source at a time —
  pre-announcing every trust dialog and consent screen before it appears.
- `scripts/validate-setup.mjs`: a preflight that prints a fix link for every
  failure instead of throwing, and touches no network.
- `scripts/health-check.mjs`: the other half — it asks every enabled connector's
  own `healthCheck()` whether its backend actually answers, and writes nothing
  while doing it. `/agenda-doctor` runs both.

### Connectors

- Every source is a swappable adapter with a documented contract. Brightspace
  ships enabled; Canvas, Outlook mail, the Outlook calendar sink, the ICS
  calendar sink, a GitHub board and a Gradescope extra all ship **disabled**.
- **Two LMS connectors, either or both.** Canvas needs only a `baseUrl` and a
  personal access token — no server, no login chain — which makes it the one LMS
  path that works in a cloud environment. Enabling both is supported; the merge
  deduplicates by item key.
- **An ICS calendar sink** writes a standard `.ics` file with reminders and
  exam-prep events, so deadline alerts work on macOS and Linux by subscribing
  from Google Calendar or Apple Calendar.
- Anything that needs Windows, COM or `schtasks` is gated on the platform and is
  off by default, so macOS and cloud configurations work out of the box. The
  **dead-man's switch is the one capability with no cross-platform substitute**,
  and the docs say so rather than implying otherwise.
- `scripts/reauth.mjs` maps a login failure onto six exit codes, and its
  `--probe` diagnostic is genuinely read-only — no login, no push, no
  credentials in the file it writes. Unknown flags are a hard error.

### Transport

- Payloads are gzipped before base64 and guarded by a CRC-32, with automatic
  slim tiers and a hard emit budget. A run's Drive upload is roughly 7,000
  characters instead of 65,000 — a >9× reduction that is what makes the
  phone-readable page possible at all.
- Four Drive documents with four exact titles and three owners: data, mirror,
  completions, commands. Every write creates before it trashes.
- A local rotating state mirror is written on every heavy run *before* Drive is
  considered, so the insurance never depends on an upload succeeding.

### Reliability

- Two independent watchdogs: an in-machine stale-run check that notices a run
  the scheduler slept through, and an off-machine dead-man's switch on a
  calendar that fires when the whole machine is gone.
- Both are documented in `docs/design-notes/watchdogs.md`.
  *(1.1.0 adds a third.)*

### Docs

- A setup guide that matches what the agent actually does, step for step.
- One page per connector, including an honest page for the platforms that have
  no viable server.
- Four design notes explaining the rules that exist because something went
  wrong once.

[1.3.0]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.3.0
[1.2.0]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.2.0
[1.1.1]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.1.1
[1.1.0]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.1.0
[1.0.0]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.0.0
