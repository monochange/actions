---
actions: major
---

# Track the monochange CLI 0.15.0 release

Bump the pinned `@monochange/cli` devDependency from 0.14.0 to 0.15.0. The action bundle is versioned independently of the CLI, so consumers that pin an action SHA can be running against a CLI whose interface moved underneath them; this release moves the action's major version in step with the CLI's.

monochange 0.15.0 is a breaking CLI release. `monochange skill` no longer forwards arguments to `npx`, `pnpm dlx`, or `bunx`, and `MONOCHANGE_SKILL_SOURCE` and `MONOCHANGE_SKILL_RUNNER` are removed in favor of `monochange skill read <topic>` and `monochange skill install --dir <dir>`. The change-classification report contract also advanced to `schema_version` `0.3`, adding `decision.pull_request_changes`.

From this release on, a breaking change in monochange produces a breaking change in `monochange/actions`, so downstream pins move major versions together.

Verified locally: the pinned CLI reports 0.15.0, `monochange next` and `step validate` run against this repository's configuration, and the full `pnpm all` suite passes. The committed `dist/` bundle is unchanged because the CLI is a development dependency.
