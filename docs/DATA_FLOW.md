# Data Flow

This document explains what the open-source desktop client sends to remote services, how the local and cloud processing paths differ, and how you can verify that behavior in this repository.

For a visual overview of the data flow, see [donethat.ai/data](https://donethat.ai/data).

The [GPL-3.0-or-later license](../LICENSE) applies to the client source code in this repository. DoneThat backend services, APIs, and infrastructure are not included here.

## Data Flow Summary

The desktop client can collect sensitive workstation data depending on user settings.

- Screenshots: may include on-screen work content across one or more displays.
- Activity tracking: may include app names, window titles, durations, and idle-time summaries.
- Window text (accessibility): part of "Active applications" (macOS and Windows only), may include visible text from the focused window, read through the operating system's accessibility APIs.
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
- `huggingface.co` (and the Hugging Face CDN it redirects to) to download the on-device model file, only when you download it.

The relevant endpoints currently used by the client are:

- `https://identitytoolkit.googleapis.com`
- `https://securetoken.googleapis.com`
- `https://firebaseinstallations.googleapis.com`
- `https://europe-west1-donethat.cloudfunctions.net/inputConfig`
- `https://europe-west1-donethat.cloudfunctions.net/inputProcess`
- `https://europe-west1-donethat.cloudfunctions.net/captureScreenshot`
- `https://app.donethat.ai`
- `https://checkout.stripe.com`
- `https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/<pinned revision>/Qwen3.5-2B-Q4_K_M.gguf`

All DoneThat-managed API requests use Firebase ID token authentication unless noted otherwise.

## Local Processing Flow

When local processing is configured, the desktop client still uses remote services, but the split is different:

1. The client collects screenshots, activity summaries, and optional audio for the capture cycle.
2. Capture inputs are processed by the configured provider:
   - the on-device model, which runs inside the app on the user's machine. It is text-only: the client runs the operating system's OCR on the current and previous screenshots and passes that text, optional window text, and activity summaries to the model. Screenshots and audio are not given to the model, and no capture data leaves the device for processing.
   - Google Gemini using the stored Gemini API key, or
   - a user-configured OpenAI-compatible endpoint, which can also point to an LLM running locally on the user's machine. For these two, raw screenshots, optional audio, and optional window text are sent to the configured provider.
3. The model returns text output.
4. The client sends that text output to DoneThat via `inputProcess`.

What DoneThat receives in this flow:

- capture timestamp
- text output derived from screenshots, activity, and optional audio
- processing parameters
- the provider used (`gemini`, `openai-compatible` or `on-device`), with each upload and with the prompt request to `inputConfig`. The prompt request also carries the model name for the on-device model and for an OpenAI-compatible endpoint, so the backend can pick a prompt suited to it. The endpoint URL and API key are never sent.
- optional client telemetry when enabled

What DoneThat does not receive in this flow:

- raw screenshots from the capture cycle
- raw microphone/system-audio payloads
- OCR text, window text, or transcripts

## Cloud Processing Flow

When local processing is not configured, the client uses the cloud capture path.

The client sends `captureScreenshot`:

- capture timestamp
- current screenshots
- previous screenshot context
- activity summaries derived from active-window tracking and idle detection
- optional audio capture payload for the cycle
- optional window text (`uiText`), only while "Active applications" is on
- optional client telemetry when enabled

In this flow, raw screenshots, activity data, and optional audio are sent directly to DoneThat services for processing.

This cloud path is a convenience flow. Backend processing still converges on the same text-output path used by local processing, and raw capture inputs are not stored as persistent backend data.

## Window Text (Accessibility)

Window text is part of the "Active applications" input: it is collected while that setting is on, and managed settings that enforce "Active applications" govern it too. It is not available on Linux.

While it is on, the client reads the accessibility tree of the window in front when an app comes to the front, when it activates a window, and once at the end of each capture cycle. It keeps the app name, the window title, and the names and text of non-editable elements such as labels, headings, buttons, links, and static text. Limits:

- Editable elements (text fields, text areas, combo boxes, spin buttons, documents) contribute only their label. Their value, and any text nested below them, is dropped before anything is buffered, so what you type, including into password fields, is never kept. Values of elements labelled like a password, passcode, secret, or PIN are dropped too.
- Apps and windows matched by your app exclusions are never read, and our own app is skipped.
- Caps: tree depth 20 levels, 300 characters per element, 8,000 characters per cycle. When the cycle cap is hit, the most recent text is kept and older text is dropped (`truncated` is set). The buffer is cleared after each cycle.
- Window text is held in memory only. It is not written to disk (except in the opt-in capture dump) and not logged; logs carry counts and lengths only.

Where it goes:

- Cloud path: sent to `captureScreenshot` as `uiText` with the rest of the cycle. The backend validates and caps it and does not store it.
- Local path: given to the configured provider (on-device model, Gemini, or OpenAI-compatible endpoint) as text. It is never included in what the client sends to `inputProcess`.

Window text is never included in client telemetry. When telemetry is enabled, it carries only two per-cycle numbers: characters available before the cap and characters sent.

## Crash Reports

Crash reporting (Sentry) never attaches screenshots and does not send default PII. Crash events from the on-device model process are dropped before sending.

## On-Device Model Download

The on-device model (Qwen3.5 2B, Q4_K_M GGUF from `unsloth/Qwen3.5-2B-GGUF`, Apache-2.0) is downloaded only when you click Download in settings.

- Source: `huggingface.co`, at a pinned repository revision. Redirects are only followed to Hugging Face hosts (`*.huggingface.co`, `*.hf.co`).
- Request: a plain file download. No account, token, user data, or capture data is sent.
- Integrity: the file size and SHA-256 hash are pinned in the client ([src-main/localModel/modelInfo.js](../src-main/localModel/modelInfo.js)). The file is only used after the hash matches.
- Storage: the model is kept in the app's user-data folder and can be deleted from settings.

The inference runtime (`node-llama-cpp` with prebuilt llama.cpp binaries) ships inside the app and never downloads or builds binaries at runtime.

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
- Read [src-main/captureUiText.js](../src-main/captureUiText.js) for window-text collection and [src-main/localModel/](../src-main/localModel/) for the on-device model download and runtime.
- Read [src-main/main-state.js](../src-main/main-state.js) for token handling and persisted capture-related settings.

Useful checks:

- Search for `captureScreenshot`, `inputProcess`, and `inputConfig`.
- Search for `uiText` to see where window text is collected and sent.
- Search for `huggingface.co` to see the only host used for the model download.
- Search for `clientTelemetry` to see where diagnostic payloads are attached.
- Search for `app.donethat.ai` and `checkout.stripe.com` to inspect embedded web flows.

What you cannot verify from this repository alone:

- backend retention policies
- backend-side processing details
- backend database/storage behavior
- web-app internals behind `app.donethat.ai`

For retention, deletion, and broader data-handling details, see [donethat.ai/data](https://donethat.ai/data).

For security reporting, use [SECURITY.md](../SECURITY.md). For support scope, use [SUPPORT.md](../SUPPORT.md).
