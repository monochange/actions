---
actions: minor
---

# Skip classification on release pull requests and pass labels

The change-classification action reads the pull request's labels (or the new `labels` input) and passes them to `monochange change classify` via `--label`. Configure `[changesets.classification].skip_labels` in `monochange.toml` (default `["release"]`) so the release pull request monochange opens is reported as skipped instead of classified: the command analyzes no packages, the action sets `result: skipped`, deletes any stale classification comment, and the job summary records the skip.

The parser also accepts the classification report's new contract: snake_case keys with `schema_version` as a `major.minor` string emitted by `monochange_classification`.

```yaml
- uses: monochange/actions/change-classification@v0
  with:
    labels: release, automated
```
