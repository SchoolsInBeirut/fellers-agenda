' ============================================================================
'  auth-retry.vbs - console-free launcher for src/auth-retry.mjs
' ============================================================================
'
'  WHY THIS FILE EXISTS
'  --------------------
'  The auth lane fires on logon, on unlock, on resume from sleep, and every hour
'  all day - roughly 24 times a day, most of them while the user is looking at
'  the screen. Pointing the task at node.exe or at a .cmd puts a console window
'  on the desktop for a fraction of a second on every one of those fires. That
'  flicker is exactly the kind of thing that gets a watchdog disabled, and a
'  disabled watchdog protects nothing.
'
'  There is a second reason here that the stale-run watchdog does not have: on
'  the rare tick where this lane actually fires, it starts a headless browser
'  login. That child inherits this hidden console, so the whole login tree stays
'  out of the user's way too.
'
'  wscript.exe has no console of its own, and WshShell.Run with window style 0
'  starts node fully hidden. This is the whole trick; there is nothing else in
'  this file.
'
'  WHAT IT DOES NOT DO
'  -------------------
'    * It writes NO log. data/auth-retry.json is the heartbeat, and the AUTH
'      lane of data/runlog.txt carries the one line a real fire produces.
'    * It makes no decisions. Every rule lives in src/auth-retry.mjs, where it
'      is unit-tested; this file must stay dumb enough to never need a test.
'
'  Exit code is node's own, passed straight through, so Task Scheduler's
'  "Last Run Result" stays truthful: 0 = a decision was reached (INCLUDING a
'  login that failed - that is this lane working), 1 = the lane itself is broken.
' ============================================================================
Option Explicit

Dim sh, fso, here, repo, nodeExe, scriptPath, cmd

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Everything is resolved relative to THIS file, so the repository can be cloned
' to any path and moved afterwards without the task definition or this wrapper
' needing an edit. Never hardcode a path here.
here       = fso.GetParentFolderName(WScript.ScriptFullName)   ' <repo>\scripts
repo       = fso.GetParentFolderName(here)                     ' <repo>
scriptPath = fso.BuildPath(repo, "src\auth-retry.mjs")

If Not fso.FileExists(scriptPath) Then
  ' Nothing to run and nowhere quiet to say so. Exit 1 = "the lane is down",
  ' which is what Task Scheduler's Last Run Result should show.
  WScript.Quit 1
End If

' Prefer the absolute node path when it is where it usually is: a scheduled task
' started at logon can run before PATH is fully composed for the session.
nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

sh.CurrentDirectory = repo
cmd = """" & nodeExe & """ """ & scriptPath & """"

' 0 = hidden window, True = wait for it so the exit code is real.
WScript.Quit sh.Run(cmd, 0, True)
