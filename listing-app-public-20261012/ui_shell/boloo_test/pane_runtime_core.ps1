param()

if ([string]::IsNullOrWhiteSpace($env:BOL_AUTO_ROOT)) { throw 'BOL_AUTO_ROOT_REQUIRED' }

function Resolve-BolPaneTaskIdentity([object[]]$TaskRows) {
  $rows = @($TaskRows | Where-Object { $null -ne $_ })
  if ($rows.Count -eq 0) { throw 'PANE_TASK_IDENTITY_MISSING' }

  $primaryRows = @($rows | Where-Object {
    [string]::IsNullOrWhiteSpace([string]$_.provider_child_parent_sku) -and
    [string]::Equals([string]$_.sku, [string]$_.master_sku, [StringComparison]::Ordinal)
  })
  if ($primaryRows.Count -ne 1) { throw 'PANE_TASK_PRIMARY_IDENTITY_AMBIGUOUS' }
  $primary = $primaryRows[0]
  if ([string]::IsNullOrWhiteSpace([string]$primary.product_id) -or
      [string]::IsNullOrWhiteSpace([string]$primary.sku) -or
      [string]::IsNullOrWhiteSpace([string]$primary.ean)) {
    throw 'PANE_TASK_PRIMARY_IDENTITY_INCOMPLETE'
  }

  $childRows = @($rows | Where-Object { -not [object]::ReferenceEquals($_, $primary) })
  foreach ($child in $childRows) {
    if ([string]::IsNullOrWhiteSpace([string]$child.provider_child_parent_sku) -or
        -not [string]::Equals([string]$child.provider_child_parent_sku, [string]$primary.sku, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$child.sku, [string]$child.master_sku, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$child.product_id, [string]$primary.product_id, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$child.ean, [string]$primary.ean, [StringComparison]::Ordinal)) {
      throw 'PANE_PROVIDER_CHILD_IDENTITY_MISMATCH'
    }
  }

  return [pscustomobject]@{
    task_identity = $primary
    provider_child_count = $childRows.Count
    provider_child_skus = @($childRows | ForEach-Object { [string]$_.sku })
  }
}

function Get-BolPaneCanonicalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'PANE_PATH_REQUIRED' }
  $full = [IO.Path]::GetFullPath($Path.Normalize([Text.NormalizationForm]::FormC))
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char[]]@([char]92,[char]47)) }
  return $full
}

function Get-BolPaneProfileLeasePath([string]$ProfilePath) {
  $canonical = (Get-BolPaneCanonicalPath $ProfilePath).ToUpperInvariant()
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($canonical)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  $parent = Split-Path -Parent (Get-BolPaneCanonicalPath $ProfilePath)
  $leaseRoot = Join-Path $parent '.boloo-profile-leases'
  return Join-Path $leaseRoot ($hash + '.owner.lock')
}

