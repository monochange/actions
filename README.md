# monochange actions

[![codecov](https://codecov.io/gh/monochange/actions/graph/badge.svg)](https://codecov.io/gh/monochange/actions)

GitHub Actions for monochange release automation.

This repository exists so monochange can own the critical parts of its workflow instead of depending directly on third-party actions, while still preserving the behavior that matters for release pull requests.

The first action in this repository is `merge`.

It is intentionally modeled after [`sequoia-pgp/fast-forward`](https://github.com/sequoia-pgp/fast-forward): it performs a **fast-forward-only** update of the base branch so the release commit lands unchanged.

That means it does **not** create a merge commit.

## What is in this repository?

Currently implemented:

- `merge` - fast-forward a monochange release pull request onto its base branch
- `fail-when` - intentionally fail a workflow step with a configurable reason
- `setup-monochange` - install monochange CLI from cargo or binstall
- `changeset-policy` - validate changeset policy for affected packages
- `release-pr` - open a release pull request
- `publish-plan` - generate a publish plan for the current release
- `post-merge-release` - tag and publish after a release PR merges

Public entrypoints:

- `monochange/actions@v0.4.0` with `name: merge`
- `monochange/actions/merge@v0.4.0`
- `monochange/actions/fail-when@v0.4.0`

Both entrypoints run the same implementation.

---

## Why monochange needs this

monochange release pull requests are not ordinary feature PRs.

A release PR usually contains a deliberately prepared release commit. That commit should land on the target branch unchanged so the resulting history still reflects the exact release artifact that monochange prepared.

Using GitHub's normal merge UI is risky here because it can:

- create a merge commit
- encourage the wrong merge strategy
- bypass monochange-specific policy checks
- make the final history less predictable

The `merge` action exists to:

- preserve the release commit SHA
- keep branch history compatible with monochange release expectations
- allow a deliberate "manual merge blocker" check pattern
- support slash-command style approval flows such as `/merge`
- keep the merge policy inside your own GitHub Actions repository

---

## How the `merge` action works

At a high level, the action:

1. resolves the target pull request
2. validates that it is a release PR you actually intend to merge
3. collects check runs and statuses for the PR head SHA
4. verifies the expected check policy
5. fetches the base and head refs with git
6. verifies the base branch is an ancestor of the PR head
7. optionally checks that the triggering actor has push permission
8. pushes the PR head SHA directly onto the base branch

In practical terms, the final branch update is equivalent to:

```bash
git push origin <pr-head-sha>:refs/heads/<base-branch>
```

-but only after the action has verified that this is a legal fast-forward update.

### Important consequence

If the release branch has diverged from the base branch, the action fails.

It will not create a merge commit and it will not force-push around divergence.

That is intentional.

---

## Available entrypoints

### Root action with variant dispatch

Use this when you want a single repository-level action entrypoint.

```yaml
uses: monochange/actions@v0.4.0
with:
  name: merge
```

### Path-based action

Use this when you want a dedicated merge action entrypoint.

```yaml
uses: monochange/actions/merge@v0.4.0
```

For most consumers, the path-based form is the clearest choice.

---

## Quick start

### Simplest usage

```yaml
- name: fast-forward release PR
  uses: monochange/actions/merge@v0.4.0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
```

### Root-entrypoint equivalent

```yaml
- name: fast-forward release PR
  uses: monochange/actions@v0.4.0
  with:
    name: merge
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
```

---

## Ready-to-copy workflow

This repository includes a ready-to-copy example workflow at:

- [`.github/workflows/release-pr-merge.yml`](.github/workflows/release-pr-merge.yml)

It supports both:

- `workflow_dispatch`
- `/merge` PR comments via `issue_comment`

### What the example workflow does

- lets a maintainer manually dispatch a release merge
- optionally accepts a PR number
- also listens for `/merge` comments on pull requests
- uses a dedicated token such as `RELEASE_PR_MERGE_TOKEN`
- uses `minimum-reviewer-permission: 'admin'` for safety

### Example file contents

```yaml
name: release PR merge

on:
  workflow_dispatch:
    inputs:
      pull_request:
        description: Optional release PR number. Leave empty to auto-detect the single open release PR.
        required: false
        type: string
      comment:
        description: Whether the action should post a pull request comment.
        required: false
        default: on-error
        type: choice
        options:
          - always
          - on-error
          - never
  issue_comment:
    types:
      - created

concurrency:
  group: release-pr-merge-${{ github.event.issue.number || inputs.pull_request || github.ref_name }}
  cancel-in-progress: false

jobs:
  merge-release-pr:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        contains(github.event.comment.body, '/merge')
      )
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      checks: read
      statuses: read
    steps:
      - name: fast-forward release PR from workflow dispatch
        if: github.event_name == 'workflow_dispatch'
        uses: monochange/actions/merge@v0.4.0
        with:
          github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
          pull-request: ${{ inputs.pull_request }}
          base-branch: main
          head-branch-prefix: monochange/release/
          required-failing-check: release-pr-manual-merge-blocker
          minimum-reviewer-permission: 'admin'
          comment: ${{ inputs.comment }}

      - name: fast-forward release PR from /merge comment
        if: github.event_name == 'issue_comment'
        uses: monochange/actions/merge@v0.4.0
        with:
          github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
          base-branch: main
          head-branch-prefix: monochange/release/
          required-failing-check: release-pr-manual-merge-blocker
          minimum-reviewer-permission: 'admin'
          comment: always
```

---

## `/merge` comment trigger

If you want behavior close to the original fast-forward workflow pattern, use an `issue_comment` trigger and ask maintainers to comment:

```text
/merge
```

on the release pull request.

### Recommended pattern

The recommended pattern is:

- listen to `issue_comment`
- only run when the comment body contains `/merge`
- only run when the issue is actually a pull request
- keep `minimum-reviewer-permission: 'admin'`
- use `comment: always` so the PR gets visible feedback

### Security note

`issue_comment` workflows run in the base repository context, so they can see repository secrets.

Because of that, you should **not** rely on the slash command match alone.

Keep this input enabled:

```yaml
with:
  minimum-reviewer-permission: 'admin'
```

That makes the action verify that the user who triggered the workflow has push access to the target repository before it performs the fast-forward.

### Minimal slash-command example

```yaml
name: release PR merge

on:
  issue_comment:
    types:
      - created

jobs:
  merge-release-pr:
    if: >-
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '/merge')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      checks: read
      statuses: read
    steps:
      - name: fast-forward release PR
        uses: monochange/actions/merge@v0.4.0
        with:
          github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
          base-branch: main
          head-branch-prefix: monochange/release/
          required-failing-check: release-pr-manual-merge-blocker
          minimum-reviewer-permission: 'admin'
          comment: always
```

---

## Pull request resolution

The action resolves the pull request in this order:

1. `pull-request` input, if provided
2. the current GitHub event payload, if the workflow runs in a PR or PR-comment context
3. auto-detection of a single open PR targeting `base-branch` whose head branch starts with `head-branch-prefix`

This makes the action work well for:

- `workflow_dispatch`
- `pull_request`
- `issue_comment`
- automation that expects exactly one open release PR

If auto-detection finds zero or multiple matching PRs, the action fails rather than guessing.

---

## Check policy

By default, the action enforces a monochange-friendly release PR policy.

It requires:

- no pending checks
- no cancelled checks
- no unexpected failing checks
- exactly one intentionally failing check named `release-pr-manual-merge-blocker`

This supports the common pattern where a blocker check exists only to stop humans from using GitHub's merge button directly.

### Disable strict green-check enforcement

```yaml
with:
  require-green-checks: 'false'
```

### Disable the special failing-check expectation

```yaml
with:
  required-failing-check: ''
```

---

## Permissions and token requirements

Minimum recommended workflow permissions:

```yaml
permissions:
  contents: write
  pull-requests: write
  checks: read
  statuses: read
```

### Why `pull-requests: write`?

The action may post a pull request comment depending on the `comment` mode.

If you always use `comment: never`, you may not need that permission, but keeping it is usually simplest.

### Recommended token setup

In most real repositories, the default `github.token` is not enough for protected branch fast-forwarding.

Recommended setup:

- create a dedicated token or GitHub App installation token
- store it as `RELEASE_PR_MERGE_TOKEN`
- allow it to update the protected base branch
- use that secret for this action

Example:

```yaml
with:
  github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
```

---

## Inputs

### Root action only

| Input  | Required | Default | Description                                          |
| ------ | -------- | ------- | ---------------------------------------------------- |
| `name` | yes      | none    | Action variant to run. Currently supported: `merge`. |

### Shared merge inputs

| Input                         | Required | Default                           | Description                                                                                                                                                       |
| ----------------------------- | -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`                | no       | `${{ github.token }}`             | Token used for GitHub API calls and the final git push.                                                                                                           |
| `repository`                  | no       | `${{ github.repository }}`        | Target repository in `owner/repo` format.                                                                                                                         |
| `pull-request`                | no       | empty                             | Explicit PR number. Must be a positive integer when provided.                                                                                                     |
| `base-branch`                 | no       | `main`                            | Expected base branch for the release PR.                                                                                                                          |
| `head-branch-prefix`          | no       | `monochange/release/`             | Required prefix for the release PR head branch.                                                                                                                   |
| `required-failing-check`      | no       | `release-pr-manual-merge-blocker` | Name of the intentionally failing blocker check. Pass an empty string to disable this special rule.                                                               |
| `allow-cross-repository`      | no       | `'false'`                         | Whether pull requests from forks are allowed.                                                                                                                     |
| `require-green-checks`        | no       | `'true'`                          | Whether all checks must be complete and successful apart from the configured blocker check.                                                                       |
| `minimum-reviewer-permission` | no       | `admin`                           | Minimum repository role required to trigger the merge. `admin` (default), `maintain`, or `push` (insecure). Strongly recommended for comment-triggered workflows. |
| `comment`                     | no       | `on-error`                        | Whether to post a pull request comment: `always`, `never`, or `on-error`.                                                                                         |
| `dry-run`                     | no       | `'false'`                         | Validate everything without updating the base branch.                                                                                                             |
| `update-branch-on-failure`    | no       | `'false'`                         | When true, rebase the head branch onto the latest base branch and force-push it instead of failing when fast-forward is not possible.                             |
| `post-update-script`          | no       | empty                             | Optional shell command to run after a successful rebase and force-push, before the fast-forward merge. Runs in the temp git workspace.                            |
| `post-update-workflow`        | no       | empty                             | Optional workflow file path to dispatch via `workflow_dispatch` after a successful rebase and force-push. Requires `actions: write` permission.                   |
| `trigger-command`             | no       | `/merge`                          | Slash command that triggers this action when posted as a pull request comment. Only validated when the workflow runs from an issue_comment event.                 |
| `debug`                       | no       | `'false'`                         | Emit extra debug logging.                                                                                                                                         |

---

## Outputs

| Output                | Description                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| `result`              | Final result. Currently `fast-forwarded`, `dry-run`, or `failed`.                      |
| `merged`              | `'true'` when a fast-forward update was performed, otherwise `'false'`.                |
| `rebased`             | `'true'` when the head branch was rebased onto the base branch before fast-forwarding. |
| `pull-request-number` | Resolved PR number.                                                                    |
| `pull-request-url`    | Resolved PR URL.                                                                       |
| `base-sha`            | Base branch SHA before validation/push.                                                |
| `head-sha`            | Head SHA used for validation.                                                          |
| `fast-forward-sha`    | The SHA pushed to the base branch, or the candidate SHA reported during dry-run mode.  |
| `comment`             | JSON string with a `body` field containing the summary comment text.                   |

### Example: consume outputs

```yaml
- name: fast-forward release PR
  id: merge
  uses: monochange/actions/merge@v0.4.0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}

- name: print results
  run: |
    echo "result=${{ steps.merge.outputs.result }}"
    echo "merged=${{ steps.merge.outputs.merged }}"
    echo "pr=${{ steps.merge.outputs.pull-request-number }}"
    echo "url=${{ steps.merge.outputs.pull-request-url }}"
    echo "base_sha=${{ steps.merge.outputs.base-sha }}"
    echo "head_sha=${{ steps.merge.outputs.head-sha }}"
    echo "ff_sha=${{ steps.merge.outputs.fast-forward-sha }}"
    echo '${{ steps.merge.outputs.comment }}'
```

---

## Common usage patterns

### Auto-detect the only open release PR

```yaml
- uses: monochange/actions/merge@v0.4.0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
```

### Fast-forward a specific PR number

```yaml
- uses: monochange/actions/merge@v0.4.0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
    pull-request: '123'
```

### Dry-run validation only

```yaml
- uses: monochange/actions/merge@v0.4.0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
    dry-run: 'true'
```

### Always post a PR comment

```yaml
- uses: monochange/actions/merge@v0.4.0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
    comment: always
```

### Allow cross-repository PRs

```yaml
- uses: monochange/actions/merge@v0.4.0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
    allow-cross-repository: 'true'
```

---

## Failure modes and troubleshooting

### "Expected exactly one open release pull request..."

Auto-detection found zero or multiple matching PRs.

Fixes:

- pass `pull-request` explicitly
- close extra release PRs
- tighten `base-branch`
- tighten `head-branch-prefix`

### "Pull request still has pending checks..."

Some checks have not completed yet.

Fixes:

- wait for CI to finish
- disable strict enforcement with `require-green-checks: 'false'` if that matches your policy

### "Expected exactly one failing check named ..."

The blocker-check expectation did not match the repository's real check set.

Fixes:

- keep the blocker check name aligned with your workflow
- set `required-failing-check: ''` to disable the special-case rule

### "Cannot fast-forward ... is not a direct ancestor ..."

The base branch advanced or the release branch diverged.

Fixes:

- rebase or regenerate the release branch
- set `update-branch-on-failure: 'true'` to let the action rebase and push automatically
- re-run the workflow after the release PR head is updated

### "Actor @... does not have push permission ..."

The user who triggered the workflow does not have write-level access.

Fixes:

- have a maintainer trigger the workflow
- keep this check enabled for slash-command workflows
- disable it only if you deliberately trust another gating mechanism

### "Fast-forward push failed ..."

The final push was rejected.

Common reasons:

- the base branch advanced after validation
- the token cannot update the protected branch
- branch protection still blocks the push

Fixes:

- re-run the workflow
- verify branch protection bypass rules for the token
- use a dedicated `RELEASE_PR_MERGE_TOKEN`

---

## Suggested monochange workflow shape

A typical monochange setup looks like this:

1. CI runs on `main` and keeps the release PR refreshed.
2. The release PR targets `main` and uses a branch like `monochange/release/...`.
3. A dedicated blocker check fails intentionally to stop UI merges.
4. A maintainer runs the merge workflow or comments `/merge`.
5. This action validates the PR and fast-forwards `main` to the release commit.
6. The release commit lands unchanged.

---

## Repository layout

```text
action.yml                              # root action entrypoint
merge/action.yml                        # path-based merge entrypoint
.github/workflows/release-pr-merge.yml  # ready-to-copy workflow example
src/main.ts                             # variant dispatcher
src/actions/merge/                      # merge implementation
src/shared/                             # shared helpers
dist/index.mjs                          # published bundle
```

---

## Development

### Tooling

- package manager: `pnpm`
- runtime baseline: Node 24
- implementation language: TypeScript
- build/test toolchain: Vite+

### Install dependencies

If this repository lives inside a larger pnpm workspace, this is often useful:

```bash
pnpm install --ignore-workspace
```

### Validate locally

```bash
pnpm check
pnpm test
pnpm build
```

### Commands

| Command      | Purpose                    |
| ------------ | -------------------------- |
| `pnpm fmt`   | format files               |
| `pnpm check` | format/lint/typecheck      |
| `pnpm test`  | run tests                  |
| `pnpm build` | build `dist/index.mjs`     |
| `pnpm all`   | run check, test, and build |

---

## Publishing notes

Like most JavaScript GitHub Actions repositories, this repository is meant to publish the compiled `dist/` bundle alongside the source.

When releasing:

1. run `pnpm build`
2. commit the updated `dist/`
3. tag a release such as `v0.4.0`
4. reference the action by tag or pinned SHA downstream

Examples:

```yaml
uses: monochange/actions@v0.4.0
```

```yaml
uses: monochange/actions/merge@v0.4.0
```

---

## `fail-when`

Intentionally fail a workflow step with a configurable reason. Useful for manual merge blockers, policy gates, and branch-protection checks that need a clear human-readable failure.

`fail-when` writes a job summary every time it intentionally fails. If `fail-comment` is provided, it also resolves the target PR and posts a formatted markdown comment. If `should-fail` is false, it skips without requiring a reason, token, repository, or pull request context.

```yaml
- uses: monochange/actions/fail-when@v0.4.0
  with:
    should-fail: ${{ startsWith(github.head_ref, 'monochange/release/') }}
    reason: Release PRs must be merged with the monochange /merge workflow.
    fail-comment: |
      This check fails intentionally so the normal GitHub merge button cannot be used.

      After checks are green, comment `/merge` to fast-forward the release PR.
```

See the full [`fail-when` documentation](fail-when/README.md) for inputs, outputs, permissions, PR comment behavior, examples, and troubleshooting.

---

## `setup-monochange`

Install the `monochange` CLI from cargo or via `cargo binstall`. Falls back to installing from source if neither is available.

```yaml
- uses: monochange/actions/setup-monochange@v0.4.0
  with:
    setup-monochange: true
    command: mc
```

---

## `changeset-policy`

Validate that all affected packages have appropriate changesets.

```yaml
- id: changed
  uses: tj-actions/changed-files@v46
  with:
    separator: ','

- uses: monochange/actions/changeset-policy@v0.4.0
  with:
    changed-paths: ${{ steps.changed.outputs.all_changed_files }}
    comment-on-failure: true
```

Failure comments use the `comment` field from `mc affected` and are deleted after the PR passes or is skipped.

---

## `release-pr`

Open a release pull request with the current changeset state.

```yaml
- uses: monochange/actions/release-pr@v0.4.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

---

## `publish-plan`

Generate a publish plan for the current release.

```yaml
- uses: monochange/actions/publish-plan@v0.4.0
  with:
    mode: full
```

---

## `post-merge-release`

Tag and publish after a release PR merges.

```yaml
- uses: monochange/actions/post-merge-release@v0.4.0
  with:
    from-ref: HEAD
    branch: release
```

---

## Adding more actions later

This repository is intentionally structured for future action variants.

To add one later:

1. add `src/actions/<variant>/`
2. dispatch from `src/main.ts`
3. document it here
4. optionally expose `<variant>/action.yml`
5. add tests
6. rebuild `dist/`

That preserves both consumption styles:

- `monochange/actions@v0.4.0` with `name: <variant>`
- `monochange/actions/<variant>@v0.4.0`
