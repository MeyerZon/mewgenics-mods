@echo off
REM Builds and runs every host-side native test suite (tier T0 for native/).
REM Stops at the first failing suite; exit code 1 on any failure.
setlocal
set "HERE=%~dp0"
echo === mewframework (signature scanner)
call "%HERE%framework\test.bat"
if errorlevel 1 exit /b 1
if exist "%HERE%mods\test-harness\test.bat" (
  echo === mewtest (harness pure modules)
  call "%HERE%mods\test-harness\test.bat"
  if errorlevel 1 exit /b 1
)
echo === all native suites passed
endlocal
