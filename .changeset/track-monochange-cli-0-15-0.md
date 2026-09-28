---
actions: patch
---

# Track the monochange CLI 0.15.0 release

Bump the pinned `@monochange/cli` devDependency from 0.14.0 to 0.15.0, so release automation and CI run the CLI release that adds `monochange next` and the `monochange publish` subcommand group. Verified locally: the pinned CLI reports 0.15.0, `monochange next` and `step validate` run against this repository's configuration, and the full `pnpm all` suite passes. The committed `dist/` bundle is unchanged because the CLI is a development dependency.
