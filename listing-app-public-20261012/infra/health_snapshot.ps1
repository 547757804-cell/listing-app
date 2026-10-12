[CmdletBinding()]
param(
  [switch]$RefreshBOL,
  [switch]$RefreshAcceptanceBOL,
  [switch]$CheckOtherProviders,
  [switch]$LocalAggregateOnly,
  [switch]$Watch,
  [string]$OutputPath,
  [string]$WatcherStatusPath,
  [ValidateRange(1,1440)][int]$IntervalMinutes = 15,
  [ValidateRange(1,720)][int]$ProviderIntervalHours = 6
)
$ErrorActionPreference='Stop'
$ProjectRoot=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'runtime_network_bootstrap.ps1')
. (Join-Path $PSScriptRoot 'runtime_health_core.ps1')
$network=Set-BolRuntimeNetworkEnvironment $ProjectRoot
$roots=Get-BolInstanceRoots $ProjectRoot
$DataRoot=$roots.formal_root
$Integrations=Join-Path $DataRoot 'integrations'
$HealthOutputPath=Join-Path $Integrations 'provider-health.json'
if($LocalAggregateOnly){$RefreshBOL=$false;$RefreshAcceptanceBOL=$false;$CheckOtherProviders=$false}
$HealthWriterMode=if($LocalAggregateOnly){'LOCAL_AGGREGATE_ONLY'}else{'REMOTE_REFRESH_ENABLED'}
if($WatcherStatusPath){
  $WatcherStatusPath=Get-BolCanonicalRuntimePath $WatcherStatusPath
  if(-not (Test-BolCanonicalPathWithin $WatcherStatusPath $roots.acceptance_base) -and -not (Test-BolCanonicalPathWithin $WatcherStatusPath $roots.formal_root)){throw 'WATCHER_STATUS_PATH_OUTSIDE_BOL_DATA_ROOTS'}
}
if($OutputPath){
  $requestedOutput=Get-BolCanonicalRuntimePath $OutputPath
  if(-not (Test-BolCanonicalPathWithin $requestedOutput $env:TEMP)){throw 'CUSTOM_HEALTH_OUTPUT_MUST_BE_UNDER_TEMP'}
  $HealthOutputPath=$requestedOutput
}
$RuntimeHealthPath=Join-Path $Integrations 'bol-api-runtime-health.json'
$Node=Join-Path $ProjectRoot '_runtime\bin\node.exe'
$cfg=$roots.config
$script:NextProviderProbe=[DateTime]::MinValue
$HealthMutex=$null
$ProductionValidation=[ordered]@{status='PASS';validated_at='2026-09-24T16:48:57.1Z';evidence='BOL API production acceptance evidence'}

if($Watch){
  $HealthMutex=[Threading.Mutex]::new($false,'Local\BOL_AUTO_PROVIDER_HEALTH')
  if(-not $HealthMutex.WaitOne(0)){Write-Output 'BOL provider health watcher already running.';exit 0}
}

function Get-BolListeningPid([int]$Port){
  try{$c=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop|Select-Object -First 1;if($c){return [int]$c.OwningProcess}}catch{}
  try{$m=netstat -ano -p tcp|Select-String -Pattern (':'+$Port+'\s+.*LISTENING\s+(\d+)\s*$')|Select-Object -First 1;if($m){return [int]$m.Matches[0].Groups[1].Value}}catch{}
  return $null
}

function Read-BolJsonFile([string]$Path){try{return Get-Content -LiteralPath $Path -Raw -Encoding UTF8|ConvertFrom-Json -ErrorAction Stop}catch{return $null}}

function Get-BolUtcInstant([string]$Value){
  if([string]::IsNullOrWhiteSpace($Value)){return $null}
  $parsed=[DateTimeOffset]::MinValue
  if([DateTimeOffset]::TryParse($Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$parsed)){return $parsed.ToUniversalTime()}
  return $null
}

