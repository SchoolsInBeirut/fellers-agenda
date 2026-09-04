#!/usr/bin/env bash
# ===========================================================================
#  setup.sh - the macOS / Linux entry point
# ===========================================================================
#  All it does is check Node is there and hand over to `npm run setup`, which
#  is `node scripts/setup.mjs`. Every decision lives in that file; this exists
#  so `./setup.sh` works from a fresh clone without knowing what npm is.
# ===========================================================================
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node is not installed, or is not on PATH."
  case "$(uname -s)" in
    Darwin) echo "  Install it with:  brew install node@22" ;;
    *)      echo "  Install it with:  curl -fsSL https://fnm.vercel.app/install | bash"
            echo "                    then: fnm install 22 && fnm use 22" ;;
  esac
  echo "  Or take the LTS build from https://nodejs.org"
  echo
  echo "  Then open a new terminal and run ./setup.sh again."
  echo
  exit 1
fi

if ! npm run setup -- "$@"; then
  echo
  echo "  Setup stopped. The reason is above; nothing was left half-written."
  echo "  Run this again, or see docs/SETUP.md for the same steps by hand."
  echo
  exit 1
fi
