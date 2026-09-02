# Brightspace (D2L) — the default LMS connector

**Tier 2** — a local server plus a browser login. **Enabled by default.**

```jsonc
"connectors": {
  "lms": {
    "brightspace": {
      "enabled": true,
      "mcpServer": "brightspace",
      "package": "brightspace-mcp-server@latest"
    }
  }
}
```

---

## What it does

Per course, per heavy run:

| Call | Gives us |
|---|---|
| `get_assignments` | Dropbox deliverables with due dates and, sometimes, submission evidence |
| `get_course_content` | The content tree — modules, files, and any dates hidden in prose |
| `get_announcements` | Recent announcements, which is where email-only homework often surfaces |
| `get_my_grades` | The gradebook, which is the **only reliable positive evidence** that something is done |

plus one global `get_upcoming_due_dates`.

### Submission evidence, and why so much of it is `null`

D2L's **student-facing** quiz endpoint reports `attemptsUsed: 0` and
`bestScore: null` even for quizzes that are already finished and graded. Those
fields are populated for instructors and empty for you.

So "the field is empty" and "the work is not done" look identical from a student
session, and only one of them is a fact. The connector emits **positive evidence
only**:

- `submitted: true` — a gradebook entry whose title matches and whose earned
  points are above zero, or a real attempt or submission object.
- `submitted: null` — **everything else.** Most items sit here and that is
  correct.
- `submitted: false` — only when a source states it outright. Rare.

`docs/design-notes/data-truth.md` is the incident that produced this rule. Read
it before you change anything in this connector.

---

## Setup

The setup agent does all of this. By hand:

**1. `.mcp.json`** ships as:

```json
{ "mcpServers": { "brightspace": { "command": "npx", "args": ["-y", "brightspace-mcp-server@latest"] } } }
```

**On Windows, wrap it:**

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "brightspace-mcp-server@latest"] }
```

A bare `npx` entry **fails silently on Windows.** The process never starts,
nothing is raised, and the only symptom is an empty course list.

**Then restart Claude Code.** `.mcp.json` is read at session start, so the fixed
entry is not live in the session that edited it.

**2. Approve the trust prompt.** Claude Code asks whether you trust the MCP
servers in this project. This is **per-user and per-project** and no repository
can pre-grant it. `claude mcp reset-project-choices` re-prompts.

**3. Log in.**

```
npx -y brightspace-mcp-server auth            # macOS / Linux
cmd /c npx -y brightspace-mcp-server@latest auth   # Windows
```

A browser opens on **your school's own** login page. Your password never passes
through this repository. Approve the two-factor push when it arrives.

**4. Verify** with `get_my_courses`. Your enrolments should list.

---

## Why the package is not version-pinned

`"package": "brightspace-mcp-server@latest"`, deliberately.

An earlier pinned build predates the generic-university single-sign-on work.
Pinning it would break every school whose identity provider has moved on, in
exchange for reproducibility that a login flow cannot give you anyway — the
*server* being frozen does not freeze the *login page*, and the login page is
what changes.

**Where that string actually lives.** `connectors.lms.brightspace.package` is a
**record of intent, not a switch.** The command that runs — for the server and
for `scripts/reauth.mjs`, which appends `auth` to it — comes from the matching
entry in `.mcp.json`, because that entry already carries the platform-correct
shape (`cmd /c npx …` on Windows) and duplicating it in `config.json` would
guarantee the two eventually disagree.

So: **to change the package, edit `.mcp.json`**, and update the `package` key to
match so the two still tell the same story. If you want reproducibility, install
from a git tag and point `.mcp.json` at your own build — see Fix B below for the
exact entry shape.

---

## When the login hangs

**The symptom is distinctive:** a browser window sitting on a fully rendered,
fully functional login page, doing nothing, until it times out. Manual login
works perfectly. Automated login never completes. Nothing says why.

**The cause:** the published build waits for a selector belonging to an older
single-sign-on form. Many institutions now delegate to **Microsoft Entra ID**
with a **Duo Universal Prompt**, which is a materially different chain:

```
campus selector -> SAML initiate -> Entra email -> Entra password
  -> second-factor prompt -> "Stay signed in?" -> LMS home
```

The old selector never appears on that chain, so the wait never ends.

### Fix A — install from upstream `main` (try this first)

The fixes may already be merged upstream even when they are not on npm yet, and
this needs no patching and no local build.

**bash / zsh** (the backslash continuations are shell syntax, not part of the
command):

```bash
claude mcp add-json brightspace \
  '{"command":"npx","args":["-y","github:RohanMuppa/brightspace-mcp-server"]}' \
  --scope project
