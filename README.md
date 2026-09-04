# DeepSeek Harness Private Development

English | [中文](README.zh.md)

This repository is a private secondary development of the official DeepSeek Harness. It keeps the official `dsh` command and plugin architecture while adding the local Web interface, workbenches, integrations, and model-environment work maintained here.

It is built on an **everything-is-a-plugin** architecture.

## Current version

The current codebase is based on the official Harness `0.1.2-rc.1` code line checked on 2026-09-04. The repository and core package version is `0.1.2-rc.1`; the Windows desktop directory target documented in the [update report](docs/releases/2026-09-03-v3-update-report.md) is `3.0.0`. Custom Web modules retain their own package prerelease versions where applicable.

## Added by this private development

The following capabilities are added in this private secondary development. The source links identify the owning implementation; the [update report](docs/releases/2026-09-03-v3-update-report.md) records the current model-environment and desktop verification scope.

| Area | Added capability | Owning source |
| --- | --- | --- |
| Web shell | An app-level navigation rail keeps the Harness work area available beside dedicated Terminal, Voice, News, LoRA, Collaboration, Model Bench, Knowledge, and Skill Market sections; switching sections keeps an active chat mounted. | [`ui-layout/AppFrame`](packages/client/ui-layout/src/client/AppFrame.tsx) |
| Appearance and sidebar | Users can import an image or video wallpaper that persists in browser IndexedDB, use the local-build brand and build badge, resize or collapse the sidebar, and keep a shell-level refresh action available. | [`wallpaper`](packages/client/ui-primitives/src/wallpaper.ts), [`SidebarRoot`](packages/client/ui-sidebar/src/client/SidebarRoot.tsx) |
| LAN sharing | The Web app exposes an explicit `/lan-share` control for private IPv4 addresses, generates a copyable link, and accepts a validated `dsh-viewport` target so a phone opens a one-column Harness view. Access is guarded and is not enabled implicitly. | [`web-app`](packages/bundle/web-app/src/index.ts), [`LanShareControl`](packages/client/ui-conversation/src/client/skeleton/LanShareControl.tsx) |
| Terminal workbench | A dedicated UI manages persistent PTY sessions for the selected Harness session: open, send commands, read bounded output, interrupt, close, and refresh. | [`TerminalApp`](packages/client/ui-layout/src/client/TerminalApp.tsx), [`session-controller terminal API`](packages/api/session-controller/src/terminal.ts) |
| Browser panel | A client plugin provides a right-side browser screenshot history and live browser state view, with a reusable Provider and event-based integration point. | [`ui-browser-panel`](packages/client/ui-browser-panel/src/client/BrowserPanel.tsx) |
| Knowledge center | A read-only Hindsight projection displays page trees, facts, documents, observations, operation health, search, and source availability in the Web GUI. | [`KnowledgeHubApp`](packages/client/ui-layout/src/client/KnowledgeHubApp.tsx), [`knowledge routes`](packages/bundle/web-app/src/knowledge.ts) |
| Skill market | A read-only catalog brings together Agent Skills, MCP servers, and DSH plugins, with source links, install commands, risk evidence, filters, sorting, refresh, and optional model-assisted Chinese summaries. | [`SkillMarketApp`](packages/client/ui-layout/src/client/SkillMarketApp.tsx), [`market routes`](packages/bundle/web-app/src/market.ts) |
| AI news | A server bundle aggregates Bilibili, Douyin, Xiaohongshu, X syndication timelines, and AI RSS feeds, caches cover images locally, and serves the Web News panel through `/api/ai-news`. | [`dsh-ai-news`](packages/web/ai-news/src/index.ts) |
| Multi-AI collaboration | A collaboration studio assigns CEO, CTO, product, programmer, tester, and documentation roles; consensus meetings precede staged deliverables, and the UI exposes project events and generated files through `/api/collab`. | [`dsh-collab-studio`](packages/web/collab-studio/src/index.ts) |
| Model bench | A benchmark studio generates questions across coding, documents, image recognition, and papers, sends one question to any selected model set through identical Harness tool environments, and records timing plus a judge-model verdict. | [`dsh-model-bench`](packages/web/model-bench/src/index.ts) |
| LoRA and voice integrations | Dedicated Web workbenches expose local LoRA training and voice cloning/assistant workflows, including model or dataset management, training monitoring, audio upload or recording, and synthesis. These panels require their separately running local services. | [`LoraTrainApp`](packages/client/ui-layout/src/client/LoraTrainApp.tsx), [`VoiceCloneApp`](packages/client/ui-layout/src/client/VoiceCloneApp.tsx) |
| Jailbreak evaluation | A logged per-agent `/jailbreak` mode applies a selected strategy to model requests and user messages for red-team safety evaluation; the client chip exposes active state and exit, while sandbox and approval policy remain independent. | [`jailbreak-mode`](packages/jailbreak/jailbreak-mode/README.md), [`ui-jailbreak`](packages/client/ui-jailbreak/README.md) |
| Model environments and replay | Provider-owned capability metadata, explicit environment diagnostics, DeepSeek and Responses route descriptions, and ordered response lifecycle events make model routing and client replay inspectable without enabling provider-managed continuation by implication. | [`model environment requirements`](specs/model-environment-upgrade/requirements.md), [`response replay`](packages/llm/llm/src/response-replay.ts) |

## Scope and limits

The `dsh` launcher, Cordis plugin architecture, session log, tool permissions, sandbox policy, and approval flow come from the official Harness foundation. This private development adds product surfaces and provider-neutral extension points around them; it does not replace the agent loop with a separate application architecture.

The LAN control is opt-in and limited to addresses reported by the local server. The Knowledge Center, News, and Skill Market depend on their configured sources. LoRA and voice panels require separate local services. Jailbreak mode is an evaluation harness and does not relax sandbox or approval enforcement. Native provider-managed Responses continuation, durable background Responses jobs, and native Responses compaction remain explicitly unavailable in this release.

## Developer preview

This private secondary development is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/bainianling/deepseek-harness-plus.git
cd deepseek-harness-plus
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
