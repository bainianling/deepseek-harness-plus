# DeepSeek Harness v3 更新报告

[English](2026-09-03-v3-update-report.md) | 中文

日期：2026-09-04

仓库基线：`0.1.2-rc.1`；Windows 桌面目录目标版本：`3.0.0`。

本次私人二次开发基于官方 DeepSeek Harness，加入面向 ChatGPT 兼容路由和 DeepSeek 路由的模型工作环境选择能力，以及第一阶段可持久化响应重放基础设施。

根目录 [README](../../README.zh.md) 记录本私人二次开发增加的 Web 能力和当前版本。

## 已完成

- 已在 `specs/model-environment-upgrade/tasks.md` 勾选任务 4。
- 增加 provider、协议、上下文窗口、缓存、工具、重放、后台任务、并行工具和原生压缩等能力的目录。
- 增加显式的会话模型环境解析、路由和 preset 校验、兼容性诊断与稳定失败码。
- 增加响应打开、响应条目和响应关闭三类 provider 无关的响应生命周期事件。
- 增加 pi-ai 对文本、推理和函数调用条目的生命周期事件生成；持久化词汇中排除了推理签名和凭据。
- agent loop 按顺序持久化响应生命周期，并覆盖取消、失败和未完成等终止状态。
- 生命周期保持路由绑定并标记为 `client-replay`，避免本地重放日志被误认为支持 provider-managed continuation。
- 按当前工作区需要改进 model-bench 的超时和通过阈值处理，并扩展会话检查 API。
- 加固桌面端启动器，通过环境变量或配置解析 harness 根目录和数据目录，不再嵌入机器专用路径。
- 从发布内容中移除已跟踪的运行时、构建、测试和桌面诊断日志；本机 `.env` 与桌面本地配置保持在发布仓库之外。
- Windows 桌面端已重新打包为 `3.0.0` 目录目标 `win-unpacked`，桌面快捷方式已改为指向该目录中的新 exe。由于当前网络无法获取签名/构建辅助工具，本次没有生成 NSIS 安装器。
- 修复了打包桌面端冷启动回归：将本地桌面配置作为打包回退，同时保留按用户配置优先的行为。重打包后的 exe 已成功在 `3080` 端口启动 Web UI，带鉴权的本机页面返回 HTTP `200`。

## 本次明确未启用

本版本未启用 provider-managed `previous_response_id`、持久化 Background Responses 任务、原生 Responses 压缩，以及对应的 SDK 和 snapshot 投影。解析器会将这些能力报告为不可用，直到请求、持久化、恢复和跨 SDK 行为能够一起实现并测试。

## 验证结果

- `dsh-llm`、`dsh-llm-pi-ai`、`dsh-agent-loop` 和 `dsh-session` 的 TypeScript 构建检查通过。
- 响应重放、pi-ai 转换、session 和 agent-loop 定向测试通过：4 个文件共 138 个测试。
- 2265 个文件的 Markdown 换行检查通过。
- pi-ai README 的翻译配对检查通过。
- 本第三版更新报告的翻译配对检查通过。
- 最终隐私清理前，持久化目录检查已通过。
- 全仓库 `pnpm run build` 通过。
- 使用本机 Electron 33.4.11 运行时执行 `npm.cmd run dist`，桌面端目录打包通过。
- 使用已配置的 harness 根目录执行桌面端冷启动验证通过；如果本地 Python wheel 缓存无效，可选的 Hindsight daemon 仍可能不可用，但不会阻止 Web UI 启动。

## 隐私声明

发布版本不包含 API key、Bearer token、带 token 的启动 URL、本机运行日志或机器专用桌面配置。文档中的敏感变量名仅用于说明环境变量接口，不包含任何敏感值。
