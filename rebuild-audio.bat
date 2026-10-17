@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/2] 只构建 server 和 web（不重建 publisher 等其他服务）...
docker compose -f docker-compose-local.yml build server web
if errorlevel 1 goto fail
echo.
echo [2/2] 重启 server 和 web（依赖的 publisher、数据库等保持原样运行）...
docker compose -f docker-compose-local.yml up -d --no-deps --no-build server web
if errorlevel 1 goto fail
echo.
echo 完成！等 1 分钟让后端启动，然后刷新 http://127.0.0.1:5550
pause
exit /b 0
:fail
echo.
echo 重建失败，请把上面的错误信息截图发给 Claude。
pause
exit /b 1
