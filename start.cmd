@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  梦云 Agent —— 一键启动（Windows CMD）
REM  双击本文件即可打开程序窗口。
REM  首次运行会自动生成 .env 让你填 API Key，然后继续启动。
REM ============================================================

cd /d "%~dp0"

echo.
echo   梦云 Agent 启动中...
echo   ----------------------------------------

REM ---------- 1. 检查 Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] 没有找到 Node.js
  echo.
  echo   请先安装 Node.js 18 或更高版本：https://nodejs.org
  echo   安装后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo   [√] Node.js !NODEVER!

REM ---------- 2. 检查配置 ----------
if not exist "config.json" (
  echo   [X] 缺少 config.json，请确认本文件解压完整。
  pause
  exit /b 1
)

REM ---------- 3. 首次运行：生成 .env，让用户填 Key，然后继续启动 ----------
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo   [!] 首次运行，已生成 .env
    echo.
    echo   正在打开记事本，请填上这一行（其他都可以不管）：
    echo       MYA_API_KEY=sk-你的key
    echo.
    echo   保存并关闭记事本后，回到这里按任意键继续启动。
    echo   ^(暂时不填也行，程序会打开，你在界面里也能填^)
    echo.
    start /wait "" notepad ".env"
  )
)

REM ---------- 4. 没填 Key 时提醒一下（不阻止启动）----------
findstr /r /c:"^MYA_API_KEY=." ".env" >nul 2>nul
if errorlevel 1 (
  echo   [!] .env 里还没填 MYA_API_KEY，界面会引导你配置
  echo       ^(如果你用的是本地 Ollama 或免鉴权网关，可以忽略^)
  echo.
)

REM ---------- 5. 启动 ----------
REM 传参可以执行其他子命令，例如：start.cmd doctor
REM 默认启动桌面程序；没有桌面组件时自动退回浏览器界面。
if "%~1"=="" (
  node bin\mya.js desktop
) else (
  node bin\mya.js %*
)

set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" (
  echo.
  echo   启动失败，代码 %EXITCODE%
  echo   排查建议：运行  start.cmd doctor  做一次环境体检
  echo.
  pause
)
endlocal
