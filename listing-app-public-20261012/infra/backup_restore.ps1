[CmdletBinding()]
param(
  [ValidateSet('Backup','RestoreDrill')][string]$Mode = 'Backup',
  [string]$BackupPath
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DataLeaf = 'BOL' + [char]0x6570 + [char]0x636e
$RulesLeaf = 'BOL' + [char]0x89c4 + [char]0x5219 + [char]0x53ea + [char]0x8bfb
$TemplateLeaf = 'BOL' + [char]0x6a21 + [char]0x677f
$AcceptanceLeaf = 'BOL' + [char]0x9a8c + [char]0x6536
$AcceptanceDataLeaf = [string][char]0x9a8c + [char]0x6536 + 'E2E'
$DataRoot = Join-Path $ProjectRoot $DataLeaf
$BackupRoot = Join-Path $DataRoot 'backups'
$Node = Join-Path $ProjectRoot '_runtime\bin\node.exe'
$SqliteHelper = Join-Path $PSScriptRoot 'sqlite_backup_verify.mjs'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'BOL private Node runtime is missing.' }
if ($Mode -eq 'RestoreDrill' -and -not $BackupPath) { throw 'RestoreDrill requires -BackupPath.' }

function Copy-Tree([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return }
  $null = New-Item -ItemType Directory -Path $Destination -Force
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  & $robocopy $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw 'A BOL-owned backup tree could not be copied.' }
}
function Snapshot-Sqlite([string]$Source, [string]$Destination) {
  & $Node $SqliteHelper $Source $Destination | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'A SQLite online backup or integrity check failed.' }
}

if ($Mode -eq 'Backup') {
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd_HHmmss_fff')
  $target = Join-Path $BackupRoot $stamp
  $payload = Join-Path $target 'payload'
  $null = New-Item -ItemType Directory -Path $payload -Force
  $manifest = [ordered]@{
    schema_version = 1
    created_at_utc = [DateTime]::UtcNow.ToString('o')
    source_root = $ProjectRoot
    backup_scope = 'BOL project only; legacy_external_project excluded'
    exclusions = @("$DataLeaf/tmp","$DataLeaf/browser-profile","$DataLeaf/webview","$DataLeaf/webview2","$DataLeaf/backups",'.env plaintext','legacy_external_project')
    env_protection = 'Windows DPAPI CurrentUser; no plaintext .env in backup'
    databases = [System.Collections.Generic.List[string]]::new()
    files = [System.Collections.Generic.List[object]]::new()
  }

  foreach ($relative in @('app','ui_shell','test','_runtime',$RulesLeaf,$TemplateLeaf)) {
    $src = Join-Path $ProjectRoot $relative
    if (Test-Path -LiteralPath $src -PathType Container) { Copy-Tree $src (Join-Path (Join-Path $payload 'source') $relative) }
  }
  foreach ($file in Get-ChildItem -LiteralPath $ProjectRoot -File -Force | Where-Object { $_.Extension -in @('.cmd','.ps1','.md','.txt') -or $_.Name -eq '.gitignore' }) {
    $dst = Join-Path (Join-Path $payload 'source') $file.Name
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force
    Copy-Item -LiteralPath $file.FullName -Destination $dst -Force
  }
  Copy-Tree (Join-Path $ProjectRoot $AcceptanceLeaf) (Join-Path $payload 'acceptance')

  $skip = @('tmp','browser-profile','webview','webview2','backups')
  foreach ($file in Get-ChildItem -LiteralPath $DataRoot -File -Recurse -Force -ErrorAction SilentlyContinue) {
    $relative = [System.IO.Path]::GetRelativePath($DataRoot, $file.FullName)
    $segments = $relative -split '[\\/]'
    if (@($segments | Where-Object { $_ -in $skip }).Count -gt 0) { continue }
    if ($relative -match '\.sqlite3-(wal|shm)$') { continue }
    $dst = Join-Path (Join-Path $payload 'data') $relative
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force
    if ($file.Name -match '\.sqlite3$') {
      Snapshot-Sqlite $file.FullName $dst
      $manifest.databases.Add($relative)
    } else { Copy-Item -LiteralPath $file.FullName -Destination $dst -Force }
  }

  $envFile = Join-Path $ProjectRoot '.env'
  if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    Add-Type -AssemblyName System.Security
    $clear = [System.IO.File]::ReadAllBytes($envFile)
    try {
      $entropy = [System.Text.Encoding]::UTF8.GetBytes('BOL_AUTO_CONFIG_BACKUP_V1')
      $protected = [System.Security.Cryptography.ProtectedData]::Protect($clear, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      $configDir = Join-Path $payload 'config'
      $null = New-Item -ItemType Directory -Path $configDir -Force
      [System.IO.File]::WriteAllBytes((Join-Path $configDir 'BOL_AUTO.env.dpapi'), $protected)
    } finally { [Array]::Clear($clear, 0, $clear.Length) }
  }
  $providerSecret = Join-Path $DataRoot 'secrets\providers.dpapi.json'
  if (Test-Path -LiteralPath $providerSecret -PathType Leaf) {
    $configDir = Join-Path $payload 'config'
    $null = New-Item -ItemType Directory -Path $configDir -Force
    Copy-Item -LiteralPath $providerSecret -Destination (Join-Path $configDir 'providers.dpapi.json') -Force
  }

  foreach ($file in Get-ChildItem -LiteralPath $payload -File -Recurse -Force) {
    $relative = [System.IO.Path]::GetRelativePath($payload, $file.FullName)
    $manifest.files.Add([ordered]@{ path=$relative; length=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash })
  }
  $manifestPath = Join-Path $target 'manifest.json'
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Write-Output (@{status='BACKUP_PASS';path=$target;files=$manifest.files.Count;databases=$manifest.databases.Count;plaintextEnvCopied=$false} | ConvertTo-Json -Compress)
  exit 0
}

