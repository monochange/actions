# monochange merge action

This directory exposes the merge action at:

```yaml
uses: monochange/actions/merge@v0.1.0
```

It uses the shared runtime bundled at `../dist/index.mjs` and fast-forwards the target branch to the checked PR head. Rebase or cherry-pick preparation updates the PR branch and returns `result: updated` with `merged: false`. Wait for fresh checks on that commit and run the action again to merge.

See the repository root [`README.md`](../README.md) for:

- usage patterns
- permissions and token setup
- input and output reference
- `/fast-forward` comment-trigger guidance
- the ready-to-copy workflow example at [`../.github/workflows/release-pr-merge.yml`](../.github/workflows/release-pr-merge.yml)
- local development and publishing notes
