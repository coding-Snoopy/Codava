# Codava

面向 C / C++ / Java 工程的 AI 代码重构与安全扫描桌面工具。基于 Electron + Vue 3 + TypeScript，通过任意 OpenAI 兼容大模型完成函数级、文件级重构与逐函数审计，并提供 Tree-sitter 解析、圈复杂度度量、Monaco 差异对比与可选的 RAG 相似案例检索。

## 功能一览

- **工程浏览** — 打开本地目录，树形浏览 `.c` / `.cpp` / `.h` / `.java` 源文件
- **函数识别** — Tree-sitter AST 解析，列出函数名、行号范围与圈复杂度
- **智能重构** — 函数级 / 文件级 LLM 重构（降复杂度、简化分支、消除重复），保持语义不变
- **代码扫描** — 单文件（重构前后双版本并行）与批量两种模式，逐函数出报告，状态栏实时进度、可中途取消
- **差异对比** — 左右双栏 Monaco Diff，右侧可直接手工修订
- **复杂度度量** — McCabe 圈复杂度分级着色：绿 ≤5、黄 6–10、红 >10
- **模型中心** — 设置中心内多模型管理、Prompt 方案自定义与导入导出，API Key 系统级加密
- **重构记录** — 每次成功重构落盘一条 JSON，可随时回看前后代码与指标变化
- **RAG 增强**（可选）— CodeBERT 向量检索历史重构案例，作为 Few-Shot 注入提示词

## 环境要求

| 组件          | 要求                                      | 说明                                            |
| ------------- | ----------------------------------------- | ----------------------------------------------- |
| Node.js       | `^20.19.0 \|\| >=22.12.0`，实测 24.12.0 | Vite 7 声明的最低 Node 版本，低于此版本请升级   |
| npm           | 随 Node.js 分发                           | 依赖锁定在 `package-lock.json`              |
| Git           | 任意较新版本                              | 克隆仓库                                        |
| OS            | Windows 10+ / macOS / Linux               | 三端均有对应打包脚本，无需额外编译环境          |
| Python        | 3.8+（建议 3.10+）                        | **仅 RAG 服务需要**，主程序不依赖 |
| 网络          | 可访问所选模型的 API 地址                 | 必要时自行配置代理                              |

## 快速开始

### 1. 克隆仓库

```bash
git clone <本仓库地址>
cd codava
```

### 2. （国内网络建议）切换下载源

Electron 的二进制包默认从 GitHub 拉取，直连容易超时。先配置镜像可显著提速：

```bash
npm config set registry https://registry.npmmirror.com
npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
```

### 3. 安装依赖

```bash
npm install
```

`postinstall` 会自动执行 `electron-builder install-app-deps`，为 Electron 重建原生依赖，首次安装耗时较长属正常现象。

### 4. 启动

```bash
npm run dev
```

主窗口默认 900×670（未设置最小尺寸，可自由缩放）；状态栏与文件列表在 860px 窄窗下已实测不溢出。

> 启动后请先完成下一节的模型配置，否则点击重构 / 扫描会提示缺少 API Key。

## 配置大模型

全部模型参数都在应用内的**设置中心**填写，项目目录里不存在任何明文密钥文件。

打开设置中心 →「模型」→ 新增，四项配置含义如下：

| 配置项               | 必填 | 说明                                     | 示例                            |
| -------------------- | ---- | ---------------------------------------- | ------------------------------- |
| 模型名称 (`name`)    | 是   | 界面展示名，同时作为请求的 `model` 字段  | `kimi-k2`                     |
| API 地址 (`baseUrl`) | 是   | 服务商的 OpenAI 兼容基地址               | `https://api.moonshot.cn/v1`  |
| API 密钥 (`apiKey`)  | 是   | 密钥，落盘前经系统级加密                 | `sk-********`                 |
| 超时时间             | 否   | 单次请求超时（毫秒），默认 120000        | `120000`                      |

常用平台的地址与密钥获取入口：

| 平台                | API 地址                                    | 密钥申请                     |
| ------------------- | ------------------------------------------- | ---------------------------- |
| OpenAI              | `https://api.openai.com/v1`               | platform.openai.com          |
| DeepSeek            | `https://api.deepseek.com`                | platform.deepseek.com        |
| Kimi（Moonshot）    | `https://api.moonshot.cn/v1`              | platform.moonshot.cn         |
| GLM（智谱）         | `https://open.bigmodel.cn/api/paas/v4`    | open.bigmodel.cn             |
| 本地部署            | 按推理服务实际监听地址填写，如 `http://localhost:11434/v1` | —                            |

