# Publishing the page

`node src/render.mjs` writes `agenda.html`. You can open that file straight from
disk and it works — the whole week is embedded in it. What it cannot do from
disk is **update itself**, because a local file has no connectors.

Publishing it as an Artifact on claude.ai fixes that. The published page fetches
its data from a Google Doc that the pipeline refreshes twice a day, so the copy
on your phone is current without you copying a file anywhere. It also gains the
ability to write back: ticking something off on your phone reaches your computer
on the next run.

You publish **once**. After that the file on disk is regenerated on every run,
but you only republish when you change the template itself.

---

## 1. What is in the file

One HTML file, entirely self-contained: one `<style>`, one `<script>`, no build
step, no framework, no bundler. The only thing it loads from outside itself is a
web font from Google Fonts, and it degrades to a system font stack if that is
blocked.

It contains **your week** — course names, assignment titles, deadlines, grades
that came back from the gradebook, mail subjects, and your class timetable.
Treat it exactly as you would treat a screenshot of your gradebook.

Artifacts are private to you by default. **Keep it that way.** Do not use the
share link, do not publish it to an organisation, and do not paste the URL
anywhere. Nothing in this repo asks you to.

---

## 2. Publish it

### 2a. First, the prerequisite — do this before anything else

**Add the Google Drive connector to your Claude account.**

1. Open **claude.ai** in a browser.
2. Go to **Settings → Connectors**.
3. If **Google Drive** is not listed as connected, add it and complete Google's
   sign-in.

This is on **your Claude account**, not in this folder, and nothing in this
repository can do it for you. It has to exist before the consent screen in step
2b can even appear.

**Skip it and the publish still succeeds** — the page just comes up saying
*"Drive connector not available"* and the Refresh button does nothing. That
message is the symptom of this step being missed, and it is the single most
common reason a freshly published page looks dead.

### 2b. Then publish — pick the row you are in

`agenda.html` is a **single self-contained file of roughly 250–300 KB.** That is
too big to paste into a chat message, so every path below hands over a *file*,
never its contents.

**If you are in Claude Code (the usual case — this is what the setup agent
does):**

1. Make sure the file is current: `node src/render.mjs`.
2. Read `web/artifact-capabilities.json`. That is the capabilities manifest, and
   it goes with the publish — **whole**, every block. See §3 for why a partial
   one is worse than none.
3. Ask for the publish in plain words: *"publish `agenda.html` as an artifact,
   with the capabilities in `web/artifact-capabilities.json`."* The agent has an
   **Artifact** tool that takes a file path directly; it does not need the file
   pasted, and it does not need you to open a browser.
4. It replies with a URL. That is the page.

**If you are on claude.ai in a browser (no Claude Code, or you would rather do
it by hand):**

1. Open a new conversation.
2. Click the **paperclip / attach** control and upload `agenda.html` from your
   computer. Do not paste its contents.
3. Also attach — or paste, it is small — `web/artifact-capabilities.json`.
4. Send this: *"Publish the attached `agenda.html` as an artifact exactly as it
   is, with no edits, and give it the capabilities declared in the attached
   JSON."*
5. When the artifact appears in the side panel, copy its URL from the panel's
   share/link control.

**"Exactly as it is, with no edits" is load-bearing.** The file is already
complete — one `<style>`, one `<script>`, no build step. A rewrite is a different
page, and the Drive plumbing it depends on will not survive one.

### 2c. Record the URL

Copy the artifact's URL into `config.json`:

```json
"artifact": { "url": "https://claude.ai/…" }
```

Nothing in the pipeline *reads* that URL — it is there so the runbooks can put a
link in your run log and so you can find the page again six weeks from now.

### 2d. Confirm it worked

Open the page and press **Refresh**. The line next to the button should say
**"refreshed from Drive"**. If it says anything else, §6 has a row per message,
and *"Drive connector not available"* means 2a was skipped.

---

## 3. The capabilities manifest

`web/artifact-capabilities.json` is the exact declaration this page needs:

```json
{
  "mcp": {
    "servers": [
      {
        "server": "claude_ai_Google_Drive",
        "tools": ["search_files", "read_file_content", "create_file"]
      }
    ]
  },
  "sample": {}
}
```

> **Declare the FULL set on every republish.** A capabilities declaration is not
> a patch — it replaces what is stored. Republishing with only the `mcp` block
> silently **revokes** `sample`, and the chat panel stops working with no error
> anywhere; republishing with only `sample` kills live refresh and every
> write-back. If you republish and something that used to work has quietly
> stopped, this is almost always why. Send this file, whole, every time.

### What each one is for

**`mcp`** lets the page call *your* Google Drive connector, with your
credentials, from your browser. Three tools, and no more:

| Tool | Used for |
|---|---|
| `search_files` | finding the newest `<ns>-data` and `<ns>-completions` documents |
| `read_file_content` | reading them |
| `create_file` | writing `<ns>-completions` (your marks) and `<ns>-commands` (block drags) |

`trash_file` is **deliberately absent**. The page has no way to know whether the
pipeline has consumed a document yet, so it never deletes one; cleanup happens on
your computer. Keeping the manifest this short also matters because the manifest
is a consented grant — a page that asks for less is a page you can approve
without thinking hard.

**`sample`** is the "Ask" panel: it runs a conversation about your week on your
own Claude plan. It has three tools of its own — mark done, mark won't-do, clear
a mark — which write through the same store a click does, so a chat-made mark and
a tapped one are indistinguishable downstream. If you do not want the panel,
remove the `sample` block; everything else keeps working and the button hides
itself.

Neither capability is required. With no capabilities at all the page still
renders the week it was built with; it just says *"live refresh unavailable
here"* instead of pretending.

