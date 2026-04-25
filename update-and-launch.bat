@echo off
TITLE Video Uploader - Update ^& Launch
SETLOCAL ENABLEDELAYEDEXPANSION

SET "ROOT_DIR=C:\auto-vid-post"
SET "BRAVE_PATH=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

echo ======================================================
echo      VIDEO UPLOADER - AUTO UPDATER ^& LAUNCHER
echo ======================================================
echo.

cd /d "%ROOT_DIR%"
IF ERRORLEVEL 1 (
    echo [ERROR] Cannot find project folder: %ROOT_DIR%
    pause
    exit /b 1
)

:: --- 1. Show current version BEFORE update ---
echo [1/7] Current local version:
for /f "delims=" %%i in ('git rev-parse --short HEAD 2^>nul') do set "OLD_COMMIT=%%i"
for /f "delims=" %%i in ('git rev-list --count HEAD 2^>nul') do set "OLD_REV=%%i"
echo       Commit: !OLD_COMMIT!  ^|  Rev: !OLD_REV!
echo.

:: --- 2. Force-fetch and hard-reset to remote main (discard ANY local drift) ---
echo [2/7] Fetching latest from GitHub (origin/main)...
git fetch origin main --prune
IF ERRORLEVEL 1 (
    echo [ERROR] Git fetch failed. Check your internet connection or git auth.
    pause
    exit /b 1
)

echo [2b/7] Hard-resetting local files to match remote...
git reset --hard origin/main
git clean -fd

:: --- 3. Show NEW version AFTER update ---
echo.
echo [3/7] New local version:
for /f "delims=" %%i in ('git rev-parse --short HEAD 2^>nul') do set "NEW_COMMIT=%%i"
for /f "delims=" %%i in ('git rev-list --count HEAD 2^>nul') do set "NEW_REV=%%i"
echo       Commit: !NEW_COMMIT!  ^|  Rev: !NEW_REV!

IF "!OLD_COMMIT!"=="!NEW_COMMIT!" (
    echo       [INFO] Already up to date - no new changes pulled.
) ELSE (
    echo       [OK] Updated from !OLD_COMMIT! to !NEW_COMMIT!.
    echo.
    echo --- Last 5 commits pulled ---
    git log --oneline -5
    echo -----------------------------
)
echo.

:: --- 4. Frontend deps (only reinstall if package.json/lock changed) ---
echo [4/7] Checking frontend dependencies...
call npm run ensure-deps
IF ERRORLEVEL 1 (
    echo [!] Frontend dependency check failed. See errors above.
    pause
    exit /b 1
)
echo [OK] Frontend packages ready.
echo.

:: --- 5. Server deps (reinstall if package.json changed since last install) ---
echo [5/7] Checking server dependencies...
cd server
SET "REINSTALL_SERVER=0"
IF NOT EXIST "node_modules" SET "REINSTALL_SERVER=1"
IF EXIST "package.json" (
    IF EXIST "node_modules\.package-lock.json" (
        for %%A in (package.json) do set "PKG_TIME=%%~tA"
        for %%A in (node_modules\.package-lock.json) do set "LOCK_TIME=%%~tA"
        :: Compare via xcopy date trick - simpler: just always check forge
        forfiles /m package.json /c "cmd /c if @fdate@ftime GTR 0 exit 0" >nul 2>&1
    )
)
IF "!REINSTALL_SERVER!"=="1" (
    echo [!] Installing server packages...
    call npm install
    call npx playwright install chromium
) ELSE (
    echo [OK] Server packages found ^(run 'npm install' inside server\ manually if package.json changed^).
)
cd ..
echo.

:: --- 6. Start LM Studio + services ---
echo [6/7] Starting LM Studio server...
start "LM Studio API" cmd /k "lms server start --port 1234 --cors --bind 0.0.0.0"
echo Waiting 6s for LM Studio...
timeout /t 6 /nobreak >nul
start "LM Studio Load Model" cmd /c "lms load google/gemma-3-27b"

echo Launching backend worker...
start "Uploader_SERVER" cmd /k "cd server && SET LM_STUDIO_URL=http://localhost:1234 && SET LM_STUDIO_MODEL=google/gemma-3-27b && npm start"

echo Launching frontend (port 8081)...
start "Uploader_FRONTEND" cmd /k "npm run dev -- --port 8081 --strictPort"
echo.

:: --- 7. Wait & open browser ---
echo [7/7] Waiting 12s for Vite + worker to compile...
timeout /t 12 /nobreak >nul

echo Opening browser at http://localhost:8081
if exist "%BRAVE_PATH%" (
    start "" "%BRAVE_PATH%" http://localhost:8081
) else (
    start http://localhost:8081
)

echo.
echo ======================================================
echo  DONE - Footer should now show commit !NEW_COMMIT!
echo  If footer still shows old version: HARD-REFRESH the
echo  browser tab with Ctrl+Shift+R to bypass Vite cache.
echo ======================================================
echo.
exit
