@echo off
echo Starting CS2 Meta Engine backend...
cd /d "%~dp0"

if not exist ".env" (
    copy .env.example .env
    echo Created .env from .env.example — edit it with your RCON password.
)

if not exist "demos" mkdir demos
if not exist "data" mkdir data

REM --reload-dir backend ensures WatchFiles only watches source code, not demos/ or data/
REM which would cause restarts mid-download when new .dem files land.
uvicorn backend.main:app ^
    --host 0.0.0.0 ^
    --port 8000 ^
    --reload ^
    --reload-dir backend
