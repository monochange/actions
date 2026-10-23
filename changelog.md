# Changelog

All notable changes to this project will be documented in this file.

This changelog is managed by [monochange](https://github.com/monochange/monochange).

## [0.11.0](https://github.com/monochange/actions/releases/tag/v0.11.0) (2026-10-23)

### 💥 Breaking Change

#### Track the monochange 0.21.0 CLI release

_Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #102](https://github.com/monochange/actions/pull/102)

The actions development and release tooling now resolves monochange 0.21.0, including Swift, CocoaPods and Gradle configuration support. This follows the breaking CLI release baseline. After the next maintainer-controlled actions release, pin its immutable commit SHA to adopt that CLI baseline; the existing action inputs remain supported.

## [0.10.1](https://github.com/monochange/actions/releases/tag/v0.10.1) (2026-10-21)

### 🚀 Feature

#### Create release commits and pull requests through monochange.dev

_Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #88](https://github.com/monochange/actions/pull/88)

The new `hosted-release` variant prepares the release in the workflow, then lets monochange.dev create the release commit and the release pull request through the monochange GitHub App. The commit is verified by GitHub, the pull request triggers the repository's normal workflows, and the job needs no personal access token.

```yaml
jobs:
  release-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: read
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          fetch-tags: true
      - id: release
        uses: monochange/actions/hosted-release@v0
        with:
          release-command: release
```

- `release-command` runs the repository's own `monochange.toml` command with `MONOCHANGE_RELEASE_BACKEND=hosted`, so its `Command` steps and `stage_all` run as they do locally. It requires monochange 0.20.0 or newer. Without it, the action runs the built-in prepare, commit, and open release steps.
- `github-token` is passed to monochange as `GITHUB_TOKEN`. With `contents: write`, monochange 0.20.0 or newer uploads the release files as a git tree, so monochange.dev receives only the tree id.

- Install the monochange GitHub App on the repository and grant `id-token: write`; the action fails early with that instruction when the job cannot mint an OIDC token.
- Requires monochange 0.17.0 or newer. The action drives the CLI's hosted `CommitRelease` and `OpenReleaseRequest` backends instead of calling the endpoints itself.
- `hosted-url` (default `https://monochange.dev`) selects the deployment; the OIDC audience is its host.
- Outputs `commit-sha`, `verified`, `head-branch`, `base-branch`, `pull-request-number`, and `pull-request-url`, read back from GitHub. The step fails when GitHub does not verify the release commit.
- Failed hosted requests keep the CLI error and add the next step to take, such as installing the app (HTTP 404), clearing a release branch that moved (HTTP 409), or keeping workflow changes out of the release (HTTP 422).

### 📝 Changed

#### Keep change-classification comments specific to the pull request

_Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #75](https://github.com/monochange/actions/pull/75)

The `change-classification` action now compares a pull request with the branch it targets and classifies the pull request head commit, so a stacked pull request no longer reports the changes of the branch below it.

- `base` defaults to `origin/<base branch>` from the `pull_request` event, and `head` defaults to the event's head commit. Each is used only when the checkout contains it; otherwise the action warns and keeps the previous behavior. Explicit inputs still win.
- The comment names the classified head commit and base commit.
- Findings seen only between the latest release and the base branch move to an "Unreleased changes already on `<base>` (not part of this pull request)" list and no longer count toward the package's findings.

Add the `edited` event, guarded by `github.event.changes.base`, so a retargeted pull request is classified again:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
jobs:
  classify:
    if: ${{ github.event.action != 'edited' || github.event.changes.base }}
```

## [0.10.0](https://github.com/monochange/actions/releases/tag/v0.10.0) (2026-09-29)

### 💥 Breaking Change

#### Track the monochange CLI 0.15.0 release

_Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #73](https://github.com/monochange/actions/pull/73) · _Related issues:_ [#71](https://github.com/monochange/actions/issues/71)

Bump the pinned `@monochange/cli` devDependency from 0.14.0 to 0.15.0. The action bundle is versioned independently of the CLI, so consumers that pin an action SHA can be running against a CLI whose interface moved underneath them; this release moves the action's major version in step with the CLI's.

monochange 0.15.0 is a breaking CLI release. `monochange skill` no longer forwards arguments to `npx`, `pnpm dlx`, or `bunx`, and `MONOCHANGE_SKILL_SOURCE` and `MONOCHANGE_SKILL_RUNNER` are removed in favor of `monochange skill read <topic>` and `monochange skill install --dir <dir>`. The change-classification report contract also advanced to `schema_version` `0.3`, adding `decision.pull_request_changes`.

From this release on, a breaking change in monochange produces a breaking change in `monochange/actions`, so downstream pins move major versions together.

Verified locally: the pinned CLI reports 0.15.0, `monochange next` and `step validate` run against this repository's configuration, and the full `pnpm all` suite passes. The committed `dist/` bundle is unchanged because the CLI is a development dependency.

### 🐛 Fixed

- **Track the latest monochange CLI release.** Bump the pinned `@monochange/cli` devDependency from 0.13.0 to 0.14.0. The repository's release automation runs `pnpm exec monochange`, so the pin decides which CLI refreshes the release pull request and validates changesets; this keeps it on the current published release. The committed `dist/` bundle is unchanged because the CLI is a development dependency.
  _Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #71](https://github.com/monochange/actions/pull/71)

## [0.9.4](https://github.com/monochange/actions/releases/tag/v0.9.4) (2026-09-17)

### 🚀 Feature

#### Show whether a breaking change applies to main or the latest release

The change-classification action reads the new `release_impact` decision field and shows it next to the default-branch impact. A package that breaks only against `main` (its latest release never shipped the changed API) renders as `breaking → additive (release)` in the comment table, gets an informational callout naming the package, and appears in the job summary line. The new `release-breaking` output is `true` only when a package breaks against its latest release, so workflow routing can block those pulls without blocking refinements of unreleased APIs.

Reports from monochange versions without `release_impact` render exactly as before.

```yaml
- id: classify
  uses: monochange/actions/change-classification@v0

- run: |
    if [[ "${{ steps.classify.outputs.release-breaking }}" == "true" ]]; then
      echo "A released API broke; a major changeset is required."
    fi
```

_Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #70](https://github.com/monochange/actions/pull/70)

#### Skip classification on release pull requests and pass labels

The change-classification action reads the pull request's labels (or the new `labels` input) and passes them to `monochange change classify` via `--label`. Configure `[changesets.classification].skip_labels` in `monochange.toml` (default `["release"]`) so the release pull request monochange opens is reported as skipped instead of classified: the command analyzes no packages, the action sets `result: skipped`, deletes any stale classification comment, and the job summary records the skip.

The parser also accepts the classification report's new contract: snake_case keys with `schema_version` as a `major.minor` string emitted by `monochange_classification`.

```yaml
- uses: monochange/actions/change-classification@v0
  with:
    labels: release, automated
```

_Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #68](https://github.com/monochange/actions/pull/68)

## [0.9.3](https://github.com/monochange/actions/releases/tag/v0.9.3) (2026-09-14)

### 🚀 Feature

#### Release the action bundle with monochange

The repository now manages its own releases with monochange instead of hand-cut tags and releases. Every push to `main` refreshes a release pull request that bumps the tag-versioned package, and merging it creates the version tag, moves the `v0.9` and `v0` floating aliases, and publishes the GitHub release with generated notes.

Consumers keep pinning the same moving aliases:

```yaml
- uses: monochange/actions@v0.9
```

A new `changeset-policy` check requires a `.changeset/*.md` entry when a pull request changes action behavior (TypeScript under `src/` or any `action.yml`). Documentation, tests, and generated output are exempt, and the `release` and `no-changeset-required` labels skip the check.

**Before:** releases were cut by hand, so changes under `src/` shipped with no required release note.

**After:**

```bash
# author a changeset with the CLI instead of writing frontmatter by hand
pnpm exec monochange run change --package actions --bump patch --reason "describe the fix"
```

The release pull request lists the planned version and consumes the pending changesets when it merges.

_Owner:_ [@ifiokjr](https://github.com/ifiokjr) · _Review:_ [PR #63](https://github.com/monochange/actions/pull/63)
