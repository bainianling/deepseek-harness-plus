---
description: "The browser GUI for dsh: interactive chat, model and settings management, and session history, for users running the dsh web surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

English | [中文](README.zh.md)

## Summary

Run `dsh --profile web` and the interface opens in your default browser, ready for interactive chat with the agent. You get the conversation view, model and settings management, and session history, backed by the same model access, tools, and safety defaults as every other surface. The command prints a tokenized startup URL; the browser exchanges that token for a signed session cookie and redirects to the clean root URL. You can change the port, suppress the browser handoff, and allow extra hosts from the command line; binding all network interfaces is intentionally not supported. Choose it for interactive work in the browser; `dsh-headless` is the one-shot command-line sibling.

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

Start the GUI, open your browser, and start talking to the agent. The flags fine-tune the invocation.

### Starting the Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

After startup you see a `dsh web:` line whose root URL carries a fresh process token. Unless `--no-open` or an SSH session suppresses it, the default browser opens that URL, receives a signed cookie, and redirects to the clean root page. You know it worked when the page loads and you can chat with the agent. Two failures to expect: if the frontend is not built, startup stops with a build hint (`pnpm run build` in a checkout); if the browser cannot be opened, a credential-free diagnostic prints to stderr while the server keeps running — open the printed startup URL yourself.

### Configuration

Most users never set these; command-line flags feed the invocation-owned settings, while the Hindsight fields select the local daemon and read-only source shown by the Knowledge section:

| Field | Default | Meaning |
|---|---|---|
| `openBrowser` | `true` | Open the default browser after startup; SSH launches suppress it |
| `printUrl` | `true` | Print the `dsh web:` URL line at startup |
| `surfaceContext` | `true` | Give the agent GUI-orientation context and expose `DSH_WEB_URL` to its shell commands |
| `trustedHosts` | `[]` | Extra hosts allowed to reach the GUI from the network |
| `hindsightUrl` | `http://127.0.0.1:9077` | Local Hindsight API used by the Knowledge section and its health probe |
| `hindsightBankId` | `coding-agent::deepseek-harness` | Hindsight bank projected into this GUI |
| `knowledgeTimeoutMs` | `5000` | Timeout for each Hindsight read or health probe, from 100 to 30000 ms |
| `hindsightProfile` | `dsh-local` | Trusted local profile passed to the fixed daemon command |
| `hindsightCommand` | `hindsight-embed` | Trusted executable name or absolute path used for manual startup |
| `hindsightStartTimeoutMs` | `240000` | Maximum wait for a manually started daemon to pass its health probe, from 10000 to 300000 ms |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) is the exhaustive source for every accepted field and its JSDoc.

### Manual Hindsight startup

Starting `dsh --profile web` does not launch Hindsight. Open the Knowledge section and select **Start Hindsight** when the local service is needed. The Host first adopts an already healthy `hindsightUrl`; otherwise it starts the configured executable with the fixed `-p <hindsightProfile> daemon start` arguments, polls `/health`, and shares concurrent requests so one Web process cannot launch duplicate daemons. The detached daemon is independent of Web plugin disposal and remains available for later sessions.

When startup cannot complete, the Knowledge section keeps the rest of the GUI usable and shows a bounded, redacted diagnostic. `executable-missing`, `spawn-failed`, `process-failed`, and `timeout` identify the failure class. Install `hindsight-embed`, configure an absolute executable path when it is not on `PATH`, or inspect the profile's own logs before retrying. The browser only calls DSH-owned `/api/knowledge` routes; it cannot choose the executable, profile, arguments, or filesystem path.

### LAN access and trusted hosts

By default the GUI accepts connections from this machine only. A deployment that binds all network interfaces also allows browsers from the LAN, and the printed URL then includes a LAN address; `--trusted-host` adds extra hosts in either case. Host and Origin checks control reachability, while the token exchange authenticates every Host API method and WebSocket stream. The LAN addresses are sampled once at startup, so a network change later is not picked up — restart the GUI to re-advertise.

### Running over SSH

When you launch `dsh --profile web` over SSH, the URL line still prints but the browser is not opened for you: the SSH client or editor owns the local forwarding address. Open the forwarded URL on your machine yourself; the printed URL names the remote host's loopback endpoint.

### Per-session agent setup

Each browser session composes its own agent from the shipped presets (the `standard` preset by default), instead of sharing one process-wide tool set. You can change the default preset or add your own presets under `$DSH_HOME/.agent-presets`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch plus one runtime glue plugin. The storage stack and projection cache come from `dsh-base`; the web overlay's workspace and message-feedback rows consume that shared `storageDomain` service. The patch restates the surface-specific values the base deliberately omits, inserts the web-only host rows and browser roster, then moves the agent plane behind presets. The glue plugin owns dist serving, trust sampling, prompt sections, the bash variable, and the readiness announcements.

