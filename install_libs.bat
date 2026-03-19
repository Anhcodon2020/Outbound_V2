@echo off
REM ====================================================
REM FILE CAI DAT THU VIEN CHO NODEJS PORTABLE
REM ====================================================

REM Dam bao duong dan nay giong voi file run.bat cua ban
set NODE_DIR=D:\NodeJS

REM Thiet lap moi truong
set PATH=%NODE_DIR%;%PATH%
cd /d "%~dp0"

echo [1/2] Dang tao file package.json (npm init)...
call npm init -y

echo [2/2] Dang cai dat mysql2 va dotenv...
call npm install mysql2 dotenv

echo ====================================================
echo HOAN TAT! Ban co the chay run.bat ngay bay gio.
pause