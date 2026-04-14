<p align="center">
  <img src="resources/logomark.svg" width="300" alt="DoneThat" />
</p>

<h1 align="center">Double your productivity, without more work.</h1>

<p align="center">
  <a href="https://donethat.ai">Website</a> · <a href="https://donethat.ai/download">Download</a> · <a href="SUPPORT.md">Support</a>
</p>

<p align="center">
  <a href="https://github.com/donethatai/donethat-electron/releases/latest"><img src="https://img.shields.io/github/v/release/donethatai/donethat-electron?label=latest" alt="Latest Release" /></a>
  <a href="https://github.com/donethatai/donethat-electron/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg" alt="License" /></a>
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

> **This is the open-source desktop client for [DoneThat](https://donethat.ai).** It does not run standalone. It requires the DoneThat backend to function. The repository is public for transparency and code inspection, following a similar model to [Proton Mail](https://github.com/ProtonMail): open-source client under GPL, proprietary backend services.

---

## What is DoneThat?

DoneThat is an automated work tracker and productivity coach. It reconstructs your work from activity on your device, turns that into summaries and structured history, and uses that history for review, reporting, and coaching.

No timers, no manual logging, no end-of-week guessing.

## How it works

### Capture

The desktop app runs quietly in the background. Every five minutes it collects screenshots, an active window timeline, and optionally audio transcription. Raw inputs are processed in real time and discarded, not stored. You control when capture runs through work hours, manual pause, and per-app exclusions. See [data privacy measures](https://donethat.ai/data) for details.

### Summarize

At the end of each day, either when you click "Finish Day" or automatically around midnight, your activity is turned into a structured summary: tasks with titles, descriptions, and classifications. You can review and edit before finalizing. Tasks are automatically grouped into projects and visible on a calendar view.

### Coach

Don is the built-in AI coach. He reviews your work patterns, helps you set goals, spots drift and overload, and nudges you when you go off track. You pick the coaching style that works for you.

### Share

Summaries can stay fully private or be shared with followers, teammates, or your organization. Share via the app, Slack, or email. Visibility is private by default and always under your control.

### Chat

A global-hotkey overlay (`Cmd/Ctrl+Shift+D`, configurable) gives you quick access to ask questions about your work, search your history, or get help without leaving your current context.

## Download

Get the app at [donethat.ai/download](https://donethat.ai/download) or from the [donethat-releases](https://github.com/donethatai/donethat-releases) repo.

You'll need a [DoneThat](https://donethat.ai) account to sign in and use the app.

## Open vs. Closed

This repository contains the **desktop client only**. The [GPL-3.0 license](LICENSE) applies exclusively to the source code in this repository. No other DoneThat code, service, or infrastructure is covered by this license.

This follows the same model as [Proton Mail](https://github.com/ProtonMail): open-source client under the GPL, closed backend infrastructure.

You can inspect the code, build the renderer, and work on desktop-only behavior without backend access. For anything that talks to the backend, you need a DoneThat account.

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

Found a vulnerability? Please report it responsibly via [SECURITY.md](SECURITY.md), not through public issues.

## Docs

- [Backend Compatibility](docs/BACKEND_COMPATIBILITY.md)
- [Dependency Security](docs/DEPENDENCY_SECURITY.md)
- [Release Integrity](docs/RELEASE_INTEGRITY.md)
- [Security](SECURITY.md)
- [Third-Party Notices](docs/THIRD_PARTY_NOTICES.md)
