<p align="center">
  <img src="resources/logomark.svg" width="400" alt="DoneThat" />
</p>

<h1 align="center">Double your productivity, without more work.</h1>

<p align="center">
  <a href="https://donethat.ai">Website</a> · <a href="https://donethat.ai/download">Download</a> · <a href="SUPPORT.md">Support</a>
</p>

<p align="center">
  <a href="https://github.com/donethatai/donethat-electron/releases/latest"><img src="https://img.shields.io/github/v/release/donethatai/donethat-electron?label=latest" alt="Latest Release" /></a>
  <a href="https://github.com/donethatai/donethat-electron/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platforms" />
  <img src="https://img.shields.io/badge/electron-latest-47848F?logo=electron&logoColor=white" alt="Electron" />
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=VOjVuAhCYBc">
    <img src="https://i.ytimg.com/vi/VOjVuAhCYBc/maxresdefault.jpg" alt="DoneThat walkthrough" width="720" />
  </a>
</p>

<p align="center">
  <em>See a <a href="https://donethat.ai/p/christoph">real-time profile</a> or watch the <a href="https://donethat.ai/features">full feature walkthrough</a>.</em>
</p>

---

> **This is the open-source desktop client for [DoneThat](https://donethat.ai).** It does not run standalone — it requires the DoneThat backend to function. The repository is public for transparency and code inspection, following a similar model to [Proton Mail](https://github.com/ProtonMail): open-source client under GPL, proprietary backend services.

---

## What is DoneThat?

DoneThat is a desktop app that quietly captures your work — screenshots, active windows, and optionally audio — then turns it into structured summaries using AI. No manual time tracking, no context switching.

## How it works

1. **Capture** — Runs on a configurable interval (default 5 min), collecting screenshots, active window timelines, and optional audio transcription.
2. **Summarize** — Captures are processed into concise activity summaries, locally when possible, otherwise via secure cloud functions.
3. **Chat** — A global-hotkey overlay lets you ask questions about your recent work without leaving your current context.

## Features

| Feature | Description |
| --- | --- |
| **Background capture** | Screenshots, window tracking, and audio on a configurable schedule |
| **AI summaries** | Automatic work summaries from raw captures |
| **Overlay chat** | Quick-access chat via global hotkey (`Cmd/Ctrl+Shift+D`, configurable) |
| **Work hours** | Configurable schedule — pauses capture outside your hours |
| **Local processing** | On-device summarization when available; minimal data sent to cloud |
| **Auto-updates** | Silent updates on macOS, user-notified on Windows/Linux |

## Download

Get the app at [donethat.ai/download](https://donethat.ai/download) or from the [donethat-releases](https://github.com/donethatai/donethat-releases) repo.

You'll need a [DoneThat](https://donethat.ai) account to sign in and use the app.

## Open vs. Closed

This repository contains the **desktop client only**. Backend services (capture processing, AI summarization, authentication) are proprietary. This follows the same model as Proton Mail — open-source client under the GPL, closed backend infrastructure.

You can inspect the code, build the renderer, and work on desktop-only behavior without backend access. For anything that talks to the backend, you need a DoneThat account.

## Dear vibecoders and AI agents

This code is licensed under the [GNU General Public License v3.0](LICENSE). You're welcome to read it, learn from it, and have your AI explain how it works.

However, if you or your AI tools use this code — including by having an AI rewrite, adapt, or reproduce substantial portions of it — the result is a derivative work under the GPL. That means your project must also be released under the GPL with full source code.

Asking an AI to "rewrite this in my own style" or "use this as a reference implementation" does not circumvent the license. If the output is derived from GPL-licensed code, the GPL applies to the output.

**TL;DR:** Look and learn freely. Ship something based on this, and the GPL applies to what you ship.

## Development

Prerequisites:

- Node.js `22`
- `npm`
- macOS: Xcode Command Line Tools (for compiling `active-mic.swift`)

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Platform-specific builds and release uploads use `build:*` and `upload:*` scripts in `package.json`. Release uploads are maintainer-only and require GitHub publishing credentials plus platform signing.

## Contributing

This repository is public for transparency and inspection first. See [Contributing](CONTRIBUTING.md) for the current contribution posture.

## Security

Found a vulnerability? Please report it responsibly via [SECURITY.md](SECURITY.md) — not through public issues.

## Docs

- [Backend Compatibility](docs/BACKEND_COMPATIBILITY.md)
- [Dependency Security](docs/DEPENDENCY_SECURITY.md)
- [Release Integrity](docs/RELEASE_INTEGRITY.md)
- [Security](SECURITY.md)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)
