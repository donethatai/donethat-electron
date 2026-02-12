## Purpose

This document explains the DoneThat Desktop app to autonomous coding agents. It covers architecture, runtime flows, IPC, build/run, constraints, pitfalls, and safe extension points.

## Tech Stack

- Electron (main + renderer)
- Firebase Auth/Functions (region `europe-west1`)
- `electron-store` for local config/state; `electron-log` for logging
- Optional local ML via `@xenova/transformers` for Whisper transcription
- Packaging via `electron-builder`

### Firebase Module Resolution

- Uses Firebase v12+ with webpack aliases for browser versions
- Webpack aliases: `@firebase/auth` → `node_modules/@firebase/auth/dist/esm/index.js`
- Webpack aliases: `@firebase/app` → `node_modules/@firebase/app/dist/esm/index.esm.js`
- Import syntax: use `firebase/` imports in code, webpack resolves to browser versions

## High-Level Architecture

- Main process: orchestrates capture, state, permissions, tray/menu, auto-updates, overlay creation. Entry: `main.js`.
- Renderer process: app UI (`src/index.html`) and chat overlay (`src/chat.html`).
- Capture modules (main): `src-main/*` implement screenshots, windows, and audio.
- State/policy (main): `src-main/main-state.js` centralizes auth token, pause/work hours, permissions, and secure settings.

### Key Modules

- `main.js`: window/tray/menu setup, hotkey registration, updater, IPC wiring, overlay lifecycle.
- `src-main/capture.js`: capture scheduler, collects enabled inputs, local-first processing, fallback upload.
- `src-main/captureScreenshots.js`: screenshots capture/processing.
- `src-main/captureWindows.js`: active window timeline + permissions.
- `src-main/captureAudio.js` + `src-main/voiceToText.js`: rolling audio + Whisper transcription.
- `src-main/processLocal.js`: local summarization path (if available).
- `src-main/main-state.js`: work scheduling, pause/resume, permissions, encrypted settings, auth token SOT.
- Renderer: `src/index.html/js`, `src/chat.html/js`, `src/firebase.js`.

## Runtime Flows (What Happens When)

### App Startup
1. `main.js` enforces single instance, sets logging levels, registers handlers.
2. `createWindow()` loads `src/index.html` (kept hidden initially), then initializes permissions and capture via `initCapture()`.
3. App menu and tray are created; auto-start and updater hooks are configured.

### Auth
- Renderer performs Firebase auth (`src/firebase.js`).
- Main tracks token via `main-state` (IPC events: `login`, `logout`, `token-refreshed`).
- Deep-link `donethat://?token=...` is delivered from main to renderer.

### Capture Cycle
1. Interval configured in `main.js` with `setCaptureInterval(minutes)` (default 5). Token is fetched inside each cycle.
2. On each cycle (`src-main/capture.js`):
   - Optionally skip screenshots if `shouldDisableScreenshotsInMeetings()` (mic activity).
   - Collect audio transcript, window timeline into compact activity.
   - Try local processing (`processLocal`) with current + previous screenshots; else POST to Cloud Function `captureScreenshot` with `Authorization: Bearer <idToken>`.
3. Errors/permission issues disable only the failing modules and notify renderer; auth/token expiry is signaled back for refresh.

### Overlay Chat Flow
- Global hotkey toggles overlay (`Cmd/Ctrl+Shift+D` by default; configurable via `hotkey:set` and persisted in `electron-store`).
- Overlay position is persisted (`overlayPosition`) and restored per display; overlay shows only when authenticated and having valid access.
- Renderer `src/chat.js` can request screenshots via IPC; messages are routed through main.
- Main proxies message processing and pushes updates back to overlay (`chat:*` channels).

### Updates
- `electron-updater` with per-OS strategies: silent on macOS, user-notified on Windows/Linux.
- Autostart is configured per-OS on first ready; Linux currently not supported.
- A daily auth check at 10:00 prompts login if unauthenticated.

## IPC Contract (non-exhaustive)

- Renderer → Main: `chat:send-message`, `overlay:*` (`overlay:toggle`, `overlay:show`, `overlay:hide`, `overlay:open-main`, `overlay:resize`, `overlay:get-state`), `requestAudioPermission`, `updateInputDataSettings`, `updateDisableScreenshotsInMeetings`, `login`, `logout`, `token-refreshed`, `inapp:notify`, `hotkey:set`, `hotkey:get`, `focus-app-window`, `checkScreenCapturePermission`.
- Main → Renderer: `inapp:notify`, `screenCapturePermission`, `windowsPermission`, `overlay:state`, `chat:receive-messages`, `hotkey:updated`, `chat:message-update`, `chat:reset-state`, `webview:reload`, `router:open-link`, `firebase-custom-token`, `refresh-token`, `auth-error`.

## Build/Run

- Dev: `npm run dev` (builds CSS + webpack, launches Electron). For Linux sandbox issues use `dev:linux`.
- Package: `npm run build` or platform-specific scripts in `package.json`.
- Release uploads use GitHub provider; set `GH_TOKEN`.

## Configuration & Permissions

- Workdays/hours and pause state persisted in `electron-store`.
- Screen capture permission checks are surfaced to renderer; Windows (active apps) permission handled similarly.
- Audio/windows are opt-in toggles; failures auto-disable the specific module.
- “Disable screenshots during meetings” switches based on mic activity from audio module.

## Privacy & Security

- Uploads send compact activity; screenshots optimized; least-necessary data shipped.
- Auth via Firebase ID token; token expiry detected and relayed.
- Gemini API key stored encrypted via `src-main/encryption.js`; getters in `main-state`.

## Coding Conventions & Constraints

- Keep code readable (descriptive names, early returns, minimal nesting). Avoid comments for trivial logic.
- Match existing formatting; do not reformat unrelated code.
- Prefer small, well-named helpers. Avoid broad try/catch; handle specific cases.
- Renderer/main boundary: use explicit IPC channels defined close to where they’re handled.
- When editing capture cadence or permissions, also update renderer state handlers (`src/permissions.js`, `src/dashboard.js`, `src/settings.js`).

## Common Pitfalls

- Don’t show overlay if user is unauthenticated or lacks valid access (check `main-state`).
- Deep-link auth can suppress webview reloads briefly; keep that suppression intact.
- Capture cycle must fetch the current token inside the cycle; don’t cache it outside.
- Windows tracking retries are bounded; don’t block the whole cycle on failures.

## How to Extend Safely

- New capture input: add agent under `src-main`, gate behind a user toggle, wire into `collectInputData()` and error handling in `capture.js`.
- New IPC: define handler near its usage, keep payloads minimal, document channel name.
- New settings: store via `electron-store` with `safeStoreOperation`; validate inputs.

## Directory Map

- Main process: `main.js`, `src-main/*`
- Renderer: `src/*` (`index.html/js`, `chat.html/js`)
- Build: `webpack.config.js`, `postcss.config.cjs`, `resources/*`, `release/*`
- Scripts: `scripts/*`
- Config: `package.json`, `firebase-config.js`

## Nuances & Operational Notes

- Hotkey: configurable suffix via `hotkey:set`; label and accelerator update menus and tray.
- Overlay: position persisted per display; shown only when authenticated and with valid access.
- Autostart: set on macOS/Windows at app ready; not supported on Linux.
- Daily auth check: at 10:00 local time, opens app and prompts if logged out.