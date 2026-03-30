# Dependency Security

This document records the current dependency-security posture for the public DoneThat Desktop repository.

## Current Audit Snapshot

`npm audit --json` was rerun on 2026-03-30.

Current totals:

- `0` critical
- `16` high
- `23` moderate
- `39` total

## Triage Summary

The current findings cluster into a few buckets:

- `electron-builder` / `app-builder-lib` / `@electron/rebuild`
  - Primarily release-tooling and build-chain findings.
  - Important for maintainer release hygiene, but not all are runtime exposure in the packaged app.
- `jimp` and related `@jimp/*` packages
  - Moderate findings concentrated in the screenshot/image-processing stack.
  - Audit suggests a semver-major `jimp` upgrade path.
- `get-windows` / `node-gyp` / `make-fetch-happen`
  - High findings tied to native build/dependency tooling and the Windows active-window dependency chain.
  - Some entries currently report `fixAvailable: false`.
- Common transitive tooling packages such as `tar`, `minimatch`, `picomatch`, `serialize-javascript`, and `yaml`
  - Spread across build/test/dependency-management chains rather than a single desktop feature surface.

## Current Position

- The audit was rerun and the results were reviewed before public launch work.
- No critical advisories were present in the current audit output.
- Several high/moderate issues still require upstream or semver-major dependency updates, especially in release/build tooling and the image stack.
- The repository already pins `tar` via `overrides`, but `npm audit` still reports remaining transitive exposure in the current dependency graph.

## Repository Controls

- PR CI runs `npm test` and `npm run build:prepare`.
- Security disclosures are handled through [SECURITY.md](../SECURITY.md).
- Aikido should be configured as a required PR security check in GitHub repository settings outside this repository.

## Follow-Up Priorities

1. Update or replace the `electron-builder` chain when a compatible remediation path is available.
2. Evaluate the semver-major `jimp` upgrade path and revalidate image-processing behavior.
3. Track upstream fixes for `get-windows` and related native/build tooling.
4. Re-run `npm audit` after dependency upgrades and before major releases.
