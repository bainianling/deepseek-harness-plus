# Agent Note: Web 知识中心使用宿主侧只读投影

Status: implemented

[English](2026-08-30-web-knowledge-center.md) | 中文

## Problem

应用级导航已经暴露知识库分区，但它只是静态占位页。Hindsight 持有项目的持久事实和生成式知识页，但浏览器代码不能安全依赖某个固定的本地 Hindsight URL、bank 选择、内部响应结构或存储实现。浏览器直接访问还会绕过 Web 宿主的部署边界，并让未来替换知识源变成一次客户端重写。

## Decision

Web 应用拥有只读 `/api/knowledge` 投影。`web-app` 使用有界的 `knowledgeTimeoutMs` 读取配置的 `hindsightUrl` 与 `hindsightBankId`，扁平化 Hindsight 知识树，并暴露 `/api/knowledge/snapshot` 与经过校验的 `/api/knowledge/pages/:id` 读取。快照携带来源身份与状态、文件夹、知识页摘要、来源标签、事实/文档/观察数量、归纳时间戳以及待处理或失败的操作数量。来源不可达或超时时返回结构化 `503`，不会挂起，也不会伪造一个空知识库。

`KnowledgeHubApp` 只消费这份 DSH 自有契约。它提供健康指标、文件夹与标签筛选、本地文本搜索、知识页选择、安全 Markdown 渲染，并明确展示加载、空结果、生成中、待更新和离线状态。页面是面向运维的管理视图而不是编辑器：在 DSH 定义经过认证的写入语义之前，知识变更仍由 Hindsight 工具与 API 负责。长期项目知识被组织为“架构与边界”“组件地图”“工程规范”“运行与维护”分区；功能 initiative 继续保留在现有 `Initiatives` 分区。

每个非平凡仓库任务都必须先列出并读取相关 Hindsight 知识页，再从源码重新推导架构或过去决策。经验证的冲突要写成 correction 文档，避免陈旧记忆继续影响后续工作。

## Alternatives considered

**让浏览器直接调用 Hindsight** — 否决，因为这会把本地服务地址和 bank 固化到客户端行为中，绕过 Web 宿主边界，让远程访问更复杂，并把 UI 耦合到 Hindsight 内部实现。

**把生成知识页复制成仓库 Markdown** — 否决，因为这会形成两个可独立修改的数据源，并丢失 Hindsight 持续刷新的知识页、事实、观察和操作健康状态。

**立即加入编辑控件** — 否决，因为可见写入动作需要认证、冲突处理、操作状态和来源所有权语义。只读管理界面在不虚构这些保证的前提下已经完整可用。

## Consequences

Hindsight 在线时知识库分区可直接使用，离线时会明确显示失败。部署可以通过 Web 行配置指向其他 bank，未来知识源实现也可以保持 `/api/knowledge` 契约而无需修改客户端。Host 每次刷新快照执行三次有界上游读取，每次选择知识页执行一次读取。实时内容依赖 Hindsight，但知识源故障不会影响 Web GUI 其他部分。测试钉住树扁平化、健康投影、离线行为、页面 ID 校验以及功能化导航页面。
