@echo off
setlocal
REM ============================================================================
REM  install-tasks.cmd - create AND repair all three scheduled tasks
REM ============================================================================
REM
REM  WHAT THIS IS FOR
REM  ----------------
REM  Windows Task Scheduler is the only part of this system that fails silently
REM  and invisibly. schtasks.exe does not validate the file a task points at, so
REM  a task can look perfectly installed for a month while executing nothing.
REM  A task without StartWhenAvailable simply loses a run the machine slept
REM  through - no digest that day, no error, no explanation anywhere.
REM
REM  This file creates the three tasks and re-asserts every setting that
REM  matters. It is IDEMPOTENT AND SAFE TO RUN REPEATEDLY: running it twice, or
REM  ten times, produces exactly the same end state. Run it after you move the
REM  repository, after a Windows feature update, or any time /agenda-doctor says
REM  a task looks wrong.
REM
REM  NO ADMIN REQUIRED. Everything here is per-user: each task runs as the
REM  logged-on user with an interactive token and least privilege. Nothing is
REM  written to HKLM and no password is stored.
REM
REM  WHAT IT NEVER DOES
REM  ------------------
REM    * It never RUNS a task. A run means a live pipeline, an email and a Drive
REM      write - that is the scheduler's job, not an installer's.
REM    * It never DELETES a task you did not ask it to remove. The three 1.x
REM      tasks are RETIRED, not condemned: without /remove-legacy this prints one
REM      notice per task it finds and leaves every one of them alone.
REM    * It never edits config.json, a runbook, or anything under src/.
REM    * It never writes into data/. The watchdogs own data/stale-check.json and
REM      data/auth-retry.json, plus the STALE and AUTH lanes of data/runlog.txt;
REM      nothing else does. In particular it never REMOVES data/auth-locked.json:
REM      re-registering a task must never look like it cleared a lockout.
REM
REM  THE THREE TASKS
REM  ---------------
REM    <prefix> Daily       scripts\run-daily.cmd, daily at scheduler.dailyAt
REM    <prefix> StaleCheck  scripts\stale-check.vbs, four triggers (below)
REM    <prefix> AuthRetry   scripts\auth-retry.vbs, the same four triggers on an
REM                         hourly floor instead of a 30-minute one
REM
REM  <prefix> is config.json -> scheduler.taskPrefix, default "Agenda", so the
REM  task names change with your namespace and never collide with anyone else's.
REM  The time comes from config.json -> scheduler.dailyAt. Change it there and
REM  re-run this file; do not edit a task by hand in the Task Scheduler UI,
REM  because the next run of this installer will assert it back.
REM
REM  RETIRED IN 2.0.0
REM  ----------------
REM  1.x installed five tasks: two heavy runs (Morning / Evening) and a 2-hourly
REM  Sync lane, all three of which handed a whole run to a language model. 2.0.0
REM  replaced them with ONE scripted run a day. If you are upgrading, those three
REM  tasks are still registered and still pointing at launchers that no longer
REM  exist; this file tells you which it found, and `install-tasks.cmd
REM  /remove-legacy` deletes exactly those three and nothing else.
REM
REM  THE STALECHECK TRIGGERS
REM  -----------------------
REM    1. At logon              - the lid opened onto a cold boot.
REM    2. On workstation unlock - the far more common case: the machine never
REM                               shut down, it slept, and the user unlocked it.
REM    3. On resume from sleep  - the System event log's power-troubleshooter
REM                               record, which is what Windows writes for
REM                               "returned from a low power state". This fires
REM                               even when the session was never locked (a lid
REM                               opened on a logged-in, unlocked desktop),
REM                               which trigger 2 misses.
REM    4. Daily 00:05, repeating every 30 min for 24 h - the floor. Covers a
REM                               machine that stays awake and logged in through
REM                               the boundary while something else went wrong.
REM
REM  Triggers 2 and 3 CANNOT be expressed by schtasks.exe at all - it has no
REM  /SC ONUNLOCK and no event-subscription syntax. That is why every task here
REM  goes through Register-ScheduledTask with CIM trigger instances.
REM
REM  THE WATCHDOG ACTIONS: wscript.exe, not node.exe
REM  -----------------------------------------------
REM  Those two tasks fire up to ~50 and ~24 times a day, mostly while the user is
REM  at the screen; anything with a console flashes a black window every single
REM  time, and a watchdog that annoys people gets disabled. wscript has no
REM  console. See the headers of scripts\stale-check.vbs and scripts\auth-retry.vbs.
REM
REM  THE AUTHRETRY TASK
REM  ------------------
REM  Same four triggers, hourly instead of half-hourly, and two settings that
REM  carry real reasoning:
REM    * WakeToRun = FALSE. Never wake a sleeping laptop to put a two-factor
REM      prompt on a sleeping user's phone. That is the original failure with
REM      extra steps. StartWhenAvailable plus the resume trigger cover the lid
REM      opening, which is when the prompt can actually be answered.
REM    * 00:04, not 00:05, so the auth lane and the stale-run watchdog do not
REM      tick in lockstep and fight over the same waking second.
REM  ExecutionTimeLimit is 15 min rather than 5: on the rare tick where it fires,
REM  it is waiting on a real login, and src/auth-retry.mjs already caps its child
REM  at 7 minutes.
REM
REM  HOW THIS FILE IS PUT TOGETHER
REM  -----------------------------
REM  The PowerShell half lives at the bottom of this same file, one statement
REM  per line behind a "#PS#" marker, and is extracted to %TEMP% and run. The
REM  reason is escaping: the event subscription is an XML string full of angle
REM  brackets and quotes, and threading that through cmd's parser inside
REM  powershell -Command is a nest of carets that breaks the first time anyone
REM  edits it. cmd never reads past the `exit /b` below, so those lines can hold
REM  any characters they like.
REM
REM  USAGE
REM  -----
REM    install-tasks.cmd                 create / re-assert all three tasks, and
REM                                      report any 1.x task still registered
REM    install-tasks.cmd /remove-legacy  also DELETE "<prefix> Morning",
REM                                      "<prefix> Evening" and "<prefix> Sync"
REM                                      if they exist. Nothing else is removed.
REM
REM  Exit 0 = all three are registered and verified. Anything else = they are
REM  not, and the reason was printed.
REM ============================================================================

