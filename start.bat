@echo off
cd /d "%~dp0"
title BPS.FotosBuilding Flask
echo Installing Python packages (Flask, Pillow, pillow-heif)...
py -3 -m pip install -r requirements.txt
if errorlevel 1 (
  python -m pip install -r requirements.txt
)
if errorlevel 1 (
  echo Python 3 not found. Install from https://www.python.org/downloads/
  echo Enable "Add python.exe to PATH" during setup.
  pause
  exit /b 1
)
set BPS_HOST=0.0.0.0
set BPS_PORT=8080
echo.
echo Starting server: http://127.0.0.1:8080/
echo Keep this window open. Close it to stop the site.
echo.
py -3 server.py
if errorlevel 1 python server.py
pause
