@echo off
setlocal
REM ============================================================================
REM  run-heavy.cmd - Windows launcher for the twice-daily full agenda run
REM ============================================================================
REM
REM  WHAT THIS IS
REM  ------------
REM  A three-line wrapper. It starts one non-interactive Claude Code session and
REM  points it at runbooks\heavy-run.md. Every decision lives in that runbook;
REM  this file exists only because Task Scheduler needs something to execute and
REM  because a run's stdout has to land somewhere a human can read it later.
REM
REM  RELATIVE PATHS, ALWAYS
REM  ----------------------
REM  %~dp0 is this script's own folder, so %~dp0.. is the repository root. The
REM  repo can be cloned to any path on any machine and this file still works
REM  unchanged. Do NOT put an absolute path in here; the moment you do, the
REM  scheduled task silently breaks for everyone who moves the folder, and
REM  schtasks does not validate its target.
REM
REM  NO --dangerously-skip-permissions
REM  ---------------------------------
REM  Deliberately absent. --allowedTools below is an explicit allow-list: it is
REM  narrow enough for an unattended run to complete without prompting, and it
REM  still refuses anything outside it. Turning permissions off entirely in a
REM  task that runs twice a day, unattended, on a student's laptop, is not a
REM  tradeoff this template makes on your behalf. docs/SCHEDULING.md explains
REM  the tradeoff if you want to make it yourself.
REM
REM  THE LOG
REM  -------
REM  data\runlog-stdout.txt is the raw transcript and grows. It is git-ignored
REM  along with the rest of data\. The structured one-line-per-run record is
REM  data\runlog.txt, written by the runbook's final step; that is the file to
REM  read when you want to know what happened, and it is capped at 500 lines.
REM ============================================================================

set "REPO=%~dp0.."
pushd "%REPO%" || exit /b 1

if not exist "data" mkdir "data"

echo ---- heavy run start %date% %time% ---- >> "data\runlog-stdout.txt"

claude -p "Read runbooks\heavy-run.md and follow its instructions exactly." ^
  --allowedTools "Bash,PowerShell,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__brightspace__*,mcp__outlook__*,mcp__claude_ai_Google_Drive__*,mcp__claude_ai_Gmail__*" ^
  >> "data\runlog-stdout.txt" 2>&1

set "RC=%ERRORLEVEL%"
echo ---- heavy run end %date% %time% (exit %RC%) ---- >> "data\runlog-stdout.txt"

popd
endlocal & exit /b %RC%
