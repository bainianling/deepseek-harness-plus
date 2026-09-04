# Agent Note: Startup updates resume verified release merges and bound desktop waits

Status: implemented

English | [中文](2026-09-02-startup-update-resume-and-timeout.zh.md)

## Problem

The local-build updater can leave a resolved release merge in `.git\MERGE_HEAD`, causing every later startup to report a blocked update even though no files remain unresolved. A changed `pnpm-lock.yaml` can also prevent recovery with `git merge --abort`. The desktop launcher has no durable update log and can wait indefinitely for a PowerShell child that stops responding.

## Decision

The startup updater treats a `MERGE_HEAD` as resumable when its worktree has no unresolved files and the pending commit resolves to an exact `dsh-v*` release tag. It keeps unresolved merges and non-release merge heads blocked. Recovery protects a user-modified `pnpm-lock.yaml` across `git merge --abort`, then rebuilds the checkout before reporting failure.

The desktop launcher runs the updater with a bounded 15-minute wait, records stdout and stderr in its user-data directory, and terminates the PowerShell process tree on timeout. The launcher continues to the server with a diagnostic warning when an update exits non-zero, while the updater status file retains the actionable reason.

## Alternatives considered

**Block every `MERGE_HEAD`.** Rejected because a merge whose conflicts are already resolved can be verified and committed safely; blocking it permanently turns an interrupted but recoverable update into a manual repair task.

**Discard the checkout with reset or forced cleanup.** Rejected because the customized harness carries local UI and desktop adaptations, and startup recovery must preserve user work and local modifications.

**Wait without a timeout and rely on console output.** Rejected because the desktop process has no reliable interactive console and a hung update can prevent the application from opening. The file log and status record make the failure diagnosable after the launcher continues.

## Consequences

- A resolved release merge can complete on the next startup, while unresolved or unexpected merges remain fail-loud and protected.
- The lockfile recovery path preserves its user content, but a failed update still leaves the status file as the source for the next repair attempt.
- Desktop startup has a finite update wait and a persistent log in its user-data directory.
- The local checkout is verified at `dsh-v0.1.2-alpha.5`; future release tags use the same resume and validation path.

## Testing

The startup updater completed the alpha.4 recovery and alpha.5 upgrade. `pnpm run build` completed, the local adaptation tests passed with `83/83` and `378/378`, and the desktop main process syntax check passed. The desktop shortcut resolved to Electron with the desktop main process as its argument, and the final updater status was `updated` with current and latest both `dsh-v0.1.2-alpha.5`.
