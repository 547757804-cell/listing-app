$ErrorActionPreference = 'Stop'
$ProjectRoot = $env:BOL_AUTO_ROOT
$Node = Join-Path $ProjectRoot '_runtime\bin\node.exe'
$Runner = Join-Path $ProjectRoot 'infra\bol_product_placement_acceptance.mjs'
$userName = $null
$inJob = $false
$codexSandbox = $false
$fromExplorer = $false
$ancestorNames = @()
$exitCode = 2

try {
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'BUNDLED_NODE_MISSING' }
  if (-not (Test-Path -LiteralPath $Runner -PathType Leaf)) { throw 'PLACEMENT_ACCEPTANCE_RUNNER_MISSING' }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BolPlacementJobProbe {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, out bool result);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
}
'@
  if (-not [BolPlacementJobProbe]::IsProcessInJob([BolPlacementJobProbe]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)) {
    throw 'JOB_MEMBERSHIP_CHECK_FAILED'
  }

  $userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $codexSandbox = ($userName -match 'CodexSandbox') -or
    ($env:CODEX_SANDBOX -match '^(1|true|yes)$') -or
    ($env:CODEX_RESTRICTED_PROCESS -match '^(1|true|yes)$')
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
  $ancestorId = $process.ParentProcessId
  for ($depth = 0; $depth -lt 6 -and $ancestorId; $depth++) {
    $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId=$ancestorId" -ErrorAction SilentlyContinue
    if (-not $ancestor) { break }
    $ancestorNames += [string]$ancestor.Name
    $ancestorId = $ancestor.ParentProcessId
  }
  $fromExplorer = $ancestorNames -contains 'explorer.exe'

  Write-Host "Launcher user: $userName; PID: $PID; Explorer ancestry: $fromExplorer; restricted job: $inJob; Codex sandbox: $codexSandbox"
  if (-not $fromExplorer) { throw 'DESKTOP_EXPLORER_LAUNCH_REQUIRED' }
  if ($inJob -or $codexSandbox) { throw 'RESTRICTED_OR_CODEX_SANDBOX_PROCESS' }

  . (Join-Path $ProjectRoot 'infra\runtime_network_bootstrap.ps1')
  $proxyContext = Set-BolRuntimeNetworkEnvironment $ProjectRoot
  Write-Host "Project proxy environment loaded for this process (enabled: $($proxyContext.enabled)); proxy credentials are not displayed."

  $env:BOL_PLACEMENT_LAUNCHER_USER = $userName
  $env:BOL_PLACEMENT_LAUNCHER_PID = [string]$PID
  $env:BOL_PLACEMENT_EXPLORER_LAUNCH = '1'
  Set-Location -LiteralPath $ProjectRoot
  & $Node $Runner
  $exitCode = $LASTEXITCODE
} catch {
  Write-Host "Product Placement acceptance stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'No readiness refresh or Product Placement request was started by this launcher.' -ForegroundColor Yellow
}

$dataLeaf = 'BOL' + [char]0x6570 + [char]0x636e
$acceptanceLeaf = [char]0x9a8c + [char]0x6536 + 'E2E'
$evidenceFile = Join-Path (Join-Path (Join-Path (Join-Path $ProjectRoot $dataLeaf) $acceptanceLeaf) 'competitor-source-20260926') 'product-placement-adapter-acceptance.json'
Write-Host "Evidence file: $evidenceFile"
Write-Host 'No OAuth readiness check, Search Terms, Product List, Offers, or Ratings probe is run by this launcher.'
exit $exitCode
