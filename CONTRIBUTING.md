# Contributing to Feller's Agenda

The most useful contribution is **a connector for a source we do not support
yet.** Second most useful is a fix to a doc that lied to you. Everything else is
welcome too.

---

## Ground rules

1. **Zero runtime dependencies.** Node ≥22 standard library only — `node:fs`,
   `node:path`, `node:url`, `node:zlib`, `node:child_process`, `node:crypto`,
   `node:test`. If you need a library, you need a different design. (One test may
   optionally import `jsdom`, and it must skip cleanly when `jsdom` is absent.)
2. **Every test passes on a bare checkout with an empty `data/`.** No test may
   read `data/`. Tests read `fixtures/` only.
3. **Zero personal data.** No real names, emails, usernames, course numbers,
   institution names, absolute user paths, document ids or tokens — in code,
   comments, fixtures, tests or docs. Use the placeholder cast:
   `PHYS 221` / `MATH 210` / `CHEM 115` / `HIST 140` / `SEM 100`,
   `Example University` / `lms.example.edu`, `Prof. R. Lang`,
   `Dr. A. Mentor`, `you@example.com`, `America/New_York`.
4. **Windows-first, never Windows-only.** Anything that shells out to
   PowerShell, COM or `schtasks` lives behind a connector that is disabled by
   default and gated on `process.platform === "win32"`.
5. **Style:** LF line endings, 2-space indent, double quotes in `.mjs`.
6. **Keep the header essays.** Several modules open with a long comment
   explaining *why* a rule exists, usually because something went wrong once.
   Those comments are the most valuable part of this repo. Extend them; do not
   trim them.

---

## Adding a connector — the seven steps

Full detail, including the tier table of MCP servers that actually work, is in
[`docs/EXTENDING.md`](docs/EXTENDING.md). The shape of the work:

1. **Pick a server** from the tier table. Tier 1 is hosted OAuth (one command,
   nothing to install), Tier 2 is a local server plus a token, Tier 3 is
   documented-as-broken.
2. **Register it:** `claude mcp add --scope project --transport http <name>
   <url>`. On Windows an stdio `npx` server must be wrapped as
   `"command": "cmd", "args": ["/c", "npx", "-y", "<pkg>"]` — a Mac-shaped npx
   entry fails silently on Windows and is the single most common cross-platform
   break. Skip this step entirely if the source is an HTTP API with a token, as
   the Canvas connector is: no server, no `.mcp.json` entry, works in the cloud.
3. **Copy `src/connectors/_template.mjs`** to
   `src/connectors/<kind>-<provider>.mjs`. Fill in `meta`, implement `collect()`
   and `healthCheck()`.
4. **Register it** in `src/connectors/index.mjs`: one import, one array entry.
5. **Add its config block** under `connectors.<kind>.<provider>` with
   `"enabled": false`, in **all three** places — `DEFAULTS` in
   `src/lib/config.mjs`, `config.example.json`, and your own `config.json` — and
   document every key in `docs/CONFIG.md`. `test/config.test.mjs` pins the first
   two against each other key for key, so missing `DEFAULTS` fails the suite.
6. **Add a test** in `test/connectors.test.mjs`. There is no per-provider
   harness and no fixture directory for connector responses, so write the sample
   **inline** as a literal object, keep your mapping in a small pure function so
   the test needs no network or `ctx`, assert `validateEmission("<kind>", out)`
   passes, and assert that a missing field produces a *named* error. Redact the
   sample — placeholder cast only.
7. **Verify end to end:** `node scripts/validate-setup.mjs`, then
   `node src/scrape.mjs`, then check `data/latest.json` has items with
   `sources: ["<provider>"]`, then `node src/render.mjs`.

### The one rule you must not get wrong

`submitted` is **tri-state**. `true` means a source gave positive evidence the
work is done. `false` means a source *explicitly said* it is not done. `null`
means you do not know.

**If you do not know, emit `null`.** A connector that emits `false` on absence
makes the agenda accuse the user of not doing work they have already done. That
is a real incident; it is written up in
[`docs/design-notes/data-truth.md`](docs/design-notes/data-truth.md). Read it
before you write a `collect()`.

---

## Opening a pull request

- **Branch off `main`.** Do not commit to `main` directly.
- **Run the suite:** `npm test`. It must be green, and it must be green
  with `jsdom` absent as well as present.
- **Run the personal-data check** on your own diff before you push. If a course
  code, a real name, an email, an institution or a `C:\Users\<you>` path appears
  anywhere, replace it with a placeholder from the cast above.
- **Conventional commit messages:** `feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`, `perf:`, `ci:`.
- **Describe the failure your change prevents,** not just the change. "Emits
  `null` instead of `false` when the status column is missing, so an unread
  status stops closing items" beats "fix status parsing".
- **If you changed a wire identifier, a payload key, an envelope or a config
  key, say so in the PR title.** Those are cross-cutting contracts: the pipeline
  writes them, the page reads them, and the docs describe them. All three change
  together or none do.

CI runs `npm test` on Node 22 and 24 (Linux and Windows). It uses no secrets and touches no
network.

---

## Reporting a bug

Use the [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml). It asks for
your OS, your Node version, which connectors are on, and a **redacted** log
excerpt. Redacted means: no email addresses, no course names, no document ids,
no tokens. The status tokens (`drive=OK(6712)`, `behind=notice(B3)`,
`cmd=REFUSED`) are what a maintainer actually needs and they carry nothing
private. A `data/auth-probe.json` from `node scripts/reauth.mjs --probe` is safe
to attach too — it holds no credentials.

Want a source that does not exist yet? Use the
[connector request form](.github/ISSUE_TEMPLATE/connector_request.yml). Please
check [`docs/connectors/not-supported.md`](docs/connectors/not-supported.md)
first — some platforms genuinely have no viable general-purpose server, and that
page says which and why.

---

## What this project will not take

- A runtime dependency.
- A connector that emits `submitted: false` when it means "I could not tell".
- A default that turns off permission prompts, skips a trust dialog, or ships
  `--dangerously-skip-permissions` in an installed scheduled task.
- Anything that stores a credential inside the repository.
- A test that reads `data/`.
