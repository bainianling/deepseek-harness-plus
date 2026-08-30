# @deepseek-ai/dsh-client-ui-jailbreak

English | [中文](README.zh.md)

Jailbreak-mode composer control: occupies the named `conversation.input.jailbreak` seat beside the plan seat with an active-state status chip. Jailbreak mode is entered through the `/jailbreak` command (owned by [`@deepseek-ai/dsh-jailbreak-mode`](../../jailbreak/jailbreak-mode/README.md)); while the host-computed `jailbreak` projection's effective target is jailbreak mode, the chip renders and executes `/jailbreak off` through the command channel, otherwise the seat stays empty. Reads ride the generic projection pair through the standard-kit `useProjection`; zero client-side jailbreak state.

This is the red-team safety evaluation surface: the chip is how a Web user sees and leaves jailbreak mode without typing the command.

## Model Experience

Indirectly, through the `/jailbreak off` command line the chip dispatches: `@deepseek-ai/dsh-jailbreak-mode` owns the model-visible policy section, the per-message wrappers, the TVD scaffolding, and the logged state that line drives, while this package only renders the projection and sends what a user could equally type.

#### KV Cache effect

Entering or leaving jailbreak mode changes the active `jailbreak:policy` system-prompt section and therefore the request prefix; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

- The chip only exits jailbreak mode; entering and strategy selection stay on the `/jailbreak` slash command.
- Failure copy stays English (error-surface policy).
