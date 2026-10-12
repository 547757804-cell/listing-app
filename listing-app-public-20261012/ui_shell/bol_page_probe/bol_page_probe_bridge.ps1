param(
  [Parameter(Mandatory=$true)][ValidateSet('status','navigate','get_dom_snapshot','get_page_data','query_selector','find_text','click_readonly','scroll','get_network_metadata')][string]$BridgeCommand,
  [string]$ArgumentsJson='{}',
  [string]$BridgeRoot,
  [int]$TimeoutSeconds=30
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$probeRoot=Join-Path $projectRoot ('BOL'+[char]0x6570+[char]0x636e+'\'+[char]0x9a8c+[char]0x6536+'E2E\BOL_PAGE_PROBE_BROWSER')
. (Join-Path $PSScriptRoot 'bol_page_probe_bridge_paths.ps1')
$bridgePaths=Resolve-BolPageProbeBridgePaths -ProbeRoot $probeRoot -BridgeRoot $BridgeRoot
$root=$bridgePaths.root
$inbox=$bridgePaths.inbox
$outbox=$bridgePaths.outbox
if(-not (Test-Path -LiteralPath $inbox -PathType Container) -or -not (Test-Path -LiteralPath $outbox -PathType Container)){throw 'BRIDGE_NOT_RUNNING_OR_NOT_INITIALIZED'}
try{$argsObject=$ArgumentsJson | ConvertFrom-Json -ErrorAction Stop}catch{throw 'ARGUMENTS_JSON_INVALID'}
if($null -eq $argsObject -or $argsObject -is [string] -or $argsObject -is [ValueType]){throw 'ARGUMENTS_MUST_BE_JSON_OBJECT'}
$id=[Guid]::NewGuid().ToString('N')
$commandPath=Join-Path $inbox ($id+'.json')
$responsePath=Join-Path $outbox ($id+'.json')
$temporaryPath=$commandPath+'.tmp'
$request=[ordered]@{id=$id;command=$BridgeCommand;args=$argsObject}
$payload=$request | ConvertTo-Json -Depth 12 -Compress
[IO.File]::WriteAllText($temporaryPath,$payload,(New-Object System.Text.UTF8Encoding($false)))
[IO.File]::Move($temporaryPath,$commandPath)
$deadline=[DateTime]::UtcNow.AddSeconds([Math]::Max(2,[Math]::Min(120,$TimeoutSeconds)))
while([DateTime]::UtcNow -lt $deadline){
  if(Test-Path -LiteralPath $responsePath -PathType Leaf){
    try{$response=Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop}
    finally{Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue}
    $response | ConvertTo-Json -Depth 12 -Compress
    if(-not $response.ok){exit 2}
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
Remove-Item -LiteralPath $commandPath -Force -ErrorAction SilentlyContinue
throw 'BRIDGE_RESPONSE_TIMEOUT'
