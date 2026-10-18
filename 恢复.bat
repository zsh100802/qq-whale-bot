@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0STOP" (
  del "%~dp0STOP"
  echo [已恢复] 小鲸可以继续说话了。
) else (
  echo [无需操作] 当前没有被急停。
)
timeout /t 3 >nul
