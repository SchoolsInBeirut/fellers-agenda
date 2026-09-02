# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this template sits on top of five external services that change without
warning, every release also carries a **last verified working** date. That date
is the honest answer to "does this still work?" — not the release date.

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

[1.1.1]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.1.1
[1.1.0]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.1.0
[1.0.0]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.0.0
