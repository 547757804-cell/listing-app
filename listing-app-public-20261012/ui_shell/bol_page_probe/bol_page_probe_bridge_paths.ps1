function Resolve-BolPageProbeBridgePaths {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$ProbeRoot,
    [string]$BridgeRoot
  )
  $base=[IO.Path]::GetFullPath($ProbeRoot.Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
  if([string]::IsNullOrWhiteSpace($BridgeRoot)){$BridgeRoot=Join-Path $base 'bridge'}
  $root=[IO.Path]::GetFullPath($BridgeRoot.Normalize([Text.NormalizationForm]::FormC)).TrimEnd('\')
  $prefix=$base+'\'
  if(-not $root.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'BRIDGE_ROOT_OUTSIDE_PROBE_ROOT'}
  [pscustomobject]@{root=$root;inbox=(Join-Path $root 'inbox');outbox=(Join-Path $root 'outbox')}
}
