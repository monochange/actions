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

## Naming

- Always write `monochange` in lowercase.
- Action variant names should stay short and explicit, e.g. `merge`.
