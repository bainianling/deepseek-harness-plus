---
description: "Web client browser panel: screenshot history, active-page status, and authenticated navigation over a confined host RPC."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-browser-panel

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-browser-panel` adds a Web GUI panel for the optional `browser` service. It shows the active page, captures screenshots, opens HTTP(S) URLs, serves recent browser snapshots, and keeps the host bridge on the loopback RPC channel `/dsh-browser-panel`. The panel remains available when `dsh-browser` is absent, reporting that browser automation is unavailable instead of making the Web profile depend on it.

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

Load the package through a Web profile bundle. The bundle patch inserts the host plugin with `connection` injection; the client plugin mounts the toggle and panel into the Web document. The optional `browser` service is resolved lazily, so installing `@anweat/dsh-browser` enables navigation and capture without changing this package's composition.

### Host operations

The host half exposes `status`, `capture`, `open`, `image`, and `history` on `/dsh-browser-panel`. `open` accepts only HTTP(S) URLs and performs the DSH signed-session bootstrap before visiting a local harness URL. `image` serves only supported image files inside the browser snapshot directory or paths previously vouched for by the browser service.

### Client exports

The client entry exports `BrowserPanel`, `BrowserToggleButton`, `BrowserPanelProvider`, `useBrowserPanel`, `OPEN_URL_EVENT`, `SHOW_PANEL_EVENT`, and the `BrowserScreenshot` contract. The built-in composition uses the provider and components directly; other Web plugins can use the context or events to open the same panel.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host plugin waits for `connection`, registers one loopback-authorized RPC handler, and temporarily wraps the shared browser's `open` method so GUI navigation receives the same authenticated DSH session as direct browser calls. The client builds a small bridge over `connection.rpc`, mounts one React root in `dsh-browser-panel-root`, and removes the root with the plugin fiber.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host RPC, DSH navigation authentication, image confinement, and screenshot history |
| [`src/client/index.tsx`](src/client/index.tsx) | Client plugin mount, RPC bridge, and public client exports |
| [`src/client/BrowserPanel.tsx`](src/client/BrowserPanel.tsx) | Panel presentation and screenshot controls |
| [`cordis.patch.yml`](cordis.patch.yml) | Web bundle registration for the host/client plugin |
| [`INTEGRATION.md`](INTEGRATION.md) | Local integration notes for this private package |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web app bundle](../../bundle/web-app/README.md) — the Web profile that mounts this package.
- [Browser integration](INTEGRATION.md) — local integration notes for the optional browser provider.
- [Client connection](../connection/README.md) — the authenticated RPC transport used by the panel.
- [Client UI layout](../ui-layout/README.md) — the layout that hosts the panel's Web surface.

-----

<a id="model-experience"></a>
## Model Experience

### Browser panel host bridge

#### What the model sees

None; this package presents browser screenshots and status through `/dsh-browser-panel` in the Web GUI and registers no prompt, tool schema, or model request.

#### Token effect

None; panel events stay in the browser UI and host RPC.

#### KV Cache effect

None; the panel does not change assembled model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The browser provider remains optional** — without `dsh-browser`, status is unavailable and capture/open operations cannot run.
- **Only local snapshot paths are served** — arbitrary filesystem paths are rejected, and images over 8 MiB are not returned.
- **Browser state is provider-owned** — this package does not persist page sessions, cookies, or navigation history beyond the snapshot files it lists.
- **The panel is a Web overlay** — it does not replace the model-facing browser tools or provide a separate automation engine.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package is a host/client bundle. Keep `/dsh-browser-panel`, the client bridge, and the bundle patch synchronized when changing endpoints or injection requirements.

</details>

**Runtime invariant:** No companion is published. RPC registration and the temporary browser wrapper are disposed with their owning Cordis effects; path checks are enforced at the image-serving operation.
