param(
  [Parameter(Mandatory=$true)][ValidateSet('status','navigate','get_dom_snapshot','get_page_data','query_selector','find_text','click_readonly','scroll','get_network_metadata')][string]$BridgeCommand,
  [string]$ArgumentsJson='{}',
  [string]$BridgeRoot=$env:BOL_ACCEPTANCE_BRIDGE_ROOT,
  [string]$DataRoot,
  [string]$PersistPath,
  [int]$TimeoutSeconds=30
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($BridgeRoot)
$inbox=Join-Path $root 'inbox'
$outbox=Join-Path $root 'outbox'
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
    if($response.ok -and $BridgeCommand -eq 'get_page_data' -and $PersistPath){
      if(-not $DataRoot){throw 'DATA_ROOT_REQUIRED_FOR_PERSISTENCE'}
      . (Join-Path $PSScriptRoot 'amazon_page_probe_capture.ps1')
      $saved=Save-AmazonPageProbeResult -Result $response.result -ExpectedAsin ([string]$argsObject.expected_asin) -DataRoot $DataRoot -OutputPath $PersistPath
      $response | Add-Member -NotePropertyName persisted_path -NotePropertyValue $saved -Force
    }
    $response | ConvertTo-Json -Depth 12 -Compress
    if(-not $response.ok){exit 2}
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
Remove-Item -LiteralPath $commandPath -Force -ErrorAction SilentlyContinue
throw 'BRIDGE_RESPONSE_TIMEOUT'
