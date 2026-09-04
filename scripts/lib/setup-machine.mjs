// ===========================================================================
//  setup-machine.mjs - Step 1, "is this machine capable of running any of it"
// ===========================================================================
//
//  Three questions, in the order they matter. Node's version is the only one
//  that can stop the wizard: everything in this repository is stdlib-only ESM
//  and several modules use APIs that landed in 22, so an older runtime cannot
//  be worked around and pretending otherwise wastes somebody's afternoon.
//  `git` and `claude` are reported and never blocked on - neither is needed to
//  reach a rendered demo agenda, which is the first thing setup wants to put in
//  front of a new user.
//
//  Every side effect - the probe, the printer, the exit - is injected, so a
//  test can put this on an imaginary machine with an imaginary Node.
// ===========================================================================

/** The oldest Node this repository runs on. `package.json` says the same. */
export const NODE_MIN = 22;

/** The exact install line per platform. Printed, never run without a yes. */
export const NODE_INSTALL = Object.freeze({
  win32: "winget install OpenJS.NodeJS.LTS",
  darwin: "brew install node@22",
  linux: "curl -fsSL https://fnm.vercel.app/install | bash   # then: fnm install 22 && fnm use 22",
});

const OS_NAMES = Object.freeze({ win32: "Windows", darwin: "macOS", linux: "Linux" });

/**
 * @param {{did:(s:string)=>void, step:(s:string)=>void}} io  the printer
 * @param {{probe:(bin:string)=>string|null, version?:string, platform?:string,
 *          arch?:string, err?:(s:string)=>void, exit?:(n:number)=>void}} env
 * @returns {{claude:boolean}}  what the rest of the wizard needs to know
 */
export function checkMachine(io, env) {
  const { probe, version = process.version, platform = process.platform, arch = process.arch } = env;
  const err = env.err ?? console.error;
  const exit = env.exit ?? process.exit;

  io.step("Checking this machine");
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  if (!Number.isFinite(major) || major < NODE_MIN) {
    err(`      Node ${version} is too old. This repository needs v${NODE_MIN} or newer.`);
    err(`      Install it with:  ${NODE_INSTALL[platform] ?? "see https://nodejs.org (take the LTS build)"}`);
    err("      Then close this terminal, open a new one, and run `npm run setup` again.");
    return exit(2);
  }
  io.did(`Node ${version} - ok`);
  io.did(`${OS_NAMES[platform] ?? platform} (${arch})`);

  const git = probe("git");
  io.did(git ? `git: ${git}` : "git: not found - only needed to clone and update this repo, not to run it");

  const claude = probe("claude");
  if (claude) io.did(`Claude Code: ${claude}`);
  else {
    io.did("Claude Code: not found on PATH.");
    io.did("  Setup does not need it; the scheduled runs do. Install it from https://claude.com/claude-code");
  }
  return { claude: Boolean(claude) };
}
