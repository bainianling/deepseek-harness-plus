---
description: "已记录的破甲模式评估能力包映射：策略注入、持久状态、命令和会话投影。"
kind: "package-group"
---

# jailbreak/ — 红队破甲模式

[English](README.md) | 中文

破甲模式是按 agent（智能体）分别记录到日志的协作状态，用于红队安全评估：激活时它会改写模型输入（一个 system 块加上逐条消息的包装），而不是通用模式注册表或能力 seam。

| 包 | 角色 | ctx key |
|---|---|---|
| [`jailbreak-mode/`](jailbreak-mode/README.zh.md) | 拥有破甲模式状态、策略注入、命令和投影 | `ctx.jailbreakMode` |

子系统参考：[docs/subsystems/jailbreak.zh.md](../../docs/subsystems/jailbreak.zh.md)。
