@echo off
setlocal
REM ============================================================================
REM  run-daily.cmd - Windows launcher for the once-a-day agenda run
REM ============================================================================
REM
REM  WHAT THIS IS
REM  ------------
REM  A three-line wrapper. Every decision lives in scripts\run-daily.mjs, which
REM  runs the pipeline, opens one small model window and finishes the run
REM  whether or not that window opened. This file exists only because Task
REM  Scheduler needs something to execute and because a run's stdout has to land
REM  somewhere a human can read it later.
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
REM  Deliberately absent, and there is nothing here to put it on: the model
REM  window is opened by run-daily.mjs with four built-in tools
REM  (Bash, Read, Write, PushNotification), no MCP servers at all, and
REM  project-level settings only. docs/SCHEDULING.md explains the tradeoff if
REM  you want to make a different one.
REM
REM  THE LOG
REM  -------
REM  data\runlog-stdout.txt is the raw transcript and grows. It is git-ignored
REM  along with the rest of data\. The structured one-line-per-run record is
REM  data\runlog.txt, written by `node src/pipeline.mjs --finish`; that is the
REM  file to read when you want to know what happened, and it is capped at 500
REM  lines with every STALE and AUTH line kept.
REM
REM  ARGUMENTS
REM  ---------
REM  Anything you pass is handed straight through, so
REM  `scripts\run-daily.cmd --no-llm` and `--dry-run` work from a terminal. The
REM  scheduled task passes nothing.
REM ============================================================================

set "REPO=%~dp0.."
pushd "%REPO%" || exit /b 1

if not exist "data" mkdir "data"

node "%~dp0run-daily.mjs" %* >> "data\runlog-stdout.txt" 2>&1

set "RC=%ERRORLEVEL%"

popd
endlocal & exit /b %RC%
