# Not supported — and why, honestly

Some platforms have no viable path. This page says which, and says *why*, because
"we haven't got round to it" and "there is nothing to build against" are very
different answers and only one of them is worth your evening.

**If your platform is on this page, you can still stop at demo mode** and come
back if the situation changes. Everything except the LMS connector works
regardless.

---

## Blackboard

**Status: no viable general-purpose server exists.**

Not "there is a rough one". Not "it needs work". There is nothing you can point
this repo at and get a course list.

**Why.** Blackboard's REST API is real and reasonably capable, but access to it
is **provisioned per institution**. An application must be registered in the
Developer Portal, and then an administrator **at your school** has to enable that
specific application key against your school's instance. There is no personal
access token, no student-level self-service, and no way to route around it.

So a general-purpose server is a contradiction in terms: it would need to be
registered and approved separately at every institution that wanted to use it,
by someone who is not you. The projects that exist are single-institution
integrations built by people who *were* that administrator, and they do not
transfer.

**What you can actually do:**

- **Ask.** If your institution's IT or teaching-technology group will register an
  application and give you the key, a Blackboard connector becomes a normal Tier 2
  build. This is not a hopeless ask at a small school; it is a hopeless ask at a
  large one.
- **Check for a secondary system.** A surprising number of institutions run
  Canvas or Brightspace alongside Blackboard for particular departments.
- **Use the page's "add a task" command** and keep the planner, the study model,
  the timetable and the phone write-back. You lose the scrape, which is a real
  loss, but the rest is most of the value.

---

## Google Classroom

**Status: blocked on an administrator, for most students.**

**Why.** The Classroom API exists and works. But a third-party application
reading a student's coursework needs the **Google Workspace administrator of the
school's domain** to add that application to an allow-list. This is
[App Access Control](https://support.google.com/a/answer/7281227), it is on by
default for education domains, and it exists specifically to stop students
authorising arbitrary applications against school data.

Your personal Google account cannot override it. The consent screen will simply
say the app is blocked.

**Also, `faizan45640/google-classroom-mcp-server` is dead.** It ranks well and it
will not help you.

**What you can actually do:**

- **Try it.** Some domains, particularly at smaller schools and universities that
  use Classroom loosely, have the control relaxed. Ten minutes tells you.
- **Ask your administrator** to allow-list the application. This is a normal
  request with a normal form and it is sometimes granted.
- **Let Classroom itself feed your calendar.** Classroom pushes coursework due
  dates into a student's Google Calendar, and calendar access is *not* gated the
  same way the API is. That gets you deadlines-on-your-phone even with no scrape
  at all. **This is a Classroom feature you turn on at Google, not a connector in
  this repo** — nothing here reads or writes a Google Calendar, and the agenda
  will not know about those deadlines.

---

## Moodle

**Status: partial. Depends entirely on your institution.**

`uvx moodle-mcp` (`loyaniu/moodle-mcp`) exists and works against a standard
Moodle Web Services setup — **if your institution has Web Services enabled and
lets students mint a token.** Many do. Many do not, and there is no way to tell
without trying.

Check **Preferences → Security keys** in your Moodle. If you see a token, you are
in business and this is an ordinary Tier 2 build (`docs/EXTENDING.md`). If the
page is empty or absent, Web Services is off and only an administrator can change
that.

Listed here rather than in the tier table because "it depends on your school" is
not something you should discover after an hour of setup.

---

## Anything behind Single Sign-On with no API

The general case, and worth naming because it comes up constantly.

If a system has **no API and no MCP server**, the only remaining approach is
browser automation against a session your institution issues. That is a bad idea
here for four separate reasons, any one of which is sufficient:

1. **It usually violates the acceptable-use policy** you agreed to.
2. **It breaks on every UI change**, silently, and the failure looks like "no
   work is due".
3. **It needs a live credential**, which means a stored credential — the thing
   this repo works hard to avoid everywhere except one clearly-labelled optional
   extra.
4. **It cannot distinguish "nothing to submit" from "the page did not load"**,
   which is the exact failure mode `docs/design-notes/data-truth.md` exists to
   prevent.

The Brightspace connector uses a browser **for login only**, then reads a
documented API through a maintained server. That is a different thing from
scraping the interface, and the difference is the whole reason it is trustworthy
enough to ship enabled.

---

## Dead packages — refuse these by name

They rank highly in search results and none of them work.

| Package | Status |
|---|---|
| `@abhiz123/todoist-mcp-server` | Dead. Use the hosted endpoint at `https://ai.todoist.net/mcp` |
| `apple-mcp` / `@dhravya/apple-mcp` | Dead. On macOS use `npx mcp-server-apple-events` |
| `faizan45640/google-classroom-mcp-server` | Dead, and blocked on the allow-list above regardless |
| `@anthropic-ai/mcp-server-gdrive` | **Does not exist at all.** Google Drive is a built-in connector, not an npm package |

`/add-source` refuses each of these by name and says why.

---

## If your platform is here

You have three real options, in increasing order of effort.

**1. Stop at demo mode.** Genuinely fine. Come back if something changes.

**2. Run it manually.** Everything except the scrape works: the timetable, the
study model, the planner, the page, the phone write-back, the calendar sink, both
watchdogs. Add deliverables through the page's task command. That is a
significantly better week-planner than most people have, and it costs about two
minutes on a Sunday.

**3. Build the connector.** If a path opens — an administrator says yes, a token
appears, someone publishes a server — it is seven steps and `docs/EXTENDING.md`
walks all of them. `/add-source` does most of the typing.

---

## Help us keep this page honest

**This page ages badly, and that is the point of dating it.** Servers get
published, institutions change their configuration, APIs open up.

If you get one of these working, please open a pull request adding it — and if
you spend an evening confirming that something *still* does not work, that is
just as valuable and this page takes it. Recording a dead end saves the next
person the same evening.

`.github/ISSUE_TEMPLATE/connector_request.yml` asks the questions that make a
request actionable, and the most important one is: **can this source tell the
difference between "not submitted" and "I could not tell"?** If it cannot, it
cannot be a safe connector at any effort level.

**Last reviewed: 2026-09-02.**
