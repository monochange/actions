# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < v0.1  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in monochange/actions, please report it
discretely via GitHub Security Advisories:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Provide a clear description, reproduction steps, and impact assessment.

We will acknowledge receipt within 48 hours and aim to provide a fix or
timeline within 7 days.

## Security Hardening

This repository uses the following practices:

- **Dependabot** is enabled for automated dependency updates.
- **CI action versions are pinned** to full-length commit SHAs to mitigate
  supply-chain attacks.
- **Least-privilege workflow permissions** are applied where possible.
- **`pnpm audit`** runs in CI to surface known vulnerabilities.

## Disclosure Policy

Once a fix is released, we will publicly disclose the issue via a GitHub
Security Advisory and credit the reporter.
