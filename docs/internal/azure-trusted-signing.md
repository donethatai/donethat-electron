# Azure Trusted Signing Setup for DoneThat

> Internal maintainer release doc. This is only useful for maintainers managing Windows code-signing credentials and release infrastructure.

This document explains how to set up Azure Trusted Signing (rebranded "Artifact Signing" as of January 2026) for the DoneThat Windows builds.

## Constants

These values are non-sensitive and are hardcoded in `.github/workflows/build.yml`:

- Trusted Signing account: `DoneThat`
- Certificate profile: `Letss` (Public Trust)
- Region: West Europe (`https://weu.codesigning.azure.net`)

## One-time Azure setup

1. Create or reuse a Microsoft Entra ID app registration / service principal that will represent CI.
2. On that app registration, add a federated identity credential:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Audience: `api://AzureADTokenExchange`
   - Subject: `repo:donethatai/donethat-electron:ref:refs/heads/main`
3. Assign the SP the `Artifact Signing Certificate Profile Signer` role (formerly `Trusted Signing Certificate Profile Signer`) on the `DoneThat / Letss` certificate profile.
4. Capture the tenant ID, client ID (the app registration's Application ID), and subscription ID for the next step.

The release workflow only runs on `main` (see `.github/workflows/build.yml`), so a single `ref:refs/heads/main` subject is enough. Add more subjects only if you start releasing from other branches or tags.

## GitHub repository secrets

Add the following secrets (or repository variables) in the GitHub repository settings:

| Name | Description |
|------|-------------|
| `AZURE_TENANT_ID` | Microsoft Entra ID tenant ID |
| `AZURE_CLIENT_ID` | App registration / service principal client ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID containing the Trusted Signing account |

No client secret is stored: the workflow authenticates via OIDC federated identity through `azure/login@v2`.

## How it works

1. The workflow grants `id-token: write` and runs `azure/login@v2` on Windows runners with the OIDC token.
2. A setup step downloads `nuget.exe`, installs the `Microsoft.ArtifactSigning.Client` NuGet package, locates the matching `Azure.CodeSigning.Dlib.dll` for the runner architecture, writes a `metadata.json` (Endpoint + account + profile), and adds `signtool.exe` from the Windows 10/11 SDK to `PATH`.
3. `electron-builder` invokes `scripts/azure-sign-windows.js` once per artifact via its `signtoolOptions.sign` callback.
4. The script runs `signtool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib <dlib> /dmdf <metadata.json> <file>` and then `signtool verify /pa /v <file>`.
5. The Trusted Signing dlib uses `DefaultAzureCredential`, which picks up the workload identity established by `azure/login@v2`.

## Local signing (optional)

Local Windows signing is skipped unless `SIGN_WINDOWS=true` is set. To exercise signing locally:

1. Install the Trusted Signing Client Tools via WinGet: `winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`.
2. `az login` as a principal that has the `Artifact Signing Certificate Profile Signer` role on `DoneThat / Letss`.
3. Set `AZURE_SIGN_DLIB` to the dlib path (e.g. inside the WinGet install) and `AZURE_SIGN_METADATA` to a metadata.json you create with the constants above.
4. Run a Windows build with `SIGN_WINDOWS=true` (e.g. `set SIGN_WINDOWS=true && npm run build:win:x64`).

## Troubleshooting

- `403 Forbidden` from the signing endpoint usually means the region URI does not match where the account was created, the SP is missing the signer role, or the federated subject does not match the running ref.
- `signtool.exe not found` -> the workflow setup step could not locate the Windows SDK signtool for the matrix arch. Verify the runner image still ships the Windows 10/11 SDK.
- `Azure.CodeSigning.Dlib.dll not found for arch` -> the `Microsoft.ArtifactSigning.Client` package layout changed or does not ship a binary for the matrix arch. Inspect `$RUNNER_TEMP/artsign/Microsoft.ArtifactSigning.Client/bin/`.
- For more detail, see [Set up signing integrations to use Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/how-to-signing-integrations).
