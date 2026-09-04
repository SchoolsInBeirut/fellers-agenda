// ===========================================================================
//  setup-schedule.mjs - the schedule plan for this machine, as data
// ===========================================================================
//
//  WHY A PLAN OBJECT RATHER THAN A SCRIPT THAT INSTALLS THINGS
//  -----------------------------------------------------------
//  Windows already has a real installer - `scripts/install-tasks.cmd` - which
//  is idempotent, verifies its target files before registering anything, and is
//  the only thing in this repository allowed to touch Task Scheduler. The
//  wizard calls it; it does not reimplement it.
//
//  macOS and Linux have no installer, because `docs/SCHEDULING.md` documents
//  those platforms as files the user (or an agent) writes. So the wizard's job
//  there is to produce those exact files with this checkout's real absolute
//  path substituted for the `$HOME/my-agenda` and `AGENDA=` placeholders, and
//  then offer to install them. Every string below is copied from
//  `docs/SCHEDULING.md`; nothing here is invented, and a platform that document
//  does not cover produces a plan with `kind: "undocumented"` and no files.
//
//  A `launchd` job or a cron line with the wrong `cd` fails silently and looks
//  perfectly installed. Substituting the real path is the whole value of doing
//  this in a script instead of in prose.
// ===========================================================================

/** The shipped scheduler block, so a plan can be built without a config.json. */
export const SCHEDULER_DEFAULTS = Object.freeze({
  taskPrefix: "Agenda",
  morningAt: "07:03",
  eveningAt: "18:07",
  syncWindow: ["09:00", "23:00"],
  syncGapHours: 3,
});

/**
 * The tool allow-lists, verbatim from docs/SCHEDULING.md. They differ per
 * platform in that document (the macOS heavy lane also allows Gmail), and this
 * file mirrors the document rather than tidying it - a wizard that "improved" a
 * documented allow-list would hand the user a schedule the docs do not describe.
 */
const TOOLS = Object.freeze({
  heavyDarwin:
    "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__brightspace__*,mcp__claude_ai_Google_Drive__*,mcp__claude_ai_Gmail__*",
  heavyLinux:
    "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__brightspace__*,mcp__claude_ai_Google_Drive__*",
  sync: "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__claude_ai_Google_Drive__*",
});

const HEAVY_PROMPT = "Read runbooks/heavy-run.md and follow its instructions exactly.";
const SYNC_PROMPT = "Read runbooks/sync-run.md and follow its instructions exactly.";

/**
 * cron starts jobs with a nearly empty environment, so `claude` is not on the
 * path unless the crontab says where to look. docs/SCHEDULING.md prints a
 * placeholder that includes a `~/.local/bin` entry for the person who installed
 * Claude Code there; this is the portable core of it, and the wizard prints a
 * line telling the user to widen it if their `claude` lives elsewhere.
 */
const CRON_PATH = "/usr/local/bin:/usr/bin:/bin";

/** "07:03" -> {h: 7, m: 3}. Falls back to the shipped default on anything else. */
export function parseHM(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return parseHM(fallback, "00:00");
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return parseHM(fallback, "00:00");
  return { h, m: min };
}

/**
 * The sync lane's step in hours.
 *
 * `scripts/install-tasks.cmd` computes `max(1, syncGapHours - 1)` and the
 * documented cron line is `9-23/2` against the default `syncGapHours: 3`. The
 * same arithmetic is repeated here so the three agree.
 */
export function syncEveryHours(syncGapHours) {
  const n = Number(syncGapHours);
  return Math.max(1, (Number.isFinite(n) ? n : SCHEDULER_DEFAULTS.syncGapHours) - 1);
}

const scheduler = (cfg) => ({ ...SCHEDULER_DEFAULTS, ...(cfg?.scheduler ?? {}) });

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(label, shell, extra) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/sh</string>",
    "    <string>-c</string>",
    `    <string>${xmlEscape(shell)}</string>`,
    "  </array>",
    extra,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function launchdPlan(repoPath, s) {
  const morning = parseHM(s.morningAt, SCHEDULER_DEFAULTS.morningAt);
  const evening = parseHM(s.eveningAt, SCHEDULER_DEFAULTS.eveningAt);
  const cd = `cd "${repoPath}" && `;
  const heavy = `${cd}claude -p "${HEAVY_PROMPT}" --allowedTools "${TOOLS.heavyDarwin}" >> data/runlog-stdout.txt 2>&1`;
  const sync = `${cd}claude -p "${SYNC_PROMPT}" --allowedTools "${TOOLS.sync}" >> data/runlog-stdout.txt 2>&1`;
  const auth = `${cd}node src/auth-retry.mjs`;

  const files = [
    {
      path: "~/Library/LaunchAgents/com.agenda.heavy.plist",
      content: plist(
        "com.agenda.heavy",
        heavy,
        [
          "  <key>StartCalendarInterval</key>",
          "  <array>",
          `    <dict><key>Hour</key><integer>${morning.h}</integer><key>Minute</key><integer>${morning.m}</integer></dict>`,
          `    <dict><key>Hour</key><integer>${evening.h}</integer><key>Minute</key><integer>${evening.m}</integer></dict>`,
          "  </array>",
          "  <key>RunAtLoad</key><false/>",
        ].join("\n"),
      ),
    },
    {
      path: "~/Library/LaunchAgents/com.agenda.sync.plist",
      content: plist(
        "com.agenda.sync",
        sync,
        [`  <key>StartInterval</key><integer>${syncEveryHours(s.syncGapHours) * 3600}</integer>`, "  <key>RunAtLoad</key><false/>"].join("\n"),
      ),
    },
    {
      path: "~/Library/LaunchAgents/com.agenda.auth.plist",
      content: plist("com.agenda.auth", auth, ["  <key>StartInterval</key><integer>3600</integer>", "  <key>RunAtLoad</key><true/>"].join("\n")),
    },
  ];

  return {
    kind: "launchd",
    doc: "docs/SCHEDULING.md -> macOS",
    files,
    commands: [
      ...files.map((f) => `launchctl load ${f.path}`),
      "launchctl list | grep com.agenda",
    ],
    notes: [
      "launchd runs a missed job when the Mac wakes, so a closed lid does not cost you a digest.",
      "It will not wake a sleeping Mac, which is why no two-factor prompt can arrive at 07:03 at a phone nobody is holding.",
      "Outlook mail and the Exchange calendar sink stay off here; enable connectors.calendar.ics for deadline reminders.",
    ],
  };
}

