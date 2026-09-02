# Design note: hands-free re-authentication, and the exit-code contract

*Why the login flow was rewritten, and why one failure had to become six.*

---

## The problem

A learning-management session expires. When it does, a scheduled run scrapes
nothing, and every downstream step operates on stale data — or the run stops and
the user gets a notification saying "your session expired" that they will read
eight hours later.

Neither is good. But the interesting part is that **"your session expired" is not
one problem.** It is at least five, and they have five different fixes:

| What actually happened | What the user must do |
|---|---|
| The session just aged out | Nothing — re-authenticate and carry on |
| A second-factor push reached their phone but expired | Approve the next one |
| The stored password is wrong | Re-run setup and type the new one |
| No credentials were ever saved | Run setup once |
| The LMS server package is not installed | Install it once |

A wrapper that reports all five as `auth failed` forces the user to diagnose the
difference themselves, at 7am, from a push notification. Most of them will just
stop trusting the notification.

---

## Half the problem was the login page itself

Automated single sign-on had been "broken" for a long time and nobody could say
why: **manual login worked perfectly, automated login hung forever.** The hang was
silent — a fully rendered browser sitting on a fully functional login page,
waiting.

Probing the live chain explained it. The institution's identity provider no
longer served the older single-sign-on form. It now delegates to **Microsoft
Entra ID**, which is a materially different flow:

```
LMS campus selector
  -> SAML initiate (the selector's buttons are inside a shadow DOM,
                    so they cannot be clicked -- navigate the URL directly)
  -> Entra email field        (submits, and is REPLACED by...)
  -> Entra password field     (a second step, not a second field)
  -> second-factor prompt     (Duo Universal Prompt, on its own domain)
  -> "Stay signed in?"        (Entra KMSI)
  -> LMS home
```

The published build waited for the *old* form's username selector, which never
appears on that chain. So it waited until it timed out, every time, having done
nothing.

Four things in that list are non-obvious and each one costs an afternoon to
rediscover:

1. **The campus selector's buttons live in a shadow DOM.** They cannot be
   selected and clicked. Navigate straight to the SAML endpoint instead.
2. **Email and password are two sequential steps, not two fields on one form.**
   Fill-both-then-submit never works.
3. **The second-factor prompt and the "stay signed in?" page arrive in an order
   that genuinely varies.** Two sequential handlers deadlock whenever the order
   flips. One polling state machine that handles whichever is on screen does not.
4. **Verified Push shows a code the phone must match.** If the browser is
   headless, the user is staring at a phone asking for a number that exists only
   on a screen they cannot see. It has to be printed.

The rewrite drives that chain, keeps the older selectors as a fallback so
institutions that have not migrated are unaffected, always accepts "remember this
browser" (which is what makes later runs prompt-free on a persistent profile),
and — critically — **throws distinguishable errors**.

The patch is at `vendor/brightspace-mcp-server/entra-duo-sso.patch`, and
`vendor/brightspace-mcp-server/NOTICE.md` argues that it should be a pull request
upstream rather than a patch anyone carries forever.

---

## The exit-code contract

`scripts/reauth.mjs --silent` classifies the failure and maps it to an exit code.
The runbook acts on the code and never on the message text. This is the entire
interface between "something went wrong with the login" and "what the user is
told".

| exit | meaning | the run does | log token |
|---|---|---|---|
| **0** | re-auth worked, session refreshed | re-run the scrape **once**, continue normally, **no alarm** | `reauth=ok` |
| **6** | a second factor was raised and never answered in time | one push + email: *"the hourly auth lane raises a fresh prompt within the hour"*, then **STOP** | `reauth=MFA-PENDING` |
| **5** | the stored password was rejected | push + email: *"run `--setup` to update it"*, **STOP** | `reauth=BAD-CREDS` |
| **2** | no credentials saved yet | *"run `--setup` once to enable hands-free re-auth"*, **STOP** | `reauth=NO-CREDS` |
| **7** | the LMS server package is missing | *"run the auth CLI once to reinstall"*, **STOP** | `reauth=NO-PACKAGE` |
| **1** | anything else | the generic auth alarm, carrying the wrapper's last printed line, **STOP** | `reauth=FAILED` |

Four rules bind this table:

- **Never run `--silent` more than once per run.** A retry loop against a login
  page is how an account gets locked.
- **`--setup` is a human at a keyboard.** It waits on stdin for a password, so it
  can only ever be run by the user, in their own terminal. A scheduled run that
  invoked it would hang until its time limit, having done nothing. `--silent` is
  the run's flag; `--setup` is the user's.
- **Every STOP keeps the old rule: do not continue on stale data.** An agenda
  built from yesterday's scrape and presented as today's is worse than no agenda,
  because the user acts on it.
- **The light sync lane never scrapes, so it never invokes re-auth.** There is no
  branch for this in `runbooks/sync-run.md` and there should not be one.

