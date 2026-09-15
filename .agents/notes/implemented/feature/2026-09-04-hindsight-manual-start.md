# Agent Note: Hindsight starts explicitly from Knowledge

Status: implemented

English | [中文](2026-09-04-hindsight-manual-start.zh.md)

## Problem

The Web launcher previously started the local Hindsight daemon as a side effect of opening the GUI. That made a read-only Knowledge view depend on an opaque background process, launched work even when the user did not need project memory, and left failures in a separate script or console instead of the place where the service is used. The GUI also needed to remain usable when Hindsight was offline or could not start.

## Decision

Web startup does not launch Hindsight. The Knowledge section owns an explicit **Start Hindsight** action and displays `offline`, `starting`, `online`, or `error` state. The browser calls only DSH-owned `/api/knowledge/status` and `/api/knowledge/start` routes; it cannot provide an executable, profile, argv, or filesystem path.

The Host registers the Knowledge routes after Connection injection and applies `requestRejection` before any lifecycle or Hindsight work. The start route is POST-only, loopback/same-origin fenced, and accepts only an empty body. Its trusted configuration supplies `hindsightProfile: dsh-local`, `hindsightCommand: hindsight-embed`, and a bounded `hindsightStartTimeoutMs` default of 240000 ms. The lifecycle first adopts a healthy `hindsightUrl`, then starts the executable without a shell using `-p <profile> daemon start`, UTF-8 Python settings, a scrubbed parent environment plus an explicit Hindsight/provider allowlist, detached stdio, and Windows-hidden process creation.

Startup operations are shared at process scope for the same daemon identity and timeout contract, so concurrent GUI requests cannot spawn duplicates. Health polling uses one deadline; executable, spawn, process, and timeout failures become structured status states. Diagnostics read only a bounded profile-log tail and redact authorization, URL, JSON, and assignment-shaped credentials. A detached daemon survives Web plugin disposal; disposing one controller only prevents later state updates from reaching that controller.

The client polls while starting, locks duplicate clicks, keeps the rest of the Web shell available offline, and exposes a retry action for failures. Locale keys exist in English and Simplified Chinese, and the status panel uses semantic design tokens with responsive and focus-visible behavior. The existing read projection remains Host-owned and is described by the [Web knowledge center note](2026-08-30-web-knowledge-center.md).

## Alternatives considered

**Keep automatic startup in `start-dsh-web.bat` or a discovered script** — rejected because opening the Web GUI should not create a background service the user did not request, and script failures are detached from the Knowledge surface. The repository launcher now only starts Web; the Knowledge action is the single explicit start path.

**Let the browser execute Hindsight or choose its command** — rejected because it would bypass Connection authentication, expose local process controls to the client, and make executable/profile/path injection part of the API contract.

**Terminate Hindsight when the Web fiber is disposed** — rejected because Hindsight is a shared local daemon and another Web session may be using it. The lifecycle owns state observation, not daemon ownership after a detached start succeeds.

**Treat an unavailable source as an empty Knowledge base** — rejected because it hides service failure and can be mistaken for missing project memory. The UI keeps the shell usable while showing the daemon state and bounded diagnostic.

## Consequences

Launching `dsh --profile web` is now side-effect-light: Hindsight remains offline until the user requests it. The first Knowledge visit performs a health probe and can adopt a daemon started elsewhere. A start may take up to the configured deadline, and the UI explains the wait instead of silently blocking the Web launch. The Host owns all process and security decisions, while the client owns only presentation and an explicit user gesture.

The route and lifecycle contracts add focused coverage for Connection rejection, local-control fencing, body framing, adoption, concurrent starts, timeout termination, process errors, redaction, disposal races, and offline-to-online UI polling. `hindsight-embed` must be installed and discoverable or configured by a trusted absolute path; the UI cannot repair a missing installation automatically.

Related projection decision: [Web knowledge center uses a host-owned read projection](2026-08-30-web-knowledge-center.md).
