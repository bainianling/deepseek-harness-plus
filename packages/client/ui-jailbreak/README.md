---
description: "Web client control for the logged per-agent jailbreak-mode evaluation command."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jailbreak

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-jailbreak` adds the Web composer chip for the logged per-agent `/jailbreak` evaluation mode. It reads the host-owned `jailbreak` projection, renders an active-state control in `conversation.input.jailbreak`, and sends `/jailbreak off` through the command channel. It owns no client-side jailbreak state and does not change sandbox or approval policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the package in the Web client composition with `dsh-jailbreak-mode`, `dsh-api-remotes`, `dsh-client-locale`, and the conversation slot packages. The chip is empty while the projected effective target is inactive; it appears when jailbreak mode is active and lets the user leave that mode without typing the command.

### Ownership

The host package owns `/jailbreak`, strategy selection, prompt wrappers, TVD scaffolding, and durable state. This package owns only the browser presentation and the call to `remote.commands.execute(sessionId, '/jailbreak off', [])`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The client plugin registers the `jailbreak` locale namespace, injects the named `conversation.input.jailbreak` slot, and derives its active state with the generic `useProjection` path. The injected seat handler dispatches the exit command and returns a user-visible error string when the command is rejected. No local store or durable event is created here.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Client plugin, slot registration, locale setup, and command dispatch |
| [`src/client/JailbreakChip.tsx`](src/client/JailbreakChip.tsx) | Active-state chip presentation |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese control copy |
| [`../../jailbreak/jailbreak-mode/README.md`](../../jailbreak/jailbreak-mode/README.md) | Host-owned mode, strategy, and prompt behavior |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Jailbreak mode](../../jailbreak/jailbreak-mode/README.md) — the host capability this control drives.
- [Conversation UI](../ui-conversation/README.md) — the slot owner beside which the chip is rendered.
- [Client session](../ui-session/README.md) — the Session projection delivery used by the control.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `/jailbreak off` command line the chip dispatches: `dsh-jailbreak-mode` owns the model-visible policy section, message wrappers, TVD scaffolding, and logged state, while this package only renders the projection and sends a command a user could type.

#### KV Cache effect

Entering or leaving jailbreak mode changes the active `jailbreak:policy` system-prompt section and therefore the request prefix; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The chip only exits the mode** — entering the mode and selecting a strategy remain owned by `/jailbreak`.
- **The host projection is authoritative** — a missing projection keeps the seat empty rather than creating client state.
- **Failure copy remains English** — command error presentation follows the existing error-surface policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the slot name, projection key, command text, and locale namespace synchronized with the host jailbreak package and the conversation slot declaration.

</details>

**Runtime invariant:** No companion is published. The chip derives from host projection state and every registration is disposed with the client plugin fiber.
