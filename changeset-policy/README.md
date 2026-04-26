# changeset-policy action

Run `mc affected` to verify changeset policy for the current pull request.

```yaml
uses: monochange/actions/changeset-policy@v0.1.0
```

## Inputs

| Input                | Required | Default               | Description                         |
| -------------------- | -------- | --------------------- | ----------------------------------- |
| `setup-monochange`   | no       | `true`                | How to resolve monochange           |
| `github-token`       | no       | `${{ github.token }}` | GitHub token for PR inspection      |
| `changed-paths`      | no       | —                     | Comma-separated changed paths       |
| `labels`             | no       | —                     | Comma-separated labels to consider  |
| `skip-labels`        | no       | —                     | Comma-separated skip labels         |
| `comment-on-failure` | no       | `false`               | Post PR comment on failure          |
| `dry-run`            | no       | `false`               | Validate without posting or failing |
| `debug`              | no       | `false`               | Enable extra debug logging          |

## Outputs

| Output    | Description                       |
| --------- | --------------------------------- |
| `result`  | `success`, `dry-run`, or `failed` |
| `json`    | Raw JSON from `mc affected`       |
| `summary` | Text summary                      |
