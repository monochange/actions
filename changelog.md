# Changelog

All notable changes to this project will be documented in this file.

This changelog is managed by [monochange](https://github.com/monochange/monochange).

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
