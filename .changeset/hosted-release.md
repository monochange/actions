---
actions: feat
---

# Create release commits and pull requests through monochange.dev

The new `hosted-release` variant prepares the release in the workflow, then lets monochange.dev create the release commit and the release pull request through the monochange GitHub App. The commit is verified by GitHub, the pull request triggers the repository's normal workflows, and the job needs no personal access token.

```yaml
jobs:
  release-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: read
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          fetch-tags: true
      - id: release
        uses: monochange/actions/hosted-release@v0
        with:
          release-command: release
```

- `release-command` runs the repository's own `monochange.toml` command with `MONOCHANGE_RELEASE_BACKEND=hosted`, so its `Command` steps and `stage_all` run as they do locally. It requires monochange 0.20.0 or newer. Without it, the action runs the built-in prepare, commit, and open release steps.
- `github-token` is passed to monochange as `GITHUB_TOKEN`. With `contents: write`, monochange 0.20.0 or newer uploads the release files as a git tree, so monochange.dev receives only the tree id.

- Install the monochange GitHub App on the repository and grant `id-token: write`; the action fails early with that instruction when the job cannot mint an OIDC token.
- Requires monochange 0.17.0 or newer. The action drives the CLI's hosted `CommitRelease` and `OpenReleaseRequest` backends instead of calling the endpoints itself.
- `hosted-url` (default `https://monochange.dev`) selects the deployment; the OIDC audience is its host.
- Outputs `commit-sha`, `verified`, `head-branch`, `base-branch`, `pull-request-number`, and `pull-request-url`, read back from GitHub. The step fails when GitHub does not verify the release commit.
- Failed hosted requests keep the CLI error and add the next step to take, such as installing the app (HTTP 404), clearing a release branch that moved (HTTP 409), or keeping workflow changes out of the release (HTTP 422).
