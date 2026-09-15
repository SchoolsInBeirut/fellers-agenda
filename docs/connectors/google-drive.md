# Google Drive — the transport

Drive is not a data *source*. It is the **wire** between your computer and the
page in your pocket, in both directions.

```jsonc
"drive": {
  "enabled": true,
  "connectorName": "Google Drive",
  "rcloneRemote": "agenda",
  "rcloneExe": "[NOT SET]",
  "maxEmitChars": 12000,
  "maxMirrorChars": 20000,
  "mirror": true
}
```

**Two halves, authorised separately, and you need both.**

| Half | Who does it | What it needs |
|---|---|---|
| **Writing** — the pipeline putting the week into a document | `src/drive-rclone.mjs`, which runs the `rclone` command-line program | `rclone` installed, and one browser consent click to create the remote |
| **Reading** — the published page fetching that document | your browser, through **your own Claude account's Drive connector** | the Google Drive connector added in claude.ai → Settings → Connectors |

Neither substitutes for the other. Skip the first and no run can publish; skip
the second and the page's refresh control says *"Drive connector not available"*.
Nothing declared in `.mcp.json` is involved, and no Google token is stored in
this repository — rclone keeps its own, in its own config file.

---

## Why a Google Doc

The published page is a static Artifact. It cannot read a file on your laptop,
and there is no server in this design to ask.

So it reads a Google Doc. A run writes the week's payload into one; the page
fetches it on load and on every refresh. That is what makes the page **live** —
you publish it once and it shows you today's week for the rest of the semester
without ever being republished.

The same channel runs backwards. When you tick something off or drag a block on
your phone, the page writes a small document, and the next run picks it up.

---

## The four documents

`<ns>` is `config.namespace`, default `agenda`. Every title is **exact**.

| Title | Written by | Read by | Envelope |
|---|---|---|---|
| `<ns>-data` | the daily run, over rclone | **the page** | `AGD2.` (gzip + CRC-32) |
| `<ns>-mirror` | the daily run, over rclone | nothing — it is insurance | `AGM1.` / `AGM2.` |
| `<ns>-completions` | **the page**, when you tick something | `completion.mjs --ingest` | `AGC1.` (plain) |
| `<ns>-commands` | **the page**, when you drag or send a command | `command-ingest.mjs --apply` | `AGQ1.` (plain) |

**Four titles, three owners, no crossover.** Destroying a completions document
while rotating the data document destroys a mark you made, and nobody will ever
know it happened. That is why the rule is stated absolutely everywhere it comes
up.

If you run two agendas from one Google account, give them **different
namespaces** or they will fight over the same four documents.

A fifth name appears once you have run for a day: a folder called
`<ns>-consumed`, which is where used-up completions and command documents go.

---

## Every write updates in place, and is verified by reading it back

`src/drive-rclone.mjs` replaces the **body of the same document**, keeping its
id. The page finds it exactly as before — search by title, take the newest
`modifiedTime`, read the body — so the page template did not change in 2.0.0.

Each publish is:

1. **Upload.** `rclone copyto` writes the local file over the existing document.
2. **Export it again** and compare. The publish is `ok` only when the exported
   envelope matches the local one **and** unpacks cleanly. The token says so:
   `drive=ok(7KB;rclone;verified)`.
3. **Self-heal on a bad compare.** The payload is re-uploaded from
   `data/payload.last-good.txt` — the last copy that verified — and the run logs
   `drive=FAILED(verify;restored-last-good)`. The page keeps reading a whole
   week rather than half of one. **The token only claims a restore that
   happened:** if that re-upload fails too, which usually means the remote went
   away mid-run, the token is `drive=FAILED(verify;restore-failed)` and the bad
   document is still live. The mirror has no last-good copy to fall back on, so a
   failed mirror verify simply keeps the previous document:
   `mirror=FAILED(verify;kept-previous)`.

**Nothing is trashed, ever.** A completions or commands document the pipeline has
consumed is **moved** into `<ns>-consumed`, named with its own id, and deleted
only after **seven days**. If a run consumes a mark it should not have, the
evidence is still there for a week.

**The page only ever creates. It never deletes or moves anything.** Cleanup is a
pipeline job, because only the pipeline knows what it has actually consumed.

### If you are upgrading from 1.x

The old transport could not replace a document body, so every run created a new
document and trashed the older ones — and a run that died between those two steps
left duplicates behind.

**The first 2.0.0 publish tidies that up.** Before uploading, it looks for every
document with that title; if there is more than one, everything except the newest
is moved into `<ns>-consumed` and the token gains `;deduped=N`. Nothing is
deleted, so if the tidy-up picked wrong the documents are still there.

---

## Why the payload is still compressed

