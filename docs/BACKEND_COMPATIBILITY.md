# Backend Compatibility

This repository contains the open-source desktop client for DoneThat. Hosted backend services remain proprietary.

## Open vs Closed Boundary

The desktop client code in this repository is public. The following remain closed and are not implemented here:

- hosted APIs and Cloud Functions
- the `app.donethat.ai` web app loaded inside the desktop client
- backend-side data storage, processing, billing, and access control

The desktop client expects those remote services to remain compatible with the payload categories documented below.

## Remote Services Used By The Client

- `https://identitytoolkit.googleapis.com`
  - Firebase Authentication sign-in and token flows used by the renderer.
- `https://securetoken.googleapis.com`
  - Firebase token refresh flows used by the renderer.
- `https://firebaseinstallations.googleapis.com`
  - Firebase client installation management used by the Firebase SDK.
- `https://europe-west1-donethat.cloudfunctions.net/inputConfig`
  - Returns backend-managed local-processing configuration.
- `https://europe-west1-donethat.cloudfunctions.net/inputProcess`
  - Accepts locally processed capture results for downstream backend handling.
- `https://europe-west1-donethat.cloudfunctions.net/captureScreenshot`
  - Accepts capture-cycle uploads when the cloud processing path is used.
- `https://europe-west1-donethat.cloudfunctions.net/contextCapture`
  - Accepts optional focused context screenshots for configured apps.
- `https://app.donethat.ai`
  - Embedded portal/dashboard webview and related account flows.
- `https://checkout.stripe.com`
  - Hosted billing flow opened from the embedded portal.

## Remote Payload Categories

All DoneThat-managed API requests use Firebase ID token authentication unless noted otherwise.

### Firebase Auth And Token Services

- Email/password or federated sign-in data handled by Firebase Auth
- token refresh and client-installation metadata handled by Firebase SDK services

### `inputConfig`

Request categories:

- authenticated GET request with no capture payload

Response categories:

- local-processing configuration
- model/input limits and related backend-managed settings

### `inputProcess`

Request categories:

- capture timestamp
- structured local-processing output derived from screenshots, activity, and optional audio
- processing parameters used to produce that structured output
- optional client diagnostic metadata when enabled in the app

This endpoint is used after local processing. "Local processing" means the desktop client sends screenshots and audio to a third-party LLM provider (Google Gemini using a stored API key, or a user-configured OpenAI-compatible endpoint) for summarization, then sends the structured result to this DoneThat endpoint. Raw screenshots and audio are not sent to DoneThat in this path, but they are sent to the configured LLM provider. Local processing does not make the workflow fully offline.

### `captureScreenshot`

Request categories:

- capture timestamp
- current screenshots
- previous screenshot context
- activity summaries derived from active-window tracking and idle detection
- optional audio capture payload for the cycle
- optional client diagnostic metadata when enabled in the app

This is the cloud-backed capture path used when local processing is not configured. In this path, raw screenshots, audio, and activity data are sent directly to DoneThat services for processing.

### `contextCapture`

Request categories:

- capture timestamp
- focused screenshots for configured apps/windows
- app names and window titles associated with those focused screenshots

This path is optional and only used when context capture is enabled in the app.

### `app.donethat.ai`

The desktop app embeds the DoneThat web application for dashboard/account flows. Data handled there is governed by the web application and backend services, not by this repository alone.

Typical categories include:

- authenticated account/session state
- subscription and billing UI flows
- summary and dashboard data returned by DoneThat services

## Local Development Expectations

You can work on several parts of the desktop client without proprietary backend access:

- install dependencies
- run tests
- run `npm run build:prepare`
- work on renderer UI, settings, and main/renderer IPC flows
- work on packaging scripts and most desktop-only behavior

For backend-integrated testing, use your own account or create a dedicated test account.

You cannot fully exercise these flows without compatible backend access:

- real sign-in against production-compatible Firebase/Auth configuration
- embedded portal behavior from `app.donethat.ai`
- cloud capture submission and backend summaries
- backend-managed local-processing config from `inputConfig`
- submission of locally processed results to `inputProcess`

## Trust Summary

The desktop client can collect sensitive workstation data depending on user settings.

- Screenshots: may include on-screen work content across one or more displays.
- Activity tracking: may include app names, window titles, durations, and idle-time summaries.
- Microphone capture: may include spoken audio recorded from the microphone when enabled.
- System audio capture: may include playback audio when enabled and supported by the operating system.

Users should assume those categories may be transmitted to DoneThat services when the related features are enabled and a compatible backend is available. When local processing is configured, raw screenshots and audio are sent to the configured third-party LLM provider (Google Gemini or a user-configured OpenAI-compatible endpoint) instead of to DoneThat, but structured results are still sent to DoneThat.

For retention, deletion, and broader data-handling details, see [donethat.ai/data](https://donethat.ai/data).

For security reporting, use [SECURITY.md](../SECURITY.md). For support scope, use [SUPPORT.md](../SUPPORT.md).
