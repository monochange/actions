# AGENTS

`monochange/actions` is the GitHub Actions repository for monochange.

## Repository goals

- Keep this repository focused on reusable GitHub Actions for monochange workflows.
- Use **pnpm** as the package manager.
- Use **Node 24** as the runtime baseline for local development, CI, and published actions.
- Use **TypeScript** for action implementation.
- Use **Vite+** as the default local toolchain for checking, testing, and packaging.

## Action layout

- Publish a single root action from `action.yml`.
- Dispatch action variants via the required `name` input.
- Keep each variant implementation in its own source subdirectory under `src/actions/<name>/`.
- Shared helpers should live under `src/shared/`.
- The first supported variant is `merge`.

## Build and release expectations

- Build the published action bundle into `dist/`.
- Prefer small, reviewable modules over large all-in-one files.
- Keep docs and examples updated when inputs or outputs change.
- When adding a new action variant, update `README.md`, `action.yml`, tests, and any variant-specific docs together.
- The published action consumes a released `@monochange/cli`, so bump the `@monochange/cli`
  devDependency when a new CLI release adds behavior this repository needs. The version is
  pinned exactly so CI and the release workflows resolve a reproducible CLI.

## Releases

Releases are managed by monochange itself. The repository is a single
tag-versioned package (`type = "github_actions"`): there is no registry
publish, so a release is the git tag plus the GitHub release body.

- `.github/workflows/release.yml` refreshes the release pull request on every push to `main`.
- `.github/workflows/release-publish.yml` tags the merged release commit, moves the floating
  aliases, and creates the GitHub release.
- `.github/workflows/changeset-policy.yml` requires a changeset for behavior changes.

Author a changeset whenever a pull request changes action behavior:

```bash
pnpm exec monochange run change --package actions --bump patch --reason "describe the change"
```

- Anything under `src/` or any `action.yml` needs a changeset.
- Documentation, tests (`**/*.test.ts`), generated output (`dist/`, `coverage/`, `docs/`), and
  release plumbing (`.github/`, `monochange.toml`, lockfiles) do not.
- The `release` and `no-changeset-required` labels skip the check. Add
  `no-changeset-required` only when a maintainer has decided the change needs no release note.
- Run `pnpm exec monochange step validate` and
  `pnpm exec monochange step prepare-release --dry-run --format json` to preview the next version.

## Naming

- Always write `monochange` in lowercase.
- Action variant names should stay short and explicit, e.g. `merge`.
