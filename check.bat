@echo off
rem EchoBridge: run the tests, build, type check and lint.
rem Double-click this file. The real work is done by scripts\dev.mjs (Node.js).
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto :no_node
node scripts\dev.mjs check
goto :done

:no_node
echo.
echo  Node.js was not found on this PC.
echo  Install the LTS version from https://nodejs.org/ja , then run this file again.
start "" "https://nodejs.org/ja/download"

:done
echo.
pause
