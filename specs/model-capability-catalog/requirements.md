# Requirements: Model Capability Catalog

## Problem

The harness can select a provider, model, and reasoning effort, but its model
catalog does not describe the protocol and state features that determine the
best execution strategy. OpenAI Responses and DeepSeek chat-completions can
both serve tool calls while requiring different handling for state, caching,
reasoning, and compaction.

## Scope

This change adds provider-owned capability metadata to exact model resolution
and exposes it through the existing Host model catalog. The current request
path remains unchanged; the metadata is an input for later model-environment
selection and native protocol work.

## User Stories

- As a model selector, I can tell whether a model is served through Responses
  or Chat Completions.
- As an environment resolver, I can distinguish client-replayed state from
  provider-managed response state and identify native compaction support.
- As an adapter author, I can describe capabilities owned by an exact model
  without changing the provider-neutral request vocabulary.

## Acceptance Criteria

### Requirement 1: Exact model capabilities

1. When an adapter resolves a model, the LLM service shall preserve a detached
   capability record alongside context, modalities, output defaults, and
   reasoning metadata.
2. If an adapter omits capability metadata, the LLM service shall preserve the
   existing resolution result and request behavior.
3. When capability metadata is malformed, the LLM service shall reject it with
   a stable model-metadata error before provider I/O.

### Requirement 2: Built-in adapter declarations

1. When the direct DeepSeek adapter resolves a model, it shall identify its
   current chat-completions transport and client-replayed state.
2. When the pi-ai adapter resolves a model, it shall identify the pi-ai model
   API and the state/caching features actually implemented by this adapter.
3. The declarations shall not claim native Responses state or compaction until
   the adapter persists and replays those protocol items.

### Requirement 3: Host catalog projection

1. When the Host builds the model catalog, it shall project exact model
   capabilities without dropping existing catalog fields.
2. When a provider's model metadata lookup fails, the existing isolated provider
   failure behavior shall remain unchanged.
3. Existing clients that ignore the optional fields shall continue to load and
   select models.

### Requirement 4: Verification and documentation

1. The LLM service tests shall cover detached capability data, invalid data,
   and omission compatibility.
2. Adapter tests shall cover the OpenAI/DeepSeek capability declarations.
3. Package documentation shall explain the metadata's meaning and explicitly
   distinguish declared transport capability from behavior not yet implemented.

## Non-goals

- Switching the agent loop from Chat Completions to Responses.
- Adding `previous_response_id`, background Responses, or a model-facing
  compaction tool.
- Changing the durable session event format or existing model-selection UI.
- Inferring capabilities by probing a provider at request time.
