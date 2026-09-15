---
description: "Web bundle for a multi-agent software company workflow with consensus meetings, staged delivery, and persisted project files."
kind: "package-bundle"
---

# @deepseek-ai/dsh-collab-studio

English | [中文](README.zh.md)

## Summary

`dsh-collab-studio` adds a collaboration section where six role agents — CEO, CTO, product, programmer, tester, and documentation — take one requirement through meetings, production, and review. It persists project records, append-only events, and generated files under `$DSH_HOME/collab-studio`, and exposes them through `/api/collab` for the Web GUI.

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

Load `cordis.patch.yml` in the Web profile. The patch inserts the `collab-studio` host row over `webServer`; the GUI creates a project from a requirement, selects project type and stage models, starts or stops the pipeline, follows events, and reads generated files.

### Project pipeline

Each stage can hold a consensus meeting before its producer writes a deliverable. A review-and-fix loop can run after production. The default company template covers requirement analysis, architecture, product planning, implementation, testing, and documentation; project types tune the stage prompts.

### HTTP surface and defaults

The service provides project list/create/detail/start/stop/delete, event paging, file listing, and bounded file reads under `/api/collab/projects`. The patch enables the bundle, keeps at most 32 projects, retains a 2,000-event tail per project, and allows up to 4 meeting rounds unless configuration overrides those limits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host plugin owns the project store and run registry. Each role is backed by a full harness Agent in the project working directory; the driver selects the role route, records meeting and stage events, and disposes agents when the pipeline ends. Control requests are loopback-only, and generated file reads stay project-relative and size-bounded.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis plugin, service, routes, and run lifecycle |
| [`src/engine.ts`](src/engine.ts) | Stage execution and deliverable flow |
| [`src/consensus.ts`](src/consensus.ts) | Atomic-Chat meeting and decision logic |
| [`src/driver.ts`](src/driver.ts) | Full harness Agent role driver |
| [`src/store.ts`](src/store.ts) | Project, event, and file persistence |
| [`src/prompts.ts`](src/prompts.ts) | Role and stage template prompts |
| [`cordis.patch.yml`](cordis.patch.yml) | Web bundle composition and limits |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web app bundle](../../bundle/web-app/README.md) — shared Web host and GUI composition.
- [Agent loop](../../core/agent-loop/README.md) — execution model used by each role agent.
- [Session persistence](../../../docs/subsystems/persistence.md) — durable log mechanics for role sessions.
- [Collaboration panel](../../client/ui-layout/README.md) — the Web client section that consumes the service.

-----

<a id="model-experience"></a>
## Model Experience

### Role-agent prompts

#### What the model sees

Each role agent receives the project requirement, its role persona, the current stage topic, meeting transcript when present, and the deliverable or review instructions; role sessions use the same harness prompt/tool composition with their selected model route.

#### Token effect

Tokens scale with the number of role turns, meeting rounds, review rounds, and generated file content; `maxMeetingRounds` bounds only meeting discussion.

#### KV Cache effect

Each role agent owns its provider request sequence; this bundle does not share a KV cache across roles or force a common provider cache policy.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **This is an orchestration template** — role personas and stage prompts are defaults, not a guarantee of production quality or consensus correctness.
- **Every role uses model capacity** — a pipeline can create multiple concurrent or sequential sessions and may consume substantial quota.
- **Generated files are local artifacts** — the bundle does not publish, deploy, review, or version-control a project automatically.
- **Project state is bounded by configuration** — event tails and project counts are capped, and stopped or failed runs require user review before retry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the stage template, event names, project store, and GUI event reader aligned when adding a new role or lifecycle phase. Role agents must continue to use the regular Agent registry and disposal path.

</details>

**Runtime invariant:** A project run owns every role-agent handle it creates; shutdown aborts active runs and waits for their disposals before the plugin releases its routes.
