# Agent Note: Model environment plans are durable before protocol rollout

Status: implemented

English | [中文](2026-09-03-model-environment-diagnostic.zh.md)

## Problem

The model catalog identifies adapter capabilities, but model selection still exposes only provider, model, and reasoning effort. A future protocol, state, compaction, or background choice therefore has no single place to validate route support or explain why a task received a particular execution environment.

## Decision

The Session Controller now exposes a pure `resolveModelEnvironment()` function and a secret-free `modelEnvironment` Remote method. The resolver accepts one exact provider/model route, optional validated capabilities, one Agent preset, a task policy, and explicit overrides, then returns a detached frozen plan with stable reason codes. Host resolves this plan before publishing a newly created Agent and records it as `model/environment`; model switches resolve the next plan and check compatibility before recording `model/selection`.

The resolver defaults missing capability metadata to an unspecified protocol, client-side replay, no provider prompt caching, and the caller's foreground/basic/sequential task policy. It rejects unknown presets and overrides that the route does not declare. The diagnostic resolves provider metadata and the available preset list, classifies route lookup failures without forwarding adapter messages, and does not read credentials, perform model I/O beyond route metadata resolution, or mount plugins. Session creation and model selection use the same resolver and write only provider-neutral plan metadata; the diagnostic itself remains read-only.

This stage does not change Agent prompt assembly, enable OpenAI Responses continuation, enable provider-managed state, add background jobs, or select native compaction. Those changes remain later stages of the model-environment upgrade plan.

## Alternatives considered

**Infer behavior from provider or model names.** Rejected because aliases and compatible routes can share names while exposing different protocols and state behavior; the adapter-owned capability record is the authoritative input.

**Put defaults and validation inside each adapter's request method.** Rejected because a caller cannot diagnose a complete environment before model I/O, and each provider would reproduce task-policy and preset checks.

**Make the resolver a new capability package immediately.** Rejected because the resolver currently has one owner and one consumer. It stays beside Session Controller until an independent consumer requires a separate Service Definition and provider.

## Consequences

Callers can fail unsupported environment requests before dispatch and can display stable route-level diagnostics without exposing credentials. New Sessions now persist the resolved plan, and model switches cannot silently change protocol, state, compaction, or background semantics. The environment error codes become part of the Remote error vocabulary, so future changes must preserve their details or deliberately revise the wire contract before the first tagged release.

The `model/environment` event and `modelEnvironment` projection persist the plan without activating provider-specific execution. Responses item replay, provider-managed continuation, background jobs, and native compaction still require their own durable events, projections, snapshots, and rollback tests before activation. Sessions created before this event existed remain readable; their first compatible model selection establishes the plan.

## Testing

The resolver tests cover DeepSeek-compatible capabilities, Responses-style protocol selection, missing-metadata fallback, unavailable presets, unsupported compaction/background/parallel-call overrides, structured Remote errors, frozen plans, and secret-free output. Session Controller model tests cover the diagnostic Remote method through the direct test Remote, pre-publication environment-event recording, and rejection of incompatible protocol changes before `model/selection` is written.
