# brightspace-mcp-server

| | |
|---|---|
| **Package** | `brightspace-mcp-server` (npm) |
| **Upstream** | <https://github.com/RohanMuppa/brightspace-mcp-server> |
| **License** | MIT — © 2025-2026 Rohan Muppa. Full text in [`LICENSE`](LICENSE) |
| **How this repo uses it** | Launched on demand by `npx` from `.mcp.json`. Not bundled, not installed by setup, not vendored |
| **What ships here** | One patch file. **No third-party source, compiled or otherwise.** |

---

## What we changed, and why

Nothing, on most installations. The published package works.

For schools whose identity provider now delegates single sign-on to **Microsoft
Entra ID with a Duo Universal Prompt**, it does not — and it fails in the worst
possible way: it hangs. The published build waits for a selector belonging to an
older single-sign-on form that those schools no longer serve, so the browser sits
on a login page that is fully rendered and fully ignored, forever. Manual login
works, automated login never completes, and nothing anywhere says why.

[`entra-duo-sso.patch`](entra-duo-sso.patch) rewrites the module that drives that
login so it walks the chain that is actually there — email field, Next, password
field, Sign in, the second-factor prompt, the "stay signed in?" page — and throws
**distinguishable** errors so a wrapper can tell "the password was wrong" apart
from "the second factor was never approved". Those are opposite problems with
opposite fixes, and collapsing them into one generic failure is what makes an
auth break take an afternoon to diagnose instead of a minute.

It also softens two `waitForLoadState("networkidle")` calls to
`domcontentloaded` with a bounded fallback. Some LMS home pages keep polling
connections open indefinitely, so "the network went idle" is a condition that
never becomes true and the wait always burns its full timeout.

The older selectors are kept as a fallback, so the patch does not break schools
that still use the previous flow.

---

## This should be a pull request upstream

It is a **general** improvement. The Entra-plus-Duo chain is not specific to one
university; it is what a large number of institutions moved to. Carrying a
downstream patch forever is worse for everybody than getting it merged: it
becomes stale on the next release, it has to be re-applied after every cache
clear, and every other user of the package hits the same hang with no hint that a
fix exists.

**If this patch helped you, please open that pull request.** It is the single
most useful thing you could do with the next twenty minutes, and it retires this
file.

---

## Applying it

You almost certainly do not need to. Try the ordinary path first — the setup
agent runs it for you:

```
npx -y brightspace-mcp-server@latest auth
```

Only if that hangs on your school's login page, and only after reading
`docs/connectors/brightspace.md`, do one of these:

**Option A — install from upstream `main`** (preferred; the fixes may already be
merged there even when they are not on npm yet):

```
claude mcp add-json brightspace '{"command":"npx","args":["-y","github:RohanMuppa/brightspace-mcp-server"]}' --scope project
```

On Windows, wrap it: `{"command":"cmd","args":["/c","npx","-y","github:RohanMuppa/brightspace-mcp-server"]}`.

**Option B — apply this patch to a local checkout:**

```
git clone https://github.com/RohanMuppa/brightspace-mcp-server
cd brightspace-mcp-server
git apply --3way /path/to/fellers-agenda/vendor/brightspace-mcp-server/entra-duo-sso.patch
npm install && npm run build
```

then point `.mcp.json` at your build.

**Read the patch header first.** It names the one file path you must adjust,
because upstream names that module after the university it was originally
written for and the name is not stable across versions.

## What we deliberately do not do

- **We do not patch the npm cache.** Writing into `node_modules` inside a package
  manager's cache is invisible, survives no `npm cache clean`, and produces a
  machine whose behaviour cannot be reproduced from its configuration. If you
  need the patch, take a real checkout.
- **We do not vendor the source.** Copying a third-party build into this repo
  would mean shipping code we do not maintain, under a license whose notice
  obligations we would then have to track per-file, and it would go stale
  silently. A diff is auditable in one screen; a vendored build is not.