### Patch semantics

A patch replaces the targeted row's whole `config`, so each web row restates every key it owns: the persona prefix and suffix templates, the `DSH_TOOLS_MODE` PTC mode opt-in, and the `session-query-sqlite` values on the base rows, then `insert` adds the web host rows, transport, and browser roster. The per-agent tool rows the base mounts process-wide are disabled here and the preset roster takes over; the reasoning for each host-plane versus preset-plane decision is inline in the patch.

### Readiness

The URL line and browser handoff are readiness signals: supervisors RPC as soon as they observe the line, and a browser requests the page as soon as it opens, so both run only after the Loader tree settles and Connection authentication is available — or immediately in a hand-built tree without a Loader. A tree disposed mid-boot announces nothing.

### LAN trust sampling

`resolveLanTrust` samples the network once at boot: a loopback bind (`127.0.0.1`) derives no LAN addresses, while an all-interfaces bind adds every non-internal IPv4 literal. The derived literals plus the explicit `--trusted-host` authorities form the `/api` browser-trust fence, and the printed LAN URL always matches that fence.

### Knowledge projection

The Knowledge section never calls Hindsight directly from the browser. [`src/knowledge.ts`](src/knowledge.ts) reads the configured bank, flattens its folder tree, and publishes a stable read-only projection at `/api/knowledge/snapshot` plus page content at `/api/knowledge/pages/:id`. The snapshot includes page and folder metadata, source tags, fact/document/observation counts, and pending or failed background operations; a timeout or unreachable Hindsight service returns a structured `503` so the GUI can show an offline state. Editing remains owned by Hindsight tools and APIs, which keeps browser code independent from its storage format and leaves the source replaceable.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `web-app` glue plugin: dist resolution, LAN trust sampling, prompt sections, bash variable, URL line, browser handoff |
| [`src/knowledge.ts`](src/knowledge.ts) | Read-only Hindsight adapter and stable `/api/knowledge` projection for the Knowledge section |
| [`src/startup.ts`](src/startup.ts) | The `web-startup` provider: `--host`, `--port`, `--trusted-host`, `--no-open`, `--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | The web patch: restated base values, web host rows, browser roster, agent plane behind presets |
| — | No runtime invariant companion is published; every contribution (frontend-static child plugin, prompt section, bashEnv registration) is registry-disposed with the fiber, and each owning registry's package carries that relation's invariant; the package holds no mutable state of its own to audit. |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | Dist resolution, fallback seat, prompt sections, readiness |
| [`tests/knowledge.spec.ts`](tests/knowledge.spec.ts) | Tree flattening, health projection, offline response, and page-ID validation |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN-trust sampling |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | Default-browser handoff after the page is reachable |

### Invariant ownership

No invariant companion is published because every contribution — the frontend-static child plugin, the prompt sections, and the bash variable registration — is registry-disposed with the fiber, and each owning registry package carries that relation's invariant.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core, the browser reload pipeline, or the built frontend.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core the GUI runs on.
- [dsh-client-hmr](../../client/hmr/README.md) — how client-plugin changes reload during development.
- [frontend-static](../../host/frontend-static/README.md) — how the built frontend is served.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (first-party order 10100, after reusable instructions) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

Source and Web sections follow first-party reusable instructions. Different checkout paths or local ports leave that preceding prefix unchanged when tools and configuration match; provider cache reuse is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits tell you what to expect in unusual setups — a source checkout, SSH sessions, or strict networks. They are current package constraints, not a general browser comparison or a task backlog.

- **The frontend must be built** — a source checkout needs `pnpm run build` first; startup stops with a build hint when the dist is missing, and there is no source-serving fallback.
- **LAN addresses are sampled once at startup** — interface changes after boot are not re-advertised; the printed LAN URL always matches what was sampled.
- **Only the handoff start is observable** — the GUI reports that the browser was asked to open, not that it actually opened; a later browser exit is never reported, and the printed URL is your manual fallback.
- **SSH sessions keep the URL but skip the browser handoff** — the printed URL names the remote host's loopback endpoint; the SSH client or editor must expose and open the local forwarded address.
- **`BROWSER` overrides only come from the environment** — a discovered `.env` cannot set `BROWSER`; only an inherited value can choose the executable for the automatic handoff.
- **Binding all network interfaces is not supported** — `--host 0.0.0.0` is rejected at startup for safety; use the default loopback host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
