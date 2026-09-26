# Launch the standalone Circuit Lab
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Split-Path -Parent $ScriptDir)

Write-Host "Starting Circuit Lab..." -ForegroundColor Cyan
python "$ScriptDir\start.py"