$resolvedBackup = [System.IO.Path]::GetFullPath($BackupPath)
$resolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
if (-not $resolvedBackup.StartsWith($resolvedBackupRoot + [System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Restore source must be inside the BOL backup root.' }
$manifestPath = Join-Path $resolvedBackup 'manifest.json'
$payload = Join-Path $resolvedBackup 'payload'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $payload -PathType Container)) { throw 'Backup manifest or payload is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$acceptanceRoot = Join-Path $DataRoot $AcceptanceDataLeaf
$drillRoot = Join-Path $acceptanceRoot ('infra-restore-drill-' + [DateTime]::UtcNow.ToString('yyyyMMdd_HHmmss_fff'))
if (-not $drillRoot.StartsWith([System.IO.Path]::GetFullPath($acceptanceRoot) + [System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Restore drill path escaped the isolated acceptance root.' }
Copy-Tree $payload $drillRoot
$verified = 0
foreach ($entry in $manifest.files) {
  $file = Join-Path $drillRoot $entry.path
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Restored file missing from isolated drill.' }
  $actual = Get-FileHash -LiteralPath $file -Algorithm SHA256
  if ($actual.Hash -ne $entry.sha256 -or (Get-Item -LiteralPath $file).Length -ne $entry.length) { throw 'Restored file integrity mismatch.' }
  $verified++
}
$dbChecks = 0
foreach ($relative in $manifest.databases) {
  $db = Join-Path (Join-Path $drillRoot 'data') $relative
  & $Node $SqliteHelper $db '--verify-only' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restored SQLite integrity check failed.' }
  $dbChecks++
}
$envRestoreCheck = 'NOT_PRESENT'
$envBackup = Join-Path (Join-Path $drillRoot 'config') 'BOL_AUTO.env.dpapi'
if (Test-Path -LiteralPath $envBackup -PathType Leaf) {
  Add-Type -AssemblyName System.Security
  $protected = [System.IO.File]::ReadAllBytes($envBackup)
  $entropy = [System.Text.Encoding]::UTF8.GetBytes('BOL_AUTO_CONFIG_BACKUP_V1')
  $clear = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $envRestoreCheck = if ($clear.Length -gt 0) { 'DPAPI_UNPROTECT_PASS_MEMORY_ONLY' } else { 'EMPTY' }
  [Array]::Clear($clear, 0, $clear.Length)
}
$drill = [ordered]@{
  status='ISOLATED_RESTORE_PASS'
  completed_at_utc=[DateTime]::UtcNow.ToString('o')
  restored_to=$drillRoot
  verified_files=$verified
  verified_databases=$dbChecks
  env_restore=$envRestoreCheck
  production_data_modified=$false
}
$drill | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $drillRoot 'restore-drill-report.json') -Encoding UTF8
Write-Output ($drill | ConvertTo-Json -Compress)
