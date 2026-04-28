@echo off
TITLE Video Uploader System
SET "ROOT_DIR=C:\auto-vid-post"
SET "BRAVE_PATH=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

echo ======================================================
echo           VIDEO UPLOADER - SMART LAUNCHER
echo ======================================================

echo [1/5] Pulling latest updates from Lovable...
cd /d "%ROOT_DIR%"
git pull origin main

:: --- 2. Start LM Studio Server & Auto-load Model ---
echo [2/5] Starting LM Studio Server...
start "LM Studio API" cmd /k "lms server start --port 1234 --cors --bind 0.0.0.0"

echo Waiting for LM Studio API to become ready...
SET "LMS_READY="
FOR /L %%i IN (1,1,30) DO (
    IF NOT DEFINED LMS_READY (
        timeout /t 1 /nobreak >nul
        curl -s -o nul -w "%%{http_code}" http://localhost:1234/v1/models 2>nul | findstr /C:"200" >nul && SET "LMS_READY=1"
    )
)
IF NOT DEFINED LMS_READY (
    echo [!] LM Studio API did not respond on port 1234. Telegram AI will not work until LM Studio is running.
) ELSE (
    echo [OK] LM Studio API is ready.
)

echo [2b/5] Ensuring a model is loaded in LM Studio...
:: Check if any model is already loaded
curl -s http://localhost:1234/v1/models 2>nul | findstr /C:"\"id\"" >nul
IF ERRORLEVEL 1 (
    echo No model currently loaded — loading default model now...
    :: Try to load the configured model. `lms load` accepts a model identifier or substring;
    :: if no arg is given, it loads the most recently used model.
    start "LM Studio Load" /MIN cmd /c "lms load --gpu max --yes 2>&1"
    echo Waiting for model to finish loading (up to 60s)...
    SET "LMS_MODEL_READY="
    FOR /L %%i IN (1,1,60) DO (
        IF NOT DEFINED LMS_MODEL_READY (
            timeout /t 1 /nobreak >nul
            curl -s http://localhost:1234/v1/models 2>nul | findstr /C:"\"id\"" >nul && SET "LMS_MODEL_READY=1"
        )
    )
    IF NOT DEFINED LMS_MODEL_READY (
        echo [!] No model loaded after 60s. Open LM Studio and load a model manually, then Telegram AI will work.
    ) ELSE (
        echo [OK] Model is loaded and ready.
    )
) ELSE (
    echo [OK] A model is already loaded in LM Studio.
)

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