In 1.x a language model had to **type** the payload into a document — there was no
upload API on the path it could reach — so every character cost tokens twice, once
to read the file and once to emit it. An uncompressed payload was about **65,000
base64 characters**: roughly 185k tokens each way, which is past a context window.
Runs failed, repeatedly.

`rclone` moves the bytes now and the model is not in that path at all, so that
particular argument is dead. The compression stayed for three reasons that have
nothing to do with a model:

- the page fetches and parses this document on every refresh, and 6,700
  characters is faster than 65,000
- the CRC-32 is a real integrity check on a document a human can open in Google
  Docs and accidentally type into
- the page template did not change in 2.0.0, and it reads `AGD2.`

Gzip before base64, on JSON with highly repeated keys, compresses about **six
times**. With the slim tiers on top, a run's upload is around **6,700
characters.**

### The checksum is not decoration

`AGD2.` carries a CRC-32 computed over the **gzip bytes, before base64**.

The realistic corruption mode is a truncated or altered document — an upload cut
short, or somebody opening the doc and typing in it. And **a truncated gzip
stream can still start decompressing**, so without a checksum a torn payload
produces *plausible partial data* rather than an error. Half a week's agenda,
presented as a whole one, is a worse outcome than no agenda.

It is also what makes the read-back verification meaningful: the publish step
does not merely compare two strings, it unpacks the exported envelope, so a
document that survives the compare is a document the page can actually read.

Readers strip all whitespace before decoding, because a Google Doc inserts soft
line breaks and those are not corruption.

`AGC1.` and `AGQ1.` stay plain and uncompressed: the page writes them directly
through a tool call, and they are small.

Full spec: `docs/PROTOCOL.md`.

### The slim tiers

If the payload does not fit `drive.maxEmitChars`, `render.mjs` drops things in a
fixed order until it does, then prints which tier it used:

```
upload: 6,712 chars (budget 12,000, tier 1)
```

| Tier | Drops | Costs you |
|---|---|---|
| 0 | nothing | — |
| 1 | descriptions on items outside a −14 / +21 day window | far-off items lose their blurbs |
| 2 | announcements older than 7 days; mail capped 12 → 8 | less context |
| 3 | the done-history window 14 d → 7 d; board cap 10 → 5 | shorter history |

Still over at tier 3? It **does not truncate.** It writes
`data/payload.oversize.txt`, prints a loud warning, and the run logs
`drive=SKIPPED(oversize)`. The copy embedded in `agenda.html` is always complete,
so the page still works from its own data.

**Raising `maxEmitChars` is cheaper than it used to be, and still not the first
fix.** Those characters no longer pass through a model, so they no longer cost
tokens — but a bigger document is a slower page refresh. Reduce
`scrapeWindowDays`, or accept tier 1: it only loses blurbs on things due in three
weeks.

---

## The state mirror

`<ns>-mirror` exists for one scenario: **your disk dies at 3am.**

The payload document is a *rendering*, and a rendering cannot be turned back into
the files that produced it. Lose your disk and you lose the study log, the
overrides, the completions, the block edits and the plan — months of accumulated
opinion that **no scrape can rebuild**, because your LMS never knew any of it.

So the daily run packs the state and pushes a copy, when `drive.mirror` is on.

**`--pack` always writes a local rotating backup to `backups/mirror-<ISO>.txt`
first** — newest 14 kept, git-ignored — *before* Drive is even considered. That
ordering is deliberate: insurance that depends on an upload succeeding is not
insurance.

Reading one back:

```
node src/drive-bundle.mjs --restore <file>
```

unpacks it into a dated folder and **touches nothing live.** Overwriting live
files needs `--force`, which still writes a `.pre-restore.bak` beside every file
it replaces.

**A scheduled run never restores.** A restore is a decision about which of two
versions of your history is real, and that is your call, made with the unpacked
copy in front of you.

---

## Setup

The setup agent walks this. Three steps, and you need all three: the first two
are the **write** half, the third is the **read** half.

### 1. Install `rclone`

One line, and it is the same program a lot of people already have:

| | |
|---|---|
| Windows | `winget install Rclone.Rclone` |
| macOS | `brew install rclone` |
| Linux | `curl https://rclone.org/install.sh \| sudo bash` |

`npm run setup` checks for it and prints the right line for your machine. It does
not install it for you, for the same reason it does not install Node.

### 2. One consent click, once

```
rclone config create agenda drive scope=drive
```

> **A browser opens on a Google consent screen** asking for access to your Drive.
> Approve it. The window closes itself and `rclone` prints the finished remote.

That is **Google's** screen, not this repository's. Say so out loud to anyone you
are helping through it, because an unannounced OAuth screen from a stranger's
repo is exactly where people quit — and they are right to.

