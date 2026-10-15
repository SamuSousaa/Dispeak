c@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0capture-bench.ps1" %*
pause
