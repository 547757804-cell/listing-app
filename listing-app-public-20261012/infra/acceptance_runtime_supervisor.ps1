[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Restart','Status','Service')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [ValidateSet('NORMAL')][string]$RuntimeMode='NORMAL',
  [string]$StopAfterStep='LISTING_SOP_17',
  [switch]$Hold,
  [switch]$NoHold,
  [string]$CachedFinalizeSku
)

$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodePath=[IO.Path]::GetFullPath((Join-Path $projectRoot '_runtime\bin\node.exe'))
$serverPath=[IO.Path]::GetFullPath((Join-Path $projectRoot 'app\bol_server.mjs'))
$dataRoot=[IO.Path]::GetFullPath($DataRoot.Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
$run=Join-Path $dataRoot 'run'
$logs=Join-Path $dataRoot 'logs'
$lockPath=Join-Path $run 'acceptance-runtime-lock.json'
$instancePath=Join-Path $run 'runtime-instance.json'
$pidPath=Join-Path $run 'server.pid'
$controlPath=Join-Path $run 'acceptance-supervisor-control.json'
$watcherStatusPath=Join-Path $run 'health-watcher-runtime.json'
$globalCoordinationRoot=Join-Path $projectRoot 'BOL数据\run'
$ownerLeasePath=Join-Path $globalCoordinationRoot 'acceptance-4181-owner.lock'
$supervisorMutexName='Local\BOL_AUTO_ACCEPTANCE_4181_SUPERVISOR'
$expectedStop='LISTING_SOP_17'
$script:acceptanceHoldEnabled=$true
$script:nodeProcess=$null
$script:nodeStartedAt=$null
$script:lockState=$null
$script:runCount=0
$script:stage='BOOT'
$script:watcherProcess=$null
$script:watcherPid=$null
$script:ownerLeaseStream=$null
$script:ownerLeaseToken=$null
$script:serviceMode=$false
$script:serverErrorOffset=0L
$script:effectiveRuntimePolicy=$null
$script:healthFailureCount=0
$script:healthConfirmation='NOT_CHECKED'
$script:healthPollSeconds=2
$script:lastHealthObservation=$null
$script:lastPortObservationStatus='NOT_CHECKED'
$script:qwenCredentialValue=[string]$env:BOL_QWEN_API_KEY
$script:deepseekCredentialValue=[string]$env:BOL_DEEPSEEK_API_KEY
$script:qwenCredentialPresent=[bool]$script:qwenCredentialValue
$script:deepseekCredentialPresent=[bool]$script:deepseekCredentialValue
$script:qwenCredentialValue=[string]$env:BOL_QWEN_API_KEY
$script:deepseekCredentialValue=[string]$env:BOL_DEEPSEEK_API_KEY
$script:qwenCredentialPresent=[bool]$script:qwenCredentialValue
$script:deepseekCredentialPresent=[bool]$script:deepseekCredentialValue
function Resolve-AcceptanceHoldMode([switch]$Hold,[switch]$NoHold) {
  if($Hold.IsPresent -and $NoHold.IsPresent){throw 'ACCEPTANCE_HOLD_MODE_CONFLICT'}
  # Preserve the historical safe default: omission means HOLD.
  return (-not $NoHold.IsPresent)
}
function Assert-AcceptanceNoHoldScope([string]$Root,[string]$ProjectRoot) {
  $canonicalRoot=[IO.Path]::GetFullPath($Root.Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
  $canonicalProject=[IO.Path]::GetFullPath($ProjectRoot.Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
  $acceptanceBase=[IO.Path]::GetFullPath((Join-Path $canonicalProject 'BOL数据\验收E2E').Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
  $formalRoot=[IO.Path]::GetFullPath((Join-Path $canonicalProject 'BOL数据').Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
  $insideAcceptance=[string]::Equals([IO.Path]::GetDirectoryName($canonicalRoot),$acceptanceBase,[StringComparison]::OrdinalIgnoreCase) -or
    $canonicalRoot.StartsWith($acceptanceBase+'\',[StringComparison]::OrdinalIgnoreCase)
  $isFormal=[string]::Equals($canonicalRoot,$formalRoot,[StringComparison]::OrdinalIgnoreCase)
  $isLegacyExternalProject=$canonicalRoot -match '(?i)(^|\\)legacy_external_project(\\|$)|^D:\\LEGACY_EXTERNAL_PROJECT_ROOT(\\|$)'
  if($isLegacyExternalProject){throw 'ACCEPTANCE_NO_HOLD_SCOPE_LEGACY_EXTERNAL_PROJECT_REJECTED'}
  if($isFormal){throw 'ACCEPTANCE_NO_HOLD_SCOPE_PRODUCTION_REJECTED'}
  if(-not $insideAcceptance){throw 'ACCEPTANCE_NO_HOLD_SCOPE_OUTSIDE_ACCEPTANCE_REJECTED'}
  return $true
}

$script:acceptanceHoldEnabled=Resolve-AcceptanceHoldMode -Hold:$Hold -NoHold:$NoHold
if($NoHold -and $Mode -notin @('Start','Service')){throw 'ACCEPTANCE_NO_HOLD_MODE_NOT_ALLOWED'}
if($NoHold){$null=Assert-AcceptanceNoHoldScope $dataRoot $projectRoot}
if($CachedFinalizeSku -and (-not $script:acceptanceHoldEnabled -or $CachedFinalizeSku -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')){throw 'ACCEPTANCE_CACHED_FINALIZE_SCOPE_REJECTED'}

function Write-SupervisorEvent([string]$event,[string]$stage,[string]$code,[string]$errorType=$null,[string]$line=$null,[string]$failureId=$null) {
  try{
    $file=Join-Path $logs 'acceptance-supervisor-lifecycle.jsonl'
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force
    $safeFailureId=if($failureId -match '^[A-Za-z0-9_.:-]{1,160}$'){$failureId}else{$null}
    $record=[ordered]@{timestamp_utc=[DateTime]::UtcNow.ToString('o');event=$event;stage=$stage;error_code=$code;error_type=$errorType;failure_id=$safeFailureId;source_line=$line;supervisor_pid=$PID;instance='ACCEPTANCE_4181';runtime_mode='NORMAL';acceptance_hold=[bool]$script:acceptanceHoldEnabled;acceptance_stop_after_step=$expectedStop}
    [IO.File]::AppendAllText($file,(ConvertTo-Json -InputObject $record -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  }catch{}
}
function Get-SafeFailureCode($record) {
  $message=[string]$record.Exception.Message
  if($message -match '^[A-Z0-9_:-]{1,96}$'){return $message}
  return 'SUPERVISOR_PS_ERROR'
}
function ConvertTo-UtcInstant($value) {
  if($null -eq $value){return $null}
  if($value -is [DateTimeOffset]){return $value.UtcDateTime}
  if($value -is [DateTime]){
    if($value.Kind -eq [DateTimeKind]::Utc){return $value}
    if($value.Kind -eq [DateTimeKind]::Unspecified){return [DateTime]::SpecifyKind($value,[DateTimeKind]::Utc)}
    return $value.ToUniversalTime()
  }
  return ([DateTimeOffset]::Parse([string]$value)).UtcDateTime
}
function Test-SameInstant($left,$right) {
  if($null -eq $left -or $null -eq $right){return $false}
  $a=ConvertTo-UtcInstant $left;$b=ConvertTo-UtcInstant $right
  return ([Math]::Abs(($a-$b).TotalMilliseconds) -lt 1)
}
function Test-StrictProcessIdentityRecord($actual,[int]$expectedPid,$expectedStart,[string]$expectedExe,[string]$commandPattern,[Nullable[int]]$expectedParentPid=$null) {
  if(-not $actual -or [int]$actual.pid -ne $expectedPid -or -not (Test-SameInstant $actual.start_time_utc $expectedStart)){return $false}
  if(-not [string]::Equals([IO.Path]::GetFullPath([string]$actual.executable),[IO.Path]::GetFullPath($expectedExe),[StringComparison]::OrdinalIgnoreCase)){return $false}
  if($commandPattern -and [string]$actual.command_line -notlike $commandPattern){return $false}
  if($null -ne $expectedParentPid -and [int]$actual.parent_pid -ne [int]$expectedParentPid){return $false}
  return $true
}
function Resolve-AcceptancePortObservation([int[]]$netIds,[bool]$netSucceeded,[int[]]$statIds,[bool]$statSucceeded) {
  if(-not $netSucceeded -and -not $statSucceeded){$script:lastPortObservationStatus='PORT_VISIBILITY_INCOMPLETE';throw 'PORT_VISIBILITY_INCOMPLETE'}
  $allIds=@(@($netIds)+@($statIds)|Where-Object{$_ -gt 0}|Select-Object -Unique)
  if($allIds.Count -gt 1){$script:lastPortObservationStatus='PORT_VISIBILITY_INCOMPLETE';throw 'PORT_4181_OWNER_OBSERVATION_CONFLICT'}
  if($allIds.Count -eq 1){
    $script:lastPortObservationStatus='PORT_OCCUPIED_CONFIRMED'
    return [pscustomobject]@{status=$script:lastPortObservationStatus;owner_pid=[int]$allIds[0];netstat_available=$statSucceeded;get_net_tcp_available=$netSucceeded}
  }
  # A successful host socket-table enumeration is authoritative for an empty
  # result. A second unavailable query must not turn a confirmed free port into
  # PORT_VISIBILITY_INCOMPLETE; bind remains the OS's final arbitration.
  $script:lastPortObservationStatus='PORT_FREE_CONFIRMED'
  return [pscustomobject]@{status=$script:lastPortObservationStatus;owner_pid=0;netstat_available=$statSucceeded;get_net_tcp_available=$netSucceeded}
}
function Resolve-AcceptanceSupervisorOwner($old,$supervisorIdentity,[string]$requestedDataRoot,[int]$observedPort) {
  if(-not $old -or $old.runtime_status -notin @('STARTING','RUNNING','STOPPING','STALE')){return 'START'}
  $oldRoot=[string]$old.data_root
  $rootSame=$false;try{$rootSame=[string]::Equals([IO.Path]::GetFullPath($oldRoot).TrimEnd('\'),[IO.Path]::GetFullPath($requestedDataRoot).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)}catch{}
  if($supervisorIdentity){
    $same=Test-StrictProcessIdentityRecord $supervisorIdentity ([int]$old.supervisor_pid) $old.supervisor_process_start_time_utc ([string]$old.supervisor_executable_path) '*acceptance_runtime_supervisor.ps1*' ([Nullable[int]]$null)
    $same=$same -and ([string]$supervisorIdentity.command_line -like '*-Mode Service*')
    if(-not $same){throw 'ACCEPTANCE_SUPERVISOR_PID_REUSED_OR_IDENTITY_MISMATCH'}
    if(-not $rootSame){throw 'ACCEPTANCE_SUPERVISOR_ROOT_MISMATCH'}
    return 'VERIFY_EXISTING'
  }
  if($observedPort -ne 0){throw 'PORT_OWNER_PRESENT_SUPERVISOR_IDENTITY_UNAVAILABLE'}
  return 'RECLAIM_STALE'
}
function Assert-OwnerLeaseToken([string]$ExpectedToken,$lockState,$markerState) {
  if($lockState -and $lockState.owner_lease_token -and $lockState.owner_lease_token -ne $ExpectedToken){throw 'RUNTIME_LOCK_CAS_CONFLICT'}
  if($markerState -and $markerState.owner_lease_token -and $markerState.owner_lease_token -ne $ExpectedToken){throw 'RUNTIME_MARKER_CAS_CONFLICT'}
  return $true
}
function Open-AcceptanceOwnerLease([string]$path) {
  try { return [IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
  catch { throw 'ACCEPTANCE_RUNTIME_OWNER_LEASE_HELD' }
}

function Reconcile-StaleRuntimeOwner([string]$requestedDataRoot) {
  $oldLock=$null;$oldMarker=$null
  try{$oldLock=Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
  try{$oldMarker=Get-Content -LiteralPath $instancePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
  if(-not $oldLock -and -not $oldMarker){return}

  $requested=[IO.Path]::GetFullPath($requestedDataRoot).TrimEnd('\')
  foreach($record in @($oldLock,$oldMarker)){
    if(-not $record){continue}
    $recordRoot=$null
    if($record.data_root){try{$recordRoot=[IO.Path]::GetFullPath([string]$record.data_root).TrimEnd('\')}catch{throw 'ACCEPTANCE_STALE_STATE_ROOT_INVALID'}}
    if($recordRoot -and -not [string]::Equals($recordRoot,$requested,[StringComparison]::OrdinalIgnoreCase)){throw 'ACCEPTANCE_STALE_STATE_ROOT_MISMATCH'}
    if($record.instance -and $record.instance -ne 'ACCEPTANCE_4181'){throw 'ACCEPTANCE_STALE_STATE_INSTANCE_MISMATCH'}
    if($record.instance_key -and $record.instance_key -ne 'ACCEPTANCE_4181'){throw 'ACCEPTANCE_STALE_STATE_INSTANCE_MISMATCH'}
  }

  # The exclusive global owner lease and mutex are already held by this
  # supervisor. Still prove the old recorded Node and supervisor identities
  # are gone (or that a PID has been reused by a different process), and that
  # the host port table is observable and free before adopting persisted state.
  $portOwner=Get-ListenerPid
  if($portOwner -ne 0){throw 'ACCEPTANCE_STALE_RECLAIM_PORT_NOT_FREE'}
  if($oldLock){
    $oldNodePid=0;try{$oldNodePid=[int]$oldLock.pid}catch{}
    if($oldNodePid -gt 0){
      $proc=Get-Process -Id $oldNodePid -ErrorAction SilentlyContinue
      if($proc){
        $identity=Get-ProcessIdentity $oldNodePid
        if(-not $identity){throw 'ACCEPTANCE_STALE_NODE_IDENTITY_UNVERIFIED'}
        $same=Test-StrictProcessIdentityRecord $identity $oldNodePid $oldLock.process_start_time_utc $nodePath '*app\bol_server.mjs*' ([Nullable[int]]$oldLock.supervisor_pid)
        if($same){throw 'ACCEPTANCE_OLD_NODE_STILL_ALIVE'}
      }
    }
    $oldSupervisorPid=0;try{$oldSupervisorPid=[int]$oldLock.supervisor_pid}catch{}
    if($oldSupervisorPid -gt 0){
      $proc=Get-Process -Id $oldSupervisorPid -ErrorAction SilentlyContinue
      if($proc){
        $identity=Get-ProcessIdentity $oldSupervisorPid
        if(-not $identity){throw 'ACCEPTANCE_STALE_SUPERVISOR_IDENTITY_UNVERIFIED'}
        $same=Test-StrictProcessIdentityRecord $identity $oldSupervisorPid $oldLock.supervisor_process_start_time_utc ([string]$oldLock.supervisor_executable_path) '*acceptance_runtime_supervisor.ps1*' ([Nullable[int]]$null)
        $same=$same -and ([string]$identity.command_line -like '*-Mode Service*')
        if($same){throw 'ACCEPTANCE_OLD_SUPERVISOR_STILL_ALIVE'}
      }
    }
  }

  $now=[DateTime]::UtcNow.ToString('o')
  if($oldLock){
    $oldLock|Add-Member NoteProperty runtime_status 'STALE' -Force
    $oldLock|Add-Member NoteProperty owner_lease_token $null -Force
    $oldLock|Add-Member NoteProperty stale_reconciled_at_utc $now -Force
    $oldLock|Add-Member NoteProperty last_error_code 'STALE_OWNER_RECLAIMED' -Force
    $oldLock|Add-Member NoteProperty pid $null -Force
    $oldLock|Add-Member NoteProperty supervisor_pid $null -Force
    Write-AtomicJson $lockPath $oldLock
  }
  if($oldMarker){
    $oldMarker|Add-Member NoteProperty status 'STALE' -Force
    $oldMarker|Add-Member NoteProperty owner_lease_token $null -Force
    $oldMarker|Add-Member NoteProperty stale_reconciled_at_utc $now -Force
    $oldMarker|Add-Member NoteProperty last_error_code 'STALE_OWNER_RECLAIMED' -Force
    $oldMarker|Add-Member NoteProperty pid $null -Force
    $oldMarker|Add-Member NoteProperty supervisor_pid $null -Force
    Write-AtomicJson $instancePath $oldMarker
  }
  Write-SupervisorEvent 'STALE_OWNER_RECLAIMED' 'STATE_RECONCILIATION' 'STALE_OWNER_RECLAIMED' $null $null
}

function Write-AtomicJson([string]$path,[object]$value) {
  $parent=Split-Path -Parent $path
  $null=New-Item -ItemType Directory -Path $parent -Force
  $tmp=$path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  $json=ConvertTo-Json -InputObject $value -Depth 12 -Compress
  [IO.File]::WriteAllText($tmp,$json,[Text.UTF8Encoding]::new($false))
  if(Test-Path -LiteralPath $path){
    try{[IO.File]::Replace($tmp,$path,$null,$true)}catch{Move-Item -LiteralPath $tmp -Destination $path -Force}
  }else{Move-Item -LiteralPath $tmp -Destination $path -Force}
}
function Write-State([string]$status,[string]$errorCode=$null,[Nullable[int]]$exitCode=$null) {
  if($script:serviceMode -and (-not $script:ownerLeaseStream -or -not $script:ownerLeaseToken)){throw 'RUNTIME_OWNER_LEASE_REQUIRED'}
  if($script:serviceMode){
    try{$current=Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{$current=$null}
    try{$currentMarker=Get-Content -LiteralPath $instancePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{$currentMarker=$null}
    $null=Assert-OwnerLeaseToken $script:ownerLeaseToken $current $currentMarker
  }
  $now=[DateTime]::UtcNow.ToString('o')
  $previousStatus=[string]$script:lockState.runtime_status
  if($null -eq $exitCode -and $null -ne $script:lastExitCode){$exitCode=[int]$script:lastExitCode}
  $state=[ordered]@{
    schema='bol.acceptance.runtime-lock.v1';runtime_status=$status;supervisor_pid=$PID
    owner_lease_token=$script:ownerLeaseToken
    supervisor_started_at_utc=$script:lockState.supervisor_started_at_utc
    supervisor_process_start_time_utc=$script:lockState.supervisor_process_start_time_utc
    supervisor_executable_path=$script:lockState.supervisor_executable_path
    pid=if($script:nodeProcess -and -not $script:nodeProcess.HasExited){[int]$script:nodeProcess.Id}else{$null}
    process_start_time_utc=$script:nodeStartedAt;executable_path=$nodePath
    command_line_identity=('node.exe app/bol_server.mjs | root='+$projectRoot)
    instance='ACCEPTANCE_4181';port=4181;data_root=$dataRoot;runtime_mode='NORMAL';acceptance_mode=$true;acceptance_hold=[bool]$script:acceptanceHoldEnabled
    acceptance_stop_after_step=$expectedStop;manual_continue_required=$false
    business_dispatch_enabled=(-not $script:acceptanceHoldEnabled);dependency_resume_enabled=(-not $script:acceptanceHoldEnabled)
    background_provider_probe_enabled=(-not $script:acceptanceHoldEnabled);task_auto_mutation_enabled=(-not $script:acceptanceHoldEnabled)
    qwen_credential_present=[bool]$script:qwenCredentialPresent;deepseek_credential_present=[bool]$script:deepseekCredentialPresent
    watcher_pid=$script:watcherPid;watcher_mode='LOCAL_AGGREGATE_ONLY';port_observation_status=$script:lastPortObservationStatus
    checked_at_utc=$now;last_health_at_utc=if($status -eq 'RUNNING'){$now}else{$script:lockState.last_health_at_utc}
    stopped_at_utc=if($status -in @('STOPPED','CRASHED')){$now}else{$null}
    last_error_code=$errorCode;process_exit_code=$exitCode;run_count=$script:runCount
    health_consecutive_failure_count=$script:healthFailureCount;health_confirmation=$script:healthConfirmation
    health_observation=$script:lastHealthObservation;health_poll_seconds=$script:healthPollSeconds
  }
  # The marker is an observation, never a second source of execution policy.
  $observedPolicy=if($status -eq 'RUNNING'){$script:effectiveRuntimePolicy}else{$null}
  $policyKeys=@('runtime_mode','acceptance_mode','acceptance_hold','manual_continue_required','acceptance_cached_finalize_sku','business_dispatch_enabled','dependency_resume_enabled','background_provider_probe_enabled','task_auto_mutation_enabled','watcher_mode','runtime_policy_version','runtime_policy_status')
  if($observedPolicy){foreach($key in $policyKeys){$state[$key]=$observedPolicy.$key}}
  else{
    $state['runtime_policy_status']='NOT_OBSERVED';$state['runtime_policy_version']=$null
    # Non-running markers describe no effective policy; never publish enabled flags.
    foreach($key in @('acceptance_hold','manual_continue_required','business_dispatch_enabled','dependency_resume_enabled','background_provider_probe_enabled','task_auto_mutation_enabled')){$state[$key]=$false}
    $state['watcher_mode']='LOCAL_AGGREGATE_ONLY'
  }
  if($status -eq 'STALE'){
    foreach($key in @('acceptance_hold','manual_continue_required','business_dispatch_enabled','dependency_resume_enabled','background_provider_probe_enabled','task_auto_mutation_enabled')){$state[$key]=$null}
  }
  $state['effective_runtime_policy']=$observedPolicy
  $state['watcher_actual_mode']='LOCAL_AGGREGATE_ONLY'
  $script:lockState=$state
  Write-AtomicJson $lockPath $state
  if($previousStatus -ne $status){Write-SupervisorEvent 'STATE_TRANSITION' $previousStatus $status $null $null}
  $instance=[ordered]@{
    schema='bol.runtime.instance.v1';status=$status;instance_key='ACCEPTANCE_4181';environment_marker='ACCEPTANCE_4181'
    owner_lease_token=$script:ownerLeaseToken
    runtime_mode='NORMAL';acceptance_mode=$true;acceptance_hold=[bool]$script:acceptanceHoldEnabled;acceptance_stop_after_step=$expectedStop
    manual_continue_required=$false;business_dispatch_enabled=(-not $script:acceptanceHoldEnabled);dependency_resume_enabled=(-not $script:acceptanceHoldEnabled)
    background_provider_probe_enabled=(-not $script:acceptanceHoldEnabled);task_auto_mutation_enabled=(-not $script:acceptanceHoldEnabled)
    watcher_mode=if($script:acceptanceHoldEnabled){'LOCAL_AGGREGATE_ONLY'}else{'NORMAL'};watcher_pid=$script:watcherPid;pid=$state.pid;last_pid=if($script:nodeProcess){[int]$script:nodeProcess.Id}else{$script:lockState.last_pid}
    supervisor_pid=$PID;port=4181;data_root=$dataRoot;executable_path=$nodePath;command_line_identity=$state.command_line_identity
    process_started_at_utc=$script:nodeStartedAt;started_at_utc=$script:lockState.supervisor_started_at_utc
    last_health_at_utc=$state.last_health_at_utc;stopped_at_utc=$state.stopped_at_utc;last_error_code=$errorCode;process_exit_code=$exitCode
  }
  foreach($key in $policyKeys){$instance[$key]=$state[$key]}
  $instance['effective_runtime_policy']=$observedPolicy
  $instance['watcher_actual_mode']='LOCAL_AGGREGATE_ONLY'
  foreach($key in @('health_consecutive_failure_count','health_confirmation','health_observation','health_poll_seconds')){$instance[$key]=$state[$key]}
  Write-AtomicJson $instancePath $instance
  $pidValue=if($state.pid){[string]$state.pid}else{$status}
  $tempPid=$pidPath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($tempPid,$pidValue,[Text.Encoding]::ASCII)
  Move-Item -LiteralPath $tempPid -Destination $pidPath -Force
}
function Get-ListenerPid {
  $netIds=@();$netSucceeded=$false;$netError=$null
  try{$rows=@(Get-NetTCPConnection -LocalPort 4181 -State Listen -ErrorAction Stop);$netIds=@($rows|ForEach-Object{[int]$_.OwningProcess}|Select-Object -Unique);$netSucceeded=$true}catch{$netError=$_.Exception.GetType().Name}
  $statIds=@();$statSucceeded=$false;$statError=$null
  try{$lines=@(netstat.exe -ano -p tcp 2>$null|Select-String -Pattern ':4181\s+.*LISTENING\s+(\d+)\s*$');$statIds=@($lines|ForEach-Object{[int]$_.Matches[0].Groups[1].Value}|Select-Object -Unique);$statSucceeded=($LASTEXITCODE -eq 0)}catch{$statError=$_.Exception.GetType().Name}
  try{
    $observation=Resolve-AcceptancePortObservation $netIds $netSucceeded $statIds $statSucceeded
    $script:lastPortObservationStatus=[string]$observation.status
    return [int]$observation.owner_pid
  }catch{
    if(-not $script:lastPortObservationStatus -or $script:lastPortObservationStatus -eq 'NOT_CHECKED'){$script:lastPortObservationStatus='PORT_VISIBILITY_INCOMPLETE'}
    throw
  }
}
function Get-ProcessIdentity([int]$processId) {
  $p=$null;try{$p=Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop}catch{}
  if($p){
    $created=$p.CreationDate
    if($created -is [DateTime]){$createdUtc=$created.ToUniversalTime()}else{$createdUtc=[Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToUniversalTime()}
    return [pscustomobject]@{pid=[int]$p.ProcessId;parent_pid=[int]$p.ParentProcessId;start_time_utc=$createdUtc.ToString('o');executable=[IO.Path]::GetFullPath([string]$p.ExecutablePath);command_line=[string]$p.CommandLine;identity_source='CIM'}
  }
  # PID/name/path alone cannot disambiguate PID reuse or establish ownership.
  # If CIM cannot provide command line and parent identity, fail closed.
  return $null
}
function Get-SupervisorSpawnedNodeIdentity([Diagnostics.Process]$process) {
  if(-not $process){return $null}
  try{
    $process.Refresh()
    if($process.HasExited){return $null}
    $path=[IO.Path]::GetFullPath([string]$process.Path)
    $started=$process.StartTime.ToUniversalTime().ToString('o')
    return [pscustomobject]@{pid=[int]$process.Id;parent_pid=$PID;start_time_utc=$started;executable=$path;command_line=$null;identity_source='SUPERVISOR_CREATED_PROCESS_HANDLE'}
  }catch{return $null}
}
function Get-DirectHealth {
  $request=$null;$response=$null
  $timer=[Diagnostics.Stopwatch]::StartNew()
  try{
    $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:4181/api/health')
    $request.Proxy=$null;$request.Timeout=1800;$request.ReadWriteTimeout=1800;$request.Method='GET'
    $response=$request.GetResponse();$reader=[IO.StreamReader]::new($response.GetResponseStream());$raw=$reader.ReadToEnd();$reader.Dispose()
    [pscustomobject]@{status=[int]$response.StatusCode;body=($raw|ConvertFrom-Json -ErrorAction Stop);error_code=$null;elapsed_ms=$timer.ElapsedMilliseconds;error_type=$null;transport_status=$null}
  }catch{
    $failure=$_.Exception
    while($failure.InnerException -and $failure -isnot [Net.WebException]){$failure=$failure.InnerException}
    $transportStatus=if($failure -is [Net.WebException]){[string]$failure.Status}else{$null}
    # Preserve an explicit INVALID_CONFIG response instead of calling it offline.
    $failedResponse=$failure.Response
    if($failedResponse){
      try{
        $reader=[IO.StreamReader]::new($failedResponse.GetResponseStream());$body=$reader.ReadToEnd()|ConvertFrom-Json;$reader.Dispose()
        return [pscustomobject]@{status=[int]$failedResponse.StatusCode;body=$body;error_code=if($body.status -eq 'INVALID_CONFIG'){'INVALID_CONFIG'}else{'DIRECT_HEALTH_HTTP_ERROR'};elapsed_ms=$timer.ElapsedMilliseconds;error_type=$failure.GetType().Name;transport_status=$transportStatus}
      }catch{}finally{$failedResponse.Dispose()}
    }
    $code=if($response){'DIRECT_HEALTH_BODY_INVALID'}elseif($transportStatus -eq 'Timeout'){'DIRECT_HEALTH_TIMEOUT'}elseif($transportStatus -in @('ConnectFailure','ConnectionClosed','ReceiveFailure','SendFailure','KeepAliveFailure')){'DIRECT_HEALTH_CONNECTION_FAILURE'}else{'DIRECT_HEALTH_UNAVAILABLE'}
    [pscustomobject]@{status=if($response){[int]$response.StatusCode}else{0};body=$null;error_code=$code;elapsed_ms=$timer.ElapsedMilliseconds;error_type=$failure.GetType().Name;transport_status=$transportStatus}
  }finally{if($response){$response.Dispose()}}
}
function Test-NodeIdentity([int]$processId,[string]$startedAt) {
  $identity=Get-ProcessIdentity $processId
  if($identity){return Test-StrictProcessIdentityRecord $identity $processId $startedAt $nodePath '*app\bol_server.mjs*' ([Nullable[int]]$script:lockState.supervisor_pid)}
  # CIM process metadata can be unavailable inside a restricted launcher
  # context. For the child this Supervisor itself created, its retained process
  # handle plus PID/start-time/executable and direct health identity are the
  # authority; never use this fallback to adopt or terminate an external PID.
  if($script:nodeProcess -and [int]$script:nodeProcess.Id -eq $processId){
    $owned=Get-SupervisorSpawnedNodeIdentity $script:nodeProcess
    return $owned -and $owned.pid -eq $processId -and (Test-SameInstant $owned.start_time_utc $startedAt) -and [string]::Equals($owned.executable,$nodePath,[StringComparison]::OrdinalIgnoreCase)
  }
  return $false
}
function Get-NodeBindFailureCode {
  $file=Join-Path $logs 'server.stderr.log'
  if(-not (Test-Path -LiteralPath $file -PathType Leaf)){return $null}
  try{
    $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try{
      if($script:serverErrorOffset -lt $stream.Length){$stream.Position=$script:serverErrorOffset;$reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true,1024,$true);$tail=$reader.ReadToEnd();$reader.Dispose()}else{$tail=''}
    }finally{$stream.Dispose()}
    if($tail -match '\bEADDRINUSE\b'){return 'PORT_BIND_EADDRINUSE_OWNER_UNRESOLVED'}
    if($tail -match '\bEACCES\b'){return 'PORT_BIND_ACCESS_DENIED'}
  }catch{}
  return $null
}
function Test-Health([int]$processId) {
  $script:lastHealthError='RUNTIME_HEALTH_OR_PORT_MISMATCH'
  $script:lastHealthFailureKind='TRANSIENT'
  $listener=Get-ListenerPid
  $script:lastHealthObservation=[ordered]@{checked_at_utc=[DateTime]::UtcNow.ToString('o');expected_pid=$processId;listener_pid=$listener;port_observation_status=$script:lastPortObservationStatus;http_status=$null;elapsed_ms=$null;error_type=$null;transport_status=$null}
  if($listener -ne $processId){
    if($listener -eq 0){$script:lastHealthError='LISTENER_NOT_OBSERVED'}else{$script:lastHealthError='PORT_OWNER_MISMATCH';$script:lastHealthFailureKind='IDENTITY_MISMATCH'}
    return $false
  }
  $health=Get-DirectHealth
  foreach($key in @('elapsed_ms','error_type','transport_status')){$script:lastHealthObservation[$key]=$health.$key}
  $script:lastHealthObservation.http_status=$health.status
  if($health.status -ne 200 -or -not $health.body){
    $script:lastHealthError=if($health.error_code){$health.error_code}else{'DIRECT_HEALTH_RESPONSE_INVALID'}
    if($health.error_code -eq 'INVALID_CONFIG'){$script:lastHealthFailureKind='POLICY_MISMATCH'}
    elseif($health.status -gt 0 -and $health.status -lt 500){$script:lastHealthFailureKind='HEALTH_CONTRACT_MISMATCH'}
    return $false
  }
  $h=$health.body
  # Consume the Server's single effective policy; verify mirrors, do not derive
  # a separate HOLD/NORMAL decision from launcher env or stale marker fields.
  $policy=$h.effective_runtime_policy
  $policyValid=$null -ne $policy -and $policy.runtime_policy_status -eq 'VALID' -and $policy.runtime_policy_version -eq 'BOL_EFFECTIVE_RUNTIME_POLICY_V1'
  foreach($key in @('runtime_mode','acceptance_mode','acceptance_hold','manual_continue_required','business_dispatch_enabled','dependency_resume_enabled','background_provider_probe_enabled','task_auto_mutation_enabled','watcher_mode','runtime_policy_version','runtime_policy_status')){
    if($null -eq $h.$key -or $null -eq $policy.$key -or $h.$key -cne $policy.$key){$policyValid=$false}
  }
  if($h.acceptance_cached_finalize_sku -cne $policy.acceptance_cached_finalize_sku){$policyValid=$false}
  # Independent fail-closed assertion on the safety invariant, not a policy override.
  if($policy.acceptance_hold -and ($policy.business_dispatch_enabled -or $policy.dependency_resume_enabled -or $policy.background_provider_probe_enabled -or $policy.task_auto_mutation_enabled)){$policyValid=$false}
  $rootMatches=$false
  try{$rootMatches=[string]::Equals([IO.Path]::GetFullPath([string]$h.data_root).TrimEnd('\'),$dataRoot,[StringComparison]::OrdinalIgnoreCase)}catch{}
  $identityValid=[int]$h.pid -eq $processId -and $h.instance -eq 'ACCEPTANCE_4181' -and $h.environment_marker -eq 'ACCEPTANCE_4181' -and $rootMatches
  $policyValid=$policyValid -and $h.runtime_mode -eq 'NORMAL' -and $h.acceptance_mode -and $h.acceptance_stop_after_step -eq $expectedStop
  $valid=[bool]($identityValid -and $policyValid)
  if($valid){$script:effectiveRuntimePolicy=$policy;$script:lastHealthError=$null;$script:lastHealthFailureKind=$null}
  else{
    $script:effectiveRuntimePolicy=$null
    if(-not $identityValid){$script:lastHealthError='RUNTIME_HEALTH_IDENTITY_MISMATCH';$script:lastHealthFailureKind='IDENTITY_MISMATCH'}
    else{$script:lastHealthError='INVALID_CONFIG';$script:lastHealthFailureKind='POLICY_MISMATCH'}
  }
  return $valid
}

function Update-HealthConfirmation([bool]$healthy) {
  $previous=$script:healthConfirmation
  if($healthy){
    $script:healthFailureCount=0;$script:healthConfirmation='HEALTHY';$script:healthPollSeconds=2
  }else{
    $script:healthFailureCount++
    if($script:lastHealthFailureKind -ne 'TRANSIENT'){$script:healthConfirmation='CONFIRMED_'+$script:lastHealthFailureKind}
    elseif($script:healthFailureCount -ge 3){$script:healthConfirmation='CONFIRMED_UNAVAILABLE'}
    else{$script:healthConfirmation='PENDING_CONFIRMATION'}
    $script:healthPollSeconds=if($script:healthConfirmation -eq 'PENDING_CONFIRMATION'){2}else{10}
  }
  if($previous -ne $script:healthConfirmation){
    # Strict safe metadata only; no response bodies, headers or exception messages.
    $event=[ordered]@{timestamp_utc=[DateTime]::UtcNow.ToString('o');event='LOCAL_HEALTH_CONFIRMATION';instance='ACCEPTANCE_4181';supervisor_pid=$PID;health_confirmation=$script:healthConfirmation;consecutive_failure_count=$script:healthFailureCount;error_code=$script:lastHealthError;failure_kind=$script:lastHealthFailureKind;observation=$script:lastHealthObservation}
    [IO.File]::AppendAllText((Join-Path $logs 'acceptance-supervisor-lifecycle.jsonl'),(ConvertTo-Json $event -Depth 6 -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  }
}

function Observe-OwnedRuntimeHealth([int]$processId) {
  $healthy=Test-Health $processId
  Update-HealthConfirmation $healthy
  if($healthy){Write-State 'RUNNING'}else{
    # A live, identity-verified Node may own a long-running lease. Never kill,
    # restart, resume or abandon it based on an HTTP health sample. Keep the
    # supervisor/control channel alive and report STALE until local recovery.
    Write-State 'STALE' $script:lastHealthError
  }
}
function Stop-OwnedNode([string]$source) {
  if(-not $script:nodeProcess){return}
  $script:nodeProcess.Refresh()
  if($script:nodeProcess.HasExited){return}
  if(-not (Test-NodeIdentity $script:nodeProcess.Id $script:nodeStartedAt)){throw 'RUNTIME_LOCK_IDENTITY_MISMATCH_REFUSE_STOP'}
  try{
    $req=[Net.HttpWebRequest]::Create('http://127.0.0.1:4181/api/shutdown');$req.Proxy=$null;$req.Timeout=1800;$req.Method='POST';$req.ContentLength=0
    $res=$req.GetResponse();$res.Dispose()
  }catch{}
  if(-not $script:nodeProcess.WaitForExit(10000)){throw 'OWNED_RUNTIME_SHUTDOWN_TIMEOUT'}
  $script:lastExitCode=$script:nodeProcess.ExitCode
}
function Get-LocalWatcherIdentity {
  $watcherState=$null;try{$watcherState=Get-Content -LiteralPath $watcherStatusPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
  $processes=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object{$_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -like '*health_snapshot.ps1*' -and $_.CommandLine -like '*-LocalAggregateOnly*' -and $_.CommandLine -like ('*'+$watcherStatusPath+'*')})
  if($processes.Count -gt 1){throw 'ACCEPTANCE_LOCAL_WATCHER_DUPLICATE_OWNER'}
  if($processes.Count -eq 0){return $null}
  $p=$processes[0]
  if($watcherState -and [int]$watcherState.pid -ne [int]$p.ProcessId){throw 'ACCEPTANCE_LOCAL_WATCHER_STATUS_PID_MISMATCH'}
  if($watcherState -and (-not $watcherState.active -or $watcherState.mode -ne 'LOCAL_AGGREGATE_ONLY')){throw 'ACCEPTANCE_LOCAL_WATCHER_STATUS_NOT_ACTIVE'}
  return [pscustomobject]@{pid=[int]$p.ProcessId;process=Get-Process -Id ([int]$p.ProcessId) -ErrorAction Stop;state=$watcherState;command_line=[string]$p.CommandLine}
}
function Ensure-LocalWatcher {
  $existing=Get-LocalWatcherIdentity
  if($existing){$script:watcherProcess=$existing.process;$script:watcherPid=$existing.pid;return}
  $script:stage='LOCAL_WATCHER_START'
  $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $scriptPath=Join-Path $projectRoot 'infra\health_snapshot.ps1'
  $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$scriptPath+'"'),'-Watch','-IntervalMinutes','1','-LocalAggregateOnly','-WatcherStatusPath',('"'+$watcherStatusPath+'"'))
  $out=Join-Path $logs 'health-watcher.stdout.log';$err=Join-Path $logs 'health-watcher.stderr.log'
  $script:watcherProcess=Start-Process -FilePath $powershell -ArgumentList $args -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $script:watcherPid=[int]$script:watcherProcess.Id
  for($i=0;$i -lt 60;$i++){
    Start-Sleep -Milliseconds 250
    $status=$null;try{$status=Get-Content -LiteralPath $watcherStatusPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
    if($status -and [int]$status.pid -eq $script:watcherPid -and $status.active -and $status.mode -eq 'LOCAL_AGGREGATE_ONLY'){
      $identity=Get-LocalWatcherIdentity
      if($identity -and $identity.pid -eq $script:watcherPid){return}
    }
    $script:watcherProcess.Refresh();if($script:watcherProcess.HasExited){break}
  }
  throw 'ACCEPTANCE_LOCAL_WATCHER_START_FAILED'
}
function Stop-LocalWatcher {
  $identity=Get-LocalWatcherIdentity
  if(-not $identity){$script:watcherPid=$null;return}
  $script:watcherPid=$identity.pid
  Stop-Process -Id $identity.pid -ErrorAction Stop
  try{
    Write-AtomicJson $watcherStatusPath ([ordered]@{schema='bol.health-watcher-runtime.v1';pid=$identity.pid;active=$false;mode='LOCAL_AGGREGATE_ONLY';stopped_at_utc=[DateTime]::UtcNow.ToString('o');stopped_by_supervisor=$PID;error_code=$null})
  }catch{}
  $script:watcherProcess=$null;$script:watcherPid=$null
}
function Start-OwnedNode {
  $script:stage='PORT_OWNER_CHECK'
  $script:runCount++
  $script:nodeProcess=$null;$script:nodeStartedAt=$null
  $script:effectiveRuntimePolicy=$null
  $script:healthFailureCount=0;$script:healthConfirmation='NOT_CHECKED';$script:healthPollSeconds=2
  $portOwner=Get-ListenerPid
  if($portOwner -ne 0){
    if($portOwner -eq -2){throw 'PORT_4181_MULTIPLE_LISTEN_OWNERS'}
    $owner=Get-ProcessIdentity $portOwner
    if(-not $owner -or -not [string]::Equals($owner.executable,$nodePath,[StringComparison]::OrdinalIgnoreCase) -or
      ($owner.command_line -and $owner.command_line -notlike '*app\bol_server.mjs*')) {throw 'PORT_OWNER_EXTERNAL'}
    $oldHealth=Get-DirectHealth
    if($oldHealth.status -ne 200 -or $oldHealth.body.instance -ne 'ACCEPTANCE_4181' -or -not [string]::Equals([IO.Path]::GetFullPath([string]$oldHealth.body.data_root).TrimEnd('\'),$dataRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'PORT_OWNER_IDENTITY_UNVERIFIED'}
    $script:nodeProcess=Get-Process -Id $portOwner -ErrorAction Stop
    $script:nodeStartedAt=$owner.start_time_utc
    Stop-OwnedNode 'SUPERVISOR_REPLACEMENT'
    $script:nodeProcess=$null;$script:nodeStartedAt=$null
    for($i=0;$i -lt 40 -and (Get-ListenerPid) -ne 0;$i++){Start-Sleep -Milliseconds 250}
    if((Get-ListenerPid) -ne 0){throw 'PORT_4181_NOT_RELEASED'}
  }
  $script:lastExitCode=$null
  Write-State 'STARTING'
  $script:stage='BOOTSTRAP_AND_PREFLIGHT'
  . (Join-Path $projectRoot 'infra\runtime_network_bootstrap.ps1')
  . (Join-Path $projectRoot 'infra\runtime_health_core.ps1')
  . (Join-Path $projectRoot 'infra\runtime_preflight.ps1')
  $null=Set-BolRuntimeNetworkEnvironment $projectRoot
    $env:BOL_RUNTIME_ENVIRONMENT='ACCEPTANCE_4181';$env:BOL_ACCEPTANCE_MODE='1'
    $env:BOL_ACCEPTANCE_HOLD=if($script:acceptanceHoldEnabled){'1'}else{'0'}
    $env:BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED='0'
    if($CachedFinalizeSku -and $script:acceptanceHoldEnabled){$env:BOL_ACCEPTANCE_CACHED_FINALIZE_SKU=$CachedFinalizeSku}else{Remove-Item Env:\BOL_ACCEPTANCE_CACHED_FINALIZE_SKU -ErrorAction SilentlyContinue}
  $env:BOL_ACCEPTANCE_DATA_ROOT=$dataRoot;$env:BOL_ACCEPTANCE_PORT='4181';$env:BOL_RUNTIME_MODE='NORMAL';$env:BOL_ACCEPTANCE_STOP_AFTER_STEP=$expectedStop
  $acceptanceProviderConfig=Join-Path $dataRoot 'integrations\runtime-config\ai_provider_config.json'
  if(Test-Path -LiteralPath $acceptanceProviderConfig -PathType Leaf){
    $canonicalProviderConfig=[IO.Path]::GetFullPath($acceptanceProviderConfig)
    $expectedProviderConfig=[IO.Path]::GetFullPath((Join-Path $dataRoot 'integrations\runtime-config\ai_provider_config.json'))
    if(-not [string]::Equals($canonicalProviderConfig,$expectedProviderConfig,[StringComparison]::OrdinalIgnoreCase)){throw 'ACCEPTANCE_PROVIDER_CONFIG_PATH_INVALID'}
    $env:BOL_AI_PROVIDER_CONFIG_PATH=$canonicalProviderConfig
  }else{
    Remove-Item Env:\BOL_AI_PROVIDER_CONFIG_PATH -ErrorAction SilentlyContinue
  }
  $env:BOL_API_READY='false';$env:BOLOO_PROVIDER_READY='false'
  $roots=Get-BolInstanceRoots $projectRoot
  if(-not (Test-BolCanonicalPathWithin $dataRoot $roots.acceptance_base) -or [string]::Equals($dataRoot,$roots.formal_root,[StringComparison]::OrdinalIgnoreCase) -or $dataRoot -match '(?i)(^|\\)legacy_external_project(\\|$)|^D:\\LEGACY_EXTERNAL_PROJECT_ROOT(\\|$)'){throw 'ACCEPTANCE_DATA_ROOT_MISMATCH'}
  $profile=Join-Path $dataRoot $roots.config.profileLeaf
  $preflight=Invoke-BolRuntimePreflight -Instance 'ACCEPTANCE_4181' -DataRoot $dataRoot -ProfilePath $profile -Port 4181
  if($preflight.status -ne 'PASS'){throw 'ACCEPTANCE_PREFLIGHT_FAILED'}
  $qwenLoaded=$script:qwenCredentialPresent;$deepseekLoaded=$script:deepseekCredentialPresent
  if(-not $deepseekLoaded){throw 'DEEPSEEK_SECURE_CREDENTIAL_NOT_LOADED'}
  $env:BOL_PROVIDER_CREDENTIALS_LOADED='1';$env:BOL_PROVIDER_CREDENTIALS_SOURCE='DPAPI_CURRENT_USER'
  $stdout=Join-Path $logs 'server.stdout.log';$stderr=Join-Path $logs 'server.stderr.log'
  $script:serverErrorOffset=if(Test-Path -LiteralPath $stderr -PathType Leaf){(Get-Item -LiteralPath $stderr).Length}else{0L}
  $env:BOL_QWEN_API_KEY=$script:qwenCredentialValue;$env:BOL_DEEPSEEK_API_KEY=$script:deepseekCredentialValue
  $script:stage='NODE_PROCESS_START'
  try{$script:nodeProcess=Start-Process -FilePath $nodePath -ArgumentList @($serverPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr}
  finally{foreach($keyName in @('BOL_QWEN_API_KEY','BOL_DEEPSEEK_API_KEY','BOL_PROVIDER_CREDENTIALS_LOADED','BOL_PROVIDER_CREDENTIALS_SOURCE','BOL_AI_PROVIDER_CONFIG_PATH','BOL_ACCEPTANCE_CACHED_FINALIZE_SKU')){Remove-Item -LiteralPath ("Env:"+$keyName) -ErrorAction SilentlyContinue}}
  $spawnedIdentity=Get-ProcessIdentity $script:nodeProcess.Id
  if(-not $spawnedIdentity){$spawnedIdentity=Get-SupervisorSpawnedNodeIdentity $script:nodeProcess}
  if(-not $spawnedIdentity -or $spawnedIdentity.pid -ne $script:nodeProcess.Id -or
    -not [string]::Equals($spawnedIdentity.executable,$nodePath,[StringComparison]::OrdinalIgnoreCase) -or
    ($spawnedIdentity.command_line -and $spawnedIdentity.command_line -notlike '*app\bol_server.mjs*') -or
    (-not $spawnedIdentity.command_line -and $spawnedIdentity.identity_source -ne 'SUPERVISOR_CREATED_PROCESS_HANDLE')){throw 'SPAWNED_NODE_IDENTITY_INVALID'}
  $script:nodeStartedAt=$spawnedIdentity.start_time_utc
  $script:lockState.qwen_credential_present=$qwenLoaded;$script:lockState.deepseek_credential_present=$deepseekLoaded
  $script:stage='DIRECT_HEALTH_GATE'
  for($i=0;$i -lt 80;$i++){
    Start-Sleep -Milliseconds 250;$script:nodeProcess.Refresh()
    if($script:nodeProcess.HasExited){$bindCode=Get-NodeBindFailureCode;if($bindCode){throw $bindCode};throw 'ACCEPTANCE_SERVER_EXITED_DURING_START'}
    if(Test-Health $script:nodeProcess.Id){break}
  }
  if(-not (Test-Health $script:nodeProcess.Id)){throw 'ACCEPTANCE_HEALTH_GATE_FAILED'}
  Update-HealthConfirmation $true
  Write-State 'RUNNING'
  Ensure-LocalWatcher
  Write-State 'RUNNING'
}
function Read-Control {
  try{$c=Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8|ConvertFrom-Json;Remove-Item -LiteralPath $controlPath -Force;return $c}catch{return $null}
}
function Start-SupervisorService {
  $null=New-Item -ItemType Directory -Path @($run,$logs) -Force
  $null=New-Item -ItemType Directory -Path $globalCoordinationRoot -Force
  $script:ownerLeaseStream=Open-AcceptanceOwnerLease $ownerLeasePath
  $script:ownerLeaseToken=[guid]::NewGuid().ToString('N')
  $script:serviceMode=$true
  $script:ownerLeaseStream.SetLength(0)
  $leaseRecord=[ordered]@{schema='bol.acceptance.runtime-owner-lease.v1';token=$script:ownerLeaseToken;pid=$PID;process_start_time_utc=(Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o');executable_path=[IO.Path]::GetFullPath((Get-Process -Id $PID -ErrorAction Stop).Path);instance='ACCEPTANCE_4181';port=4181;data_root=$dataRoot;acquired_at_utc=[DateTime]::UtcNow.ToString('o')}
  $leaseBytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $leaseRecord -Compress))
  $script:ownerLeaseStream.Write($leaseBytes,0,$leaseBytes.Length);$script:ownerLeaseStream.Flush($true)
  $mutex=[Threading.Mutex]::new($false,$supervisorMutexName)
  if(-not $mutex.WaitOne(0)){$script:ownerLeaseStream.Dispose();$script:ownerLeaseStream=$null;throw 'ACCEPTANCE_SUPERVISOR_ALREADY_OWNED'}
  try{
    Reconcile-StaleRuntimeOwner $dataRoot
    $supervisorProcess=Get-Process -Id $PID -ErrorAction Stop
    $script:lockState=[ordered]@{
      supervisor_pid=$PID;owner_lease_token=$script:ownerLeaseToken
      supervisor_started_at_utc=[DateTime]::UtcNow.ToString('o')
      supervisor_process_start_time_utc=$supervisorProcess.StartTime.ToUniversalTime().ToString('o')
      supervisor_executable_path=[IO.Path]::GetFullPath($supervisorProcess.Path)
      last_health_at_utc=$null;last_pid=$null
    }
    Remove-Item -LiteralPath $controlPath -Force -ErrorAction SilentlyContinue
    try{Start-OwnedNode}catch{
      $code=Get-SafeFailureCode $_
      Write-SupervisorEvent 'START_FAILED' $script:stage $code $_.Exception.GetType().Name ([string]$_.InvocationInfo.ScriptLineNumber) ([string]$_.FullyQualifiedErrorId)
      if($code -in @('PORT_BIND_EADDRINUSE_OWNER_UNRESOLVED','PORT_VISIBILITY_INCOMPLETE','PORT_OWNER_PRESENT_SUPERVISOR_IDENTITY_UNAVAILABLE','PORT_4181_OWNER_OBSERVATION_CONFLICT')){
        # Another session or an unobservable listener may still be the owner.
        # Do not rewrite shared runtime state or stop a watcher on this path.
        throw
      }
      try{Stop-OwnedNode 'START_FAILURE_CLEANUP'}catch{}
      try{Stop-LocalWatcher}catch{}
      Write-State 'CRASHED' $code
      throw
    }
    $restartWindow=[DateTime]::UtcNow.AddMinutes(-10);$unexpectedRestarts=0
    while($true){
      $control=Read-Control
      if($control -and $control.action -in @('STOP','RESTART')){
        Write-State 'STOPPING'
        Stop-OwnedNode 'SUPERVISOR_CONTROL'
        Stop-LocalWatcher
        Write-State 'STOPPED'
        if($control.action -eq 'STOP'){break}
        Start-OwnedNode
      }
      $script:nodeProcess.Refresh()
      if($script:nodeProcess.HasExited){
        $exit=$script:nodeProcess.ExitCode;$script:lastExitCode=$exit;Write-State 'CRASHED' 'NODE_PROCESS_EXITED' $exit
        if(([DateTime]::UtcNow-$restartWindow).TotalMinutes -ge 10){$restartWindow=[DateTime]::UtcNow.AddMinutes(-10);$unexpectedRestarts=0}
        $unexpectedRestarts++
        if($unexpectedRestarts -gt 3){break}
        Start-Sleep -Seconds ([Math]::Min(30,2*[Math]::Pow(2,$unexpectedRestarts-1)))
        try{Start-OwnedNode}catch{$code=Get-SafeFailureCode $_;Write-SupervisorEvent 'RESTART_FAILED' $script:stage $code $_.Exception.GetType().Name ([string]$_.InvocationInfo.ScriptLineNumber) ([string]$_.FullyQualifiedErrorId);try{Stop-OwnedNode 'RESTART_FAILURE_CLEANUP'}catch{};try{Stop-LocalWatcher}catch{};Write-State 'CRASHED' $code;break}
      }elseif(-not (Test-NodeIdentity $script:nodeProcess.Id $script:nodeStartedAt)){
        Write-State 'STALE' 'RUNTIME_IDENTITY_MISMATCH';break
      }else{Observe-OwnedRuntimeHealth $script:nodeProcess.Id}
      Ensure-LocalWatcher
      Start-Sleep -Seconds $script:healthPollSeconds
    }
  }finally{$mutex.ReleaseMutex();$mutex.Dispose();if($script:ownerLeaseStream){$script:ownerLeaseStream.Dispose();$script:ownerLeaseStream=$null}}
}

function Get-ObservedRuntimeState($state) {
  if(-not $state){return $null}
  $persistedStatus=[string]$state.runtime_status
  $observedStatus=$persistedStatus;$observedCode=[string]$state.last_error_code
  if($persistedStatus -eq 'RUNNING'){
    $supIdentity=Get-ProcessIdentity ([int]$state.supervisor_pid)
    $supValid=$false
    if($supIdentity){
    $supValid=(Test-StrictProcessIdentityRecord $supIdentity ([int]$state.supervisor_pid) $state.supervisor_process_start_time_utc ([string]$state.supervisor_executable_path) '*acceptance_runtime_supervisor.ps1*' ([Nullable[int]]$null)) -and
        ([string]$supIdentity.command_line -like '*-Mode Service*') -and ([string]$supIdentity.command_line -like ('*'+$dataRoot+'*'))
    }
    if(-not $supValid){$observedStatus='STALE';$observedCode='SUPERVISOR_IDENTITY_NOT_VERIFIED'}
    else{
      try{$listener=Get-ListenerPid}catch{$listener=-3;$script:lastPortObservationStatus='PORT_VISIBILITY_INCOMPLETE'}
      $nodeIdentity=Get-ProcessIdentity ([int]$state.pid)
      $nodeValid=Test-StrictProcessIdentityRecord $nodeIdentity ([int]$state.pid) $state.process_start_time_utc ([string]$state.executable_path) '*app\bol_server.mjs*' ([Nullable[int]]$state.supervisor_pid)
      $health=Get-DirectHealth
      $healthValid=$health.status -eq 200 -and $health.body -and [int]$health.body.pid -eq [int]$state.pid -and
        $health.body.instance -eq 'ACCEPTANCE_4181' -and $health.body.environment_marker -eq 'ACCEPTANCE_4181' -and
        [string]::Equals([IO.Path]::GetFullPath([string]$health.body.data_root).TrimEnd('\'),$dataRoot,[StringComparison]::OrdinalIgnoreCase)
      $marker=$null;try{$marker=Get-Content -LiteralPath $instancePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
      $markerValid=$marker -and $marker.instance_key -eq 'ACCEPTANCE_4181' -and [int]$marker.pid -eq [int]$state.pid -and
        [string]::Equals([IO.Path]::GetFullPath([string]$marker.data_root).TrimEnd('\'),$dataRoot,[StringComparison]::OrdinalIgnoreCase) -and
        (-not $state.owner_lease_token -or $marker.owner_lease_token -eq $state.owner_lease_token)
      if($listener -ne [int]$state.pid){$observedStatus='STALE';$observedCode=if($listener -eq -3){'PORT_VISIBILITY_INCOMPLETE'}else{'LISTENER_PID_MISMATCH'}}
      elseif(-not $nodeValid){$observedStatus='STALE';$observedCode='NODE_PROCESS_IDENTITY_NOT_VERIFIED'}
      elseif(-not $healthValid){$observedStatus='STALE';$observedCode=if($health.error_code){$health.error_code}else{'DIRECT_HEALTH_IDENTITY_MISMATCH'}}
      elseif(-not $markerValid){$observedStatus='STALE';$observedCode='RUNTIME_MARKER_IDENTITY_MISMATCH'}
    }
  }
  $result=[ordered]@{};foreach($property in $state.PSObject.Properties){$result[$property.Name]=$property.Value}
  $result.persisted_runtime_status=$persistedStatus
  $result.runtime_status=$observedStatus
  $result.port_observation_status=$script:lastPortObservationStatus
  $result.observation_error_code=$observedCode
  $result.observed_at_utc=[DateTime]::UtcNow.ToString('o')
  return [pscustomobject]$result
}

if($Mode -ne 'Service'){
  # Start-Process redirects supervisor output into $logs before Service mode
  # starts. Create both directories here so first boot in a fresh isolated
  # acceptance dataRoot does not fail before the supervisor can initialize.
  $null=New-Item -ItemType Directory -Path @($run,$logs) -Force
  if($Mode -eq 'Status'){
    try{$state=Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{$state=$null}
    Get-ObservedRuntimeState $state|ConvertTo-Json -Depth 12 -Compress
    return
  }
  if($Mode -eq 'Stop' -or $Mode -eq 'Restart'){
    Write-AtomicJson $controlPath ([ordered]@{action=$Mode.ToUpperInvariant();requested_at_utc=[DateTime]::UtcNow.ToString('o')})
    return
  }
  $guardPath=Join-Path $run 'acceptance-supervisor-start.guard'
  $guard=$null
  try{$guard=[IO.File]::Open($guardPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'ACCEPTANCE_SUPERVISOR_START_ALREADY_IN_PROGRESS'}
  try{
    $old=$null;try{$old=Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
    if($old -and $old.runtime_status -in @('STARTING','RUNNING','STOPPING','STALE')){
      $sup=Get-ProcessIdentity ([int]$old.supervisor_pid)
      $observedPort=if($sup){-1}else{Get-ListenerPid}
      $ownerDecision=Resolve-AcceptanceSupervisorOwner $old $sup $dataRoot ([int]$observedPort)
      if($ownerDecision -eq 'VERIFY_EXISTING'){
        $observed=Get-ObservedRuntimeState $old
        if($observed.runtime_status -eq 'RUNNING'){
          [pscustomobject]@{status='ALREADY_RUNNING';supervisor_pid=$old.supervisor_pid;pid=$old.pid;data_root=$old.data_root;observation='LIVE_PROCESS_SOCKET_HEALTH_MARKER_MATCH'}|ConvertTo-Json -Compress;return
        }
        throw ('ACCEPTANCE_SUPERVISOR_RUNTIME_NOT_HEALTHY:'+$observed.observation_error_code)
      }
    }
    $script:stage='DPAPI_CONFIG_LOAD'
    $loader=Join-Path $projectRoot 'app\load_bol_provider_credentials.ps1'
    if(-not (Test-Path -LiteralPath $loader -PathType Leaf)){throw 'BOL_PROVIDER_CREDENTIAL_LOADER_MISSING'}
    try{$null=& $loader}catch{Write-SupervisorEvent 'DPAPI_LOAD_FAILED' $script:stage 'BOL_PROVIDER_CREDENTIAL_LOAD_FAILED' $_.Exception.GetType().Name ([string]$_.InvocationInfo.ScriptLineNumber) ([string]$_.FullyQualifiedErrorId);throw 'BOL_PROVIDER_CREDENTIAL_LOAD_FAILED'}
    $script:qwenCredentialValue=[string]$env:BOL_QWEN_API_KEY
    $script:deepseekCredentialValue=[string]$env:BOL_DEEPSEEK_API_KEY
    $script:qwenCredentialPresent=[bool]$script:qwenCredentialValue
    $script:deepseekCredentialPresent=[bool]$script:deepseekCredentialValue
    if(-not $script:deepseekCredentialPresent){throw 'DEEPSEEK_SECURE_CREDENTIAL_NOT_LOADED'}
    $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $self='"'+$PSCommandPath+'"';$rootArg='"'+$dataRoot+'"'
    $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$self,'-Mode','Service','-DataRoot',$rootArg,'-RuntimeMode','NORMAL','-StopAfterStep',$expectedStop)
    if($CachedFinalizeSku){$args+=@('-CachedFinalizeSku',$CachedFinalizeSku)}
    if($script:acceptanceHoldEnabled){$args+=('-Hold')}else{$args+=('-NoHold')}
    $supervisorOut=Join-Path $logs 'acceptance-supervisor.stdout.log';$supervisorErr=Join-Path $logs 'acceptance-supervisor.stderr.log'
    try{$service=Start-Process -FilePath $powershell -ArgumentList $args -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $supervisorOut -RedirectStandardError $supervisorErr}
    finally{foreach($keyName in @('BOL_QWEN_API_KEY','BOL_DEEPSEEK_API_KEY','BOL_PROVIDER_CREDENTIALS_LOADED','BOL_PROVIDER_CREDENTIALS_SOURCE')){Remove-Item -LiteralPath ("Env:"+$keyName) -ErrorAction SilentlyContinue}}
    $deadline=[DateTime]::UtcNow.AddSeconds(45);$state=$null
    do{
      Start-Sleep -Milliseconds 250
      try{$candidate=Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{$candidate=$null}
      if($candidate -and [int]$candidate.supervisor_pid -eq [int]$service.Id){$state=$candidate}
      elseif($service.HasExited -and $candidate -and $candidate.runtime_status -eq 'RUNNING'){
        $existingSupervisor=Get-Process -Id ([int]$candidate.supervisor_pid) -ErrorAction SilentlyContinue
        $existingStart=$null;try{$existingStart=$existingSupervisor.StartTime.ToUniversalTime().ToString('o')}catch{}
        $sameExistingStart=Test-SameInstant $existingStart $candidate.supervisor_process_start_time_utc
        if($existingSupervisor -and $sameExistingStart -and [string]::Equals([IO.Path]::GetFullPath([string]$candidate.data_root).TrimEnd('\'),$dataRoot,[StringComparison]::OrdinalIgnoreCase)){$state=$candidate}
      }
    }while([DateTime]::UtcNow -lt $deadline -and (-not $state -or $state.runtime_status -notin @('RUNNING','CRASHED','STALE')))
    if($service.HasExited -and -not $state){
      $serviceError=Get-Content -LiteralPath $supervisorErr -Raw -ErrorAction SilentlyContinue
      if($serviceError -match 'ACCEPTANCE_RUNTIME_OWNER_LEASE_HELD'){throw 'ACCEPTANCE_RUNTIME_OWNER_LEASE_HELD'}
      if($serviceError -match 'PORT_BIND_EADDRINUSE_OWNER_UNRESOLVED'){throw 'PORT_BIND_EADDRINUSE_OWNER_UNRESOLVED'}
    }
    if($state -and $state.runtime_status -ne 'RUNNING'){throw ([string]$state.last_error_code)}
    if(-not $state -or $state.runtime_status -ne 'RUNNING'){throw 'ACCEPTANCE_SUPERVISOR_START_TIMEOUT'}
    [pscustomobject]@{status='RUNNING';supervisor_pid=$state.supervisor_pid;pid=$state.pid;data_root=$state.data_root;runtime_status=$state.runtime_status;runtime_mode=$state.runtime_mode;acceptance_hold=$state.acceptance_hold;business_dispatch_enabled=$state.business_dispatch_enabled;dependency_resume_enabled=$state.dependency_resume_enabled;background_provider_probe_enabled=$state.background_provider_probe_enabled;task_auto_mutation_enabled=$state.task_auto_mutation_enabled;acceptance_stop_after_step=$state.acceptance_stop_after_step}|ConvertTo-Json -Compress
  }finally{if($guard){$guard.Dispose();Remove-Item -LiteralPath $guardPath -Force -ErrorAction SilentlyContinue}}
  return
}

if($RuntimeMode -ne 'NORMAL' -or $StopAfterStep -ne $expectedStop){throw 'ACCEPTANCE_SUPERVISOR_POLICY_MISMATCH'}
if($NoHold -and -not (Assert-AcceptanceNoHoldScope $dataRoot $projectRoot)){throw 'ACCEPTANCE_NO_HOLD_SCOPE_REJECTED'}
Start-SupervisorService
