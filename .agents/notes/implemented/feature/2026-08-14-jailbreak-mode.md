# Agent Note: Jailbreak mode for red-team safety evaluation

Status: implemented

English | [中文](2026-08-14-jailbreak-mode.zh.md)

## Problem

DSH sessions had no built-in way to run reproducible red-team safety evaluations against the models they route to. A researcher who wants to compare how ChatGPT, DeepSeek, or other providers behave under classic jailbreak techniques had to hand-paste a public DAN/Developer-Mode/prefix-injection prompt into every request and keep the state in their head across the session. There was no logged, per-agent mode that automatically rewrites model input for evaluation, and no UI surface showing that a session is running in that mode.

## Decision

Add `dsh-jailbreak-mode`, a logged per-agent collaboration state modeled directly on `dsh-plan-mode`: the `jailbreak/mode` session event carries the whole `{ active, strategy }` value, `ctx.jailbreakMode` owns the fold and the step-boundary flush, the `jailbreak:policy` system-prompt section renders the strategy's `system` block at order 130 (after every tool-doc section, so the policy is the final system instruction) while active, and each claimed user message is wrapped `prefix + text + suffix` before request assembly. Tool-result messages are never wrapped. The mode-switch narration stays neutral ("The user switched this session to a new operating mode.") so it flags the flip without naming jailbreak to the model. The `/jailbreak [off|strategy]` command enters, exits, and switches strategies; unknown strategy ids fail loud. The `jailbreak` projection unit folds `command/run` + `jailbreak/mode` into `{ active, pending, strategy }` for the Web control, which lives in the new `conversation.input.jailbreak` composer seat (`dsh-client-ui-jailbreak`).

The built-in strategy table ships eleven public, widely documented techniques (`dan`, `developer-mode`, `stan`, `prefix-injection`, `persona`, `research-framing`, `authorized-ctf`, `evaluator`, `continuation`, `gpt56-sol-unrestricted`, `tvd-guard`) so deployments can run reproducible evaluations out of the box; the table is exported and extendable. The classic persona/override entries reproduce the documented techniques verbatim, while `evaluator` (meta-evaluation framing: the session is scored on instruction-following fidelity, so refusals register as evaluation failures) and `continuation` (text-continuation framing: the request becomes an existing draft to extend) cover the technique classes that remain effective on modern safety-trained models. The `tvd-guard` strategy is a TVD self-loop harness: entering it scaffolds a Task/Validator/Data skeleton into the session workspace and renders the workspace path and validator entrypoint into the system block, so the model completes the data file until the validator passes and each failure returns as a programming error. Jailbreak mode is an evaluation harness only: it rewrites prompts, and does not change sandbox mode, approval policy, or provider-side moderation.

## Host-plane ownership after presets

Like `plan-mode`, jailbreak state is per-agent by nature, so the Web composition disables the base `jailbreak-mode` row and the `standard` agent preset mounts its own instance inside an entry-local `isolate` realm (`jailbreakMode`). The base bundle keeps a host row for headless/TUI use.

A dedicated `jailbreak` agent preset ships beside `standard`/`code`/`minimal`/`cordis`: it is the standard composition with `defaultActive: true` on the jailbreak-mode row, so a session created under it starts in jailbreak mode without a `/jailbreak` command. The `defaultActive` config makes the service append `jailbreak/mode {active: true}` on `agent/created` only when the session log carries no prior `jailbreak/mode` record, so resume/refork and an explicit `/jailbreak off` (or the composer chip) are preserved.

## Testing

- `tests/projection.spec.ts` drives the real `jailbreak` projection unit: empty log, pending until commit, strategy switch without state flip, `off` targeting inactive, and key absence without the plugin.
- `tests/invariant.spec.ts` validates the `jailbreak/mode` payload shape on live and late-registered streams.
- `tests/jailbreak-mode.spec.ts` mounts the real plugin beside real `SystemPrompt`/`ToolRuntime`/`AgentRegistry` and asserts fold semantics, strategy resolution, section rendering, message wrapping, idle vs mid-turn selection, TVD scaffolding, and `/jailbreak` command behavior.
- `tests/tvd.spec.ts` covers workspace root derivation, scaffolding idempotency, the `cwd` fallback, and degrade-on-failure.
- `apps/cli/config/agent-presets/standard` and the base/web bundles carry composition-level coverage via existing config-verification gates.

## Alternatives considered

**Wrap only the system prompt, not user messages.** The `system` block alone mirrors plan-mode but is a weaker jailbreak vector; the per-message prefix/suffix is the classic prefix-injection shape and is what makes the mode useful for evaluating ChatGPT-class models. Both are cheap, so both ship.

**A generic mode registry.** Plan mode is deliberately not a generic registry; jailbreak mode follows the same logged-state pattern instead of inventing a parallel abstraction.

## Consequences

A session can be switched into jailbreak mode and back with a slash command or the composer chip, and the mode, strategy, wrapped messages, and policy section all reconstruct from the session log alone (resume, fork, compaction). Because every model-visible rewrite is logged as `user/message`, the model-visible ⟺ logged rule holds. The `/jailbreak` command and chip surface are optional; headless consumers can drive `ctx.jailbreakMode.set()` directly.
