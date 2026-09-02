# Design note: an announcement is not an attendance

*"The retake sitting is Wednesday at 7:30 pm" tells you an opportunity exists. It
tells you nothing about whether the user is going.*

---

## The failure

An instructor posts: *"The first reassessment sitting is Wednesday, 7:30 pm, in
`SCI 105`."*

The obvious thing for a scraper to do is create a deliverable. It has a date, a
time and a room; it looks exactly like an exam. So the pipeline makes it an item,
the item becomes a calendar event with a reminder, the planner sees an assessment
36 hours out and reorganises three days of study around preparing for it.

The user never signed up. There was nothing to prepare for.

**Cost: roughly three days of misdirected study, plus a calendar alarm for an
event they were never attending.** And the failure is invisible — everything
looked right, the data was accurate, the reasoning was consistent. It was just
answering a question nobody asked.

---

## The distinction

There are two different facts, and only one of them was in the announcement:

| Fact | Where it comes from |
|---|---|
| **This opportunity exists** | The announcement. Always true once posted |
| **The user is taking it** | A signup. **Never** in the announcement |

Optional assessments — reassessments, retakes, opt-in sittings, extra-credit
sessions — are the case where these come apart. For a normal exam they do not:
everyone sits it, it is on the syllabus, and announcing it and attending it are
the same fact. That is why the same code can safely treat a scheduled exam as an
item the moment it is scraped, and must not do the same for a sitting.

---

## The rule

**Record the opportunity. Do not create the commitment.**

An announced sitting goes into `data/study-plan.json` `sittings[]` with its date,
label, room and targets — and stops there. It becomes an item, a calendar event
and a planner input **only** when attendance resolves to yes.

Attendance is deliberately **tri-state**, exactly like `submitted` in
`docs/design-notes/data-truth.md`, and for exactly the same reason: the honest
answer is usually "I do not know", and a system that cannot express that will
guess.

| `kind` | `attending` | Resolves to |
|---|---|---|
| `exam` | absent | **attending** — everyone sits the scheduled exams |
| `exam` | `true` / `false` | as stated |
| `reassessment` | absent | **unknown** — never assume a signup |
| `reassessment` | `true` | attending (signup evidence exists) |
| `reassessment` | `false` | not attending |

`src/focus-engine.mjs` implements this same table. **The two must not drift** — if
the runbook and the planner disagree about whether a sitting is real, the page and
the digest will say different things about the same evening.

---

## What each state does

**attending = yes.** A real deliverable. It may become an item, a calendar event,
the plan's `nextSitting`, and it drives the focus strip as the assessment it is.

**attending = no.** It contributes **nothing**. Keep the entry in `sittings[]` as
history with a short `note` saying why — *never delete history* — but: no item,
no calendar event, never `nextSitting`, and zero focus urgency.

**attending = unknown.** This is the interesting one, and the whole design lives
here. It gets:

- **one** gentle mention in the digest: *"the weekly reassessment is Wed 7:30 pm
  in `SCI 105` if you signed up"*
- **one** "only if you signed up" clause in that course's focus block

and nothing else. No item, no calendar event, no `nextSitting`, no urgency boost,
and **it must never dominate a day.**

That is the correct shape for information you have but cannot act on. It is
strictly better than both alternatives: staying silent means the user misses a
sitting they did sign up for, and treating it as real means the failure at the top
of this page.

---

## What counts as evidence

Only **positive evidence** promotes a sitting to `attending: true`:

- a signup confirmation or receipt in that run's mail sweep, naming the course or
  the standard
- an LMS signup or registration record for the sitting
- the user said so — in this session, or in an earlier one recorded in the plan

**An announcement from the instructor is NOT evidence.** It announces the
opportunity, not the user's decision. Neither is the presence of a signup link in
a content module: a link is a door, not a decision.

`attending: false` is set when the user says they did not sign up, or when the
signup window closed with no evidence AND the user has previously confirmed
non-attendance for that sitting. Otherwise it stays **absent**, and the
gentle-mention rule handles it.

When a sitting flips to `false`, the matching item is removed and the calendar
sink deletes its event on the next run by itself — because sinks delete events
for items that vanished. **Do not touch the calendar by hand.**

**Once a sitting date has passed, leave the entry alone forever.** It is the
record of which opportunities were used, which matters because each standard
allows a limited number of attempts and usually at most one per week. A deleted
sitting is a lost constraint.

---

## The parser is deliberately timid

The week note carries the announcement sentence in a fixed shape so the planner
can read it back:

```
First reassessment Wed Sep 2, 7:30 pm, SCI 105 (C1 only - ...)
```

It wants, in order: the word "reassessment", a month-and-day, an `H:MM am/pm`
time, the room as `LETTERS NUMBER`, and the standard list in parentheses followed
by "only".

**Anything it cannot read confidently is ignored rather than guessed**, and a date
more than two weeks after the week start is rejected outright.

That is the right trade. A missed sitting costs one line of digest; an invented
one costs three days. When a parser's failure modes are that lopsided, it should
be timid.

**Never invent a sitting that was not announced.**

---

## The flag beats the prose

The week `note` records **what the instructor announced.** The `attending` flag
records **what the user did about it.** When they disagree, the flag wins —
because the note is a copy of somebody else's sentence and the flag is a fact
about this user.

---

## The general form

This generalises past sittings, and it is worth stating on its own because it
comes up every time a new source is added:

> **Announcements create opportunities, not commitments. Never infer that the
> user signed up for something optional.**

Optional review sessions, office hours, extra-credit talks, opt-in labs,
tutoring, a study group posted to a discussion board — all the same shape. They
are real, they have dates, and putting them on someone's calendar because they
were mentioned is how a calendar becomes noise.

**When in doubt, mention it once and move on.**
