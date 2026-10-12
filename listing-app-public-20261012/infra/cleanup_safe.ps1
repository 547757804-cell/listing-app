[CmdletBinding()]
param([switch]$Apply,[ValidateRange(1,365)][int]$TempAgeDays=7,[ValidateRange(1,3650)][int]$LogAgeDays=30)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DataRoot = Join-Path $ProjectRoot ('BOL' + [char]0x6570 + [char]0x636e)
$TempRoot = Join-Path $DataRoot 'tmp'
$LogsRoot = Join-Path $DataRoot 'logs'
$cutTemp = [DateTime]::UtcNow.AddDays(-$TempAgeDays)
$cutLog = [DateTime]::UtcNow.AddDays(-$LogAgeDays)
$tempFiles = @(Get-ChildItem -LiteralPath $TempRoot -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.tmp','.partial') -and $_.LastWriteTimeUtc -lt $cutTemp })
$logFiles = @(Get-ChildItem -LiteralPath $LogsRoot -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq '.log' -and $_.LastWriteTimeUtc -lt $cutLog -and $_.FullName -notmatch '[\\/]archive[\\/]' })
$actions = [System.Collections.Generic.List[object]]::new()
foreach ($file in $tempFiles) {
  $full = [System.IO.Path]::GetFullPath($file.FullName)
  if (-not $full.StartsWith([System.IO.Path]::GetFullPath($TempRoot)+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary cleanup path escaped the BOL tmp directory.' }
  $actions.Add(@{kind='STALE_TEMP';path=$full;bytes=$file.Length;action=if($Apply){'DELETE'}else{'WOULD_DELETE'}})
  if ($Apply) { Remove-Item -LiteralPath $full -Force }
}
foreach ($file in $logFiles) {
  $full = [System.IO.Path]::GetFullPath($file.FullName)
  if (-not $full.StartsWith([System.IO.Path]::GetFullPath($LogsRoot)+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Log rotation path escaped the BOL logs directory.' }
  $archive = Join-Path (Join-Path $LogsRoot 'archive') ($file.BaseName + '.' + $file.LastWriteTimeUtc.ToString('yyyyMMdd_HHmmss') + '.zip')
  $actions.Add(@{kind='OLD_LOG';path=$full;bytes=$file.Length;action=if($Apply){'ARCHIVE_THEN_DELETE'}else{'WOULD_ARCHIVE'}})
  if ($Apply) {
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $archive) -Force
    Compress-Archive -LiteralPath $full -DestinationPath $archive -CompressionLevel Optimal
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or (Get-Item -LiteralPath $archive).Length -le 0) { throw 'Compressed log archive verification failed; original log retained.' }
    Remove-Item -LiteralPath $full -Force
  }
}
$webview = @{}
foreach ($name in @('browser-profile','webview','webview2')) {
  $p = Join-Path $DataRoot $name
  if (Test-Path -LiteralPath $p) {
    $files = Get-ChildItem -LiteralPath $p -File -Recurse -Force -ErrorAction SilentlyContinue
    $webview[$name] = @{file_count=@($files).Count;bytes=[int64](($files | Measure-Object Length -Sum).Sum);cleanup='MONITOR_ONLY_PROFILE_OR_CACHE_PATH_UNCLASSIFIED'}
  }
}
Write-Output (@{mode=if($Apply){'APPLY'}else{'DRY_RUN'};stale_temp_count=$tempFiles.Count;old_log_count=$logFiles.Count;webview=$webview;actions=@($actions);protected_paths=@('Final','versions','acceptance reports','legacy_external_project')} | ConvertTo-Json -Compress -Depth 8)

