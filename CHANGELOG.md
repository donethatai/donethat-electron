# Changelog

## Unreleased

- Harden desktop OAuth callbacks, embedded portal token handoff, and webview navigation.
- Fix Windows updater cache permission failures by checking update metadata without downloading and offering a manual download.

## 2.2.9

- Sign Windows ARM64 releases by compiling on ARM runners and signing/package-publishing on x64 runners.
- Pin Electron Builder to avoid the upstream NSIS 7z filter regression that skips Windows executables during install.

## 2.2.6

- Remove experimental context capture settings and disable the focused-screenshot capture path.
- Improve Electron child-process exit reporting in Sentry diagnostics.
- Relaunch on repeated GPU process crashes with hardware acceleration disabled.
- Fix system audio capture request handling when Electron cancels the media request.
- Fix chat overlay visibility on macOS fullscreen Spaces.
- Fix settings loading crash when auth state changes during managed settings sync.
- Sync capture interval from user settings.
- Handle local storage full errors without reporting them as renderer crashes.

## 2.2.5

- Fix macOS pausing with a false "no screen capture permission" message.

## 2.2.4

- Add Sentry Electron error reporting and source-map upload for the main app and chat overlay.
- Pin Electron to 41.7.0 to avoid the Chromium 148 Windows startup crash.

## 2.2.3

- Fix chat overlay reopening collapsed after using the dashboard home button.
- Fix audio capture 400 errors by preserving WebM headers across buffer trims and recorder restarts.
- Fix microphone permission recovery so capture can restart after permission changes without manual reset.
- Add chat screenshot prompt flow improvements.
- Improve workday and work-hour state sync reliability.
- Improve local processing reliability around Gemini quota handling and fallback behavior.
- Reduce audio capture bitrate to lower upload and processing overhead.
- Increase Finish Day callable timeout to 15 minutes to reduce deadline-exceeded failures.
- Add client telemetry for capture-cycle, permission-check, and runtime state diagnostics.
- Fix a dependency vulnerability.

## 2.2.2

- **Embedded dashboard auth bridge:** strengthen Firebase id token handoff into `<webview>` — gate sends on `auth.currentUser` (not app-state `isAuthenticated`), staggered kicks after dashboard navigation (incl. post-login), main-window show, recover, main-process `webview:reload`, and calendar-linked reload; bounded retries from `dom-ready` / `did-finish-load`; debounce-bypass nudges on SPA `did-navigate` / `did-frame-finish-load`.

## 2.2.1

- Harden desktopCapturer-based screen permission probes (non-Linux) with backoff retries and longer timeouts so cold-start timeouts are less likely to block recording or macOS system-audio checks; user-triggered permission checks use a shorter interactive probe so UI actions do not wait as long as background probes.
- Fix dashboard portal lifecycle, recovery, and auth handoff around hide/reopen flows.
- Re-send Firebase id token to the embedded portal on a short bounded schedule after `dom-ready` and on `did-finish-load` (debounce bypass) so slow session restore or missed `postMessage` on Windows is less likely to strand the web dashboard bootstrap.
- Listen for Google OAuth callback on IPv4 and IPv6 loopback so browsers that resolve `localhost` to `[::1]` (common on Windows) still reach the app.
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