Exit 6 is the one worth dwelling on. "A second factor was raised and you did not
answer it" is *not an error* — it is a completely normal thing to happen when a
phone is in another room. The correct response is a friendly one-line note and a
stop. Reporting it as a failure trains the user to ignore auth notifications, and
then a real one arrives.

---

## The retry policy: who picks 6 back up

The table above ends every failure at **STOP**, and for a long time that was the
whole story: the next scheduled run tried again. On the shipped schedule that
means the retry interval for a failed login is **eleven hours**, and if the
evening run fails the same way it is eleven more.

`src/auth-retry.mjs` is the lane that closes that gap. It runs on its own hourly
scheduled task, it is the *only* thing in this repository that retries a login,
and no run may invoke it. What it does with each exit code:

| exit | token | the hourly lane |
|---|---|---|
| 0 | `ok` | done — deletes any lock file and goes quiet |
| 1 | `FAILED` | retry in an hour |
| 2 | `NO-CREDS` | retry in an hour |
| **4** | `USAGE` | retry in an hour, **and let the failure counter climb** |
| **5** | **`BAD-CREDS`** | **stop permanently** — writes `data/auth-locked.json` |
| 6 | `MFA-PENDING` | retry in an hour — and raise a fresh prompt each time |
| 7 | `NO-PACKAGE` | retry in an hour |

**Exit 5 is the only stop, and it has to be.** Institutions lock accounts after a
handful of rejected passwords. An hourly retry against one the school has already
refused converts "my agenda is stale" - an inconvenience - into "I cannot log in
to anything" - an afternoon with the help desk. So exit 5 leaves a tombstone and
the lane never fires again. Two things follow from that, and both are load-bearing:

- **The tombstone's existence is the lock.** There is no boolean anywhere else,
  so the two cannot drift out of step, and a tombstone whose JSON will not parse
  reads as *still locked* rather than as no lock. The only ways out are a
  successful login, or a human running `--setup` and then `--clear-lock`.
- **Nothing unknown may ever reach that state.** `classifyExit` maps every code
  it does not recognise to `FAILED`, never to `BAD-CREDS`, and there is a test
  asserting exactly that. A stop this expensive must be reachable only on
  purpose.

**Exit 4 (`USAGE`) is the interesting one**, because it is not a login failure at
all: it means the lane called `reauth.mjs` wrongly, which is a bug in us.
Retrying is harmless — no push, no network, instant — and it will never fix
itself, so the useful behaviour is to retry *and* let `consecutiveFailures`
climb. A digest that can say "the auth lane has failed twelve times with USAGE"
names a code bug; one that silently stopped would hide it.

`docs/design-notes/watchdogs.md` covers why this is a separate lane rather than a
rule inside the run, and why the stale-run watchdog is *right* to stay silent
while it happens.

---

## Number matching, and why "retry" and "relay" are one feature

Everything above assumes that retrying a login is worth something. Under an
approve/deny push it obviously is: the prompt goes to the phone, and a second
attempt is a second chance at the same thing.

**Under number matching it is worth nothing at all**, and this changes the design
rather than decorating it.

Some identity providers - Microsoft Entra prominently - no longer send an
approve/deny push. Each sign-in renders a short number *on the sign-in page*, and
the user must type that number into their authenticator app within roughly 60-90
seconds. So:

> A headless login raises a prompt **nobody can see**. That is not "a push the
> user missed" — it is a prompt that was never answerable at all. Retrying it
> hourly without relaying the number just repeats an unanswerable prompt forever.

So the lane has a second job beside deciding *whether* to fire: it has to get the
number in front of the user **while it is still worth typing**. Four things make
that work, and each of them is defended by a test.

1. **Capture.** The vendored login patch already polls every 500 ms waiting for
   the second factor, so the number is one DOM read away. The probe sits at the
   top of that loop, runs on every poll regardless of the current URL, and prints
   `MFA-NUMBER: <n>` on the first sight of it. It is anchored to **strictly 1-3
   digits**: relaying a *wrong* number is worse than relaying none, because the
   user types it, so any other text in that element is discarded.
