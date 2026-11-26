@echo off
REM Local preview for the Agile Outcomes site. Double-click, or run from the repo folder.
cd /d "%~dp0"

echo.
echo === Getting the redesign branch ===
git fetch origin claude/zen-dirac-0nxqc6
if errorlevel 1 (echo Could not fetch. Check git is installed and you are online. & pause & exit /b 1)
git checkout claude/zen-dirac-0nxqc6
if errorlevel 1 (echo Checkout failed. Commit or stash your local changes first. & pause & exit /b 1)
git pull origin claude/zen-dirac-0nxqc6

where node >nul 2>nul
if errorlevel 1 goto nopython_check

echo.
echo === Full preview with the Worker (live dashboard) ===
echo First time only: if asked, run  npx wrangler login  so AI commentary works.
echo Open the address shown below (usually http://localhost:8787). Ctrl+C to stop.
echo.
start "" http://localhost:8787/
npx wrangler dev
goto :eof

:nopython_check
where py >nul 2>nul
if errorlevel 1 (echo Neither Node.js nor Python found. Install Node.js from nodejs.org and run this again. & pause & exit /b 1)
echo.
echo === Pages-only preview (no dashboard data; install Node.js for the full one) ===
echo Open http://127.0.0.1:8000/  Ctrl+C to stop.
echo.
start "" http://127.0.0.1:8000/
cd public
py -m http.server 8000 --bind 127.0.0.1
