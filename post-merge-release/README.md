# post-merge-release action

After a release PR merges, detect the release record, create tags, and publish.

```yaml
uses: monochange/actions/post-merge-release@v0.1.0
```

## Inputs

| Input              | Required | Default | Description                      |
| ------------------ | -------- | ------- | -------------------------------- |
| `setup-monochange` | no       | `true`  | How to resolve monochange        |
| `ref`              | no       | `HEAD`  | Git ref to inspect               |
| `target-branch`    | no       | —       | Target branch the PR merged into |
| `dry-run`          | no       | `false` | Show without tagging/publishing  |
| `debug`            | no       | `false` | Enable extra debug logging       |

## Outputs

| Output      | Description                                  |
| ----------- | -------------------------------------------- |
| `result`    | `success`, `skipped`, `dry-run`, or `failed` |
| `tagged`    | Whether tags were created                    |
| `published` | Whether packages were published              |
| `json`      | Release record JSON                          |
