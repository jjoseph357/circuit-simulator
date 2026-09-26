# Run CLI simulations with Circuit Lab
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Split-Path -Parent $ScriptDir)

python "$ScriptDir\run.py" $args
