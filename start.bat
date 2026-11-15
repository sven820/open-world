@echo off
setlocal
title Open World - START
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-dev.ps1" -Action stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-dev.ps1" -Action start -Follow %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [FAILED] Start did not complete. See the message above.
echo Logs above are live. This window can stay open; run stop.bat to stop everything.
echo.
pause
endlocal
exit /b %RC%
