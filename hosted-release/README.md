# `hosted-release`

`monochange/actions/hosted-release` prepares a release in the workflow, then lets [monochange.dev](https://monochange.dev) create the release commit and the release pull request through the monochange GitHub App.

The commit and pull request belong to the monochange bot instead of a personal access token or `github-actions[bot]`, so:

- GitHub verifies the release commit, which satisfies "require signed commits" branch protection;
- the release pull request triggers the repository's normal `pull_request` workflows;
- the workflow needs no write token, deploy key, or git identity.

## Requirements

- The [monochange GitHub App](https://monochange.dev/install) is installed on the repository.
- The job grants `id-token: write` so it can mint a GitHub Actions OIDC token for monochange.dev.
- `monochange.toml` configures `[source]` with `provider = "github"` and `[source.pull_requests]`.
- monochange `0.17.0` or newer. The action resolves the CLI like `setup-monochange` and fails early on an older one.

## Quick start

```yaml
name: release

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  release-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: read # read the release commit back
      pull-requests: read # read the release pull request back
      id-token: write # authenticate to monochange.dev
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          fetch-tags: true

      - id: release
        uses: monochange/actions/hosted-release@v0

      - run: echo "Release pull request ${{ steps.release.outputs.pull-request-url }}"
```

The root entrypoint runs the same implementation:

```yaml
- uses: monochange/actions@v0
  with:
    name: hosted-release
```

## How it works

1. `monochange step prepare-release` computes versions, changelogs, and the release record in the checkout.
2. `monochange step open-release-request --backend hosted --dry-run` reports the release branch and base branch.
3. `monochange step commit-release --commit-backend hosted` sends the prepared files to `POST /api/release-commits`. The app commits them on the release branch, with the checked-out commit as the parent.
4. `monochange step open-release-request --backend hosted` sends the rendered pull request to `POST /api/release-requests`. The app opens or updates the pull request.
5. The action reads the release branch head and the open pull request back from GitHub with `github-token`, then fails if GitHub did not verify the commit.

The monochange CLI builds the request payloads and requests the OIDC token itself. The token audience is the `hosted-url` host, so the default is `monochange.dev`.

The release branch is `<branch_prefix>/step-open-release-request`, because monochange names release branches after the command that opens them.

## Inputs

| Input               | Required | Default                  | Description                                                                                                                     |
| ------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `setup-monochange`  | No       | `true`                   | How to resolve monochange: `true` auto-resolves, `false` requires `monochange` on `PATH`, any other string is a custom command. |
| `working-directory` | No       | `.`                      | Directory to run monochange in.                                                                                                 |
| `hosted-url`        | No       | `https://monochange.dev` | Base URL of the monochange app. The OIDC token audience is this URL's host.                                                     |
| `github-token`      | No       | `${{ github.token }}`    | Token used only to read the release commit and pull request back. Needs `contents: read` and `pull-requests: read`.             |
| `dry-run`           | No       | `false`                  | Prepare the release and report the branches without contacting the hosted app. Does not need `id-token: write`.                 |

## Outputs

| Output                | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| `result`              | `success`, `dry-run`, or `failed`.                        |
| `head-branch`         | Release pull request head branch.                         |
| `base-branch`         | Release pull request base branch.                         |
| `commit-sha`          | Release commit SHA on the head branch.                    |
| `verified`            | `true` when GitHub verified the release commit signature. |
| `pull-request-number` | Open release pull request number.                         |
| `pull-request-url`    | Open release pull request URL.                            |

## Troubleshooting

### "this job cannot request one. Add `permissions: id-token: write`"

The job cannot mint a GitHub Actions OIDC token. Add `id-token: write` to the job's `permissions`. Pull requests from forks never receive OIDC tokens, so run the action on `push` or `workflow_dispatch`.

### HTTP 404: "has no monochange GitHub App installation"

Install the monochange GitHub App on the repository, or check that `hosted-url` points at a monochange deployment.

### HTTP 401: "OIDC verification failed"

The hosted app did not accept the token audience. Point `hosted-url` at the deployment that should verify the token.

### HTTP 409: the release branch moved

The release branch already points at a different commit than the one this run prepared from. Merge or close the open release pull request and delete its branch, then rerun. Enabling "Automatically delete head branches" removes merged release branches for you.

### "is not verified by GitHub"

GitHub did not verify the release commit. The `commit-sha` and `verified` outputs are still set so later steps can inspect them.

### "no markdown changesets found"

There is nothing to release. Run the action only when changesets are pending.
