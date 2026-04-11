@echo off
echo Starting CS2 Meta Engine frontend...
cd /d "%~dp0\frontend"

if not exist "node_modules" (
    echo Installing npm packages...
    npm install
)

npm run dev
