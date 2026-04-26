# monochange action variants plan

This document tracks the next monochange-specific action variants planned for `monochange/actions`.

## Why this plan exists

The current `monochange/actions` repository is **not** organized as a catalog of reusable workflow YAML files. It currently publishes:

- one root action from `action.yml`
- variant dispatch via the required `name` input
- optional path-based entrypoints such as `merge/action.yml`
- TypeScript implementations under `src/actions/<name>/`
- shared helpers under `src/shared/`

That means the next GitHub automation features should land as **new action variants**, not as a parallel library of top-level reusable workflows.

Consumers will still use these variants inside their own repository workflows, but the implementation work in this repo should follow the existing structure.

## Scope

This plan only covers these requested variants:

1. `setup-monochange`
2. `changeset-policy`
3. `release-pr`
4. `post-merge-release`
5. `publish-plan`

## Repository constraints

All work should respect the current repo shape:

- root action input dispatch remains the primary entrypoint
- each variant gets its own implementation under `src/actions/<name>/`
- shared logic belongs in `src/shared/`
- root `action.yml` must expose the superset of inputs and outputs needed by all variants
- each variant should also get a path-based wrapper directory at the repo root for discoverability, e.g. `setup-monochange/action.yml`
- docs must be updated in `README.md` and any variant-specific wrapper `README.md`

## Shared bootstrap model

### 1. Every variant resolves monochange first

Every variant must begin by resolving monochange availability before doing anything else.

This is now a **shared bootstrap behavior**, not a one-off precondition.

- `setup-monochange` exposes the bootstrap flow directly as its own variant
- every other variant must call the same shared bootstrap helper as its first meaningful operation
- no variant should assume `mc` already exists without first honoring the shared input described below

### 2. Shared `setup-monochange` input

Every variant should support a `setup-monochange` input.

Because GitHub Actions inputs are strings, this input should be parsed with the following semantics:

- `true` — default; automatically resolve monochange, using an existing install if available and installing or shimming it if not
- `false` — do not install; require monochange to already be available on `PATH` as `mc`
- any other non-empty string — treat the value as the monochange binary or command to use, for example `/opt/bin/mc` or `npx @monochange/cli`

Recommended behavior:

1. if `setup-monochange` is a string command/path, use that exact command as the source of truth
2. if `setup-monochange` is `false`, require `mc` to already exist
3. if `setup-monochange` is `true`, try existing `mc` first, then auto-setup monochange if missing

If the user supplies a custom string command and that command does not work, the action should fail clearly rather than silently falling back to another executable.

### 3. Shared bootstrap outputs

The shared bootstrap helper should make it easy for every variant to expose:

- resolved monochange command
- detected monochange version
- resolution mode or source, e.g. `existing-mc`, `npx-shim`, `cargo-binstall`, `custom-command`

### 4. Shared helpers to add

Expected shared helpers:

- `src/shared/monochange-cli.ts`
  - parse the `setup-monochange` input
  - resolve or install monochange
  - verify CLI availability
  - capture CLI version
  - return the resolved command for later subprocess calls
- `src/shared/exec.ts`
  - thin wrapper around `@actions/exec` for stdout and stderr capture
- `src/shared/json.ts`
  - optional helpers for parsing mixed text and JSON CLI output safely

## Planned variants

| Variant              | Implementation path               | Wrapper path          | Primary command(s)                                                 | Notes                                                                       |
| -------------------- | --------------------------------- | --------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `setup-monochange`   | `src/actions/setup-monochange/`   | `setup-monochange/`   | `mc --version`, `npx @monochange/cli`, `cargo binstall monochange` | Exposes the shared bootstrap flow directly and outputs the resolved command |
| `changeset-policy`   | `src/actions/changeset-policy/`   | `changeset-policy/`   | `mc affected --format json --verify ...`                           | Must resolve monochange first via the shared bootstrap input                |
| `release-pr`         | `src/actions/release-pr/`         | `release-pr/`         | `mc release-pr`                                                    | Must resolve monochange first via the shared bootstrap input                |
| `post-merge-release` | `src/actions/post-merge-release/` | `post-merge-release/` | `mc release-record`, `mc tag-release`, `mc publish-release`        | Must support merged release commits on non-`main` target branches           |
| `publish-plan`       | `src/actions/publish-plan/`       | `publish-plan/`       | `mc publish-plan`                                                  | Read-only planning plus CI-snippet output                                   |

