@echo off
chcp 65001 >nul
setlocal
set PORT=8899
cd /d "%~dp0"

echo ============================================
echo    PromptVault 本地服务
echo ============================================
echo.

where python >nul 2>nul
if not errorlevel 1 goto use_python

where npx >nul 2>nul
if not errorlevel 1 goto use_npx

echo [错误] 未检测到 python 或 npx。
echo 请先安装 Python 3 或 Node.js，然后重新运行本脚本。
echo.
pause
exit /b 1

:use_python
start "" http://localhost:%PORT%/
echo 正在启动 Python 静态服务器： http://localhost:%PORT%/
echo 关闭此窗口即停止服务
echo.
python -m http.server %PORT%
exit /b 0

:use_npx
start "" http://localhost:%PORT%/
echo 正在启动 Node serve 静态服务器： http://localhost:%PORT%/
echo 关闭此窗口即停止服务
echo.
npx --yes serve -l %PORT% .
exit /b 0
