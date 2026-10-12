Set-StrictMode -Version Latest

function Get-AmazonProbePlainValue($Node) {
  if ($null -eq $Node) { return $null }
  if ($Node -is [string] -or $Node -is [ValueType]) { return $Node }
  if ($Node -is [System.Collections.IDictionary]) {
    $out = [ordered]@{}
    foreach ($key in $Node.Keys) {
      if ([string]$key -match '(?i)(cookie|authorization|password|secret|token|csrf|request.?body|response.?body|email|headers|credential)') { continue }
      $out[[string]$key] = Get-AmazonProbePlainValue $Node[$key]
    }
    return $out
  }
  if ($Node -is [System.Collections.IEnumerable]) {
    $items = @()
    foreach ($item in $Node) { $items += ,(Get-AmazonProbePlainValue $item) }
    return ,$items
  }
  $out = [ordered]@{}
  foreach ($prop in $Node.PSObject.Properties) {
    if ($prop.Name -match '(?i)(cookie|authorization|password|secret|token|csrf|request.?body|response.?body|email|headers|credential)') { continue }
    $out[$prop.Name] = Get-AmazonProbePlainValue $prop.Value
  }
  return $out
}

function Test-AmazonProbeIdentity($Result,[string]$ExpectedAsin) {
  $asin = $ExpectedAsin.ToUpperInvariant()
  if ($asin -notmatch '^[A-Z0-9]{10}$') { throw 'EXPECTED_ASIN_INVALID' }
  if ($Result.schema -ne 'AMAZON_PAGE_PROBE_PERSISTED_RESULT' -or $Result.result_status -ne 'PASS') { throw 'PAGE_PROBE_RESULT_NOT_PASS' }
  $identity = $Result.identity
  $requested = [string]$identity.requested_asin.value
  $canonical = [string]$identity.canonical_asin.value
  $url = [string]$identity.canonical_url.value
  $urlAsin = $null
  if ($url -match '/(?:dp|gp/product)/([A-Z0-9]{10})(?:/|$)') { $urlAsin = $Matches[1].ToUpperInvariant() }
  if ($identity.marketplace.value -ne 'Amazon.de' -or $requested.ToUpperInvariant() -ne $asin -or $canonical.ToUpperInvariant() -ne $asin -or $identity.asin_match.value -ne $true -or $urlAsin -ne $asin) { throw 'AMAZON_ASIN_IDENTITY_MISMATCH' }
  return $true
}

function Save-AmazonPageProbeResult($Result,[string]$ExpectedAsin,[string]$DataRoot,[string]$OutputPath) {
  $null = Test-AmazonProbeIdentity $Result $ExpectedAsin
  $root = [IO.Path]::GetFullPath($DataRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  $acceptanceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'BOL数据\验收E2E')).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not $root.StartsWith($acceptanceRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'DATA_ROOT_OUTSIDE_ACCEPTANCE' }
  $captureRoot = [IO.Path]::GetFullPath((Join-Path $root 'integrations\amazon-page-probes')).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $target = [IO.Path]::GetFullPath($OutputPath)
  if (-not $target.StartsWith($captureRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'CAPTURE_PATH_OUTSIDE_ALLOWED_ROOT' }
  $safe = Get-AmazonProbePlainValue $Result
  $safe['safety'] = [ordered]@{amazon_login_performed=$false;cookie_values_saved=$false;authorization_saved=$false;request_response_bodies_saved=$false}
  $safe['persisted_at'] = [DateTime]::UtcNow.ToString('o')
  $safe['identity']['requested_asin']['value'] = $ExpectedAsin.ToUpperInvariant()
  $dir = Split-Path -Parent $target
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $temp = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $json = $safe | ConvertTo-Json -Depth 30
  [IO.File]::WriteAllText($temp,$json,(New-Object System.Text.UTF8Encoding($false)))
  if ([IO.File]::Exists($target)) { Remove-Item -LiteralPath $temp -Force; throw 'CAPTURE_TARGET_ALREADY_EXISTS' }
  [IO.File]::Move($temp,$target)
  $readback = Get-Content -LiteralPath $target -Raw -Encoding UTF8 | ConvertFrom-Json
  $null = Test-AmazonProbeIdentity $readback $ExpectedAsin
  if ($readback.safety.cookie_values_saved -ne $false -or $readback.safety.authorization_saved -ne $false -or $readback.safety.request_response_bodies_saved -ne $false) { throw 'PERSISTED_SAFETY_GATE_FAILED' }
  return $target
}
