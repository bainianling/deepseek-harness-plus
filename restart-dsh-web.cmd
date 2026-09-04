@echo off
rem One-shot launcher for the dsh web restart helper. Re-invokes itself
rem minimized so the scheduled task's console window does not linger, then
rem removes the one-shot task so it never fires again on its schedule.
if /I not "%1"=="go" (
  start "" /min cmd /c "%~f0" go
  exit /b
)
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-dsh-web.ps1"
schtasks /delete /tn "DSH-Restart-Web" /f >nul 2>&1
