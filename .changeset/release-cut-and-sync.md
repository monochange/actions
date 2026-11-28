---
actions: minor
---

# Add `sync-release` variant and frozen release cut support (`--refresh`, `--banner-only`, post-merge chaining)

Adds the `sync-release` GitHub Action variant (`monochange/actions/sync-release`) to replay published cut release bookkeeping onto the base branch and open/update the coalesced sync pull request (`monochange/sync-release`) via a single `open-sync-request` invocation (or standalone `sync-release` when `open-request` is `false`). Also adds `refresh`, `banner-only`, `from`, and authorized `/refresh` PR comment trigger support (including `write` permission) to `release-pr` and `hosted-release`, and updates `post-merge-release` to skip synced bookkeeping commits (`synced_from_commit`), fail without follow-on steps if publishing fails, and optionally chain `open-sync-request` and `open-next-cut` from clean default-branch worktrees.
