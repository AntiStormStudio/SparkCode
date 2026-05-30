@echo off
setlocal
set "SPARK_CODE_ROOT=%~dp0"

if exist "%SPARK_CODE_ROOT%runtime\win32-x64\bun.exe" (
  set "BUN=%SPARK_CODE_ROOT%runtime\win32-x64\bun.exe"
) else if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
) else (
  set "BUN=bun"
)

"%BUN%" run "%SPARK_CODE_ROOT%src\dev-entry.ts" %*
exit /b %ERRORLEVEL%
