# `monochange/actions/ci`

Run the [`monochange ci`](https://monochange.github.io/monochange/guide/configuration/#ci-gatekeeper) gatekeeper from GitHub Actions. The action is a thin wrapper: job rules live in your `monochange.toml` under `[ci.jobs.*]`, and the CLI owns git diffing, provider calls, memory, learned rules, and verification.

One `mode: decide` call evaluates every configured job, so a single gate job can drive any number of downstream jobs.

> [!IMPORTANT]
> The pinned monochange CLI must include `monochange ci`. That command was released after [monochange#867](https://github.com/monochange/monochange/pull/867). Re-pin the action after upgrading to a CLI release that contains it.

## Modes

| Mode     | What it does                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| `decide` | Default. Runs `monochange ci decide --format github-outputs --on-error <on-error>` and republishes its outputs.    |
| `verify` | Calls `monochange ci verify` for every gated workflow job in `needs`, recording the outcome in CI memory.          |
| `check`  | Runs `monochange ci check --workflow <path>` to validate `[ci]` configuration and workflow `decisions` references. |

## Configure jobs in `monochange.toml`

The workflow job id is the `[ci.jobs.<id>]` id. Use lowercase kebab-case.

```toml
[ci]
provider = "graph" # graph | opencode-go | openrouter | cloudflare | jev | openai-compatible
model = "deepseek-v4.1"
ai_can_skip = false
max_skips_on_main = 5
unconditional_events = ["schedule", "workflow_dispatch"]
unconditional_branches = ["release/*", "monochange/release/*", "refs/tags/v*"]
unconditional_paths = ["Cargo.lock", "rust-toolchain.toml", ".github/workflows/**"]
ignore_paths = ["**/*.md"]

[ci.jobs.test-windows]
packages = ["app"] # root packages the job builds; globs are allowed
paths = ["crates/windows/**"] # extra non-package inputs
always = false

[ci.jobs.docs]
paths = ["docs/**"]
```

See the [configuration guide](https://monochange.github.io/monochange/guide/configuration/#ci-gatekeeper) for the full rule semantics, including dependency propagation, learned rules, and unowned changes.

## Complete workflow

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      decisions: ${{ steps.decide.outputs.decisions }}
      run-all: ${{ steps.decide.outputs.run-all }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Restore CI memory
        uses: actions/cache/restore@v4
        with:
          path: .monochange/ci-memory.json
          key: monochange-ci-memory-${{ github.run_id }}
          restore-keys: monochange-ci-memory-
      - name: Decide which jobs run
        id: decide
        uses: monochange/actions/ci@v0
        with:
          mode: decide
          provider: opencode-go
          api-key: ${{ secrets.OPENCODE_GO_API_KEY }}
          on-error: run-all
          auth-token: ${{ secrets.MONOCHANGE_CI_TOKEN }}
          require-auth: 'false'

  test-windows:
    needs: gate
    if: needs.gate.outputs.run-all == 'true' || fromJSON(needs.gate.outputs.decisions)['test-windows']
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo test -p app

  docs:
    needs: gate
    if: needs.gate.outputs.run-all == 'true' || fromJSON(needs.gate.outputs.decisions)['docs']
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm docs:build

  ci-config:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check CI wiring
        uses: monochange/actions/ci@v0
        with:
          mode: check
          workflow: .github/workflows/ci.yml

  ci-verify:
    if: >-
      always()
      && github.event_name == 'push'
      && github.ref == 'refs/heads/main'
      && needs.gate.result == 'success'
    needs: [gate, test-windows, docs]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Restore CI memory
        uses: actions/cache/restore@v4
        with:
          path: .monochange/ci-memory.json
          key: monochange-ci-memory-${{ github.run_id }}
          restore-keys: monochange-ci-memory-
      - name: Verify gated jobs
        uses: monochange/actions/ci@v0
        with:
          mode: verify
          needs: ${{ toJSON(needs) }}
          decisions: ${{ needs.gate.outputs.decisions }}
          auth-token: ${{ secrets.MONOCHANGE_CI_TOKEN }}
      - name: Save CI memory
        if: always()
        uses: actions/cache/save@v4
        with:
          path: .monochange/ci-memory.json
          key: monochange-ci-memory-${{ github.run_id }}
```

Notes:

- `fetch-depth: 0` gives the gate the history it needs to diff `HEAD^1` or `github.event.before` against `HEAD`.
- The memory cache key is unique per run so `actions/cache/save` can always write, while `restore-keys` picks up the newest snapshot from earlier runs. Only the `push` verification job saves, so PRs read memory without mutating it.
- The workflow job ids (`test-windows`, `docs`) must match the `[ci.jobs.*]` ids. The gate job itself uses a different id so `verify` ignores it.
- `ci check` validates that every configured job is referenced by a scanned workflow and that every referenced id is configured. Pass each workflow that contains gated jobs.

## Gate downstream jobs

`decide` outputs:

- `decisions`: JSON object mapping every evaluated job id to `true` or `false`, passed through verbatim from the CLI.
- `affected-packages`: JSON array of affected package ids.
- `run-all`: `true` when every job runs.

Gate a job with:

```yaml
if: needs.gate.outputs.run-all == 'true' || fromJSON(needs.gate.outputs.decisions)['test-windows']
```

Do not rely on `decisions['test-windows']` alone when `on-error: run-all` is set. If the CLI cannot run at all (spawn failure or unparsable output), the action fails open with `run-all=true` and `decisions={}` so the gate still runs every job. GitHub treats a skipped required check as passing, so the `run-all` clause is what keeps a broken gate from silently skipping tests.

With `on-error: fail`, a decide failure fails the gate step instead.

## Diff defaults

`decide` derives its base ref from the GitHub context unless you set `base`:

- `pull_request`: `HEAD^1`. The default `actions/checkout` checks out GitHub's merge commit, whose first parent is the base.
- `push`: `github.event.before`, unless it is the all-zero deletion marker.
- Everything else: `origin/<default branch>`.

`head` defaults to `HEAD`. Set `base`/`head` explicitly to compare other refs.

## Verify semantics

`verify` takes the gate's `decisions` output and the workflow's `needs` map:

```yaml
with:
  mode: verify
  needs: ${{ toJSON(needs) }}
  decisions: ${{ needs.gate.outputs.decisions }}
```

For every `needs` entry whose id appears in `decisions`, it calls:

```text
monochange ci verify --job <id> --conclusion <success|failure|skipped> --commit <sha> --branch <branch> --prior-decision <y|n>
```

`cancelled` jobs and job ids the gate did not evaluate are skipped. Run verification on `push` to the default branch with `always()` (plus a successful gate) so failures and skips are recorded, then save `.monochange/ci-memory.json` with `actions/cache/save`.

## Authentication and provider overrides

`provider`, `model`, `api-key`, `api-url`, and `cloudflare-account-id` are passed only when set; otherwise the CLI reads `[ci]` from `monochange.toml`. `api-key` and `auth-token` are masked with `core.setSecret` and never logged.

`auth-token` maps to the CLI's `--token` flag for repository-scoped CI history. `require-auth` adds `--require-auth` and defaults to `false`. Create a token once with `monochange ci auth init` and store it as a repository secret.

`setup-monochange` behaves like the other monochange actions: `true` auto-resolves the CLI, `false` requires `monochange` on `PATH`, and any other string is a custom command. `working-directory` defaults to `.` and must contain `monochange.toml`.
