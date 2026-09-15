---
description: "支持多智能体软件公司流程、共识会议、分阶段交付与项目文件持久化的 Web bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-collab-studio

[English](README.md) | 中文

## 概述

`dsh-collab-studio` 添加协作区，让六个角色 Agent——CEO、CTO、产品、程序员、测试和文档——把一条需求经过会议、产出和评审。它把项目记录、追加式 event 和生成文件保存到 `$DSH_HOME/collab-studio`，并通过 `/api/collab` 提供给 Web GUI。

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

在 Web profile 中加载 `cordis.patch.yml`。Patch 会在 `webServer` 上插入 `collab-studio` Host row；GUI 可以根据需求创建项目、选择项目类型和阶段模型、启动或停止 pipeline、跟随 event 并读取生成文件。

### 项目 pipeline

每个阶段都可以在 producer 写入交付物前进行共识会议，产出后还可以运行 review-and-fix 循环。默认公司模板覆盖需求分析、架构、产品规划、实现、测试和文档；项目类型会调整阶段 prompt。

### HTTP surface 与默认值

Service 在 `/api/collab/projects` 下提供项目列表/创建/详情/启动/停止/删除、event 分页、文件列表和有界文件读取。Patch 默认启用 bundle，最多保留 32 个项目，每个项目保留 2,000 条 event tail，最多允许 4 轮会议；配置可以覆盖这些限制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Host 插件拥有项目 store 和运行 registry。每个角色都由项目工作目录中的完整 harness Agent 驱动；driver 选择角色路由，记录会议与阶段 event，并在 pipeline 结束时释放 Agent。控制请求仅允许回环访问，生成文件读取保持项目相对路径并受大小限制。

### 源码索引

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 插件、service、路由与运行生命周期 |
| [`src/engine.ts`](src/engine.ts) | 阶段执行与交付物流转 |
| [`src/consensus.ts`](src/consensus.ts) | Atomic-Chat 会议与决策逻辑 |
| [`src/driver.ts`](src/driver.ts) | 完整 harness Agent 角色 driver |
| [`src/store.ts`](src/store.ts) | 项目、event 与文件持久化 |
| [`src/prompts.ts`](src/prompts.ts) | 角色与阶段模板 prompt |
| [`cordis.patch.yml`](cordis.patch.yml) | Web bundle 组合与限制 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web app bundle](../../bundle/web-app/README.zh.md) — 共用 Web Host 与 GUI 组合。
- [Agent loop](../../core/agent-loop/README.zh.md) — 每个角色 Agent 使用的执行模型。
- [Session persistence](../../../docs/subsystems/persistence.zh.md) — 角色 Session 的持久化机制。
- [Collaboration panel](../../client/ui-layout/README.zh.md) — 消费本 service 的 Web Client 区域。

-----

<a id="model-experience"></a>
## 模型体验

### Role-agent prompt

#### What the model sees

每个角色 Agent 会收到项目需求、角色 persona、当前阶段主题、会议 transcript（如果有）以及交付或评审说明；角色 Session 使用相同的 harness prompt/tool 组合，只切换到所选模型路由。

#### Token effect

Token 消耗随角色轮次、会议轮数、评审轮数和生成文件内容增加；`maxMeetingRounds` 只限制会议讨论。

#### KV Cache effect

每个角色 Agent 拥有自己的 provider 请求序列；本 bundle 不在角色之间共享 KV cache，也不强制统一的 provider 缓存策略。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **这是一个编排模板**——角色 persona 和阶段 prompt 是默认值，不保证产出质量或共识正确性。
- **每个角色都会消耗模型能力**——一个 pipeline 可能创建多个并发或串行 Session，消耗较多配额。
- **生成文件是本地工件**——本 bundle 不会自动发布、部署、评审或提交到版本控制。
- **项目状态受配置限制**——event tail 和项目数量都有上限，停止或失败的运行需要人工检查后再重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

新增角色或生命周期阶段时，保持阶段模板、event 名称、项目 store 和 GUI event reader 一致。角色 Agent 必须继续使用常规 Agent registry 和释放路径。

</details>

**运行时不变式：** 一个项目运行拥有它创建的所有角色 Agent handle；关闭时会中止活跃运行，并等待其释放后再释放插件路由。
