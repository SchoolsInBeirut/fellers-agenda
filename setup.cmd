@echo off
REM ===========================================================================
REM  setup.cmd - double-click this on Windows
REM ===========================================================================
REM  All it does is check Node is there and hand over to `npm run setup`, which
REM  is `node scripts/setup.mjs`. Every decision lives in that file; this exists
REM  so somebody who has never opened a terminal has something to double-click,
REM  and so the window does not vanish before they can read the error.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node is not installed, or is not on PATH.
  echo   Install it with:  winget install OpenJS.NodeJS.LTS
  echo   Or take the LTS build from https://nodejs.org
  echo.
  echo   Then close this window, open a new one, and double-click this file again.
  echo.
  pause
  exit /b 1
)

call npm run setup -- %*
if errorlevel 1 (
  echo.
  echo   Setup stopped. The reason is above; nothing was left half-written.
  echo   Run this again, or see docs\SETUP.md for the same steps by hand.
  echo.
  pause
  exit /b 1
)

echo.
pause
