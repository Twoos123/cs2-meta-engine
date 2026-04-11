@echo off
echo ============================================================
echo  CS2 Meta Engine — First-Time Setup
echo ============================================================
cd /d "%~dp0"

echo.
echo [1/3] Installing Python dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: pip install failed. Make sure Python 3.10+ is installed.
    pause & exit /b 1
)

echo.
echo [2/3] Installing Node.js dependencies...
cd frontend
npm install
if errorlevel 1 (
    echo ERROR: npm install failed. Make sure Node.js 18+ is installed.
    pause & exit /b 1
)
cd ..

echo.
echo [3/3] Creating default config...
if not exist ".env" copy .env.example .env
if not exist "demos" mkdir demos
if not exist "data"  mkdir data

echo.
echo ============================================================
echo  Setup complete!
echo.
echo  Next steps:
echo    1. Edit .env and set your RCON_PASSWORD
echo    2. Run:  run_backend.bat   (in one terminal)
echo    3. Run:  run_frontend.bat  (in another terminal)
echo    4. Open: http://localhost:5173
echo    5. Click "Ingest Demos" to pull pro match demos from HLTV
echo ============================================================
pause
