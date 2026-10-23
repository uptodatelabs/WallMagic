@echo off
cd /d "%~dp0"
cargo check -p wallmagic-app > check-app.log 2>&1
echo EXITCODE=%errorlevel% >> check-app.log
