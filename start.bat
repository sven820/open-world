@echo off
setlocal
title Open World - START
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-dev.ps1" -Action start %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [FAILED] Start did not complete. See the message above.
echo Keep this window if you like; run stop.bat to stop everything.
echo.
pause
endlocal
exit /b %RC%
