# jailbreak/ — red-team jailbreak mode

English | [中文](README.zh.md)

Jailbreak mode is logged, per-agent collaboration state for red-team safety evaluation: it rewrites model input (a system block plus per-message wrapping) while active, rather than a generic mode registry or capability seam.

| Package | Role | ctx key |
|---|---|---|
| [`jailbreak-mode/`](jailbreak-mode/README.md) | Owns jailbreak-mode state, strategy injection, commands, and the projection | `ctx.jailbreakMode` |

The subsystem reference is [docs/subsystems/jailbreak.md](../../docs/subsystems/jailbreak.md).
