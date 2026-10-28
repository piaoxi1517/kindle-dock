@echo off
chcp 65001 >nul
title GitHub 登录授权
cd /d "%~dp0"

echo.
echo   ══════════════════════════════════════════════
echo     GitHub 登录（设备码授权）
echo   ══════════════════════════════════════════════
echo.
echo   接下来会：
echo     1. 打印一个 8 位码，形如 XXXX-XXXX
echo     2. 自动打开浏览器（或手动访问 https://github.com/login/device）
echo     3. 把 8 位码输进去，点 Authorize
echo.
echo   全程不需要输入密码，助手也接触不到你的 token。
echo.
pause

git credential-manager github login

echo.
if errorlevel 1 (
  echo   [失败] 登录没有完成。把上面的报错内容发给助手。
) else (
  echo   [完成] 已登录成功，回到对话里说一声「好了」。
)
echo.
pause
