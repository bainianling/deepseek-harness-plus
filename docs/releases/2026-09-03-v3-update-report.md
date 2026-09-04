# DeepSeek Harness v3 Update Report

English | [中文](2026-09-03-v3-update-report.zh.md)

Date: 2026-09-04

Repository baseline: `0.1.2-rc.1`; Windows desktop directory target: `3.0.0`.

This private secondary development, based on the official DeepSeek Harness, adds model-environment selection and the first durable response-replay foundation for ChatGPT-compatible and DeepSeek routes.

The root [README](../../README.md) records the private development's added Web capabilities and current version.

## Delivered

- Task 4 is checked in `specs/model-environment-upgrade/tasks.md`.
- Added a capability catalog for provider, protocol, context-window, cache, tool, replay, background-job, parallel-tool, and native-compaction properties.
- Added explicit session model-environment resolution, route and preset validation, compatibility diagnostics, and stable failure codes.
- Added provider-neutral response lifecycle events for response open, response item, and response close.
- Added pi-ai lifecycle emission for text, reasoning, and function-call items. Reasoning signatures and credentials are excluded from the persisted vocabulary.
- Added ordered response lifecycle persistence in the agent loop, including cancellation, failure, and incomplete terminal states.
- Kept the lifecycle route-bound and marked as `client-replay`; this prevents unsupported provider-managed continuation from being implied by a local replay log.
- Improved model-bench timeout and pass-threshold handling and extended its session inspection API where required by the current checkout.
- Hardened the desktop launcher so the installed app resolves its harness root and data directory through environment/configuration values instead of embedded machine-specific paths.
- Removed tracked runtime, build, test, and desktop diagnostic logs from the release content. Local `.env` files and desktop-local configuration remain outside the published repository.
- Repackaged the Windows desktop application as version `3.0.0` in the `win-unpacked` directory target and updated the desktop shortcut to that executable. The NSIS installer target was not produced because its signing/build helper download was unavailable in the current network environment.
- Fixed the packaged desktop cold-start regression by including the local desktop configuration as a packaged fallback while preserving the per-user configuration override. A rebuilt executable started the Web UI on port `3080`, and its authenticated local page returned HTTP `200`.

## Deliberately not enabled

Provider-managed `previous_response_id`, durable background Responses jobs, native Responses compaction, and corresponding SDK/snapshot projections are not enabled by this release. The resolver reports these capabilities as unavailable until their request, persistence, recovery, and cross-SDK behavior can be implemented and tested together.

## Verification

- TypeScript build checks passed for `dsh-llm`, `dsh-llm-pi-ai`, `dsh-agent-loop`, and `dsh-session`.
- Focused response-replay, pi-ai conversion, session, and agent-loop tests passed: 138 tests in 4 files.
- Markdown wrapping verification passed for 2265 files.
- Translation pairing verification passed for the updated pi-ai README.
- Translation pairing verification passed for this v3 report.
- Persistence catalog verification passed before the final privacy cleanup.
- The full repository build passed with `pnpm run build`.
- Desktop directory packaging passed with `npm.cmd run dist` using the locally installed Electron 33.4.11 runtime.
- Packaged desktop cold-start verification passed with the configured harness root; the optional Hindsight daemon can still remain unavailable when its local Python wheel cache is invalid, without preventing Web UI startup.

## Privacy statement

The published revision contains no API keys, bearer tokens, launch URLs with tokens, local runtime logs, or machine-specific desktop configuration. Secret-like names in documentation refer only to environment-variable interfaces and do not contain secret values.
