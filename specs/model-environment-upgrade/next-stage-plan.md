# 下一阶段方案：模型环境层与原生协议适配

## 目标

让模型选择不再只是切换 `provider/model/reasoningEffort` 三个字段，而是解析出一份可验证的执行计划：使用哪种线上协议、由谁持有会话状态、采用哪种压缩方式、是否支持后台任务、是否允许并行工具调用，以及当前会话使用哪套 Agent preset。

本阶段不把 ChatGPT、ZCode 或其他产品的实现直接搬进 Harness。Harness 保留自己的 Cordis 插件边界、Session 事件日志、Agent preset 和权限体系，只吸收这些产品体现出的有效分工：模型能力、工具环境、长任务状态和界面策略分别由对应层负责。

## 当前基线

上一阶段已经完成精确模型能力目录：

| 路由 | 当前协议 | 状态策略 | 原生压缩 | 后台任务 | 并行工具调用 |
|---|---|---|---:|---:|---:|
| 直连 DeepSeek | `chat-completions` | `client-replay` | 否 | 否 | 是 |
| pi-ai 普通路由 | 由 `Model.api` 决定 | `client-replay` | 否 | 否 | 是 |
| pi-ai Responses 路由 | `responses` 等 API 名称 | `client-replay` | 否 | 否 | 是 |

这些字段现在只描述适配器能力，不改变请求派发。下一阶段先增加解析器和诊断，再逐步接入原生协议；因此已有 DeepSeek 会话的请求行为保持不变。

## 总体架构

```text
模型目录 + Agent preset + 任务策略 + 部署覆盖
                         |
                         v
              ModelEnvironmentResolver
                         |
                         v
                 immutable EnvironmentPlan
                    /                   \
                   v                     v
         Session 创建/切换             LlmAdapter.prepareCall
                   |                     |
                   +----------+----------+
                              v
                     Agent step / request
                              |
                              v
                   Session events / projections
```

`ModelEnvironmentResolver` 必须是纯函数：不读取凭据、不探测网络、不挂载插件、不修改 Session。Session Controller 决定什么时候解析和接受计划；Agent preset 决定工具、提示词、技能和权限组合；LLM adapter 决定 provider wire 转换；Session 层保存所有后续请求需要的模型可见状态。

## 执行计划字段

计划至少包含以下字段：

- `route`：精确的 provider 和 model。
- `preset`：本次 Agent 使用的 preset；它必须来自当前可用名单。
- `protocol`：适配器声明的线上协议，保持开放字符串。
- `state`：`client-replay` 或 `provider-managed`。
- `promptCaching`：`none` 或 `provider`。
- `compaction`：`disabled`、`basic` 或 `native`。
- `background`：`foreground` 或 `durable`。
- `parallelToolCalls`：本次 Agent 是否允许并行安全工具调用。
- `reasons`：每个决定的来源和稳定 reason code。

解析优先级固定为：LLM 服务校验能力字段、路由覆盖、preset 选择、任务策略、部署覆盖、能力约束校验、计划物化。任何覆盖都不能创造适配器没有声明的能力。例如，`nativeCompaction: false` 不能被配置项改成 `native`；Responses 协议名称也不能单独把 `client-replay` 改成 `provider-managed`。

## 阶段拆分

### 阶段 A：纯解析器和诊断

目标是让系统能够解释“为什么这个模型使用这个环境”，但不改变模型请求。

交付内容：

1. 在 Session Controller 旁实现纯 `resolveModelEnvironment()`；只有第二个独立消费者出现时，才拆成新的 capability package。
2. 定义 `EnvironmentRequest`、`EnvironmentPlan`、任务策略、部署覆盖和稳定错误码。
3. 校验 preset 是否存在，校验 `native`、`durable`、并行调用等覆盖是否满足路由能力。
4. 增加 secret-free 诊断接口，返回协议、状态、压缩、后台、并行和 reason codes。
5. 在 model-bench 中记录解析计划，但不把计划字段送入模型上下文。

验收：同一输入得到字节级稳定计划；缺少能力、未知 preset 和不支持覆盖均在模型 I/O 前失败；已有客户端忽略新增诊断字段时仍能正常选模。

### 阶段 B：计划绑定 Session 生命周期

目标是让新 Session 和模型切换拥有明确的环境归属。

交付内容：

1. 新 Session 在 Agent 发布前解析模型环境。
2. 运行中的模型切换先检查旧历史与新计划是否兼容。
3. 只有计划影响模型可见请求或持久化状态时才记录计划变化事件；单纯的 UI 诊断读取不写日志。
4. 为环境计划增加 projection，使冷读取、重连和 model-bench 可以读取相同结果。
5. 不允许模型选择绕过现有 workspace、sandbox、approval 或 tool permission 策略。

兼容规则：DeepSeek `chat-completions/client-replay` 可以在现有会话中继续切换；切换到 provider-managed 状态或不同的持久化协议时，必须创建新的模型消息系列，或者明确拒绝该切换，不能把两种历史直接拼接。

### 阶段 C：OpenAI Responses 的 provider-neutral 回放

目标是先解决持久化和重启恢复，再启用 provider-managed 状态。

建议增加的事件类别包括：响应打开、响应 item、工具输出、响应结束；最终名称以事件归属审查为准。事件需要记录：

- provider/model 路由身份；
- response id 或等价的继续句柄；
- 模型可见的 reasoning、text、tool call 和 tool result 内容；
- incomplete、cancelled、failed 等终止状态；
- 适配器版本或 replay schema 版本。

