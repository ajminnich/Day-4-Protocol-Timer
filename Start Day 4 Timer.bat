@echo off
setlocal
title Day 4 Protocol Timer
cd /d "%~dp0"

set "TIMER_URL=http://localhost:3000/"

rem If the timer is already running, just open it.
powershell.exe -NoLogo -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri '%TIMER_URL%' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  if not defined DAY4_TIMER_NO_BROWSER start "" "%TIMER_URL%"
  exit /b 0
)

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if %ERRORLEVEL% EQU 0 (
    set "NODE_EXE=node"
  ) else (
    echo.
    echo Node.js was not found, so the Day 4 timer cannot start.
    echo Install Node.js 22 or newer, then double-click this file again.
    echo.
    pause
    exit /b 1
  )
)

if not exist "node_modules\vinext\dist\cli.js" (
  echo.
  echo First-time setup: preparing the Day 4 timer...
  set "PNPM_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
  if exist "%PNPM_EXE%" (
    call "%PNPM_EXE%" install
  ) else (
    where pnpm >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
      call pnpm install
    ) else (
      echo.
      echo pnpm was not found. Install pnpm, then double-click this file again.
      echo.
      pause
      exit /b 1
    )
  )
  if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Setup did not finish successfully.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo Starting the Day 4 Protocol Timer...
echo The browser will open automatically when the timer is ready.
echo Keep this window open while using the timer.
echo Press Ctrl+C here when you are finished.
echo.

if not defined DAY4_TIMER_NO_BROWSER (
  start "" /b powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "$url = '%TIMER_URL%'; for ($i = 0; $i -lt 60; $i++) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; if ($response.StatusCode -eq 200) { Start-Sleep -Milliseconds 800; Start-Process $url; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
)

"%NODE_EXE%" "node_modules\vinext\dist\cli.js" dev

echo.
echo The Day 4 timer has stopped.
pause
endlocal
