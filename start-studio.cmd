@echo off
rem prod-imagen studio: dev launcher. Starts the generation server
rem (skips cleanly if one is already running) and opens the app.
cd /d "%~dp0"
start "gen-server" /min cmd /c "python -m server.gen_server"
cd studio
if not exist node_modules call npm install --no-audit --no-fund
npm start