凭据、Authorization 标头和无关的 provider 私有数据不得进入 Session 事件、普通诊断接口或 telemetry。响应 item 在 wire/parser 边界校验，持久化层只接受可重放的 JSON 数据。

这一阶段先实现前台 Responses 请求的客户端回放模式：每次请求根据 Session 日志重建输入，不依赖 `previous_response_id`。这样可以独立验证 Responses 的 item 转换、工具调用、reasoning、取消和错误行为。

### 阶段 D：provider-managed state

只有阶段 C 的事件、projection、重启恢复和 keyless snapshot 全部通过后，才为指定路由启用 `previous_response_id` 或等价的 provider continuation。

启用条件：

1. response id 与 provider/model 路由绑定，换路由后不得继续使用旧 id。
2. Session 日志可以恢复最后一个可继续的 response 状态。
3. provider 返回无效或过期 id 时，适配器能够分类失败并按显式策略退回客户端回放，不能静默丢失历史。
4. 同一 Session 的并发请求、取消和重连不会重复提交或交叉使用 continuation。
5. provider-managed 计划由显式部署配置开启，默认保持 `client-replay`。

### 阶段 E：后台 Responses 与 jobs

后台响应必须同时拥有两种身份：Job 负责调度、轮询、取消和 UI 状态；Session 负责保存响应 continuation 和模型可见结果。

交付内容：

1. 创建、轮询、重连、完成、失败、取消的持久化状态。
2. Session generation 检查，防止过期 Job 把结果写入新会话或旧路由。
3. Host 重启后恢复可继续 Job；无法继续时写入明确的 durable failure。
4. 前台和后台模式共享同一 adapter replay 规则，不复制一套请求转换逻辑。
5. UI 只读取 Job 和 Session projection，不直接读取 provider response payload。

### 阶段 F：原生压缩

原生压缩最后接入。OpenAI compact 或其他 provider 压缩接口返回的结果，必须先能够映射为现有 compaction replacement projection，再允许 resolver 选择 `native`。

验收条件：

- 压缩前后的模型可见历史可以从日志重建。
- 工具调用和工具结果配对不被破坏。
- 压缩取消、provider 失败、进程重启和重复提交都有明确状态。
- 不支持原生压缩的路由自动使用现有 `basic` compaction，且不改变 DeepSeek 路由。

## Preset 设计

不要按 provider 复制 `openai`、`deepseek`、`zcode` 三套完整 preset。建议保留任务导向的少量 preset：

| preset | 主要工具环境 | 适用任务 |
|---|---|---|
| `coding-standard` | shell、filesystem、LSP、skills、subagents、basic compaction | 常规编码 |
| `coding-ptc` | 与 standard 相同，代码执行走 PTC | 需要程序化工具调用的编码 |
| `review` | 读操作、差异分析、有限写权限 | 代码审查和变更评估 |
| `research` | web、文件整理、notes、jobs | 多来源研究和长任务 |

模型路由选择协议和状态策略，preset 选择工具和提示词。这样同一个 DeepSeek 模型可以运行在 coding 或 research 环境，同一个 OpenAI 模型也可以运行在 review 环境，不会因为模型名称而隐式获得额外权限。

## 测试与证据

每个阶段都需要独立的无 key 验证：

| 阶段 | 必要测试 |
|---|---|
| A | 解析优先级、默认值、未知 preset、能力不足覆盖、计划 detached |
| B | 新建、恢复、模型切换、计划 projection、冲突拒绝 |
| C | Responses text/reasoning/tool item、incomplete、cancel、重启回放 |
| D | `previous_response_id` 绑定、无效 id、换路由、fallback |
| E | Job 轮询、重连、取消、过期 generation、Host 重启 |
| F | balanced range、压缩失败、重启恢复、重复提交 |

涉及模型可见内容的阶段必须同时更新 TypeScript SDK、Python SDK、记录会话 snapshot 和 model-bench 预期输出。普通单元测试不能替代这些回放证据。

## 发布和回滚

发布顺序固定为：

1. 能力目录保持默认启用，但不改变请求路径。
2. 纯解析器和诊断默认启用，计划只作为只读结果。
3. Session 计划绑定默认启用，原生协议开关保持关闭。
4. Responses 前台客户端回放按单一路由灰度。
5. provider-managed state 按路由显式开启。
6. 后台任务和原生压缩分别开启，不能共用一个总开关。

任一阶段发生错误时，回滚目标是上一阶段的 plan mode：provider-managed 回退到 client-replay，native compaction 回退到 basic，durable background 回退到 foreground。回滚不能删除已有事件，也不能重写历史；不兼容的旧状态必须以分类错误结束并保留诊断。

## 主要风险

- **把协议名称当成能力**：通过 `LlmModelCapabilities` 和 resolver 约束解决。
- **provider id 跨路由复用**：用 provider/model/adapter generation 绑定 continuation。
- **后台结果写入错误 Session**：用 durable ownership 和 generation 检查解决。
- **压缩破坏工具配对**：复用现有 balanced-range 规则，先做 projection 再开启 native。
- **preset 复制造成配置分裂**：preset 按任务定义，provider 差异留在 adapter 和 plan。
- **诊断泄露凭据或 reasoning 私有字段**：诊断只返回公开 plan 和 reason codes。

## 研究依据

- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI Responses compact](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/)
- [DeepSeek KV cache](https://api-docs.deepseek.com/guides/kv_cache/)
- [ZCode agent framework](https://zcode.z.ai/en/docs/agent-framework)
