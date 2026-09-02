' ============================================================================
'  stale-check.vbs - console-free launcher for src/stale-check.mjs
' ============================================================================
'
'  WHY THIS FILE EXISTS
'  --------------------
'  The stale-run watchdog task fires on logon, on unlock, on resume from sleep,
'  and every 30 minutes all day - up to ~50 times a day, most of them while the
'  user is looking at the screen. Pointing the task at node.exe or at a .cmd
'  puts a console window on the desktop for a fraction of a second on every one
'  of those fires. That flicker is exactly the kind of thing that gets a
'  watchdog disabled, and a disabled watchdog protects nothing.
'
'  wscript.exe has no console of its own, and WshShell.Run with window style 0
'  starts node fully hidden. This is the whole trick; there is nothing else in
'  this file.
'
'  WHAT IT DOES NOT DO
'  -------------------
'    * It writes NO log. data/runlog.txt belongs to the run lanes and
'      data/stale-check.json is the only file this watchdog owns - a per-fire
'      transcript would bury both. `lastCheckAt` in that JSON is the heartbeat.
'    * It makes no decisions. Every rule lives in src/stale-check.mjs, where it
'      is unit-tested; this file must stay dumb enough to never need a test.
'
'  Exit code is node's own, passed straight through, so Task Scheduler's
'  "Last Run Result" stays truthful: 0 = a decision was reached, 1 = the
'  watchdog itself is broken.
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
scriptPath = fso.BuildPath(repo, "src\stale-check.mjs")

If Not fso.FileExists(scriptPath) Then
  ' Nothing to run and nowhere quiet to say so. Exit 1 = "the watchdog is down",
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
