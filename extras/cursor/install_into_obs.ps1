# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 Avalon Reset

param(
    [string]$ObsConfigRoot = "",
    [string]$SceneCollection = "",
    [string]$TargetSourceName = "pointer overlay",
    [switch]$CopyOnly,
    [switch]$LaunchObs,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceLua = Join-Path $SourceRoot "legends_cursor_filter.lua"
$SourceEffect = Join-Path $SourceRoot "legends_cursor_filter.effect"
$CursorFilterName = "Legends Cursor Filter"
$CursorFilterId = "legends_cursor_filter"

if (-not (Test-Path -LiteralPath $SourceLua)) {
    throw "Missing source Lua file: $SourceLua"
}
if (-not (Test-Path -LiteralPath $SourceEffect)) {
    throw "Missing source shader file: $SourceEffect"
}

if ([string]::IsNullOrWhiteSpace($ObsConfigRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA is not set. Pass -ObsConfigRoot explicitly."
    }
    $ObsConfigRoot = Join-Path $env:APPDATA "obs-studio"
}

if (-not (Test-Path -LiteralPath $ObsConfigRoot)) {
    throw "OBS config root was not found: $ObsConfigRoot"
}

$DestRoot = Join-Path $ObsConfigRoot "scripts\legends-cursor-filter"
$DestLua = Join-Path $DestRoot "legends_cursor_filter.lua"
$DestEffect = Join-Path $DestRoot "legends_cursor_filter.effect"

$runningObs = Get-Process -Name "obs64", "obs32" -ErrorAction SilentlyContinue
if ($runningObs -and -not $Force -and -not $CopyOnly) {
    throw "OBS is currently running. Close OBS first, or rerun with -Force if you accept that OBS may overwrite the scene JSON on exit."
}

New-Item -ItemType Directory -Path $DestRoot -Force | Out-Null
Copy-Item -LiteralPath $SourceLua -Destination $DestLua -Force
Copy-Item -LiteralPath $SourceEffect -Destination $DestEffect -Force

Write-Host "Installed script files:"
Write-Host "  $DestLua"
Write-Host "  $DestEffect"

if ($CopyOnly) {
    Write-Host "CopyOnly requested; scene collection was not changed."
    exit 0
}

function Read-IniValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Key
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    $current = ""
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -match "^\[(.+)\]$") {
            $current = $Matches[1]
            continue
        }
        if ($current -eq $Section -and $trimmed -match "^$([regex]::Escape($Key))=(.*)$") {
            return $Matches[1].Trim()
        }
    }

    return ""
}

function Ensure-ArrayList {
    param($Value)

    $list = New-Object System.Collections.ArrayList
    if ($null -eq $Value) {
        return ,$list
    }

    if ($Value -is [System.Array]) {
        foreach ($item in $Value) {
            [void]$list.Add($item)
        }
    } else {
        [void]$list.Add($Value)
    }

    return ,$list
}

