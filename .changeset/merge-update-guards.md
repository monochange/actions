---
actions: patch
---

# Enforce merge authorization, check policy, and dry-run before branch updates and hooks

The merge action rejects unauthorized actors and blocked checks before creating its git workspace. Dry-run never rebases or pushes either branch, runs a post-update script, or dispatches a workflow. Post-update scripts receive only executable-path, locale, and temporary-directory variables instead of inheriting action inputs and job credentials.
