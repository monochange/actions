# monochange merge action

This directory exposes the merge action at:

```yaml
uses: monochange/actions/merge@v1
```

It uses the shared runtime bundled at `../dist/index.mjs` and performs a **fast-forward-only** update of the target branch.

See the repository root [`README.md`](../README.md) for:

- usage patterns
- permissions and token setup
- input and output reference
- `/fast-forward` comment-trigger guidance
- the ready-to-copy workflow example at [`../.github/workflows/release-pr-merge.yml`](../.github/workflows/release-pr-merge.yml)
- local development and publishing notes
