@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul || (
  echo [错误] 没有找到 Node.js
  echo.
  echo   要么安装 Node.js 18+ 并加入 PATH，
  echo   要么直接用打包好的 Kindle投书.exe（不需要 Node）。
  pause
  exit /b 1
)

echo.
echo   正在启动 Kindle 投书服务...
echo   浏览器会自动打开 http://127.0.0.1:8765
echo   关闭本窗口即停止服务
echo.

node server.js --open

pause
