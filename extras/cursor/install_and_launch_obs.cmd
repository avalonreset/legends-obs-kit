@echo off
rem SPDX-License-Identifier: GPL-2.0-or-later
rem Copyright (c) 2026 Avalon Reset
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_into_obs.ps1" -LaunchObs %*
echo.
pause
