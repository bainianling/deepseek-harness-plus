# Design: Model Capability Catalog

## Boundary

`@deepseek-ai/dsh-llm` owns the provider-neutral capability type and validates
adapter-returned records. Each adapter owns the values for the exact route it
serves. `@deepseek-ai/dsh-api-session-controller` projects the detached record
into its existing model catalog. No session event is needed because this is
descriptive metadata and does not change a model-visible request.

## Capability record

```ts
interface LlmModelCapabilities {
  protocol: string
  state: 'client-replay' | 'provider-managed'
  promptCaching: 'none' | 'provider'
  nativeCompaction: boolean
  background: boolean
  parallelToolCalls: boolean
}
```

`protocol` stays a string because adapter-specific gateways can expose
protocols not known by the core package. The remaining fields describe only
behavior the installed adapter can actually provide. Existing model metadata
fields remain independent so capability additions do not alter image or
reasoning validation.

The direct DeepSeek adapter reports `chat-completions`, `client-replay`,
provider prompt caching, no native compaction, no background execution, and
parallel tool calls. The pi-ai adapter reports its exact `Model.api`,
`client-replay`, provider prompt caching only for the routes where the adapter
currently writes a cache key, and false for native state/compaction/background.
Its parallel-tool declaration follows the adapter's current common tool-call
path rather than the provider's undocumented theoretical support.

## Validation and projection

`LlmRuntime.normalizeModelInfo()` validates enum values, a non-empty protocol,
and boolean feature values, then clones the record. The Host catalog copies the
record into `ModelCatalogModel`. Client code need not change behavior in this
phase because all new fields are optional on the wire-facing catalog type.

## Testing

- Add LLM service cases for cloning, omission, and each invalid field.
- Add direct DeepSeek adapter assertions for the exact resolved metadata.
- Add pi-ai catalog assertions for an OpenAI Responses model and a standard
  model, including the cache declaration.
- Add Host catalog projection coverage.

## Follow-up seams

Later work can add a model-environment resolver that combines these capabilities
with an `AgentPreset` and task policy. Native Responses state must first add
durable response/reasoning items to the session log; native compaction must
first add opaque compaction items and replay rules. Those changes are separate
because they alter model-visible state and require snapshot updates.
