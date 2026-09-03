@echo off
REM Stands in for uwpick-run.ps1 so dispatch can be tested without a console.
echo picker %~1>> "%UW_TEST_MARKER%"
exit /b 0
