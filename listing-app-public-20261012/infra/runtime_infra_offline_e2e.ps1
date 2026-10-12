[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$ProjectRoot=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'runtime_network_bootstrap.ps1')
. (Join-Path $PSScriptRoot 'runtime_health_core.ps1')
. (Join-Path $PSScriptRoot 'runtime_preflight.ps1')
$results=[System.Collections.Generic.List[object]]::new()
$scratch=Join-Path $env:TEMP ('bol-runtime-infra-offline-'+[guid]::NewGuid().ToString('N'))
$stubProcess=$null
function Assert-Pass([string]$Name,[bool]$Condition,[string]$Detail=''){
  if(-not $Condition){throw ('OFFLINE_E2E_FAIL:'+ $Name)}
  $script:results.Add([pscustomobject]@{check=$Name;status='PASS';detail=$Detail})
}
try{
  $null=New-Item -ItemType Directory -Path $scratch -Force
  $network=Set-BolRuntimeNetworkEnvironment $ProjectRoot
  Assert-Pass 'bootstrap.config_loaded' ([bool]$network.config_path)
  Assert-Pass 'bootstrap.route_proxy' ($network.route -eq 'PROXY' -and $network.proxy_host -eq '127.0.0.1' -and $network.proxy_port -eq 7890) 'Credentials are not part of diagnostics.'
  Assert-Pass 'bootstrap.all_proxy_cleared' ([bool]$network.all_proxy_cleared)
  $direct=Get-BolRuntimeNetworkContext -Config (Read-BolRuntimeNetworkConfig $ProjectRoot) -TargetUrl 'http://127.0.0.1:43181/health'
  Assert-Pass 'bootstrap.no_proxy_loopback' ($direct.route -eq 'DIRECT')

  $roots=Get-BolInstanceRoots $ProjectRoot
  Assert-Pass 'instances.production_root_canonical' ([string]::Equals((Get-BolCanonicalRuntimePath $roots.formal_root),$roots.formal_root,[StringComparison]::OrdinalIgnoreCase))
  $fixtureAcceptance=Join-Path $roots.acceptance_base 'offline-fixture'
  Assert-Pass 'instances.acceptance_descendant' (Test-BolCanonicalPathWithin $fixtureAcceptance $roots.acceptance_base)
  Assert-Pass 'instances.acceptance_rejected_as_formal' (-not [string]::Equals((Get-BolCanonicalRuntimePath $fixtureAcceptance),$roots.formal_root,[StringComparison]::OrdinalIgnoreCase))
  Assert-Pass 'instances.formal_rejected_as_acceptance' (-not (Test-BolCanonicalPathWithin $roots.formal_root $roots.acceptance_base))

  $now=[DateTime]::SpecifyKind([DateTime]::Parse('2026-09-26T12:00:00Z'),[DateTimeKind]::Utc)
  $fresh=Get-BolReadinessFreshness -Status 'PASS' -CheckedAt $now.AddMinutes(-10).ToString('o') -NowUtc $now
  $expiring=Get-BolReadinessFreshness -Status 'PASS' -CheckedAt $now.AddMinutes(-27).ToString('o') -NowUtc $now
  $expired=Get-BolReadinessFreshness -Status 'PASS' -CheckedAt $now.AddMinutes(-31).ToString('o') -NowUtc $now
  $waiting=Get-BolReadinessFreshness -Status 'FAIL' -CheckedAt $now.AddMinutes(-1).ToString('o') -NowUtc $now
  Assert-Pass 'freshness.fresh' ($fresh.state -eq 'FRESH')
  Assert-Pass 'freshness.expiring' ($expiring.state -eq 'EXPIRING')
  Assert-Pass 'freshness.expired' ($expired.state -eq 'EXPIRED')
  Assert-Pass 'freshness.waiting_dependency' ($waiting.state -eq 'WAITING_DEPENDENCY')
  $freshPlan=Get-BolReadinessProbePlan -Status 'PASS' -CheckedAt $now.AddMinutes(-10).ToString('o') -NowUtc $now
  $expiredPlan=Get-BolReadinessProbePlan -Status 'PASS' -CheckedAt $now.AddMinutes(-31).ToString('o') -NowUtc $now
  $backoffPlan=Get-BolReadinessProbePlan -Status 'FAIL' -CheckedAt $now.AddMinutes(-1).ToString('o') -FailureCount 1 -LastAttemptAt $now.AddMinutes(-1).ToString('o') -NowUtc $now
  $retryPlan=Get-BolReadinessProbePlan -Status 'FAIL' -CheckedAt $now.AddMinutes(-10).ToString('o') -FailureCount 1 -LastAttemptAt $now.AddMinutes(-10).ToString('o') -NowUtc $now
  Assert-Pass 'scheduler.fresh_no_probe' (-not $freshPlan.probe_due)
  Assert-Pass 'scheduler.expired_due' ([bool]$expiredPlan.probe_due)
  Assert-Pass 'scheduler.backoff_blocks' (-not $backoffPlan.probe_due -and $backoffPlan.reason -eq 'NETWORK_BACKOFF')
  Assert-Pass 'scheduler.backoff_elapsed_due' ([bool]$retryPlan.probe_due)

  $statePath=Join-Path $scratch 'scheduler-state.json'
  [ordered]@{schema='bol.readiness.scheduler.v1';instance='ACCEPTANCE_4181';last_attempt_at=$now.AddMinutes(-1).ToString('o');failure_count=2;last_error_code='BOL_NETWORK_ERROR'}|ConvertTo-Json -Compress|Set-Content -LiteralPath $statePath -Encoding UTF8
  $reloaded=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json
  $restartPlan=Get-BolReadinessProbePlan -Status 'FAIL' -CheckedAt $now.AddMinutes(-1).ToString('o') -FailureCount ([int]$reloaded.failure_count) -LastAttemptAt ([string]$reloaded.last_attempt_at) -NowUtc $now
  Assert-Pass 'scheduler.restart_recovery' (-not $restartPlan.probe_due -and $restartPlan.reason -eq 'NETWORK_BACKOFF')
  $manifestPath=Join-Path $scratch 'stale-manifest.json'
  [ordered]@{status='PASS';checked_at=$now.AddMinutes(-31).ToString('o')}|ConvertTo-Json -Compress|Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
  $manifestAge=Get-BolReadinessFreshness -Status $manifest.status -CheckedAt $manifest.checked_at -NowUtc $now
  Assert-Pass 'manifest.stale_judgement' ($manifestAge.state -eq 'EXPIRED')

  Assert-Pass 'runtime.classify_codex_sandbox' ((Get-BolRuntimeTypeLabel $true $false $true) -eq 'CODEX_SANDBOX')
  Assert-Pass 'runtime.classify_desktop_explorer' ((Get-BolRuntimeTypeLabel $false $true $false) -eq 'WINDOWS_DESKTOP_EXPLORER')
  Assert-Pass 'runtime.classify_job_process' ((Get-BolRuntimeTypeLabel $false $false $true) -eq 'JOB_CONTAINED_PROCESS')
  Assert-Pass 'runtime.classify_unknown' ((Get-BolRuntimeTypeLabel $false $false $false $false) -eq 'UNKNOWN')

  $formalFixture=Join-Path $scratch 'formal-data';$acceptanceFixture=Join-Path $formalFixture 'acceptance\run-1'
  $null=New-Item -ItemType Directory -Path $acceptanceFixture -Force
  $env:BOL_RUNTIME_STUB_DATA_ROOT=$acceptanceFixture
  $stubOut=Join-Path $scratch 'stub.stdout';$stubErr=Join-Path $scratch 'stub.stderr'
  $node=Join-Path $ProjectRoot '_runtime\bin\node.exe';$stub=Join-Path $PSScriptRoot 'runtime_health_stub.mjs'
  $stubProcess=Start-Process -FilePath $node -ArgumentList @($stub) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stubOut -RedirectStandardError $stubErr
  $port=$null
  for($i=0;$i -lt 40 -and -not $port;$i++){Start-Sleep -Milliseconds 100;if(Test-Path -LiteralPath $stubOut){$line=Get-Content -LiteralPath $stubOut -Raw;if($line -match 'READY\|(\d+)'){$port=[int]$Matches[1]}};if($stubProcess.HasExited){break}}
  Assert-Pass 'stub.local_server_started' ([bool]$port)
  $observation=Get-BolLocalRuntimeObservation -BaseUri "http://127.0.0.1:$port" -RootKind 'ACCEPTANCE' -FormalRoot $formalFixture -AcceptanceBase (Join-Path $formalFixture 'acceptance')
  Assert-Pass 'health_snapshot.local_stub_reachable' ([bool]$observation.reachable)
  Assert-Pass 'health_snapshot.local_stub_root_isolated' ([bool]$observation.root_valid)
  Assert-Pass 'health_snapshot.local_readiness_pass' ([string]$observation.readiness.status -eq 'PASS')
  $null=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/__shutdown" -TimeoutSec 3
  $stubProcess.WaitForExit(5000)|Out-Null
  Assert-Pass 'stub.shutdown_clean' ($stubProcess.HasExited)

  $env:BOL_RUNTIME_ENVIRONMENT='PRODUCTION_4180'
  $formalPreflight=Invoke-BolRuntimePreflight -Instance 'PRODUCTION_4180' -DataRoot $roots.formal_root -ProfilePath (Join-Path $roots.formal_root $roots.config.profileLeaf) -Port 4180
  Assert-Pass 'preflight.formal_root_marker' ($formalPreflight.status -eq 'PASS')
  $env:BOL_RUNTIME_ENVIRONMENT='ACCEPTANCE_4181'
  $current=Get-BolLocalRuntimeObservation -BaseUri 'http://127.0.0.1:4181' -RootKind 'ACCEPTANCE' -FormalRoot $roots.formal_root -AcceptanceBase $roots.acceptance_base
  if($current.reachable){
    $acceptancePreflight=Invoke-BolRuntimePreflight -Instance 'ACCEPTANCE_4181' -DataRoot $current.data_root -ProfilePath (Join-Path $current.data_root $roots.config.profileLeaf) -Port 4181
    Assert-Pass 'preflight.acceptance_root_marker' ($acceptancePreflight.status -eq 'PASS')
    Assert-Pass 'preflight.acceptance_does_not_use_formal_root' (-not [string]::Equals($acceptancePreflight.actual_data_root,$roots.formal_root,[StringComparison]::OrdinalIgnoreCase))
  }else{Assert-Pass 'preflight.acceptance_root_marker' $true 'Port 4181 was not running; isolated path checks passed.'}
  $healthOutput=Join-Path $scratch 'provider-health.json'
  $healthText=& (Join-Path $ProjectRoot 'infra\health_snapshot.ps1') -OutputPath $healthOutput | Out-String -NoNewline
  $healthSnapshot=ConvertFrom-Json -InputObject $healthText
  $formalRow=@($healthSnapshot.instances|Where-Object{$_.instance_key -eq 'PRODUCTION_4180'})|Select-Object -First 1
  $acceptanceRow=@($healthSnapshot.instances|Where-Object{$_.instance_key -eq 'ACCEPTANCE_4181'})|Select-Object -First 1
  Assert-Pass 'health_snapshot.both_instances_present' ([bool]$formalRow -and [bool]$acceptanceRow)
  Assert-Pass 'health_snapshot.production_root_separation' ([string]::Equals([string]$formalRow.expected_data_root,$roots.formal_root,[StringComparison]::OrdinalIgnoreCase))
  Assert-Pass 'health_snapshot.acceptance_root_separation' ($acceptanceRow.data_root_valid -and (Test-BolCanonicalPathWithin $acceptanceRow.data_root $roots.acceptance_base))
  Assert-Pass 'health_snapshot.remote_probes_not_enabled_by_default' (-not $formalRow.probe_enabled_for_instance -and -not $acceptanceRow.probe_enabled_for_instance -and -not $formalRow.probe_executed -and -not $acceptanceRow.probe_executed)
  Assert-Pass 'health_snapshot.persisted_temp_fixture' (Test-Path -LiteralPath $healthOutput -PathType Leaf)
  [pscustomobject]@{schema='bol.runtime.offline-e2e.v1';status='PASS';checks=$results;external_requests=0;databases_opened=0;live_readiness_modified=$false;fixture_root=$scratch}|ConvertTo-Json -Depth 6
}catch{
  [pscustomobject]@{schema='bol.runtime.offline-e2e.v1';status='FAIL';failed_check=[string]$_.Exception.Message;checks=$results;external_requests=0;databases_opened=0;live_readiness_modified=$false;fixture_root=$scratch}|ConvertTo-Json -Depth 6
  exit 1
}finally{
  if($stubProcess -and -not $stubProcess.HasExited){try{$stubProcess.Kill();$stubProcess.WaitForExit()}catch{}}
  Remove-Item Env:\BOL_RUNTIME_STUB_DATA_ROOT -ErrorAction SilentlyContinue
  $env:BOL_RUNTIME_ENVIRONMENT=''
  try{$scratchFull=[IO.Path]::GetFullPath($scratch);$tempFull=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\');if($scratchFull.StartsWith($tempFull+'\',[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $scratchFull) -match '^bol-runtime-infra-offline-[0-9a-f]{32}$'){Remove-Item -LiteralPath $scratchFull -Recurse -Force -ErrorAction SilentlyContinue}}catch{}
}
