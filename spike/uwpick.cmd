@echo off
REM UW picker shim for Claude Code's external-editor handoff (ctrl+g).
REM DISPATCHER, not a replacement: only takes over when the chat input is the
REM sentinel, so ctrl+g keeps working normally in plan mode, AskUserQuestion
REM fields, workflows and the fleet view.
setlocal
set "BUF=%~1"
set "SENTINEL="
if exist "%BUF%" for /f "usebackq delims=" %%L in ("%BUF%") do if not defined SENTINEL set "SENTINEL=%%L"

REM trigger on: m | model | >>m   (leading "# ---" response header lines are skipped
REM because we only read the first non-empty line)
if /i "%SENTINEL%"=="diag"   goto diag
if /i "%SENTINEL%"=="m"      goto pick
if /i "%SENTINEL%"=="model"  goto pick
if /i "%SENTINEL%"==">>m"    goto pick

REM not ours -> hand off to the real editor, unchanged
if defined UW_REAL_EDITOR ( "%UW_REAL_EDITOR%" "%BUF%" & exit /b %errorlevel% )
start /wait notepad "%BUF%"
exit /b %errorlevel%

:pick
REM via PowerShell: it sets the console to raw VT input mode first, which node
REM cannot do. Without that the console stays line-buffered and arrows/typing
REM never reach the picker -- the exact failure seen in testing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uwpick-run.ps1" -File "%BUF%"
exit /b 0

:diag
node "%~dp0uwdiag.mjs" "%BUF%"
exit /b 0
