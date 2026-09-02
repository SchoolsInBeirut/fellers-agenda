# Gradescope connector (optional, off by default)

Some courses collect everything on Gradescope. When they do, Gradescope is the
only place that knows whether the work is actually **done** — the LMS will
happily keep showing the assignment as outstanding forever. This adapter reads
that submission state and feeds it back into the agenda, which is what stops the
page from nagging about homework you turned in a week ago.

It is the only part of this repo that needs a language other than Node, it is
the only connector that logs in with a password rather than through an official
integration, and it is **off by default**. Turn it on deliberately.

---

## Read this before you enable it

This adapter logs into Gradescope as you and reads your own course pages,
through an unofficial community library that parses the site's HTML. There is no
public Gradescope API for students.

**Check your institution's acceptable-use policy and Gradescope's own terms of
service, and decide for yourself whether automated access to your own account is
something you are comfortable with.** This repo cannot make that call for you and
does not try to. If the answer is no — or if you are unsure — leave the connector
disabled. Everything else in the agenda works without it; you simply lose the
"already submitted" signal for courses that live on Gradescope.

Some practical notes for that decision:

- It reads only your own account, only course and assignment listings, and only
  when a run happens. It never posts, submits, or modifies anything.
- It is a handful of page fetches per run, not a crawl.
- Because it depends on the site's markup, it *will* break when Gradescope
  redesigns something. That is expected, not a bug in your setup — see
  [Troubleshooting](#troubleshooting).

---

## Enabling it

**1. Install Python 3 and the dependency.**

```
python -m pip install -r extras/gradescope/requirements.txt
```

**Use `python -m pip`, not bare `pip`.** With more than one interpreter on a
machine — and there usually is — bare `pip` can install into a different one than
the connector will run, and you get `gradescopeapi not installed` from a
successful install.

If `python` on your PATH is not the interpreter you want, use that one in the
command above and point the connector at it in `config.json`:

```json
"connectors": { "grades": { "gradescope": { "python": "python3" } } }
```

**2. Save your credentials.**

```
python extras/gradescope/gradescope.py --setup
```

> **This command stops and waits for typing, and only you can answer it.** It
> asks for your email, then shows a **hidden password prompt** — no characters
> echo. An agent calling it from a tool will hang, or get end-of-file and fail.
> **Run it yourself, in your own terminal.** This is the one place in this whole
> repository a password is stored, and that is deliberate: it should be a thing
> you did on purpose.

It prompts for the **complete email address you log into Gradescope with** and
the password (hidden). No domain is ever appended to what you type: a Gradescope
account is frequently not at your institution's domain, and a guessed address
just fails in a way that looks like a wrong password.

**3. Turn the connector on** in `config.json`:

```json
"connectors": { "grades": { "gradescope": { "enabled": true } } }
```

**4. Check it.**

```
node scripts/validate-setup.mjs        # or /agenda-doctor in Claude Code
python extras/gradescope/gradescope.py --check
```

---

## Where the credentials live, and what is never committed

Credentials are written to `extras/gradescope/gradescope-credentials.json`, next
to the adapter. That path is covered by the repository's ignore rules
(`*credentials*.json` and `*.dpapi`), so it is never committed — but the file is
still on your disk, so treat the folder accordingly.

Two shapes are supported:

| Shape | What it is |
|---|---|
| `{"email": "...", "dpapiPassword": "<base64>"}` | **The normal one.** Written by `--setup`. The password is sealed with Windows DPAPI at CurrentUser scope: only your Windows account on that machine can unseal it, and no plaintext password is on disk. |
| `{"email": "...", "password": "..."}` | Plaintext. It works, and it is discouraged. It exists for platforms where DPAPI does not — if you use it, make sure you understand that anything able to read the file can read the password. |

The sealing and unsealing subprocess passes the secret on **stdin and stdout
only** — never through `argv`, which every other process on the machine can see,
and never through a temp file, which survives a crash.

---

## The empty-result canary

The library this adapter depends on returns an **empty list** when its parsing
breaks or the session is lost. No exception, no error, exit code zero. So a
total failure and "you have nothing due" produce byte-identical output, and the
failure mode is the dangerous one: a silently empty result would tell you your
week is clear.

The canary is the guard against exactly that. Every run records how many
assignments each course had. If a course that had work last run comes back with
zero this run — or if a course's status column becomes entirely unreadable — that
is treated as a **failure**, not an empty agenda:

- the finding is written into the payload's `errors[]`, so the data explains
  itself to whatever reads it next;
- the adapter exits non-zero, so the connector surfaces a visible
  `grades-gradescope:` error instead of quietly contributing nothing;
- the run continues **without** Gradescope data, rather than with data that
  claims nothing is due.

Being loudly absent beats being quietly wrong. There is no baseline on the very
first run, so the canary stays silent until it has something to compare against.

---

## Checking it without touching your account

```
python extras/gradescope/gradescope.py --self-test
```

Runs 26 cases against the pure logic — the submission-status classifier, the
course-code normalizer (including LTI-provisioned course names), and the canary
itself. **No credentials, no network, no login.** Run it after any upgrade of
the dependency; if the classifier cases still pass but live runs come back
empty, the drift is in the library's HTML parsing, not here.

```
python extras/gradescope/gradescope.py --check
```

Reports whether the library is importable, which methods it exposes, and whether
Gradescope's login form still parses. Also credential-free — it attempts no
login. This is the one to run when you cannot tell a rejected password from a
changed website.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no credentials file; the connector is dormant` | `--setup` has not been run | `python extras/gradescope/gradescope.py --setup`, **in your own terminal** — it prompts for a password |
| `could not run "python"` | The configured interpreter is not on PATH | Set `connectors.grades.gradescope.python` to the right command |
| `gradescopeapi not installed` | Dependency missing from *that* interpreter | `python -m pip install -r extras/gradescope/requirements.txt`, using the **same** interpreter the connector is configured to run |
| Login refused | Wrong password — **or** the site's login form moved | Run `--check`. It tells the two apart; only the first is your fault |
| `canary: <code> went N -> 0 assignments` | Library drift, or a lost session | Check the library's [releases](https://github.com/nyuoss/gradescope-api/releases) and bump the pin in `requirements.txt` |
| Everything works but items still look undone | The titles do not match closely enough to pair up | Compare the assignment names on Gradescope with the ones in your LMS |

If it stays broken, disabling it costs you nothing but the submission signal:

```json
"connectors": { "grades": { "gradescope": { "enabled": false } } }
```
