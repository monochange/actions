# publish-draft-releases action

Publish the draft GitHub releases that monochange created for a release.

Replace a hand-written `gh release edit` step with an action that retries transient GitHub failures and publishes every draft release that belongs to the same monochange release.

```yaml
- name: publish draft releases
  uses: monochange/actions/publish-draft-releases@v0
  with:
    release-tag: v0.14.0
```

## Inputs

| Input               | Required | Default                    | Description                                                    |
| ------------------- | -------- | -------------------------- | -------------------------------------------------------------- |
| `release-tag`       | yes      | —                          | Release tag to publish, for example `v0.14.0`                  |
| `github-token`      | no       | `${{ github.token }}`      | Token used to read and publish releases                        |
| `repository`        | no       | `${{ github.repository }}` | Target repository in `owner/repo` format                       |
| `publish-related`   | no       | `true`                     | Also publish released targets from the matching release record |
| `max-attempts`      | no       | `5`                        | Maximum attempts per release for retryable API failures        |
| `working-directory` | no       | `.`                        | Working directory containing `.monochange/releases`            |

## Outputs

| Output           | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `result`         | `success` or `failed`                                  |
| `target-tags`    | JSON array of release tags this run inspected          |
| `published-tags` | JSON array of release tags this run made public        |
| `failed-tags`    | JSON array of release tags that could not be published |

## Behavior

1. The primary `release-tag` is always published.
2. With `publish-related: true`, the action finds the `.monochange/releases/*/release.json` record whose `release_targets[]` contains the primary tag. It reads the record with `jq` and adds every `tag_name` whose `release` flag is true. When no record matches, it prints a notice and publishes only the primary tag. A missing `jq` or an unreadable record produces a warning and the same fallback.
3. Each release is looked up with `gh release view`, which supplements the REST tag endpoint with a GraphQL draft lookup and therefore finds drafts. The REST `/releases/tags/{tag}` endpoint alone returns 404 for a draft, so it is not used.
4. An already public release is reported and skipped, so the action is safe to run twice. A draft is published, then read back to confirm it is no longer a draft.
5. Only the primary tag is marked as the latest release. Every other tag is published with `--latest=false`, so a secondary draft cannot take the latest marker from the primary release.
6. A missing primary release fails the action. A missing secondary release is a warning.
7. HTTP 5xx responses, HTTP 429, rate limiting, and network errors are retried with exponential backoff (10 s, 20 s, 40 s, 80 s) up to `max-attempts`. A 4xx response such as 404 or 422 fails at once and includes the response text.
8. The step exits non-zero only when the primary release is not public at the end, and the error names every release that failed.

## Permissions

```yaml
permissions:
  contents: write
```

Draft releases are only visible to tokens that can push to the repository, so the default `github.token` needs `contents: write` (the permission is already required to publish a release).

`gh` and `jq` are preinstalled on GitHub-hosted runners.

## Example

```yaml
name: publish

on:
  workflow_dispatch:
    inputs:
      release-tag:
        description: Release tag to publish.
        required: true
        type: string

jobs:
  publish-draft-releases:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6

      - uses: monochange/actions/publish-draft-releases@v0
        with:
          release-tag: ${{ inputs.release-tag }}
```
