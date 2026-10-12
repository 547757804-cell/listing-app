$ErrorActionPreference = 'Stop'
$ProjectRoot = $env:BOL_AUTO_ROOT
$DataLeaf = 'BOL' + [char]0x6570 + [char]0x636e
$AcceptanceLeaf = [string][char]0x9a8c + [char]0x6536 + 'E2E'
$ExpectedDataRoot = Join-Path $ProjectRoot $DataLeaf
$DataRoot = $ExpectedDataRoot
$AuditRoot = Join-Path $ExpectedDataRoot 'logs'
$Node = Join-Path $ProjectRoot '_runtime\bin\node.exe'
$SmokeScript = Join-Path $ProjectRoot 'infra\bol_desktop_cache_smoke.mjs'
$OriginalWorkingDirectory = (Get-Location).Path
. (Join-Path $ProjectRoot 'infra\runtime_health_core.ps1')
. (Join-Path $ProjectRoot 'infra\runtime_preflight.ps1')

function Normalize-WindowsPath([string]$Value) {
  $normalizedUnicode = $Value.Normalize([System.Text.NormalizationForm]::FormC)
  $full = [System.IO.Path]::GetFullPath($normalizedUnicode)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char[]]@([char]92,[char]47)) }
  return $full
}

function Write-LauncherAudit([System.Collections.IDictionary]$Record) {
  New-Item -ItemType Directory -Path $AuditRoot -Force | Out-Null
  $file = Join-Path $AuditRoot ('bol-desktop-cache-smoke-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.jsonl')
  $Record | ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $file -Encoding UTF8
  return $file
}

