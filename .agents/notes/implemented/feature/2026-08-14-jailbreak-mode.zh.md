# Agent Note：用于红队安全评估的破甲模式

Status: implemented

[English](2026-08-14-jailbreak-mode.md) | 中文

## 问题

DSH 会话没有内置的方式，对它们路由到的模型运行可复现的红队安全评估。研究者想要比较 ChatGPT、DeepSeek 或其他提供方在经典破甲技术下的表现时，不得不在每个请求里手动粘贴公开的 DAN/开发者模式/前缀注入提示词，并在整个会话中凭记忆保持状态。没有已记录的、按 agent 的模式可以自动改写用于评估的模型输入，也没有 UI 表面显示某个会话正在以该模式运行。

## 决策

新增 `dsh-jailbreak-mode`，一种直接仿照 `dsh-plan-mode` 构建的、记录到日志的按 agent 协作状态：`jailbreak/mode` 会话事件携带完整的 `{ active, strategy }` 值，`ctx.jailbreakMode` 拥有折叠与步骤边界提交，`jailbreak:policy` 系统提示词 section 在激活时于顺序 130（排在所有工具文档 section 之后，因此该策略是系统提示词的最后一条指令）渲染策略的 `system` 块，且每条被认领的用户消息会在请求组装前包装为 `前缀 + 原文 + 后缀`。工具结果消息永远不会被包装。模式切换叙述保持中性（"The user switched this session to a new operating mode."），只标记切换、不向模型点名破甲。`/jailbreak [off|strategy]` 命令负责进入、退出和切换策略；未知策略 id 会大声失败。`jailbreak` 投影单元把 `command/run` 与 `jailbreak/mode` 折叠为 `{ active, pending, strategy }`，供 Web 控件使用；控件位于新的 `conversation.input.jailbreak` 编辑器座位（`dsh-client-ui-jailbreak`）。

内置策略表提供十一种公开且被广泛记载的技术（`dan`、`developer-mode`、`stan`、`prefix-injection`、`persona`、`research-framing`、`authorized-ctf`、`evaluator`、`continuation`、`gpt56-sol-unrestricted`、`tvd-guard`），使部署方开箱即可运行可复现的评估；该表已导出且可扩展。经典人设/覆盖类条目逐字复现已记载的技术，而 `evaluator`（元评估框架——会话按指令遵循保真度评分，拒绝记为评估失败）与 `continuation`（文本续写框架——请求被框定为既有草稿的续写）覆盖了对现代安全训练模型仍然有效的技术类别。`tvd-guard` 策略是 TVD 自循环工具链：进入时会在会话工作区脚手架 Task/Validator/Data 骨架，并把工作区路径和验证器入口命令渲染进系统块，因此模型补全数据文件直到验证器通过，每次失败都以编程错误回流。破甲模式只是评估工具：它改写提示词，不改变沙箱模式、批准策略或提供方一侧的审核。

## 引入 preset 之后的宿主平面归属

与 `plan-mode` 一样，破甲状态天然是 per-agent 的，因此 Web 组合会禁用 base 的 `jailbreak-mode` 行，而 `standard` agent preset 会在条目局部 `isolate` realm（`jailbreakMode`）内挂载自己的实例。base bundle 为 headless/TUI 保留一个宿主行。

另有一个专用的 `jailbreak` agent preset 与 `standard`/`code`/`minimal`/`cordis` 并列：它是 standard 组合，但 jailbreak-mode 行配置了 `defaultActive: true`，因此在该预设下创建的会话无需 `/jailbreak` 命令即自动进入破甲模式。`defaultActive` 配置使服务仅在会话日志没有任何 `jailbreak/mode` 记录时，于 `agent/created` 时追加 `jailbreak/mode {active: true}`，从而保留恢复/refork 以及显式 `/jailbreak off`（或编辑器 chip）的状态。

## 测试

- `tests/projection.spec.ts` 驱动真实的 `jailbreak` 投影单元：空日志、待提交前保持 pending、不翻转状态地切换策略、`off` 指向未激活，以及缺少插件时键不存在。
- `tests/invariant.spec.ts` 在实时与延迟注册的流上校验 `jailbreak/mode` 载荷形状。
- `tests/jailbreak-mode.spec.ts` 在真实的 `SystemPrompt`/`ToolRuntime`/`AgentRegistry` 旁挂载真实插件，断言折叠语义、策略解析、section 渲染、消息包装、空闲与轮中选择、TVD 脚手架以及 `/jailbreak` 命令行为。
- `tests/tvd.spec.ts` 覆盖工作区根路径推导、脚手架幂等、`cwd` 回退以及失败降级。
- `apps/cli/config/agent-presets/standard` 与 base/web bundle 通过现有配置校验门禁获得组合级覆盖。

## 备选方案

**只包装系统提示词，不包装用户消息。** 仅 `system` 块与 plan-mode 相似，但作为破甲向量较弱；逐条消息的前缀/后缀是经典前缀注入形态，也是让该模式对评估 ChatGPT 级模型有用的关键。两者都很廉价，因此一并提供。

**通用模式注册表。** Plan mode 刻意不是通用注册表；破甲模式遵循同样的已记录状态模式，而不是发明一个平行的抽象。

## 后果

会话可以通过斜杠命令或编辑器 chip 切换到破甲模式再切回，模式、策略、被包装的消息和策略 section 都能仅凭会话日志重建（恢复、fork、压缩）。由于每条模型可见的改写都以 `user/message` 记录，模型可见 ⟺ 已记录规则成立。`/jailbreak` 命令与 chip 表面是可选的；headless 消费者可以直接驱动 `ctx.jailbreakMode.set()`。
