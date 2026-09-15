# Agent Note: 需要移植发布 API 重叠时暂停启动更新

Status: implemented

[English](2026-09-05-startup-update-release-overlap-guard.md) | 中文

## Problem

直接把新版本合并到定制 checkout（检出目录）可能会把新的核心 API 与旧的 session、LLM 和 workspace 本地适配混在一起。即使 Git 没有未解决的冲突，TypeScript 构建仍可能失败，导致启动更新反复失败。

## Decision

启动发布合并前，更新器会计算共同基线，并在 `apps/` 和 `packages/` 下比较本地修改路径与发布修改路径，排除 README 和 i18n 元数据。发现源码或包配置重叠时，更新器会暂停升级、写入 `blocked` 状态、列出代表性文件，并保持当前 checkout 不变。受影响的发布版本完成移植后，下一次启动检查确认没有重叠时，更新器即可继续。

## Alternatives considered

**合并每个发布版本，并在冲突时选择上游文件。** 已否决，因为 Git 冲突解决无法迁移不兼容的 TypeScript API，也无法在双方修改同一实现时保留本地行为。

**丢弃本地修改并直接安装发布树。** 已否决，因为定制 harness（运行框架）包含必须保留的本地 UI、局域网共享和桌面端适配。

**每次启动都继续重试失败的合并。** 已否决，因为重复尝试会产生相同的损坏工作树，并掩盖使发布版本能够构建所需的版本专属 API 移植工作。

## Consequences

- 没有源码重叠的发布版本继续使用自动合并和构建流程。
- 存在本地与上游源码或配置重叠的发布版本会在修改 checkout 前安全停止。
- 版本专属 API 完成移植期间，当前可用版本保持可用。

## Testing

隔离的 `dsh-v0.1.3-alpha.1` 发布树已通过 `pnpm install --frozen-lockfile` 和 `pnpm run build`。完整定制树的移植测试复现了核心 API 不匹配。更新器 PowerShell 语法检查已通过，实际更新检查返回退出码 0 且状态为 `blocked`，仓库工作树保持不变。