try {
  $expectedNormalized = Normalize-WindowsPath $ExpectedDataRoot
  $actualRawPath = $DataRoot
  $actualNormalized = Normalize-WindowsPath $actualRawPath
  $dataRootItem = Get-Item -LiteralPath $actualNormalized -Force -ErrorAction Stop
  $isReparsePoint = [bool]($dataRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  $actualLower = $actualNormalized.ToLowerInvariant()
  $acceptancePath = (Join-Path (Join-Path $ProjectRoot $DataLeaf) $AcceptanceLeaf).ToLowerInvariant()
  $isAcceptanceRoot = $actualLower.StartsWith($acceptancePath,[System.StringComparison]::OrdinalIgnoreCase)
  $isLegacyExternalProjectRoot = ($actualLower -match '(^|\\)legacy_external_project(\\|$)') -or $actualLower -eq 'd:\LEGACY_EXTERNAL_PROJECT_ROOT' -or $actualLower.StartsWith('d:\LEGACY_EXTERNAL_PROJECT_ROOT\')
  $pathMatches = [string]::Equals($expectedNormalized,$actualNormalized,[System.StringComparison]::OrdinalIgnoreCase)
  $pathDiagnostic = [ordered]@{
    expected_formal_data_root = $ExpectedDataRoot
    actual_resolved_data_root = $actualNormalized
    data_root_source = 'launcher_environment'
    original_raw_path = $actualRawPath
    windows_canonical_normalized_path = $actualNormalized
    current_working_directory = $OriginalWorkingDirectory
    has_trailing_separator = $actualRawPath.EndsWith('\') -or $actualRawPath.EndsWith('/')
    has_case_only_difference = ($expectedNormalized -cne $actualNormalized) -and $pathMatches
    is_relative_path = -not [System.IO.Path]::IsPathRooted($actualRawPath)
    is_reparse_point = $isReparsePoint
    unicode_normalization_changes_path = ($actualRawPath.Normalize([Text.NormalizationForm]::FormC) -cne $actualRawPath)
    unicode_nfc_equivalent_to_expected = [string]::Equals($actualRawPath.Normalize([Text.NormalizationForm]::FormC),$ExpectedDataRoot.Normalize([Text.NormalizationForm]::FormC),[System.StringComparison]::OrdinalIgnoreCase)
    is_acceptance_root = $isAcceptanceRoot
    is_legacy_external_project_root = $isLegacyExternalProjectRoot
    matches_formal_root = $pathMatches
  }
  if ($isReparsePoint -or $isAcceptanceRoot -or $isLegacyExternalProjectRoot -or -not $pathMatches) { throw 'FORMAL_DATA_ROOT_MISMATCH' }
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'BUNDLED_NODE_MISSING' }
  if (-not (Test-Path -LiteralPath $SmokeScript -PathType Leaf)) { throw 'SMOKE_SCRIPT_MISSING' }

  $runtimeContext=Get-BolRuntimeContext
  $inJob=[bool]$runtimeContext.job_object_membership
  $userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $codexSandbox = [bool]$runtimeContext.sandbox_indicator
  $ancestorNames = @($runtimeContext.parent_process_chain)
  $fromExplorer = [bool]$runtimeContext.explorer_indicator
  $context = [ordered]@{
    checked_at_utc = [DateTime]::UtcNow.ToString('o')
    launcher_pid = $PID
    launcher_user = $userName
    launcher_in_job_object = [bool]$inJob
    codex_sandbox_marker = [bool]$codexSandbox
    explorer_in_launch_ancestry = [bool]$fromExplorer
    runtime_type = $runtimeContext.runtime_type
    runtime_environment_marker = $env:BOL_RUNTIME_ENVIRONMENT
    parent_process_name = $runtimeContext.parent_process_name
    launch_ancestor_process_names = $ancestorNames
    node_child_job_membership = if ($inJob) { 'INHERITED_RESTRICTED_JOB' } else { 'NOT_IN_RESTRICTED_LAUNCHER_JOB' }
    data_root_diagnostic = $pathDiagnostic
  }
  $contextFile = Join-Path $AuditRoot ('bol-desktop-launch-context-' + [guid]::NewGuid().ToString('N') + '.json')
  New-Item -ItemType Directory -Path $AuditRoot -Force | Out-Null
  $context | ConvertTo-Json -Compress | Set-Content -LiteralPath $contextFile -Encoding UTF8

  if (-not $fromExplorer) { throw 'DESKTOP_EXPLORER_LAUNCH_REQUIRED' }
  if ($inJob -or $codexSandbox) {
    if ($codexSandbox) { throw 'CODEX_SANDBOX_RUNTIME_LIMITATION' }
    throw 'RESTRICTED_JOB_OBJECT'
  }

  . (Join-Path $ProjectRoot 'infra\runtime_network_bootstrap.ps1')
  $proxyConfig = Set-BolRuntimeNetworkEnvironment $ProjectRoot
  $env:BOL_RUNTIME_ENVIRONMENT = 'PRODUCTION_4180'
  $context.runtime_environment_marker = $env:BOL_RUNTIME_ENVIRONMENT
  $preflight = Invoke-BolRuntimePreflight -Instance 'PRODUCTION_4180' -DataRoot $DataRoot -ProfilePath (Join-Path $DataRoot 'browser-profile') -Port 4180
  if ($preflight.status -ne 'PASS') { throw ('PRODUCTION_PREFLIGHT_FAILED:' + ($preflight.failure_codes -join ',')) }

  $env:BOL_API_ENABLED = '1'
  $env:TEMP = Join-Path $DataRoot 'tmp'
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
  $env:BOL_DESKTOP_SMOKE_CONTEXT_FILE = $contextFile
  $env:BOL_DESKTOP_SMOKE_DATA_ROOT = $actualNormalized
  Set-Location -LiteralPath $ProjectRoot
  Write-Host 'Starting the isolated BOL desktop API/cache smoke against the formal data root.' -ForegroundColor Cyan
  & $Node $SmokeScript
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { Write-Host "Smoke finished with sanitized failure code $exitCode." -ForegroundColor Red }
  else { Write-Host 'Smoke completed. Review the sanitized audit record shown above.' -ForegroundColor Green }
  Remove-Item -LiteralPath $contextFile -Force -ErrorAction SilentlyContinue
} catch {
  $safeCode = [string]$_.Exception.Message
  if ($safeCode -notmatch '^[A-Z0-9_:-]{1,80}$') { $safeCode = 'DESKTOP_LAUNCHER_FAILED' }
  try {
    $audit = Write-LauncherAudit ([ordered]@{
      checked_at_utc = [DateTime]::UtcNow.ToString('o')
      phase = 'desktop_preflight'
      status = 'FAIL'
      error_code = $safeCode
      launcher_pid = $PID
      launcher_user = if ($userName) { $userName } else { [System.Security.Principal.WindowsIdentity]::GetCurrent().Name }
      launcher_in_job_object = [bool]$inJob
      codex_sandbox_marker = [bool]$codexSandbox
      explorer_in_launch_ancestry = [bool]$fromExplorer
      launch_ancestor_process_names = @($ancestorNames)
      data_root_diagnostic = $pathDiagnostic
    })
    Write-Host "Desktop preflight failed ($safeCode). Sanitized audit: $audit" -ForegroundColor Red
  } catch { Write-Host "Desktop preflight failed ($safeCode); audit file could not be written." -ForegroundColor Red }
  $exitCode = 2
}

if ($contextFile -and (Test-Path -LiteralPath $contextFile)) { Remove-Item -LiteralPath $contextFile -Force -ErrorAction SilentlyContinue }

Write-Host 'No credentials or token values are displayed. Press Enter to close this window.'
[void](Read-Host)
exit $exitCode
