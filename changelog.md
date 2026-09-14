# Changelog

All notable changes to this project will be documented in this file.

This changelog is managed by [monochange](https://github.com/monochange/monochange).

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
