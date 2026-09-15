# Design: Model Environment Upgrade

## Architecture

The upgrade has four owners with explicit data flow:

```text
exact route
    |
    v
LlmAdapter.resolveModel() -> validated capabilities
    |
    v
EnvironmentResolver(capabilities, task policy, preset roster, overrides)
    |
    v
immutable EnvironmentPlan
    |                         |
    v                         v
session creation/preset       LlmAdapter.prepareCall()
    |                         |
    +-------------> Agent step/request
                                  |
                                  v
                           Session events and projections
```

`EnvironmentResolver` is a pure host-side function. It does not mount plugins,
make network calls, inspect credentials, or mutate a Session. The session
controller owns when a plan is resolved and when a plan change is admitted.
The adapter owns provider wire conversion. Existing preset and capability
seams remain the only owners of their respective behavior.

## Public records

The first native-environment package should expose records similar to:

```ts
interface EnvironmentRequest {
  route: { provider: string; model: string }
  capabilities?: LlmModelCapabilities
  task: 'conversation' | 'coding' | 'review' | 'research' | 'maintenance'
  preset?: string
  overrides?: {
    protocol?: 'client-replay' | 'responses'
    compaction?: 'basic' | 'native' | 'disabled'
    background?: 'foreground' | 'durable'
    parallelToolCalls?: boolean
  }
}

interface EnvironmentPlan {
  route: { provider: string; model: string }
  preset: string
  protocol: string
  state: 'client-replay' | 'provider-managed'
  compaction: 'basic' | 'native' | 'disabled'
  background: 'foreground' | 'durable'
  parallelToolCalls: boolean
  reasons: readonly {
    field: string
    source: 'route' | 'preset' | 'task' | 'override' | 'fallback'
    code: string
  }[]
}
```

The exact types belong in a new capability package only after a consumer needs
them. Until then, the existing `LlmModelCapabilities` record remains the
source of truth for route facts. `protocol` stays open-ended; resolver modes
are closed and checked with `assertNever` where they are closed.

## Precedence

Resolution should be deterministic and visible:

1. Reject malformed route capabilities at the LLM service.
2. Resolve a deployment route override, if present.
3. Resolve the requested preset or the deployment default preset.
4. Apply the task policy's preferred environment.
5. Apply only overrides whose required capabilities are present.
6. Materialize defaults into an immutable plan and record reason codes.

An override cannot turn `nativeCompaction: false` into native compaction, and a
Responses protocol label cannot turn client replay into provider-managed state.
The resolver must distinguish a route's declared protocol from an adapter's
actual support for provider-managed state, background execution, and native
compaction.

## Presets

Do not create `openai`, `deepseek`, or `zcode` copies of the entire standard
preset. Keep a small number of task-oriented presets, for example:

- `coding-standard`: full shell, filesystem, search, LSP, skills, subagents,
  basic compaction, and conservative parallelism.
- `coding-ptc`: the same host policy with PTC as the execution surface.
- `review`: read-heavy tools, no write-capable tools unless explicitly granted,
  and a smaller context contribution.
- `research`: web tools and durable notes, with long-running work delegated to
  the job capability.

The model route selects protocol and request policy; the preset selects the
tool and prompt vocabulary. This keeps a DeepSeek model usable in a coding
preset and an OpenAI model usable in a review preset while allowing route
specific execution differences.

## Native Responses adapter

Add a separate provider adapter rather than teaching the current pi-ai adapter
to guess when a model is Responses-native. Its prepared call must bind one
immutable adapter generation to the exact route and expose a replay record that
the session layer can persist.

The durable event design should use provider-neutral event names with an opaque
provider payload, for example `llm/response-opened`, `llm/response-item`, and
`llm/response-closed`. The event payload must carry enough information to
reconstruct model-visible content and the provider continuation handle, while
redaction and telemetry must omit credentials. Raw provider items are accepted
only at the wire/parser boundary and validated before persistence.

Native compaction should be a separate provider operation. The adapter may use
the Responses compact endpoint only after the result can be represented as a
durable replacement in the existing compaction projection. Until then, the
resolver selects `basic` compaction and client replay.

Background mode belongs to the existing jobs capability, but the response
continuation record belongs to the session. A job completion cannot mutate a
session after ownership is lost; it must re-check the session generation and
append a classified event or publish a durable failure.

## DeepSeek adapter

Keep the direct DeepSeek adapter on chat-completions and keep the current
client-replay path. Make reasoning passback, image projection, cache usage, and
request extensions explicit in its prepared-call metadata. The adapter should
not introduce provider-managed ids merely because a future gateway exposes a
Responses-compatible endpoint.

## UI and diagnostics

The model selector should show route capabilities only as secondary metadata:
protocol, reasoning choices, context capacity, and supported long-task mode.
It must never promise a feature from a provider name alone. A diagnostic panel
or model-bench row can show the resolved plan and reason codes; ordinary model
selection responses should stay compact and secret-free.

## Migration

The migration is deliberately staged:

1. Keep the completed capability catalog as the compatibility layer.
2. Add a pure resolver and a host diagnostic RPC with no request behavior
   change.
3. Add plan selection at session creation and record plan changes.
4. Add native Responses persistence and keyless snapshots.
5. Enable provider-managed state for one adapter route behind explicit config.
6. Add durable background responses and reconnect handling.
7. Add native compaction after its event/projection contract is proven.

Each stage has an independently reversible config gate until the first tagged
release. No compatibility reader for pre-release durable formats is promised;
the monotonic session format policy remains authoritative.