function Set-JsonProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        $Value
    )

    if ($Object -is [System.Collections.IDictionary]) {
        $Object[$Name] = $Value
        return
    }

    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.PSObject.Properties[$Name].Value = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Test-TargetSourceName {
    param([string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) {
        return $false
    }

    if ($Name -ieq $TargetSourceName) {
        return $true
    }

    $normalized = $Name.ToLowerInvariant()
    if (($normalized -match "pointer") -and ($normalized -match "overlay")) {
        return $true
    }
    if (($normalized -match "cursor") -and ($normalized -match "overlay")) {
        return $true
    }
    if (($normalized -match "mouse") -and ($normalized -match "overlay")) {
        return $true
    }

    return $false
}

function Find-ObsExecutable {
    $candidates = New-Object System.Collections.ArrayList
    $programFiles = [Environment]::GetEnvironmentVariable("ProgramFiles")
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")

    if (-not ([string]::IsNullOrWhiteSpace($programFiles))) {
        [void]$candidates.Add((Join-Path $programFiles "obs-studio\bin\64bit\obs64.exe"))
    }
    if (-not ([string]::IsNullOrWhiteSpace($programFilesX86))) {
        [void]$candidates.Add((Join-Path $programFilesX86 "obs-studio\bin\32bit\obs32.exe"))
    }
    [void]$candidates.Add("C:\Program Files\obs-studio\bin\64bit\obs64.exe")
    [void]$candidates.Add("C:\Program Files (x86)\obs-studio\bin\32bit\obs32.exe")

    foreach ($candidate in $candidates) {
        if (-not ([string]::IsNullOrWhiteSpace($candidate)) -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    return ""
}

function New-ScriptEntry {
    param([string]$Path)

    return [ordered]@{
        path = $Path
        settings = [ordered]@{}
    }
}

function New-CursorSettings {
    return [ordered]@{
        width = 3840
        height = 2160
        origin_x = 0
        origin_y = 0
        visual_mode = 1
        shape_mode = 0
        activation_mode = 2
        radius = 82.0
        thickness = 12.0
        glow = 90.0
        opacity = 0.92
        enable_floaty_follow = $true
        follow_lag_ms = 255.0
        enable_idle_pulse = $true
        enable_motion_ticks = $true
        enable_laser_wake = $true
        enable_comet_trail = $true
        enable_stretch_warp = $true
        enable_left_click = $true
        enable_right_click = $true
        idle_activity = 0.22
        mode_strength = 1.0
        speed_limit = 3200.0
        click_size = 330.0
        click_duration = 0.70
        left_intensity = 1.0
        right_intensity = 1.0
        motion_spin = 1.0
        motion_decay = 5.5
        motion_ticks = 0.85
        tick_count = 10.0
        stretch_strength = 0.70
        wake_strength = 0.60
        trail_strength = 0.55
        trail_spacing = 0.030
        trail_duration = 0.42
        finder_enabled = $true
        finder_sensitivity = 6.0
        finder_size = 1.90
        finder_decay = 2.2
        main_r = 0.0
        main_g = 1.0
        main_b = 0.47
        accent_r = 0.18
        accent_g = 0.80
        accent_b = 1.0
        left_r = 1.0
        left_g = 1.0
        left_b = 1.0
        right_r = 1.0
        right_g = 0.18
        right_b = 0.78
    }
}

function New-CursorFilter {
    return [ordered]@{
        prev_ver = 503382018
        name = $CursorFilterName
        uuid = ([guid]::NewGuid().ToString())
        id = $CursorFilterId
        versioned_id = $CursorFilterId
        settings = (New-CursorSettings)
        mixers = 0
        sync = 0
        flags = 0
        volume = 1.0
        balance = 0.5
        enabled = $true
        muted = $false
        "push-to-mute" = $false
        "push-to-mute-delay" = 0
        "push-to-talk" = $false
        "push-to-talk-delay" = 0
        hotkeys = [ordered]@{}
        deinterlace_mode = 0
        deinterlace_field_order = 0
        monitoring_type = 0
        private_settings = [ordered]@{}
    }
}

function Merge-CursorSettings {
    param($Existing)

    $defaults = New-CursorSettings
    if ($null -eq $Existing) {
        return $defaults
    }

    foreach ($key in $defaults.Keys) {
        if (-not ($Existing.PSObject.Properties.Name -contains $key)) {
            $Existing | Add-Member -NotePropertyName $key -NotePropertyValue $defaults[$key]
        }
    }

    $Existing.enable_floaty_follow = $true
    $Existing.follow_lag_ms = 255.0
    $Existing.enable_motion_ticks = $true
    $Existing.enable_left_click = $true
    $Existing.enable_right_click = $true
    $Existing.radius = 82.0
    $Existing.opacity = 0.92

    return $Existing
}

$GlobalIni = Join-Path $ObsConfigRoot "global.ini"
if ([string]::IsNullOrWhiteSpace($SceneCollection)) {
    $SceneCollection = Read-IniValue -Path $GlobalIni -Section "Basic" -Key "SceneCollectionFile"
}

$ScenesRoot = Join-Path $ObsConfigRoot "basic\scenes"
if (-not (Test-Path -LiteralPath $ScenesRoot)) {
    throw "OBS scenes folder was not found: $ScenesRoot"
}

if (-not ([string]::IsNullOrWhiteSpace($SceneCollection))) {
    $ScenePath = Join-Path $ScenesRoot ($SceneCollection + ".json")
} else {
    $ScenePath = Get-ChildItem -LiteralPath $ScenesRoot -Filter "*.json" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

if (([string]::IsNullOrWhiteSpace($ScenePath)) -or -not (Test-Path -LiteralPath $ScenePath)) {
    throw "Could not locate an OBS scene collection JSON file."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupPath = "$ScenePath.legends-cursor-backup-$timestamp"
Copy-Item -LiteralPath $ScenePath -Destination $BackupPath -Force
Write-Host "Backed up scene collection:"
Write-Host "  $BackupPath"

$scene = Get-Content -LiteralPath $ScenePath -Raw | ConvertFrom-Json

if ($null -eq $scene.modules) {
    Set-JsonProperty -Object $scene -Name "modules" -Value ([pscustomobject][ordered]@{})
}

$scriptEntries = Ensure-ArrayList $scene.modules."scripts-tool"
$alreadyRegistered = $false
foreach ($entry in $scriptEntries) {
    if ([string]$entry.path -ieq $DestLua) {
        $alreadyRegistered = $true
        if ($null -eq $entry.settings) {
            $entry | Add-Member -NotePropertyName "settings" -NotePropertyValue ([ordered]@{})
        }
    }
}

if (-not $alreadyRegistered) {
    [void]$scriptEntries.Add((New-ScriptEntry -Path $DestLua))
}
Set-JsonProperty -Object $scene.modules -Name "scripts-tool" -Value @($scriptEntries)

$updatedExistingFilter = $false
$addedToPointerOverlay = $false
$addedToSourceName = ""

foreach ($source in @($scene.sources)) {
    if ($null -eq $source) {
        continue
    }

    $filters = Ensure-ArrayList $source.filters
    $sourceHadFilters = $filters.Count -gt 0

    $dedupedFilters = New-Object System.Collections.ArrayList
    $keptCursorFilter = $false

    foreach ($filter in $filters) {
        $filterName = [string]$filter.name
        $filterId = [string]$filter.id
        $isCursorFilter = $filterName -ieq "Legends Cursor Filter" -or $filterName -ieq $CursorFilterName -or $filterId -match "legends.*cursor"
        if ($isCursorFilter -and -not $keptCursorFilter) {
            Set-JsonProperty -Object $filter -Name "name" -Value $CursorFilterName
            Set-JsonProperty -Object $filter -Name "id" -Value $CursorFilterId
            Set-JsonProperty -Object $filter -Name "versioned_id" -Value $CursorFilterId
            Set-JsonProperty -Object $filter -Name "settings" -Value (Merge-CursorSettings $filter.settings)
            Set-JsonProperty -Object $filter -Name "enabled" -Value $true
            $updatedExistingFilter = $true
            $keptCursorFilter = $true
            [void]$dedupedFilters.Add($filter)
        } elseif (-not $isCursorFilter) {
            [void]$dedupedFilters.Add($filter)
        }
    }

    $filters = $dedupedFilters

    if (-not $updatedExistingFilter -and -not $addedToPointerOverlay -and (Test-TargetSourceName ([string]$source.name))) {
        [void]$filters.Add((New-CursorFilter))
        Set-JsonProperty -Object $source -Name "filters" -Value @($filters)
        $addedToPointerOverlay = $true
        $addedToSourceName = [string]$source.name
    } elseif ($sourceHadFilters) {
        Set-JsonProperty -Object $source -Name "filters" -Value @($filters)
    }
}

$scene | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $ScenePath -Encoding UTF8

Write-Host "Updated scene collection:"
Write-Host "  $ScenePath"
Write-Host "Registered script in modules.scripts-tool: $DestLua"

if ($updatedExistingFilter) {
    Write-Host "Updated existing Legends cursor filter entries while preserving the original filter name/id: $CursorFilterName"
} elseif ($addedToPointerOverlay) {
    Write-Host "Added $CursorFilterName to source: $addedToSourceName"
} else {
    Write-Host "No existing Legends cursor filter or matching overlay source was found; script is registered for OBS."
    Write-Host "Target source name checked: $TargetSourceName"
}

if ($LaunchObs) {
    $obsExe = Find-ObsExecutable
    if ([string]::IsNullOrWhiteSpace($obsExe)) {
        Write-Host "LaunchObs requested, but OBS executable was not found in the standard install paths."
    } else {
        $obsWorkingDirectory = Split-Path -Parent $obsExe
        Start-Process -FilePath $obsExe -WorkingDirectory $obsWorkingDirectory
        Write-Host "Launched OBS:"
        Write-Host "  $obsExe"
    }
}
