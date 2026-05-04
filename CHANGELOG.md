# Changelog

## Unreleased

- Fix dashboard portal lifecycle, recovery, and auth handoff around hide/reopen flows.
- Switch Windows code signing from DigiCert KeyLocker to Azure Trusted Signing (OIDC). Windows arm64 builds are temporarily unsigned because Azure Trusted Signing does not yet ship an ARM64 dlib.
- Fix silent Linux auto-update failure when the AppImage lives in a non-writable location: detect missing write permissions up front and surface a manual-download notification instead of swallowing the `EACCES` from `electron-updater`.

## 2.1.0

- Switch license SPDX to `GPL-3.0-or-later`.
- Docs updates.
- Fixed windows iframe embedding bug.
- Updated Don animation.
- Aligned design with webapp and website.
- Allow task reassignment in finish day dialog.

## 2.0.2

- Add Finish Day flow with project-based task edits.
- Fix recording state and icon inversion issues.
- Fix overlay drag issues on Windows.
- Fix drop shadow rendering on Windows.
- Align design with frontend and website.
- Update mascot assets.

## 2.0.1

- Fix overlay issues on Windows.
- Fix mascot rendering.

## 2.0.0

- Add GPLv3 license and switch package SPDX to `GPL-3.0-only`.
- Add minimal security, support, and third-party notices docs.
- Correct README development/build docs and OSS boundary statement.
- Update repository metadata to `donethatai/donethat-electron`.
