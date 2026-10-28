@echo off
REM ---------------------------------------------------------------------------
REM Release build with path remapping (required for clean binaries).
REM
REM Purpose: keep local absolute paths out of release binaries, e.g.
REM          C:\Users\<name>\.cargo\registry\... and <checkout>\crates\core\src\...
REM
REM Why: Rust embeds source paths in panic Location data and file!() strings.
REM      Without remapping the account name stays inside the .exe, so rewriting
REM      git history does not clean the shipped installer (NSIS/MSI unpack it).
REM
REM Why USERPROFILE: writing the account name literally in this file would put
REM      the personal string back into the repository. Using the environment
REM      variable keeps tracked files free of personal data.
REM
REM Verify: node scripts/verify-release.mjs  (includes binary path leak scan)
REM ---------------------------------------------------------------------------
setlocal

if "%USERPROFILE%"=="" (
  echo FAIL USERPROFILE is empty - cannot build remap flags
  exit /b 1
)

set "RUSTFLAGS=--remap-path-prefix=%USERPROFILE%=anonymous --remap-path-prefix=%CD%=WallMagic"
echo info RUSTFLAGS=%RUSTFLAGS%

call npm run release:build
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo FAIL release:build exit=%CODE%
  exit /b %CODE%
)

echo ok release:build done - now run node scripts/verify-release.mjs
exit /b 0
