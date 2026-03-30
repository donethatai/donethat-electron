# DoneThat Desktop

Open-source desktop client for DoneThat work capture and summaries.

## Development Prerequisites

- Node.js `22` (matches the CI environment)
- `npm`
- On macOS, Xcode Command Line Tools are required because local setup/build steps may compile `src-os/macos/active-mic.swift` via `xcrun swiftc`
- Desktop build targets in this repository are macOS, Windows, and Linux

## Development

- `npm install`
- `npm run dev`

## Build

- `npm run build`
- Platform builds: use `build:*` scripts in `package.json`
- Release uploads: use `upload:*` scripts in `package.json`
- Release uploads are maintainer-only and require GitHub publishing credentials plus platform signing credentials

## Open vs Closed

This repository contains the desktop client only. Hosted backend services and APIs remain proprietary. Client behavior that depends on remote services is limited to published endpoints and API compatibility.

Primary backend dependencies:
- `https://*.cloudfunctions.net`
- `https://app.donethat.ai`
- `https://identitytoolkit.googleapis.com`
- `https://securetoken.googleapis.com`

## Local Development Notes

You can run tests, build the renderer bundle, and work on most desktop-only behavior without proprietary backend access.

For backend-integrated testing, use your own account or create a dedicated test account.

You should expect limited or unavailable behavior for:

- sign-in against production-compatible services
- embedded portal flows from `app.donethat.ai`
- capture uploads and backend-produced summaries
- backend-managed local-processing config and result submission

## Contributions

This repository is public for transparency and inspection first. See [Contributing](CONTRIBUTING.md) for the current contribution posture.

## Project Docs

- [Backend Compatibility](docs/BACKEND_COMPATIBILITY.md)
- [Dependency Security](docs/DEPENDENCY_SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Release Integrity](docs/RELEASE_INTEGRITY.md)
- [Security](SECURITY.md)
- [Support](SUPPORT.md)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)
