# Agent Note: 模型环境计划在协议发布前持久化

Status: implemented

[English](2026-09-03-model-environment-diagnostic.md) | 中文

## Problem

模型目录已经识别 adapter 能力，但模型选择仍只公开 provider、model 和 reasoning effort。因此，未来的协议、状态、压缩或后台任务选择没有统一位置来校验路由是否支持，也无法解释某个任务为什么获得了特定的执行环境。

## Decision

Session Controller 现在提供纯 `resolveModelEnvironment()` 函数和无凭据的 `modelEnvironment` Remote 方法。解析器接收一条精确的 provider/model 路由、可选的已验证能力、一个 Agent preset、任务策略和显式覆盖，然后返回一份 detached 且冻结的计划，其中包含稳定 reason code。Host 会在发布新建 Agent 前解析该计划并记录为 `model/environment`；模型切换会解析下一份计划，并在记录 `model/selection` 前检查兼容性。

当能力元数据缺失时，解析器默认使用未指定协议、客户端回放、不使用 provider prompt caching，以及调用方传入的前台、basic、串行任务策略。它会拒绝未知 preset 和路由未声明支持的覆盖。诊断会解析 provider 元数据与当前可用的 preset 名单，并在不转发 adapter 错误消息的情况下分类路由解析失败；但不会读取凭据、执行模型 I/O（路由元数据解析除外）或挂载插件。Session 创建与模型选择使用同一个解析器，并且只写入与 provider 无关的计划元数据；诊断方法本身仍是只读的。

本阶段不会改变 Agent prompt assembly，不会启用 OpenAI Responses continuation、provider-managed state、后台 job 或 native compaction。这些更改仍属于模型环境升级方案的后续阶段。

## Alternatives considered

**根据 provider 或 model 名称推断行为。** 不采用，因为别名和兼容路由可能共享名称，却提供不同的协议和状态行为；adapter 拥有的能力记录才是权威输入。

**把默认值和校验放进每个 adapter 的请求方法。** 不采用，因为调用方无法在模型 I/O 前诊断完整环境，而且每个 provider 都会重复任务策略和 preset 检查。

**立即把解析器拆成新的 capability package。** 不采用，因为目前只有一个拥有方和一个消费者。等出现独立消费者、确实需要单独的 Service Definition 与 provider 后，再放入独立包。

## Consequences

调用方可以在派发前拒绝不支持的环境请求，并在不暴露凭据的情况下显示稳定的路由诊断。新建 Session 现在会持久化解析后的计划，模型切换也不能静默改变协议、状态、压缩或后台语义。环境错误码成为 Remote 错误词汇的一部分，因此首个 tagged release 前如需改变其 details，必须有意识地调整协议格式。

`model/environment` event 与 `modelEnvironment` projection 会持久化计划，但不会启用 provider 专属执行。Responses item 回放、provider-managed continuation、后台 job 和 native compaction 仍需要各自的持久化事件、projection、snapshot 以及回滚测试后才能启用。在该 event 引入前创建的 Session 仍可读取；它们第一次兼容的模型选择会建立计划。

## Testing

解析器测试覆盖 DeepSeek 兼容能力、Responses 风格协议选择、缺失元数据回退、不可用 preset、不支持的压缩/后台/并行调用覆盖、结构化 Remote 错误、冻结计划和无凭据输出。Session Controller 模型测试通过 direct test Remote 覆盖诊断 Remote 方法、发布前记录环境 event，以及在写入 `model/selection` 前拒绝不兼容协议切换。
