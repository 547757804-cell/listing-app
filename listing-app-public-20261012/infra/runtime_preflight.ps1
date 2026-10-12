function Invoke-BolRuntimePreflight {
  param(
    [Parameter(Mandatory=$true)][ValidateSet('PRODUCTION_4180','ACCEPTANCE_4181')][string]$Instance,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [Parameter(Mandatory=$true)][string]$ProfilePath,
    [Parameter(Mandatory=$true)][int]$Port
  )
  $projectRoot=Get-BolCanonicalRuntimePath (Join-Path $PSScriptRoot '..')
  $roots=Get-BolInstanceRoots $projectRoot
  $actual=Get-BolCanonicalRuntimePath $DataRoot
  $formal=$Instance -eq 'PRODUCTION_4180'
  $rootValid=if($formal){[string]::Equals($actual,$roots.formal_root,[StringComparison]::OrdinalIgnoreCase)}else{(Test-BolCanonicalPathWithin $actual $roots.acceptance_base) -and -not [string]::Equals($actual,$roots.formal_root,[StringComparison]::OrdinalIgnoreCase)}
  if($actual -match '(?i)(^|\\)legacy_external_project(\\|$)|^D:\\LEGACY_EXTERNAL_PROJECT_ROOT(\\|$)'){$rootValid=$false}
  $marker=[string]$env:BOL_RUNTIME_ENVIRONMENT
  $markerExpected=if($formal){'PRODUCTION_4180'}else{'ACCEPTANCE_4181'}
  $markerOk=$marker -eq $markerExpected
  $reparse=$false
  try { $item=Get-Item -LiteralPath $actual -Force -ErrorAction Stop; $reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint) } catch { }
  $profile=Get-BolCanonicalRuntimePath $ProfilePath
  $profileValid=(Test-BolCanonicalPathWithin $profile $actual) -and -not [string]::Equals($profile,$actual,[StringComparison]::OrdinalIgnoreCase)
  $profileReparse=$false
  if(Test-Path -LiteralPath $profile){try{$pi=Get-Item -LiteralPath $profile -Force;$profileReparse=[bool]($pi.Attributes -band [IO.FileAttributes]::ReparsePoint)}catch{}}
  $sqlitePath=Join-Path $actual $roots.config.sqliteLeaf
  $logsPath=Join-Path $actual $roots.config.logsLeaf
  $rootAccessible=Test-Path -LiteralPath $actual -PathType Container
  $logsAccessible=if(Test-Path -LiteralPath $logsPath){Test-Path -LiteralPath $logsPath -PathType Container}else{$rootAccessible}
  $sqliteDirectoryAccessible=$rootAccessible -and ([string]::Equals((Get-BolCanonicalRuntimePath (Split-Path -Parent $sqlitePath)),$actual,[StringComparison]::OrdinalIgnoreCase))
  $portPid=$null
  try { $conn=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1; if($conn){$portPid=[int]$conn.OwningProcess} } catch {
    try { $line=netstat -ano -p tcp | Select-String -Pattern (':'+$Port+'\s+.*LISTENING\s+(\d+)\s*$') | Select-Object -First 1; if($line -and $line.Matches[0].Groups[1].Value){$portPid=[int]$line.Matches[0].Groups[1].Value} } catch { }
  }
  $portOwnerRoot=$null
  if($portPid){try{$dash=Invoke-BolDirectLoopbackJson -Uri "http://127.0.0.1:$Port/api/dashboard";$portOwnerRoot=Get-BolCanonicalRuntimePath ([string]$dash.data_root)}catch{}}
  $portMatches=if(-not $portPid){$true}else{[string]::Equals($portOwnerRoot,$actual,[StringComparison]::OrdinalIgnoreCase)}
  $network=Read-BolRuntimeNetworkConfig $projectRoot
  $route=Get-BolRuntimeNetworkContext -Config $network -TargetUrl 'https://login.bol.com'
  $checks=[ordered]@{
    data_root_valid=[bool]$rootValid
    data_root_exists=[bool]$rootAccessible
    data_root_not_reparse_point=(-not $reparse)
    environment_marker_valid=[bool]$markerOk
    proxy_config_read=[bool]$network.config_path
    provider_route=$route.route
    provider_proxy_host=$route.proxy_host
    provider_proxy_port=$route.proxy_port
    sqlite_directory_accessible=[bool]$sqliteDirectoryAccessible
    sqlite_file_exists=[bool](Test-Path -LiteralPath $sqlitePath -PathType Leaf)
    logs_directory_accessible=[bool]$logsAccessible
    profile_path_valid=[bool]($profileValid -and -not $profileReparse)
    port=$Port
    port_occupied=[bool]$portPid
    port_pid=$portPid
    port_data_root_matches=[bool]$portMatches
  }
  $required=@('data_root_valid','data_root_exists','data_root_not_reparse_point','environment_marker_valid','proxy_config_read','sqlite_directory_accessible','logs_directory_accessible','profile_path_valid','port_data_root_matches')
  $failed=@($required | Where-Object { -not [bool]$checks[$_] })
  [pscustomobject]@{
    schema='bol.runtime.preflight.v1'
    checked_at_utc=[DateTime]::UtcNow.ToString('o')
    instance=$Instance
    status=if($failed.Count){'FAIL'}else{'PASS'}
    failure_codes=$failed
    expected_port=$Port
    expected_environment_marker=$markerExpected
    actual_environment_marker=$marker
    expected_data_root=if($formal){$roots.formal_root}else{$roots.acceptance_base}
    actual_data_root=$actual
    profile_path=$profile
    proxy_config_path=$network.config_path
    checks=$checks
    runtime_context=(Get-BolRuntimeContext)
  }
}
