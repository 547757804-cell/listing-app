[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$TaskDataRoot,
  [ValidateRange(5,180)][int]$TimeoutSeconds = 80
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $env:BOL_AUTO_ROOT
$FormalDataRoot = Join-Path $ProjectRoot 'BOL数据'
$Integrations = Join-Path $FormalDataRoot 'integrations'
$OwnerManifest = Join-Path $Integrations 'boloo-pane-owner.json'
$RegistrationPath = Join-Path $Integrations 'boloo-pane-runtime.json'
$ExpectedProfile = Join-Path $FormalDataRoot 'webview\boloo'
$ExpectedBinary = Join-Path $ProjectRoot 'ui_shell\boloo_test\bin_pane_owner\BolooWorkbenchTestShell.exe'
$ExpectedBridge = Join-Path $Integrations 'boloo-pane-bridge'
. (Join-Path $ProjectRoot 'ui_shell\boloo_test\pane_runtime_core.ps1')
$TaskDataRoot = Get-BolPaneCanonicalPath $TaskDataRoot

$AcceptanceRoot = Get-BolPaneCanonicalPath (Join-Path $FormalDataRoot '验收E2E')
if (-not $TaskDataRoot.StartsWith($AcceptanceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'PANE_TASK_DATA_ROOT_OUTSIDE_ACCEPTANCE'
}

function Test-PaneOwner([string]$ManifestPath) {
  $observation = Get-BolPaneRuntimeObservation $ManifestPath $ExpectedBinary $ExpectedProfile
  if ($observation.readiness -ne 'READY') { throw ('PANE_OWNER_NOT_READY:' + [string]$observation.error_code) }
  $manifest = $observation.manifest
  if (-not [string]::Equals((Get-BolPaneCanonicalPath ([string]$manifest.data_root)), (Get-BolPaneCanonicalPath $FormalDataRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'PANE_OWNER_DATA_ROOT_MISMATCH' }
  if (-not [string]::Equals((Get-BolPaneCanonicalPath ([string]$manifest.bridge_root)), (Get-BolPaneCanonicalPath $ExpectedBridge), [StringComparison]::OrdinalIgnoreCase)) { throw 'PANE_SHARED_BRIDGE_ROOT_MISMATCH' }
  return $observation
}

$owner = Test-PaneOwner $OwnerManifest
$attachmentPath = Join-Path $TaskDataRoot 'integrations\boloo-pane-runtime.json'
$attachment = Get-Content -LiteralPath $attachmentPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
$attachmentMismatch = $attachment.schema -ne 'boloo.pane-task-attachment.v1'
$attachmentMismatch = $attachmentMismatch -or ([int]$attachment.owner_pid -ne [int]$owner.pid)
$attachmentMismatch = $attachmentMismatch -or (-not [string]::Equals((Get-BolPaneCanonicalPath ([string]$attachment.task_data_root)), $TaskDataRoot, [StringComparison]::OrdinalIgnoreCase))
$attachmentMismatch = $attachmentMismatch -or (-not [string]::Equals((Get-BolPaneCanonicalPath ([string]$attachment.owner_manifest)), (Get-BolPaneCanonicalPath $OwnerManifest), [StringComparison]::OrdinalIgnoreCase))
$attachmentMismatch = $attachmentMismatch -or (-not [string]::Equals((Get-BolPaneCanonicalPath ([string]$attachment.bridge_root)), (Get-BolPaneCanonicalPath $ExpectedBridge), [StringComparison]::OrdinalIgnoreCase))
if ($attachmentMismatch) {
  throw 'PANE_TASK_ATTACHMENT_MISMATCH'
}

$requestId = [guid]::NewGuid().ToString()
$script = @'
(()=>{
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
 const nodes=[...document.querySelectorAll('a,button,[role=button],nav,main,[role=main],#root')].filter(visible);
 const label=e=>(e.innerText||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().toLowerCase();
 const body=(document.body?.innerText||'').toLowerCase();
 const loginFormVisible=[...document.querySelectorAll('input[type=password],form')].some(e=>visible(e)&&(/password|wachtwoord|inloggen|login|sign in/.test(label(e)+' '+(e.innerText||'').toLowerCase())||e.querySelector('input[type=password]')));
 const appShellVisible=nodes.some(e=>e.matches('main,[role=main],#root,nav'))||body.includes('keyword explorer')||body.includes('zoekwoorden');
 const explorerEntryVisible=nodes.some(e=>/keyword explorer|keyword[- ]?verkenner|zoekwoorden verkennen|keyword research/.test(label(e)));
 const u=new URL(location.href);
 return {status:'READ_ONLY_STATUS',host:u.host,path:u.pathname,title:document.title,readyState:document.readyState,loginFormVisible,appShellVisible,explorerEntryVisible};
})()
'@
$responsePath = Join-Path $TaskDataRoot ('integrations\boloo-pane\outbox\response-' + $requestId + '.json')
$request = New-BolPaneBridgeRequestObject $TaskDataRoot 'script' $script $null $requestId
$inbox = Join-Path $ExpectedBridge 'inbox'
$requestPath = Join-Path $inbox ('pane-' + $requestId + '.json')
$null = New-Item -ItemType Directory -Path $inbox -Force
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $responsePath) -Force
if (Test-Path -LiteralPath $requestPath -PathType Leaf) { throw 'PANE_BRIDGE_REQUEST_ALREADY_EXISTS' }
$tempRequest = $requestPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
[IO.File]::WriteAllText($tempRequest,(ConvertTo-Json -InputObject $request -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempRequest -Destination $requestPath
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $responsePath -PathType Leaf)) {
  $owner = Test-PaneOwner $OwnerManifest
  Start-Sleep -Milliseconds 250
}
if (-not (Test-Path -LiteralPath $responsePath -PathType Leaf)) { throw 'PANE_READ_ONLY_STATUS_TIMEOUT' }
$response = Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ([string]$response.request_id -ne $requestId -or [string]$response.result.status -ne 'READ_ONLY_STATUS') {
  throw 'PANE_READ_ONLY_STATUS_RESPONSE_INVALID'
}
$owner = Test-PaneOwner $OwnerManifest
$result = $response.result
$checks = [ordered]@{
  webview2 = [bool]$owner.manifest.webview_initialized -and [string]$result.readyState -eq 'complete'
  explorer = [bool]$result.explorerEntryVisible
  login = [bool]$result.appShellVisible -and -not [bool]$result.loginFormVisible
  bridge = [bool]$owner.manifest.bridge_worker_started -and [bool]$owner.manifest.bridge_worker_heartbeat_at
}
$ready = @($checks.Values | Where-Object { $_ -ne $true }).Count -eq 0
$now = [DateTime]::UtcNow.ToString('o')
$startedValue = $owner.manifest.process_started_at_utc
$startedAtUtc = if ($startedValue -is [DateTime]) { $startedValue.ToUniversalTime().ToString('o') } elseif ($startedValue -is [DateTimeOffset]) { $startedValue.ToUniversalTime().ToString('o') } else { [DateTimeOffset]::Parse([string]$startedValue).ToUniversalTime().ToString('o') }
$process = Get-Process -Id ([int]$owner.pid) -ErrorAction Stop
$registration = [ordered]@{
  schema = 'boloo-pane-runtime-registration.v2'
  pid = [int]$owner.pid
  process_name = [string]$process.ProcessName
  process_started_at_utc = $startedAtUtc
  registered_at_utc = $now
  checked_at_utc = $now
  source = 'OFFICIAL_PANE_OWNER_READ_ONLY_BRIDGE_VERIFICATION'
  claimed_readiness = if ($ready) { 'READY' } else { 'NOT_READY' }
  profile_path = [string]$owner.manifest.profile_path
  bridge_root = [string]$owner.manifest.bridge_root
  task_data_root = $TaskDataRoot
  desktop_session_id = [int]$owner.manifest.desktop_session_id
  windows_user = [string]$owner.manifest.windows_user
  checks = $checks
  status_request_id = $requestId
  status_response_id = [string]$response.request_id
  status_evidence_ref = $responsePath
  current_page_host = [string]$result.host
  current_page_path = [string]$result.path
  page_title = [string]$result.title
  ready_state = [string]$result.readyState
  formal_keyword_query_submitted = $false
  external_business_request_count = 0
  error_code = if ($ready) { $null } else { 'PANE_ACCEPTANCE_CHECK_INCOMPLETE' }
}
Write-BolPaneManifestAtomic $RegistrationPath $registration

[pscustomobject]@{
  status = if ($ready) { 'READY' } else { 'NOT_READY' }
  pid = [int]$owner.pid
  process_started_at_utc = $startedAtUtc
  owner_identity = 'VERIFIED'
  task_attachment = 'MATCH'
  checks = $checks
  page_host = [string]$result.host
  page_path = [string]$result.path
  ready_state = [string]$result.readyState
  external_business_request_count = 0
  registration_path = $RegistrationPath
  status_evidence_ref = $responsePath
  error_code = if ($ready) { $null } else { 'PANE_ACCEPTANCE_CHECK_INCOMPLETE' }
} | ConvertTo-Json -Depth 5
