[CmdletBinding()]
param(
  [string]$DataRoot=$env:BOL_ACCEPTANCE_DATA_ROOT,
  [ValidateRange(21,21)][int]$Samples=21,
  [ValidateRange(30,30)][int]$IntervalSeconds=30,
  [Parameter(Mandatory=$true)][int]$ExpectedRevision,
  [Parameter(Mandatory=$true)][string]$ExpectedStatus,
  [Parameter(Mandatory=$true)][string]$ExpectedStep,
  [Parameter(Mandatory=$true)][string]$ExpectedTaskHash
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedRoot=[IO.Path]::GetFullPath($env:BOL_ACCEPTANCE_DATA_ROOT)
$DataRoot=[IO.Path]::GetFullPath($DataRoot.Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
if(-not [string]::Equals($DataRoot,$expectedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'STABLE_GATE_DATA_ROOT_MISMATCH'}
$run=Join-Path $DataRoot 'run';$logs=Join-Path $DataRoot 'logs'
$lockPath=Join-Path $run 'acceptance-runtime-lock.json';$instancePath=Join-Path $run 'runtime-instance.json'
$watcherStatusPath=Join-Path $run 'health-watcher-runtime.json'
$auditPath=Join-Path $logs ('acceptance-stable-runtime-gate-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss')+'.jsonl')
$node=Join-Path $projectRoot '_runtime\bin\node.exe';$sqlitePath=Join-Path $DataRoot 'bol.sqlite3'
$taskPath=Join-Path $DataRoot 'products\SYNTHETIC-SKU-LEGACY-10.json'
$providerEvidenceRoots=@('ai-generation-recovery','ai-provider-readiness','deepseek-responses-shape-tests','deepseek-responses-normalized-evidence')
function Get-ProviderEvidenceDigest {
  $rows=@(foreach($leaf in $providerEvidenceRoots){
    $folder=Join-Path $DataRoot ('integrations\'+$leaf)
    if(Test-Path -LiteralPath $folder){Get-ChildItem -LiteralPath $folder -File -Recurse|Sort-Object FullName|ForEach-Object{([string]$_.FullName)+'|'+(Get-FileHash -LiteralPath $_.FullName).Hash}}
  })
  return ($rows -join "`n")
}
$baselineProviderEvidence=Get-ProviderEvidenceDigest

function Read-DirectJson([string]$Url){
  $request=[Net.HttpWebRequest]::Create($Url);$request.Proxy=$null;$request.Timeout=2500;$request.ReadWriteTimeout=2500;$response=$null
  try{$response=$request.GetResponse();$reader=[IO.StreamReader]::new($response.GetResponseStream());$body=$reader.ReadToEnd()|ConvertFrom-Json;$reader.Dispose();return [pscustomobject]@{status=[int]$response.StatusCode;body=$body}}
  catch{return [pscustomobject]@{status=0;body=$null}}
  finally{if($response){$response.Dispose()}}
}
function Read-Process([int]$Id){
  try{$p=Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction Stop}catch{return $null}
  if(-not $p){return $null}
  $created=$p.CreationDate
  if($created -is [DateTime]){$utc=$created.ToUniversalTime()}else{$utc=[Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToUniversalTime()}
  return [pscustomobject]@{pid=[int]$p.ProcessId;parent_pid=[int]$p.ParentProcessId;start_utc=$utc.ToString('o');exe=[IO.Path]::GetFullPath([string]$p.ExecutablePath);cmd=[string]$p.CommandLine}
}
function Same-Instant($Left,$Right){
  if(-not $Left -or -not $Right){return $false}
  $toUtc={param($value)
    if($value -is [DateTimeOffset]){return $value.UtcDateTime}
    if($value -is [DateTime]){
      if($value.Kind -eq [DateTimeKind]::Utc){return $value}
      if($value.Kind -eq [DateTimeKind]::Unspecified){return [DateTime]::SpecifyKind($value,[DateTimeKind]::Utc)}
      return $value.ToUniversalTime()
    }
    return ([DateTimeOffset]::Parse([string]$value)).UtcDateTime
  }
  $a=& $toUtc $Left;$b=& $toUtc $Right
  return ([Math]::Abs(($a-$b).TotalMilliseconds) -lt 1)
}
function Get-ListenOwners {
  try{$rows=@(Get-NetTCPConnection -LocalPort 4181 -State Listen -ErrorAction Stop);return @($rows|ForEach-Object{[int]$_.OwningProcess}|Select-Object -Unique)}catch{}
  $matches=@(netstat.exe -ano -p tcp|Select-String -Pattern ':4181\s+.*LISTENING\s+(\d+)\s*$')
  return @($matches|ForEach-Object{[int]$_.Matches[0].Groups[1].Value}|Select-Object -Unique)
}
function Get-ActiveLeaseCount {
  $code='const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.argv[1],{readOnly:true}); const r=db.prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state=''RUNNING''").get("SYNTHETIC-SKU-LEGACY-10"); console.log(r.n); db.close();'
  $output=& $node -e $code $sqlitePath
  if($LASTEXITCODE -ne 0){throw 'SYNTHETIC_ACCEPTANCE_10_READ_ONLY_LEASE_QUERY_FAILED'}
  return [int]([string]$output).Trim()
}

$baselineTask=$null
$baseline=Read-DirectJson 'http://127.0.0.1:4181/api/dashboard'
if($baseline.status -ne 200){throw 'BASELINE_DASHBOARD_UNAVAILABLE'}
$baselineTask=@($baseline.body.tasks|Where-Object{$_.sku -eq 'SYNTHETIC-SKU-LEGACY-10'})|Select-Object -First 1
if(-not $baselineTask -or [int]$baselineTask.revision -ne $ExpectedRevision -or $baselineTask.status -ne $ExpectedStatus -or $baselineTask.current_step -ne $ExpectedStep -or (Get-FileHash -LiteralPath $taskPath).Hash -ne $ExpectedTaskHash){throw 'SYNTHETIC_ACCEPTANCE_10_BASELINE_MISMATCH'}
$baselineLeaseCount=Get-ActiveLeaseCount
if($baselineLeaseCount -ne 0){throw 'SYNTHETIC_ACCEPTANCE_10_ACTIVE_LEASE_PRESENT_AT_GATE_START'}
$initialLock=Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8|ConvertFrom-Json
if($initialLock.runtime_status -ne 'RUNNING' -or -not $initialLock.pid){throw 'SUPERVISOR_RUNTIME_NOT_RUNNING_AT_GATE_START'}
$expectedNodePid=[int]$initialLock.pid;$expectedNodeStart=$initialLock.process_start_time_utc
$expectedSupervisorPid=[int]$initialLock.supervisor_pid;$expectedSupervisorStart=$initialLock.supervisor_process_start_time_utc
$startedAt=[DateTime]::UtcNow
$samplesPassed=0;$failure=$null;$sampleRecords=[Collections.Generic.List[object]]::new()

for($i=1;$i -le $Samples;$i++){
  $scheduled=$startedAt.AddSeconds(($i-1)*$IntervalSeconds)
  $wait=($scheduled-[DateTime]::UtcNow).TotalMilliseconds
  if($wait -gt 0){Start-Sleep -Milliseconds ([int][Math]::Ceiling($wait))}
  $checked=[DateTime]::UtcNow.ToString('o')
  $lock=$null;$instance=$null;$watcher=$null;$health=$null;$dashboard=$null;$task=$null
  try{$lock=Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
  try{$instance=Get-Content -LiteralPath $instancePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
  try{$watcher=Get-Content -LiteralPath $watcherStatusPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
  $nodeProcess=Read-Process $expectedNodePid;$supervisorProcess=Read-Process $expectedSupervisorPid
  $owners=@(Get-ListenOwners)
  $healthResponse=Read-DirectJson 'http://127.0.0.1:4181/api/health';$health=$healthResponse.body
  $dashboardResponse=Read-DirectJson 'http://127.0.0.1:4181/api/dashboard';$dashboard=$dashboardResponse.body
  if($dashboard){$task=@($dashboard.tasks|Where-Object{$_.sku -eq 'SYNTHETIC-SKU-LEGACY-10'})|Select-Object -First 1}
  $watcherProcess=$null;$watcherCount=0
  if($watcher){
    $watchers=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object{$_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -like '*health_snapshot.ps1*' -and $_.CommandLine -like '*-LocalAggregateOnly*' -and $_.CommandLine -like ('*'+$watcherStatusPath+'*')})
    $watcherCount=$watchers.Count
    if($watcherCount -eq 1){$watcherProcess=Read-Process ([int]$watcher.pid)}
  }
  $heartbeatAge=if($watcher){([DateTime]::UtcNow-([DateTime]$watcher.heartbeat_at_utc).ToUniversalTime()).TotalSeconds}else{[double]::PositiveInfinity}
  $checks=[ordered]@{
    lock_running=($lock.runtime_status -eq 'RUNNING')
    same_node_pid=([int]$lock.pid -eq $expectedNodePid -and [int]$health.pid -eq $expectedNodePid)
    same_node_start_time=(Same-Instant $lock.process_start_time_utc $expectedNodeStart -and $nodeProcess -and (Same-Instant $nodeProcess.start_utc $expectedNodeStart))
    node_executable=($nodeProcess -and [string]::Equals($nodeProcess.exe,$node,[StringComparison]::OrdinalIgnoreCase))
    node_command=($nodeProcess -and $nodeProcess.cmd -like '*app\bol_server.mjs*')
    same_supervisor=($supervisorProcess -and (Same-Instant $supervisorProcess.start_utc $expectedSupervisorStart) -and [string]::Equals($supervisorProcess.exe,(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),[StringComparison]::OrdinalIgnoreCase))
    one_listener=($owners.Count -eq 1 -and $owners[0] -eq $expectedNodePid)
    direct_health_http_200=($healthResponse.status -eq 200)
    acceptance_identity=($health -and $health.instance -eq 'ACCEPTANCE_4181' -and $health.environment_marker -eq 'ACCEPTANCE_4181' -and $health.acceptance_mode -and $health.runtime_mode -eq 'NORMAL')
    data_root=($health -and [string]::Equals([IO.Path]::GetFullPath([string]$health.data_root).TrimEnd('\'),$DataRoot,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([IO.Path]::GetFullPath([string]$lock.data_root).TrimEnd('\'),$DataRoot,[StringComparison]::OrdinalIgnoreCase))
    acceptance_hold=($health -and $health.acceptance_hold -and $lock.acceptance_hold)
    stop_after_sop17=($health -and $health.acceptance_stop_after_step -eq 'LISTING_SOP_17' -and $lock.acceptance_stop_after_step -eq 'LISTING_SOP_17')
    dispatch_disabled=($health -and -not $health.business_dispatch_enabled -and -not $lock.business_dispatch_enabled)
    dependency_resume_disabled=($health -and -not $health.dependency_resume_enabled -and -not $lock.dependency_resume_enabled)
    background_provider_probe_disabled=($health -and -not $health.background_provider_probe_enabled -and -not $lock.background_provider_probe_enabled)
    task_auto_mutation_disabled=($health -and -not $health.task_auto_mutation_enabled -and -not $lock.task_auto_mutation_enabled)
    runtime_marker_running=($instance -and $instance.status -eq 'RUNNING' -and [int]$instance.pid -eq $expectedNodePid)
    unique_local_aggregate_watcher=($watcher -and $watcher.active -and $watcher.mode -eq 'LOCAL_AGGREGATE_ONLY' -and $watcherCount -eq 1 -and $heartbeatAge -le 90)
    policy_valid_and_consistent=($health.runtime_policy_status -eq 'VALID' -and $lock.runtime_policy_status -eq 'VALID' -and $instance.runtime_policy_status -eq 'VALID' -and $health.effective_runtime_policy.acceptance_hold -eq $true)
    case_a_revision_unchanged=($task -and [int]$task.revision -eq $ExpectedRevision)
    case_a_status_step_unchanged=($task -and $task.status -eq $ExpectedStatus -and $task.current_step -eq $ExpectedStep)
    case_a_bytes_unchanged=((Get-FileHash -LiteralPath $taskPath).Hash -eq $ExpectedTaskHash)
    provider_evidence_unchanged=((Get-ProviderEvidenceDigest) -ceq $baselineProviderEvidence)
  }
  $failed=@($checks.Keys|Where-Object{-not [bool]$checks[$_]})
  $record=[ordered]@{sample=$i;checked_at_utc=$checked;status=if($failed.Count){'FAIL'}else{'PASS'};pid=$expectedNodePid;supervisor_pid=$expectedSupervisorPid;watcher_pid=if($watcher){[int]$watcher.pid}else{$null};listener_pids=$owners;checks=$checks;failed_checks=$failed;provider_requests_issued_by_gate=0}
  [IO.File]::AppendAllText($auditPath,(ConvertTo-Json -InputObject $record -Depth 8 -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  $sampleRecords.Add($record)
  if($failed.Count){$failure=$failed;break}
  $samplesPassed++
}
$endedAt=[DateTime]::UtcNow;$elapsed=($endedAt-$startedAt).TotalSeconds
$finalTask=$null;$finalDashboard=Read-DirectJson 'http://127.0.0.1:4181/api/dashboard'
if($finalDashboard.body){$finalTask=@($finalDashboard.body.tasks|Where-Object{$_.sku -eq 'SYNTHETIC-SKU-LEGACY-10'})|Select-Object -First 1}
$finalLeaseCount=Get-ActiveLeaseCount
$pass=($samplesPassed -eq 21 -and $elapsed -ge 600 -and $null -eq $failure -and $finalTask -and [int]$finalTask.revision -eq $ExpectedRevision -and $finalTask.status -eq $ExpectedStatus -and $finalTask.current_step -eq $ExpectedStep -and $finalLeaseCount -eq 0 -and (Get-FileHash -LiteralPath $taskPath).Hash -eq $ExpectedTaskHash)
$summary=[ordered]@{result=if($pass){'PASS'}else{'FAIL'};started_at_utc=$startedAt.ToString('o');ended_at_utc=$endedAt.ToString('o');elapsed_seconds=[Math]::Round($elapsed,2);samples_passed=$samplesPassed;samples_required=21;interval_seconds=$IntervalSeconds;minimum_duration_seconds=600;first_failed_checks=$failure;audit_path=$auditPath;provider_requests_issued=0;case_a_revision_before=[int]$baselineTask.revision;case_a_revision_after=if($finalTask){[int]$finalTask.revision}else{$null};case_a_status_after=if($finalTask){[string]$finalTask.status}else{$null};case_a_step_after=if($finalTask){[string]$finalTask.current_step}else{$null};case_a_waiting_dependency_after=if($finalTask){[string]$finalTask.waiting_dependency_key}else{$null};active_lease_count_before=$baselineLeaseCount;active_lease_count_after=$finalLeaseCount}
$summary|ConvertTo-Json -Depth 8 -Compress
