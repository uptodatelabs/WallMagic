@echo off
cd /d "%~dp0"
cargo run -p wallmagic-app > run-app.log 2>&1
echo EXITCODE=%errorlevel% >> run-app.log
