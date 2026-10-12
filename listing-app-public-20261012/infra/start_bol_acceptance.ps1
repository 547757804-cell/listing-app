[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [ValidateSet('NORMAL')][string]$RuntimeMode='NORMAL',
  [string]$StopAfterStep='LISTING_SOP_17',
  [switch]$AcceptanceHold
)
$ErrorActionPreference='Stop'
if($RuntimeMode -ne 'NORMAL' -or -not $AcceptanceHold -or $StopAfterStep -ne 'LISTING_SOP_17'){
  throw 'ACCEPTANCE_START_REQUIRES_NORMAL_HOLD_SOP17'
}
$supervisor=Join-Path $PSScriptRoot 'acceptance_runtime_supervisor.ps1'
if(-not (Test-Path -LiteralPath $supervisor -PathType Leaf)){throw 'ACCEPTANCE_RUNTIME_SUPERVISOR_MISSING'}
& $supervisor -Mode Start -DataRoot $DataRoot -RuntimeMode NORMAL -StopAfterStep LISTING_SOP_17 -Hold
