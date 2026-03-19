@echo off
REM ====================================================
REM FILE CHAY SERVER CHO NODEJS PORTABLE (O D)
REM ====================================================

REM --- QUAN TRONG: Sua duong dan duoi day thanh noi chua file node.exe cua ban ---
REM Vi du: set NODE_DIR=D:\Softwares\node-v20.11.0-win-x64
set NODE_DIR=D:\NodeJS

REM ====================================================

echo Dang thiet lap moi truong tu: %NODE_DIR%
set PATH=%NODE_DIR%;%PATH%

REM Chuyen thu muc lam viec ve noi chua file bat nay de tranh loi sai duong dan
cd /d "%~dp0"

echo Kiem tra phien ban Node.js:
node -v
IF %ERRORLEVEL% NEQ 0 (
    echo [LOI] Khong tim thay Node.js! 
    echo Vui long chuot phai vao file nay, chon 'Edit' va sua dong 'set NODE_DIR=...' dung voi noi ban luu Node.js tren o D.
    pause
    exit /b
)

REM --- KIEM TRA VA CAI DAT THU VIEN TU DONG ---
if not exist "node_modules" (
    echo.
    echo [CANH BAO] Chua tim thay thu vien "node_modules". Dang tu dong cai dat...
    
    if not exist "package.json" (
        echo [1/2] Tao file package.json...
        call npm init -y
    )
    
    echo [2/2] Dang tai mysql2 va dotenv...
    call npm install mysql2 dotenv
    
    echo [OK] Cai dat hoan tat.
)

echo.
echo ====================================================
echo  DANG KHOI DONG SERVER...
echo ====================================================

REM Mo trinh duyet mac dinh tai dia chi localhost
REM Lenh start "" ... giup mo trinh duyet ma khong lam dung server
start "" "http://localhost:3000"

REM Chay server
node server.js
pause