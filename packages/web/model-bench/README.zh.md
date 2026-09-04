---
description: "支持并发多模型测试、自动生成问题、共享工具、计时与评审结论的 Web bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-model-bench

[English](README.md) | 中文

## 概述

`dsh-model-bench` 为 Web GUI 添加模型测试区。它生成一个编程、文档、视觉或论文问题，通过使用相同工具环境的完整 harness Agent，把同一问题发送给选定模型，记录各模型结果和耗时，并请求 judge model 给出 pass/fail 结论。Round 记录和工件位于 `$DSH_HOME/model-bench`，通过 `/api/bench` 提供。

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

在 Web profile 中加载 `cordis.patch.yml`。Patch 会在 `webServer` 上插入 `model-bench` Host row；GUI 可以创建 round、生成问题、选择 contestant 和可选 judge、启动或停止 contest、跟随 event 并读取有界结果文件。

### Round 流程

一个 round 包含生成的问题、每个所选模型对应的 contestant Agent，以及可选的 judge 阶段。Contestant 收到同一问题和部署默认 preset；只有模型路由不同。Vision round 使用 bundle 自带的 seed image，也可以把模型生成的材料写入 round 目录。

### HTTP surface 与默认值

Service 在 `/api/bench` 下提供 metadata/model catalog、round 列表/创建/详情/删除、生成/启动/停止、event 分页、文件列表和有界文件读取。Patch 默认启用 bundle，最多保留 64 个 round，允许 12 个 contestant；contestant 超时 20 分钟、问题生成 10 分钟、judge 15 分钟，配置可以覆盖这些值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

插件持久化 round 状态与 event，启动时处理被中断的 round，为每个 contestant 创建一个完整 harness Agent，并在完成或取消后释放所有 driver。问题生成、contestant 执行和 judge 共用有界阶段超时。控制路由要求回环请求，结果文件读取保持项目相对路径并受大小限制。

### 源码索引

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 插件、service、路由与运行生命周期 |
| [`src/engine.ts`](src/engine.ts) | 问题、contestant 与 judge 阶段 |
| [`src/driver.ts`](src/driver.ts) | 每个模型路由对应的完整 harness Agent driver |
| [`src/store.ts`](src/store.ts) | Round、event 与工件持久化 |
| [`src/prompts.ts`](src/prompts.ts) | 类别与 judge prompt 模板 |
| [`src/assets.ts`](src/assets.ts) | Vision round 的 seed image 准备 |
| [`cordis.patch.yml`](cordis.patch.yml) | Web bundle 组合与限制 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web app bundle](../../bundle/web-app/README.zh.md) — 共用 Web Host 与 GUI 组合。
- [LLM 能力](../../../docs/subsystems/llm-streaming.zh.md) — provider 路由与 streaming 行为。
- [Agent loop](../../core/agent-loop/README.zh.md) — contestant 与 judge 使用的执行模型。
- [Model bench panel](../../client/ui-layout/README.zh.md) — 消费本 service 的 Web Client 区域。

-----

<a id="model-experience"></a>
## 模型体验

### Contestant 与 judge 请求

#### What the model sees

每个 contestant model 会收到同一个生成问题、类别材料和部署默认工具环境；judge model 会收到问题与 contestant 输出用于比较，普通 harness 对话不会自动收到 benchmark 上下文。

#### Token effect

Token 消耗随问题生成、每个 contestant 的完整 Agent 运行和可选 judge 运行增加；`maxContestantsPerRound` 与阶段超时限制资源使用，但不会限制 provider 输出 token 数。

#### KV Cache effect

Contestant 和 judge 使用独立的 provider 请求序列；本 bundle 不承诺共享 KV cache 状态或跨模型缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **结果依赖部署**——模型版本、provider 延迟、凭据、工具和网络条件都会影响结果。
- **Round 不是标准化 benchmark**——生成问题和 judge prompt 是 harness 模板，不是外部校准的评测集。
- **视觉材料是本地 fixture**——seed image 准备在 round asset 目录中，不代表完整视觉测试套件。
- **长任务会消耗配额**——生成、contestant 和 judge 都会调用模型，浏览器 tab 关闭后仍可能继续，直到停止或完成处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

保持一个 round 的问题和 preset 分配对所有 contestant 一致。修改 event 持久化、阶段转换或文件名时，要同步 panel 的 event 和文件 reader。

</details>

**运行时不变式：** Run registry 拥有它创建的所有 contestant 与 judge Agent handle；释放时会中止活动 round，并在释放路由前等待清理完成。
