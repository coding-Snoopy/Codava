@echo off
REM RAG 服务快速启动脚本 (Windows)

echo ========================================
echo RAG 代码重构服务 - 启动脚本
echo ========================================
echo.

REM 检查 Python 是否安装
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python，请先安装 Python 3.8+
    pause
    exit /b 1
)

echo [1/4] 检查 Python 环境...
echo.

REM 检查依赖是否安装
echo [2/4] 检查依赖...
python -c "import fastapi" >nul 2>&1
if %errorlevel% neq 0 (
    echo [提示] 正在安装依赖...
    pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
) else (
    echo [✓] 依赖已安装
)
echo.

REM 检查数据库是否存在
echo [3/4] 检查数据库...
if not exist "data\refactor_rag.db" (
    echo [提示] 数据库不存在，需要先构建数据库
    echo.
    echo 请确保 data 目录下有样本数据 refactor_history_sample.json
    echo 然后运行：python build_db.py data/refactor_history_sample.json data/refactor_rag.db
    echo.
    pause
    exit /b 1
) else (
    echo [✓] 数据库已就绪
)
echo.

REM 启动 FastAPI 服务
echo [4/4] 启动 FastAPI 服务...
echo.
echo 服务地址：http://localhost:8000
echo 健康检查：http://localhost:8000/health
echo API 文档：http://localhost:8000/docs
echo.
echo 按 Ctrl+C 停止服务
echo ========================================
echo.

python main.py
