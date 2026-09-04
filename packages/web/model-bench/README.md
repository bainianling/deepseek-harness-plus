---
description: "Web bundle for concurrent multi-model testing with generated questions, shared tools, timing, and judge verdicts."
kind: "package-bundle"
---

# @deepseek-ai/dsh-model-bench

English | [中文](README.zh.md)

## Summary

`dsh-model-bench` adds a model testing section to the Web GUI. It generates one coding, document, vision, or paper question, sends the same question to a selected set of models through full harness agents with one identical tool environment, records per-model results and timing, and asks a judge model for pass/fail verdicts. Round records and artifacts live under `$DSH_HOME/model-bench` and are served through `/api/bench`.

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

Load `cordis.patch.yml` in the Web profile. The patch inserts the `model-bench` host row over `webServer`; the GUI creates a round, generates a question, chooses contestants and an optional judge, starts or stops the contest, follows events, and reads bounded result files.

### Round flow

One round has a generated question, one contestant Agent per selected model, and an optional judge pass. Contestants receive the same question and deployment-default preset; only their model route differs. Vision rounds use the bundled seed images and can also write model-produced materials into the round directory.

### HTTP surface and defaults

The service provides metadata/model catalogs, round list/create/detail/delete, generation/start/stop, event paging, file listing, and bounded file reads under `/api/bench`. The patch enables the bundle, keeps at most 64 rounds, allows 12 contestants, and uses 20 minutes for contestant timeout, 10 minutes for question generation, and 15 minutes for judging unless configuration overrides them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin persists round state and events, settles interrupted rounds on startup, creates one full harness Agent per contestant, and disposes every driver after completion or cancellation. Question generation, contestant execution, and judging share bounded phase timeouts. Control routes require a loopback request, while result file reads are project-relative and size-bounded.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis plugin, service, routes, and run lifecycle |
| [`src/engine.ts`](src/engine.ts) | Question, contestant, and judge phases |
| [`src/driver.ts`](src/driver.ts) | Full harness Agent driver per model route |
| [`src/store.ts`](src/store.ts) | Round, event, and artifact persistence |
| [`src/prompts.ts`](src/prompts.ts) | Category and judge prompt templates |
| [`src/assets.ts`](src/assets.ts) | Seed image preparation for vision rounds |
| [`cordis.patch.yml`](cordis.patch.yml) | Web bundle composition and limits |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web app bundle](../../bundle/web-app/README.md) — shared Web host and GUI composition.
- [LLM capability](../../../docs/subsystems/llm-streaming.md) — provider routes and streaming behavior.
- [Agent loop](../../core/agent-loop/README.md) — execution model used by contestants and judge.
- [Model bench panel](../../client/ui-layout/README.md) — the Web client section that consumes the service.

-----

<a id="model-experience"></a>
## Model Experience

### Contestant and judge requests

#### What the model sees

Each contestant model receives the same generated question, category materials, and deployment-default tool environment; the judge model receives the question and contestant outputs for comparison, while the ordinary harness conversation receives no automatic benchmark context.

#### Token effect

Tokens scale with question generation, one full agent run per contestant, and the optional judge run; `maxContestantsPerRound` and phase timeouts bound resource use but do not cap provider output tokens.

#### KV Cache effect

Contestants and judge use separate provider request sequences; this bundle does not promise shared KV cache state or cross-model cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Results are deployment-dependent** — model versions, provider latency, credentials, tools, and network conditions affect outcomes.
- **A round is not a standardized benchmark** — generated questions and judge prompts are harness templates, not an externally calibrated evaluation set.
- **Vision materials are local fixtures** — seed images are prepared in the round asset directory and do not represent a complete vision test suite.
- **Long runs consume quota** — generation, contestants, and judge each have their own model calls and can outlive a browser tab until stopped or settled.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the same question and preset assignment for every contestant in a round. Changes to event persistence, phase transitions, or file names must be reflected in the panel's event and file readers.

</details>

**Runtime invariant:** The run registry owns every contestant and judge Agent handle it creates; disposal aborts active rounds and waits for their cleanup before routes are released.
