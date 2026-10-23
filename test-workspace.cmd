@echo off
cd /d "%~dp0"
cargo test --workspace > test-workspace.log 2>&1
echo EXITCODE=%errorlevel% >> test-workspace.log
exit /b %errorlevel%
