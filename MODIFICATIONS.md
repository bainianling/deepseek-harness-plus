# 修改说明（MODIFICATIONS）

本文件依据 MIT License 的良好实践，说明本仓库相对原版
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的修改内容。
English note at the [end](#english-note).

## 基线

| 项 | 值 |
| --- | --- |
| 原版仓库 | <https://github.com/deepseek-ai/deepseek-harness> |
| 基线提交 | `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| 对应版本 | `0.1.2-alpha.1`（release 分支 `release/dsh-0.1.2-alpha.1` 的合并提交，PR #3248） |
| 原版许可证 | MIT License，Copyright (c) 2026 DeepSeek |
| 当前同步源码 | `dsh-v0.1.2-alpha.5`，来源工作树提交 `3b479baa1cec71898a95684a3daa21f40934ac7f` |

本仓库当前采用三段式发布历史：第 1 个提交是上游基线的原样导入（squashed import），第 2 个提交是首次二改完整体，第 3 个提交同步上游至 `dsh-v0.1.2-alpha.5` 并加入本次本地增强。
查看第 2、3 个提交的 diff，可以分别看到初始二改和后续增量改动。

## 总体规模

初始二改相对 alpha.1 基线：**389 个文件变更，+36,620 行 / −870 行；其中新增文件 173 个，修改文件 216 个。**

本次增量包含完整的上游 alpha.2–alpha.5 同步，以及模型测试台与本地化增强；上游同步会带来包重组、接口/测试夹具和双语文档变化，精确数量以本次发布提交的 Git diff 为准。

## 一、新增功能（按模块）

### 1. AI 实时新闻（`packages/web/ai-news/` 等）

新增 host 侧插件包 `packages/web/ai-news`：

- 平台爬虫：B 站（含 WBI 签名 `src/wbi.ts`）、抖音热榜、小红书探索页、X/Twitter（syndication 接口）、RSS/Atom 通用抓取。
- 内置 RSS 源：量子位、OpenAI News、The Verge AI、DeepMind Blog、Hugging Face Blog、MIT Tech Review AI（`src/crawlers/rssfeeds.ts`）。
- 可配置代理（`http://host:port`）、抓取间隔、条目上限；可选翻译管线（OpenAI 兼容端点，默认指向 DashScope 兼容模式，端点可配）。
- host HTTP 路由与持久化 store；客户端分区 `packages/client/ui-layout/src/client/NewsPanel.tsx`（+样式）。
- 配套测试：`tests/{wbi,twitter,xiaohongshu,rss,translate,store,config}.spec.ts`。

### 2. 技能市场（skill market）

- host 侧 `packages/bundle/web-app/src/market.ts`：只读公共开发者工具目录（skill / MCP / dsh-plugin 三类），
  返回元数据、安装命令与风险评级（low/medium/high/unknown + 依据信号）；**只读目录，不安装、不导入、不执行任何内容**，
  上游失败隔离，内置第一方基线条目保证离线可用；含模型辅助的条目摘要生成。
- 客户端分区 `SkillMarketApp.tsx`（+样式）；测试 `tests/market.spec.ts`。

### 3. 知识库（knowledge center）

- host 侧 `packages/bundle/web-app/src/knowledge.ts`：本地 Hindsight 记忆库的**只读适配器**，
  浏览器读取 DSH 自有的投影（文件夹/知识页树、页面内容、检索），不直连 Hindsight 内部 API；
  配置项：`hindsightUrl`、`hindsightBankId`、`knowledgeTimeoutMs`。
- 客户端分区 `KnowledgeHubApp.tsx`（+样式）；测试 `tests/knowledge.spec.ts`。
- 功能笔记 `.agents/notes/implemented/feature/2026-08-30-web-knowledge-center.*`。

### 4. 模型测试台（model bench）

- host 侧插件包 `packages/web/model-bench`：同一提示词并发投喂多个模型路由，收集输出、时延、用量并持久化（store）。
- 客户端分区 `ModelBenchApp.tsx`（+样式）；配套测试与 `cordis.patch.yml`。
- 本次增量强化题目合同：固定编程 / 文档 / 识图 / 论文四类题目；生成器必须按 `easy` / `medium` / `hard` 生成对应工作量、材料和参考答案；裁判使用难度对应的通过阈值与严格度。
- 引擎按难度缩放生成、作答、裁判超时预算（`easy=1x`、`medium=1.5x`、`hard=2.5x`），共享停止信号，并对阶段超时抛出可识别错误。
- 题目元数据解析具备防御性回退；裁判结果使用 `[BENCH_VERDICT]` 标记解析，支持中英文通过值、`/10` 后缀、最后一条标记优先和 0–10 分数钳制；新增中英文界面文案及覆盖这些合同的定向测试。

### 5. LoRA 训练工作室

- 客户端分区 `LoraTrainApp.tsx`（约 1,400 行）：封装本机 LoRA 训练服务（默认 `http://127.0.0.1:8918`，kohya sd-scripts），
  四个页签：底模管理（扫描/导入/删除/选择）、素材（数据集创建、导入、缩略图、逐图打标、WD14 自动打标）、
  训练（network dim/alpha、LR、调度器、轮次、分辨率、显存选项、SDXL/SD1.5 预设、启动/停止、step/loss/ETA 实时监控、
  loss 图表、日志尾随、样图预览）、模型库（已训 LoRA 列表、复制到 ComfyUI、试生成、LoRA 合并进底模）。
- 训练服务本体不在本仓库内，需自行部署。

### 6. 虚拟软件公司（Collab Studio）

- host 侧插件包 `packages/web/collab-studio`：多智能体「软件公司」协作编排（角色分工、任务流转、store 持久化）。
- 客户端分区 `CollabStudioApp.tsx`（+样式）；配套测试。

### 7. 声线克隆（IndexTTS）

- 客户端分区 `VoiceCloneApp.tsx`（约 900 行）：对接本机 IndexTTS 语音服务（默认 `http://127.0.0.1:8917`，
  可用浏览器 localStorage `dsh.voiceServiceUrl` 覆盖）的 TTS 工作台，暴露推理参数（top_p/top_k/temperature/
  repetition_penalty/max_mel_tokens 等），含参考音频管理与合成试听。
- `VoiceAssistant.tsx`：语音助手入口组件。
- 语音服务本体不在本仓库内，需自行部署；公开版本已将启动提示中的本机绝对路径改为通用的 `voice-clone\\start-voice-service.cmd`。

### 8. 内置浏览器面板

- 新包 `packages/client/ui-browser-panel/`：GUI 右侧内置浏览器面板（页面截图、状态、快照浏览），
  含鉴权与 host 侧测试 `tests/authentication.host.spec.ts`。

### 9. 内置终端（共享 Shell）

- host 侧 `packages/api/session-controller/src/terminal.ts`：会话控制器内的共享终端通道（持久 PTY）。
- 客户端分区 `TerminalApp.tsx`（+样式）；测试 `tests/session-file-import.host.spec.ts` 同批补充。

### 10. 自动化任务面板

- `packages/client/ui-sidebar/src/client/AutomationPanel.tsx`（+样式）：侧边栏自动化任务入口与调度管理面板；
  `SidebarRoot.tsx`、侧边栏 locales 配套修改。
- `packages/schedule/schedule/` 的 domain/runtime/tools/types 配套增强。

### 11. 壁纸更换

- `packages/client/ui-primitives/src/wallpaper.ts`、`WallpaperLayer.tsx`、`WallpaperPicker.tsx`：
  静态 + 动态壁纸层与选择器；`Button`/`Input` 基础样式微调，`ui-primitives/src/index.ts` 导出。

### 12. 停止服务按钮

- 客户端 `packages/client/ui-settings-general/src/client/StopServerAction.tsx`（+locales+测试）。
- host 侧 `packages/bundle/web-app/src/index.ts` 新增 shutdown API 路由（终止服务进程树，处理 Windows 监听进程父链），
  测试 `tests/shutdown-route.spec.ts`；`packages/host/webserver/src/index.ts` 配套。

### 13. 破甲（Jailbreak）红队模式

⚠️ 实验性功能，仅面向授权的红队安全评估：

- 新包 `packages/jailbreak/jailbreak-mode/`：注入策略（`authorized-ctf`、`tvd-guard` 等，`src/strategies.ts`、`src/tvd.ts`）、
  client/invariant/types，完整测试。
- 新客户端包 `packages/client/ui-jailbreak/`：策略芯片 `JailbreakChip`。
- 新 agent preset `apps/cli/config/agent-presets/jailbreak/`（`preset.yml` + `agent.cordis.yml`）。
- 文档 `docs/subsystems/jailbreak.{md,zh.md,i18n.yaml}`、功能笔记 `.agents/notes/implemented/feature/2026-08-14-jailbreak-mode.*`。
- 标准/最小 preset 的 `agent.cordis.yml` 与 `packages/core/system-prompt/` 相应调整（推理控制标签不进入聊天等）。

### 14. 会话与工作区增强

- 会话文件导入：`packages/api/session-controller/`（contract/sessions、manager、测试）。
- 会话删除：`packages/session/session-persistence-sqlite/`（`delete-session-events.sql`、`delete-session-row.sql`、store/sql）
  与 `session-persistence`、`session-persistence-jsonl` 配套。
- 跨工作区移动对话 / 工作区浏览：`packages/client/runtime/src/client/workspaces/`（manager/service/contract）、
  `packages/host/apiproxy/src/api/workspace*.ts`、`packages/client/ui-workspace/`（WorkspaceBrowser、Rows）。
- 会话内切换 Agent preset：`packages/client/ui-agent-preset/`（AgentPresetLabel 等）、
  `packages/host/apiproxy/src/api/agent-presets.ts` 及配套测试。
- 输入栏图片导入：`packages/client/ui-attachment/`（ComposerImageImport、ComposerAttachments、AttachmentRail）。
- 局域网共享开关：`packages/client/ui-conversation/src/client/skeleton/LanShareControl.tsx` + InputBar 调整。
- 模型余额入口：`packages/client/ui-model-selection/`（ModelBalanceAction）。

### 15. 主题与布局

- `packages/client/ui-layout/src/client/AppFrame.tsx`：应用级导航框架（承载上述功能分区）。
- `packages/client/ui-theme/src/styles/`：`design-platform.css`、`gradient-shadow-text.css`、`scrollbar.css`。
- `packages/client/ui-chat/`：CompactionItem、command 会话节点、消息样式微调。
- `packages/client/web/src/{platform,seed}.ts`：客户端壳引导配套。
- `packages/client/ui-trajectory/`、`packages/client/ui-settings-plugins/`（CompactionCard 等）细节调整。

## 二、配套修改（非新功能）

- `packages/bundle/base/cordis.patch.yml`、`packages/bundle/web-app/cordis.patch.yml`：挂载上述新插件行。
- `packages/compaction/compaction-basic/`：配置/设置/类型增强（缓存感知压缩相关）。
- `packages/llm/llm-pi-ai/`：adapter/catalog/config 调整与测试。
- `packages/core/session/src/known-event-types.ts`、`packages/extensions/*`（slot/api catalog）配套。
- `packages/host/apiproxy/`：RPC schema、fetch carrier、client handler 扩展。
- `packages/host/directory-picker-auto/`、`packages/workspace/workspace/`（entity/spec/types）调整。
- `packages/test-support/client-runtime/`：sessions/workspaces 测试支撑。
- `tsconfig.{base,client,host}.json`、`knip.json`：工程配置。
- `package.json` / `pnpm-lock.yaml`：`react`、`react-dom` 提为根级依赖；`lightningcss` 锁定 `1.32.0`。
- 文档（双语）：`docs/config-catalog*`、`docs/capability-seams*`、`docs/event-producer-consumer*`、
  `docs/persistence-catalog*`、`docs/subsystems/{persistence,web-server,workspace,README}*`、
  `packages/README*`、`packages/client/README*`、多个子包 README。
- Agent 笔记：`.agents/notes/implemented/feature/2026-08-14-jailbreak-mode.*`、
  `.agents/notes/implemented/feature/2026-08-30-web-knowledge-center.*`、
  `.agents/notes/implemented/bug-fix/2026-08-30-reasoning-control-tags-stay-out-of-chat.*`、
  `.agents/notes/implemented/process/2026-08-28-localmod-recovery-playbook.md`。

## 三、有意不包含的内容

以下存在于本地工作目录、但**有意排除**在本仓库之外：

- 构建产物与打包件（`dist/`、`*.tgz`）、`*.tsbuildinfo`、coverage、快照缓存等。
- 全部运行日志与测试输出（`*.log`、`*-out.txt` 等）。
- 本机专用启动/重启脚本（含机器特定路径，如 `start-dsh-web.bat`、`restart-dsh-web.*`）。
- 本地规划过程文档（`.planning/`）与代理工作区目录（`.sessions/`、`.dsh-build/` 等）。
- 上游 GitHub Actions 工作流（`.github/workflows/`）：这些工作流绑定上游官方 CI 基础设施
  （官方 secrets、专用 runner、发布流水线），在二次修改仓库中无法也不应运行，故整体移除；
  `.github/` 其余内容（issue 模板、dependabot 等）保留。
- 任何凭据：仓库内不含 `.env`、`.credentials.yaml`、API key 或令牌；全部密钥模式匹配均为上游测试夹具的占位假值。

## English note

This repository modifies the upstream project at baseline commit
`cd5ef8148158c3a752a658978873241fdf8e2bbc` (release `0.1.2-alpha.1`, MIT License).
The second commit in this repository contains the complete local modification set:
The initial modification commit changed 389 files, +36,620 / −870 lines (173 files added, 216 modified).
The current release also includes the upstream alpha.2–alpha.5 synchronization and a local model-bench increment:
strict four-category difficulty contracts, `easy`/`medium`/`hard` prompt rules, difficulty-scaled phase timeouts,
defensive metadata/verdict parsing, and matching English/Chinese UI copy with focused tests.

The modifications add, among other things: an AI news aggregation section, a read-only skill marketplace,
a Hindsight-backed knowledge center, a multi-model benchmark bench, a LoRA training studio wrapping a local
kohya-based service, a multi-agent collaboration studio, voice cloning against a local IndexTTS service,
a built-in browser panel and shared terminal, an automation scheduling panel, wallpapers, a stop-server
action, LAN-share control, per-session agent preset switching, cross-workspace conversation moves,
session file import/delete, composer image import, and an experimental jailbreak preset intended only for
authorized red-team security evaluation. Machine-local helper scripts, build artifacts, logs, the upstream
GitHub Actions CI workflows (bound to the official upstream CI infrastructure), and all credentials are
intentionally excluded.
