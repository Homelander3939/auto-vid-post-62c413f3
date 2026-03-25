@echo off
TITLE Video Uploader System
SET "ROOT_DIR=C:\auto-vid-post"
SET "BRAVE_PATH=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

echo ======================================================
echo           VIDEO UPLOADER - SMART LAUNCHER
echo ======================================================

echo [1/4] Pulling latest updates from Lovable...
cd /d "%ROOT_DIR%"
git pull origin main

echo [2/4] Checking Dependencies...
IF NOT EXIST "node_modules" (
    echo [!] Missing frontend packages. Installing now...
    call npm install
) ELSE (
    echo [OK] Frontend packages found.
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

:: ===== LOVABLE API KEY =====
:: The smart-agent uses the Lovable AI gateway for browser automation intelligence.
:: Without this key, AI vision falls back to basic DOM analysis (less reliable).
:: Get the key from your Lovable Cloud project settings.
IF NOT DEFINED LOVABLE_API_KEY (
    IF EXIST "%ROOT_DIR%\server\.env" (
        echo [*] Loading LOVABLE_API_KEY from server\.env...
        for /f "tokens=1,* delims==" %%A in ('findstr /I "LOVABLE_API_KEY" "%ROOT_DIR%\server\.env"') do (
            SET "LOVABLE_API_KEY=%%B"
        )
    )
    IF NOT DEFINED LOVABLE_API_KEY (
        echo [!] WARNING: LOVABLE_API_KEY not set. AI-powered browser automation will use basic DOM analysis only.
        echo     To enable full AI vision, create server\.env with: LOVABLE_API_KEY=your_key_here
        echo     Or set it as an environment variable before running this script.
    )
)

echo [3/4] Launching services...
:: Start Backend with LOVABLE_API_KEY passed through
start "Uploader_SERVER" cmd /k "cd server && SET LOVABLE_API_KEY=%LOVABLE_API_KEY% && npm start"

:: Start Frontend (LOCKED TO PORT 8081)
start "Uploader_FRONTEND" cmd /k "npm run dev -- --port 8081 --strictPort"

echo [4/4] Waiting 10 seconds for services to compile...
timeout /t 10 /nobreak

echo Opening Brave Browser...
if exist "%BRAVE_PATH%" (
    start "" "%BRAVE_PATH%" http://localhost:8081
) else (
    start http://localhost:8081
)
exit
