# Requirements: Model Environment Upgrade

## Problem

The harness can select a model and expose adapter capability metadata, but the
selected model still runs through one client-replay execution path. OpenAI
Responses models, DeepSeek chat-completions models, and coding-agent models
need different state, tool, compaction, and long-task handling. A model choice
must therefore select a compatible execution environment without making the
agent loop provider-specific.

## Goal

Add a model-environment layer that resolves an exact model route to a validated
execution plan. The plan combines adapter capabilities, an agent preset, a
task policy, and deployment overrides. Native protocol features are added only
when their model-visible state is represented in the durable Session log.

## User Stories

- As a user, I can choose an OpenAI or DeepSeek model and receive the tool,
  context, reasoning, and long-task behavior supported by that route.
- As a deployment author, I can assign a model family to a preset and override
  the assignment for a specific provider/model route.
- As an adapter author, I can add native protocol behavior without changing
  `agent-loop` or inventing a second prompt and tool registry.
- As an operator, I can see why a route selected a protocol, preset, and
  compaction policy, and I can diagnose a rejected incompatible override.
- As a test author, I can replay a model-visible transcript without a live API
  key and verify that the environment decision is deterministic.

## Requirements

### Requirement 1: Environment resolution

1. The resolver shall accept an exact provider/model route, its validated
   `LlmModelCapabilities`, a task policy, and the available preset roster.
2. The resolver shall return a detached plan containing the selected protocol
   mode, state mode, prompt/tool preset, compaction mode, background mode, and
   parallel-tool policy.
3. Every selected plan field shall be explainable by a stable reason code and
   the source that supplied it: route, preset, task policy, or deployment
   override.
4. An override that requires an unsupported capability shall fail before model
   I/O with a stable configuration error.
5. The resolver shall not infer capabilities by probing a provider at request
   time.

### Requirement 2: Preset and session ownership

1. Presets shall remain the owner of tools, system-prompt sections, skills, and
   compaction consumers.
2. The environment layer shall select or validate a preset at session creation
   and shall not mount a second per-session prompt/tool registry.
3. A model switch that changes only route-compatible request behavior may take
   effect on the next step; a switch that changes preset or durable protocol
   state shall be rejected while the session has incompatible history.
4. The selected environment shall be recorded when it changes a model-visible
   request or durable session behavior.

### Requirement 3: OpenAI Responses execution

1. A Responses adapter shall preserve response ids, response items, tool-call
   outputs, reasoning items, and incomplete/failed terminal status needed to
   reconstruct the next request.
2. A request using provider-managed state shall identify the exact previous
   response or an explicit client replay fallback; it shall never silently mix
   ids from different provider/model routes.
3. Native Responses compaction shall be exposed only after the compaction item
   and its replay rules have a Session event representation.
4. Background responses shall be represented as durable jobs with ownership,
   cancellation, polling, completion, failure, and reconnect behavior.
5. A process restart shall be able to resume or explicitly abandon a background
   response without losing the session's last durable state.

### Requirement 4: DeepSeek chat-completions execution

1. The DeepSeek adapter shall keep client-replayed history as the authoritative
   request source.
2. Reasoning content needed by the provider shall remain in the durable
   assistant turn and be replayed according to the route's reasoning policy.
3. Stable request prefixes, cache-read usage, image projection, and image
   offload decisions shall remain adapter-owned and deterministic.
4. DeepSeek-specific request extensions shall remain model-hidden unless the
   provider explicitly makes them part of model input.

### Requirement 5: Compatibility and safety

1. Existing adapters that provide no capability metadata shall continue using
   the current client-replay plan.
2. An environment plan shall be immutable after resolution and detached from
   adapter-owned mutable metadata.
3. Provider credentials, response ids, signatures, and raw reasoning metadata
   shall not be exposed in ordinary client catalog responses.
4. Tool permissions and workspace policy shall be enforced by their existing
   host capabilities; model selection shall not relax them.
5. Unsupported combinations shall fail loud at the earliest resolvable point.

### Requirement 6: Verification and observability

1. Keyless recorded-session snapshots shall cover one DeepSeek client-replay
   turn, one OpenAI Responses replay turn, a compaction transition, and a
   background response transition.
2. Unit tests shall cover precedence, invalid overrides, route changes,
   restart/reconnect, cancellation, and detached plan data.
3. A diagnostic projection shall expose the selected environment's public mode
   and reason codes without exposing secrets or provider-private payloads.
4. Model-bench shall be able to compare plans and outcomes using the same
   task, workspace, and tool policy.

## Non-goals

- Making the agent loop contain OpenAI, DeepSeek, or pi-ai conditionals.
- Treating a model name as proof of support for a provider feature.
- Copying the ChatGPT or ZCode product UI or server architecture wholesale.
- Adding a second global tool registry or a second prompt assembly pipeline.
- Enabling native provider state before the Session log can replay it.