2. **Streaming, never buffering — on both sides of the seam.**
   `scripts/reauth.mjs` wraps the login child and forwards each chunk of its
   output to its own stdout the instant it arrives (`streamCollector`); then
   `src/auth-retry.mjs` reads that stdout line by line and calls its relay on the
   very line carrying the digits. This is not a style preference. If *either* side
   buffers — the wrapper flushing only to the transcript at exit, or the lane
   waiting for the child to close — you get the number minutes after it stopped
   working, which is the same as not delivering it. (The wrapper buffering its
   output was a real production failure: every cold login timed out at "token
   interception" with the number stranded in a string.) Two tests defend this:
   one drives the real reader against a real child and asserts the number reached
   the relay **more than 800 ms before the child exited**, and one asserts the
   wrapper's collector forwards a chunk live rather than only buffering it.
   Simplify either back to a buffered call and a test fails.
3. **Fire-and-forget channels, file first.** `data/auth-mfa.json` is written
   first because it is the only channel that cannot fail. Then an on-screen
   alert, platform-dispatched. Then the optional push hook. None is awaited and
   a channel that throws is swallowed — the login is sitting in a ninety-second
   window and nothing may block it.
4. **One prompt, one relay.** Only the first number is relayed. A resend would
   overwrite a number the user is halfway through typing.

And now the retry policy above earns its keep: an unanswered number prompt is
still exit 6, still retried in an hour, **because each retry produces a fresh
number and a fresh relay.** That is what makes hourly retrying useful here rather
than merely noisy.

### The honest gap

The on-screen alert reliably reaches the **screen**. Whether it reaches the
**phone** depends entirely on whether the user wrote a push hook, and that is a
seam this repository documents rather than a provider it hard-codes.
`docs/CONFIG.md` ships a worked example: a one-line `curl` to
[ntfy](https://ntfy.sh) that reaches the phone in under a second, with Pushover,
Telegram or a self-hosted server dropping into the same hook unchanged. It is not
installed by default and is not required. (A `claude -p --allowedTools
PushNotification` hook is a tempting one-liner but does **not** work here: that
tool only pushes through a live Remote-Control-connected session, so a hook
spawned fresh from a scheduler reports success and delivers nothing.)

The capture selector itself is **unverified in production.** It is the element
Entra ships today and the code path is unit-tested end to end, but no run in this
repository has yet met a live number-matching prompt to confirm it. Treat it as
unverified until an `AUTH ` line in `data/runlog.txt` turns up carrying `mfa=<n>`.
If it is wrong, the fix is one selector, and `data/reauth-last-output.txt` plus
`node scripts/reauth.mjs --probe` are the two diagnostics for it.

---

## The security model

The password has exactly three states and no others:

1. **The user's keystrokes** during interactive setup.
2. **Sealed ciphertext at rest**, decryptable only by that operating-system
   account on that machine.
3. **In memory and in the login child process's environment** during a login,
   and cleared immediately after.

**Never in `argv`** — process arguments are readable by other processes on most
systems and end up in shell history. **Never plaintext on disk. Never in a log**,
and the output scrubber defends the log path regardless of what the auth tool
decides to print.

A scheduled run may **run** the wrapper. It may never read, write, move or print
the credentials store, and it may never run interactive setup — that is the user
typing a password into a terminal, which is a thing a person does and a scheduled
task does not.

Network egress is unchanged from the audited package: the LMS host, the
institution's identity provider, the Entra endpoint, the second-factor provider,
and a local browser. Nothing else, and nothing belonging to this repo.

---

## When it breaks again

It will. Login pages change, and this is the part of the stack most exposed to
that.

```
node scripts/reauth.mjs --probe
```

records the live login chain — **with no credentials at all** — to
`data/auth-probe.json`. That file holds the public login form's structure and
nothing else, and it is safe to read and safe to paste into an issue.

**The probe is read-only, and that property is the whole point of it.** It never
opens a login, never sends a second-factor push, never touches the credentials
store, and never blocks for five minutes waiting on a browser. A "diagnostic"
that quietly started a real login would be worse than no diagnostic: you would
reach for it precisely when things are already broken, and it would cost a phone
push and five minutes to tell you nothing.

Which is why **an unknown flag is a hard error** rather than being ignored.
`--probe` and `--porbe` must not be the same command, because the second one
would fall through to the default behaviour — the real login — under a name that
promised safety. The script refuses to run and names the flag instead.

**The probe is the permanent diagnostic, not a one-off.** When selectors drift,
the probe tells you what is actually being served now, and the fix is a selector
update in the patch. Guessing at selectors without a probe is how an afternoon
disappears.

**The second diagnostic is the transcript.** Every non-probe run of
`scripts/reauth.mjs` leaves the login child's whole output - already
password-scrubbed, last 20 kB, overwritten each run - in
`data/reauth-last-output.txt`. Before it existed, callers read one line out of
that child and threw the rest away, which meant a crashed auth CLI and a lost
second-factor prompt both reported as `reauth=FAILED exit 1` with a last line
that named a Node version and nothing else. Those two have opposite fixes. The
difference between them is always legible about fifteen lines earlier, and now it
is kept. Writing that file is wrapped so it can never turn a working login into a
failed one: an unwritable data directory is a diagnostics problem.

---

## What "hands-free" actually means

It does not mean "no human ever touches it".

It means: **the only recurring human step is answering an occasional second
factor on a phone.** Setup is typed once. The trust-this-browser cookie lives in
a persistent browser profile, so most re-auths skip the second factor entirely.
Everything else — noticing the expiry, re-authenticating, retrying hourly until
it works, re-running the scrape, continuing the run — happens without anyone
being awake for it.

The one thing it cannot do without you is a **rejected password**. That stops the
lane on purpose, and it stays stopped until you type a new one. There is no way
to automate that which does not also risk your account.

That is the honest description, and it is the one the setup agent gives.
