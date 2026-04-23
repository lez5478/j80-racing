# Registers two Windows scheduled tasks that snapshot HKO's hourly text
# wind readings every Saturday and Sunday at 22:00 HKT. Each run downloads
# the past 24 hourly snapshots (--hours=24), guaranteed to include all of
# that day's 07:00–22:00 racing window. Files already on disk are skipped,
# so back-to-back Sat+Sun runs together cover the whole weekend cleanly.
#
# Run from an elevated PowerShell:
#   PowerShell -ExecutionPolicy Bypass -File wind\register-task.ps1
#
# Tasks created: "Sailing-Wind-Sat" and "Sailing-Wind-Sun".
# To remove: Unregister-ScheduledTask -TaskName "Sailing-Wind-Sat" -Confirm:$false
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node).Source
$script = Join-Path $root "wind\fetch-text.js"

function Register-Day([string]$name, [string]$dayOfWeek) {
  $action = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$script`" --hours=24" `
    -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $dayOfWeek -At 10pm
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -Description "Save HKO hourly wind text snapshots for the J/80 racing app." -Force | Out-Null
  Write-Host "Registered: $name (every $dayOfWeek 22:00)"
}

Register-Day "Sailing-Wind-Sat" "Saturday"
Register-Day "Sailing-Wind-Sun" "Sunday"