`agenda` is the remote's name and it must match `drive.rcloneRemote` in
`config.json`. The token lands in rclone's own config file
(`%APPDATA%\rclone\rclone.conf` on Windows, `~/.config/rclone/rclone.conf`
elsewhere) — **not** in this repository, which is why nothing here is git-ignored
on its behalf. It is worth locking that file down to your own user account.

Then check it:

```
node src/drive-rclone.mjs status
```

`rclone=ok` and you are done with this half. `rclone=missing` means step 1 did
not take; `rclone=auth-failed(...)` means step 2 did not.

**`npm run setup` will never run the consent command for you**, and neither will
a scheduled run: something has to click Allow in a browser, and a script at 10:30
in the morning cannot.

### 3. Add the connector to your Claude account

**claude.ai → Settings → Connectors → add Google Drive**, and complete Google's
sign-in there if it asks.

This is the **read** half — it is how the published page fetches the document,
and how your phone reads the brief (`docs/PHONE.md`). It lives on **your Claude
account**, not in this folder. Nothing in this repository can do it for you and
no configuration key substitutes for it. Skip it and runs publish perfectly
happily, right up to the point where the page says *"Drive connector not
available"* and the Refresh button does nothing.

**What each half can actually touch.** rclone holds a Drive token scoped to your
whole Drive — that is the only scope Google offers for this — but
`src/drive-rclone.mjs` only ever names the four titles above and the
`<ns>-consumed` folder, and it never deletes anything younger than seven days.
The page creates and reads documents whose titles start with your namespace, and
deletes nothing at all.

### A caveat with a date on it

rclone ships with a **shared Google client id that is being retired during 2026**,
and it prints a notice about that on every call. (The repository filters that
notice out of its error reporting, so a routine notice never becomes a fake
failure.)

When the day comes, publishes start failing with **authentication** errors. The
fix is to make your own client id — the procedure is on
[rclone.org/drive](https://rclone.org/drive/#making-your-own-client-id) — and then,
once:

```
rclone config update agenda client_id=<yours> client_secret=<yours>
node src/drive-rclone.mjs status
```

One more Allow click and it is done. Nothing in this repository changes.

---

## Turning it off — including "I don't have a Google account"

Set `drive.enabled: false`. Everything still works locally — `agenda.html`
renders with its complete embedded payload every run, and no run will look for
`rclone`.

**No Google account is a supported configuration, not a failure.** Setup asks
before it announces anything, and this is the branch it takes. You keep the
scrape, the study model, the planner, the page and every connector; you open
`agenda.html` from disk like any other file.

**What you lose:** the page stops being live. It shows whatever was baked in when
it was last rendered, and the phone write-back buses stop, so ticking things off
on your phone no longer reaches the pipeline.

For a desktop-only workflow where you open `agenda.html` locally, that is a
perfectly reasonable trade.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "no data doc in Drive" | No run has uploaded successfully yet, or `namespace` does not match what the published page was built with |
| "data doc unreadable (checksum)" | Re-run the publish. **Do not hand-edit the document** |
| The page shows stale data and refresh does nothing | The Drive **connector** is not authorised in the browser session showing the page. Re-approve it. This is the read half and it is separate from rclone |
| `drive=FAILED(rclone;missing)` | `rclone` is not installed or not findable. Install it (setup step 1), or set `drive.rcloneExe` to its full path. (`rclone=missing` without the `drive=` prefix is the same thing said by `drive-rclone.mjs status`) |
| `drive=FAILED(rclone;<errno>)` | rclone ran and failed for some other reason; the errno is rclone's. `node src/drive-rclone.mjs status` says whether the remote is reachable at all - if it answers `rclone=auth-failed(...)`, re-run `rclone config create <remote> drive scope=drive`. If this started happening suddenly on a setup that worked for months, read "A caveat with a date on it" above |
| `drive=FAILED(verify;restored-last-good)` | The upload did not read back as what was sent, and the previous good payload was put back. The page is showing yesterday. Look at `data/runlog-stdout.txt` for that run; if it repeats, file an issue |
| `drive=FAILED(verify;no-last-good)` | The same, on a machine that has never had a verified publish. Run again |
| `drive=FAILED(verify;restore-failed)` | **The one to act on.** The read-back did not match *and* putting the last good payload back failed too — usually because the remote went away mid-run. **The bad document is still live**, so the page may be showing a torn week. Run `node src/drive-rclone.mjs status`, fix whatever it names, and publish again |
| `drive=SKIPPED(oversize)` | See the slim tiers above |
| The Doc mangles the blob | Readers strip whitespace, so this is normally invisible |
| Duplicate `<ns>-data` documents from a 1.x install | The next publish tidies them into `<ns>-consumed` and logs `;deduped=N`. Nothing is deleted |
| A mark you made vanished | Look in `<ns>-consumed` — consumed documents are kept there for seven days, so it is probably recoverable. Then file an issue |
