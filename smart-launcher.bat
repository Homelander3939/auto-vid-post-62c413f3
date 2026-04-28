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

:: --- 2. Start LM Studio Server (in background window) ---
echo [2/5] Starting LM Studio Server on port 1234...
start "LM Studio API" cmd /k "lms server start --port 1234 --cors"

echo Waiting for LM Studio API to become ready...
SET /A _tries=0
:WAIT_LMS
SET /A _tries+=1
timeout /t 1 /nobreak >nul
curl -s -o nul -w "%%{http_code}" http://localhost:1234/v1/models 2>nul | findstr /C:"200" >nul
IF NOT ERRORLEVEL 1 GOTO LMS_READY
IF %_tries% LSS 30 GOTO WAIT_LMS
echo [!] LM Studio API did not respond on port 1234 after 30s.
echo     Continuing anyway — Telegram AI will not work until you start LM Studio manually.
GOTO AFTER_LMS

:LMS_READY
echo [OK] LM Studio API is ready.

echo [2b/5] Ensuring first model in list is loaded...
:: Get list of available (downloaded) models, pick the first one
SET "FIRST_MODEL="
FOR /F "tokens=*" %%M IN ('lms ls --json 2^>nul ^| node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const arr=Array.isArray(j)?j:(j.models||j.data||[]);if(arr[0])console.log(arr[0].modelKey||arr[0].path||arr[0].id||arr[0].name||'');}catch(e){}}"') DO (
    IF NOT DEFINED FIRST_MODEL SET "FIRST_MODEL=%%M"
)

:: Check if already loaded
curl -s http://localhost:1234/v1/models 2>nul | findstr /C:"\"id\"" >nul
IF NOT ERRORLEVEL 1 (
    echo [OK] A model is already loaded in LM Studio.
    GOTO AFTER_LMS
)

IF DEFINED FIRST_MODEL (
    echo Loading first available model: %FIRST_MODEL%
    start "LM Studio Load" /MIN cmd /c "lms load ""%FIRST_MODEL%"" --gpu max --yes"
) ELSE (
    echo Loading most recently used model...
    start "LM Studio Load" /MIN cmd /c "lms load --gpu max --yes"
)

echo Waiting for model to finish loading (up to 90s)...
SET /A _mtries=0
:WAIT_MODEL
SET /A _mtries+=1
timeout /t 1 /nobreak >nul
curl -s http://localhost:1234/v1/models 2>nul | findstr /C:"\"id\"" >nul
IF NOT ERRORLEVEL 1 GOTO MODEL_READY
IF %_mtries% LSS 90 GOTO WAIT_MODEL
echo [!] No model loaded after 90s. Open LM Studio and load a model manually.
GOTO AFTER_LMS

:MODEL_READY
echo [OK] Model is loaded and ready.

:AFTER_LMS

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
:: Start Backend — use localhost:1234 for LM Studio (running on this machine)
start "Uploader_SERVER" cmd /k "cd server && SET LM_STUDIO_URL=http://localhost:1234 && npm start"

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
