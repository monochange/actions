# changeset-policy action

Run `mc affected` to verify changeset policy for the current pull request.

When `comment-on-failure` is enabled, the action posts the `comment` field returned by
`mc affected`. Repeated failures with the same comment body do not produce duplicate
updates. When the failure message changes, the previous failure is preserved in a
collapsed `<details>` section. Once the PR passes or is skipped, the action updates
the existing comment with a ✅ checkmark and preserves the previous failure history
a collapsed section.

```yaml
name: changeset policy

on:
  pull_request:

permissions:
  contents: read
  pull-requests: read
  issues: write

jobs:
  changeset-policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - id: changed
        uses: tj-actions/changed-files@v46
        with:
          separator: ','

      - uses: monochange/actions/changeset-policy@v0.4.0
        with:
          changed-paths: ${{ steps.changed.outputs.all_changed_files }}
          comment-on-failure: true
```

## Inputs

| Input                | Required | Default                    | Description                              |
| -------------------- | -------- | -------------------------- | ---------------------------------------- |
| `setup-monochange`   | no       | `true`                     | How to resolve monochange                |
| `github-token`       | no       | `${{ github.token }}`      | GitHub token for PR comments             |
| `repository`         | no       | `${{ github.repository }}` | Target repository in `owner/repo` format |
| `changed-paths`      | no       | —                          | Comma-separated changed paths            |
| `labels`             | no       | —                          | Comma-separated labels to consider       |
| `skip-labels`        | no       | —                          | Comma-separated skip labels              |
| `comment-on-failure` | no       | `true`                     | Post/update PR comment on failure        |
| `dry-run`            | no       | `false`                    | Validate without posting or failing      |
| `debug`              | no       | `false`                    | Enable extra debug logging               |

## Outputs

| Output    | Description                                  |
| --------- | -------------------------------------------- |
| `result`  | `success`, `skipped`, `dry-run`, or `failed` |
| `json`    | Raw JSON from `mc affected`                  |
| `summary` | Text summary                                 |
| `comment` | Markdown comment body from `mc affected`     |
