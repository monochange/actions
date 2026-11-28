# `sync-release`

Replays published release bookkeeping from frozen cut branches (`strategy = "cut"`) onto the base branch (`main`) and opens or updates a single coalesced sync pull request (`monochange/sync-release` → `main`).

## Usage

```yaml
- uses: monochange/actions/sync-release@v0
  with:
    from: ${{ github.ref_name }}
    backend: hosted
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input               | Default                  | Description                                                                                                                   |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `setup-monochange`  | `true`                   | How to resolve `monochange`.                                                                                                  |
| `working-directory` | `.`                      | Working directory to run `monochange` in.                                                                                     |
| `from`              | `''`                     | Optional release tag or commit SHA to sync explicitly.                                                                        |
| `mode`              | `''`                     | Optional override: `semantic_pr`, `bookkeeping_only`, `merge_pr`, or `none`.                                                  |
| `open-request`      | `true`                   | Run `open-sync-request` to open or update the coalesced sync PR (`true`), or run standalone `sync-release` locally (`false`). |
| `backend`           | `local`                  | Backend for `open-sync-request`: `local` or `hosted`.                                                                         |
| `hosted-url`        | `https://monochange.dev` | Hosted app base URL when `backend` is `hosted`.                                                                               |
| `github-token`      | `${{ github.token }}`    | Token passed to `monochange` as `GITHUB_TOKEN`.                                                                               |
| `format`            | `json`                   | Output format (`json`, `json-min`, `text`, `md`).                                                                             |
| `dry-run`           | `false`                  | Preview without modifying files or opening a pull request.                                                                    |
| `debug`             | `false`                  | Enable debug logging.                                                                                                         |
