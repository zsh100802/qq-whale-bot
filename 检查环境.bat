@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 优先用 WorkBuddy 自带的 node（双击时系统 PATH 可能找不到 node）
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" src\selfcheck.mjs
echo.
pause
