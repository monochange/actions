# change-classification action

Run `monochange change classify` once and publish the same evidence as action outputs, a job summary, and one updatable pull request comment.

The report keeps the proposed bump for the current pull request separate from the release floor accumulated since the latest package release. Each package decision reports the default-branch impact next to the release-relative impact (`release_impact`), so a pull request that only changes an API the latest release never shipped reads as breaking against `main` while its proposed bump follows the release verdict. The comment marks those packages with a `main → release (release)` impact cell and an informational callout, and the `release-breaking` output is `true` only when a package is breaking against its latest release. It shows the finding, source location, analyzer confidence, completeness, comparison membership, and pending changeset action behind every package recommendation.

The comment is specific to the pull request it is attached to. The action compares the pull request with the branch it targets (`origin/<base branch>`) and classifies the pull request head commit, so a stacked pull request does not inherit the changes of the branch below it. The comment opens with the classified head commit and base commit, so a reader can tell whether it matches the latest push. Findings that monochange saw only between the latest release and the base branch are listed under "Unreleased changes already on `<base>` (not part of this pull request)" and are not counted in the package table; they only explain the release floor.

The job summary and pull request comment open with a package table that counts breaking, minor, and patch findings per package. Counts reuse the finding markers (🔴 breaking, 🟢 minor, ⚪ patch) and only list severities the package actually has, so a package without breaking findings never shows a zero count. The individual findings and any analysis warnings stay available in collapsed `<details>` sections, so the comment stays short until a reviewer expands the package that needs attention.

```yaml
name: change classification

on:
  pull_request:
    # `edited` re-classifies a pull request whose base branch changed, such as
    # a stacked pull request retargeted after its parent merged.
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  pull-requests: write

jobs:
  classify:
    if: ${{ github.event.action != 'edited' || github.event.changes.base }}
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
| `base`                   | no       | PR base branch             | Base ref; defaults to `origin/<base branch>` of the pull request, else auto     |
| `head`                   | no       | PR head commit             | Candidate ref; defaults to the pull request head commit, else `HEAD`            |
| `release`                | no       | auto                       | Release ref override                                                            |
| `packages`               | no       | affected packages          | Comma- or newline-separated package ids or names                                |
| `detection-level`        | no       | `signature`                | `basic`, `signature`, or `semantic`                                             |
| `dependency-propagation` | no       | `public`                   | `none` or `public`                                                              |
| `include-unchanged`      | no       | `false`                    | Include unchanged packages                                                      |
| `post-comment`           | no       | `true`                     | Upsert the PR comment                                                           |

## Outputs

| Output             | Description                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| `result`           | `success` after classification                                                |
| `json`             | Versioned JSON contract from monochange                                       |
| `markdown`         | Rendered report used for the summary and comment                              |
| `recommendation`   | Overall `major`, `minor`, `patch`, or `none` proposal                         |
| `release-breaking` | `true` when a package is breaking against its latest release, not only `main` |
| `review-required`  | `true` when at least one package needs human or agent review                  |
| `summary`          | One-line result                                                               |

The action accepts every change-classification report with `schemaVersion` 1 or newer, so newer monochange CLI releases can add findings and coverage detail without breaking the action. The evidence fields the action reads (packages, decisions, findings) are stable across those schema versions.
