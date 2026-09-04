# Agent Note: Model capability metadata precedes model environments

Status: implemented

English | [中文](2026-09-03-model-capability-catalog.zh.md)

## Problem

The model selector exposed provider, model, and reasoning effort, but the harness could not tell an environment resolver which wire protocol or state strategy an exact model route actually used. Treating OpenAI Responses and DeepSeek chat-completions as interchangeable would make later native-state and compaction work claim behavior the adapter does not yet implement.

## Decision

`dsh-llm` now accepts optional exact-model capability metadata owned by each adapter. The record identifies the wire protocol, state strategy, prompt-cache ownership, native compaction, background execution, and parallel tool-call support. `LlmRuntime` validates and detaches the record, and the Session Controller projects it through the existing model catalog.

The direct DeepSeek adapter reports its chat-completions transport and current client-replay implementation. The pi-ai adapter reports each resolved pi-ai API and its current client-replay implementation. Neither adapter claims provider-managed state, native compaction, or background execution before those behaviors have durable replay and lifecycle support.

The metadata is descriptive only. It does not change request dispatch, add a session event, or alter model selection in this change.

## Alternatives considered

- **Infer protocol and features in the Session Controller** — rejected because the adapter owns the exact route and is the only layer that knows which behavior its dispatch path implements.
- **Add a separate model-environment package immediately** — deferred because an environment needs both capability metadata and a selected AgentPreset/task policy; adding the registry before native protocol behavior would create a second source of truth.
- **Expose every provider feature as a boolean** — rejected because a provider may support a feature while the installed adapter does not. The fields describe installed behavior, not upstream marketing capability.

## Consequences

Model-environment work can now consume a stable, validated catalog record without probing providers or duplicating adapter knowledge. Third-party adapters remain compatible when they omit the optional field. The current catalog carries no native Responses continuation, compaction item, or background job, so those features still require separate durable session and adapter changes.

## Testing

The LLM service tests cover valid detached metadata, omission, and invalid values. Direct DeepSeek, pi-ai Responses, and Host catalog tests cover the built-in declarations and projection.
