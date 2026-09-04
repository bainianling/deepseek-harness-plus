# DeepSeek Harness 私人二次开发版

[English](README.md) | 中文

本仓库是基于官方 DeepSeek Harness 的私人二次开发版本。它保留官方 `dsh` 命令和插件架构，并加入本仓库维护的 Web 界面、工作台、集成和模型环境能力。

它构建于**一切皆插件**的架构之上。

## 当前版本

当前代码基于截至 2026-09-04 核对的官方 Harness `0.1.2-rc.1` 代码线。仓库和核心源码包版本为 `0.1.2-rc.1`；[更新报告](docs/releases/2026-09-03-v3-update-report.zh.md)中记录的 Windows 桌面目录目标版本为 `3.0.0`。定制 Web 模块在适用时保留各自的预发行包版本。

## 本私人二次开发增加的内容

以下能力由本私人二次开发加入。源码链接指向对应实现；[更新报告](docs/releases/2026-09-03-v3-update-report.zh.md)记录当前模型环境与桌面端验证范围。

| 领域 | 二次开发增加的能力 | 所属源码 |
| --- | --- | --- |
| Web 外壳 | 增加应用级导航轨道，在 Harness 工作区旁提供终端、语音、新闻、LoRA、协作、模型评测、知识中心和技能市场分区；切换分区时保持活动聊天挂载。 | [`ui-layout/AppFrame`](packages/client/ui-layout/src/client/AppFrame.tsx) |
| 外观与侧栏 | 支持导入并通过浏览器 IndexedDB 持久化图片或视频壁纸，显示本地构建品牌和构建徽标，调整或收起侧栏，并保留外壳级刷新操作。 | [`wallpaper`](packages/client/ui-primitives/src/wallpaper.ts)、[`SidebarRoot`](packages/client/ui-sidebar/src/client/SidebarRoot.tsx) |
| 局域网共享 | Web 应用提供显式的 `/lan-share` 控制，只显示私有 IPv4 地址，生成可复制链接，并接受经过校验的 `dsh-viewport` 目标，使手机打开单列 Harness 页面。访问受保护且不会隐式开启。 | [`web-app`](packages/bundle/web-app/src/index.ts)、[`LanShareControl`](packages/client/ui-conversation/src/client/skeleton/LanShareControl.tsx) |
| 终端工作台 | 独立界面管理当前 Harness 会话的持久 PTY：打开、发送命令、读取有上限的输出、中断、关闭和刷新。 | [`TerminalApp`](packages/client/ui-layout/src/client/TerminalApp.tsx)、[`session-controller terminal API`](packages/api/session-controller/src/terminal.ts) |
| 浏览器面板 | Client 插件提供右侧浏览器截图历史和实时浏览器状态视图，并提供可复用的 Provider 与基于事件的集成入口。 | [`ui-browser-panel`](packages/client/ui-browser-panel/src/client/BrowserPanel.tsx) |
| 知识中心 | 只读 Hindsight 投影在 Web GUI 中显示页面树、事实、文档、观察、操作健康度、搜索和数据源可用性。 | [`KnowledgeHubApp`](packages/client/ui-layout/src/client/KnowledgeHubApp.tsx)、[`knowledge routes`](packages/bundle/web-app/src/knowledge.ts) |
| 技能市场 | 只读目录聚合 Agent Skills、MCP Servers 和 DSH 插件，提供源码链接、安装命令、风险证据、筛选、排序、刷新以及可选的模型辅助中文摘要。 | [`SkillMarketApp`](packages/client/ui-layout/src/client/SkillMarketApp.tsx)、[`market routes`](packages/bundle/web-app/src/market.ts) |
| AI 新闻 | Server bundle 聚合 Bilibili、抖音、小红书、X syndication 时间线和 AI RSS feed，在本地缓存封面图片，并通过 `/api/ai-news` 为 Web 新闻面板提供数据。 | [`dsh-ai-news`](packages/web/ai-news/src/index.ts) |
| 多智能体协作 | 协作工作室分配 CEO、CTO、产品、程序员、测试和文档角色；分阶段交付物前先进行共识会议，界面通过 `/api/collab` 展示项目事件和生成文件。 | [`dsh-collab-studio`](packages/web/collab-studio/src/index.ts) |
| 模型评测台 | 评测工作室在编程、文档、图像识别和论文四类中生成题目，通过相同 Harness 工具环境把同一题目发送给任意选定的模型集合，并记录耗时和裁判模型结论。 | [`dsh-model-bench`](packages/web/model-bench/src/index.ts) |
| LoRA 与语音集成 | 独立 Web 工作台提供本地 LoRA 训练与语音克隆／助手流程，包括模型或数据集管理、训练监控、音频上传或录制以及合成。这些面板需要单独运行的本地服务。 | [`LoraTrainApp`](packages/client/ui-layout/src/client/LoraTrainApp.tsx)、[`VoiceCloneApp`](packages/client/ui-layout/src/client/VoiceCloneApp.tsx) |
| Jailbreak 评测 | 记录每个 agent 的 `/jailbreak` 模式，为模型请求和用户消息应用所选策略，用于红队安全评测；client chip 显示活动状态并提供退出操作，沙箱和审批策略保持独立。 | [`jailbreak-mode`](packages/jailbreak/jailbreak-mode/README.zh.md)、[`ui-jailbreak`](packages/client/ui-jailbreak/README.zh.md) |
| 模型环境与回放 | 由提供方拥有的能力元数据、显式环境诊断、DeepSeek 与 Responses 路由描述以及有序响应生命周期事件，使模型路由和客户端回放可检查，同时不会通过暗示启用提供方管理的续接。 | [`模型环境需求`](specs/model-environment-upgrade/requirements.md)、[`响应回放`](packages/llm/llm/src/response-replay.ts) |

## 范围与限制

`dsh` 启动器、Cordis 插件架构、Session 日志、工具权限、沙箱策略和审批流程来自官方 Harness 基础。本私人二次开发在其周围增加产品界面和 provider 无关的扩展点，不会用另一套应用架构替换 agent loop。

局域网控制需要显式开启，并且只使用本机服务报告的地址。知识中心、新闻和技能市场依赖各自配置的数据源。LoRA 和语音面板需要单独的本地服务。Jailbreak 模式是评测工具，不会放宽沙箱或审批强制规则。本版本仍明确不提供提供方管理的原生 Responses 续接、持久化 Background Responses 任务和原生 Responses 压缩。

## 开发者预览

本私人二次开发处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/bainianling/deepseek-harness-plus.git
cd deepseek-harness-plus
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
