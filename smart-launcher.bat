@echo off
TITLE Video Uploader System
for %%I in ("%~dp0.") do SET "ROOT_DIR=%%~fI"
SET "BRAVE_PATH=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

echo ======================================================
echo           VIDEO UPLOADER - SMART LAUNCHER
echo ======================================================

echo [1/5] Pulling latest updates from Lovable...
cd /d "%ROOT_DIR%"
git pull origin main

:: --- 2. Start LM Studio Server & Model ---
echo [2/5] Starting LM Studio Server...
start "LM Studio API" cmd /k "lms server start --port 1234 --cors --bind 0.0.0.0"
echo Waiting for LM Studio server to become ready...
timeout /t 8 /nobreak

echo [2b/5] Loading Gemma 3 27B model...
start "LM Studio Load Model" cmd /c "lms load google/gemma-3-27b"

echo [3/5] Checking Dependencies...
call npm run ensure-deps
IF ERRORLEVEL 1 (
    echo [!] Frontend dependency check failed.
    echo     Make sure this repo is fully updated and package.json still includes the ensure-deps script.
    echo     Fix the errors above, then run the launcher again.
    pause
    exit /b 1
) ELSE (
    echo [OK] Frontend packages are ready.
)

cd server
IF NOT EXIST "node_modules" (
    echo [!] Missing server packages. Installing now...
    call npm install
    call npx playwright install chromium
) ELSE (
    echo [OK] Server packages found.
)
cd ..

echo [4/5] Launching services...
:: Start Backend — use localhost:1234 for LM Studio (running on this machine)
start "Uploader_SERVER" cmd /k "cd server && SET LM_STUDIO_URL=http://localhost:1234 && SET LM_STUDIO_MODEL=google/gemma-3-27b && npm start"

:: Start Frontend (LOCKED TO PORT 8081)
start "Uploader_FRONTEND" cmd /k "npm run dev -- --port 8081 --strictPort"

echo [5/5] Waiting 10 seconds for services to compile...
timeout /t 10 /nobreak

echo Opening Brave Browser...
if exist "%BRAVE_PATH%" (
    start "" "%BRAVE_PATH%" http://localhost:8081
) else (
    start http://localhost:8081
)
exit
