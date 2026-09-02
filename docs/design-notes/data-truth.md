# Design note: `submitted` is tri-state, and `false` is a claim

*This rule exists because of an incident. It is the most load-bearing rule in the
codebase and the easiest one to break by accident.*

---

## What happened

One morning the agenda told its user they had not done a homework assignment and
two quizzes. All three were finished. Two of them were already **graded**.

The scrape had been stamping `submitted: false` on every quiz and every dropbox
row, in every course. Not because any source said the work was missing — because
the code read fields the LMS server does not send, got `undefined`, and coerced
that to `false`.

So the agenda opened the day by accusing its user of failing to do work they had
done, complete with an urgent push notification. They then spent twenty minutes
checking each item against the gradebook to prove the software wrong.

## Why this is the worst possible failure

An agenda's entire value is that you can stop holding your semester in your head.
The moment it tells you something false about what you have done, you have to
verify everything it says — and an agenda you have to verify is worse than no
agenda, because it costs you time *and* you still do not trust it.

The costs are wildly asymmetric:

| Failure | What it costs |
|---|---|
| Saying "past due — check whether it's still open" about work that is actually done | Two seconds of mild annoyance |
| Saying "you have not submitted this" about work that is done | The user stops believing the tool |

There is no symmetry to trade off here. You take the first one every time.

---

## The rule

Every item carries `submitted` with **three** possible values, and they are three
different things:

| Value | Means | Comes from |
|---|---|---|
| `true` | **Proof it is done.** | A gradebook entry whose title matches and whose earned points are above zero, or a real attempt or submission object, or a mark the user made themselves |
| `false` | **A source explicitly said it is not done.** | A status column that literally reads "No Submission". Rare, and always traceable to a specific string a specific service returned |
| `null` | **Nobody knows.** | Everything else |

**`null` is the default and the most common value, and that is correct.**

### The two sentences that matter

> **If you do not know, emit `null`.**
>
> **`false` is a claim. Make it only when a source made it.**

---

## Why `null` is so common

Learning platforms are not built to answer "has this student submitted this?"
from a student session. Several will happily report `attemptsUsed: 0` and
`bestScore: null` on their student-facing quiz endpoint for a quiz that is
already finished and graded — the fields exist, they are populated for
instructors, and they are empty for you.

So "the field is empty" and "the work is not done" look identical from the
outside, and only one of them is a fact.

---

## What this means for a connector author

You are writing `collect()`. You have a status column, or an attempts count, or
nothing at all. The temptation is to write:

```js
submitted: Boolean(row.submittedAt)      // WRONG
```

That maps every unknown to `false` and reintroduces the incident. Write:

```js
// The status column is the only thing that ever asserts a negative. An absent
// or unrecognised value is UNKNOWN, and unknown is null.
let submitted = null;
if (/^submitted$/i.test(row.status)) submitted = true;
else if (/^no submission$/i.test(row.status)) submitted = false;
```

Three rules that follow from this:

1. **Never infer `false` from a due date having passed.** A deadline passing is
   information about the clock, not about the user.
2. **Never infer `false` from an absence.** No row, no field, no response,
   service down — all of those are `null`.
3. **A connector that emits `false` on absence will make the agenda accuse the
   user of not doing work they have done.** That is the failure. Nothing else in
   the repo can protect against it, because by then it is data.

---

## What this means for an agent

- **Never write `submitted` into `data/latest.json` by hand.** It is derived, and
  the derivation is tested.
- **If the user says they finished something and the data disagrees**, check the
  gradebook for that course before changing anything. If there is no grade yet,
  *say so* rather than flipping the flag.
- **If you see a snapshot where nearly everything is `false`, the scrape is
  broken.** Do not send notifications off it, and do not "fix" it by hand — the
  bug is upstream and hand-fixing hides it.
- **Only positive evidence changes the flag, and only in one direction.** A
  scheduled run may set an item done. **Nothing a scheduled run observes may
  un-do one.** Re-opening a finished item pushes a false alarm about work the
  user already did — the same failure, arriving from the other side.

Only the user may revoke a mark, and only their own, and doing so writes a
**tombstone** rather than deleting anything. Pipeline-origin completions are
untouchable: the page and the CLI both refuse to clear them.

---

## The wording rules that fall out of this

Because most items are `null`, almost every sentence the agenda writes about
unfinished work is a sentence about something it does not actually know.

| Never say | Say instead |
|---|---|
| "You have not submitted Quiz 3" | "Quiz 3 closes in 14h" |
| "You missed Homework 2" | "Homework 2 is past due — check whether it's still open" |
| "3 assignments outstanding" | "3 assignments with nothing marked done" |

**Only say "not submitted" when the item is literally `false`.**

An item is named in the behind check because *nothing says it is done*, never
because *something says it is not*. Those summary strings are written that way
deliberately — use them as they come, and do not rewrite them into accusations.

---

## Related

- `docs/EXTENDING.md` — the emission shapes, with this rule in bold
- `docs/PROTOCOL.md` — the completion ledger, its three states, and tombstones
- `CONTRIBUTING.md` — "what this project will not take"
