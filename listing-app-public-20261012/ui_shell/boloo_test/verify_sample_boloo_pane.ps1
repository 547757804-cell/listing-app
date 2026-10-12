[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$TaskDataRoot,
  [ValidateRange(5,180)][int]$TimeoutSeconds = 80
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:BOL_AUTO_ROOT)) { throw 'BOL_AUTO_ROOT_REQUIRED' }
$ProjectRoot = $env:BOL_AUTO_ROOT
$Verifier = Join-Path $ProjectRoot 'infra\verify_boloo_pane_readiness.ps1'
if (-not (Test-Path -LiteralPath $Verifier -PathType Leaf)) { throw 'OFFICIAL_PANE_VERIFIER_MISSING' }

# Keep this legacy entry point as a compatibility wrapper only. All request
# schema, shared Owner inbox, task response path, and identity checks belong to
# the single generic verifier.
& $Verifier -TaskDataRoot $TaskDataRoot -TimeoutSeconds $TimeoutSeconds