function Test-BolPaneProfileLeaseAvailable([string]$ProfilePath) {
  $leasePath = Get-BolPaneProfileLeasePath $ProfilePath
  $null = New-Item -ItemType Directory -Path (Split-Path -Parent $leasePath) -Force
  $stream = $null
  try {
    $stream = [IO.File]::Open($leasePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    return [pscustomobject]@{ available = $true; lease_path = $leasePath; error_code = $null }
  } catch [IO.IOException] {
    return [pscustomobject]@{ available = $false; lease_path = $leasePath; error_code = 'WEBVIEW_PROFILE_ALREADY_OWNED' }
  } catch {
    return [pscustomobject]@{ available = $false; lease_path = $leasePath; error_code = 'WEBVIEW_PROFILE_LEASE_UNVERIFIABLE' }
  } finally { if ($stream) { $stream.Dispose() } }
}

function Enter-BolPaneManifestLock([string]$ManifestPath, [int]$TimeoutMilliseconds = 3000) {
  $lockPath = $ManifestPath + '.write-lock'
  $null = New-Item -ItemType Directory -Path (Split-Path -Parent $lockPath) -Force
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    try { return [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { Start-Sleep -Milliseconds 50 }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'PANE_MANIFEST_LOCK_TIMEOUT'
}

function Write-BolPaneManifestAtomic([string]$ManifestPath, [object]$Value) {
  $lock = Enter-BolPaneManifestLock $ManifestPath
  try {
    $tmp = $ManifestPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $json = ConvertTo-Json -InputObject $Value -Depth 12 -Compress
    [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
      try { [IO.File]::Replace($tmp, $ManifestPath, $null, $true) }
      catch { Move-Item -LiteralPath $tmp -Destination $ManifestPath -Force }
    } else { Move-Item -LiteralPath $tmp -Destination $ManifestPath }
  } finally { $lock.Dispose() }
}

function Get-BolPaneProcessIdentity([int]$ProcessId, [string]$ExpectedBinary, [string]$ExpectedProfile, $ExpectedStartedAtUtc) {
  $process = $null
  try { $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop } catch { return [pscustomobject]@{ valid = $false; error_code = 'PANE_PROCESS_IDENTITY_UNAVAILABLE'; process = $null } }
  if (-not $process) { return [pscustomobject]@{ valid = $false; error_code = 'PANE_PROCESS_NOT_FOUND'; process = $null } }
  $pathValid = [string]::Equals((Get-BolPaneCanonicalPath ([string]$process.ExecutablePath)), (Get-BolPaneCanonicalPath $ExpectedBinary), [StringComparison]::OrdinalIgnoreCase)
  $cmd = [string]$process.CommandLine
  $profileNeedle = '--profile\s+"?' + [regex]::Escape((Get-BolPaneCanonicalPath $ExpectedProfile)) + '"?(\s|$)'
  $profileValid = $cmd -match $profileNeedle
  $created = if ($process.CreationDate -is [DateTime]) { $process.CreationDate.ToUniversalTime() } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate).ToUniversalTime() }
  if ($ExpectedStartedAtUtc -is [DateTime]) { $expected = $ExpectedStartedAtUtc.ToUniversalTime() }
  else { $expected = [DateTimeOffset]::Parse([string]$ExpectedStartedAtUtc).UtcDateTime }
  $startValid = [Math]::Abs(($created - $expected).TotalMilliseconds) -lt 1500
  $valid = $pathValid -and $profileValid -and $startValid
  return [pscustomobject]@{
    valid = [bool]$valid
    error_code = if ($valid) { $null } elseif (-not $pathValid) { 'PANE_BINARY_IDENTITY_MISMATCH' } elseif (-not $profileValid) { 'PANE_PROFILE_IDENTITY_MISMATCH' } else { 'PANE_PROCESS_START_TIME_MISMATCH' }
    process = [pscustomobject]@{ pid = [int]$process.ProcessId; parent_pid = [int]$process.ParentProcessId; path = [string]$process.ExecutablePath; command_line = $cmd; started_at_utc = $created.ToString('o') }
  }
}

function Get-BolPaneWebViewProfileOwners([string]$ProfilePath, [object[]]$ProcessRows) {
  $target = Get-BolPaneCanonicalPath $ProfilePath
  $owners = @()
  foreach ($process in @($ProcessRows)) {
    if ([string]$process.Name -notmatch '(?i)^msedgewebview2\.exe$') { continue }
    $cmd = [string]$process.CommandLine
    $match = [regex]::Match($cmd, '(?i)--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
    if (-not $match.Success) {
      $owners += [pscustomobject]@{ pid = [int]$process.ProcessId; profile_path = $null; identity = 'UNKNOWN' }
      continue
    }
    $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    try { $actual = Get-BolPaneCanonicalPath $value } catch { $actual = $null }
    if ($actual -and ($actual.Equals($target, [StringComparison]::OrdinalIgnoreCase) -or $actual.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
      $owners += [pscustomobject]@{ pid = [int]$process.ProcessId; profile_path = $actual; identity = 'MATCH' }
    }
    elseif (-not $actual) { $owners += [pscustomobject]@{ pid = [int]$process.ProcessId; profile_path = $null; identity = 'UNKNOWN' } }
  }
  return $owners
}

function ConvertTo-BolPaneUtc([object]$Value) {
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
  return [DateTimeOffset]::Parse([string]$Value).UtcDateTime
}

function Get-BolPaneHeartbeatObservation([object]$RuntimeHeartbeat, [object]$BridgeHeartbeat, [bool]$BridgeStarted, [DateTime]$NowUtc = [DateTime]::UtcNow, [int]$TtlSeconds = 15) {
  $runtimeAge = $null; $runtimeFresh = $false; $bridgeAge = $null; $bridgeFresh = -not $BridgeStarted
  try { $runtimeAge = [Math]::Max(0, ($NowUtc.ToUniversalTime() - (ConvertTo-BolPaneUtc $RuntimeHeartbeat)).TotalSeconds); $runtimeFresh = $runtimeAge -le $TtlSeconds } catch { }
  if ($BridgeStarted) {
    try { $bridgeAge = [Math]::Max(0, ($NowUtc.ToUniversalTime() - (ConvertTo-BolPaneUtc $BridgeHeartbeat)).TotalSeconds); $bridgeFresh = $bridgeAge -le $TtlSeconds } catch { }
  }
  return [pscustomobject]@{ runtime_age_seconds = $runtimeAge; runtime_fresh = $runtimeFresh; bridge_age_seconds = $bridgeAge; bridge_fresh = $bridgeFresh; ttl_seconds = $TtlSeconds }
}

function New-BolPaneBridgeRequestObject([string]$TaskDataRoot, [ValidateSet('script','navigate')][string]$Operation, [string]$Script, [string]$Url, [string]$RequestId = ([guid]::NewGuid().ToString())) {
  $taskRoot = Get-BolPaneCanonicalPath $TaskDataRoot
  $acceptanceRoot = Get-BolPaneCanonicalPath (Join-Path $env:BOL_AUTO_ROOT 'BOL数据\验收E2E')
  if (-not $taskRoot.StartsWith($acceptanceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'PANE_TASK_DATA_ROOT_OUTSIDE_ACCEPTANCE' }
  $taskItem = Get-Item -LiteralPath $taskRoot -Force -ErrorAction Stop
  if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PANE_TASK_DATA_ROOT_REPARSE_POINT_BLOCKED' }
  $markerPath = Join-Path $taskRoot 'run\runtime-instance.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'PANE_TASK_RUNTIME_MARKER_MISSING' }
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  if ($marker.schema -ne 'bol.runtime.instance.v1' -or $marker.instance_key -ne 'ACCEPTANCE_4181' -or -not (Get-BolPaneCanonicalPath ([string]$marker.data_root)).Equals($taskRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'PANE_TASK_RUNTIME_MARKER_MISMATCH' }
  if ($RequestId -notmatch '^[A-Za-z0-9-]{8,80}$') { throw 'PANE_BRIDGE_REQUEST_ID_INVALID' }
  if ($Operation -eq 'script' -and [string]::IsNullOrWhiteSpace($Script)) { throw 'PANE_BRIDGE_SCRIPT_REQUIRED' }
  if ($Operation -eq 'navigate') {
    $uri = $null
    if (-not [Uri]::TryCreate($Url,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.Host -ne 'app.boloo.co') { throw 'PANE_BRIDGE_NAVIGATION_TARGET_BLOCKED' }
  }
  $responsePath = Join-Path $taskRoot ('integrations\boloo-pane\outbox\response-' + $RequestId + '.json')
  $request = [ordered]@{ schema = 'boloo.pane.bridge-request.v1'; request_id = $RequestId; data_root = $taskRoot; response_path = $responsePath; operation = $Operation }
  if ($Operation -eq 'script') { $request.script = $Script }
  if ($Operation -eq 'navigate') { $request.url = $Url }
  return [pscustomobject]$request
}

function Write-BolPaneBridgeRequest([string]$BridgeRoot, [object]$Request) {
  $root = Get-BolPaneCanonicalPath $BridgeRoot
  $expected = Get-BolPaneCanonicalPath (Join-Path $env:BOL_AUTO_ROOT 'BOL数据\integrations\boloo-pane-bridge')
  if (-not $root.Equals($expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'PANE_SHARED_BRIDGE_ROOT_MISMATCH' }
  $inbox = Join-Path $root 'inbox'
  $null = New-Item -ItemType Directory -Path $inbox -Force
  $target = Join-Path $inbox ($Request.request_id + '.json')
  if (Test-Path -LiteralPath $target) { throw 'PANE_BRIDGE_REQUEST_ALREADY_EXISTS' }
  $temp = $target + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temp,(ConvertTo-Json -InputObject $Request -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $target
  return [pscustomobject]@{ request_id = [string]$Request.request_id; request_path = $target; expected_response_path = [string]$Request.response_path }
}

function Get-BolPaneRuntimeObservation([string]$ManifestPath, [string]$ExpectedBinary, [string]$ExpectedProfile, [int]$HeartbeatTtlSeconds = 15) {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    return [pscustomobject]@{ readiness = 'NOT_READY'; runtime_status = 'MISSING'; error_code = 'PANE_MANIFEST_MISSING'; pid = $null; heartbeat_age_seconds = $null }
  }
  try { $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { return [pscustomobject]@{ readiness = 'NOT_READY'; runtime_status = 'INVALID'; error_code = 'PANE_MANIFEST_INVALID_JSON'; pid = $null; heartbeat_age_seconds = $null } }
  $pidValue = 0; [void][int]::TryParse([string]$manifest.pid, [ref]$pidValue)
  $identity = if ($pidValue -gt 0) { Get-BolPaneProcessIdentity $pidValue $ExpectedBinary $ExpectedProfile $manifest.process_started_at_utc } else { [pscustomobject]@{ valid = $false; error_code = 'PANE_PROCESS_NOT_FOUND'; process = $null } }
  $manifestProfileMatches = $false
  try { $manifestProfileMatches = (Get-BolPaneCanonicalPath ([string]$manifest.profile_path)).Equals((Get-BolPaneCanonicalPath $ExpectedProfile), [StringComparison]::OrdinalIgnoreCase) } catch { }
  $leaseObservation = Test-BolPaneProfileLeaseAvailable $ExpectedProfile
  $profileLeaseHeld = -not $leaseObservation.available -and $leaseObservation.error_code -eq 'WEBVIEW_PROFILE_ALREADY_OWNED'
  $beats = Get-BolPaneHeartbeatObservation $manifest.heartbeat_at_utc $manifest.bridge_worker_heartbeat_at ([bool]$manifest.bridge_worker_started) ([DateTime]::UtcNow) $HeartbeatTtlSeconds
  $heartbeatAge = $beats.runtime_age_seconds; $heartbeatFresh = $beats.runtime_fresh; $bridgeFresh = $beats.bridge_fresh
  $ready = [bool]($identity.valid -and $manifestProfileMatches -and $profileLeaseHeld -and $heartbeatFresh -and $bridgeFresh -and $manifest.runtime_status -eq 'RUNNING' -and $manifest.runtime_ready -eq $true)
  $code = if (-not $identity.valid) { [string]$identity.error_code } elseif (-not $manifestProfileMatches) { 'PANE_PROFILE_MANIFEST_MISMATCH' } elseif (-not $profileLeaseHeld) { if ($leaseObservation.error_code) { [string]$leaseObservation.error_code } else { 'PANE_PROFILE_LEASE_NOT_HELD' } } elseif (-not $heartbeatFresh) { 'PANE_HEARTBEAT_STALE' } elseif (-not $bridgeFresh) { 'PANE_BRIDGE_HEARTBEAT_STALE' } elseif ($manifest.runtime_status -ne 'RUNNING' -or $manifest.runtime_ready -ne $true) { [string]$manifest.last_error_code } else { $null }
  return [pscustomobject]@{ readiness = if ($ready) { 'READY' } else { 'NOT_READY' }; runtime_status = if ($identity.valid -and $manifestProfileMatches -and $profileLeaseHeld -and $heartbeatFresh -and $bridgeFresh) { [string]$manifest.runtime_status } else { 'STALE' }; error_code = $code; pid = $pidValue; process_identity = [bool]$identity.valid; profile_identity = $manifestProfileMatches; profile_lease_held = $profileLeaseHeld; heartbeat_age_seconds = $heartbeatAge; heartbeat_fresh = $heartbeatFresh; bridge_heartbeat_age_seconds = $beats.bridge_age_seconds; bridge_heartbeat_fresh = $bridgeFresh; profile_path = [string]$manifest.profile_path; manifest = $manifest }
}

function Set-BolPaneManifestObservation([string]$ManifestPath, [string]$ExpectedStartedAtUtc, [string]$Status, [string]$ErrorCode) {
  $lock = Enter-BolPaneManifestLock $ManifestPath
  try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    $actualStartedAt = ConvertTo-BolPaneUtc $manifest.process_started_at_utc
    $expectedStartedAt = ConvertTo-BolPaneUtc $ExpectedStartedAtUtc
    if ($actualStartedAt.Ticks -ne $expectedStartedAt.Ticks) { throw 'PANE_MANIFEST_CAS_CONFLICT' }
    $manifest.runtime_status = $Status
    $manifest.last_error_code = $ErrorCode
    $updatedAt = [DateTime]::UtcNow.ToString('o')
    if ($manifest.PSObject.Properties['updated_at_utc']) { $manifest.updated_at_utc = $updatedAt }
    else { $manifest | Add-Member -NotePropertyName updated_at_utc -NotePropertyValue $updatedAt }
    if ($Status -in @('STOPPED','CRASHED','STALE','FAILED')) { $manifest.runtime_ready = $false; $manifest.claimed_readiness = 'NOT_READY' }
    $tmp = $ManifestPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $manifest -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
    try { [IO.File]::Replace($tmp, $ManifestPath, $null, $true) }
    catch { Move-Item -LiteralPath $tmp -Destination $ManifestPath -Force }
  } finally { $lock.Dispose() }
}
