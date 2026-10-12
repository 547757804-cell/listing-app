param([switch]$Build)
$ErrorActionPreference = 'Stop'
$projectRoot = $env:BOL_AUTO_ROOT
$acceptanceParent = Join-Path $projectRoot 'BOL数据\验收E2E'
$probeRoot = Join-Path $acceptanceParent 'BOL_PAGE_PROBE_BROWSER'
$profile = Join-Path $probeRoot 'profile-9000000000000001'
$bridgeRoot = Join-Path $probeRoot 'bridge'
$logs = Join-Path $probeRoot 'logs'
$audit = Join-Path $logs 'bol-page-probe.jsonl'
$productUrl = 'https://www.bol.com/nl/nl/p/kleine-kerstcadeauzakjes-van-kraftpapier-12-stuks-met-stickers-voor-gastcadeaus-en-geschenken/9000000000000001/'
$shellDir = Join-Path $projectRoot 'ui_shell\bol_page_probe'
$exe = Join-Path $shellDir 'bin_bridge_v2\BolPageProbeShell.exe'
$bootstrap = Join-Path $projectRoot 'infra\runtime_network_bootstrap.ps1'

$expectedRoot = [IO.Path]::GetFullPath($acceptanceParent).TrimEnd('\')
$actualRoot = [IO.Path]::GetFullPath($probeRoot)
if (-not $actualRoot.StartsWith($expectedRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'PROBE_DATA_ROOT_OUTSIDE_ACCEPTANCE' }
$productionRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'BOL数据')).TrimEnd('\')
if ($actualRoot.StartsWith(($productionRoot + '\'),[StringComparison]::OrdinalIgnoreCase) -and $actualRoot.IndexOf('\验收E2E\',[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'PROBE_ROOT_MUST_NOT_BE_PRODUCTION' }
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'NETWORK_BOOTSTRAP_MISSING' }
. $bootstrap
$networkConfig = Read-BolRuntimeNetworkConfig -ProjectRoot $projectRoot
$route = Set-BolRuntimeNetworkEnvironment -ProjectRoot $projectRoot
if ($route.route -ne 'PROXY' -or $route.proxy_host -ne '127.0.0.1' -or $route.proxy_port -ne 7890) { throw 'PROJECT_PROXY_ROUTE_MISMATCH' }

function Test-BolProjectProxyListener([string]$HostName,[int]$Port,[int]$TimeoutMs=1500) {
  $client = New-Object System.Net.Sockets.TcpClient
  $async = $null
  try {
    $async = $client.BeginConnect($HostName,$Port,$null,$null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $client.Connected
  } catch { return $false }
  finally {
    if ($async -and $async.AsyncWaitHandle) { $async.AsyncWaitHandle.Close() }
    $client.Close()
  }
}

if (-not (Test-BolProjectProxyListener $route.proxy_host ([int]$route.proxy_port))) { throw 'PROJECT_PROXY_LISTENER_UNAVAILABLE' }

if ($Build -or -not (Test-Path -LiteralPath $exe -PathType Leaf) -or (Get-Item -LiteralPath (Join-Path $shellDir 'BolPageProbeShell.cs')).LastWriteTimeUtc -gt (Get-Item -LiteralPath $exe).LastWriteTimeUtc -or (Get-Item -LiteralPath (Join-Path $shellDir 'bol_page_data_contract.js')).LastWriteTimeUtc -gt (Get-Item -LiteralPath $exe).LastWriteTimeUtc) {
  & (Join-Path $shellDir 'build_bol_page_probe.ps1') -OutputName 'bin_bridge_v2'
  if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'SHELL_BINARY_MISSING' }
New-Item -ItemType Directory -Path $profile,$logs,(Join-Path $bridgeRoot 'inbox'),(Join-Path $bridgeRoot 'outbox') -Force | Out-Null
$owners = @(Get-Process -Name BolPageProbeShell -ErrorAction SilentlyContinue)
if ($owners) { throw 'ISOLATED_PROFILE_ALREADY_IN_USE' }

function Quote-Argument([string]$value) {
  if ($value -notmatch '[\s"]') { return $value }
  return '"' + ($value -replace '(\\*)"','$1$1\"' -replace '(\\+)$','$1$1') + '"'
}
$args = @('--profile',$profile,'--audit',$audit,'--url',$productUrl,'--proxy',$networkConfig.https_proxy,'--proxy-bypass',$networkConfig.no_proxy,'--bridge-root',$bridgeRoot)
$argLine = (($args | ForEach-Object { Quote-Argument $_ }) -join ' ')
$process = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru -WorkingDirectory $shellDir
[pscustomobject]@{
  status='STARTED'
  pid=$process.Id
  shell='WebView2 WinForms isolated BOL page probe'
  profile=$profile
  audit=$audit
  bridge_root=$bridgeRoot
  url=$productUrl
  route=$route.route
  proxy_host=$route.proxy_host
  proxy_port=$route.proxy_port
  proxy_listener='PASS'
  runtime_mode='DESKTOP_READ_ONLY'
} | ConvertTo-Json -Compress
