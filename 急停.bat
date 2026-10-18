@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 急停 > "%~dp0STOP"
echo [已急停] 小鲸从现在起只记录、不说话。删掉 STOP 文件或用 恢复.bat 即可恢复。
timeout /t 3 >nul
