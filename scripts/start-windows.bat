@echo off
rem 티츄 서버 실행기 (Windows) — 죽으면 5초 후 자동 재시작
title tichu server
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다. nodejs.org에서 LTS 버전을 설치하세요.
  pause
  exit /b 1
)

rem 포트 8080 선점 확인 — 이미 떠 있으면 중복 실행 방지
netstat -ano | findstr ":8080 " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [주의] 포트 8080이 이미 사용 중입니다. 티츄 서버가 이미 실행 중이거나
  echo        다른 프로그램이 8080을 쓰고 있습니다. 기존 창을 확인하세요.
  pause
  exit /b 1
)

:loop
echo [%date% %time%] 티츄 서버 시작 (포트 8080)
node server.js
echo [%date% %time%] 서버 종료됨 — 5초 후 재시작합니다. (창을 닫으면 완전히 중지)
timeout /t 5 /nobreak >nul
goto loop
