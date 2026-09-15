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
//
//  WHAT 2.0.0 CHANGED HERE
//  -----------------------
//  Every platform now schedules THE SAME LAUNCHER: `node scripts/run-daily.mjs`.
//  1.x scheduled `claude -p` directly and therefore had to carry a per-platform
//  tool allow-list in this file, which is how the macOS and Linux lanes quietly
//  drifted apart from each other and from the Windows one. The launcher owns
//  the model window now - which model, which effort, which four tools, and what
//  to do when `claude` is not installed at all - so there is exactly one place
//  that knows, and it is not this file.
// ===========================================================================

/** The shipped scheduler block, so a plan can be built without a config.json.
 *  Only the two keys a schedule is actually made of: what to call the tasks,
 *  and when the one run of the day happens. */
export const SCHEDULER_DEFAULTS = Object.freeze({
  taskPrefix: "Agenda",
  dailyAt: "10:30",
});

/** What every platform schedules. Relative, because every form below `cd`s into
 *  the checkout first - an absolute path here would have to be re-substituted
 *  in three places and would break the moment the folder moved. */
const LAUNCHER = "node scripts/run-daily.mjs";

/** The auth watchdog's hourly tick. The stale-run watchdog has no cron or
 *  launchd form: it rescues a Windows scheduled task, and there is nothing for
 *  it to rescue on a platform where `schtasks` does not exist. */
const AUTH = "node src/auth-retry.mjs";

/** Where a scheduled run's stdout goes on every platform. The launcher writes
 *  its own `---- daily start/end <ISO> ----` markers into this file. */
const LOG = ">> data/runlog-stdout.txt 2>&1";

/**
 * cron starts jobs with a nearly empty environment, so neither `node` nor
 * `claude` is on the path unless the crontab says where to look.
 * docs/SCHEDULING.md prints a placeholder that includes a `~/.local/bin` entry
 * for the person who installed Claude Code there; this is the portable core of
 * it, and the wizard prints a line telling the user to widen it if their
 * binaries live elsewhere.
 */
const CRON_PATH = "/usr/local/bin:/usr/bin:/bin";

/** "10:30" -> {h: 10, m: 30}. Falls back to the shipped default on anything else. */
export function parseHM(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return parseHM(fallback, "00:00");
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return parseHM(fallback, "00:00");
  return { h, m: min };
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
  const at = parseHM(s.dailyAt, SCHEDULER_DEFAULTS.dailyAt);
  const cd = `cd "${repoPath}" && `;
  const daily = `${cd}${LAUNCHER} ${LOG}`;
  const auth = `${cd}${AUTH}`;

  const files = [
    {
      path: "~/Library/LaunchAgents/com.agenda.daily.plist",
      content: plist(
        "com.agenda.daily",
        daily,
        [
          "  <key>StartCalendarInterval</key>",
          `  <dict><key>Hour</key><integer>${at.h}</integer><key>Minute</key><integer>${at.m}</integer></dict>`,
          "  <key>RunAtLoad</key><false/>",
        ].join("\n"),
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
      "launchd runs a missed job when the Mac wakes, so a closed lid does not cost you a day.",
      "It will not wake a sleeping Mac, which is why no two-factor prompt can arrive at a phone nobody is holding.",
      "The daily run needs rclone for Google Drive; `rclone version` is the check, and setup printed the install line above.",
      "Outlook mail and the Exchange calendar sink stay off here; enable connectors.calendar.ics for deadline reminders.",
      "There is no stale-run watchdog on macOS - it rescues a Windows scheduled task, and launchd already catches up a missed job by itself.",
    ],
  };
}

function cronPlan(repoPath, s) {
  const at = parseHM(s.dailyAt, SCHEDULER_DEFAULTS.dailyAt);

  // BOTH halves are quoted, and both matter. cron word-splits an unquoted
  // assignment, so a clone in `~/my agenda` yields AGENDA=/home/sam/my with a
  // stray `agenda` argument; `cd` then fails on a path that does not exist and
  // `&&` swallows the whole job. Nothing is written anywhere - the crontab
  // looks perfectly installed and no digest ever arrives.
  const lines = [
    `PATH=${CRON_PATH}`,
    `AGENDA="${repoPath}"`,
    "",
    `${at.m} ${at.h} * * * cd "$AGENDA" && ${LAUNCHER} ${LOG}`,
    `4 * * * * cd "$AGENDA" && ${AUTH} ${LOG}`,
  ];

  return {
    kind: "cron",
    doc: "docs/SCHEDULING.md -> Linux",
    files: [{ path: "(crontab)", content: `${lines.join("\n")}\n` }],
    commands: ["crontab -e   # paste the block above", "crontab -l   # check it took"],
    notes: [
      "PATH is explicit because cron's environment is nearly empty and neither `node` nor `claude` would be found otherwise. Widen it if yours live elsewhere.",
      "cron does not catch up: a job whose time passed while the machine slept is simply gone. If yours sleeps, use systemd timers with Persistent=true.",
      "The daily run needs rclone for Google Drive; `rclone version` is the check, and setup printed the install line above.",
      "There is no dead-man's switch on Linux - it needs the Windows Outlook sink. Every run logs deadman=SKIPPED(no-calendar-sink), which is expected.",
    ],
  };
}

function windowsPlan(s) {
  const p = s.taskPrefix || SCHEDULER_DEFAULTS.taskPrefix;
  const at = s.dailyAt || SCHEDULER_DEFAULTS.dailyAt;
  return {
    kind: "windows",
    doc: "docs/SCHEDULING.md -> Windows",
    files: [],
    commands: ["scripts\\install-tasks.cmd"],
    tasks: [
      `${p} Daily       scripts\\run-daily.cmd, daily at ${at}`,
      `${p} StaleCheck  src/stale-check.mjs, at logon, unlock, resume, and every 30 min`,
      `${p} AuthRetry   src/auth-retry.mjs, the same triggers on an hourly floor`,
    ],
    notes: [
      "No administrator rights are needed - every task runs as your user, and no password is stored.",
      "The installer is idempotent: running it again after you move the folder re-asserts every setting.",
      "It never runs a task. The first agenda arrives at the next scheduled time.",
      `Upgrading from 1.x? "${p} Morning", "${p} Evening" and "${p} Sync" are retired. The installer names any it finds and leaves them; scripts\\install-tasks.cmd /remove-legacy deletes exactly those three.`,
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
      "Run the pipeline by hand with `node scripts/run-daily.mjs`, or open an issue describing this platform's scheduler.",
    ],
  });
}
