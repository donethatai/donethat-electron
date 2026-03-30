# Open-Source Readiness Checklist: DoneThat Desktop

Date: 2026-03-30
Scope: Entire repository at `/Users/christoph/repos/donethat-electron`
Goal: Publish the desktop client source while keeping hosted backend services proprietary.

## Current State Snapshot

- Desktop client source is in this repository; backend services remain proprietary.
- Legal and baseline OSS docs are now present: `LICENSE`, `README.md`, `SECURITY.md`, `SUPPORT.md`, `THIRD_PARTY_NOTICES.md`, and `CHANGELOG.md`.
- `package.json` metadata now points at `donethatai/donethat-electron` and uses `GPL-3.0-only`.
- Firebase client config is committed, so docs/tests do not depend on CI-injected client config.
- Public backend testing posture is now documented: backend-integrated testing uses your own account or a dedicated test account.
- Public backend behavior is now documented in `docs/BACKEND_COMPATIBILITY.md`.
- Release automation now enforces version-tag creation/validation via `scripts/ensure-release-tag.js` before upload.
- Release integrity and dependency-security docs are now present: `docs/RELEASE_INTEGRITY.md` and `docs/DEPENDENCY_SECURITY.md`.
- A lightweight PR CI workflow now runs tests and `build:prepare`.
- Test coverage is still shallow; only a small number of main-process tests exist today.
- Aikido is handled as a required PR security check in GitHub outside this repository.
- Git history still contains both org and personal author email addresses.

## P0 Before Public Launch

- [x] **Add license files and legal metadata**
  - `LICENSE` added.
  - `package.json` license updated to `GPL-3.0-only`.
- [x] **Clarify the open vs closed boundary in the public README**
  - README states that the desktop client is open source and hosted backend services remain proprietary.
- [x] **Document backend compatibility and remote behavior**
  - `docs/BACKEND_COMPATIBILITY.md` documents the proprietary backend dependency surface.
  - Remote payload categories are documented at a public, category-based level.
- [x] **Replace the broken public dev command docs**
  - README now points to `npm run dev` and `npm run build`.
- [x] **Expand local developer bootstrap guidance**
  - README documents Node.js `22`, supported desktop targets, and the macOS Xcode Command Line Tools requirement for local helper builds.
  - README clarifies what can be developed and tested without proprietary backend access.
  - Backend-dependent limitations are documented publicly.
- [x] **Document the supported public backend testing path**
  - Backend-integrated testing uses your own account or a dedicated test account.
- [x] **Add third-party license compliance artifacts**
  - `THIRD_PARTY_NOTICES.md` exists.
- [x] **Add a basic security disclosure path**
  - `SECURITY.md` exists with a private reporting channel and response expectation.
- [x] **Add a concise public trust summary**
  - `docs/BACKEND_COMPATIBILITY.md` includes a public summary of screenshot, activity, microphone, and system-audio handling.
- [x] **Align repository metadata to the source repo**
  - `repository`, `bugs`, and `homepage` now point to `donethatai/donethat-electron`.
- [x] **Align source and release topology**
  - Keep this repository as the canonical source repository.
  - Keep `donethat-releases` as the binary/update repository.
  - The release process now has a shared create-if-missing tag guard via `scripts/ensure-release-tag.js`.
  - Release uploads validate or create the exact `v<package.json version>` source tag before publishing binaries.
- [x] **Audit and clean repository artifacts**
  - The unexplained `%b` root artifact is no longer present.
- [x] **Sanitize current tracked secret templates**
  - `.env-template` now uses descriptive placeholders instead of token-shaped example values.

## P1 Strongly Recommended

- [x] **Add a minimal maintainer/support policy**
  - `SUPPORT.md` exists.
- [x] **Add release integrity and reproducibility docs**
  - `docs/RELEASE_INTEGRITY.md` documents checksums/update metadata, signing, source-to-binary mapping, and the tag-guarded release flow.
  - The public docs now explain how to verify published binaries against source.
- [x] **Improve dependency and security hygiene**
  - `npm audit` was rerun on 2026-03-30 and triaged in `docs/DEPENDENCY_SECURITY.md` (`16` high, `23` moderate, `0` critical).
  - The Aikido GitHub App is handled as a required PR security check in GitHub outside this repository.
- [x] **Add CI quality gates**
  - PR CI now runs tests and build smoke checks.
  - The manual release workflow is no longer the only workflow in the repository.
- [x] **Add a changelog**
  - `CHANGELOG.md` exists.

## P2 Maturity Follow-Ups

- [ ] **Increase test depth and coverage**
  - Add tests beyond work-hours logic, especially around capture flows, IPC, auth, and permissions.
- [x] **Publish contribution posture**
  - `CONTRIBUTING.md` states that the repo is public for inspection first and that outside changes are considered selectively.
- [ ] **Add trademark or brand usage guidance**
  - Protect product branding while allowing source reuse.

## Source-Available Trust Model Requirements

- [ ] Client source for every shipped binary version is published and tagged in this repository.
- [ ] Every release in `donethat-releases` links to the exact matching source tag in this repository.
- [ ] A deterministic or well-documented build path is available.
- [ ] Signed artifacts and checksums are published.
- [x] Remote dependencies and payload categories are documented.

## Minimum File Set Before Announcement

- [x] `LICENSE`
- [x] `SUPPORT.md`
- [x] `SECURITY.md`
- [x] `THIRD_PARTY_NOTICES.md`
- [x] `docs/BACKEND_COMPATIBILITY.md`
- [x] `CONTRIBUTING.md`
- [x] `CHANGELOG.md`

## Git History Hygiene

Findings from local history inspection:

- Author metadata still includes both organization and personal email identities in public history.
- No obvious private-key blocks were identified in the latest history scan.
- Current tracked-file review found no committed `.env` file.
- Remaining public-history concerns are author metadata and secret-like placeholders in historical templates.

Remaining actions:

- [ ] Rewrite public history before announcement to normalize author metadata and sanitize historical secret-like placeholders.
- [ ] If history is rewritten, rescan rewritten history and rotate anything if a real secret is later discovered.

### History Rewrite Plan

1. Create a mirror backup of the repository before any rewrite.
2. Rewrite public history to normalize author metadata to the canonical public organization identity.
3. Rewrite historical secret-like placeholders in committed templates so they no longer match token scanners.
4. Verify the rewritten history by rescanning author metadata and token/private-key patterns.
5. Force-push rewritten branches and tags only after verification succeeds.
6. Reconcile release/source linkage after the rewrite, since tags and commit SHAs will change.
