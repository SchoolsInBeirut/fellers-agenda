@echo off
setlocal
REM ============================================================================
REM  run-sync.cmd - Windows launcher for the two-hourly light sync run
REM ============================================================================
REM
REM  Identical in shape to run-heavy.cmd, pointed at the other runbook. The
REM  difference that matters is inside runbooks\sync-run.md: this lane never
REM  scrapes, has a two-minute budget, and sends no email under any
REM  circumstance.
REM
REM  The tool allow-list is deliberately SMALLER than the heavy run's. A sync
REM  run has no reason to reach the LMS, the mailbox or the materials tree, so
REM  it is not given the ability to. If a future step genuinely needs one of
REM  those, that step belongs in the heavy run.
REM
REM  %~dp0.. is the repository root, so this works at any clone path. Never put
REM  an absolute path in here.
REM
REM  No --dangerously-skip-permissions. See run-heavy.cmd's header and
REM  docs/SCHEDULING.md.
REM ============================================================================

set "REPO=%~dp0.."
pushd "%REPO%" || exit /b 1

if not exist "data" mkdir "data"

echo ---- sync start %date% %time% ---- >> "data\runlog-stdout.txt"

claude -p "Read runbooks\sync-run.md and follow its instructions exactly." ^
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,ToolSearch,PushNotification,mcp__outlook__*,mcp__claude_ai_Google_Drive__*" ^
  >> "data\runlog-stdout.txt" 2>&1

set "RC=%ERRORLEVEL%"
echo ---- sync end %date% %time% (exit %RC%) ---- >> "data\runlog-stdout.txt"

popd
endlocal & exit /b %RC%
