# release-pr action

Create or update the release pull request using monochange.

```yaml
uses: monochange/actions/release-pr@v0.1.0
```

## Inputs

| Input               | Required | Default | Description                  |
| ------------------- | -------- | ------- | ---------------------------- |
| `setup-monochange`  | no       | `true`  | How to resolve monochange    |
| `format`            | no       | `json`  | Output format                |
| `dry-run`           | no       | `false` | Show without creating        |
| `github-token`      | no       | —       | GitHub token for PR creation |
| `working-directory` | no       | `.`     | Working directory            |
| `debug`             | no       | `false` | Enable extra debug logging   |

## Outputs

| Output                   | Description                       |
| ------------------------ | --------------------------------- |
| `result`                 | `success`, `dry-run`, or `failed` |
| `head-branch`            | Release PR head branch            |
| `base-branch`            | Release PR base branch            |
| `release-request-number` | PR number                         |
| `release-request-url`    | PR URL                            |
| `json`                   | Full JSON metadata                |
