# Canvas — the token-based LMS connector

**Ships in the box, disabled by default.** A token you generate yourself, no
server to install, no browser chain to drive. On most setups it is the easier of
the two LMS connectors, and it is the only one that works in a cloud
environment.

```jsonc
"connectors": {
  "lms": {
    "brightspace": { "enabled": false, ... },
    "canvas": {
      "enabled": true,
      "baseUrl": "https://canvas.example.edu",
      "token": "[NOT SET]",
      "courseFilter": []
    }
  }
}
```

The connector is `src/connectors/lms-canvas.mjs`. It is registered in
`src/connectors/index.mjs` like every other source — nothing to write, nothing
to add.

---

## Turning it on

Three steps, and the setup agent does all of them with you if you say `hey`.

**1. Get an API token.** In Canvas: **Account → Settings → Approved
Integrations → + New Access Token**. Give it a name you will recognise and an
expiry you will remember.

Canvas tokens carry **your full permissions**. Treat it exactly like your
password.

**2. Put it in `config.json`.**

```jsonc
"canvas": {
  "enabled": true,
  "baseUrl": "https://canvas.example.edu",
  "token": "13~aBcD...",
  "courseFilter": []
}
```

| Key | What it does |
|---|---|
| `enabled` | Turns the connector on |
| `baseUrl` | Your school's Canvas address. Defaults to `institution.lmsHost` if you leave it `[NOT SET]` |
| `token` | The access token from step 1 |
| `courseFilter` | Limits the sweep to these course codes or ids. **Empty means every active enrolment**, which is what most people want |

**`config.json` is the only place the token goes.** That file is git-ignored, so
it is never committed. Do **not** put it in `.mcp.json` or `.env.example`, both
of which are committed, and do not paste it into an issue.

**3. Verify end to end.**

```
node scripts/validate-setup.mjs
node src/scrape.mjs
node src/render.mjs
```

The preflight checks that the LMS you enabled actually has what it needs, so a
missing `token` or `baseUrl` is caught there rather than at the scrape. In
`data/latest.json`, items from this connector carry `sources: ["canvas"]`.

Then look at the page and count. If a course has three assignments and Canvas has
thirty, you have hit the pagination trap described below — file it.

---

## If your school has disabled personal access tokens

Some institutions do. Three symptoms:

- **There is no "New Access Token" button** on the Approved Integrations page.
- **`401`** — Canvas rejected the token. It was revoked, it expired, or it was
  made on a different Canvas site. Make a new one and paste it in; the
  connector's own error says exactly this, and names the page.
- **`403`** — Canvas *recognised* the token and refused the request anyway. That
  is the institutional one: API access is disabled for students, or for that
  scope. Ask your help desk whether student API tokens are enabled. **If they are
  not, no retry and no new token fixes it.**

The connector distinguishes the two rather than reporting a generic auth
failure, because they have opposite fixes: one is a two-minute regeneration, the
other is a conversation with your school or a different connector. A `429` is
neither — that is rate limiting, and the next run picks up where this one
stopped.

What is left, in order: the Brightspace connector if your school also runs
Brightspace (`docs/connectors/brightspace.md`), or
`docs/connectors/not-supported.md`, which is honest about the platforms with no
viable route at all. Demo mode keeps working either way.

---

## Why a token is a better interface than a login

| | Brightspace | Canvas |
|---|---|---|
| Authentication | A browser login chain that varies by institution and changes without notice | **A token you generate yourself** |
| Setup time | Minutes, sometimes an hour when the login chain has moved | About two minutes |
| Breaks when | Your school changes its identity provider | Your token expires, or your school disables tokens |
| Diagnosing a break | Probe the live login chain and update selectors | Read the HTTP status code |
| Works in a cloud environment | **No** — a cloud task cannot reach a local stdio server | **Yes** |

Nothing in the token path can hang forever on a page that renders perfectly,
which is the specific failure mode `docs/connectors/brightspace.md` spends half
a page on.

---

## What it reads

| Need | Canvas endpoint |
|---|---|
| Deliverables with due dates | `/courses/:id/assignments` |
| Content tree | `/courses/:id/modules`, `/courses/:id/pages` |
| Announcements | `/announcements?context_codes[]=course_:id` |
| **Positive submission evidence** | `/courses/:id/students/submissions`, and the gradebook |

Read-only, on your own account, with your own token. It never posts, submits or
modifies anything.

### The tri-state rule, with a Canvas-specific trap

Canvas's `submission` object has a `workflow_state` that is genuinely
informative — `submitted`, `graded`, `unsubmitted`, `pending_review`. That is
better than most platforms give you.

But **`unsubmitted` is Canvas's default state for a submission record that
exists**, and a record can exist for an assignment you have never opened. So:

```js
// WRONG - "unsubmitted" is the default, not an assertion
submitted: s.workflow_state !== "unsubmitted"   // maps unknown to true. Even worse.

// ALSO WRONG - treats an absent record as a negative
submitted: Boolean(s?.submitted_at)

// RIGHT
let submitted = null;
if (s?.workflow_state === "graded" || s?.workflow_state === "submitted") submitted = true;
else if (s?.workflow_state === "unsubmitted" && s?.missing === true) submitted = false;
// everything else, including no record at all, stays null
```

`missing: true` is Canvas explicitly saying "this is past due and not handed in".
**That** is a negative assertion. `unsubmitted` on its own is not.

`docs/design-notes/data-truth.md` is the incident that produced this rule. Read
it before changing anything in this connector.

---

## Things Canvas does that will surprise you

| Behaviour | What it means for you |
|---|---|
| **Everything is paginated**, 10 per page by default, and the `Link` header is the only way to know there is more | Reading page one silently loses most of a semester, so the connector follows `rel="next"` to the end. If you ever see a course with far fewer assignments than Canvas shows, that is a bug worth an issue |
| `due_at` is `null` for ungraded and undated assignments | That is a fact, not a gap. It stays out of `items[]`. **Never invent a date** |
| Assignment **overrides** give different due dates per section | Where the applicable override can be identified it is used; where it cannot, the base date is used and the item is marked `approx: true`, which the page renders with a `~` and the planner treats loosely |
| A `quiz` and its shadow `assignment` both appear | Same problem as calendar twins. `merge.mjs` collapses them by item key |
| Course names are long and inconsistent | `courses[].code` in your config is what appears everywhere in the UI. Keep it short |
| Concluded courses still enumerate | Use `courseFilter`, or mark them `"skip": true` in `courses[]` |

---

## Running Brightspace and Canvas together

**Enable either or both.** A transfer semester, or a school running two platforms
through a migration, is a supported configuration and needs no special handling:
`merge.mjs` deduplicates by item key, so a deliverable that appears in both ends
up as one item with `sources: ["brightspace", "canvas"]`.

Give the courses **distinct `code` values** in `config.json`, though. Two courses
called `MATH 210` from two platforms will collide in `difficulty`, `schedule` and
every bucket name, and the resulting plan will be quietly wrong.

---

## Turning it off

Set `enabled: false` — but **at least one LMS connector must be enabled**, or
`scrape.mjs` exits 1 with `scrape: no LMS source is enabled.` and a four-line
fix. The preflight fails on the same condition, for the same reason, so you find
out before the scrape rather than after it.