只要接口遵循 OpenAI 规范即可接入，本地微调模型（LLaMA Factory 训练 + Ollama 之类提供 OpenAI 兼容端点推理）同样直接填地址就行。

### 配置保存在哪里

配置写入用户数据目录的 `settings.json`，**不在仓库内**，也不会被提交：

| 平台    | 路径                                                 |
| ------- | ---------------------------------------------------- |
| Windows | `%APPDATA%\Codava\settings.json`                   |
| macOS   | `~/Library/Application Support/Codava/settings.json` |
| Linux   | `~/.config/Codava/settings.json`                   |

`apiKey` 字段以 `enc:` 前缀 + Base64 密文存放，由 Electron `safeStorage` 交给系统密钥服务加密（Windows DPAPI / macOS Keychain / Linux libsecret），只在主进程发起请求的瞬间解密，不下发给渲染进程。因此**该文件复制到另一台机器无法解密**，换机请重新填写密钥。

设置中心的「导出配置」会对 Key 做掩码脱敏，可以放心分享 Prompt 方案；导入时若遇到掩码值，会保留本机已有的真实密钥。

### 验证是否配好

选中模型 → 挑一个函数点「函数重构」→ 看主进程控制台，出现类似下面这行即表示密钥已就绪：

```
[DEBUG] Model: original=..., normalized=..., baseUrl=..., apiKeyExists=true, source=settings
```

## 打包安装包

```bash
npm run build:win     # Windows（NSIS 安装器）
npm run build:mac     # macOS
npm run build:linux   # Linux
```

三步依次做类型检查、`electron-vite build` 产出 `out/`、再由 electron-builder 打包。产物默认输出到 `dist/`，文件名形如 `codava-1.0.0-setup.exe`。

`build:unpack` 只出免安装目录版本，用于快速验证打包结果。

## npm 脚本

| 命令                      | 作用                                       |
| ------------------------- | ------------------------------------------ |
| `npm run dev`           | 开发模式启动（带渲染进程热更新）           |
| `npm run start`         | 预览已构建产物                             |
| `npm run build`         | 类型检查 + 构建渲染产物                    |
| `npm run build:win`     | 构建并打 Windows 安装包                    |
| `npm run typecheck`     | 主进程 + 渲染进程双套 TS 配置的类型检查    |
| `npm run lint`          | ESLint 检查（带缓存）                      |
| `npm run format`        | Prettier 格式化全仓                        |
| `npm run test:history`  | 重构记录持久化模块的单元测试               |

## 使用流程

### 重构

1. 设置中心新增并激活一个模型
2. 「文件 → 打开…」选择工程根目录
3. 左侧目录树选中源文件，中间出现代码编辑区
4. 左下自动列出函数、行号范围与圈复杂度
5. 选中函数点「函数重构」，或对整个文件点「文件重构」
6. 底部状态栏显示进度，右侧 Diff 区对照原始与重构结果，右栏可手工改
7. 右下面板看复杂度前后变化
8. 确认无误点「写回到文件」覆盖源文件

### 扫描

- **单文件**：标题栏「开始扫描」或活动栏放大镜。若该文件已有重构版本，会**并行**扫描重构前与重构后两个版本，报告分别落地为 `<文件名>.original.audit.json` 与 `<文件名>.refactored.audit.json`
- **批量**：「批量扫描」对目录下所有源文件逐个审计，报告落地为同目录 `<文件名>.audit.json`
- 两种模式都会在底部状态栏显示当前文件 / 当前函数、完成数、百分比、剩余时间，可随时取消；展开「扫描详情」面板可看逐函数流水
- 扫描耗时与函数数量成正比，批量模式建议先在小目录试跑

### 重构记录

成功的重构会在被改造工程内写一条 JSON，按源文件相对路径归档：

```text
工程/src/framework/ActivityManager.cpp
工程/.aosp-refactor/history/src/framework/ActivityManager.cpp.json
```

记录内含重构类型、时间、会话 ID、模型与 Prompt、前后完整代码、行数与复杂度差值。刚生成时状态为 `generated`，确认写回后更新为 `applied`。`.aosp-refactor/` 已被 Git 忽略，在应用左侧以「重构记录」呈现，点开可查看指标变化与带高亮的前后 Diff。

## （可选）启动 RAG 检索服务

