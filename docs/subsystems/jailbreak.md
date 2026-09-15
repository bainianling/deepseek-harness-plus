# Jailbreak Mode

English | [中文](jailbreak.zh.md)

Jailbreak mode is logged per-agent collaboration state owned by [dsh-jailbreak-mode](../../packages/jailbreak/jailbreak-mode) (`ctx.jailbreakMode`, `JailbreakModeController`): while active, the selected strategy's instruction block is appended to the system prompt of every model request and each claimed user message is wrapped with the strategy's prefix/suffix. Jailbreak mode is a **red-team safety evaluation** tool. [Sandbox mode](sandbox.md) and [approval policy](approval.md) enforce restrictions independently; neither reads or writes jailbreak state. The package is optional, and the agent loop does not depend on it. It contributes the `jailbreak:policy` prompt section and registers the `/jailbreak` command. The [package README](../../packages/jailbreak/jailbreak-mode/README.md) owns the model-experience and limitation detail.

Source: [`packages/jailbreak/jailbreak-mode/src/index.ts`](../../packages/jailbreak/jailbreak-mode/src/index.ts)

## Logged state and recovery

`jailbreak/mode` (`{ active: boolean, strategy: string }`) is a log-only, whole-value-replace [session event](session.md): durable and replayable, never in the model transcript. `foldJailbreakMode(events, end?)` returns the last logged `{ active, strategy }` pair in the prefix, or `{ active: false, strategy: <default> }` when there is none — the state in force is always a pure fold of the session log, so resume, fork, and compaction recover it with no live mirror, and UIs observe committed flips through `session/event`.

## Pending selections and the pre-step flush

Because every session event is turn-enclosed, a user selection remains pending until the next accepted in-turn pre-step appends it before request derivation, in whichever turn that occurs. `set(agent, active, strategy?)` records the pending selection (a no-op when the target equals the logged-or-already-pending state), and `get(agent)` returns `{ active, strategy, pending? }`: the logged state used to assemble the current step plus the selected state waiting to be appended.

The only append point while an agent is running is a prepended `agent/pre-step` listener. It observes every proposed request step, including turn 1 step 1 and request-recovery retries, calls downstream listeners first, and appends only after they accept the step. Prompt admission happens before a turn and cannot append `jailbreak/mode`, so a selection made at the prompt is appended by the first accepted in-turn pre-step of the turn it starts. An append failure cannot block the turn, and the selection remains pending for a later accepted in-turn pre-step. A selection made after a turn's final accepted pre-step remains process-local and is lost if the process exits before another accepted in-turn pre-step ([README limitation](../../packages/jailbreak/jailbreak-mode/README.md#known-limitations-and-deferred-work)).

## Strategy injection

While active, the `jailbreak:policy` [system-prompt section](system-prompt.md) renders the strategy's `system` block at order 130, and each claimed user message is wrapped as `prefix + text + suffix` before request assembly. Tool-result messages are never wrapped. The built-in strategy table ships eleven public, widely documented techniques (`dan`, `developer-mode`, `stan`, `prefix-injection`, `persona`, `research-framing`, `authorized-ctf`, `evaluator`, `continuation`, `gpt56-sol-unrestricted`, `tvd-guard`); a deployment that needs its own templates can extend the exported table. The `tvd-guard` strategy runs a [TVD self-loop harness](../../packages/jailbreak/jailbreak-mode/README.md): entering it scaffolds a Task/Validator/Data skeleton into the session workspace, and failures return as programming errors instead of refusals. The [package README](../../packages/jailbreak/jailbreak-mode/README.md) owns the strategy detail and model-experience/limitation detail.

## The `/jailbreak` command

When [`ctx.commands`](commands.md) is composed, the plugin registers `/jailbreak [off|strategy]`: bare `/jailbreak` selects the default strategy, a known strategy id selects that strategy, and the exact argument `off` selects inactive. Unknown strategy ids fail loud rather than silently degrading.

## The service

`ctx.jailbreakMode` owns the logged jailbreak state, applies and narrates selected state at step start, and owns the `jailbreak:policy` section and the `/jailbreak` command; `get`/`set` signatures are in the generated [service catalog](#ctxjailbreakmode--jailbreakmodecontroller).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjailbreakmode--jailbreakmodecontroller"></a>

### `ctx.jailbreakMode` — `JailbreakModeController`

`ctx.jailbreakMode`: owns logged jailbreak state, applies and narrates selected state at step start, wraps claimed user messages while active, the `jailbreak:policy` section, and the `/jailbreak` command. UIs observe committed flips through `session/event`; there is no live mirror.

```ts cordis-catalog
/**
 * Read the logged jailbreak state and any selection awaiting the next
 * accepted in-turn pre-step.
 *
 * @param agent The agent to read.
 * @returns Current logged state plus a pending selection, when present.
 */
get(agent: Agent): JailbreakState & { pending?: JailbreakState }

/**
 * Select whether jailbreak mode should be active, optionally switching the
 * strategy in the same flip. Between turns the method appends the change
 * immediately because no in-turn pre-step will run until another prompt
 * starts a turn. The open-turn fold is the idle signal: agent status stays
 * `running` through post-turn checkpointing, when no further in-turn
 * pre-step runs. During an open turn the selection remains pending until the
 * next accepted in-turn pre-step. Repeated selection of the current or
 * already-pending state is a no-op.
 *
 * @param agent The agent to switch.
 * @param active Whether jailbreak mode should be active.
 * @param strategy The strategy id to select (defaults to the current one).
 * @returns what happened: `committed` (logged now), `queued` (awaiting the
 * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
 * was cleared; the logged state already matches), or `noop` (already in that
 * state).
 */
set(agent: Agent, active: boolean, strategy: string = foldJailbreakMode(agent.session.snapshotEvents()).strategy): 'committed' | 'queued' | 'cancelled' | 'noop'
```

Types: [Agent](core.md)

Source: [`packages/jailbreak/jailbreak-mode/src/index.ts`](../../packages/jailbreak/jailbreak-mode/src/index.ts)
<!-- END GENERATED cordis-surface -->