## Delivery order

Recommended order:

1. `setup-monochange`
2. shared bootstrap helper extraction
3. `changeset-policy`
4. `release-pr`
5. `publish-plan`
6. `post-merge-release`

`post-merge-release` comes last because it depends most heavily on the shared command runner, release-record parsing, and documented assumptions around post-merge behavior.

## Variant notes

### `setup-monochange`

Goals:

- provide the reusable bootstrap implementation every other variant will call internally
- still work as a standalone action variant for workflows that want an explicit setup step
- prefer an `mc`-compatible wrapper around `npx @monochange/cli`
- default to latest, but allow version pinning
- fall back to `cargo binstall monochange`
- do not install ecosystem-specific toolchains or publishing dependencies

Likely behavior:

1. if `setup-monochange` is a custom string, validate and use it
2. else if an existing `mc` works, use it
3. else create an `mc` shim that shells out to `npx @monochange/cli[@version]`
4. else fall back to `cargo binstall monochange`

Preferred outputs:

- `command`
- `version`
- `source`

### `changeset-policy`

Goals:

- keep the action easy to consume from PR workflows
- make monochange bootstrap the first step
- avoid forcing consumers to wire a specific third-party changed-files action

Preferred inputs:

- `setup-monochange`
- `github-token`
- `changed-paths`
- `labels`
- `comment-on-failure`
- `skip-labels`

Preferred behavior:

- first resolve monochange through the shared bootstrap helper
- use explicit `changed-paths` and `labels` when provided
- otherwise detect PR files and labels from the GitHub API
- run `mc affected --format json --verify`
- expose raw JSON and a compact summary as outputs

### `release-pr`

Goals:

- wrap `mc release-pr` behind the standard action interface
- make monochange bootstrap the very first step
- expose machine-readable outputs for downstream workflows

Preferred inputs:

- `setup-monochange`
- `format`
- `dry-run`
- `github-token`
- `working-directory`

Preferred outputs:

- `result`
- `release-request-number`
- `release-request-url`
- `head-branch`
- `base-branch`
- `json`

### `post-merge-release`

Goals:

- detect whether `HEAD` resolves to a monochange release record
- distinguish a merged release commit from a release-PR-only commit
- tag and publish after merge
- support branches other than `main`
- update related issues through the configured monochange release command flow

Important implementation note:

This variant should **not** assume the merge target is literally `main`.
It should operate on the actual target branch or configured branch input and rely on release-record detection plus git reachability rather than a hardcoded branch name.

Preferred behavior:

1. resolve monochange through the shared bootstrap helper
2. inspect `mc release-record --from <ref> --format json`
3. detect whether the release commit is reachable from the target branch
4. skip cleanly when the commit is still only on the release PR branch
5. run `mc tag-release --from <ref>`
6. run `mc publish-release` so provider release publication and related issue comments stay in monochange’s configured flow

### `publish-plan`

Goals:

- provide a thin but ergonomic wrapper around `mc publish-plan`
- keep it read-only
- make its outputs easy to feed into GitHub Actions matrices and summaries

Preferred inputs:

- `setup-monochange`
- `format`
- `mode`
- `ci`
- repeated `package` filters

Preferred outputs:

- `result`
- `json`
- `summary`
- `ci-snippet`
- `fits-single-window`

## Cross-cutting implementation checklist

Every variant issue should include:

- root `action.yml` updates
- `src/main.ts` dispatch updates
- variant implementation in `src/actions/<name>/index.ts`
- path-based wrapper `action.yml`
- wrapper `README.md`
- tests for input parsing and core behavior
- README updates

## Tracking issues

- [#1 Add `setup-monochange` action variant](https://github.com/monochange/actions/issues/1)
- [#2 Add `changeset-policy` action variant](https://github.com/monochange/actions/issues/2)
- [#3 Add `release-pr` action variant](https://github.com/monochange/actions/issues/3)
- [#4 Add `publish-plan` action variant](https://github.com/monochange/actions/issues/4)
- [#5 Add `post-merge-release` action variant](https://github.com/monochange/actions/issues/5)
