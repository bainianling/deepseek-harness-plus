---
description: "多平台 AI 新闻聚合、封面本地缓存与可选模型翻译的 Web bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-ai-news

[English](README.md) | 中文

## 概述

`dsh-ai-news` 添加 Web GUI 的 AI 新闻区和 Host 侧聚合器，支持 Bilibili、抖音、小红书、X syndication timeline 以及 AI RSS feed。它把有界 feed 与下载的封面保存到 `$DSH_HOME/data/ai-news`，通过 `/api/ai-news` 提供 feed，并可以通过配置的模型路由或 OpenAI-compatible fallback 翻译英文标题和摘要。

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

在 Web profile 中加载 `cordis.patch.yml`。patch 会在 `webServer` 上插入 `ai-news` Host row；GUI 区域消费它的 `/api/ai-news` endpoint。默认 row 每 24 小时抓取一次，最多保留 800 条 item，启用五类数据源，并使用 `DASHSCOPE_API_KEY` 作为 fallback key 环境变量启用翻译。

### HTTP surface

- `GET /api/ai-news/feed` 返回 crawl 状态、各平台结果和有界 item。
- `POST /api/ai-news/refresh` 请求一次本地同源刷新。
- `/api/ai-news/media/<file>` 在文件名校验后提供缓存封面。

当远程封面过期时，Web GUI 可以显示缓存媒体；每条 item 都会保留来源链接用于 attribution。

### 配置

Patch 暴露 `enabled`、`intervalHours`、`maxItems`、`proxy`、`platforms`、`translateEnabled`、`translateApiKeyEnv`、`translateModel` 和 `translateMaxPerCrawl`。使用 `proxy: ''` 自动探测系统 proxy；部署需要固定选择时可以设置明确的 proxy URL 或 `none`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

插件执行有界 crawl，按 platform/native id 去重，过滤过期或低相关记录，把封面下载到 content-addressed cache，并持久化 feed 状态。手动 refresh 与定时 crawl 共用同一个 store 和运行保护。翻译是独立的有界步骤，因此翻译服务故障不会清空来源 feed。

### 源码索引

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis 插件、路由、service 注册与生命周期 |
| [`src/crawl.ts`](src/crawl.ts) | Crawl 编排与平台结果处理 |
| [`src/store.ts`](src/store.ts) | Feed 持久化、去重与有界状态 |
| [`src/media.ts`](src/media.ts) | 封面下载与本地媒体服务 |
| [`src/translate.ts`](src/translate.ts) | 可选模型/fallback 翻译 |
| [`cordis.patch.yml`](cordis.patch.yml) | Web bundle 组合与部署默认值 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web app bundle](../../bundle/web-app/README.zh.md) — 共用 Web Host 与 GUI 组合。
- [Web 能力](../../../docs/subsystems/web.zh.md) — 本 bundle 使用的 HTTP carrier。
- [LLM streaming](../../../docs/subsystems/llm-streaming.zh.md) — 翻译使用的模型 adapter 行为。
- [AI news panel](../../client/ui-layout/README.zh.md) — 消费 feed 的 Web Client 区域。

-----

<a id="model-experience"></a>
## 模型体验

### 翻译请求

#### What the model sees

当 `translateEnabled` 为 true 时，翻译模型会收到 crawl 得到的英文新闻标题和摘要；主 harness Agent 不会自动收到新闻上下文，本 bundle 也不会增加 Agent 工具 schema。

#### Token effect

翻译消耗的 token 与翻译 item 数量相关，并受 `translateMaxPerCrawl` 限制；普通 Agent 请求不变。

#### KV Cache effect

翻译请求使用所配置 provider 的缓存行为；本 bundle 不改变普通 Agent 请求前缀或缓存输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **数据源可用性在外部**——平台 HTML、syndication endpoint、RSS feed、proxy 行为、rate limit 和登录状态都可能在不发布 bundle 的情况下变化。
- **抖音数据需要 provider 状态**——配置的 browser auth profile 必须包含有效 session 才能获得登录数据。
- **封面是尽力而为**——远程图片可能过期、被阻断或超过下载限制；缓存文件只属于一个 DSH home。
- **翻译是可选的**——缺少 key、模型路由不可用或 fallback 被禁用时，会保留原始英文字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

保持 route prefix、媒体文件名校验、crawl store 和翻译限制与消费 `NewsFeed` 的 Web panel 一致。

</details>

**运行时不变式：** 本插件不拥有模型 Session 历史。Store、crawler 运行保护、HTTP 路由和翻译资源会随 Cordis context 释放。
