@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0canvas-studio.exe" "%~dp0resources\app\out\main\local-agent.js" %*
exit /b %errorlevel%
