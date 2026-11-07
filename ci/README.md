# `monochange/actions/ci`

Decide whether a CI job should run (`y` / `n`) on a pull request or conditional `main` push, and verify whether prior decisions were accurate when the job runs on `main`.

## Recommended provider: OpenCode Go (`opencode-go`)

`monochange/actions/ci` defaults to `provider: opencode-go` with `model: deepseek-v4.1` because OpenCode Go provides low, predictable pricing and single-token authentication (`OPENCODE_GO_API_KEY`).

It also supports:

- `openrouter` (`https://openrouter.ai/api/v1/chat/completions`)
- `cloudflare` (Cloudflare Workers AI / AI Gateway)
- `jev` (any lightweight HTTP decision endpoint that accepts context JSON and returns `y` or `n`)
- `openai-compatible` (self-hosted open-source models via Ollama, vLLM, or llama.cpp)
- `graph` (deterministic path + package + learned memory fallback when no token is provided)

## Modes

- `decide` (default): evaluates whether the job should run and returns `y` / `n`.
- `verify`: records the observed `success`, `failure`, or `skipped` outcome on `main`, classifies the prior decision, and learns a hard rule from false negatives.
- `analytics`: reports repo-scoped gatekeeper accuracy, false negatives, false positives, and minutes saved. Always requires repo authentication.
- `auth`: creates or validates `.monochange/ci-auth.json` and emits a repo-scoped `auth-token`.

## Repo-scoped authentication

History, lessons, and analytics are scoped to one canonical repository id. The id comes from `repo-id`, then `GITHUB_REPOSITORY`, then a normalized `git config --get remote.origin.url`.

Run `mode: auth` once to create `.monochange/ci-auth.json` with a local HMAC secret and token:

```yaml
- id: ci-auth
  uses: monochange/actions/ci@v0
  with:
    mode: auth
    repo-id: ${{ github.repository }}
- run: echo "::add-mask::${{ steps.ci-auth.outputs.auth-token }}"
```

Then pass `auth-token: ${{ secrets.MONOCHANGE_CI_TOKEN }}` (or set `MONOCHANGE_CI_TOKEN`) to `decide`, `verify`, or `analytics`. A token is bound to its repository id and is rejected when the signature or repository does not match. `analytics` fails closed: `Unauthorized: repo-scoped authentication failed for <repoId>. Only the authenticated local repository can access CI history and analytics.`

`require-auth` defaults to `true` in `analytics` mode and to `false` elsewhere unless a token or `.monochange/ci-auth.json` is present.

## Accuracy outputs

`verify`, `decide`, `analytics`, and `auth` expose cumulative counts from the ledger:

- `false-negatives`: runs that were skipped (`n`) but failed on `main`.
- `false-positives`: runs that ran (`y`) despite no matching job paths/packages and passed.
- `true-negatives`: runs that were skipped (`n`) and verified green on `main`.
- `true-positives`: runs that ran (`y`) and caught a failure or verified affected code.
- `analytics`: JSON object with the full repo analytics, including accuracy, per-job metrics, and saved minutes.

## Example: Conditional job on PRs and `main` with unconditional overrides

```yaml
jobs:
  gate-ios:
    runs-on: ubuntu-latest
    outputs:
      decision: ${{ steps.ci.outputs.decision }}
      should-run: ${{ steps.ci.outputs.should-run }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: ci
        uses: monochange/actions/ci@v0
        with:
          mode: decide
          job: ios-widgets
          paths: crates/leptoskit_ios/,crates/leptoskit_native/
          packages: leptoskit_ios,leptoskit_native
          provider: opencode-go
          api-key: ${{ secrets.OPENCODE_GO_API_KEY }}
          model: deepseek-v4.1
          max-skips-on-main: '5'
          unconditional-branches: 'monochange/release/*,release/*'

  ios-widgets:
    needs: gate-ios
    if: needs.gate-ios.outputs.decision == 'y'
    runs-on: macos-latest
    steps:
      - run: echo "Running iOS suite"

  verify-ios:
    needs: [gate-ios, ios-widgets]
    if: always() && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - uses: monochange/actions/ci@v0
        with:
          mode: verify
          job: ios-widgets
          prior-decision: ${{ needs.gate-ios.outputs.decision }}
          outcome: ${{ needs.ios-widgets.result }}
```
