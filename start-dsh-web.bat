@echo off
title DeepSeek Harness Web
cd /d "%~dp0"
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"

echo Starting Hindsight memory daemon (keep-alive, no idle shutdown)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DSH_HOME%\scripts\start-hindsight.ps1"
echo.

for /f %%i in ('powershell -NoProfile -Command "$c=(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count; if ($c -gt 0) { echo 1 } else { echo 0 }"') do set DSH_ALREADY_RUNNING=%%i

if "%DSH_ALREADY_RUNNING%"=="1" (
  echo DeepSeek Harness Web is already running.
  echo Opening http://127.0.0.1:3080 in your browser...
  start "" http://127.0.0.1:3080
  exit /b 0
)

echo Checking for protected DeepSeek Harness updates...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DSH_HOME%\scripts\dsh-update-on-startup.ps1"
if errorlevel 1 (
  echo Update check or upgrade failed. See %DSH_HOME%\data\personal-update\status.json
  pause
  exit /b 1
)
echo Starting DeepSeek Harness Web UI...
echo Server: http://127.0.0.1:3080  (Ctrl+C to stop)
echo.
echo (The UI opens automatically in your browser once the server is ready.)
pnpm dsh web
echo.
echo Server stopped.
pause
