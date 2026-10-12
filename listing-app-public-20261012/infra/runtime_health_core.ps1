function Get-BolRuntimeInstancesConfig([string]$ProjectRoot) {
  $file = Join-Path $ProjectRoot 'infra\bol-runtime-instances.json'
  try { return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'BOL_RUNTIME_INSTANCE_CONFIG_INVALID' }
}

function Test-BolCanonicalPathWithin([string]$Path,[string]$Root,[switch]$AllowEqual) {
  try { $p = Get-BolCanonicalRuntimePath $Path; $r = Get-BolCanonicalRuntimePath $Root }
  catch { return $false }
  if ($AllowEqual -and [string]::Equals($p,$r,[StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $p.StartsWith($r + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}

function Get-BolReadinessFreshness {
  param(
    [string]$Status,
    [string]$CheckedAt,
    [DateTime]$NowUtc = [DateTime]::UtcNow,
    [int]$TtlMinutes = 30,
    [int]$ExpiringWithinMinutes = 5
  )
  $checked = [DateTimeOffset]::MinValue
  if ([string]::IsNullOrWhiteSpace($Status) -or $Status -notin @('PASS','READY')) {
    return [pscustomobject]@{ state='WAITING_DEPENDENCY'; age_seconds=$null; checked_at_utc=$CheckedAt; expires_at_utc=$null; reason='READINESS_NOT_PASS' }
  }
  if (-not [DateTimeOffset]::TryParse($CheckedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$checked)) {
    return [pscustomobject]@{ state='WAITING_DEPENDENCY'; age_seconds=$null; checked_at_utc=$CheckedAt; expires_at_utc=$null; reason='CHECK_TIME_INVALID' }
  }
  $now = [DateTimeOffset]::new($NowUtc.ToUniversalTime())
  $age = ($now - $checked.ToUniversalTime()).TotalSeconds
  if ($age -lt -60) { return [pscustomobject]@{ state='WAITING_DEPENDENCY'; age_seconds=[Math]::Round($age,1); checked_at_utc=$checked.ToUniversalTime().ToString('o'); expires_at_utc=$null; reason='CHECK_TIME_IN_FUTURE' } }
  $expiry = $checked.ToUniversalTime().AddMinutes($TtlMinutes)
  $state = if ($age -ge ($TtlMinutes * 60)) { 'EXPIRED' } elseif ($age -ge (($TtlMinutes-$ExpiringWithinMinutes) * 60)) { 'EXPIRING' } else { 'FRESH' }
  return [pscustomobject]@{ state=$state; age_seconds=[Math]::Max(0,[Math]::Round($age,1)); checked_at_utc=$checked.ToUniversalTime().ToString('o'); expires_at_utc=$expiry.ToString('o'); reason=$state }
}

function Get-BolReadinessProbePlan {
  param(
    [string]$Status,
    [string]$CheckedAt,
    [DateTime]$NowUtc = [DateTime]::UtcNow,
    [int]$FailureCount = 0,
    [string]$LastAttemptAt,
    [int]$TtlMinutes = 30,
    [int]$ExpiringWithinMinutes = 5,
    [int]$BackoffBaseMinutes = 5,
    [int]$BackoffCapMinutes = 360
  )
  $freshness = Get-BolReadinessFreshness -Status $Status -CheckedAt $CheckedAt -NowUtc $NowUtc -TtlMinutes $TtlMinutes -ExpiringWithinMinutes $ExpiringWithinMinutes
  $now = [DateTimeOffset]::new($NowUtc.ToUniversalTime())
  $next = $null
  $due = $false
  $reason = 'NOT_DUE'
  if ($FailureCount -gt 0 -and -not [string]::IsNullOrWhiteSpace($LastAttemptAt)) {
    $last = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($LastAttemptAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$last)) {
      $minutes = [Math]::Min($BackoffCapMinutes,($BackoffBaseMinutes * [Math]::Pow(2,[Math]::Min(20,$FailureCount-1))))
      $next = $last.ToUniversalTime().AddMinutes($minutes)
      if ($now -lt $next) { $reason = 'NETWORK_BACKOFF' }
    }
  }
  if ($reason -ne 'NETWORK_BACKOFF') {
    if ($freshness.state -eq 'EXPIRED') { $due=$true; $reason='READINESS_EXPIRED' }
    elseif ($freshness.state -eq 'WAITING_DEPENDENCY') { $due=$true; $reason='CHECK_REQUIRED' }
  }
  [pscustomobject]@{ probe_due=$due; reason=$reason; next_allowed_at_utc=if($next){$next.ToString('o')}else{$null}; freshness=$freshness }
}

function Get-BolRuntimeTypeLabel([bool]$SandboxMarker,[bool]$ExplorerInAncestry,[bool]$JobContained,[bool]$HasProcessMetadata=$true) {
  if($SandboxMarker){return 'CODEX_SANDBOX'}
  if($ExplorerInAncestry){return 'WINDOWS_DESKTOP_EXPLORER'}
  if($JobContained){return 'JOB_CONTAINED_PROCESS'}
  if($HasProcessMetadata){return 'WINDOWS_PROCESS'}
  return 'UNKNOWN'
}

function Get-BolRuntimeContext {
  param([int]$ProcessId = $PID)
  $name=$null; $parentId=$null; $parentName=$null; $ancestors=@(); $owner=$null; $job=$null; $queryError=$null
  try {
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    $name=[string]$proc.Name; $parentId=[int]$proc.ParentProcessId
    $parent=Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
    if($parent){$parentName=[string]$parent.Name}
    $id=$parentId
    for($i=0;$i -lt 8 -and $id;$i++){
      $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
      if(-not $p){break};$ancestors+=([string]$p.Name);$id=[int]$p.ParentProcessId
    }
    $ownerInfo=Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction SilentlyContinue
    if($ownerInfo.User){$owner=if($ownerInfo.Domain){$ownerInfo.Domain+'\'+$ownerInfo.User}else{$ownerInfo.User}}
  } catch { $queryError='PROCESS_METADATA_UNAVAILABLE' }
  try {
    if(-not ('BolRuntimeContextNative' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BolRuntimeContextNative {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, out bool result);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
}
'@ -ErrorAction Stop | Out-Null
    }
    if($ProcessId -eq $PID){$h=[BolRuntimeContextNative]::GetCurrentProcess()}else{$h=(Get-Process -Id $ProcessId -ErrorAction Stop).Handle}
    $j=$false;if([BolRuntimeContextNative]::IsProcessInJob($h,[IntPtr]::Zero,[ref]$j)){$job=[bool]$j}
  } catch { $job=$null }
  $current=$ProcessId -eq $PID
  $sandbox=$null
  if($current){$sandbox=([System.Security.Principal.WindowsIdentity]::GetCurrent().Name -match 'CodexSandbox') -or ($env:CODEX_SANDBOX -match '^(1|true|yes)$') -or ($env:CODEX_RESTRICTED_PROCESS -match '^(1|true|yes)$')}
  $explorer=$ancestors -contains 'explorer.exe'
  $runtimeType=Get-BolRuntimeTypeLabel -SandboxMarker ([bool]$sandbox) -ExplorerInAncestry ([bool]$explorer) -JobContained ([bool]$job) -HasProcessMetadata ([bool]$name)
  [pscustomobject]@{ user=$owner; process_id=$ProcessId; process_name=$name; parent_process_id=$parentId; parent_process_name=$parentName; parent_process_chain=$ancestors; job_object_membership=$job; sandbox_indicator=$sandbox; sandbox_indicator_source=if($current){'CURRENT_PROCESS_ENVIRONMENT'}else{'NOT_READ_FROM_REMOTE_PROCESS'}; explorer_indicator=[bool]$explorer; runtime_type=$runtimeType; current_process_environment_visible=$current; metadata_error_code=$queryError }
}

function Get-BolInstanceRoots([string]$ProjectRoot) {
  $cfg=Get-BolRuntimeInstancesConfig $ProjectRoot
  $root=Get-BolCanonicalRuntimePath (Join-Path $ProjectRoot $cfg.dataRootLeaf)
  $acceptanceBase=Get-BolCanonicalRuntimePath (Join-Path $root $cfg.acceptanceLeaf)
  [pscustomobject]@{ config=$cfg; formal_root=$root; acceptance_base=$acceptanceBase }
}

function Get-BolLocalRuntimeObservation {
  param(
    [Parameter(Mandatory=$true)][string]$BaseUri,
    [Parameter(Mandatory=$true)][ValidateSet('FORMAL','ACCEPTANCE')][string]$RootKind,
    [Parameter(Mandatory=$true)][string]$FormalRoot,
    [Parameter(Mandatory=$true)][string]$AcceptanceBase
  )
  $uri=$null
  if(-not [Uri]::TryCreate($BaseUri,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1','localhost','::1')) { throw 'LOCAL_HEALTH_TARGET_MUST_BE_LOOPBACK' }
  $dashboard=$null;$readiness=$null;$errorCode=$null;$actual=$null
  try{$dashboard=Invoke-BolDirectLoopbackJson -Uri ([Uri]::new($uri,'/api/dashboard').AbsoluteUri);$actual=Get-BolCanonicalRuntimePath ([string]$dashboard.data_root)}catch{$errorCode='DASHBOARD_UNAVAILABLE'}
  $valid=$false
  if($actual){
    if($RootKind -eq 'FORMAL'){$valid=[string]::Equals($actual,(Get-BolCanonicalRuntimePath $FormalRoot),[StringComparison]::OrdinalIgnoreCase)}
    else{$valid=(Test-BolCanonicalPathWithin $actual $AcceptanceBase) -and -not [string]::Equals($actual,(Get-BolCanonicalRuntimePath $FormalRoot),[StringComparison]::OrdinalIgnoreCase)}
  }
  if($valid){try{$readiness=Invoke-BolDirectLoopbackJson -Uri ([Uri]::new($uri,'/api/integrations/bol/readiness').AbsoluteUri)}catch{$errorCode='READINESS_ENDPOINT_UNAVAILABLE'}}
  [pscustomobject]@{reachable=[bool]$dashboard;data_root=$actual;root_valid=[bool]$valid;dashboard=$dashboard;readiness=$readiness;error_code=$errorCode}
}

function Invoke-BolDirectLoopbackJson {
  param([Parameter(Mandatory=$true)][string]$Uri)
  $target=$null
  if(-not [Uri]::TryCreate($Uri,[UriKind]::Absolute,[ref]$target) -or $target.Scheme -ne 'http' -or $target.Host -notin @('127.0.0.1','localhost','::1')){throw 'LOCAL_HEALTH_TARGET_MUST_BE_LOOPBACK'}
  $request=[Net.HttpWebRequest]::Create($target)
  $request.Proxy=$null
  $request.Timeout=3000
  $request.ReadWriteTimeout=3000
  $response=$null
  try{
    $response=$request.GetResponse()
    $reader=[IO.StreamReader]::new($response.GetResponseStream())
    $body=$reader.ReadToEnd();$reader.Dispose()
    return ($body | ConvertFrom-Json -ErrorAction Stop)
  }finally{if($response){$response.Dispose()}}
}
