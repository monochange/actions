# monochange actions

GitHub Actions for monochange release automation.

This repository exists so monochange can own the critical parts of its workflow instead of depending directly on third-party actions, while still preserving the behavior that matters for release pull requests.

## What is in this repository?

Currently implemented variants:

| Variant                                     | Purpose                                                             | Path entrypoint                            |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| [`merge`](#merge)                           | Fast-forward a monochange release pull request onto its base branch | `monochange/actions/merge@v0`              |
| [`setup-monochange`](#setup-monochange)     | Resolve or install the monochange CLI                               | `monochange/actions/setup-monochange@v0`   |
| [`changeset-policy`](#changeset-policy)     | Run `mc affected` to verify changeset policy                        | `monochange/actions/changeset-policy@v0`   |
| [`release-pr`](#release-pr)                 | Create or update the release pull request                           | `monochange/actions/release-pr@v0`         |
| [`publish-plan`](#publish-plan)             | Generate a publish plan from monochange                             | `monochange/actions/publish-plan@v0`       |
| [`post-merge-release`](#post-merge-release) | Tag and publish after a release PR merges                           | `monochange/actions/post-merge-release@v0` |

All variants are also available through the root action with the `name` input:

```yaml
uses: monochange/actions@v0
with:
  name: merge
```

---

## Shared inputs

Every variant supports these common inputs:

| Input              | Required | Default   | Description                                                                                                                  |
| ------------------ | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `setup-monochange` | no       | `'true'`  | How to resolve monochange: `true` = auto-resolve, `false` = require existing `mc` on PATH, any other string = custom command |
| `dry-run`          | no       | `'false'` | Validate everything without side effects                                                                                     |
| `debug`            | no       | `'false'` | Emit extra debug logging                                                                                                     |

The `setup-monochange` bootstrap is the first meaningful operation of every variant except `merge` (which does not need monochange).

---

## `merge`

The `merge` action is intentionally modeled after [`sequoia-pgp/fast-forward`](https://github.com/sequoia-pgp/fast-forward): it performs a **fast-forward-only** update of the base branch so the release commit lands unchanged.

That means it does **not** create a merge commit.

### Why monochange needs this

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
- support slash-command style approval flows such as `/fast-forward`
- keep the merge policy inside your own GitHub Actions repository

### How the `merge` action works

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

—but only after the action has verified that this is a legal fast-forward update.

**Important consequence:** If the release branch has diverged from the base branch, the action fails. It will not create a merge commit and it will not force-push around divergence. That is intentional.

### Quick start

```yaml
- name: fast-forward release PR
  uses: monochange/actions/merge@v0
  with:
    github-token: ${{ secrets.RELEASE_PR_MERGE_TOKEN }}
```

### Inputs

| Input                           | Required | Default                           | Description                                         |
| ------------------------------- | -------- | --------------------------------- | --------------------------------------------------- |
| `github-token`                  | no       | `${{ github.token }}`             | Token for GitHub API and the final git push         |
| `repository`                    | no       | `${{ github.repository }}`        | Target repository in `owner/repo` format            |
| `pull-request`                  | no       | —                                 | Explicit PR number, must be a positive integer      |
| `base-branch`                   | no       | `main`                            | Expected base branch for the release PR             |
| `head-branch-prefix`            | no       | `monochange/release/`             | Required prefix for the release PR head branch      |
| `required-failing-check`        | no       | `release-pr-manual-merge-blocker` | Name of the intentionally failing blocker check     |
| `allow-cross-repository`        | no       | `'false'`                         | Whether PRs from forks are allowed                  |
| `require-green-checks`          | no       | `'true'`                          | Whether all checks must pass except the blocker     |
| `require-actor-push-permission` | no       | `'true'`                          | Whether the triggering actor needs push access      |
| `comment`                       | no       | `on-error`                        | Post a PR comment: `always`, `never`, or `on-error` |
| `dry-run`                       | no       | `'false'`                         | Validate without updating the base branch           |
| `debug`                         | no       | `'false'`                         | Emit extra debug logging                            |

### Outputs

| Output                | Description                                     |
| --------------------- | ----------------------------------------------- |
| `result`              | `fast-forwarded`, `dry-run`, or `failed`        |
| `merged`              | `'true'` when a fast-forward was performed      |
| `pull-request-number` | Resolved PR number                              |
| `pull-request-url`    | Resolved PR URL                                 |
| `base-sha`            | Base branch SHA before push                     |
| `head-sha`            | Head SHA used for validation                    |
| `fast-forward-sha`    | SHA pushed to the base branch                   |
| `comment`             | JSON with a `body` field containing the summary |

### Ready-to-copy workflow

See [`.github/workflows/release-pr-merge.yml`](.github/workflows/release-pr-merge.yml) for a complete example that supports both `workflow_dispatch` and `/fast-forward` comment triggers.

---

## `setup-monochange`

Resolve or install the monochange CLI and expose its resolved command, version, and source.

This variant also powers the shared bootstrap used by every other monochange-dependent variant, so it is useful both as a standalone setup step and as the internal mechanism other actions rely on.

### Quick start

```yaml
- name: setup monochange
  uses: monochange/actions/setup-monochange@v0
```

### Inputs

| Input              | Required | Default   | Description                                                                       |
| ------------------ | -------- | --------- | --------------------------------------------------------------------------------- |
| `setup-monochange` | no       | `'true'`  | `true` = auto-resolve, `false` = require existing, custom string = use as command |
| `debug`            | no       | `'false'` | Enable extra debug logging                                                        |

### Outputs

| Output    | Description                                                                      |
| --------- | -------------------------------------------------------------------------------- |
| `command` | Resolved monochange command                                                      |
| `version` | Resolved monochange version string                                               |
| `source`  | Resolution source: `existing-mc`, `npx-shim`, `cargo-binstall`, `custom-command` |
| `result`  | `success` or `failed`                                                            |

---

## `changeset-policy`

Run `mc affected --format json --verify` to check changeset policy for the current pull request.

This is the action variant that answers the question: **"does this PR satisfy monochange's changeset requirements?"**

### Quick start

```yaml
- name: check changeset policy
  uses: monochange/actions/changeset-policy@v0
  with:
    setup-monochange: 'true'
```

### Inputs

| Input                | Required | Default               | Description                                   |
| -------------------- | -------- | --------------------- | --------------------------------------------- |
| `setup-monochange`   | no       | `'true'`              | How to resolve monochange                     |
| `github-token`       | no       | `${{ github.token }}` | Token for PR inspection                       |
| `changed-paths`      | no       | —                     | Comma-separated changed paths                 |
| `labels`             | no       | —                     | Comma-separated labels to consider            |
| `skip-labels`        | no       | —                     | Comma-separated labels that skip requirements |
| `comment-on-failure` | no       | `'false'`             | Post a PR comment on failure                  |
| `dry-run`            | no       | `'false'`             | Validate without side effects                 |
| `debug`              | no       | `'false'`             | Enable extra debug logging                    |

### Outputs

| Output    | Description                       |
| --------- | --------------------------------- |
| `result`  | `success`, `dry-run`, or `failed` |
| `json`    | Raw JSON from `mc affected`       |
| `summary` | Text summary of affected packages |

---

## `release-pr`

Create or update the release pull request using `mc release-pr`.

This action produces a machine-readable release PR and exposes its metadata as outputs for downstream workflows.

### Quick start

```yaml
- name: create release PR
  uses: monochange/actions/release-pr@v0
  with:
    setup-monochange: 'true'
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Inputs

| Input               | Required | Default   | Description                  |
| ------------------- | -------- | --------- | ---------------------------- |
| `setup-monochange`  | no       | `'true'`  | How to resolve monochange    |
| `format`            | no       | `json`    | Output format                |
| `dry-run`           | no       | `'false'` | Show without creating        |
| `github-token`      | no       | —         | GitHub token for PR creation |
| `working-directory` | no       | `.`       | Working directory            |
| `debug`             | no       | `'false'` | Enable extra debug logging   |

### Outputs

| Output                   | Description                       |
| ------------------------ | --------------------------------- |
| `result`                 | `success`, `dry-run`, or `failed` |
| `head-branch`            | Release PR head branch            |
| `base-branch`            | Release PR base branch            |
| `release-request-number` | PR number                         |
| `release-request-url`    | PR URL                            |
| `json`                   | Full JSON metadata                |

---

## `publish-plan`

Run `mc publish-plan` and expose the plan as JSON, summary, and CI outputs.

This variant is **read-only**: it never changes anything in the repository. It is safe to run on every push or PR.

### Quick start

```yaml
- name: generate publish plan
  uses: monochange/actions/publish-plan@v0
  with:
    setup-monochange: 'true'
    mode: full
```

### Inputs

| Input              | Required | Default   | Description                          |
| ------------------ | -------- | --------- | ------------------------------------ |
| `setup-monochange` | no       | `'true'`  | How to resolve monochange            |
| `format`           | no       | `json`    | Output format                        |
| `mode`             | no       | `full`    | Plan mode: `full` or `single-window` |
| `ci`               | no       | —         | CI provider for snippet generation   |
| `package`          | no       | —         | Comma-separated package filters      |
| `debug`            | no       | `'false'` | Enable extra debug logging           |

### Outputs

| Output               | Description                           |
| -------------------- | ------------------------------------- |
| `result`             | `success` or `failed`                 |
| `json`               | Full JSON publish plan                |
| `summary`            | Text summary                          |
| `fits-single-window` | Whether the plan fits a single window |

---

## `post-merge-release`

After a release PR merges, detect the release record, create tags, and publish packages.

This variant intentionally does **not** hardcode `main` as the target branch. It operates on the actual target branch or configured branch input, relying on release-record detection and git reachability.

### Quick start

```yaml
- name: post-merge release
  uses: monochange/actions/post-merge-release@v0
  with:
    setup-monochange: 'true'
```

### Inputs

| Input              | Required | Default   | Description                              |
| ------------------ | -------- | --------- | ---------------------------------------- |
| `setup-monochange` | no       | `'true'`  | How to resolve monochange                |
| `ref`              | no       | `HEAD`    | Git ref to inspect for a release record  |
| `target-branch`    | no       | —         | Target branch the release PR merged into |
| `dry-run`          | no       | `'false'` | Show without tagging or publishing       |
| `debug`            | no       | `'false'` | Enable extra debug logging               |

### Outputs

| Output      | Description                                  |
| ----------- | -------------------------------------------- |
| `result`    | `success`, `skipped`, `dry-run`, or `failed` |
| `tagged`    | Whether tags were created                    |
| `published` | Whether packages were published              |
| `json`      | Release record JSON                          |

### Behavior

1. Resolves monochange through the shared bootstrap helper
2. Inspects `mc release-record --from <ref> --format json`
3. Detects whether the release commit is reachable from the target branch
4. Skips cleanly when the commit is still only on the release PR branch
5. Runs `mc tag-release --from <ref>`
6. Runs `mc publish-release`

The `publish-release` step is allowed to fail without failing the whole action, because publication may fail for network or registry reasons while tagging succeeded.

---

## Development

### Tooling

- package manager: `pnpm`
- runtime baseline: Node 24
- implementation language: TypeScript
- build/test toolchain: Vite+

### Install dependencies

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

| Command                   | Purpose                        |
| ------------------------- | ------------------------------ |
| `pnpm fmt`                | format files                   |
| `pnpm check`              | format, lint, and typecheck    |
| `pnpm test`               | run tests                      |
| `pnpm test -- --coverage` | run tests with coverage report |
| `pnpm build`              | build `dist/index.mjs`         |
| `pnpm all`                | run check, test, and build     |

### Test coverage

The repository enforces a minimum coverage threshold of **50%** across statements, branches, functions, and lines. Current coverage is well above this threshold.

### Verify `dist/` before committing

After `pnpm build`, make sure `dist/` is committed:

```bash
git add dist/
```

The CI workflow checks that `dist/` matches a fresh build and fails if it is stale.

---

## Publishing notes

This repository is meant to publish the compiled `dist/` bundle alongside the source.

When releasing:

1. run `pnpm build`
2. commit the updated `dist/`
3. tag a release such as `v0.2.0`
4. update the moving `v0` tag to point to the same commit
5. reference the action by tag downstream

There are two consumption styles:

- root entrypoint with variant dispatch:

  ```yaml
  uses: monochange/actions@v0
  with:
    name: merge
  ```

- path-based entrypoint:

  ```yaml
  uses: monochange/actions/merge@v0
  ```

---

## Adding more variants

To add a new variant later:

1. add `src/actions/<variant>/` with `index.ts` and `index.test.ts`
2. dispatch from `src/main.ts`
3. optionally expose `<variant>/action.yml` and `<variant>/README.md`
4. add tests
5. rebuild `dist/`

That preserves both consumption styles:

- `monochange/actions@v0` with `name: <variant>`
- `monochange/actions/<variant>@v0`
