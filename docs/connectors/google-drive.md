# Google Drive — the transport

Drive is not a data *source*. It is the **wire** between your computer and the
page in your pocket, in both directions.

```jsonc
"drive": {
  "enabled": true,
  "connectorName": "Google Drive",
  "maxEmitChars": 12000,
  "maxMirrorChars": 20000,
  "mirror": true
}
```

It is reached through **your own Claude account's built-in Drive connector**, not
through anything declared in `.mcp.json` and not through any token stored here.

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
| `<ns>-data` | a run | **the page** | `AGD2.` (gzip + CRC-32) |
| `<ns>-mirror` | a **heavy** run only | nothing — it is insurance | `AGM1.` / `AGM2.` |
| `<ns>-completions` | **the page**, when you tick something | `completion.mjs --ingest` | `AGC1.` (plain) |
| `<ns>-commands` | **the page**, when you drag or send a command | `command-ingest.mjs --apply` | `AGQ1.` (plain) |

**Four titles, three owners, no crossover.** Trashing a completions document
while rotating the data document destroys a mark you made, and nobody will ever
know it happened. That is why the rule is stated absolutely in every runbook.

If you run two agendas from one Google account, give them **different
namespaces** or they will fight over the same four documents.

---

## Every write is create-then-trash, in that order

`update_file` on this connector is **metadata-only.** It can rename a document; it
cannot replace its body. So the only way to publish new content is:

1. `create_file` with the new content
2. `search_files` for that exact title
3. `trash_file` every result **except the one just created, matched by id**

**Create first, trash second, always.** The reasoning is one sentence:

- Trash first and the create fails → the page is now reading **nothing**.
- Trash nothing and the create fails → the page keeps reading yesterday's
  document, one cycle stale. Which is fine.

The failure mode you can survive is the one you design for.

Duplicate documents piling up therefore mean a run created one and then died
before cleaning up. The next successful run tidies them. That is the safe
failure and it needs no intervention.

**The page only ever creates. It never trashes anything.** Cleanup is a pipeline
job, because only the pipeline knows what it has actually consumed.

---

## Why the payload is compressed

The agent has to **type** the payload into a document. There is no upload API on
this path, so the language model is unavoidably the byte transport, and every
character costs tokens twice — once to read the file, once to emit it.

An uncompressed payload was about **65,000 base64 characters**: roughly 185k
tokens to read and 185k more to emit, which is past a context window. Runs
failed, repeatedly, with `drive=FAILED(payload 65000 chars ...)`.

Gzip before base64, on JSON with highly repeated keys, compresses about **six
times**. With the slim tiers on top, a run's upload is around **6,700 characters
— roughly 2,000 to 2,800 tokens.** That is a >9× reduction and it fits in one
message with room to spare.

### The checksum is not decoration

`AGD2.` carries a CRC-32 computed over the **gzip bytes, before base64**.

The realistic corruption mode here is a truncated or mistyped transcription — the
model dropped a chunk, or a document reflowed something. And **a truncated gzip
stream can still start decompressing**, so without a checksum a torn payload
produces *plausible partial data* rather than an error. Half a week's agenda,
presented as a whole one, is a worse outcome than no agenda.

Readers strip all whitespace before decoding, because a Google Doc inserts soft
line breaks and those are not corruption.

`AGC1.` and `AGQ1.` stay plain and uncompressed: the page writes them directly
through a tool call, so no model is in that path and they are small.

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

**Raising `maxEmitChars` is usually the wrong fix.** Those characters get typed
by a model and they cost real tokens on every run. Reduce `scrapeWindowDays`, or
accept tier 1 — it only loses blurbs on things due in three weeks.

---

## The state mirror

`<ns>-mirror` exists for one scenario: **your disk dies at 3am.**

The payload document is a *rendering*, and a rendering cannot be turned back into
the files that produced it. Lose your disk and you lose the study log, the
overrides, the completions, the block edits and the plan — months of accumulated
opinion that **no scrape can rebuild**, because your LMS never knew any of it.

So heavy runs pack the state and push a copy.

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

The setup agent walks this. There are two steps and the first one is the one
everybody misses.

### 1. Add the connector to your Claude account — first

**claude.ai → Settings → Connectors → add Google Drive**, and complete Google's
sign-in there if it asks.

This is on **your Claude account**, not in this folder. Nothing in this
repository can do it for you, no configuration key substitutes for it, and
**until it exists there is no consent screen for anything to trigger.** Skip it
and everything still appears to work right up to the point where the published
page says *"Drive connector not available"* and the Refresh button does nothing.

### 2. Then the consent screen, which you should expect

> A **Google consent screen** asking Claude for Drive access.

That is **Google's** screen, not this repository's. Say so out loud to anyone you
are helping through it, because an unannounced OAuth screen from a stranger's
repo is exactly where people quit — and they are right to.

**What the page can actually touch:** it creates and reads documents whose titles
start with your namespace, and it trashes nothing. The pipeline trashes only
older documents of the four exact titles above, matched by id. Nothing else in
your Drive is read, written or deleted.

---

## Turning it off — including "I don't have a Google account"

Set `drive.enabled: false`. Everything still works locally — `agenda.html`
renders with its complete embedded payload every run.

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
| "data doc unreadable (checksum)" | Re-run the upload. **Do not hand-edit the document** |
| The page shows stale data and refresh does nothing | The Drive connector is not authorised in the browser session showing the page. Re-approve it |
| `drive=SKIPPED(oversize)` | See the slim tiers above |
| The Doc mangles the blob | Readers strip whitespace, so this is normally invisible. If it genuinely breaks, pass `disableConversionToGoogleType: true` on the create |
| A mark you made vanished | A completions document was trashed unconsumed. That is a bug — please file it |
