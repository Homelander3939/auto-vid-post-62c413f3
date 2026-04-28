@echo off
setlocal enableextensions
TITLE Video Uploader System
SET "ROOT_DIR=C:\auto-vid-post"
SET "BRAVE_PATH=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

echo ======================================================
echo           VIDEO UPLOADER - SMART LAUNCHER
echo ======================================================

echo [1/5] Pulling latest updates from Lovable...
cd /d "%ROOT_DIR%"
git pull origin main

:: --- 2. Start LM Studio Windows app + API + first model ---
echo [2/5] Starting LM Studio app, API server, and first model...
SET "LM_STUDIO_URL=http://localhost:1234"
SET "LM_STUDIO_FORCE_LOCAL=true"
node server\ensure-lmstudio.js

echo [3/5] Checking Dependencies...
call npm run ensure-deps
IF ERRORLEVEL 1 (
    echo [!] Frontend dependency check failed.
    echo     Make sure this repo is fully updated and package.json still includes the ensure-deps script.
    echo     Fix the errors above, then run the launcher again.
    pause
    exit /b 1
)
echo [OK] Frontend packages are ready.

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
:: Start Backend — force localhost:1234 for LM Studio running on this PC
start "Uploader_SERVER" cmd /k "cd server && SET LM_STUDIO_URL=http://localhost:1234 && SET LM_STUDIO_FORCE_LOCAL=true && npm start"

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
