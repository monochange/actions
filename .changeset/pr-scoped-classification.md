---
actions: change
---

# Keep change-classification comments specific to the pull request

The `change-classification` action now compares a pull request with the branch it targets and classifies the pull request head commit, so a stacked pull request no longer reports the changes of the branch below it.

- `base` defaults to `origin/<base branch>` from the `pull_request` event, and `head` defaults to the event's head commit. Each is used only when the checkout contains it; otherwise the action warns and keeps the previous behavior. Explicit inputs still win.
- The comment names the classified head commit and base commit.
- Findings seen only between the latest release and the base branch move to an "Unreleased changes already on `<base>` (not part of this pull request)" list and no longer count toward the package's findings.

Add the `edited` event, guarded by `github.event.changes.base`, so a retargeted pull request is classified again:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
jobs:
  classify:
    if: ${{ github.event.action != 'edited' || github.event.changes.base }}
```
