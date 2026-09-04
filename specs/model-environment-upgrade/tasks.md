# Implementation Plan

Detailed sequencing, ownership, rollout, and acceptance evidence are in
[`next-stage-plan.md`](next-stage-plan.md).

- [x] 1. Freeze the environment vocabulary and policy precedence.
  - Add a pure resolver package or place the first resolver beside the owning
    Host session controller if no independent consumer exists yet.
  - Define task policy, route override, preset selection, reason codes, and
    stable configuration errors.
  - Add unit tests for fallback, precedence, malformed capabilities, and
    unsupported overrides.
  - _Requirements: 1, 5_

- [x] 2. Expose a secret-free environment diagnostic.
  - Project the immutable plan through the existing Host model catalog or a
    dedicated session diagnostic RPC.
  - Keep response ids, signatures, credentials, and raw provider payloads out
    of the client response.
  - Add client and Host tests for route failures and plan explanation.
  - _Requirements: 1, 6_

- [x] 3. Bind plan selection to session creation and model switches.
  - Resolve the plan before Agent publication for new sessions.
  - Revalidate plan compatibility when a model changes.
  - Log plan changes only when they affect model-visible requests or durable
    state; keep the existing request selection event for the route itself.
  - Add replay and conflict tests.
  - _Requirements: 2, 5, 6_

- [x] 4. Add provider-neutral Responses replay events.
  - Choose event payloads and redaction rules for response ids, response items,
    reasoning items, tool outputs, and terminal status.
  - Update TypeScript and Python SDK expected outputs and keyless snapshots.
  - Add restart, route-change, invalid-replay, and provider-error coverage.
  - Completed foundation: the event vocabulary, immutable reducer, Session
    persistence catalog, restart replay, route binding, and provider-failure
    tests are in place. Adapter emission and SDK/snapshot projections are
    tracked by the integration tasks below because they depend on the stream
    producer and loop ownership.
  - _Requirements: 3, 6_

- [ ] 5. Implement an explicit OpenAI Responses adapter.
  - Bind `previous_response_id` and client replay to one prepared adapter
    generation.
  - Gate provider-managed state behind capabilities and persisted replay data.
  - Add tool-call, reasoning, incomplete, and cancellation behavior.
  - _Requirements: 3, 5, 6

- [ ] 6. Integrate durable background Responses with jobs.
  - Persist ownership and continuation state.
  - Handle poll, reconnect, cancellation, completion, failure, and stale-job
    races.
  - Add keyless recorded-session snapshots for each transition.
  - _Requirements: 3, 6

- [ ] 7. Add native compaction only after replay support is complete.
  - Map provider compact results to the existing compaction replacement
    projection.
  - Keep basic compaction as the fallback for routes without native support.
  - Add balanced-range, cancellation, and restart tests.
  - _Requirements: 3, 5, 6

- [ ] 8. Add model-bench comparison and staged rollout controls.
  - Record the resolved plan beside latency, token, cache, tool, and task
    outcomes.
  - Add explicit deployment configuration for enabling provider-managed state,
    background mode, and native compaction per route.
  - Document rollback and failure classification.
  - _Requirements: 1, 6
