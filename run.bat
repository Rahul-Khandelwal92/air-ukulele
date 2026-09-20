@echo off
rem Air Ukulele launcher: serves the project over http so the offline vendor/
rem MediaPipe files load (Chrome blocks them from file://), then opens Chrome.
cd /d "%~dp0"
start "uke-server" /min cmd /c "python -m http.server 8000"
timeout /t 1 /nobreak >nul
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
start "" %CHROME% http://localhost:8000/uke.html
