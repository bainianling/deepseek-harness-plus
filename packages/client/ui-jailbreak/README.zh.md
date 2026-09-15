---
description: "已记录的每 Agent 破甲模式评测命令的 Web Client 控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jailbreak

[English](README.md) | 中文

## 概述

`dsh-client-ui-jailbreak` 为已记录的每 Agent `/jailbreak` 评测模式添加 Web composer chip。它读取 Host 所有的 `jailbreak` 投影，在 `conversation.input.jailbreak` 中呈现活动状态控件，并通过 command channel 发送 `/jailbreak off`。它不拥有 Client 侧破甲状态，也不会改变沙箱或审批策略。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web Client 组合中与 `dsh-jailbreak-mode`、`dsh-api-remotes`、`dsh-client-locale` 和 conversation slot 包一起加载本包。当投影的有效目标为 inactive 时，chip 保持为空；破甲模式激活后它出现，让用户无需输入命令即可退出。

### 所有权

Host 包拥有 `/jailbreak`、策略选择、prompt wrapper、TVD 脚手架和持久状态。本包只拥有浏览器呈现，以及对 `remote.commands.execute(sessionId, '/jailbreak off', [])` 的调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Client 插件注册 `jailbreak` locale namespace，注入名为 `conversation.input.jailbreak` 的 slot，并通过通用 `useProjection` 路径推导活动状态。注入的 seat handler 分发退出命令，命令被拒绝时返回用户可见的错误字符串。本包不创建本地 store 或持久 event。

### 源码索引

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Client 插件、slot 注册、locale 初始化与命令分发 |
| [`src/client/JailbreakChip.tsx`](src/client/JailbreakChip.tsx) | 活动状态 chip 呈现 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文控件文案 |
| [`../../jailbreak/jailbreak-mode/README.zh.md`](../../jailbreak/jailbreak-mode/README.zh.md) | Host 所有的模式、策略与 prompt 行为 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Jailbreak mode](../../jailbreak/jailbreak-mode/README.zh.md) — 本控件驱动的 Host 能力。
- [Conversation UI](../ui-conversation/README.zh.md) — 本控件呈现位置旁边的 slot 所有者。
- [Client session](../ui-session/README.zh.md) — 控件使用的 Session 投影传输。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 chip 分发的 `/jailbreak off` 命令行：`dsh-jailbreak-mode` 拥有模型可见的策略 section、消息 wrapper、TVD 脚手架和已记录状态，本包只呈现投影并发送用户可以输入的命令。

#### KV Cache effect

进入或离开破甲模式会改变生效的 `jailbreak:policy` system-prompt section，从而改变请求前缀；chip 本身不添加 prompt 内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Chip 只负责退出模式**——进入模式和选择策略仍由 `/jailbreak` 所有。
- **Host 投影是权威来源**——缺少投影时 seat 保持为空，不创建 Client 状态。
- **失败文案保持英文**——命令错误呈现遵循现有错误表面策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

保持 slot 名称、投影 key、命令文本和 locale namespace 与 Host jailbreak 包及 conversation slot 声明同步。

</details>

**运行时不变式：** 不发布伴生入口。Chip 从 Host 投影状态推导，所有注册都会随 Client 插件 fiber 释放。
