# `fail-when`

`monochange/actions/fail-when` is a small policy action that intentionally fails a workflow when a GitHub Actions expression says it should.

Use it when a repository needs an explicit, visible blocker instead of hiding conditional logic in shell scripts. The action can also write a job summary and optionally post a pull request comment explaining why the job was blocked.

## Typical use cases

- Keep a protected branch blocked until a maintainer uses the supported merge flow.
- Fail release pull requests that should be merged with `monochange/actions/merge` instead of GitHub's normal merge button.
- Add a readable failure reason to branch protection checks.
- Post a clear pull request comment when a maintainer attempted an unsupported workflow.

## Quick start

```yaml
- name: block unsupported merge path
  uses: monochange/actions/fail-when@v0.4.0
  with:
    should-fail: ${{ github.event_name == 'pull_request' }}
    reason: Release pull requests must be merged with /merge.
```

When `should-fail` evaluates to `true`, the step fails with the configured `reason`. When it evaluates to `false`, the action exits successfully and sets `failed` to `false`.

## How `should-fail` works

`should-fail` is evaluated by GitHub Actions before the action starts. Pass a normal GitHub Actions expression:

```yaml
should-fail: ${{ github.event.pull_request.base.ref == 'main' }}
```

The action receives the result as a string and accepts boolean-like values:

- true values: `true`, `1`, `yes`, `on`
- false values: `false`, `0`, `no`, `off`, empty string

Prefer expressions that return actual booleans (`${{ ... }}`) rather than hand-written strings.

## Inputs

| Input          | Required | Default                                  | Description                                                                                                                                                |
| -------------- | -------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | No       | `fail-when`                              | Internal variant selector for the path-based entrypoint. Leave unchanged.                                                                                  |
| `should-fail`  | No       | `false`                                  | Condition result. If true, the action records outputs, writes a summary, optionally comments on a PR, then fails.                                          |
| `reason`       | No       | `fail-when condition evaluated to true.` | Failure message used for the thrown error, `reason` output, and summary/comment body.                                                                      |
| `fail-comment` | No       | empty                                    | Markdown body to include in a PR comment when `should-fail` is true. If omitted, the action never calls the GitHub API.                                    |
| `github-token` | No       | `${{ github.token }}`                    | Token used only when `fail-comment` is set. Needs `pull-requests: read` to resolve PRs and `issues: write` to create comments.                             |
| `repository`   | No       | `${{ github.repository }}`               | Target repository in `owner/repo` format. Used only when `fail-comment` is set.                                                                            |
| `pull-request` | No       | empty                                    | Explicit pull request number for commenting. If omitted, the action tries to resolve the current PR from `pull_request` or `issue_comment` event payloads. |

## Outputs

| Output                | Value                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `failed`              | `true` when the action intentionally failed, `false` when it skipped.                                    |
| `reason`              | The final failure reason when `failed` is `true`.                                                        |
| `comment`             | JSON object containing the generated comment body when `fail-comment` is set.                            |
| `pull-request-number` | The PR number that received the comment, when a PR was resolved.                                         |
| `result`              | `skipped` when `should-fail` is false. The root dispatcher sets `result: failed` when the action throws. |

## Pull request comments

Set `fail-comment` to post a formatted comment on the relevant PR:

```yaml
- name: explain blocked release PR
  uses: monochange/actions/fail-when@v0.4.0
  permissions:
    pull-requests: read
    issues: write
  with:
    should-fail: ${{ github.event_name == 'pull_request' }}
    reason: Release PRs must be merged with the /merge command.
    fail-comment: |
      Please run `/merge` after the required checks have completed.
```

The posted comment includes:

1. a heading (`Action Blocked`),
2. the triggering actor,
3. the failure reason,
4. your custom markdown from `fail-comment`, and
5. a link back to the workflow run.

### PR resolution order

When `fail-comment` is set, the action resolves the target PR in this order:

1. `pull-request` input, if provided,
2. `github.context.payload.pull_request.number` for `pull_request` events,
3. `github.context.payload.issue.number` for `issue_comment` events where the issue is a pull request.

If no PR can be resolved, the action writes a warning and still fails with `reason`. Comment-posting failures are warnings too; they do not replace the intentional failure reason.

## Permissions

No special permissions are needed when `fail-comment` is omitted.

When posting comments, add these job permissions:

```yaml
permissions:
  pull-requests: read
  issues: write
```

`contents` permissions are not required by `fail-when`.

## Examples

### Block GitHub's normal merge path for release PRs

```yaml
name: release PR manual merge blocker

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  block-release-pr-ui-merge:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
      issues: write
    steps:
      - uses: monochange/actions/fail-when@v0.4.0
        with:
          should-fail: ${{ startsWith(github.head_ref, 'monochange/release/') }}
          reason: Release PRs must be merged with the monochange /merge workflow.
          fail-comment: |
            This check fails intentionally so the normal GitHub merge button cannot be used.

            After checks are green, comment `/merge` to fast-forward the release PR.
```

### Use the root action dispatcher

```yaml
- uses: monochange/actions@v0.4.0
  with:
    name: fail-when
    should-fail: ${{ github.ref_name == 'main' }}
    reason: This job is not allowed to run on main.
```

### Comment from an `issue_comment` workflow

```yaml
name: unsupported command explainer

on:
  issue_comment:
    types: [created]

jobs:
  explain:
    if: github.event.issue.pull_request && contains(github.event.comment.body, '/shipit')
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
      issues: write
    steps:
      - uses: monochange/actions/fail-when@v0.4.0
        with:
          should-fail: true
          reason: The /shipit command is not supported for this repository.
          fail-comment: |
            Use `/merge` for monochange release pull requests.
```

## Troubleshooting

### The step skipped unexpectedly

Check the rendered value of `should-fail`. GitHub evaluates `${{ ... }}` before the action starts. If the expression returns an empty string, `false`, `0`, `no`, or `off`, the action skips.

### No PR comment was posted

Make sure all of these are true:

- `fail-comment` is non-empty,
- the job grants `pull-requests: read` and `issues: write`, and
- the action can resolve a PR from `pull-request`, a `pull_request` event, or an `issue_comment` event on a PR.

### The workflow failed with the configured reason but also logged a comment warning

That is intentional. `fail-when` keeps the configured failure reason as the primary error. Comment and summary failures are warnings so they do not hide the policy failure.
