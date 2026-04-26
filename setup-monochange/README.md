# setup-monochange action

Resolve or install the monochange CLI and expose its path, version, and source.

```yaml
uses: monochange/actions/setup-monochange@v0.1.0
```

## Inputs

| Input              | Required | Default | Description                                                                                                          |
| ------------------ | -------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `setup-monochange` | no       | `true`  | How to resolve monochange: `true` = auto-resolve, `false` = require existing `mc`, any other string = custom command |
| `debug`            | no       | `false` | Enable extra debug logging                                                                                           |

## Outputs

| Output    | Description                                                                      |
| --------- | -------------------------------------------------------------------------------- |
| `command` | Resolved monochange command                                                      |
| `version` | Resolved monochange version string                                               |
| `source`  | Resolution source: `existing-mc`, `npx-shim`, `cargo-binstall`, `custom-command` |
| `result`  | `success` or `failed`                                                            |
