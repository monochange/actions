# Changelog

All notable changes to this project will be documented in this file.

This changelog is managed by [monochange](https://github.com/monochange/monochange).

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
