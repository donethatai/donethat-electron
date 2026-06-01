# Data Flow

This document explains what the open-source desktop client sends to remote services, how the local and cloud processing paths differ, and how you can verify that behavior in this repository.

For a visual overview of the data flow, see [donethat.ai/data](https://donethat.ai/data).

The [GPL-3.0-or-later license](../LICENSE) applies to the client source code in this repository. DoneThat backend services, APIs, and infrastructure are not included here.

## Data Flow Summary

The desktop client can collect sensitive workstation data depending on user settings.

- Screenshots: may include on-screen work content across one or more displays.
- Activity tracking: may include app names, window titles, durations, and idle-time summaries.
- Microphone capture: may include spoken audio recorded from the microphone when enabled.
- System audio capture: may include playback audio when enabled and supported by the operating system.
- Client telemetry: may include diagnostic metrics and logs when enabled.

The exact data shared depends on which processing path is active.

## How The App Talks To The Backend

The client talks to a small set of remote services:

- Firebase Auth services for sign-in and token refresh.
- DoneThat Cloud Functions for capture uploads, local-processing config, and text-result submission.
- `app.donethat.ai` for the embedded dashboard/account experience.
- `checkout.stripe.com` for hosted billing flows opened from the embedded portal.

The relevant endpoints currently used by the client are:

- `https://identitytoolkit.googleapis.com`
- `https://securetoken.googleapis.com`
- `https://firebaseinstallations.googleapis.com`
- `https://europe-west1-donethat.cloudfunctions.net/inputConfig`
- `https://europe-west1-donethat.cloudfunctions.net/inputProcess`
- `https://europe-west1-donethat.cloudfunctions.net/captureScreenshot`
- `https://app.donethat.ai`
- `https://checkout.stripe.com`

All DoneThat-managed API requests use Firebase ID token authentication unless noted otherwise.

## Local Processing Flow

When local processing is configured, the desktop client still uses remote services, but the split is different:

1. The client collects screenshots, activity summaries, and optional audio for the capture cycle.
2. Raw screenshots and optional audio are sent to the configured LLM provider:
   - Google Gemini using the stored Gemini API key, or
   - a user-configured OpenAI-compatible endpoint, which can also point to an LLM running locally on the user's machine.
3. The LLM returns text output.
4. The client sends that text output to DoneThat via `inputProcess`.

What DoneThat receives in this flow:

- capture timestamp
- text output derived from screenshots, activity, and optional audio
- processing parameters
- optional client telemetry when enabled

What DoneThat does not receive in this flow:

- raw screenshots from the capture cycle
- raw microphone/system-audio payloads

## Cloud Processing Flow

When local processing is not configured, the client uses the cloud capture path.

The client sends `captureScreenshot`:

- capture timestamp
- current screenshots
- previous screenshot context
- activity summaries derived from active-window tracking and idle detection
- optional audio capture payload for the cycle
- optional client telemetry when enabled

In this flow, raw screenshots, activity data, and optional audio are sent directly to DoneThat services for processing.

This cloud path is a convenience flow. Backend processing still converges on the same text-output path used by local processing, and raw capture inputs are not stored as persistent backend data.

## Other Remote Data Flows

### Auth

Firebase handles:

- email/password or federated sign-in data
- token refresh and installation metadata used by the Firebase SDK

### Embedded Web App

The desktop app embeds `app.donethat.ai` for dashboard, account, and billing-related flows. Typical data categories there include:

- authenticated account/session state
- subscription and billing UI flows
- summaries and dashboard data returned by DoneThat services

## How To Verify This Yourself

You can inspect the client code directly:

- Search for remote endpoints in the repo to see what hosts the client talks to.
- Read [main.js](../main.js) for updater, auth-window, and embedded-webview behavior.
- Read [src-main/capture.js](../src-main/capture.js) for the main capture-cycle upload flow.
- Read [src-main/processLocal.js](../src-main/processLocal.js) for the local-processing submission path.
- Read [src-main/main-state.js](../src-main/main-state.js) for token handling and persisted capture-related settings.

Useful checks:

- Search for `captureScreenshot`, `inputProcess`, and `inputConfig`.
- Search for `clientTelemetry` to see where diagnostic payloads are attached.
- Search for `app.donethat.ai` and `checkout.stripe.com` to inspect embedded web flows.

What you cannot verify from this repository alone:

- backend retention policies
- backend-side processing details
- backend database/storage behavior
- web-app internals behind `app.donethat.ai`

For retention, deletion, and broader data-handling details, see [donethat.ai/data](https://donethat.ai/data).

For security reporting, use [SECURITY.md](../SECURITY.md). For support scope, use [SUPPORT.md](../SUPPORT.md).
