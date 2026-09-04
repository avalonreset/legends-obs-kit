#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
  $BuiltCli = Join-Path $RepoRoot 'dist\index.js'
  if (Test-Path -LiteralPath $BuiltCli) {
    & node $BuiltCli doctor --pretty
  }
  elseif (Test-Path -LiteralPath (Join-Path $RepoRoot 'src\index.ts')) {
    & corepack pnpm dev -- doctor --pretty
  }
  else {
    throw 'Missing built CLI and source tree. Re-download the complete release or repository.'
  }
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
