# Agent Note: Web knowledge center uses a host-owned read projection

Status: implemented

English | [中文](2026-08-30-web-knowledge-center.zh.md)

## Problem

The application navigation already exposed a Knowledge section, but it was a static placeholder. Hindsight held the project's durable facts and generated knowledge pages, yet browser code could not safely depend on one local Hindsight URL, bank selection, internal response shape, or storage implementation. Direct browser access would also bypass the Web host's deployment boundary and make a future knowledge-source replacement a client rewrite.

## Decision

The Web app owns a read-only `/api/knowledge` projection. `web-app` reads the configured `hindsightUrl` and `hindsightBankId` with a bounded `knowledgeTimeoutMs`, flattens the Hindsight knowledge tree, and exposes `/api/knowledge/snapshot` plus validated `/api/knowledge/pages/:id` reads. The snapshot carries source identity and status, folders, page summaries, source tags, fact/document/observation counts, consolidation timestamps, and pending or failed operation counts. An unavailable or timed-out source returns a structured `503` rather than hanging or fabricating an empty knowledge base.

`KnowledgeHubApp` consumes only that DSH-owned contract. It provides health metrics, folder and tag filters, local text search, page selection, safe Markdown rendering, and explicit loading, empty, generating, stale, and offline states. The page is an operational management view rather than an editor: knowledge mutation remains in Hindsight tools and APIs until DSH defines authenticated write semantics. Long-lived project knowledge is organized into Architecture and boundaries, Component map, Engineering conventions, and Operations and maintenance folders; feature initiatives remain in the existing Initiatives folder.

Every non-trivial repository task must list and read relevant Hindsight pages before re-deriving architecture or prior decisions from source. Verified contradictions are written back as correction documents so stale memory does not keep steering later work.

## Alternatives considered

**Let the browser call Hindsight directly** — rejected because it hard-codes a local service address and bank into client behavior, bypasses the Web host boundary, complicates remote access, and couples the UI to Hindsight internals.

**Copy generated pages into repository Markdown** — rejected because it creates two independently mutable stores and loses Hindsight's continuously refreshed pages, facts, observations, and operation health.

**Add editing controls immediately** — rejected because a visible write action needs authentication, conflict, operation-status, and source-ownership semantics. A read-only management surface is complete and honest without inventing those guarantees.

## Consequences

The Knowledge section is useful whenever Hindsight is online and fails visibly when it is not. Deployments can point at another bank through the Web row config, and a later source implementation can preserve the `/api/knowledge` contract without changing the client. The Host performs three bounded upstream reads per snapshot refresh and one read per selected page. Hindsight remains a runtime dependency for live content, while the rest of the Web GUI remains available during knowledge-source failure. Tests pin tree flattening, health projection, offline behavior, page-ID validation, and the functional navigation occupant.
