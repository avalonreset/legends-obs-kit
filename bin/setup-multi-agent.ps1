#Requires -Version 5.1
param(
  [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SkillName = 'legends-obs-kit'
$SkillTarget = Join-Path $RepoRoot "skills\$SkillName"
$BuiltCli = Join-Path $RepoRoot 'dist\index.js'

if (-not (Test-Path -LiteralPath (Join-Path $SkillTarget 'SKILL.md'))) {
  throw "Missing skill source: $SkillTarget"
}

function Normalize-Path([string]$Path) {
  return ([IO.Path]::GetFullPath($Path) -replace '/', '\').TrimEnd('\')
}

function Set-SkillJunction {
  param(
    [Parameter(Mandatory)][string]$Agent,
    [Parameter(Mandatory)][string]$LinkPath
  )

  $parent = Split-Path -Parent $LinkPath
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  if (Test-Path -LiteralPath $LinkPath) {
    $item = Get-Item -LiteralPath $LinkPath -Force
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "[$Agent] refusing to replace existing non-junction: $LinkPath"
    }
    $current = if ($item.Target -is [array]) { [string]$item.Target[0] } else { [string]$item.Target }
    if ((Normalize-Path $current) -eq (Normalize-Path $SkillTarget)) {
      Write-Host "[$Agent] already linked" -ForegroundColor DarkGray
      return
    }
    throw "[$Agent] refusing to replace a link owned by another installation: $LinkPath -> $current"
  }

  New-Item -ItemType Junction -Path $LinkPath -Target $SkillTarget | Out-Null
  Write-Host "[$Agent] linked $LinkPath" -ForegroundColor Green
}

Write-Host 'Legends OBS Kit multi-agent installer' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $BuiltCli)) {
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'src\index.ts'))) {
    throw "Missing built CLI and source tree. Re-download the complete release or repository."
  }
  Push-Location $RepoRoot
  try {
    & corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed: $LASTEXITCODE" }
    & corepack pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed: $LASTEXITCODE" }
  }
  finally {
    Pop-Location
  }
}

$targets = @(
  @{ Agent = 'Codex + Gemini shared'; Path = Join-Path $env:USERPROFILE ".agents\skills\$SkillName" },
  @{ Agent = 'Claude'; Path = Join-Path $env:USERPROFILE ".claude\skills\$SkillName" },
  @{ Agent = 'Gemini'; Path = Join-Path $env:USERPROFILE ".gemini\skills\$SkillName" },
  @{ Agent = 'Grok compatibility'; Path = Join-Path $env:USERPROFILE ".grok\skills\$SkillName" },
  @{ Agent = 'OpenCode compatibility'; Path = Join-Path $env:USERPROFILE ".config\opencode\skills\$SkillName" }
)

foreach ($target in $targets) {
  Set-SkillJunction -Agent $target.Agent -LinkPath $target.Path
}

if ($SkipDoctor) {
  Write-Host 'Install complete. Doctor skipped by request.' -ForegroundColor Cyan
  exit 0
}

Write-Host 'Install complete. Running doctor...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'doctor.ps1')
exit $LASTEXITCODE