```

**PowerShell** — one line, single quotes:

```powershell
claude mcp add-json brightspace '{"command":"cmd","args":["/c","npx","-y","github:RohanMuppa/brightspace-mcp-server"]}' --scope project
```

**cmd.exe** — only double quotes exist, so the inner ones are doubled:

```
claude mcp add-json brightspace "{""command"":""cmd"",""args"":[""/c"",""npx"",""-y"",""github:RohanMuppa/brightspace-mcp-server""]}" --scope project
```

If the quoting fights back, **edit `.mcp.json` by hand** — it is the only file
`add-json` writes. Either way, **restart Claude Code**: `.mcp.json` is read at
session start.

### Fix B — apply the patch

`vendor/brightspace-mcp-server/entra-duo-sso.patch` rewrites the module that
drives the login. **Read its header first.** Two things in it matter before you
run anything: the file path in the `---`/`+++` lines is a **placeholder**, and
the hunk line numbers are approximate.

**1. Take a real checkout.**

```
git clone https://github.com/RohanMuppa/brightspace-mcp-server
cd brightspace-mcp-server
npm install
```

**2. Find the real module name.** Upstream names it after the university it was
originally written for, and that name moves between versions. In *this checkout*
the login module is under the source tree:

```
ls src/auth/          # the sources you are patching
ls build/auth/        # the compiled output, after npm run build
```

The patch header suggests `ls node_modules/brightspace-mcp-server/build/auth/`
— that is the path **if you already have the package installed elsewhere** and
only want to see the built filename. You are patching the checkout, so use the
checkout's own `src/auth/`. Edit the patch's two `---` / `+++` lines to name the
file you found.

**3. Apply it.** `patch` is not on a stock Windows shell; `git apply` is, because
you have just used `git`:

```
git apply --3way --reject vendor-path/entra-duo-sso.patch   # any platform
patch -p1 --fuzz=5 < vendor-path/entra-duo-sso.patch        # macOS/Linux/Git Bash
```

where `vendor-path` is your clone of this repo's
`vendor/brightspace-mcp-server/`. **If a hunk is rejected, that is expected** —
the header says so. The `+` side of the patch is complete enough to paste in by
hand.

**4. Build it.**

```
npm run build
```

**5. Point `.mcp.json` at your build.** Note the absolute path to the built
entry point — `ls build/` will show it, commonly `build/index.js`:

```json
{
  "mcpServers": {
    "brightspace": {
      "command": "node",
      "args": ["C:/Users/you/src/brightspace-mcp-server/build/index.js"]
    }
  }
}
```

No `npx`, so **no `cmd /c` wrapper is needed** — that wrapper exists only for
`npx`. Use forward slashes even on Windows; JSON treats a backslash as an escape.
Then restart Claude Code, and re-run the auth CLI as
`node C:/…/build/index.js auth`.

**Never patch the npm or npx cache.** It is invisible, it survives no cache
clean, and it produces a machine whose behaviour cannot be reproduced from its
configuration.

`vendor/brightspace-mcp-server/NOTICE.md` argues — correctly — that this should
be a pull request upstream rather than a patch anyone carries forever. If it
helped you, please open it.

### The permanent diagnostic

```
node scripts/reauth.mjs --probe
```

Records the **current** login chain to `data/auth-probe.json`.

**It is read-only.** It does not open a login, does not send a two-factor push,
does not touch the credentials store, and captures **no credentials at all** — it
records the public login form's structure and nothing else. It is safe to read
and safe to paste into an issue, and it is safe to run when you are only curious.

When selectors drift again — and they will — the probe tells you what is actually
being served now. Guessing at selectors without one is how an afternoon
disappears.

Unknown flags are a **hard error**: `reauth.mjs` refuses to run rather than
falling through to the default behaviour. A wrapper that ignored a typo here
would open a real login when you asked for a diagnostic.

---

## Re-authentication

Sessions expire. `scripts/reauth.mjs --silent` handles it — headless, never
prompting — and maps the failure to a specific exit code, because "auth failed"
is at least five different problems with five different fixes:

| exit | token | meaning | what happens |
|---|---|---|---|
| 0 | `ok` | worked | the scrape re-runs **once**, the run continues, no alarm |
| 6 | `MFA-PENDING` | a push was sent and not approved in time | one friendly note, then stop. **Not an error** — approve the next one |
| 5 | `BAD-CREDS` | the stored password was rejected | *"run `--setup` to update it"*, stop |
| 2 | `NO-CREDS` | nothing saved yet | *"run `--setup` once"*, stop |
| 7 | `NO-PACKAGE` | the LMS server package is missing | *"run the auth CLI once"*, stop |
| 1 | `FAILED` | anything else | the generic alarm with the last output line, stop |

**`--setup` is interactive.** It stops and waits for you to type a password into
your own terminal, so it is yours to run and an agent cannot answer it — a
scheduled run must never invoke it, and one that tried would hang. `--silent` is
the opposite: headless, no prompt, no install, and it only ever *reads* the
credentials store.

**Every stop keeps the rule: do not continue on stale data.** An agenda built
from yesterday's scrape and presented as today's is worse than no agenda, because
you act on it.

`docs/design-notes/auth-hardening.md` has the full reasoning and the security
model.

---

## Health check

```
node scripts/health-check.mjs
```

`healthCheck()` calls `check_auth` and `get_my_courses` and returns the number of
visible courses, or a failure with the re-auth hint. It proves the session is
alive; it does **not** prove a full sweep would succeed, and it does not try to.

The script above runs that probe for every enabled connector, writes nothing,
and exits 1 if any of them could not answer. `/agenda-doctor` runs it for you.
When a probe is green and a sweep still comes back wrong, the next step is
`node src/scrape.mjs` against the real data.

---

## Known quirks

| Quirk | What to do |
|---|---|
| An item appears twice with different dates — an "opens" and a "closes" | Handled. `merge.mjs` collapses calendar twins; the corroborated row wins and exams keep the earliest twin, which is the session |
| A shell course returns access-denied on everything | Mark it `"skip": true` in `courses[]`. Those errors are expected and skipping keeps them out of every digest |
| Some instructors post schedules only as prose | The heavy runbook's step 2 re-reads content modules and syllabi weekly and extracts dated deliverables, keeping `approx: true` when only a week was given |
| A quiz shows no attempts but is graded | The student endpoint quirk above. It stays `null`. This is correct |

---

## Turning it off

Set `enabled: false` — but **at least one LMS connector must be enabled and
configured**, or `scrape.mjs` exits 1 with `scrape: no LMS source is enabled.`
and a four-line fix. `docs/connectors/canvas.md` is the other one, and **either
or both may be on**: with both enabled, `merge.mjs` deduplicates by item key and
anything in both ends up with `sources: ["brightspace", "canvas"]`.
