---
description: "Web bundle for multi-platform AI news aggregation, local cover caching, and optional model-backed translation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-ai-news

English | [中文](README.zh.md)

## Summary

`dsh-ai-news` adds the Web GUI's AI news section and a host-side aggregator for Bilibili, Douyin, Xiaohongshu, X syndication timelines, and AI RSS feeds. It stores a bounded feed and downloaded covers under `$DSH_HOME/data/ai-news`, exposes the feed at `/api/ai-news`, and can translate English titles and summaries through the configured model route or an OpenAI-compatible fallback.

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

Load `cordis.patch.yml` in the Web profile. The patch inserts the `ai-news` host row over `webServer`; the GUI section consumes its `/api/ai-news` endpoints. The default row crawls every 24 hours, keeps at most 800 items, enables the five supported source groups, and enables translation with `DASHSCOPE_API_KEY` as the fallback key environment variable.

### HTTP surface

- `GET /api/ai-news/feed` returns crawl status, per-platform outcomes, and bounded items.
- `POST /api/ai-news/refresh` requests a local same-origin refresh.
- `/api/ai-news/media/<file>` serves cached cover images after filename validation.

The Web GUI can show cached media when a remote cover expires; each item retains its source link for attribution.

### Configuration

The patch exposes `enabled`, `intervalHours`, `maxItems`, `proxy`, `platforms`, `translateEnabled`, `translateApiKeyEnv`, `translateModel`, and `translateMaxPerCrawl`. Use `proxy: ''` for system-proxy detection, or set an explicit proxy URL or `none` when the deployment requires a fixed choice.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin schedules a bounded crawl, deduplicates items by platform/native id, filters stale or low-relevance records, downloads covers into a content-addressed cache, and persists feed state. A refresh uses the same store and run guard as the scheduled crawl. Translation is a separate bounded step, so a translation outage does not erase the source feed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis plugin, routes, service registration, and lifecycle |
| [`src/crawl.ts`](src/crawl.ts) | Crawl orchestration and platform result handling |
| [`src/store.ts`](src/store.ts) | Feed persistence, deduplication, and bounded state |
| [`src/media.ts`](src/media.ts) | Cover download and local media serving |
| [`src/translate.ts`](src/translate.ts) | Optional model/fallback translation |
| [`cordis.patch.yml`](cordis.patch.yml) | Web bundle composition and deployment defaults |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web app bundle](../../bundle/web-app/README.md) — shared Web host and GUI composition.
- [Web capability](../../../docs/subsystems/web.md) — the HTTP carrier used by this bundle.
- [LLM streaming](../../../docs/subsystems/llm-streaming.md) — model adapter behavior used by translation.
- [AI news panel](../../client/ui-layout/README.md) — the Web client section that consumes the feed.

-----

<a id="model-experience"></a>
## Model Experience

### Translation request

#### What the model sees

When `translateEnabled` is true, the translation model receives English news titles and summaries from the crawl; the main harness agent receives no automatic news context and this bundle adds no agent tool schema.

#### Token effect

Translation consumes tokens in proportion to translated items, bounded by `translateMaxPerCrawl`; normal agent requests are unchanged.

#### KV Cache effect

The translation request uses the configured provider's cache behavior; this bundle does not change the normal agent request prefix or cache inputs.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Source availability is external** — platform HTML, syndication endpoints, RSS feeds, proxy behavior, rate limits, and login state can change without a bundle release.
- **Douyin data requires provider state** — the configured browser auth profile must contain a valid session for logged-in results.
- **Covers are best effort** — remote images may expire, be blocked, or exceed the configured download limit; cached files are local to one DSH home.
- **Translation is optional** — missing keys, unavailable model routes, or a disabled fallback leave the original English fields intact.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the route prefix, media filename validation, crawl store, and translation limits aligned with the Web panel that consumes `NewsFeed`.

</details>

**Runtime invariant:** The plugin owns no model session history. Its store, crawler run guard, HTTP routes, and translation resources are disposed with the Cordis context.
