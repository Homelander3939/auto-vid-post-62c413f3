@echo off
echo ================================================
echo   Video Uploader - Local Server Setup
echo ================================================
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node.js found: 
node --version

:: Install dependencies
echo.
echo Installing dependencies...
cd /d "%~dp0"
call npm install

:: Install Playwright browser
echo.
echo Installing Chromium browser for automation...
call npx playwright install chromium

echo.
echo ================================================
echo   Setup complete! 
echo ================================================
echo.
echo To start the server, run:
echo   npm start
echo.
echo Or double-click "start.bat"
echo.
pause
