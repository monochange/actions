# post-merge-release action

After a release PR merges, detect the release record, create tags, and publish.

```yaml
uses: monochange/actions/post-merge-release@v0.1.0
```

## Inputs

| Input              | Required | Default               | Description                                                                   |
| ------------------ | -------- | --------------------- | ----------------------------------------------------------------------------- |
| `setup-monochange` | no       | `true`                | How to resolve monochange                                                     |
| `ref`              | no       | `HEAD`                | Git ref to inspect                                                            |
| `target-branch`    | no       | —                     | Target branch the PR merged into                                              |
| `base-branch`      | no       | —                     | Default branch override for `sync-release` and `open-next-cut`                |
| `github-token`     | no       | `${{ github.token }}` | Token passed to `monochange` as `GITHUB_TOKEN`                                |
| `sync-release`     | no       | `false`               | Run `open-sync-request` from the default branch after publishing succeeds     |
| `open-next-cut`    | no       | `false`               | Open the next sticky cut PR from the default branch after publishing succeeds |
| `dry-run`          | no       | `false`               | Show without tagging/publishing                                               |
| `debug`            | no       | `false`               | Enable extra debug logging                                                    |

## Outputs

| Output      | Description                                  |
| ----------- | -------------------------------------------- |
| `result`    | `success`, `skipped`, `dry-run`, or `failed` |
| `tagged`    | Whether tags were created                    |
| `published` | Whether packages were published              |
| `json`      | Release record JSON                          |