function Get-BolCurrentRuntimeEvidence([object]$Persisted,[object]$Readiness,[object]$PriorInstance,[int]$TtlMinutes){
  $candidates=[System.Collections.Generic.List[object]]::new()
  if($Persisted -and $Persisted.BOL_API_RUNTIME_HEALTH){
    $at=Get-BolUtcInstant ([string]$Persisted.last_check_at)
    $value=[string]$Persisted.BOL_API_RUNTIME_HEALTH
    if($at -and $value -in @('HEALTHY','FAIL','DEGRADED','UNKNOWN')){
      $candidates.Add([pscustomobject]@{checked_at=$at;status=$value;source='PERSISTED_RUNTIME_HEALTH';error_code=[string]$Persisted.last_error_code})
    }
  }
  if($Readiness -and [string]$Readiness.status -in @('PASS','FAIL')){
    $at=Get-BolUtcInstant ([string]$Readiness.checked_at)
    if($at){
      $status=if([string]$Readiness.status -eq 'PASS'){'HEALTHY'}else{'FAIL'}
      $errorCode=[string]$Readiness.oauth_error_code
      if(-not $errorCode){$errorCode=[string]$Readiness.endpoint_error_code}
      if($errorCode -notmatch '^[A-Za-z0-9_-]{1,64}$'){$errorCode=$null}
      $candidates.Add([pscustomobject]@{checked_at=$at;status=$status;source='CURRENT_READINESS_MANIFEST';error_code=$errorCode})
    }
  }
  $latest=$null
  foreach($candidate in $candidates){if(-not $latest -or $candidate.checked_at -ge $latest.checked_at){$latest=$candidate}}
  $successAt=$null
  foreach($value in @(
    $(if($Persisted){[string]$Persisted.last_success_at}else{''}),
    $(if($PriorInstance){[string]$PriorInstance.last_success_at}else{''})
  )){
    $candidateAt=Get-BolUtcInstant $value
    if($candidateAt -and (-not $successAt -or $candidateAt -gt $successAt)){$successAt=$candidateAt}
  }
  if($Readiness -and [string]$Readiness.status -eq 'PASS'){
    $readinessSuccessAt=Get-BolUtcInstant ([string]$Readiness.checked_at)
    if($readinessSuccessAt -and (-not $successAt -or $readinessSuccessAt -gt $successAt)){$successAt=$readinessSuccessAt}
  }
  $lastSuccess=if($successAt){$successAt.ToString('o')}else{$null}
  $failureAt=$null
  foreach($value in @(
    $(if($Persisted){[string]$Persisted.last_failure_at}else{''}),
    $(if($PriorInstance){[string]$PriorInstance.last_failure_at}else{''}),
    $(if($Readiness -and [string]$Readiness.status -eq 'FAIL'){[string]$Readiness.checked_at}else{''})
  )){
    $candidateAt=Get-BolUtcInstant $value
    if($candidateAt -and (-not $failureAt -or $candidateAt -gt $failureAt)){$failureAt=$candidateAt}
  }
  $lastFailure=if($failureAt){$failureAt.ToString('o')}else{$null}
  if(-not $latest){return [pscustomobject]@{status='UNKNOWN';source='NO_RUNTIME_HEALTH_EVIDENCE';last_check_at=$null;last_success_at=$lastSuccess;last_failure_at=$lastFailure;last_error_code=$null}}
  $age=([DateTimeOffset]::UtcNow-$latest.checked_at).TotalSeconds
  if($age -lt -60 -or $age -ge ($TtlMinutes*60)){
    return [pscustomobject]@{status='UNKNOWN';source='STALE_'+$latest.source;last_check_at=$latest.checked_at.ToString('o');last_success_at=$lastSuccess;last_failure_at=$lastFailure;last_error_code=$latest.error_code}
  }
  return [pscustomobject]@{status=$latest.status;source=$latest.source;last_check_at=$latest.checked_at.ToString('o');last_success_at=$lastSuccess;last_failure_at=$lastFailure;last_error_code=if($latest.status -in @('HEALTHY','UNKNOWN')){$null}else{$latest.error_code}}
}

