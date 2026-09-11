# change-classification action

Run `monochange change classify` once and publish the same evidence as action outputs, a job summary, and one updatable pull request comment.

The report keeps the proposed bump for the current pull request separate from the release floor accumulated since the latest package release. It shows the finding, source location, analyzer confidence, completeness, comparison membership, and pending changeset action behind every package recommendation.

```yaml
name: change classification

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  classify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}

      - id: classify
        uses: monochange/actions/change-classification@v0
        with:
          dependency-propagation: public

      - run: echo "Proposed bump is ${{ steps.classify.outputs.recommendation }}"
```

`fetch-depth: 0` is required so monochange can resolve the default branch, merge base, and release tags. Checking out the pull request head SHA avoids classifying GitHub’s synthetic test-merge commit as authored source history.

Comments are advisory. Creating or updating the pull request comment needs the `pull-requests: write` scope: with only `issues: write` the API returns `403 Resource not accessible by integration`, and the action emits a warning while the JSON output and job summary remain available. A fork pull request receives a read-only token, which produces the same warning.

## Inputs

| Input                    | Required | Default                    | Description                                                                     |
| ------------------------ | -------- | -------------------------- | ------------------------------------------------------------------------------- |
| `setup-monochange`       | no       | `true`                     | Resolve monochange automatically, require it on `PATH`, or run a custom command |
| `github-token`           | no       | `${{ github.token }}`      | Token for pull request comments                                                 |
| `repository`             | no       | `${{ github.repository }}` | Repository in `owner/repo` format                                               |
| `pull-request`           | no       | event PR                   | Explicit pull request number                                                    |
| `working-directory`      | no       | `.`                        | Directory containing `monochange.toml`                                          |
| `base`                   | no       | auto                       | Default-branch ref                                                              |
| `head`                   | no       | `HEAD`                     | Candidate ref                                                                   |
| `release`                | no       | auto                       | Release ref override                                                            |
| `packages`               | no       | affected packages          | Comma- or newline-separated package ids or names                                |
| `detection-level`        | no       | `signature`                | `basic`, `signature`, or `semantic`                                             |
| `dependency-propagation` | no       | `public`                   | `none` or `public`                                                              |
| `include-unchanged`      | no       | `false`                    | Include unchanged packages                                                      |
| `post-comment`           | no       | `true`                     | Upsert the PR comment                                                           |

## Outputs

| Output            | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `result`          | `success` after classification                               |
| `json`            | Versioned JSON contract from monochange                      |
| `markdown`        | Rendered report used for the summary and comment             |
| `recommendation`  | Overall `major`, `minor`, `patch`, or `none` proposal        |
| `review-required` | `true` when at least one package needs human or agent review |
| `summary`         | One-line result                                              |

The action accepts every change-classification report with `schemaVersion` 1 or newer, so newer monochange CLI releases can add findings and coverage detail without breaking the action. The evidence fields the action reads (packages, decisions, findings) are stable across those schema versions.
