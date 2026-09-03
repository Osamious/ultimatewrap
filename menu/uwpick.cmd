@echo off
REM UW picker shim for Claude Code's external-editor handoff (ctrl+g).
REM DISPATCHER, not a replacement: only takes over when the chat input is the
REM sentinel, so ctrl+g keeps working normally in plan mode, AskUserQuestion
REM fields, workflows and the fleet view.
setlocal
set "BUF=%~1"
set "SENTINEL="
if exist "%BUF%" for /f "usebackq delims=" %%L in ("%BUF%") do if not defined SENTINEL set "SENTINEL=%%L"

if /i "%SENTINEL%"=="m"      goto pick
if /i "%SENTINEL%"=="model"  goto pick
if /i "%SENTINEL%"==">>m"    goto pick

REM not ours -> hand off to the real editor, unchanged. Exit 0 regardless: a
REM non-zero exit makes CC DISCARD the buffer, and here the buffer holds the
REM user's real prose, so discarding it is the harm.
if defined UW_REAL_EDITOR ( "%UW_REAL_EDITOR%" "%BUF%" & exit /b 0 )
start /wait notepad "%BUF%"
exit /b 0

:pick
REM PROPAGATE the child's exit code from here down. The reasoning above INVERTS on
REM this branch: the buffer holds the sentinel `m`, not prose, so exit 0 makes CC
REM accept `m` as a chat message. Every abort inside the picker -- esc, ctrl+c, a
REM missing snapshot, no CONIN$ -- exits non-zero precisely so CC discards it
REM (Q2.1, Q2.3a, Q2.6).
REM
REM UW_PICK_OVERRIDE exists so the dispatch DECISION can be tested without a
REM console. It is never set in normal use, and it propagates too, so the
REM dispatcher's exit-code behaviour is testable at all.
REM
REM NOT written as `if defined X ( "%X%" "%BUF%" & exit /b %ERRORLEVEL% )`. cmd
REM parses a parenthesised block in full before executing any of it, so
REM %ERRORLEVEL% there expands to the value from BEFORE the call -- always 0 --
REM and the propagation silently does nothing. `goto` keeps each expansion on a
REM line that is parsed only once the previous line has run.
if not defined UW_PICK_OVERRIDE goto realpick
"%UW_PICK_OVERRIDE%" "%BUF%"
exit /b %ERRORLEVEL%

:realpick
REM via PowerShell: it sets the console to raw VT input mode first, which node
REM cannot do. Without that the console stays line-buffered and arrows/typing
REM never reach the picker -- the exact failure seen in testing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uwpick-run.ps1" -File "%BUF%"
exit /b %ERRORLEVEL%
