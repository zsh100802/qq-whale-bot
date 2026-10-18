@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env.local" (
  echo [!] 没找到 .env.local
  echo     请把 .env.example 复制成 .env.local，填好 Key 和群号再运行。
  echo.
  pause
  exit /b 1
)

echo 正在启动深小鲸...
echo 关掉这个窗口 = 机器人下线
echo.

rem 优先用 WorkBuddy 自带的 node（双击时系统 PATH 可能找不到 node）
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" src\onebot-adapter.js
echo.
echo 进程已退出。
pause
