# GitHub Actions Setup for DoneThat Electron App

This document explains how to set up the GitHub Actions workflow to build your Electron app.

## Setting Up GitHub Secrets

For the GitHub Actions workflow to work properly, you need to set up several secrets in your GitHub repository:

1. Go to your GitHub repository
2. Click on "Settings" tab
3. In the left sidebar, click on "Secrets and variables" → "Actions"
4. Click "New repository secret" to add each of the following secrets:

### For macOS Builds

- `APPLE_ID`: Your Apple Developer ID email
- `APPLE_ID_PASSWORD`: An app-specific password for your Apple ID
- `APPLE_APP_SPECIFIC_PASSWORD`: An app-specific password generated for notarization
- `APPLE_TEAM_ID`: Your Apple Developer Team ID
- `MAC_CERTIFICATE`: Base64-encoded developer certificate (p12 file)
- `MAC_CERTIFICATE_PASSWORD`: Password for the certificate

### For Windows Builds

Windows builds are signed via Azure Trusted Signing using OIDC federated identity (no client secret stored).

- `AZURE_TENANT_ID`: Microsoft Entra ID tenant ID
- `AZURE_CLIENT_ID`: Service principal / app registration client ID
- `AZURE_SUBSCRIPTION_ID`: Subscription containing the Trusted Signing account

The service principal must have a federated identity credential trusting `repo:donethatai/donethat-electron:ref:refs/heads/main` and the `Artifact Signing Certificate Profile Signer` role on the `DoneThat / Letss` profile. See [`docs/internal/azure-trusted-signing.md`](../docs/internal/azure-trusted-signing.md) for full setup steps.

Note: Windows builds will work without code signing, but users may see security warnings.

## How to Run the Workflow

1. Go to your GitHub repository
2. Click on the "Actions" tab
3. In the left sidebar, click on "Build and Release"
4. Click on "Run workflow"
5. Enter a version number if needed (or leave blank to use the one in package.json)
6. Click "Run workflow"

The workflow will build your app for macOS, Windows, and Linux (x64 architectures) and create a draft GitHub release with all the files.

## Building for ARM Architectures

For ARM architectures:

- For Linux ARM64: Uncomment the relevant section in the workflow file once GitHub's ARM64 runners are stable
- For macOS ARM64 (Apple Silicon): Build locally using `npm run upload:mac:arm64`
- For Windows ARM64: Build locally if you have a Windows ARM device

## Notes

- The `GH_TOKEN` is automatically provided by GitHub Actions
- You can monitor the build progress in the Actions tab
- All build artifacts will be available as GitHub release assets