function Get-BolCanonicalRuntimePath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'BOL_RUNTIME_PATH_REQUIRED' }
  $nfc = $Value.Normalize([System.Text.NormalizationForm]::FormC)
  $full = [System.IO.Path]::GetFullPath($nfc)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char[]]@([char]92,[char]47)) }
  return $full
}

function Read-BolRuntimeNetworkConfig([string]$ProjectRoot) {
  $root = Get-BolCanonicalRuntimePath $ProjectRoot
  $file = Join-Path $root 'infra\bol-network-proxy.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'BOL_PROXY_CONFIG_MISSING' }
  try { $config = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'BOL_PROXY_CONFIG_INVALID_JSON' }
  if ($null -eq $config.enabled -or $config.enabled -isnot [bool]) { throw 'BOL_PROXY_CONFIG_ENABLED_REQUIRED' }
  if ($null -eq $config.noProxy -or $config.noProxy -isnot [string]) { throw 'BOL_PROXY_CONFIG_NO_PROXY_REQUIRED' }
  $http = $null
  $https = $null
  if ($config.enabled) {
    $http = ConvertTo-BolRuntimeProxyUri ([string]$config.httpProxy) 'HTTP'
    $https = ConvertTo-BolRuntimeProxyUri ([string]$config.httpsProxy) 'HTTPS'
  }
  [pscustomobject]@{
    enabled = [bool]$config.enabled
    project_root = $root
    config_path = $file
    http_proxy = $http
    https_proxy = $https
    no_proxy = [string]$config.noProxy
  }
}

function ConvertTo-BolRuntimeProxyUri([string]$Value, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "BOL_PROXY_CONFIG_INVALID_$Name" }
  $parsed = $null
  if (-not [Uri]::TryCreate($Value.Trim(),[UriKind]::Absolute,[ref]$parsed)) { throw "BOL_PROXY_CONFIG_INVALID_$Name" }
  if ($parsed.Scheme -notin @('http','https') -or -not $parsed.Host -or $parsed.Port -lt 1 -or
      $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment -or $parsed.AbsolutePath -ne '/') {
    throw "BOL_PROXY_CONFIG_INVALID_$Name"
  }
  return $parsed.GetLeftPart([UriPartial]::Authority)
}

function Set-BolRuntimeNetworkEnvironment([string]$ProjectRoot) {
  $config = Read-BolRuntimeNetworkConfig $ProjectRoot
  foreach ($name in @('HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy')) {
    Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
  }
  if ($config.enabled) {
    $env:HTTP_PROXY = $config.http_proxy
    $env:http_proxy = $config.http_proxy
    $env:HTTPS_PROXY = $config.https_proxy
    $env:https_proxy = $config.https_proxy
  }
  $env:NO_PROXY = $config.no_proxy
  $env:no_proxy = $config.no_proxy
  return Get-BolRuntimeNetworkContext -Config $config -TargetUrl 'https://login.bol.com'
}

function Test-BolNoProxyHost([string]$HostName,[string]$NoProxy) {
  $hostValue = $HostName.TrimEnd('.').ToLowerInvariant()
  foreach ($raw in ($NoProxy -split ',')) {
    $rule = $raw.Trim().ToLowerInvariant()
    if (-not $rule) { continue }
    if ($rule -eq '*') { return $true }
    $literalRule=$rule.Trim('[',']')
    if ($hostValue -eq $literalRule) { return $true }
    $ip=$null
    if ([Net.IPAddress]::TryParse($literalRule,[ref]$ip)) { continue }
    if ($rule.Contains(':')) { continue }
    if ($rule.StartsWith('*.')) { $rule = $rule.Substring(2) }
    if ($rule.StartsWith('.')) { $rule = $rule.Substring(1) }
    if ($hostValue -eq $rule -or $hostValue.EndsWith('.' + $rule)) { return $true }
  }
  return $false
}

function Get-BolRuntimeNetworkContext([object]$Config,[string]$TargetUrl) {
  $target = $null
  if (-not [Uri]::TryCreate($TargetUrl,[UriKind]::Absolute,[ref]$target)) { throw 'BOL_ROUTE_TARGET_INVALID' }
  $proxy = if ($target.Scheme -eq 'https') { $Config.https_proxy } else { $Config.http_proxy }
  $route = 'DIRECT'
  $proxyHost = $null
  $proxyPort = $null
  if ($Config.enabled -and -not (Test-BolNoProxyHost $target.Host $Config.no_proxy) -and $proxy) {
    $route = 'PROXY'
    $parsedProxy = [Uri]$proxy
    $proxyHost = $parsedProxy.Host
    $proxyPort = $parsedProxy.Port
  }
  [pscustomobject]@{
    config_path = $Config.config_path
    enabled = [bool]$Config.enabled
    config_enabled = [bool]$Config.enabled
    target_host = $target.Host
    route = $route
    proxy_host = $proxyHost
    proxy_port = $proxyPort
    http_proxy_host = if($Config.enabled){([Uri]$Config.http_proxy).Host}else{$null}
    http_proxy_port = if($Config.enabled){([Uri]$Config.http_proxy).Port}else{$null}
    https_proxy_host = if($Config.enabled){([Uri]$Config.https_proxy).Host}else{$null}
    https_proxy_port = if($Config.enabled){([Uri]$Config.https_proxy).Port}else{$null}
    all_proxy_cleared = [string]::IsNullOrEmpty($env:ALL_PROXY) -and [string]::IsNullOrEmpty($env:all_proxy)
    http_proxy_present = -not [string]::IsNullOrEmpty($env:HTTP_PROXY)
    https_proxy_present = -not [string]::IsNullOrEmpty($env:HTTPS_PROXY)
    no_proxy_rule_count = @($Config.no_proxy -split ',' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
  }
}

# Compatibility entrypoint; all proxy parsing and environment mutation stays in this module.
function Set-BolProjectProxyEnvironment([string]$ProjectRoot) {
  return Set-BolRuntimeNetworkEnvironment $ProjectRoot
}
