# Third-party notices

This project has **zero runtime dependencies**. Nothing is bundled, nothing is
vendored, and `npm install` is not part of setup. This file records the outside
software the template *talks to* and the one patch it distributes.

---

## brightspace-mcp-server

- **Package:** `brightspace-mcp-server` (npm)
- **Upstream:** <https://github.com/RohanMuppa/brightspace-mcp-server>
- **License:** MIT — © 2025-2026 Rohan Muppa
- **Full license text:** reproduced at
  [`vendor/brightspace-mcp-server/LICENSE`](vendor/brightspace-mcp-server/LICENSE)

The default LMS connector reaches Brightspace through this server. It is
launched on demand with `npx` from `.mcp.json`; **no copy of it lives in this
repository.**

**This repo ships a patch, not a copy.**
[`vendor/brightspace-mcp-server/entra-duo-sso.patch`](vendor/brightspace-mcp-server/entra-duo-sso.patch)
is a small unified diff that rewrites the single-sign-on module for schools whose
identity provider now delegates to Microsoft Entra ID with a Duo Universal
Prompt — a login chain the published build does not drive. It is a reference
patch you apply yourself, deliberately, only if your school's login hangs. No
compiled third-party source is vendored here, and applying the patch is never
automatic.

**This fix should be offered upstream as a pull request.** It is a general
improvement — the Entra + Duo chain is not specific to one university — and
carrying a downstream patch forever is worse for everyone than getting it
merged. If you are reading this because the patch helped you, opening that PR is
the single most useful thing you could do with the next twenty minutes. See
[`vendor/brightspace-mcp-server/NOTICE.md`](vendor/brightspace-mcp-server/NOTICE.md)
for exactly what changed and why.

---

## Services this template integrates with

None of these are dependencies; each is an optional connector you enable
yourself, and each is governed by its own terms.

| Service | Used for | Reached via |
|---|---|---|
| Brightspace (D2L) | Assignments, content, announcements, grades | `brightspace-mcp-server` over stdio |
| Canvas (Instructure) | The alternative LMS source; either or both may be enabled | The Canvas REST API directly, with a personal access token you generate. No third-party package |
| Google Drive | The transport for the payload, mirror and both write-back buses | Your Claude account's own connector |
| Google Calendar / Apple Calendar | Optional, and **at your end only** — they read the `.ics` file the ICS sink writes. Nothing here talks to either service | A calendar subscription you set up yourself |
| GitHub | The optional side-project board | The `gh` CLI, MIT |
| Microsoft Outlook (classic, Windows) | Optional mail triage and an Exchange calendar sink | Local COM automation |
| Gradescope | An optional grades extra, **off by default** | `gradescopeapi` (Python), see `extras/gradescope/README.md` |

`gradescopeapi` is the only Python package this repo can invoke, it is pinned in
`extras/gradescope/requirements.txt`, and it is never installed unless you
deliberately enable that extra. Read `extras/gradescope/README.md` — and your
institution's and the service's terms — before you do.

---

## Fonts

The rendered page requests **Google Fonts** and nothing else. It has no CDN
scripts, no external stylesheets beyond that, no remote images and no analytics.
Every face has a real system fallback stack, so the page is fully legible with
the network off.
