# Agent Note: Responses replay uses provider-neutral durable lifecycle events

Status: implemented

English | [中文](2026-09-03-responses-replay-events.zh.md)

## Problem

Responses-style providers return a response id, an ordered collection of heterogeneous output items, and a terminal status that may be incomplete or failed. The existing assistant replay envelope is adapter-private and cannot reconstruct those facts after a restart or prove that a continuation stayed on the original route.

## Decision

The LLM vocabulary and Session event map now define three log-only events: `llm/response-opened`, `llm/response-item`, and `llm/response-closed`. An opening records the exact provider/model route, optional provider response id, and state strategy. Each item records that route, response id, a contiguous zero-based index, a provider-neutral kind (`message`, `reasoning`, `tool-call`, or `tool-result`), and adapter-validated JSON payload. The closing record repeats the route and response id, then records `completed`, `incomplete`, `failed`, or `cancelled` plus provider-neutral failure facts when present.

The adapter owns the wire boundary and must remove credentials, authorization data, signatures, and raw transport envelopes before appending an item payload. The reducer does not reinterpret provider payloads. It enforces one open response, exact route and response-id equality, contiguous item order, and close-after-open, returning immutable state and raising `INVALID_REPLAY_STATE` for a violation. A session restart replays the durable events; a later adapter decides whether the preserved response id can be continued natively or must be represented through client-side replay.

## Alternatives considered

**Keep all Responses data inside `assistant/message` replay metadata.** Rejected because item order, tool outputs, incomplete status, and response-level failure are not independently durable or inspectable, and generic Session consumers cannot validate route continuity.

**Persist the provider response JSON unchanged.** Rejected because raw responses may contain credentials, transport metadata, signatures, or provider-specific fields that are not needed for replay. Adapters must project a credential-free JSON payload before the Session append boundary.

**Let the reducer silently accept a route change.** Rejected because a response id has meaning only for its owning provider/model route; silently combining routes could send stale provider-managed state to the wrong endpoint.

## Consequences

Restart and persistence tests can reconstruct response items and terminal provider failures without depending on a live provider. Route changes, response-id changes, missing openings, duplicate openings, and item gaps fail deterministically. The event vocabulary is provider-neutral, but the current stage does not activate an OpenAI Responses wire adapter, provider-managed continuation, background jobs, native compaction, or SDK transcript changes; those remain later tasks with their own snapshots and rollback coverage.

## Testing

The LLM reducer tests cover ordered reasoning-style output, route and response-id changes, item gaps, duplicate openings, and closing without an opening. Session tests append a tool-call item and a failed provider response, reconstruct the event log through structured cloning and `Session.create(seed)`, then fold the restarted log. They also verify that a route change remains rejected after crossing the Session log boundary.
