# DeepSeek Harness Plus（二改增强版）

> **本仓库是个人二次修改版（Modified Fork），不是 DeepSeek 官方项目。**
> 原版来源：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，
> 初始基线提交：`cd5ef8148158c3a752a658978873241fdf8e2bbc`（release `0.1.2-alpha.1`）。
> 当前同步源码：`dsh-v0.1.5-rc.2`（版本号 `0.1.5-rc.2`，来源工作树提交 `4f3b2070ebdb5c44171405f1b841e2719057f5b4`，并包含其本地改动）。
> 原版采用 [MIT License](LICENSE)（Copyright (c) 2026 DeepSeek），本仓库沿用 MIT 许可证并保留原始版权声明。
> 使用前请务必阅读 [免责声明](DISCLAIMER.md)。

[English summary](#english-summary)

---

## 这是什么

DeepSeek Harness（`dsh`）是 DeepSeek 开源的「一切皆插件」Agent 运行框架（基于 [Cordis](https://github.com/cordiverse/cordis)），
自带 Web GUI、CLI、Headless、ACP、Python SDK 等多种运行形态。

本仓库以官方 `0.1.2-alpha.1` 为初始基线，并已同步上游至 `dsh-v0.1.5-rc.2`；在此基础上继续保留本地二次修改。核心目标是：**把 Web GUI 从一个聊天界面扩展成一个多功能工作台**，
新增了一批应用级功能分区（AI 实时新闻、技能市场、知识库、模型测试台、LoRA 训练工作室、虚拟软件公司、声线克隆、内置浏览器、内置终端、自动化任务等），
并补充了壁纸、局域网共享开关、会话内切换 Agent preset、跨工作区移动对话、停止服务按钮、破甲（jailbreak）红队模式等增强，
以及双模型角色分工、提示词增强、对话创造等会话能力提升。

完整修改清单（含每一项的文件路径与规模统计）见 [MODIFICATIONS.md](MODIFICATIONS.md)。

## 功能总览

### 新增：Web GUI 应用级功能分区

| 分区 | 功能 | 主要实现 |
| --- | --- | --- |
| 📰 **AI 实时新闻** | 聚合 B 站、抖音、小红书、X（Twitter）热榜与多个 RSS 源（量子位、OpenAI News、The Verge AI、DeepMind、Hugging Face、MIT Tech Review 等），支持代理抓取与自动翻译 | `packages/web/ai-news/`、`NewsPanel` |
| 🧩 **技能市场** | 只读公共开发者工具目录（skill / MCP / dsh-plugin），展示元数据、安装命令与风险评级；市场本身不安装、不执行任何内容 | `packages/bundle/web-app/src/market.ts`、`SkillMarketApp` |
| 📚 **知识库** | 只读对接本地 Hindsight 记忆库的知识中心：文件夹/知识页树、检索与可视化浏览 | `packages/bundle/web-app/src/knowledge.ts`、`KnowledgeHubApp` |
| 🧪 **模型测试台** | 同一提示词并发投喂多个模型路由，对比输出、时延与用量；支持编程/文档/识图/论文四类题目，以及 easy/medium/hard 严格难度分级、题目生成—作答—裁判流水线 | `packages/web/model-bench/`、`ModelBenchApp` |
| 🎨 **LoRA 训练工作室** | 封装本机 LoRA 训练服务（`127.0.0.1:8918`，kohya sd-scripts）：底模管理 / 素材打标（WD14）/ 训练监控（loss 曲线、样图预览）/ 模型库与合并，四个工作台页签 | `LoraTrainApp` |
| 🏢 **虚拟软件公司（Collab Studio）** | 多智能体协作分区：以「软件公司」角色分工编排多个 Agent 协同完成任务 | `packages/web/collab-studio/`、`CollabStudioApp` |
| 🎙️ **声线克隆** | 对接本机 IndexTTS 语音服务（默认 `127.0.0.1:8917`，可在浏览器 localStorage 覆盖）的 TTS 工作台，附语音助手悬浮入口 | `VoiceCloneApp`、`VoiceAssistant` |

### 新增：系统与界面增强

| 功能 | 说明 | 主要实现 |
| --- | --- | --- |
| 🖥️ **内置浏览器面板** | GUI 右侧集成无头浏览器面板（截图、页面状态、快照浏览） | `packages/client/ui-browser-panel/` |
| ⌨️ **内置终端** | Web 内共享 Shell 终端（host 侧持久 PTY 通道） | `packages/api/session-controller/src/terminal.ts`、`TerminalApp` |
| ⏰ **自动化任务面板** | 侧边栏自动化任务入口与调度（schedule）管理面板 | `ui-sidebar/AutomationPanel` |
| 🖼️ **壁纸更换** | 静态 + 动态壁纸层与壁纸选择器 | `ui-primitives/Wallpaper*` |
| 🛑 **停止服务按钮** | 设置页一键停止 dsh web 服务（host 侧 shutdown API，Windows 进程树处理） | `StopServerAction`、`shutdown-route.spec.ts` |
| 📡 **局域网共享开关** | 会话输入栏的 LAN 共享控制（受信主机 / 绑定地址场景） | `LanShareControl` |
| 🔁 **会话内切换 Agent preset** | 会话级 preset 标签与切换，配套 host 侧 preset API | `ui-agent-preset/`、`host/apiproxy` |
| 🗂️ **跨工作区移动对话 / 工作区浏览** | 工作区浏览器与对话迁移 | `client/runtime/workspaces/`、`WorkspaceBrowser` |
| 📥 **会话文件导入** | 导入外部会话文件（JSONL）到会话存储 | `session-file-import` |
| 🗑️ **会话删除** | SQLite/JSONL 持久层的会话与事件删除 SQL 及接口 | `session-persistence-sqlite` |
| 🖼️ **图片导入输入** | 输入栏图片导入（ComposerImageImport）与附件栏调整 | `ui-attachment/` |
| 💰 **模型余额入口** | 模型选择器旁的余额 / 用量快捷入口 | `ModelBalanceAction` |
| 🎨 **主题细节** | 滚动条、渐变阴影文字、平台化设计变量等样式增强 | `ui-theme/` |

### 新增：本机二开增强（`dsh-v0.1.5-rc.2` 增量）

| 功能 | 说明 | 主要实现 |
| --- | --- | --- |
| 🧠 **双模型角色（思考 / 执行）** | 会话级双模型分工：分别指定「思考模型」与「执行模型」，投影按会话持久化；GUI 提供角色控制与角色目录选择 | `session-controller/src/model-roles-projection.ts`、`ui-model-selection/ModelRolesControl`、`model-roles.ts` |
| ✨ **提示词增强** | 输入栏一键把草稿扩写为更完整的提示词：host 侧有界读取工作区上下文（文件数/深度/字节数上限，跳过 `.git`、`node_modules`、`.env`、凭据等敏感项），再以指定模型单次生成，客户端可预览并回填 | `session-controller/src/prompt-enhancement.ts`、`ui-model-selection/PromptEnhancer` |
| 💬 **对话创造（Conversation Create）** | 编排一段完整对话草稿（用户 / 助手 / 工具调用 / 工具结果四类条目），选择分组目录与智能体预设后创建为**真实会话**并逐轮执行，创建后 AI 可继续接手；含草稿校验、预览、进度与失败阶段提示 | `ui-layout/ConversationCreateApp.tsx`、`conversation-create.ts`、`conversation-creator.ts` |
| 🗂️ **历史会话路由与事件** | 新增历史路由与历史事件支撑，用于跨版本会话日志的读取与兼容 | `core/session/src/historical-route.ts`、`historical-events.ts` |
| 🏢 **Collab Studio 增强** | 驱动、存储与类型层增强（`driver.ts` / `store.ts` / `types.ts`），配套测试扩充 | `packages/web/collab-studio/` |
| 🔌 **LLM 适配与插件清单** | `llm-deepseek` 序列化与类型、`llm-pi-ai` 适配与配置、插件包清单（含测试）配套更新 | `packages/llm/`、`plugin-package-inventory-deepseek` |

### 新增：破甲（Jailbreak）红队模式

用于**红队安全评估**的实验性功能：新增 `jailbreak` agent preset 与 `packages/jailbreak/jailbreak-mode` 插件，
对所有模型请求自动注入可选策略的破甲指令（内置 `authorized-ctf`、`tvd-guard` 等策略，`/jailbreak` 命令切换），
并在 GUI 提供策略芯片（`ui-jailbreak`）。⚠️ 仅限授权安全评估场景使用，详见 [免责声明](DISCLAIMER.md)。

### 其它修改

- 依赖调整：`react`/`react-dom` 提为根级依赖、`lightningcss` 锁版等（`package.json`、`pnpm-lock.yaml`）。
- 文档：新增 `docs/subsystems/jailbreak*`，更新 persistence / web-server / workspace / config-catalog 等（中英双语）。
- 压缩（compaction）、`llm-pi-ai` 适配器、系统提示词、已知事件类型等处的配套修改。
- 完整清单见 [MODIFICATIONS.md](MODIFICATIONS.md)。

## 快速开始

> 前置：Node.js `^22.19.0 || >=24.0.0` 与 pnpm。

```sh
git clone https://github.com/bainianling/deepseek-harness-plus.git
cd deepseek-harness-plus
pnpm install
pnpm run build
pnpm dsh web        # 打开 http://127.0.0.1:3080
```

模型凭据按原版方式提供（环境变量 `DEEPSEEK_API_KEY`、`$DSH_HOME/.credentials.yaml` 或 GUI 引导），详见原版文档。

部分功能分区依赖**额外的本机服务**，需自行准备（本仓库不包含这些服务本身）：

| 功能 | 依赖 |
| --- | --- |
| LoRA 训练工作室 | 本机 `127.0.0.1:8918` 的 LoRA 训练服务（kohya sd-scripts 封装） |
| 声线克隆 | 本机 `127.0.0.1:8917` 的 IndexTTS 语音服务（服务地址可在浏览器 localStorage `dsh.voiceServiceUrl` 覆盖） |
| 知识库 | 本机运行的 Hindsight 记忆库及其投影配置 |
| AI 实时新闻 | 访问各平台热榜的网络条件（可配置代理与翻译服务端点） |

## 许可证与来源

- 原版：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT License，Copyright (c) 2026 DeepSeek。
- 本仓库沿用 [MIT License](LICENSE)；相对原版的修改说明见 [MODIFICATIONS.md](MODIFICATIONS.md)。
- 本项目与 DeepSeek 无任何隶属或背书关系。免责声明见 [DISCLAIMER.md](DISCLAIMER.md)。

---

## English summary

This is a **personal modified fork** of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(initial baseline commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`, currently synced through
`dsh-v0.1.5-rc.2`, MIT License). It is **not** an official DeepSeek product.

On top of the upstream agent harness, this fork extends the Web GUI into a multi-function workbench:
AI news aggregation, a read-only skill marketplace, a Hindsight knowledge-center view, a multi-model
benchmark bench, a LoRA training studio (local kohya-based service), a multi-agent "virtual software
company" studio, voice cloning against a local IndexTTS service, a built-in browser panel and terminal,
automation scheduling, wallpapers, LAN-share control, per-session agent preset switching, cross-workspace
conversation moves, a stop-server action, session import/delete, and an experimental jailbreak preset
intended **only** for authorized red-team security evaluation. The current release adds a session-level
dual-model (thinking/worker) role split, one-click prompt enhancement with bounded workspace context, and a
conversation-creation flow that turns an authored draft into a real session. See [MODIFICATIONS.md](MODIFICATIONS.md)
for the full change list and [DISCLAIMER.md](DISCLAIMER.md) for the disclaimer.

Quick start: `pnpm install && pnpm run build && pnpm dsh web` (Node.js `^22.19.0 || >=24.0.0`, pnpm required).
