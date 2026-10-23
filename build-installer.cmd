@echo off
rem WallMagic NSIS/MSI installer build (Windows only)
rem Usage: build-installer.cmd   -> logs to tauri-build.log
setlocal
set LOG=tauri-build.log
echo [%date% %time%] === WallMagic installer build start === > %LOG%

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] node not found in PATH >> %LOG%
  exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
  echo [FAIL] cargo not found in PATH - install Rust via https://rustup.rs >> %LOG%
  exit /b 1
)

echo [1/3] npm run build (web bundle) >> %LOG%
call npm run build >> %LOG% 2>&1
if errorlevel 1 (
  echo [FAIL] npm run build failed >> %LOG%
  exit /b 1
)

echo [2/3] npm run tauri build (rust + nsis/msi bundle) >> %LOG%
call npm run tauri build >> %LOG% 2>&1
if errorlevel 1 (
  echo [FAIL] tauri build failed >> %LOG%
  exit /b 1
)

echo [3/3] listing bundle artifacts >> %LOG%
dir /b target\release\bundle\nsis >> %LOG% 2>&1
if errorlevel 1 (
  echo [FAIL] nsis bundle missing - artifact verification failed >> %LOG%
  exit /b 1
)
dir /b target\release\bundle\msi >> %LOG% 2>&1
if errorlevel 1 (
  echo [FAIL] msi bundle missing - artifact verification failed >> %LOG%
  exit /b 1
)
echo [%date% %time%] === BUILD OK === >> %LOG%
exit /b 0
