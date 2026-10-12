$ErrorActionPreference = 'Stop'
$projectRoot = $env:BOL_AUTO_ROOT
$runtimeRoot = Join-Path $projectRoot 'BOL数据\验收E2E\AMAZON_PAGE_PROBE_BROWSER'
$profile = Join-Path $runtimeRoot 'profile-SYNTHETIC1'
$bridgeRoot = Join-Path $runtimeRoot 'bridge'
$logs = Join-Path $runtimeRoot 'logs'
$audit = Join-Path $logs 'amazon-page-probe.jsonl'
$runtimeManifest = Join-Path $runtimeRoot 'amazon-page-probe-runtime.json'
$url = 'https://www.amazon.de/dp/SYNTHETIC1'
$shellDir = Join-Path $projectRoot 'ui_shell\amazon_page_probe'
$exe = Join-Path $shellDir 'bin\AmazonPageProbeShell.exe'
$bootstrap = Join-Path $projectRoot 'infra\runtime_network_bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'NETWORK_BOOTSTRAP_MISSING' }
. $bootstrap
$networkConfig = Read-BolRuntimeNetworkConfig -ProjectRoot $projectRoot
if (-not $networkConfig.enabled) { throw 'PROJECT_PROXY_DISABLED' }
$null = Set-BolRuntimeNetworkEnvironment -ProjectRoot $projectRoot
$route = Get-BolRuntimeNetworkContext -Config $networkConfig -TargetUrl $url
if ($route.route -ne 'PROXY' -or $route.proxy_host -ne '127.0.0.1' -or $route.proxy_port -ne 7890) { throw 'PROJECT_PROXY_ROUTE_MISMATCH' }
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'BOL数据\验收E2E')).TrimEnd('\')
$actualRoot = [IO.Path]::GetFullPath($runtimeRoot)
if (-not $actualRoot.StartsWith($expectedRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'AMAZON_PROBE_ROOT_OUTSIDE_ACCEPTANCE' }
if ($actualRoot -match 'BOL_PAGE_PROBE_BROWSER|boloo') { throw 'AMAZON_PROFILE_MUST_BE_INDEPENDENT' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or (Get-Item -LiteralPath (Join-Path $shellDir 'AmazonPageProbeShell.cs')).LastWriteTimeUtc -gt (Get-Item -LiteralPath $exe).LastWriteTimeUtc) {
  & (Join-Path $shellDir 'build_amazon_page_probe.ps1') -OutputName 'bin'
  if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'SHELL_BINARY_MISSING' }
$owners = @(Get-Process -Name AmazonPageProbeShell -ErrorAction SilentlyContinue)
if ($owners) { throw 'AMAZON_ISOLATED_PROFILE_ALREADY_IN_USE' }
New-Item -ItemType Directory -Path $profile,$logs,(Join-Path $bridgeRoot 'inbox'),(Join-Path $bridgeRoot 'outbox') -Force | Out-Null
function Quote-Argument([string]$value) { if ($value -notmatch '[\s"]') { return $value }; return '"' + ($value -replace '(\\*)"','$1$1\"' -replace '(\\+)$','$1$1') + '"' }
$args = @('--profile',$profile,'--audit',$audit,'--url',$url,'--proxy',$networkConfig.https_proxy,'--proxy-bypass',$networkConfig.no_proxy,'--bridge-root',$bridgeRoot,'--runtime-manifest',$runtimeManifest,'--expected-asin','SYNTHETIC1')
$argLine = (($args | ForEach-Object { Quote-Argument $_ }) -join ' ')
$process = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru -WorkingDirectory $shellDir
[pscustomobject]@{status='STARTED';pid=$process.Id;binary=$exe;profile=$profile;bridge_root=$bridgeRoot;runtime_manifest=$runtimeManifest;url=$url;route=$route.route;proxy_host=$route.proxy_host;proxy_port=$route.proxy_port;runtime_mode='DESKTOP_READ_ONLY'} | ConvertTo-Json -Compress
