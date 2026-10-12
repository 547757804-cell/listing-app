$ErrorActionPreference = 'Stop'
$ProjectRoot = $env:BOL_AUTO_ROOT
$DataLeaf = 'BOL' + [char]0x6570 + [char]0x636e
$DataRoot = Join-Path $ProjectRoot $DataLeaf
$AuditRoot = Join-Path $DataRoot 'logs'
$Node = Join-Path $ProjectRoot '_runtime\bin\node.exe'
$DiagnosticScript = Join-Path $ProjectRoot 'infra\bol_desktop_proxy_env_diagnostic.mjs'
$OriginalWorkingDirectory = (Get-Location).Path
$AncestorNames = @()
$ExplorerInAncestry = $false
$LauncherPid = $PID
$LauncherUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

try {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
  $ancestorId = [uint32]$processInfo.ParentProcessId
  for ($depth = 0; $depth -lt 8 -and $ancestorId; $depth++) {
    $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId=$ancestorId" -ErrorAction SilentlyContinue
    if (-not $ancestor) { break }
    $AncestorNames += [string]$ancestor.Name
    $ancestorId = [uint32]$ancestor.ParentProcessId
  }
  $ExplorerInAncestry = $AncestorNames -contains 'explorer.exe'

  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'BUNDLED_NODE_MISSING' }
  if (-not (Test-Path -LiteralPath $DiagnosticScript -PathType Leaf)) { throw 'DIAGNOSTIC_SCRIPT_MISSING' }
  $ProxyBootstrap = Join-Path $ProjectRoot 'infra\runtime_network_bootstrap.ps1'
  if (-not (Test-Path -LiteralPath $ProxyBootstrap -PathType Leaf)) { throw 'BOL_RUNTIME_NETWORK_BOOTSTRAP_MISSING' }
  . $ProxyBootstrap
  . (Join-Path $ProjectRoot 'infra\runtime_health_core.ps1')
  $proxyConfig = Set-BolRuntimeNetworkEnvironment $ProjectRoot
  $runtimeContext = Get-BolRuntimeContext

  $launcherContext = [ordered]@{
    launcher_pid = $LauncherPid
    launcher_user = $LauncherUser
    launcher_parent_pid = [uint32]$processInfo.ParentProcessId
    launch_ancestor_process_names = $AncestorNames
    explorer_in_launch_ancestry = [bool]$ExplorerInAncestry
    launcher_working_directory = $OriginalWorkingDirectory
    project_proxy_config_enabled = $proxyConfig.enabled
    project_proxy_host = $proxyConfig.https_proxy_host
    project_proxy_port = $proxyConfig.https_proxy_port
    runtime_context = $runtimeContext
  }
  $env:BOL_DESKTOP_PROXY_DIAGNOSTIC_CONTEXT = $launcherContext | ConvertTo-Json -Compress
  Set-Location -LiteralPath $ProjectRoot
  & $Node $DiagnosticScript
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { Write-Host "Read-only proxy environment diagnostic failed (code $exitCode)." -ForegroundColor Red }
  else { Write-Host 'Read-only proxy environment diagnostic completed. Review its independent audit JSON.' -ForegroundColor Green }
} catch {
  $safeCode = [string]$_.Exception.Message
  if ($safeCode -notmatch '^[A-Z0-9_:-]{1,80}$') { $safeCode = 'DESKTOP_PROXY_DIAGNOSTIC_LAUNCH_FAILED' }
  try {
    New-Item -ItemType Directory -Path $AuditRoot -Force | Out-Null
    $auditPath = Join-Path $AuditRoot ('desktop-proxy-env-diagnostic-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
    [ordered]@{
      schema = 'bol.desktop-proxy-env-diagnostic.v1'
      checked_at_utc = [DateTime]::UtcNow.ToString('o')
      status = 'FAIL'
      error_code = $safeCode
      process = @{
        launcher_pid = $LauncherPid
        launcher_user = $LauncherUser
        launch_ancestor_process_names = $AncestorNames
        explorer_in_launch_ancestry = [bool]$ExplorerInAncestry
        launcher_working_directory = $OriginalWorkingDirectory
        runtime_context = if($runtimeContext){$runtimeContext}else{$null}
      }
      network_requests_made = $false
      database_opened = $false
      health_or_readiness_modified = $false
    } | ConvertTo-Json -Compress -Depth 6 | Set-Content -LiteralPath $auditPath -Encoding UTF8
    Write-Host "Read-only diagnostic preflight failed ($safeCode). Audit: $auditPath" -ForegroundColor Red
  } catch { Write-Host "Read-only diagnostic preflight failed ($safeCode); sanitized audit could not be written." -ForegroundColor Red }
  $exitCode = 2
}

Remove-Item Env:\BOL_DESKTOP_PROXY_DIAGNOSTIC_CONTEXT -ErrorAction SilentlyContinue
Write-Host 'No network request, database access, credential read, or readiness update was performed. Press Enter to close.'
[void](Read-Host)
exit $exitCode