function Save-BolJsonAtomic([string]$Path,[object]$Value){
  $dir=Split-Path -Parent $Path
  $null=New-Item -ItemType Directory -Path $dir -Force
  $tmp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  $json=$Value|ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($tmp,$json,[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Update-BolWatcherStatus([bool]$Active,[string]$ErrorCode=$null){
  if(-not $Watch -or -not $WatcherStatusPath){return}
  $existing=Read-BolJsonFile $WatcherStatusPath
  if($existing -and $existing.active -and [int]$existing.pid -ne $PID){
    $owner=Get-Process -Id ([int]$existing.pid) -ErrorAction SilentlyContinue
    if($owner){throw 'WATCHER_STATUS_OWNED_BY_ANOTHER_PROCESS'}
  }
  $startedAt=if($existing -and [int]$existing.pid -eq $PID){[string]$existing.started_at_utc}else{[DateTime]::UtcNow.ToString('o')}
  Save-BolJsonAtomic $WatcherStatusPath ([ordered]@{
    schema='bol.health-watcher-runtime.v1';pid=$PID;active=$Active;mode=$HealthWriterMode
    started_at_utc=$startedAt;heartbeat_at_utc=[DateTime]::UtcNow.ToString('o')
    error_code=$ErrorCode
  })
}

function Get-BolooPaneRuntimeSnapshot{
  $now=[DateTime]::UtcNow.ToString('o')
  $registrationPath=Join-Path $Integrations 'boloo-pane-runtime.json'
  $registration=Read-BolJsonFile $registrationPath
  if(-not $registration){return [pscustomobject]@{readiness='NOT_READY';pid=$null;process_name=$null;checked_at_utc=$now;registered_at_utc=$null;source='NO_RUNTIME_REGISTRATION';error_code='PANE_RUNTIME_NOT_REGISTERED';checks=@{webview2=$false;explorer=$false;login=$false;bridge=$false};formal_keyword_query_submitted=$false}}
  $pidValue=0;[void][int]::TryParse([string]$registration.pid,[ref]$pidValue)
  $process=if($pidValue -gt 0){Get-Process -Id $pidValue -ErrorAction SilentlyContinue}else{$null}
  $processValid=$false
  $errorCode=$null
  if(-not $process){$errorCode='PANE_PID_NOT_RUNNING'}
  elseif([string]$process.ProcessName -ne [string]$registration.process_name){$errorCode='PANE_PID_PROCESS_MISMATCH'}
  else{
    $processValid=Test-BolPaneStartTimeMatch $process.StartTime $registration.process_started_at_utc
    if(-not $processValid){$errorCode='PANE_PID_START_TIME_MISMATCH'}
  }
  $checks=[ordered]@{webview2=([bool]$registration.checks.webview2);explorer=([bool]$registration.checks.explorer);login=([bool]$registration.checks.login);bridge=([bool]$registration.checks.bridge)}
  $checksPass=(@($checks.Values|Where-Object{$_ -ne $true}).Count -eq 0)
  if(-not $checksPass -and -not $errorCode){$errorCode='PANE_ACCEPTANCE_CHECK_INCOMPLETE'}
  $ready=($processValid -and $checksPass -and [string]$registration.claimed_readiness -eq 'READY')
  return [pscustomobject]@{
    readiness=if($ready){'READY'}else{'NOT_READY'};pid=$pidValue;process_name=[string]$registration.process_name
    process_started_at_utc=[string]$registration.process_started_at_utc;checked_at_utc=$now;registered_at_utc=[string]$registration.registered_at_utc
    source=[string]$registration.source;error_code=if($ready){$null}else{$errorCode};checks=$checks
    formal_keyword_query_submitted=([bool]$registration.formal_keyword_query_submitted);registration_path=$registrationPath
  }
}

function Test-BolPaneStartTimeMatch([object]$Actual,[object]$Registered,[int]$ToleranceMilliseconds=1500){
  try{
    $actualUtc=if($Actual -is [DateTime]){$Actual.ToUniversalTime()}else{[DateTimeOffset]::Parse([string]$Actual,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime}
    $registeredUtc=if($Registered -is [DateTime]){$Registered.ToUniversalTime()}elseif($Registered -is [DateTimeOffset]){$Registered.UtcDateTime}else{[DateTimeOffset]::Parse([string]$Registered,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime}
    return [Math]::Abs(($actualUtc-$registeredUtc).TotalMilliseconds) -lt $ToleranceMilliseconds
  }catch{return $false}
}

function Get-BolooProviderCapabilitySnapshot{
  $manifestPath=Join-Path $Integrations 'boloo-official-web-readiness.json'
  $manifest=Read-BolJsonFile $manifestPath
  $state=if($manifest -and [string]$manifest.readiness -eq 'READY' -and [string]$manifest.approval_status -eq 'APPROVED'){'READY'}else{'NOT_READY'}
  return [pscustomobject]@{readiness=$state;provider_source=if($manifest){[string]$manifest.provider_source}else{'BOLOO_OFFICIAL_WEB'};approval_status=if($manifest){[string]$manifest.approval_status}else{'UNKNOWN'};approved_at_utc=if($manifest){[string]$manifest.approved_at_utc}else{$null};checked_at_utc=[DateTime]::UtcNow.ToString('o');source='PROVIDER_CAPABILITY_MANIFEST'}
}

function Save-BolProductionHealth([object]$Readiness,[bool]$RefreshAttempted){
  if(-not $RefreshAttempted){return Read-BolJsonFile $RuntimeHealthPath}
  $record=Read-BolJsonFile $RuntimeHealthPath
  if(-not $record){$record=[pscustomobject]@{BOL_API_PRODUCTION_VALIDATED='PASS';production_validated_at=$ProductionValidation.validated_at;production_validation_evidence=$ProductionValidation.evidence;last_success_at=$null}}
  # Historical acceptance is immutable and kept separate from the current probe.
  $record.BOL_API_PRODUCTION_VALIDATED='PASS'
  if(-not $record.production_validated_at){$record.production_validated_at=$ProductionValidation.validated_at}
  if(-not $record.production_validation_evidence){$record.production_validation_evidence=$ProductionValidation.evidence}
  $checked=if($Readiness.checked_at){([DateTimeOffset]$Readiness.checked_at).ToUniversalTime().ToString('o')}else{[DateTime]::UtcNow.ToString('o')}
  $record.last_check_at=$checked
  if([string]$Readiness.status -eq 'PASS'){
    $record.BOL_API_RUNTIME_HEALTH='HEALTHY';$record.dependency_readiness='READY';$record.last_success_at=$checked;$record.last_error_code=$null
  }else{
    $record.BOL_API_RUNTIME_HEALTH='FAIL';$record.dependency_readiness='WAITING_DEPENDENCY'
    $code=[string]$Readiness.oauth_error_code;if(-not $code){$code=[string]$Readiness.endpoint_error_code};if(-not $code){$code='BOL_READINESS_FAILED'}
    $record.last_error_code=if($code -match '^[A-Za-z0-9_-]{1,64}$'){$code}else{'BOL_READINESS_FAILED'}
  }
  Save-BolJsonAtomic $RuntimeHealthPath $record
  return $record
}

$PriorSnapshot=Read-BolJsonFile $HealthOutputPath
$FormalPersisted=Read-BolJsonFile $RuntimeHealthPath

function Get-BolInstanceSnapshot([object]$Definition,[bool]$AllowRefresh){
  $port=[int]$Definition.port;$pidValue=Get-BolListeningPid $port
  $rootExpected=if($Definition.rootKind -eq 'FORMAL'){$roots.formal_root}else{$roots.acceptance_base}
  $observation=$null;$dashboard=$null;$actualRoot=$null;$readiness=$null;$localError=$null;$rootValid=$false
  if($pidValue){
    $observation=Get-BolLocalRuntimeObservation -BaseUri "http://127.0.0.1:$port" -RootKind ([string]$Definition.rootKind) -FormalRoot $roots.formal_root -AcceptanceBase $roots.acceptance_base
    $dashboard=$observation.dashboard;$actualRoot=$observation.data_root;$readiness=$observation.readiness;$localError=$observation.error_code;$rootValid=[bool]$observation.root_valid
  }else{$localError='SERVICE_NOT_RUNNING'}
  $markerState=$null
  if($actualRoot){$markerState=Read-BolJsonFile (Join-Path (Join-Path $actualRoot 'run') 'runtime-instance.json')}
  $marker=if($markerState -and [int]$markerState.pid -eq $pidValue){[string]$markerState.environment_marker}else{[string]$Definition.environmentMarker}
  $markerSource=if($markerState -and [int]$markerState.pid -eq $pidValue){'STARTUP_RECORD'}else{'PORT_AND_DATAROOT_INFERENCE'}
  $markerValid=($marker -eq [string]$Definition.environmentMarker) -and $rootValid
  $processContext=if($pidValue){Get-BolRuntimeContext -ProcessId $pidValue}else{$null}
  $manifestPath=if($actualRoot){Join-Path (Join-Path $actualRoot 'integrations') 'bol-api-readiness.json'}else{$null}
  $runtimePath=if($actualRoot){Join-Path (Join-Path $actualRoot 'integrations') 'bol-api-runtime-health.json'}else{$null}
  $persisted=if($runtimePath){Read-BolJsonFile $runtimePath}elseif($Definition.rootKind -eq 'FORMAL'){$FormalPersisted}else{$null}
  $priorInstance=$null
  if($PriorSnapshot -and $PriorSnapshot.instances){$priorInstance=@($PriorSnapshot.instances|Where-Object{$_.instance_key -eq [string]$Definition.key}|Select-Object -First 1)}
  if($priorInstance -is [array]){$priorInstance=$priorInstance|Select-Object -First 1}
  $scheduler=if($priorInstance){$priorInstance.probe_scheduler}else{$null}
  if($rootValid -and $pidValue){
    if($readiness -and [string]$readiness.status -eq 'WAITING_FOR_READINESS_CHECK'){
      $saved=Read-BolJsonFile $manifestPath
      if($saved){$readiness=$saved}
    }
  }
  $readinessStatus=if($readiness){[string]$readiness.status}else{''}
  $checkedAt=if($readiness){[string]$readiness.checked_at}else{''}
  $fresh=Get-BolReadinessFreshness -Status $readinessStatus -CheckedAt $checkedAt -TtlMinutes ([int]$cfg.freshness.ttlMinutes) -ExpiringWithinMinutes ([int]$cfg.freshness.expiringWithinMinutes)
  $failures=if($scheduler){[int]$scheduler.failure_count}else{0}
  $lastAttempt=if($scheduler){[string]$scheduler.last_attempt_at}else{''}
  $plan=Get-BolReadinessProbePlan -Status $readinessStatus -CheckedAt $checkedAt -FailureCount $failures -LastAttemptAt $lastAttempt -TtlMinutes ([int]$cfg.freshness.ttlMinutes) -ExpiringWithinMinutes ([int]$cfg.freshness.expiringWithinMinutes) -BackoffBaseMinutes ([int]$cfg.freshness.backoffBaseMinutes) -BackoffCapMinutes ([int]$cfg.freshness.backoffCapMinutes)
  $refreshAttempted=$false
  $refreshAllowed=($Definition.rootKind -eq 'FORMAL' -and $RefreshBOL) -or ($Definition.rootKind -eq 'ACCEPTANCE' -and $RefreshAcceptanceBOL)
  if($AllowRefresh -and $refreshAllowed -and $rootValid -and $pidValue -and $plan.probe_due){
    $refreshAttempted=$true;$now=[DateTime]::UtcNow.ToString('o')
    try{$readiness=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/integrations/bol/readiness-check" -TimeoutSec 45}
    catch{$readiness=[pscustomobject]@{status='FAIL';checked_at=$now;oauth_error_code='READINESS_REFRESH_FAILED';endpoint_error_code=$null}}
    if($Definition.rootKind -eq 'FORMAL'){$persisted=Save-BolProductionHealth $readiness $true}
    $passed=[string]$readiness.status -eq 'PASS'
    $newCount=if($passed){0}else{$failures+1}
    $scheduler=[pscustomobject]@{schema='bol.readiness.scheduler.v1';instance=$Definition.key;last_attempt_at=$now;failure_count=$newCount;last_error_code=if($passed){$null}else{[string]$readiness.oauth_error_code};next_probe_at_utc=if($passed){$null}else{(Get-BolReadinessProbePlan -Status 'FAIL' -CheckedAt $now -FailureCount $newCount -LastAttemptAt $now -NowUtc ([DateTime]::UtcNow.AddSeconds(-1)) -BackoffBaseMinutes ([int]$cfg.freshness.backoffBaseMinutes) -BackoffCapMinutes ([int]$cfg.freshness.backoffCapMinutes)).next_allowed_at_utc}}
    $readinessStatus=[string]$readiness.status;$checkedAt=[string]$readiness.checked_at
    $fresh=Get-BolReadinessFreshness -Status $readinessStatus -CheckedAt $checkedAt -TtlMinutes ([int]$cfg.freshness.ttlMinutes) -ExpiringWithinMinutes ([int]$cfg.freshness.expiringWithinMinutes)
    $plan=Get-BolReadinessProbePlan -Status $readinessStatus -CheckedAt $checkedAt -FailureCount $newCount -LastAttemptAt $now -TtlMinutes ([int]$cfg.freshness.ttlMinutes) -ExpiringWithinMinutes ([int]$cfg.freshness.expiringWithinMinutes) -BackoffBaseMinutes ([int]$cfg.freshness.backoffBaseMinutes) -BackoffCapMinutes ([int]$cfg.freshness.backoffCapMinutes)
  }
  $runtimeReadiness=if($fresh.state -in @('FRESH','EXPIRING')){'READY'}else{'WAITING_DEPENDENCY'}
  $runtimeEvidence=Get-BolCurrentRuntimeEvidence -Persisted $persisted -Readiness $readiness -PriorInstance $priorInstance -TtlMinutes ([int]$cfg.freshness.ttlMinutes)
  $runtimeHealthValue=[string]$runtimeEvidence.status
  $runtimeHealthSource=[string]$runtimeEvidence.source
  $runtimeMode=if($dashboard -and $dashboard.runtime_mode){[string]$dashboard.runtime_mode}elseif($markerState -and $markerState.runtime_mode){[string]$markerState.runtime_mode}else{$null}
  $businessDispatchEnabled=if($dashboard -and $null -ne $dashboard.business_dispatch_enabled){[bool]$dashboard.business_dispatch_enabled}elseif($markerState -and $null -ne $markerState.business_dispatch_enabled){[bool]$markerState.business_dispatch_enabled}else{$null}
  $dependencyResumeEnabled=if($dashboard -and $null -ne $dashboard.dependency_resume_enabled){[bool]$dashboard.dependency_resume_enabled}elseif($markerState -and $null -ne $markerState.dependency_resume_enabled){[bool]$markerState.dependency_resume_enabled}else{$null}
  $route=Get-BolRuntimeNetworkContext -Config (Read-BolRuntimeNetworkConfig $ProjectRoot) -TargetUrl 'https://login.bol.com'
  $record=[ordered]@{
    schema='bol.runtime.instance-health.v1';checked_at_utc=[DateTime]::UtcNow.ToString('o');instance_key=[string]$Definition.key;port=$port;pid=$pidValue
    data_root=$actualRoot;expected_data_root=$rootExpected;data_root_valid=$rootValid;environment_marker=$marker;environment_marker_source=$markerSource;environment_marker_valid=$markerValid
    runtime_mode=$runtimeMode;business_dispatch_enabled=$businessDispatchEnabled;dependency_resume_enabled=$dependencyResumeEnabled
    BOL_API_PRODUCTION_VALIDATED=$ProductionValidation.status
    production_validated_at=$ProductionValidation.validated_at
    BOL_API_RUNTIME_HEALTH=$runtimeHealthValue;runtime_health_source=$runtimeHealthSource
    readiness=$runtimeReadiness;readiness_status=$readinessStatus;freshness=$fresh.state;readiness_checked_at=$checkedAt
    last_success_at=$runtimeEvidence.last_success_at
    last_check_at=$runtimeEvidence.last_check_at;last_failure_at=$runtimeEvidence.last_failure_at;last_error_code=$runtimeEvidence.last_error_code
    freshness_age_seconds=$fresh.age_seconds;freshness_expires_at=$fresh.expires_at_utc;probe_plan=$plan;probe_scheduler=$scheduler;probe_executed=$refreshAttempted;probe_enabled_for_instance=[bool]$refreshAllowed
    provider_route=$route.route;provider_proxy_host=$route.proxy_host;provider_proxy_port=$route.proxy_port;local_error_code=$localError;runtime_context=$processContext
    persistence_path=$HealthOutputPath
  }
  return [pscustomobject]$record
}

function Get-BolSnapshot([bool]$RunOtherProviderProbe){
  $instances=@($cfg.instances|ForEach-Object{$canRefresh=($_.rootKind -eq 'FORMAL' -and $RefreshBOL) -or ($_.rootKind -eq 'ACCEPTANCE' -and $RefreshAcceptanceBOL);Get-BolInstanceSnapshot $_ ([bool]$canRefresh)})
  $paneRuntime=Get-BolooPaneRuntimeSnapshot
  $providerCapabilities=@{BOLOO_OFFICIAL_WEB=Get-BolooProviderCapabilitySnapshot}
  $snapshot=[ordered]@{schema='bol.provider-health.v2';checked_at_utc=[DateTime]::UtcNow.ToString('o');health_writer=@{mode=$HealthWriterMode;pid=$PID};services=@{};instances=$instances;runtime_components=@{BOLOO_WEBVIEW2_PANE=$paneRuntime};provider_capabilities=$providerCapabilities;providers=@{};disk=@{};storage=@{};runtime_network=@{config_path=$network.config_path;enabled=$network.config_enabled;provider_route=$network.route;proxy_host=$network.proxy_host;proxy_port=$network.proxy_port;all_proxy_cleared=$network.all_proxy_cleared}}
  foreach($i in $instances){$snapshot.services[[string]$i.port]=@{reachable=([bool]$i.pid -and [bool]$i.data_root_valid);root_match=[bool]$i.data_root_valid;pid=$i.pid;environment_marker=$i.environment_marker;data_root=$i.data_root;readiness=$i.readiness;freshness=$i.freshness}}
  $production=$instances|Where-Object{$_.instance_key -eq 'PRODUCTION_4180'}|Select-Object -First 1
  if($production){$snapshot.providers.BOL_API=@{production_validated=$production.BOL_API_PRODUCTION_VALIDATED;runtime_health=$production.BOL_API_RUNTIME_HEALTH;readiness=$production.readiness;freshness=$production.freshness;last_success_at=$production.last_success_at;last_check_at=$production.last_check_at;last_error_code=$production.last_error_code;provider_route=$production.provider_route;reason=$production.readiness_status}}
  if($RunOtherProviderProbe){
    $providerNames=@();try{$providerNames=@((Get-Content -LiteralPath (Join-Path $ProjectRoot 'app\ai_provider_config.json') -Raw|ConvertFrom-Json).providers|ForEach-Object{[string]$_.name})}catch{}
    try{. (Join-Path $ProjectRoot 'app\load_bol_provider_credentials.ps1')|Out-Null;$raw=& $Node (Join-Path $ProjectRoot 'app\provider_connectivity_smoke.mjs')|Out-String -NoNewline;if($LASTEXITCODE -ne 0){throw 'PROVIDER_SMOKE_FAILED'};$rows=@(ConvertFrom-Json $raw);$snapshot.providers.AI=@($rows|ForEach-Object{@{name=$_.provider;readiness=if($_.status -eq 'PASS'){'READY'}else{'WAITING_DEPENDENCY'};reason=$_.error}})}catch{$snapshot.providers.AI=@($providerNames|ForEach-Object{@{name=$_;readiness='WAITING_DEPENDENCY';reason='provider check unavailable'}})}
  }
  try{$drive=[IO.DriveInfo]::new('D:\');$snapshot.disk.D=@{free_bytes=$drive.AvailableFreeSpace;total_bytes=$drive.TotalSize;readiness=if($drive.AvailableFreeSpace -gt 20GB){'READY'}else{'WAITING_DEPENDENCY'}}}catch{$snapshot.disk.D=@{readiness='WAITING_DEPENDENCY'}}
  foreach($name in @('tmp','browser-profile','webview','webview2','versions','uploads','products','events')){$path=Join-Path $DataRoot $name;if(Test-Path -LiteralPath $path){$files=Get-ChildItem -LiteralPath $path -File -Recurse -Force -ErrorAction SilentlyContinue;$snapshot.storage[$name]=@{file_count=@($files).Count;bytes=[int64](($files|Measure-Object Length -Sum).Sum)}}}
  return $snapshot
}

try{
  if($Watch){Update-BolWatcherStatus $true}
  do{
    $providerDue=$CheckOtherProviders -and (-not $Watch -or [DateTime]::UtcNow -ge $script:NextProviderProbe)
    if($providerDue){$script:NextProviderProbe=[DateTime]::UtcNow.AddHours($ProviderIntervalHours)}
    $snapshot=Get-BolSnapshot ([bool]$providerDue)
    Save-BolJsonAtomic $HealthOutputPath $snapshot
    if($Watch){Update-BolWatcherStatus $true}
    $PriorSnapshot=$snapshot
    Write-Output ($snapshot|ConvertTo-Json -Compress -Depth 12)
    if($Watch){Start-Sleep -Seconds ($IntervalMinutes*60)}
  }while($Watch)
}finally{
  if($Watch -and $WatcherStatusPath){try{Update-BolWatcherStatus $false}catch{}}
  if($HealthMutex){try{$HealthMutex.ReleaseMutex()}catch{};$HealthMutex.Dispose()}
}
