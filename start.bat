@echo off
REM ---------------------------------------------------------------------------
REM  Nuclear Option Mission Planner - launcher
REM
REM  Double-click this. It serves this folder over HTTP and opens the planner.
REM  A server is needed because browsers block fetch() on pages opened directly
REM  from disk, so units.json (and later the terrain DEM) cannot load otherwise.
REM
REM  Close this window, or press Ctrl+C in it, to stop the server.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo   Nuclear Option Mission Planner
echo   ------------------------------
echo   Serving on http://localhost:8000
echo   Close this window to stop.
echo.

REM Opens the default browser. The server below starts in milliseconds, long
REM before the browser finishes launching, so there is no race in practice.
start "" http://localhost:8000

python -m http.server 8000

REM Reached only if the server exits or fails - most likely port 8000 already
REM in use, or python missing from PATH. Keeps the window open so the error is
REM readable rather than vanishing instantly.
echo.
echo   Server stopped.
pause
