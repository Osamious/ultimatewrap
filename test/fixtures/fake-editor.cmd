@echo off
REM Stands in for the user's real editor. Records that it was called, with which
REM buffer, and leaves the buffer untouched.
echo passthrough %~1>> "%UW_TEST_MARKER%"
exit /b 0
