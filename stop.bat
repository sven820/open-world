@echo off
setlocal
title Open World - STOP
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-dev.ps1" -Action stop %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [FAILED] Stop did not complete. See the message above.
echo.
pause
endlocal
exit /b %RC%
