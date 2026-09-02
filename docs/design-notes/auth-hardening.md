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
| **6** | a second-factor push was sent, never approved in time | one push + email: *"approve the next one and the agenda catches up automatically"*, then **STOP** | `reauth=MFA-PENDING` |
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

Exit 6 is the one worth dwelling on. "A push was sent and you did not approve it"
is *not an error* — it is a completely normal thing to happen when a phone is in
another room. The correct response is a friendly one-line note and a stop, and
the next scheduled run picks it up. Reporting it as a failure trains the user to
ignore auth notifications, and then a real one arrives.

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

---

## What "hands-free" actually means

It does not mean "no human ever touches it".

It means: **the only recurring human step is approving an occasional push on a
phone.** Setup is typed once. The trust-this-browser cookie lives in a persistent
browser profile, so most re-auths skip the second factor entirely. Everything
else — noticing the expiry, re-authenticating, re-running the scrape, continuing
the run — happens without anyone being awake for it.

That is the honest description, and it is the one the setup agent gives.
