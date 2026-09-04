# Agent Note: Document the private secondary development

Status: implemented

English | [中文](2026-09-04-custom-harness-distribution-documentation.zh.md)

## Problem

The repository entry documents identified the codebase as `alpha.5` and described only the model-environment work, so a reader could not identify the current private secondary-development version or its added capabilities.

## Decision

The root README identifies this repository as a private secondary development based on the official DeepSeek Harness, records the current code line as `0.1.2-rc.1`, records the Windows desktop directory target separately as `3.0.0`, and maintains a source-linked list of the added Web shell, local presentation features, LAN sharing, external-service workbenches, product bundles, jailbreak evaluation, and model-environment replay work. The release report records the same version facts.

The list distinguishes capabilities implemented in the repository from panels that require a separately running local service or configured external data source. The official Harness architecture, permissions, sandbox policy, and approval behavior remain the foundation of this private development.

## Alternatives considered

- **Keep the root README short and rely on the source tree** — rejected because a repository tree does not tell users which behavior was added here, which service owns it, or whether a panel needs an external dependency.
- **Keep `alpha.5` as the current product label** — rejected because the current code line and root package metadata are `0.1.2-rc.1`, while `alpha.5` is an older local label.
- **Copy the complete implementation inventory into the README** — rejected because source-linked capability groups are useful for orientation while package READMEs and code remain the owners of detailed contracts.

## Consequences

Users can identify the private secondary development's added capabilities and current version from the repository entry page. The list needs updates when a product surface or external integration changes; package contracts and source behavior remain authoritative for implementation detail. The standing `AGENTS.md` budget is 2,150 words because its user-scoped harness restriction and knowledge prerequisite are required context for every maintenance task.

## Testing

The changed bilingual pairs are re-recorded with `verify-translation-pairing --write`; documentation gates and the whitespace check were run. Repository-wide lint remains blocked by existing violations in the customized source tree.
