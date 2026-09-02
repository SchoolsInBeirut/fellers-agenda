# Gradescope — an optional grades extra

**Tier 3 — expect trouble.** It scrapes a rendered page through an unofficial
library, and `meta.tier` says `3` for exactly that reason.

**Off by default. Deliberately.** Turning it on is a decision you make after
reading `extras/gradescope/README.md`, including the part about your
institution's and the service's terms.

```jsonc
"connectors": {
  "grades": {
    "gradescope": { "enabled": false, "python": "python", "termLabel": "[NOT SET]" }
  }
}
```

---

## Why anyone wants it

Some courses collect **everything** on an external grading service. For those
courses the LMS knows the assignment exists and knows nothing about whether you
did it — so every item sits at `submitted: null` forever, the backlog looks
permanently full, and the behind check has nothing to work with.

The external service is the only place that knows.

It also closes items that were born from **email**. An instructor announces "Hw1"
by mail, so the item is `0::homework::hw1`; you submit "Homework 1" on the
grading service; and the overlay matches on course plus fuzzy title —
**deliberately ignoring the due date and the source** — and closes it.

Title matching is strict about numbers on purpose: `HW1` matches `Homework 1`,
and `HW 1` does **not** match `HW 11`.

---

## Why it is off

Four honest reasons:

1. **It is the only thing in this repo that needs Python.** Everything else is
   Node standard library with zero dependencies. This one extra brings a runtime,
   a package and a version to keep working.
2. **It scrapes.** There is no student API. The adapter drives a third-party
   library that parses the course page's status column. That is more fragile than
   an API and more exposed to terms of service than an API.
3. **It stores a credential.** No other connector does. On Windows it is sealed
   to your account; it is never plaintext, never in `argv` and never logged — but
   it is still a password on your disk, and you should decide that deliberately.
4. **Most people do not need it.** If your courses collect on the LMS, the
   gradebook already gives positive evidence and this adds nothing.

An extra that ships enabled is an extra nobody chose.

---

## What it emits

`data/gradescope.json`: every assignment in every tracked course, dated or not,
each with:

| Field | Notes |
|---|---|
| `submitted` | `true` / `false` / **`null` = unknown** |
| `status` | The raw status text, kept so a parse failure is diagnosable |
| `grade`, `maxGrade` | When present |
| a deep link | So the card can link to the submission page |

**`submitted: null` never closes anything.** This connector has the same
tri-state obligation as every other one, and it has more chances to get it wrong
than most, because it is reading a rendered status column rather than a field.

`docs/design-notes/data-truth.md` is required reading before you touch this
adapter.

---

## The empty-result canary

The failure this adapter guards hardest against is not an error. It is a
**silence that looks like good news.**

The service answers, the session is fine, the page parses — and a course that had
twelve assignments last run comes back with zero. Nothing threw. If the adapter
passed that through, every item in that course would suddenly have no
contradicting evidence and the agenda would quietly report a clear week.

So it refuses:

```
gradescope: PHYS 221 went 12 -> 0 assignments
gradescope: CHEM 115 statuses all unreadable
```

and **drops itself from the cycle** for that run. The previous state stands.

**Mention it once in the digest like any other snapshot error and do not retry in
a loop.** It usually means the service changed its page layout or the session
drifted. The diagnostic is:

```
python extras/gradescope/gradescope.py --check
```

which also probes the login form. `login form reachable: False` means the
**library** drifted, not that your credentials are wrong — a distinction worth
having before you go resetting a password.

---

## Enabling it

**Read `extras/gradescope/README.md` first.** Then:

**1. Install the dependency:**

```
python -m pip install -r extras/gradescope/requirements.txt
```

The version is pinned. It is deliberately not watched by Dependabot: an automatic
bump to a scraping library is a change a human should read.

**2. Store the credential:**

```
python extras/gradescope/gradescope.py --setup
```

> **This command stops and waits for typing, and it is yours to run.** It asks
> for your full Gradescope email address, then shows a **hidden password prompt**
> — the characters do not echo. An agent cannot answer either one: called from a
> tool it hangs, or reads end-of-file and fails. Run it **in your own terminal**,
> then come back. `--check` and `--self-test` are the non-interactive commands,
> and they are the ones to verify with afterwards.

Your email is entered in full — **no domain is ever appended to a username.**
Guessing at a domain produces a rejection that looks exactly like a wrong
password, which is a bad half-hour.

The password is sealed at rest to your operating-system account. It reaches the
subprocess over **stdin and stdout only** — never `argv`, never a temporary file,
never a log. The credentials file is git-ignored by three separate patterns.

**3. Turn it on:**

```jsonc
"grades": { "gradescope": { "enabled": true, "python": "python", "termLabel": "Fall 2026" } }
```

`python` is the executable name or full path; the shim checks it **exists** before
running anything.

`termLabel` says **which term to read**. `adapterArgs()` in
`src/connectors/grades-gradescope.mjs` turns it into `--term "Fall 2026"` on the
Python adapter's command line, and that is what disambiguates a course you have
taken more than once.

Leave it unset and the adapter derives the term from the system clock. That is
right for a semester system in mid-term and wrong the rest of the time: wrong on
a quarter system, wrong over a summer term, and wrong every January that you open
the previous term's gradebook.

**4. Verify:**

```
python extras/gradescope/gradescope.py --check       # session and login form
python extras/gradescope/gradescope.py --self-test   # 26 offline parser cases, no credentials
node src/scrape.mjs
```

Both diagnostics exit 0 and neither needs credentials to be *valid* — `--self-test`
needs none at all.

---

## How failures are handled

The JS shim checks, in order: connector enabled → the Python binary exists →
the credentials file is present → run it.

**Any failure produces one `errors[]` entry and never a throw.** A grading
service being down is not a reason for you to have no agenda.

| Situation | Result |
|---|---|
| Not enabled | Silent. Nothing is logged, ever |
| Python not found | One error line naming `connectors.grades.gradescope.python` |
| No credentials file | One error line. **This is the normal state and is not a fault** |
| Malformed or undecryptable credentials | One error line. **Deliberately loud** — never papered over, because a silently broken credential means silently missing evidence |
| The empty-result canary fired | One error line, the connector drops out for that run |
| Session expired | One error line, mentioned once in the digest |

---

## Library reality, so nobody re-litigates it

The Python library exposes submission state **to a student session** only through
the parsed status column on the course page, plus grade and maximum grade.

The instructor-facing submission objects exist in the library and are
**instructor-only**. If you find yourself reaching for them, you will get a
permission error, and the answer is that there is no student-side equivalent.

That is why the status column is parsed, why unreadable statuses are a canary
rather than an assumption, and why this connector is the most fragile thing in
the repo.

---

## Terms of service

**Check your institution's acceptable-use policy and the service's own terms
before enabling this.** Automated access to a grading platform may be restricted,
and that is a question about your account and your school, not about this code.

This repo ships the adapter **disabled**, requires you to store a credential
deliberately, and puts this paragraph in three places. That is the most it can
reasonably do — the decision is yours.

`extras/gradescope/README.md` has the longer version.