不启动 RAG 时，重构与扫描功能完全可用，只是不会注入相似历史案例。

```bash
cd pybackend
pip install -r requirements.txt

# 用仓库自带的样本数据建库（输出文件名必须是 refactor_rag.db，服务固定读这个名字）
python build_db.py data/refactor_history_sample.json data/refactor_rag.db

# 启动服务
python main.py
```

看到下列输出即启动成功，服务监听 `http://localhost:8000`：

```
INFO:     Uvicorn running on http://0.0.0.0:8000
```

自检与接口文档：

```bash
curl http://localhost:8000/health   # 健康检查，含数据库是否已加载
# 浏览器打开 http://localhost:8000/docs 可直接调 API
```

要点：

- 首次运行会下载 CodeBERT 权重（约 500MB），启动慢属正常
- Electron 侧默认连 `http://localhost:8000`，需要改地址时设置环境变量 `RAG_API_BASE_URL`
- 相似度阈值默认 0.8，改 `pybackend/main.py` 里 `AppConfig.similarity_threshold`
- 换成自己的数据：准备 `{ "<id>": { "func_before": "...", "func_after": "..." } }` 结构的 JSON，再执行上面的 `build_db.py`
- 仓库只带 `data/refactor_history_sample.json` 与同名 `.jsonl` 样本；其余 `*.db` 与 `*.jsonl` 均为生成物，不入库，clone 后按上面步骤自行建库

## 项目结构

```
codava/
├── src/
│   ├── main/                     # Electron 主进程
│   │   ├── index.ts              # 窗口 / IPC / LLM 调用 / 重构与扫描编排
│   │   ├── treeSitterFunctions.ts# AST 解析，提取函数边界
│   │   ├── cyclomaticComplexity.ts# McCabe 圈复杂度
│   │   ├── settingsStore.ts      # 配置持久化 + safeStorage 加密
│   │   ├── refactorHistory.ts    # 重构记录 Schema 与原子写入
│   │   ├── refactorQualityGate.ts# 重构质量门校验
│   │   ├── signatureChecker.ts   # 函数签名一致性校验
│   │   └── failureReport.ts      # 失败报告生成
│   ├── preload/                  # contextBridge 暴露的 IPC 契约与类型声明
│   └── renderer/src/             # Vue 3 渲染进程
│       ├── App.vue               # 主界面：目录树 + Diff + 函数表 + 复杂度 + 进度面板
│       └── components/           # MonacoEditor / MonacoDiff / SettingsDialog / RefactorHistoryViewer
├── pybackend/                    # Python RAG 服务（可选组件）
│   ├── main.py                   # FastAPI 入口，向量检索
│   ├── build_db.py               # JSON → CodeBERT 向量 → SQLite
│   ├── data/                     # 自带样本数据
│   └── requirements.txt
├── build/ resources/             # 应用图标与打包资源
├── tests/                        # 单元测试
├── electron.vite.config.ts       # 三段式构建配置
├── electron-builder.yml          # 打包配置（appId com.codava.app）
└── tsconfig.{node,web}.json      # 主进程 / 渲染进程分别检查
```

## 开发约定

- 代码注释统一使用中文
- 提交前跑 `npm run typecheck` 与 `npm run lint`
- 布局尺寸优先复用 `src/renderer/src/assets/base.css` 的排版标尺与 Element Plus 主题变量，不写死颜色
- 新增 IPC 需同步更新 `src/preload/index.d.ts` 的类型声明，保持契约单一来源

## 常见问题

**Q：`npm install` 卡在 Electron 下载**
按「快速开始」第 2 步配置 `ELECTRON_MIRROR` 后删除 `node_modules` 重装。

**Q：点重构 / 扫描提示未配置 API 密钥**
设置中心里确认已填写并**激活**了模型（新增不等于激活），改完重启应用。

**Q：换了台机器，配置里的密钥用不了**
密文与本机系统密钥绑定，跨机不可解密，请在新机重新填写。

**Q：大文件解析慢或复杂度显示不准**
生产版要求 tree-sitter 的 wasm 模块解包到 asar 之外（`electron-builder.yml` 的 `asarUnpack` 已配置）。自行改动打包配置时不要漏掉这一段，否则会静默退化成正则兜底解析。

**Q：RAG 起了但前端没有参考案例**
依次检查：服务是否在 8000 端口、`/health` 是否显示数据库已加载、建库输出文件名是否为 `refactor_rag.db`、相似度是否达到阈值。
