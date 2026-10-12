param([string]$OutputName='bin')
$ErrorActionPreference = 'Stop'
$shellDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [IO.Path]::GetFullPath((Join-Path $shellDir '..\..'))
$outputDir = Join-Path $shellDir $OutputName
$outputExe = Join-Path $outputDir 'AmazonPageProbeShell.exe'
$vendorDir = Join-Path $projectRoot 'ui_shell\runtime\build'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'CSC_NOT_FOUND' }
$source = Join-Path $shellDir 'AmazonPageProbeShell.cs'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'SHELL_SOURCE_MISSING' }
$running = Get-Process -Name AmazonPageProbeShell -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $outputExe }
if ($running) { throw 'CLOSE_EXISTING_AMAZON_PAGE_PROBE_BEFORE_BUILD' }
foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')) {
  if (-not (Test-Path -LiteralPath (Join-Path $vendorDir $name) -PathType Leaf)) { throw "WEBVIEW2_DEPENDENCY_MISSING_$name" }
}
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')) {
  Copy-Item -LiteralPath (Join-Path $vendorDir $name) -Destination (Join-Path $outputDir $name) -Force
}
$refs = @('/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',('/reference:' + (Join-Path $outputDir 'Microsoft.Web.WebView2.Core.dll')),('/reference:' + (Join-Path $outputDir 'Microsoft.Web.WebView2.WinForms.dll')))
& $compiler /nologo /target:winexe /platform:x64 /codepage:65001 ('/out:' + $outputExe) @refs $source
if ($LASTEXITCODE -ne 0) { throw "CSHARP_BUILD_FAILED_$LASTEXITCODE" }
Write-Output "BUILD=PASS; EXE=$outputExe"
