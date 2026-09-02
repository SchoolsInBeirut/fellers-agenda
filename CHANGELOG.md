# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this template sits on top of five external services that change without
warning, every release also carries a **last verified working** date. That date
is the honest answer to "does this still work?" — not the release date.

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

### Docs

- A setup guide that matches what the agent actually does, step for step.
- One page per connector, including an honest page for the platforms that have
  no viable server.
- Four design notes explaining the rules that exist because something went
  wrong once.

[1.0.0]: https://github.com/SchoolsInBeirut/fellers-agenda/releases/tag/v1.0.0
