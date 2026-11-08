@echo off
rem EchoBridge: check the environment and install the dependencies (npm ci).
rem Double-click this file. The real work is done by scripts\dev.mjs (Node.js).
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto :no_node
node scripts\dev.mjs setup
goto :done

:no_node
echo.
echo  Node.js was not found on this PC.
echo  Install the LTS version from https://nodejs.org/ja , then run this file again.
start "" "https://nodejs.org/ja/download"

:done
echo.
pause
