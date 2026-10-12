[CmdletBinding()]
param([ValidateRange(1,120)][int]$WaitSeconds = 20)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DataRoot = Join-Path $ProjectRoot ('BOL' + [char]0x6570 + [char]0x636e)
$Launcher = Join-Path $ProjectRoot 'ui_shell\launch_bol.ps1'
$Url = 'http://127.0.0.1:4180/api/dashboard'
function Get-Dashboard { try { return Invoke-RestMethod -Uri $Url -TimeoutSec 2 } catch { return $null } }
$dashboard = Get-Dashboard
if ($dashboard) {
  if ([System.IO.Path]::GetFullPath([string]$dashboard.data_root) -ne [System.IO.Path]::GetFullPath($DataRoot)) { throw 'Port 4180 belongs to another data root; recovery refused.' }
  Write-Output (@{status='READY';recovery='NOT_NEEDED';data_root=$DataRoot} | ConvertTo-Json -Compress)
  exit 0
}
$listen = netstat -ano | Select-String '^\s*TCP\s+127\.0\.0\.1:4180\s+.*LISTENING'
if ($listen) { throw 'Port 4180 is occupied but the BOL dashboard is unavailable; recovery refused to avoid terminating an unknown process.' }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$proc = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$Launcher,'-NoBrowser') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
  Start-Sleep -Milliseconds 500
  $dashboard = Get-Dashboard
  if ($dashboard) {
    if ([System.IO.Path]::GetFullPath([string]$dashboard.data_root) -ne [System.IO.Path]::GetFullPath($DataRoot)) { throw 'A different service claimed port 4180; no process was terminated.' }
    Write-Output (@{status='READY';recovery='RESTARTED_BOL_BACKEND_ONLY';launcher_pid=$proc.Id;data_root=$DataRoot} | ConvertTo-Json -Compress)
    exit 0
  }
} while ([DateTime]::UtcNow -lt $deadline -and -not $proc.HasExited)
throw 'BOL backend did not recover; no forced process termination was attempted.'

