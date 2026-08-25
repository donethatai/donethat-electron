# Changelog

## Unreleased

- Pause auto-update for 7 days by clicking the Settings version label 7 times, or set `DONETHAT_DISABLE_AUTO_UPDATE=1`.
- Fix a custom LLM endpoint that answers but returns nothing usable failing silently all day: the app now notifies you, and the Test button reports the failure instead of reporting success.
- Move Setup out of the top bar: its sections now open as an overlay straight from the web dashboard's settings (Permissions and App from the nav, App masking and LLM from Privacy), leaving the dashboard loaded underneath.
- Fix capture interval changes made in the web dashboard never reaching the app.
- Fix copy buttons in the embedded web dashboard (such as the MCP server settings) silently copying nothing.
- Fix a burst of recording each day during holidays longer than a week, where the daily pause expired mid-holiday and briefly resumed capture before the state check caught it.
- App masking rules move to your account: edit them in Privacy in the web dashboard and they apply on every computer you sign in on. Rules that only existed on this machine are uploaded once, and the desktop panel keeps the part a browser cannot do — testing them against a live capture.
- Say why App masking is greyed out instead of hiding the reason in a tooltip.
- Drop the Finish button from Setup, and stop repeating a section's name in both the panel header and the card below it.
- Fix macOS never asking for Screen Recording: the permission request now probes even when TCC reports "denied", which is what it reports for an app that was never asked.
- Fix macOS work-location fingerprints not attaching to captures after Location was granted.
- Only collect the router identifier once location access is granted, and stop scanning after it is refused.
- Verify signed macOS helpers at package time instead of shipping a silently broken one.
- Reduce the macOS local-network permission prompt by disabling Chromium Cast discovery and Continuity Camera.
- Upgrade Electron from 41.7.0 to 43.4.1.

## 2.2.12

- Fix a crash dialog ("A JavaScript error occurred in the main process") caused by an unguarded breadcrumbs bug in @sentry/electron 7.14; pin to 7.13 and guard the main-process error handler.
- Harden desktop OAuth callbacks, embedded portal token handoff, and webview navigation.
- Fix Windows updater cache permission failures by checking update metadata without downloading and offering a manual download.
- Build Windows ARM64 release payloads through NSIS packaging before signing so updater resources are present in the installed app.

## 2.2.10

- Sign Windows ARM64 releases by compiling on ARM runners and signing/package-publishing on x64 runners.
- Force the Windows NSIS app archive to use the BCJ 7z filter to avoid the upstream Electron Builder regression that skips executables during install.

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
