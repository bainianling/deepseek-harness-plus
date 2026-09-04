# Agent Note: Responses 回放使用与 provider 无关的持久化生命周期事件

Status: implemented

[English](2026-09-03-responses-replay-events.md) | 中文

## Problem

Responses 风格 provider 会返回 response id、有序的异构 output item 集合，以及可能为 incomplete 或 failed 的终态。现有 assistant replay envelope 只属于 adapter，无法在重启后重建这些事实，也无法证明 continuation 始终留在原路由上。

## Decision

LLM 词汇与 Session event map 现在定义三个仅记录事件：`llm/response-opened`、`llm/response-item` 和 `llm/response-closed`。Opening 记录精确的 provider/model 路由、可选的 provider response id 与状态策略。每个 item 记录该路由、response id、连续的从零开始序号、与 provider 无关的 kind（`message`、`reasoning`、`tool-call` 或 `tool-result`），以及经过 adapter 校验的 JSON payload。Closing 重复记录路由与 response id，然后记录 `completed`、`incomplete`、`failed` 或 `cancelled`，并在存在时记录与 provider 无关的失败事实。

Adapter 拥有 wire 边界，必须在追加 item payload 前移除凭据、授权数据、签名和原始传输 envelope。Reducer 不重新解释 provider payload。它强制一个 response 只能有一个 opening、路由与 response id 必须精确相等、item 序号必须连续、closing 必须发生在 opening 之后；违反时返回不可变状态并抛出 `INVALID_REPLAY_STATE`。Session 重启会回放持久化事件；后续 adapter 再决定保留的 response id 是否可以原生 continuation，还是必须使用 client-side replay。

## Alternatives considered

**把所有 Responses 数据留在 `assistant/message` replay metadata 中。** 不采用，因为 item 顺序、tool output、incomplete 状态和 response 级失败无法独立持久化或检查，通用 Session 消费方也无法校验路由连续性。

**原样持久化 provider response JSON。** 不采用，因为原始响应可能包含凭据、传输元数据、签名或回放不需要的 provider 专属字段。Adapter 必须在 Session append 边界前投影出不含凭据的 JSON payload。

**让 reducer 静默接受路由变化。** 不采用，因为 response id 只对拥有它的 provider/model 路由有意义；静默混用路由可能把过期的 provider-managed state 发送到错误端点。

## Consequences

重启与持久化测试可以在不依赖在线 provider 的情况下重建 response item 与 provider failed 终态。路由变化、response id 变化、缺少 opening、重复 opening 和 item 序号空洞都会确定性失败。事件词汇与 provider 无关，但当前阶段不会启用 OpenAI Responses wire adapter、provider-managed continuation、后台 job、native compaction 或 SDK transcript 变化；这些仍是后续任务，并需要各自的 snapshot 与回滚覆盖。

## Testing

LLM reducer 测试覆盖有序 reasoning 风格输出、路由与 response id 变化、item 序号空洞、重复 opening 以及没有 opening 的 closing。Session 测试追加 tool-call item 与 provider failed response，通过结构化复制和 `Session.create(seed)` 重建 event log，再折叠重启后的日志；它还验证路由变化穿过 Session log 边界后仍会被拒绝。