function cronPlan(repoPath, s) {
  const morning = parseHM(s.morningAt, SCHEDULER_DEFAULTS.morningAt);
  const evening = parseHM(s.eveningAt, SCHEDULER_DEFAULTS.eveningAt);
  const win = Array.isArray(s.syncWindow) ? s.syncWindow : SCHEDULER_DEFAULTS.syncWindow;
  const from = parseHM(win[0], SCHEDULER_DEFAULTS.syncWindow[0]);
  const to = parseHM(win[1], SCHEDULER_DEFAULTS.syncWindow[1]);
  const step = syncEveryHours(s.syncGapHours);

  // BOTH halves are quoted, and both matter. cron word-splits an unquoted
  // assignment, so a clone in `~/my agenda` yields AGENDA=/home/sam/my with a
  // stray `agenda` argument; `cd` then fails on a path that does not exist and
  // `&&` swallows the whole job. Nothing is written anywhere - the crontab
  // looks perfectly installed and no digest ever arrives.
  const heavy = `cd "$AGENDA" && claude -p "${HEAVY_PROMPT}" --allowedTools "${TOOLS.heavyLinux}" >> data/runlog-stdout.txt 2>&1`;
  const sync = `cd "$AGENDA" && claude -p "${SYNC_PROMPT}" --allowedTools "${TOOLS.sync}" >> data/runlog-stdout.txt 2>&1`;

  const lines = [
    `PATH=${CRON_PATH}`,
    `AGENDA="${repoPath}"`,
    "",
    `${morning.m} ${morning.h} * * * ${heavy}`,
    `${evening.m} ${evening.h} * * * ${heavy}`,
    `0 ${from.h}-${to.h}/${step} * * * ${sync}`,
    `4 * * * * cd "$AGENDA" && node src/auth-retry.mjs >> data/runlog-stdout.txt 2>&1`,
  ];

  return {
    kind: "cron",
    doc: "docs/SCHEDULING.md -> Linux",
    files: [{ path: "(crontab)", content: `${lines.join("\n")}\n` }],
    commands: ["crontab -e   # paste the block above", "crontab -l   # check it took"],
    notes: [
      "PATH is explicit because cron's environment is nearly empty and `claude` would not be found otherwise. Widen it if your claude lives elsewhere.",
      "cron does not catch up: a job whose time passed while the machine slept is simply gone. If yours sleeps, use systemd timers with Persistent=true.",
      "There is no dead-man's switch on Linux - it needs the Windows Outlook sink. Every run logs deadman=SKIPPED(no-calendar-sink), which is expected.",
    ],
  };
}

function windowsPlan(s) {
  const p = s.taskPrefix || SCHEDULER_DEFAULTS.taskPrefix;
  return {
    kind: "windows",
    doc: "docs/SCHEDULING.md -> Windows",
    files: [],
    commands: ["scripts\\install-tasks.cmd"],
    tasks: [
      `${p} Morning     runbooks/heavy-run.md, daily at ${s.morningAt}`,
      `${p} Evening     runbooks/heavy-run.md, daily at ${s.eveningAt}`,
      `${p} Sync        runbooks/sync-run.md, every ${syncEveryHours(s.syncGapHours)}h inside ${(s.syncWindow ?? []).join("-")}`,
      `${p} StaleCheck  src/stale-check.mjs, at logon, unlock, resume, and every 30 min`,
      `${p} AuthRetry   src/auth-retry.mjs, the same triggers on an hourly floor`,
    ],
    notes: [
      "No administrator rights are needed - every task runs as your user, and no password is stored.",
      "The installer is idempotent: running it again after you move the folder re-asserts every setting.",
      "It never runs a task. The first digest arrives at the next scheduled time.",
    ],
  };
}

/**
 * The whole plan for one machine. Pure: no disk, no processes, no `os` lookup
 * beyond what the caller passes in.
 *
 * @param {string} platform  a `process.platform` value
 * @param {string} repoPath  the absolute path of this checkout
 * @param {object} cfg       the loaded config, for `scheduler`
 */
export function schedulePlan(platform, repoPath, cfg = {}) {
  const s = scheduler(cfg);
  if (platform === "win32") return Object.freeze({ platform, repoPath, ...windowsPlan(s) });
  if (platform === "darwin") return Object.freeze({ platform, repoPath, ...launchdPlan(repoPath, s) });
  if (platform === "linux") return Object.freeze({ platform, repoPath, ...cronPlan(repoPath, s) });
  return Object.freeze({
    platform,
    repoPath,
    kind: "undocumented",
    doc: "docs/SCHEDULING.md",
    files: [],
    commands: [],
    notes: [
      `docs/SCHEDULING.md does not cover "${platform}", so nothing is generated for it here.`,
      "Run the two lanes by hand with /agenda-now, or open an issue describing this platform's scheduler.",
    ],
  });
}