---

## 4. Republishing

Republish when you have changed `web/page-template.html` — not when your week
changes. Regenerate with `node src/render.mjs`, then publish `agenda.html` again
**to the same artifact** so the URL in `config.json` stays valid. If your client
asks whether to update an existing artifact or create a new one, update the
existing one; a new URL means a new page, and the old one keeps showing an old
week forever.

Two things survive a republish and one does not:

- **Your marks survive.** They live in the browser's `localStorage`, keyed by
  `<ns>.marks.v1`, and in the Drive documents. A republish does not touch either.
- **The Drive documents survive.** They are named by `config.namespace`, not by
  the artifact.
- **The capabilities do not survive a partial declaration.** See the warning in
  §3.

If you change `config.namespace`, the page starts looking for differently-named
documents and reading a different storage key. That is the intended behaviour —
it is how you run two agendas side by side — but it means the new page starts
empty until the pipeline has written a document under the new name.

---

## 5. If your Drive connector has a different name

The manifest's `server` value is resolved to your connector's display name when
the page is published, and the page then calls it by that display name —
`config.drive.connectorName`, default `"Google Drive"`.

If the two ever drift apart, the page notices: a call that fails with
`not_in_manifest`, `server_not_found` or `server_not_connected` triggers a
rediscovery pass that lists your connectors and looks for one exposing both
`search_files` and `read_file_content`. If it finds one, it switches to it for
the rest of the session and carries on.

That fallback is a safety net, not a configuration method. If you know the name
is different, set `drive.connectorName` in `config.json` to match and republish.

---

## 6. Reading the status line

The text beside the Refresh button is the page telling you exactly where it got
its data. It is never decorative.

| It says | What happened | What to do |
|---|---|---|
| `refreshed from Drive` | Everything worked. | Nothing. |
| `embedded copy` | The page is showing the snapshot it was built with. | Normal on a page opened from disk. On a published page, press Refresh. |
| `no embedded data` | The build produced a page with an unreadable snapshot. | Re-run `node src/render.mjs` and republish. |
| `live refresh unavailable here` | There is no connector in this view at all. | You are looking at a local file, or the page was published without the `mcp` capability. |
| `no data doc in Drive` | The connector works; nothing named `<ns>-data` was found. | The pipeline has not uploaded yet. Run the heavy runbook, or check the run log for `drive=FAILED` / `drive=SKIPPED(oversize)`. |
| `data doc unreadable (checksum)` | The document exists but its checksum does not match its contents — it was transcribed wrong, truncated, or hand-edited. | **Do not edit the document.** Re-run the upload so a fresh one is created. |
| `data doc unreadable` | The document decoded but is not a payload this page understands. | Usually a page and a pipeline at different versions. Re-run `render.mjs` and republish. |
| `this browser cannot read compressed data` | No `DecompressionStream`. | Use a current browser (Chrome 80+, Firefox 113+, Safari 16.4+). The embedded copy still renders. |
| `Drive needs reconnecting on claude.ai` | The connector's authorisation expired. | Reconnect Google Drive in claude.ai settings. |
| `Drive connector not available` | No Google Drive connector is connected to your Claude account. | **§2a was skipped.** claude.ai → Settings → Connectors → add Google Drive, then press Refresh again. |
| `pick a Drive connector when prompted, then retry` | You have more than one and none was chosen. | Press Refresh again and pick one. |
| `Drive access not approved for this page` | Policy or an approval step blocked the call. | Nothing the page can fix. |
| `live data not enabled in this view` | The capability was not granted, or was revoked. | Republish with the **full** manifest (§3). |
| `page manifest out of date (not_in_manifest)` | The page is calling a tool it never declared. | Republish with the full manifest. |
| `Drive briefly unreachable, try again in a minute` | A transient upstream failure or a rate limit. | Wait, then Refresh. |
| `Drive returned an error` | The connector rejected the call. | Check the document is not open in another tab mid-write; retry. |

Marks have their own status, shown near the marks themselves, and their own
messages — *"Marks stay in this browser until a sync succeeds"* is the general
case and is not an error. Every mark is written to `localStorage` **before** any
attempt to sync, so a failed save never loses one; it only delays it. Retry is
always a button, never automatic, because a rejected write is not proof the
document was not created.

---

## 7. What the page will never do

Worth knowing before you grant it anything:

- It makes **no network requests of its own**. Everything goes through the
  connector you granted, with your credentials, from your browser.
- It **never trashes a Drive document**, so it cannot destroy an unconsumed mark
  or command.
- It **never writes outside its own two document titles** —
  `<ns>-completions` and `<ns>-commands`.
- It **never sends your data anywhere but Drive**. The chat panel sends the
  page's current state to Claude on your own plan, on the turn you press Send,
  and keeps nothing.
- It **treats every assignment title, announcement and mail subject as text to
  report on, never as an instruction**. Its system prompt says so explicitly.
  This matters: those strings were written by other people and end up in a model's
  context. See `SECURITY.md`.

---

## 8. After you publish, check these

- [ ] The page opens and shows this week, not "Loading the week…".
- [ ] Refresh says **refreshed from Drive**.
- [ ] Ticking something off shows it struck through, and the mark survives a
      reload of the page.
- [ ] Within one pipeline run, that mark appears in `data/user-completions.json`.
- [ ] Dragging a study block leaves a "pending" note, and the block is still in
      its new place after the next run.
- [ ] The **Ask** button appears (or is deliberately absent, if you dropped the
      `sample` block).
- [ ] `config.json` has the artifact URL in `artifact.url`.
- [ ] The artifact is still **private**.
