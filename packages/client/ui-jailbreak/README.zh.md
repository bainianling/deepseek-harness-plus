# @deepseek-ai/dsh-client-ui-jailbreak

[English](README.md) | 中文

破甲模式编辑器控件：占用 plan 座位旁名为 `conversation.input.jailbreak` 的座位，以激活状态 chip 呈现。破甲模式通过 `/jailbreak` 命令进入（由 [`@deepseek-ai/dsh-jailbreak-mode`](../../jailbreak/jailbreak-mode/README.zh.md) 拥有）；当宿主计算的 `jailbreak` 投影的有效目标为破甲模式时，chip 渲染并通过命令通道执行 `/jailbreak off`，否则座位保持为空。读取经由标准套件的 `useProjection` 使用通用投影对；零客户端破甲状态。

这是红队安全评估的表面：chip 是 Web 用户无需输入命令即可看到并离开破甲模式的方式。

## Model Experience

间接地，经由 chip 分发的 `/jailbreak off` 命令行：`@deepseek-ai/dsh-jailbreak-mode` 拥有该命令驱动下的模型可见策略 section、逐条消息包装、TVD 脚手架和已记录状态，而本包只渲染投影并发送用户同样可以输入的指令。

#### KV Cache 影响

进入或离开破甲模式会改变生效的 `jailbreak:policy` 系统提示词 section，从而改变请求前缀；chip 本身不添加任何提示词内容。

## 已知限制与后续工作

- chip 只负责退出破甲模式；进入和策略选择保留在 `/jailbreak` 斜杠命令上。
- 失败文案保持英文（错误表面策略）。
