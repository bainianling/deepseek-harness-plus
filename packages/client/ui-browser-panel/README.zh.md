---
description: "Web 客户端浏览器面板：通过受限的 Host RPC 提供截图历史、活动页面状态和已认证导航。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-browser-panel

[English](README.md) | 中文

## 概述

`dsh-client-ui-browser-panel` 为可选的 `browser` 服务添加 Web GUI 面板。它显示活动页面、捕获截图、打开 HTTP(S) URL、提供近期浏览器快照，并把 Host 桥接保持在回环 RPC 通道 `/dsh-browser-panel` 上。未安装 `dsh-browser` 时面板仍然可用，只报告浏览器自动化不可用，不会让 Web profile 强制依赖该服务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 Web profile bundle 加载本包。bundle patch 会插入注入 `connection` 的 Host 插件；Client 插件则把切换按钮和面板挂载到 Web 文档。可选的 `browser` 服务按需解析，因此安装 `@anweat/dsh-browser` 后即可启用导航和截图，不需要改变本包的组合方式。

### Host 操作

Host 部分在 `/dsh-browser-panel` 上提供 `status`、`capture`、`open`、`image` 和 `history`。`open` 只接受 HTTP(S) URL，并会在访问本地 harness URL 前完成 DSH 签名会话交换。`image` 只提供浏览器 snapshot 目录内的受支持图片，或 browser service 之前确认过的路径。

### Client 导出

Client 入口导出 `BrowserPanel`、`BrowserToggleButton`、`BrowserPanelProvider`、`useBrowserPanel`、`OPEN_URL_EVENT`、`SHOW_PANEL_EVENT` 和 `BrowserScreenshot` contract。内置组合直接使用 provider 与组件；其他 Web 插件可以使用 context 或 event 打开同一个面板。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Host 插件等待 `connection`，注册一个只允许回环访问的 RPC handler，并临时包装共享 browser 的 `open` 方法，使 GUI 导航和直接 browser 调用使用同一个已认证 DSH session。Client 通过 `connection.rpc` 建立小型 bridge，把一个 React root 挂载到 `dsh-browser-panel-root`，并随插件 fiber 移除该 root。

### 源码索引

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host RPC、DSH 导航认证、图片路径限制与截图历史 |
| [`src/client/index.tsx`](src/client/index.tsx) | Client 插件挂载、RPC bridge 与公共 Client 导出 |
| [`src/client/BrowserPanel.tsx`](src/client/BrowserPanel.tsx) | 面板呈现与截图操作 |
| [`cordis.patch.yml`](cordis.patch.yml) | Host/Client 插件的 Web bundle 注册 |
| [`INTEGRATION.md`](INTEGRATION.md) | 本私有包的本地集成说明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web app bundle](../../bundle/web-app/README.zh.md) — 挂载本包的 Web profile。
- [Browser integration](INTEGRATION.md) — 可选 browser provider 的本地集成说明。
- [Client connection](../connection/README.zh.md) — 面板使用的认证 RPC transport。
- [Client UI layout](../ui-layout/README.zh.md) — 承载 Web surface 的 layout。

-----

<a id="model-experience"></a>
## 模型体验

### Browser panel Host bridge

#### What the model sees

无；本包只通过 Web GUI 的 `/dsh-browser-panel` 呈现浏览器截图与状态，不注册 prompt、工具 schema 或模型请求。

#### Token effect

无；面板 event 只留在浏览器 UI 与 Host RPC 中。

#### KV Cache effect

无；面板不会改变组装后的模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Browser provider 仍是可选项**——没有 `dsh-browser` 时状态不可用，capture/open 操作无法执行。
- **只提供本地 snapshot 路径**——任意文件系统路径都会被拒绝，超过 8 MiB 的图片不会返回。
- **浏览器状态由 provider 所有**——本包不会持久化 page session、cookie 或面板之外的导航历史。
- **面板是 Web overlay**——它不会替代面向模型的 browser 工具，也不提供另一套自动化引擎。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包是 Host/Client bundle。修改 endpoint 或注入要求时，保持 `/dsh-browser-panel`、Client bridge 和 bundle patch 同步。

</details>

**运行时不变式：** 不发布伴生入口。RPC 注册和临时 browser wrapper 会随所属 Cordis effect 释放；图片服务操作会执行路径检查。
