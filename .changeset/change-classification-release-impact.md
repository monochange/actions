---
actions: minor
---

# Show whether a breaking change applies to main or the latest release

The change-classification action reads the new `release_impact` decision field and shows it next to the default-branch impact. A package that breaks only against `main` (its latest release never shipped the changed API) renders as `breaking → additive (release)` in the comment table, gets an informational callout naming the package, and appears in the job summary line. The new `release-breaking` output is `true` only when a package breaks against its latest release, so workflow routing can block those pulls without blocking refinements of unreleased APIs.

Reports from monochange versions without `release_impact` render exactly as before.

```yaml
- id: classify
  uses: monochange/actions/change-classification@v0

- run: |
    if [[ "${{ steps.classify.outputs.release-breaking }}" == "true" ]]; then
      echo "A released API broke; a major changeset is required."
    fi
```