set "REPO=%~dp0.."
set "PS1=%TEMP%\agenda-install-tasks.ps1"
set "REMOVELEGACY=0"
if /I "%~1"=="/remove-legacy" set "REMOVELEGACY=1"

echo.
echo === Agenda scheduled-task installer ===
echo.

REM --- extract the PowerShell half of this file to %TEMP% ---------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$o=@(); foreach($l in [IO.File]::ReadAllLines('%~f0')){ if($l.StartsWith('#PS#')){ $o += $l.Substring(4) } }; if($o.Count -lt 10){ Write-Host '      FAILED - could not extract the installer body.'; exit 1 }; [IO.File]::WriteAllLines($env:TEMP + '\agenda-install-tasks.ps1', $o)"
if errorlevel 1 goto :failed

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Repo "%REPO%" -RemoveLegacy %REMOVELEGACY%
set "RC=%ERRORLEVEL%"
del "%PS1%" >nul 2>&1
if not "%RC%"=="0" goto :failed

echo.
echo === done. Nothing was run; the scheduler starts them at their own times. ===
echo.
endlocal
exit /b 0

:failed
echo.
echo === installation did NOT complete - see the message above ===
echo.
endlocal
exit /b 1

REM ============================================================================
REM  Everything below is the PowerShell half. cmd never reaches it.
REM ============================================================================
#PS# param([string]$Repo, [int]$RemoveLegacy = 0)
#PS# $ErrorActionPreference = 'Stop'
#PS#
#PS# $Repo = (Resolve-Path -LiteralPath $Repo).Path
#PS# $Ns   = 'Root/Microsoft/Windows/TaskScheduler'
#PS# $Me   = "$env:USERDOMAIN\$env:USERNAME"
#PS#
#PS# # ---- read scheduler settings from config.json, with the shipped defaults --
#PS# # A task pointing at settings that disagree with config.json is a task that
#PS# # lies. There is one source of truth and it is config.json.
#PS# $cfgPath = Join-Path $Repo 'config.json'
#PS# $prefix  = 'Agenda'
#PS# $dailyAt = '10:30'
#PS# if (Test-Path -LiteralPath $cfgPath) {
#PS#   try {
#PS#     $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
#PS#     $s = $cfg.scheduler
#PS#     if ($s) {
#PS#       if ($s.taskPrefix) { $prefix  = [string]$s.taskPrefix }
#PS#       if ($s.dailyAt)    { $dailyAt = [string]$s.dailyAt }
#PS#     }
#PS#     Write-Host ('      read config.json - prefix "' + $prefix + '", daily run at ' + $dailyAt)
#PS#   } catch {
#PS#     Write-Host '      WARNING - config.json is unreadable; using the shipped defaults.'
#PS#   }
#PS# } else {
#PS#   Write-Host '      no config.json yet - using the shipped defaults. Re-run this after setup.'
#PS# }
#PS#
#PS# $daily = Join-Path $Repo 'scripts\run-daily.cmd'
#PS# $dmjs  = Join-Path $Repo 'scripts\run-daily.mjs'
#PS# $pipe  = Join-Path $Repo 'src\pipeline.mjs'
#PS# $vbs   = Join-Path $Repo 'scripts\stale-check.vbs'
#PS# $mjs   = Join-Path $Repo 'src\stale-check.mjs'
#PS# $avbs  = Join-Path $Repo 'scripts\auth-retry.vbs'
#PS# $amjs  = Join-Path $Repo 'src\auth-retry.mjs'
#PS#
#PS# # A task pointing at a script that is not there is worse than no task: it
#PS# # fails silently, looks installed, and schtasks will never tell you. The two
#PS# # .cmd wrappers are what a task EXECUTES; the four .mjs files are what they go
#PS# # on to run, and a missing one of those fails just as quietly one layer down.
#PS# Write-Host '[1/7] Checking that every target exists ...'
#PS# foreach ($f in @($daily, $dmjs, $pipe, $vbs, $mjs, $avbs, $amjs)) {
#PS#   if (-not (Test-Path -LiteralPath $f)) { Write-Host ('      FAILED - missing ' + $f); exit 1 }
#PS#   Write-Host ('      OK   ' + $f)
#PS# }
#PS#
#PS# $principal = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Limited
#PS#
#PS# function Assert-Task([string]$Name, $Action, $Triggers, $Settings, [string]$Desc) {
#PS#   $t = New-ScheduledTask -Action $Action -Trigger $Triggers -Settings $Settings -Principal $script:principal -Description $Desc
#PS#   try {
#PS#     Register-ScheduledTask -TaskName $Name -InputObject $t -Force | Out-Null
#PS#     Write-Host ('      OK - "' + $Name + '" registered.')
#PS#     return $true
#PS#   } catch {
#PS#     Write-Host ('      FAILED - "' + $Name + '" : ' + $_.Exception.Message)
#PS#     return $false
#PS#   }
#PS# }
#PS#
#PS# $ok = $true
#PS#
#PS# # ---- the three tasks 1.x left behind ------------------------------------
#PS# # Morning, Evening and Sync each handed a whole run to a language model, and
#PS# # each pointed at a launcher 2.0.0 deleted. Leaving one registered costs a
#PS# # failed task every day; deleting one nobody asked about is an installer
#PS# # reaching outside its brief. So: report always, delete only when asked.
#PS# Write-Host '[2/7] Looking for the retired 1.x tasks ...'
#PS# $legacy = @(($prefix + ' Morning'), ($prefix + ' Evening'), ($prefix + ' Sync'))
#PS# $found = @()
#PS# foreach ($name in $legacy) {
#PS#   $t = $null
#PS#   try { $t = Get-ScheduledTask -TaskName $name -ErrorAction Stop } catch { $t = $null }
#PS#   if ($t) { $found += $name }
#PS# }
#PS# if ($found.Count -eq 0) {
#PS#   Write-Host '      none registered - nothing to tidy.'
#PS# } elseif ($RemoveLegacy -eq 1) {
#PS#   foreach ($name in $found) {
#PS#     try {
#PS#       Unregister-ScheduledTask -TaskName $name -Confirm:$false
#PS#       Write-Host ('      REMOVED "' + $name + '" - retired in 2.0.0.')
#PS#     } catch {
#PS#       Write-Host ('      FAILED to remove "' + $name + '" : ' + $_.Exception.Message)
#PS#       $ok = $false
#PS#     }
#PS#   }
#PS# } else {
#PS#   foreach ($name in $found) {
#PS#     Write-Host ('      NOTICE "' + $name + '" is a 1.x task. It is retired in 2.0.0 and its')
#PS#     Write-Host '             launcher no longer exists, so it fails every time it fires.'
#PS#   }
#PS#   Write-Host '      Left alone. Run  install-tasks.cmd /remove-legacy  to delete them.'
#PS# }
#PS#
#PS# # ---- the daily run ------------------------------------------------------
#PS# # StartWhenAvailable is the important one: without it a run missed because
#PS# # the laptop was closed is simply lost, and the user gets no digest that day
#PS# # with nothing to show why.
#PS# #
#PS# # ExecutionTimeLimit 2h: a wedged run must not hold the slot for days while
#PS# # MultipleInstances=IgnoreNew silently drops every run behind it. The run
#PS# # finishes well inside two hours, and run-daily.mjs caps the model window
#PS# # itself at llm.timeoutMinutes.
#PS# #
#PS# # Restart 3x/10min covers the transient case - the network is not up yet
#PS# # after a resume. WakeToRun is TRUE here and FALSE on both watchdogs: the
#PS# # one run of the day is worth waking a sleeping laptop for, a check is not.
#PS# Write-Host '[3/7] Registering the daily run ...'
#PS# $dailySettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
#PS# $dailySettings.WakeToRun = $true
#PS# $dailyAction = New-ScheduledTaskAction -Execute $daily -WorkingDirectory $Repo
#PS# $tDailyRun = New-ScheduledTaskTrigger -Daily -At $dailyAt
#PS# $d = 'Weekly agenda daily run. Runs scripts\run-daily.cmd: phase 1 fetches and ingests, one model window reads runbooks\daily-agent.md, phase 2 renders and publishes, and the run log gets one line. Sends at most one digest and at most one push.'
#PS# if (-not (Assert-Task ($prefix + ' Daily') $dailyAction @($tDailyRun) $dailySettings $d)) { $ok = $false }
#PS#
#PS# # ---- the stale-run watchdog --------------------------------------------
#PS# Write-Host '[4/7] Registering the stale-run watchdog ...'
#PS# $wAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"{0}"' -f $vbs) -WorkingDirectory $Repo
#PS#
#PS# # 1. logon - cold boot / sign-in.
#PS# $tLogon = New-ScheduledTaskTrigger -AtLogOn -User $Me
#PS#
#PS# # 2. workstation unlock. StateChange 8 = session unlock (7 is lock, and
#PS# #    firing on lock would be exactly backwards: the user just left).
#PS# $tUnlock = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger -Namespace $Ns) -ClientOnly
#PS# $tUnlock.Enabled = $true
#PS# $tUnlock.StateChange = 8
#PS# $tUnlock.UserId = $Me
#PS#
#PS# # 3. resume from sleep. The power-troubleshooter record in the System log is
#PS# #    the "returned from a low power state" event, and it lands after the
#PS# #    machine is actually usable - which is the whole point. It also covers
#PS# #    the case trigger 2 misses: a lid opened on a session never locked.
#PS# $sub = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
#PS# $tResume = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace $Ns) -ClientOnly
#PS# $tResume.Enabled = $true
#PS# $tResume.Subscription = $sub
#PS#
#PS# # 4. the floor: daily at 00:05, repeating every 30 min for 24 h. PowerShell
#PS# #    cannot put a repetition on a Daily trigger directly, so the Repetition
#PS# #    object is borrowed from a throwaway Once trigger. A Once trigger on its
#PS# #    own would NOT do: its 24 h window expires and never reopens, so the
#PS# #    watchdog would quietly stop after one day.
#PS# $tDaily = New-ScheduledTaskTrigger -Daily -At '00:05'
#PS# $tDaily.Repetition = (New-ScheduledTaskTrigger -Once -At '00:05' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 24)).Repetition
#PS# $tDaily.Repetition.StopAtDurationEnd = $false
#PS#
#PS# # WakeToRun FALSE: the whole point is to catch up when the user comes back.
#PS# # Waking a sleeping laptop to ask "did anything get missed" is the opposite
#PS# # of that. IgnoreNew because logon + unlock + resume can all land within one
#PS# # second. Five minutes of execution limit on milliseconds of work means
#PS# # "wedged".
#PS# $wSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
#PS# $wSettings.WakeToRun = $false
#PS# $d = 'Weekly agenda stale-run watchdog. Runs src\stale-check.mjs on logon, on unlock, on resume from sleep and every 30 min; if the day''s run was missed it starts the existing Daily task through the scheduler. Never runs a launcher directly and never touches the other tasks.'
#PS# if (-not (Assert-Task ($prefix + ' StaleCheck') $wAction @($tLogon, $tUnlock, $tResume, $tDaily) $wSettings $d)) { $ok = $false }
#PS#
#PS# # ---- the hourly auth lane -----------------------------------------------
#PS# # The stale-run watchdog asks "did the run happen?". This one asks "can we
#PS# # still log in?" - a genuinely different question, because a run that fired
#PS# # on time and then died on an expired session DID happen.
#PS# Write-Host '[5/7] Registering the hourly auth lane ...'
#PS# $aAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"{0}"' -f $avbs) -WorkingDirectory $Repo
#PS#
#PS# # The same first three triggers as the watchdog above, rebuilt rather than
#PS# # shared: a CIM instance handed to two registrations is a subtle way to end
#PS# # up with one task quietly missing a trigger.
#PS# $aLogon = New-ScheduledTaskTrigger -AtLogOn -User $Me
#PS# $aUnlock = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger -Namespace $Ns) -ClientOnly
#PS# $aUnlock.Enabled = $true
#PS# $aUnlock.StateChange = 8
#PS# $aUnlock.UserId = $Me
#PS# $aResume = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace $Ns) -ClientOnly
#PS# $aResume.Enabled = $true
#PS# $aResume.Subscription = $sub
#PS#
#PS# # 00:04, not 00:05: the auth lane and the stale-run watchdog must not tick in
#PS# # lockstep. Hourly for 24 h, borrowing a Repetition from a throwaway Once
#PS# # trigger for the same reason the watchdog does.
#PS# $aDaily = New-ScheduledTaskTrigger -Daily -At '00:04'
#PS# $aDaily.Repetition = (New-ScheduledTaskTrigger -Once -At '00:04' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 24)).Repetition
#PS# $aDaily.Repetition.StopAtDurationEnd = $false
#PS#
#PS# # WakeToRun FALSE, and here it is not merely polite: firing a two-factor
#PS# # prompt at a sleeping user's phone is the original failure with extra steps.
#PS# # The prompt is only answerable when somebody is awake, which is what the
#PS# # logon/unlock/resume triggers are for. IgnoreNew because those three plus
#PS# # the hourly tick can all land within one second. Fifteen minutes of
#PS# # execution limit because a real fire waits on a real login; src\auth-retry.mjs
#PS# # caps its own child at seven.
#PS# $aSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
#PS# $aSettings.WakeToRun = $false
#PS# $d = 'Weekly agenda auth watchdog. Runs src\auth-retry.mjs on logon, on unlock, on resume from sleep and every hour. When the LMS session is broken AND nothing has repaired it, it runs scripts\reauth.mjs --silent once and relays any number-matching prompt. Stops permanently on rejected credentials (data\auth-locked.json).'
#PS# if (-not (Assert-Task ($prefix + ' AuthRetry') $aAction @($aLogon, $aUnlock, $aResume, $aDaily) $aSettings $d)) { $ok = $false }
#PS#
#PS# # ---- verify -------------------------------------------------------------
#PS# # Every one of the three, not just the watchdogs: a Daily task registered
#PS# # without StartWhenAvailable loses a run to a closed lid and says nothing,
#PS# # which is the exact failure this repository has a watchdog for.
#PS# Write-Host '[6/7] Verifying all three tasks'' triggers and settings ...'
#PS# $wantTriggers = @{}
#PS# $wantTriggers[($prefix + ' Daily')]      = @('MSFT_TaskDailyTrigger')
#PS# $wantTriggers[($prefix + ' StaleCheck')] = @('MSFT_TaskLogonTrigger','MSFT_TaskSessionStateChangeTrigger','MSFT_TaskEventTrigger','MSFT_TaskDailyTrigger')
#PS# $wantTriggers[($prefix + ' AuthRetry')]  = @('MSFT_TaskLogonTrigger','MSFT_TaskSessionStateChangeTrigger','MSFT_TaskEventTrigger','MSFT_TaskDailyTrigger')
#PS# $wantWake = @{}
#PS# $wantWake[($prefix + ' Daily')]      = $true
#PS# $wantWake[($prefix + ' StaleCheck')] = $false
#PS# $wantWake[($prefix + ' AuthRetry')]  = $false
#PS# foreach ($name in @(($prefix + ' Daily'), ($prefix + ' StaleCheck'), ($prefix + ' AuthRetry'))) {
#PS#   Write-Host ('      ' + $name)
#PS#   $t = $null
#PS#   try { $t = Get-ScheduledTask -TaskName $name -ErrorAction Stop } catch { $t = $null }
#PS#   if (-not $t) { Write-Host '        MISSING - it is not registered at all'; $ok = $false; continue }
#PS#   $kinds = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
#PS#   foreach ($w in $wantTriggers[$name]) {
#PS#     if ($kinds -contains $w) { Write-Host ('        OK      ' + $w) }
#PS#     else { Write-Host ('        MISSING ' + $w); $ok = $false }
#PS#   }
#PS#   $s = $t.Settings
#PS#   if ($s.StartWhenAvailable -ne $true)        { Write-Host '        WRONG StartWhenAvailable'; $ok = $false }
#PS#   if ($s.WakeToRun -ne $wantWake[$name])      { Write-Host '        WRONG WakeToRun'; $ok = $false }
#PS#   if ($s.MultipleInstances -ne 'IgnoreNew')   { Write-Host '        WRONG MultipleInstances'; $ok = $false }
#PS#   if ($s.DisallowStartIfOnBatteries)          { Write-Host '        WRONG DisallowStartIfOnBatteries'; $ok = $false }
#PS# }
#PS#
#PS# # A lockout survives re-registration, and it MUST look like it did. Deleting
#PS# # that file restarts hourly attempts against a password the school already
#PS# # rejected, which is how a stale agenda becomes a locked account.
#PS# $lockFile = Join-Path $Repo 'data\auth-locked.json'
#PS# if (Test-Path -LiteralPath $lockFile) {
#PS#   Write-Host ''
#PS#   Write-Host '  !! THE AUTH LANE IS LOCKED OUT and re-registering did NOT change that.'
#PS#   Write-Host ('     ' + $lockFile + ' exists, which means the school rejected the stored')
#PS#   Write-Host '     password. The lane will not fire until a human fixes the credentials:'
#PS#   Write-Host '       node scripts/reauth.mjs --setup'
#PS#   Write-Host '       node src/auth-retry.mjs --clear-lock'
#PS#   Write-Host '     Do NOT simply delete that file. Retrying a rejected password locks accounts.'
#PS# }
#PS#
#PS# Write-Host ''
#PS# Write-Host '[7/7] Current state (read-only; nothing was started) ==='
#PS# Get-ScheduledTask | Where-Object { $_.TaskName -like ($prefix + '*') } | Sort-Object TaskName | ForEach-Object {
#PS#   $i = Get-ScheduledTaskInfo -TaskName $_.TaskName
#PS#   '{0,-24} state={1,-8} triggers={2} last={3} next={4}' -f $_.TaskName, $_.State, $_.Triggers.Count, $i.LastRunTime, $i.NextRunTime
#PS# }
#PS#
#PS# Write-Host ''
#PS# Write-Host 'Tip: the Task Scheduler operational log is off by default on Windows Home.'
#PS# Write-Host 'With it off there is no record of WHY a task did not fire - only that it did'
#PS# Write-Host 'not. To turn it on permanently (it is a bounded ring buffer, so it cannot grow'
#PS# Write-Host 'without limit), run this ONCE in an elevated terminal:'
#PS# Write-Host '  wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true'
#PS#
#PS# if (-not $ok) { exit 1 }
#PS# exit 0
