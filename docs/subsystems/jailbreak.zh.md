# 破甲模式

[English](jailbreak.md) | 中文

破甲模式是按 agent（智能体）分别记录到日志的协作状态，由 [dsh-jailbreak-mode](../../packages/jailbreak/jailbreak-mode)（`ctx.jailbreakMode`、`JailbreakModeController`）拥有：激活时，所选策略的指令块会追加到每个模型请求的系统提示词中，且每条被认领的用户消息会用该策略的前缀/后缀包装。破甲模式是**红队安全评估**工具。[沙箱模式](sandbox.zh.md)和[批准策略](approval.zh.md)各自强制执行限制；两者都不读写破甲状态。该包是可选的，agent 循环不依赖它。它贡献 `jailbreak:policy` 提示词 section，并注册 `/jailbreak` 命令。[包 README](../../packages/jailbreak/jailbreak-mode/README.zh.md) 拥有模型体验与限制细节。

来源：[`packages/jailbreak/jailbreak-mode/src/index.ts`](../../packages/jailbreak/jailbreak-mode/src/index.ts)

## 已记录状态与恢复

`jailbreak/mode`（`{ active: boolean, strategy: string }`）是一个仅存在于日志中、每次以完整值替换的[会话事件](session.zh.md)：持久、可回放，绝不出现在模型记录中。`foldJailbreakMode(events, end?)` 返回前缀中最后记录的 `{ active, strategy }` 对，如果没有则返回 `{ active: false, strategy: <默认> }`——生效状态始终是会话日志的纯折叠结果，因此恢复、fork 和压缩都能在无实时镜像的情况下恢复它，UI 通过 `session/event` 观察已提交的切换。

## 待生效选择与 pre-step 提交

由于每个会话事件都受回合包裹，用户的选择会保持待生效，直到下一个被接受的轮内 pre-step 在请求派生之前追加它，无论发生在哪个回合。`set(agent, active, strategy?)` 记录待生效选择（当目标等于已记录或已待生效状态时为 no-op），`get(agent)` 返回 `{ active, strategy, pending? }`：用于组装当前步骤的已记录状态，加上等待被追加的所选状态。

agent 运行期间唯一的追加点是前置的 `agent/pre-step` 监听器。它观察每一个提议的请求步骤（包括第 1 回合第 1 步和请求恢复重试），先调用下游监听器，且只在它们接受该步骤后追加。提示词准入发生在回合之前，无法追加 `jailbreak/mode`，因此提示词处做出的选择由该回合的第一个被接受的轮内 pre-step 追加。追加失败不会阻塞回合，选择会保留给后续被接受的轮内 pre-step。在回合最后一次被接受的 pre-step 之后做出的选择仍停留在进程本地，若进程在另一个被接受的轮内 pre-step 之前退出则会丢失（[README 限制](../../packages/jailbreak/jailbreak-mode/README.zh.md#known-limitations-and-deferred-work)）。

## 策略注入

激活时，`jailbreak:policy` [系统提示词 section](system-prompt.zh.md) 会在顺序 130 处渲染策略的 `system` 块，且每条被认领的用户消息会在请求组装前包装为 `前缀 + 原文 + 后缀`。工具结果消息永远不会被包装。内置策略表提供十一种公开且被广泛记载的技术（`dan`、`developer-mode`、`stan`、`prefix-injection`、`persona`、`research-framing`、`authorized-ctf`、`evaluator`、`continuation`、`gpt56-sol-unrestricted`、`tvd-guard`）；需要自定义模板的部署方可以扩展导出的表。`tvd-guard` 策略运行 [TVD 自循环工具链](../../packages/jailbreak/jailbreak-mode/README.zh.md)：进入时会在会话工作区脚手架 Task/Validator/Data 骨架，失败以编程错误回流而非拒绝。策略细节与模型体验/限制细节由[包 README](../../packages/jailbreak/jailbreak-mode/README.zh.md) 负责。

## `/jailbreak` 命令

组合 [`ctx.commands`](commands.zh.md) 时，该插件注册 `/jailbreak [off|strategy]`：不带参数的 `/jailbreak` 选择默认策略，已知策略 id 选择该策略，参数恰好为 `off` 时选择停用。未知策略 id 会大声失败，而不是静默降级。

## 服务

`ctx.jailbreakMode` 拥有已记录的破甲状态，在步骤开始时应用并叙述所选状态，并拥有 `jailbreak:policy` section 和 `/jailbreak` 命令；`get`/`set` 签名见生成的[服务目录](#ctxjailbreakmode--jailbreakmodecontroller)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/jailbreak/jailbreak-mode/src/index.ts`](../../packages/jailbreak/jailbreak-mode/src/index.ts)
<!-- END GENERATED cordis-surface -->
