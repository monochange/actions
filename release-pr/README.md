# release-pr action

Create or update the release pull request using monochange.

```yaml
uses: monochange/actions/release-pr@v0.1.0
```

## Inputs

| Input                         | Required | Default    | Description                                                                       |
| ----------------------------- | -------- | ---------- | --------------------------------------------------------------------------------- |
| `setup-monochange`            | no       | `true`     | How to resolve monochange                                                         |
| `format`                      | no       | `json`     | Output format                                                                     |
| `dry-run`                     | no       | `false`    | Show without creating                                                             |
| `github-token`                | no       | —          | GitHub token for PR creation                                                      |
| `working-directory`           | no       | `.`        | Working directory                                                                 |
| `refresh`                     | no       | `false`    | Force re-cutting an open sticky cut PR from the latest green base commit          |
| `banner-only`                 | no       | `false`    | Update only the behind-main status banner on an open cut PR                       |
| `from`                        | no       | —          | Optional base git ref or commit SHA to cut from                                   |
| `refresh-command`             | no       | `/refresh` | Pull request comment command that authorizes re-cutting an open cut PR            |
| `minimum-reviewer-permission` | no       | `maintain` | Minimum permission for `/refresh` comments (`admin`, `maintain`, `write`, `push`) |
| `debug`                       | no       | `false`    | Enable extra debug logging                                                        |

## Outputs

| Output                   | Description                       |
| ------------------------ | --------------------------------- |
| `result`                 | `success`, `dry-run`, or `failed` |
| `head-branch`            | Release PR head branch            |
| `base-branch`            | Release PR base branch            |
| `release-request-number` | PR number                         |
| `release-request-url`    | PR URL                            |
| `json`                   | Full JSON metadata                |
