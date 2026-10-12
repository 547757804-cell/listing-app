$bootstrap = Join-Path $PSScriptRoot 'runtime_network_bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'BOL_RUNTIME_NETWORK_BOOTSTRAP_MISSING' }
. $bootstrap
