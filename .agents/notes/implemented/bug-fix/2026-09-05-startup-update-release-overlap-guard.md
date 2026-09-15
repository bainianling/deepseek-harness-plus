# Agent Note: Pause startup upgrades when release API overlap needs porting

Status: implemented

English | [中文](2026-09-05-startup-update-release-overlap-guard.zh.md)

## Problem

Directly merging a new release into the customized checkout can combine new core APIs with older local session, LLM, and workspace adaptations. The merge can have no unresolved Git conflicts and still fail the TypeScript build, causing repeated startup update failures.

## Decision

Before starting a release merge, the updater computes the merge base and intersects local changed paths with release changed paths under `apps/` and `packages/`, excluding README and i18n metadata. Any source or package configuration overlap pauses the upgrade, writes state `blocked`, lists representative files, and leaves the current checkout untouched. The updater can resume after the affected release has been ported and the next startup check finds no overlap.

## Alternatives considered

**Merge every release and choose upstream files on conflicts.** Rejected because Git conflict resolution cannot migrate incompatible TypeScript APIs or preserve local behavior when both sides changed the same implementation.

**Discard local changes and install the release tree.** Rejected because the customized harness owns local UI, LAN-sharing, and desktop adaptations that must remain available.

**Keep retrying the failed merge on every startup.** Rejected because repeated attempts produce the same broken checkout and obscure the version-specific porting work required to make the release build.

## Consequences

- Releases with no source overlap continue through the automatic merge and build path.
- Releases with overlapping local and upstream source/configuration changes fail closed before modifying the checkout.
- The current working version remains available while the affected release receives deliberate API porting.

## Testing

The isolated `dsh-v0.1.3-alpha.1` release tree passed `pnpm install --frozen-lockfile` and `pnpm run build`. Transplanting the full customized tree reproduced core API mismatches. The updater PowerShell parse check passed, the live updater check returned exit code 0 with state `blocked`, and the repository worktree remained unchanged.
