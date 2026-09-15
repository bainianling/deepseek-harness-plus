# Agent Note: Hindsight 从知识库显式启动

Status: implemented

[English](2026-09-04-hindsight-manual-start.md) | 中文

## Problem

过去 Web 启动器会在打开 GUI 时顺带启动本地 Hindsight daemon。这样只读知识库分区会依赖一个不透明的后台进程，即使用户不需要项目记忆也会拉起服务；启动失败还会落在另一个脚本或控制台里，而不是发生实际使用的界面中。Hindsight 离线或无法启动时，GUI 其他部分也必须继续可用。

## Decision

Web 启动不再拉起 Hindsight。知识库分区拥有明确的“启动 Hindsight”操作，并展示 `offline`、`starting`、`online` 或 `error` 状态。浏览器只调用 DSH 自有的 `/api/knowledge/status` 与 `/api/knowledge/start` 路由，不能提供可执行文件、profile、argv 或文件系统路径。

Host 在 Connection 注入后注册知识库路由，并在任何生命周期或 Hindsight 工作之前调用 `requestRejection`。启动路由只接受 POST，仅允许 loopback/同源控制，并且只接受空 body。可信配置提供 `hindsightProfile: dsh-local`、`hindsightCommand: hindsight-embed`，以及默认 240000 毫秒的有界 `hindsightStartTimeoutMs`。生命周期会先检查健康的 `hindsightUrl` 并接管现有 daemon；否则不经过 shell 启动可执行文件，固定传入 `-p <profile> daemon start`，设置 Python UTF-8 环境，使用脱敏父环境加显式 Hindsight/provider allowlist，stdio 脱离，并在 Windows 上隐藏进程窗口。

相同 daemon 身份和超时契约的启动操作在进程范围共享，因此并发 GUI 请求不会启动重复进程。健康轮询使用一个总 deadline；可执行文件缺失、spawn、进程退出和超时会转化为结构化状态。诊断只读取 profile 日志的有界尾部，并脱敏授权信息、URL、JSON 与赋值形式的凭据。detached daemon 不会因 Web fiber 释放而被终止；释放某个 controller 只会阻止后续状态更新到达该 controller。

客户端在 starting 时轮询，锁住重复点击，离线时保留 Web shell 其他功能，并在失败时提供重试。英文和简体中文 locale 均包含对应文案；状态面板使用语义设计 token，并具备响应式与 focus-visible 行为。既有只读投影仍由 Host 拥有，详见[Web 知识中心说明](2026-08-30-web-knowledge-center.zh.md)。

## Alternatives considered

**继续在 `start-dsh-web.bat` 或发现的脚本中自动启动** — 否决，因为打开 Web GUI 不应创建用户未请求的后台服务，而且脚本失败与知识库界面脱节。仓库启动器现在只启动 Web；知识库操作是唯一显式启动路径。

**让浏览器执行 Hindsight 或选择启动命令** — 否决，因为这会绕过 Connection 鉴权，把本地进程控制暴露给客户端，并让可执行文件/profile/路径注入成为 API 契约的一部分。

**在 Web fiber 释放时终止 Hindsight** — 否决，因为 Hindsight 是共享本地 daemon，其他 Web 会话可能仍在使用。detached 启动成功后，生命周期只负责观察状态，不拥有 daemon 的终止权。

**把不可用来源当成空知识库** — 否决，因为这会隐藏服务故障，容易被误认为项目没有记忆。UI 保留 shell 可用性，同时明确展示 daemon 状态与有界诊断。

## Consequences

运行 `dsh --profile web` 现在不会顺带启动 Hindsight：Hindsight 会保持离线，直到用户明确请求。第一次进入知识库分区会执行健康检查，并可以接管其他途径已启动的 daemon。手动启动最长可能等待配置的 deadline；UI 会解释等待状态，而不是让 Web 启动静默阻塞。Host 拥有所有进程与安全决策，客户端只负责展示和响应明确的用户手势。

路由和生命周期契约新增了针对 Connection rejection、本地控制栅栏、body 分帧、现有 daemon 接管、并发启动、超时终止、进程错误、脱敏、销毁竞态以及离线到在线 UI 轮询的聚焦覆盖。必须安装 `hindsight-embed` 或通过可信绝对路径配置它；UI 不会自动修复缺失的安装。

相关投影决策：[Web 知识中心使用宿主侧只读投影](2026-08-30-web-knowledge-center.zh.md)。
