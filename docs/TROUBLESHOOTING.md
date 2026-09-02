# Troubleshooting

**Start here:**

```
node scripts/validate-setup.mjs
```

It prints a fix link for every failure, never throws, and **touches no network**.

When the machine looks fine but a source does not, ask the sources themselves:

```
node scripts/health-check.mjs
```

That runs every **enabled** connector's own liveness probe — is the session
alive, is the token accepted — and prints a fix per failure. It writes nothing:
no scrape, no calendar event, no file. Exit 1 means at least one could not
answer.

Inside Claude Code, `/agenda-doctor` runs both, plus a configuration review and a
look at your recent runs.

**If that command itself will not run**, the answer is almost always Node:
`node --version` should print `v22` or higher. If it prints nothing, or
"command not found", install the LTS build from
[nodejs.org](https://nodejs.org), close the terminal, open a new one, and try
again — a fresh `PATH` needs a fresh shell.

**Then find your symptom below.**

---

## Setup and permissions

| Symptom | Cause | Fix |
|---|---|---|
| A dialog appeared asking *"Do you trust the MCP servers in this project?"* | This is normal and correct. A project-scoped server needs a **per-user, per-project** approval | Say yes. It is this repo asking permission to talk to your school, and it only ever reads. **No repository can pre-grant this** — there is no setting that skips it |
| You dismissed that dialog and now nothing works | The approval is remembered as "no" | `claude mcp reset-project-choices`, then reopen the folder |
| `claude mcp list` shows `brightspace` as pending | The trust dialog has not been answered | Answer it. If you never saw it, reset as above |
| A Google consent screen appeared asking Claude for Drive access | Normal. That is **Google's** screen, not this repo's | Approve it. The page only ever creates and reads documents whose titles start with your namespace |
| Setup ran but `/agenda-now` says setup has not run | `CLAUDE.md` Part 2 still contains unfilled fields | Say `hey` again; the setup agent resumes at the first unanswered question and rewrites Part 2 |
| Claude Code keeps asking to approve commands and file writes | **Working as intended.** `.claude/settings.json` pre-approves a short list of read-only commands; everything else asks once, per kind | Approve them. This template deliberately does not ship anything that turns prompts off — `SECURITY.md` explains why |
| You edited `.mcp.json` and the server still behaves the old way | Claude Code reads `.mcp.json` **at session start** | Close the session, run `claude` again. Nothing works around this |
| A command seems to hang forever with no output | It is waiting for you to type. `gh auth login`, `gh auth refresh` and `gradescope.py --setup` are interactive and cannot be driven by an agent | Stop it, run it yourself in a terminal, then come back. `docs/SETUP.md` Step 10 lists all three and what each one asks |
| `/agenda-doctor` reports failures right after you started setup | **A half-finished `config.json` makes the preflight stricter, on purpose** | Not a fault. Say `hey` and finish setup; the failures go with it |
| A command exits with `ConfigError: config: "<key>" is not set yet` and a stack trace | Exactly what it says — that key has no value, and the module needed it | The first line is the real message; the stack below it is noise. Say `hey` to finish setup, or set the key by hand — `docs/CONFIG.md` documents every one |
| `npm test` or `node --test` fails with `MODULE_NOT_FOUND` on `test` | You ran `node --test test/`. Node's handling of a bare directory argument has changed between releases | Use `npm test`, which runs `node --test test/*.test.mjs` — the form CI uses on every supported version |
| You want to start completely over | — | `node scripts/reset.mjs` lists what it would remove and removes nothing; `node scripts/reset.mjs --yes` does it. Same command on every OS, and it never touches `backups/`. `docs/SETUP.md` → "Starting over" has the rest. Or just ask: *"reset my setup"* |

---

## Logging in to your school

**Brightspace only.** The Canvas connector uses a token and has no login flow —
its failures are in the next table.

| Symptom | Cause | Fix |
|---|---|---|
| The login browser opens and **hangs forever** on a fully rendered login page | The published package waits for an older single-sign-on form. Your school delegates to Microsoft Entra ID with a second-factor prompt, which it does not drive | Install from upstream `main` (the fix may already be merged), or apply `vendor/brightspace-mcp-server/entra-duo-sso.patch`. Both are in `docs/connectors/brightspace.md`. **Do not just retry** |
| A second factor was raised and expired before you answered it | Completely normal | Do nothing. The hourly auth lane raises a fresh one within the hour. Logged as `reauth=MFA-PENDING` (exit 6) — it is a note, not a failure |
| Your phone shows a code to match and you cannot see one on screen | The browser is headless | The wrapper prints it. Look for `SECOND-FACTOR CODE:` or `MFA-NUMBER:` in the output, or read `data/auth-mfa.json`, which the auth lane writes the instant a number appears. If neither is there, see the two rows below |
| **The login keeps failing and I never get a number** | Number matching is in use and the capture selector has drifted. Identity providers rename these elements | Run the read-only probe: `node scripts/reauth.mjs --probe`, and read `data/reauth-last-output.txt` — the last login's whole transcript. Compare what the page actually renders against the `displaySign` selector in `vendor/brightspace-mcp-server/entra-duo-sso.patch`. **That selector is flagged unverified in production**: it is the one Entra ships today, but no run in this repository has yet met a live number-matching prompt to confirm it. If it is wrong, the fix is one selector |
| **A number arrived but had already expired by the time I saw it** | The prompt is good for about 60-90 seconds and the relay reached only the screen | Set `authRetry.pushHook` (or drop a `data/push-hook.cmd` / `data/push-hook.sh` in place) so the number reaches your *phone* too. `docs/CONFIG.md` has a one-line `curl` hook to [ntfy](https://ntfy.sh) (or Pushover / Telegram) that reaches your phone in under a second. Each hourly retry raises a **fresh** number, so nothing is lost — you just wait for the next one |
| **"My session expired and nothing is fixing it"** | Either the lane is locked out, or it is opted out | In this order: 1. does `data/auth-locked.json` exist? Then the school rejected your password and the lane stopped **on purpose** — see the next row. 2. `node src/auth-retry.mjs --status`, which prints what it can see and the verdict it would reach, and writes nothing. 3. `grep ^AUTH data/runlog.txt` for every login it has attempted |
| `reauth=BAD-CREDS` (exit 5), or `data/auth-locked.json` exists | The stored password was rejected, and the hourly lane has **stopped permanently** so it cannot lock your account | `node scripts/reauth.mjs --setup`, type the new password, then `node src/auth-retry.mjs --clear-lock`. **That first command is interactive** — it waits on your keyboard, so run it yourself in a terminal; an agent cannot answer it. **Never just delete the lock file.** Its existence *is* the stop, and removing it without fixing the password restarts hourly attempts against a rejected one |
| `reauth=NO-CREDS` (exit 2) | Nothing was ever saved | `node scripts/reauth.mjs --setup` once — again, interactive and yours to type. Or `npx brightspace-mcp-server@latest auth` for a one-off |
| `reauth=NO-PACKAGE` (exit 7) | The LMS server package is not installed | `npx -y brightspace-mcp-server@latest auth` once |
| Login used to work and suddenly does not | Your school changed its login page. This happens | `node scripts/reauth.mjs --probe` records the **current** chain to `data/auth-probe.json`. It is **read-only: it never opens a login, never sends a push, and captures no credentials** — the file holds the public login form's structure and nothing else, so it is safe to read and safe to paste into an issue. It is the permanent diagnostic |
| `reauth.mjs` refuses to start and names a flag | Unknown flags are a **hard error**, on purpose | Check the spelling. The flags are `--silent`, `--probe`, `--setup`, `--dry-run`, `--quiet` and `--home`. A wrapper that ignored a typo would run the real login when you asked for a diagnostic |
| A login failed with `exit 1` and the last line says nothing useful | One exit code and one last line cannot tell a crashed auth CLI apart from an unanswered prompt | Read `data/reauth-last-output.txt`. Every non-probe run overwrites it with that login's whole output, password-scrubbed, last 20 kB. The reason is almost always fifteen lines above the last one |
| The auth lane never fires at all, and `--status` says `no-session-source` | Your LMS connector keeps no session file, so the lane opted out rather than fire hourly forever | This is correct for Canvas, which uses a token. If your connector *does* mint a session file, add its path to `authRetry.sessionFiles` in `config.json` |
| `get_my_courses` returns nothing after a successful login | The session did not actually take | Re-run the auth CLI **once**. If it happens twice, stop and file an issue with the probe output |

---

## Windows-specific

| Symptom | Cause | Fix |
|---|---|---|
| The LMS connector returns nothing at all, no error | **`.mcp.json` has a bare `npx` entry.** On Windows an stdio `npx` server fails **silently** — the process never starts and nothing is raised | Change it to `{"command": "cmd", "args": ["/c", "npx", "-y", "<pkg>"]}`. This is the single most common cross-platform break in this project. `validate-setup.mjs` checks for it |
| Mail and calendar connectors report `requires Windows` on Windows | You have the **new** Outlook app, not classic Outlook. They are different programs and the new one has no automation surface | Install classic Outlook, or leave both connectors off — everything else works. See `docs/connectors/outlook.md` |
| Outlook mail is stale by days | The mail client is offline | Open it and let it sync. The run logs `mail:stale(...)` and continues. **Never let a scheduled run start or restart the mail client** — it can leave you with one that cannot complete its own login |
| A scheduled task looks installed but never runs | `schtasks` does **not validate its target.** A task pointing at a missing or moved script fails silently and looks perfectly installed | Re-run `scripts\install-tasks.cmd`. It verifies every target exists before registering, and it is idempotent |
| You want to know *why* a task did not fire | The Task Scheduler operational log is off by default on Windows Home | Run once, elevated: `wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`. It is a bounded ring buffer and cannot grow without limit |
| A run happened at a strange hour | The stale-run watchdog rescued a run the machine slept through | Working as designed. `grep ^STALE data/runlog.txt` shows the rescues |

---

## Google Drive and the published page

| Symptom | Cause | Fix |
|---|---|---|
| The page says **"no data doc in Drive"** | No run has successfully uploaded yet, or the document title does not match `<namespace>-data` | Run `/agenda-now`. If it logs `drive=FAILED`, the message says why. Check that `namespace` in `config.json` matches what the published page was built with |
| The page says **"data doc unreadable (checksum)"** | The document body was truncated or altered. A CRC-32 guards it precisely because a truncated gzip stream can still *start* decompressing and would otherwise yield plausible partial data | **Re-run the upload. Do not hand-edit the document.** If it repeats, the payload may be near the size limit — see the oversize row below |
| The page shows yesterday's week and the refresh button does nothing | The Drive connector is not authorised in the browser session showing the page | Open the page's refresh control; it should say *"refreshed from Drive"*. If it does not, re-approve the Drive connector in your Claude account |
| A run logs `drive=SKIPPED(oversize)` | The payload did not fit the emit budget even at the highest slim tier. `render.mjs` wrote `data/payload.oversize.txt` and refused to truncate | The copy embedded in `agenda.html` is always complete, so the page still works from its own data. To fix it properly: reduce `scrapeWindowDays`, or accept a higher tier. **Raising `drive.maxEmitChars` is usually the wrong fix** — the agent has to type those characters and they cost tokens |
| The run reports a high tier every time | Genuinely a lot of data — many courses, many descriptions | `docs/PROTOCOL.md` says exactly what each tier drops. Tier 1 only loses blurbs on far-off items and is harmless |
| The Google Doc **mangles** the payload — line breaks appear inside it | Drive converted the plain text to a Google Doc and reflowed it | Readers strip all whitespace before decoding, so this is normally invisible. If it genuinely breaks, pass `disableConversionToGoogleType: true` on the `create_file` call |
| Duplicate `<ns>-data` documents piling up | A run created one and then failed before trashing the older ones. **This is the safe failure** — create always happens before trash | The next successful run cleans them up. If it does not, check whether something is trashing across titles, which it must never do |
| A mark you made on your phone vanished | A `<ns>-completions` document was trashed without being consumed | This is a bug and worth an issue. The rule is absolute: a run trashes **only** the documents its own ingest reported `ok`, and **never** a document with a different title |

---

## Connectors

| Symptom | Cause | Fix |
|---|---|---|
| `scrape: no LMS source is enabled.` and the run exits 1 | Exactly what it says. Every LMS connector is off, or the enabled one is missing something it needs | Enable **either or both**: set `connectors.lms.brightspace.enabled: true`, or set `connectors.lms.canvas.enabled: true` **and** give it a `baseUrl` and a `token`. `node scripts/validate-setup.mjs` fails on the same condition, so run it first |
| Canvas calls come back **401** | The token was rejected: revoked, expired, or made on a different Canvas site | Make a new one — Account → Settings → Approved Integrations → **+ New Access Token** — and put it in `connectors.lms.canvas.token`. The error message names the page |
| Canvas calls come back **403** | The token is recognised and the request is still refused. **Usually your institution has disabled student API access** | Ask your help desk whether API tokens are enabled for students. If they are not, no retry and no new token fixes it — `docs/connectors/canvas.md` says what is left |
| Canvas calls come back **429** | Rate limiting, not an auth problem | Nothing to do. The next run picks up where this one stopped |
| A Canvas course shows far fewer assignments than Canvas does | Canvas paginates at 10 per page and the link header is the only signal there is more | The connector follows `Link: rel="next"`. If you still see a short list, that is a bug worth an issue |
| `board=SKIPPED(gh not authenticated)` | The GitHub CLI is installed but not logged in | `gh auth login`, **in your own terminal** — it is an interactive wizard (protocol choice, then an eight-character code to paste into github.com) and an agent running it will hang. Until then the board is empty and the run continues normally. **Never fix `gh` auth from a scheduled run** |
| `board=SKIPPED(...scopes...)` | `gh` needs `repo` and `read:org` for your organisation | `gh auth refresh -s repo,read:org` — also interactive, also yours to type |
| Outlook connector reports COM unavailable | Classic Outlook is not running or not installed | It is **optional**. Set `connectors.mail.outlook.enabled: false` and everything else works. The mail panel hides itself |
| Python or Gradescope import errors | The optional grades extra is enabled and its Python dependency is missing | It ships **off**. Either disable it, or install `extras/gradescope/requirements.txt`. Read `extras/gradescope/README.md` first |
| `grades: <code> went 12 -> 0 assignments` | The **empty-result canary.** The service answered, but a course that had work last run came back empty, so the adapter refused to pass that off as "nothing is due" | Working as designed. Mention it once; **do not retry in a loop.** It usually means the service changed its page or the session drifted |
| A connector is enabled but the log says `skipped (requires Windows)` | Correct behaviour on macOS or Linux | Turn it off to silence the line. It never fails a run either way |

---

## The plan itself

| Symptom | Cause | Fix |
|---|---|---|
| The agenda says you have not done work you have done | **This should be impossible.** `submitted` is tri-state and `false` is only written when a source says so | This is the most serious bug class in the repo. File an issue with the redacted item and see `docs/design-notes/data-truth.md` |
| A course gets far too much or too little time | The study model's allocation disagrees with you | Every bucket explains itself in `data/study-model.json` → `courses.<bucket>.evidence[]`. Read that, then change `difficulty` — one value, and see what next week looks like. The weekly-review **skill** walks it: it is not a slash command, so trigger it in plain language — "how did last week go?" |
| A block you dragged moved back | A block edit did not reach the pipeline | Check `data/block-edits.json` exists and has an `edits[]` entry. If the render logs a `warn:` about it twice in a row, the page's edits are not getting through |
| A day has only one block | You pinned something long. **Pinned minutes come off the day's budget before anything else is sized** | Working as designed — that is your arithmetic, not a bug |
| Nothing is scheduled before 10am even though you are up | `wakeTime` is a **hard floor** | Change `wakeTime` in `config.json` |
| Study blocks land at hours you are busy | The planner only routes around commitments it can see — `schedule{}` entries with `attend: true`, exams and attended sittings | Add the commitment to `schedule{}`, or just drag the block and it will stay. Outside the timetable, block times are **advisory** |
| An exam appeared that you never signed up for | A connector or an agent turned an **announcement** into a commitment | That is the failure `docs/design-notes/attendance-vs-announcement.md` exists to prevent. File an issue |
| `completion.mjs` exits 6 and refuses | **The refusal is the feature.** Three causes: a session verb with no resolvable block, `--cancel` on something already done, or trying to un-do a pipeline observation | The message says which and what to do. `done → cancelled` is a two-step: `--undone` first. **Do not paper over exit 6** |
| `completion.mjs` exits 4 (ambiguous) | Your query matched several things | It printed the candidates with their exact keys. Re-run with one. **Nobody should pick one for you** |

---

## Scheduled runs

| Symptom | Cause | Fix |
|---|---|---|
| A run happened but nothing was sent | Correct. **At most one push and one email per run, and zero is expected** | Silence means nothing was due and nothing was behind. That is the goal |
| No morning digest today | Either nothing was due within 7 days and there was no diff activity (the digest is skipped), or the run did not happen | `grep -v -e ^SYNC -e ^STALE -e ^AUTH data/runlog.txt | tail -3` shows the last heavy runs |
| Two `STALE ` lines for the same lane in one day | The watchdog rescued that lane twice and has now stopped. **This is the signal that something is failing before the run reaches its log step** | Read `data/runlog-stdout.txt` for the last two attempts. This one genuinely needs a human. See `docs/design-notes/watchdogs.md` |
| `deadman=SKIPPED(no-calendar-sink)` | Nothing can host the dead-man's switch here | **Expected on most installations**, never a failure and never a reason to retry — but be clear about what it means: **the switch is not armed.** It needs a calendar *service* that can ring when this machine is gone, which in this repo means the **Outlook sink on Windows**. The ICS sink writes a file on the machine that stopped, so it cannot substitute, and no configuration change makes it able to |
| A calendar event you expected is not in Google or Apple Calendar | The ICS sink writes a **file**; something has to read it | Check `data/agenda.ics` exists and has a `BEGIN:VEVENT` for that item. If it does, the gap is the subscription — a subscribed URL is refreshed on Google's own schedule, typically every 8–24 hours. `docs/connectors/calendar-ics.md` |
| The whole thing has been silent for days | The machine was off, or the scheduler is disabled | With the Outlook sink you would have had a calendar alarm about 26 hours in. Without it there is no such alarm to miss — the in-machine watchdog still rescues a lane the machine slept through, but a machine that is *gone* has nothing watching it. `docs/design-notes/watchdogs.md` |
| A run stopped after the scrape with an auth token | Correct. **A heavy run never continues on stale data after an auth failure** | The token says which of six things happened. See the "Logging in" table above. The run tries once and then hands the question to the hourly auth lane; you do not have to do anything |
| No `AUTH ` lines in `data/runlog.txt` at all | Expected on a healthy machine. The lane writes there **only when it actually fires a login**, because it ticks 24 times a day | `data/auth-retry.json`'s `lastCheckAt` is the heartbeat. If that is stale too, the `<prefix> AuthRetry` task is not running — re-run `scripts\install-tasks.cmd` |
| `AUTH ` lines every hour with the same result | The lane is working and the login is not | Read the token on the line. `MFA-PENDING` means nobody answered the second factor — see the number-matching rows in the "Logging in" table. `USAGE` means the lane is calling `reauth.mjs` wrongly, which is a bug worth reporting rather than a login problem |

---

## Still stuck

1. `node scripts/validate-setup.mjs` — the fix links are per-check. No network.
2. `node scripts/health-check.mjs` — asks each enabled connector's backend
   whether it answers. Writes nothing.
3. `/agenda-doctor` in Claude Code — runs both, adds a configuration review and
   recent-run analysis.
4. `node scripts/demo.mjs` — if the demo renders, the pipeline is fine and the
   problem is a connector or a credential. If the demo does **not** render, that
   is a bug in this repo and worth an issue on its own.
5. Open an issue with `.github/ISSUE_TEMPLATE/bug_report.yml`. **Redact first:**
   no emails, no course names, no document ids, no tokens, no
   `C:\Users\<your name>` paths. The status tokens (`drive=OK(6712)`,
   `behind=notice(B3)`, `cmd=REFUSED`) are what a maintainer needs and they carry
   nothing private. A `data/auth-probe.json` from `node scripts/reauth.mjs
   --probe` is also safe to attach — it holds no credentials.
