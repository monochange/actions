# publish-plan action

Run `mc publish-plan` and expose the plan as JSON, summary, and CI outputs.

```yaml
uses: monochange/actions/publish-plan@v0.1.0
```

## Inputs

| Input              | Required | Default | Description                          |
| ------------------ | -------- | ------- | ------------------------------------ |
| `setup-monochange` | no       | `true`  | How to resolve monochange            |
| `format`           | no       | `json`  | Output format                        |
| `mode`             | no       | `full`  | Plan mode: `full` or `single-window` |
| `ci`               | no       | —       | CI provider for snippet generation   |
| `package`          | no       | —       | Comma-separated package filters      |
| `debug`            | no       | `false` | Enable extra debug logging           |

## Outputs

| Output               | Description                     |
| -------------------- | ------------------------------- |
| `result`             | `success` or `failed`           |
| `json`               | Full JSON publish plan          |
| `summary`            | Text summary                    |
| `fits-single-window` | Whether plan fits single window |
