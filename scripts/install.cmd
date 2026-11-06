@echo off
rem poca-note installer wrapper for Windows.
rem Runs the PowerShell installer with the execution policy bypassed for this
rem process only, so double-clicking this file works on a default Windows setup.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
