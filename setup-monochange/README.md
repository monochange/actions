# setup-monochange action

Resolve or install the monochange CLI and expose its path, version, and source.

With `setup-monochange: true`, use an existing CLI on PATH or download the exact release tracked by the action. Downloads come directly from the npm registry and must match the SHA-512 checksum embedded from the action's lockfile. Setup ignores consumer `.npmrc` files and stops on download or integrity failures. It requires `tar`, as provided on GitHub-hosted runners.

Automatic downloads return a quoted absolute `command` in a private temporary directory. Pass that output to subsequent commands to reuse the verified binary. macOS, Windows, and Linux (glibc or musl) are supported on x64 and ARM64.

```yaml
uses: monochange/actions/setup-monochange@v0.1.0
```

## Inputs

| Input              | Required | Default | Description                                                                                                                  |
| ------------------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `setup-monochange` | no       | `true`  | How to resolve monochange: `true` = auto-resolve, `false` = require existing `monochange`, any other string = custom command |
| `debug`            | no       | `false` | Enable extra debug logging                                                                                                   |

## Outputs

| Output    | Description                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| `command` | Resolved monochange command                                                   |
| `version` | Resolved monochange version string                                            |
| `source`  | Resolution source: `existing-monochange`, `pinned-download`, `custom-command` |
| `result`  | `success` or `failed`                                                         |
