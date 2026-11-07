---
actions: major
---

# Replace the `ci` action engine with the `monochange ci` CLI

The `ci` action is now a thin wrapper. Job rules live in the consumer's `monochange.toml` under `[ci.jobs.*]`, and the CLI owns git diffing, provider calls, memory, learned rules, and verification.

This breaks the published `ci` contract:

- `mode` accepts `decide` (default), `verify`, or `check`. The old `analytics` and `auth` modes are now `monochange ci analytics` and `monochange ci auth` in the CLI.
- `decide` evaluates every configured job in one call and replaces the per-invocation `job`, `paths`, `packages`, `unconditional*`, `max-skips-on-main`, `max-duration-minutes`, `duration-minutes`, `memory-path`, `suggestion`, and `verdict-class` inputs with `[ci]` configuration.
- `decide` outputs `decisions` (JSON object of job id to boolean), `affected-packages` (JSON array), and `run-all` instead of `decision`, `should-run`, `unconditional`, `reason`, and the analytics counters.
- `verify` takes `needs` (`${{ toJSON(needs) }}`) and the gate's `decisions` output, then records each job outcome through the CLI. `check` takes `workflow` paths and validates the `[ci]` wiring.
- Workflows gate jobs with `if: needs.gate.outputs.run-all == 'true' || fromJSON(needs.gate.outputs.decisions)['<job-id>']`.

The pinned monochange CLI is intentionally unchanged in this change. A release that includes `monochange ci` (after monochange#867) must land before consumers can use this action release; re-pin the action SHA afterwards.
