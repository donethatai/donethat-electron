# Open-Source Readiness Assessment: DoneThat Desktop

Date: 2026-03-06
Scope: Entire repository at `/Users/christoph/repos/donethat-electron`
Goal: Publish desktop client source while keeping server proprietary ("Proton-style" trust model)

## License Decision

Use **GPLv3** for the desktop client.

## Current State Snapshot (what I found)

- No project license file exists (`LICENSE`, `COPYING`, etc. missing).
- `package.json` is currently `"license": "UNLICENSED"`.
- Minimal docs only (`README.md` + 2 operational docs).
- `README.md` says to run `npm run start`, but there is no `start` script.
- Build/runtime depends on private backend endpoints (`*.cloudfunctions.net`, `app.donethat.ai`) and local private config (`firebase-config.js`).
- Only one real test suite exists (`src-main/__tests__/main-state-workdays.test.js`).
- Test coverage is very low overall (~8.45% statements from `npm test -- --coverage --runInBand`).
- `npm audit --json` reports 12 vulnerabilities (10 high, 2 moderate).
- A strangely named tracked binary file exists at repo root: `%b` (PNG).
- No contributor governance/security docs (`CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, etc.).
- No third-party notices/SBOM currently present.
- Git history contains two author emails; one is a personal Gmail address.

## What Is Missing Before Best-Practice Open Source Release

## P0 (must-have before going public)

- [ ] **Add license files and legal metadata**
  - Add `LICENSE` (GPLv3 text), `COPYING` if desired, SPDX headers strategy.
  - Update `package.json` license from `UNLICENSED`.
- [ ] **Clarify client/server boundary in writing**
  - Add explicit statement: client is open-source; server/API is proprietary.
  - Add backend compatibility/API contract doc for public understanding.
- [ ] **Replace/clean secret-coupled setup**
  - Provide a safe public config pattern (`firebase-config.example.js` or env-based loader).
  - Ensure no private credentials are required to build docs/tests locally.
- [ ] **Add third-party license compliance artifacts**
  - Add `THIRD_PARTY_NOTICES.md` (or generated `THIRD_PARTY_LICENSES.txt`).
  - Include dependency license review and obligations (including MPL-2.0 dependency handling).
- [ ] **Security disclosure and trust docs**
  - Add `SECURITY.md` (reporting channel, SLA, supported versions).
  - Add threat model/privacy summary for screenshot/audio/window capture behavior.
- [ ] **Expose telemetry opt-out in settings**
  - Add a user-facing setting to disable telemetry from the desktop app.
  - Document exactly what is still sent when opt-out is enabled (if anything).
- [ ] **Fix public README correctness**
  - Correct run/build commands.
  - Add complete developer bootstrap steps.
  - Document what works without proprietary backend.
- [ ] **Align repository + release topology**
  - Publish releases from this source repository (instead of a separate releases repo).
  - Rename repository to `donethat-desktop` and update all metadata/links accordingly.
  - Plan and execute an `electron-updater` feed switchover during rename/migration (update publish target repo and updater config, e.g. `package.json` `build.publish` and `dev-app-update.yml`).
- [ ] **Audit and clean repository artifacts**
  - Remove unexplained tracked file `%b` if accidental.
  - Ensure only intended assets remain.

## P1 (strongly recommended)

- [ ] **Minimal maintainer policy (trimmed for low-contrib model)**
  - Keep this to one lightweight doc (recommended: `SUPPORT.md`) that states support boundaries and contact path.
- [ ] **Release integrity and reproducibility**
  - Public release process doc with signed artifacts, checksums, and source/binary mapping.
  - Explain how users verify binaries match published source.
- [ ] **Dependency/security hygiene**
  - Triage and remediate current audit findings.
  - Add CI security scanning (`npm audit`, CodeQL/Dependabot/Snyk equivalent).
- [ ] **CI for quality gates**
  - Add PR CI (tests, lint, build smoke checks).
  - Current workflow is manual release-oriented (`workflow_dispatch`) rather than PR safety.
- [ ] **Repo metadata corrections**
  - Update `repository`, `bugs`, and homepage metadata to the actual source repository strategy.

## P2 (best-practice maturity)

- [ ] **Testing depth and coverage targets**
  - Add tests beyond work-hours logic (capture pipeline, IPC contract, auth/permissions).
  - Define minimum coverage thresholds in CI.
- [ ] **Developer standards**
  - Add lint/format config and contribution expectations.
- [ ] **Change transparency**
  - Add `CHANGELOG.md` and stable release notes process.
- [ ] **Trademark/brand usage policy**
  - Permit source reuse while protecting product branding and official service identity.
- [ ] **Public architecture docs**
  - Expand docs around data flow, telemetry, and local vs cloud processing fallback.

## Proton-Style Trust Model Requirements (important for your stated intent)

If the purpose is "users can inspect client code even with closed backend", add these explicit guarantees:

- [ ] Client source for every shipped binary version is published and tagged.
- [ ] Deterministic or well-documented reproducible build path is available.
- [ ] Signed release artifacts and checksums are published.
- [ ] Remote behavior dependencies are documented (all backend endpoints, what they do, and what data they receive).
- [ ] Telemetry/data collection defaults and opt-out behavior are documented precisely.

## Minimum File Set To Add

At minimum, add these files before announcing OSS:

- `LICENSE`
- `SUPPORT.md` (minimal maintainer/support policy)
- `SECURITY.md`
- `THIRD_PARTY_NOTICES.md` (or equivalent generated file)
- `ARCHITECTURE.md` (public version)
- `PRIVACY_CLIENT.md` (what desktop captures/sends)
- `OPEN_SOURCE_SCOPE.md` (what is open vs closed)
- `CHANGELOG.md`

## Git History Hygiene Scan (completed in this assessment)

Scan scope: all reachable commits (`git rev-list --all`, 587 commits), blob content + commit author emails.

Findings:

- Potential credential patterns in history were mostly expected placeholders (notably in `.env-template`), plus secret-variable names in workflow files.
- No private key blocks found in git history (`BEGIN RSA/EC/OPENSSH PRIVATE KEY` patterns).
- No obvious live-token patterns found in git history beyond placeholder-like examples.
- Author email metadata contains:
  - `christoph@donethat.ai`
  - `[redacted personal email]` (appears on many commits, including Codex snapshot commits)

Actions to consider:

- [ ] If you do not want personal email disclosure, rewrite git history before public launch.
- [ ] After any history rewrite, rotate tokens as precaution and rescan (e.g., with gitleaks/trufflehog + custom patterns).

### Email rewrite commands (post-hoc)

Set future commits to org email:

```bash
git config user.email "new@donethat.ai"
```

Rewrite historical commit email metadata:

```bash
cat > .mailmap <<'EOF'
Your Name <old@example.com> Your Name <new@donethat.ai>
EOF

git filter-repo --force --mailmap .mailmap
git push --force --all
git push --force --tags
```

Notes:

- This rewrites commit SHAs.
- Everyone using the repo must re-clone or hard-reset to the rewritten history.
- Old SHAs may still exist in forks/clones.

## Practical Recommendation

Use **GPLv3** for the desktop client. Publish clear boundary docs so there is no ambiguity that the hosted backend remains proprietary.
