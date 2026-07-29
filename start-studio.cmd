@echo off
rem prod-imagen studio: dev launcher. Replaces any server already on the
rem port (a stale one would silently serve old code), then opens the app.
cd /d "%~dp0"

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*:8787 .*LISTENING"') do (
  echo Stopping old server on 8787 [pid %%p]
  taskkill /f /pid %%p >nul 2>&1
)

rem Prefer the CUDA interpreter so the local GPU engine is available.
set "STUDIO_PY=python"
if exist "%~dp0.venv-image\Scripts\python.exe" set "STUDIO_PY=%~dp0.venv-image\Scripts\python.exe"

echo Starting generation server...
start "prod-imagen server" /min "%STUDIO_PY%" -m server.gen_server

cd studio
if not exist node_modules call npm install --no-audit --no-fund
npm start
