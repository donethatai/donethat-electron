# DigiCert Code Signing Setup for DoneThat

> Internal maintainer release doc. This is only useful for maintainers managing Windows code-signing credentials and release infrastructure.

This document explains how to set up DigiCert KeyLocker code signing for the DoneThat application on Windows.

## Prerequisites

1. DigiCert KeyLocker account
2. DigiCert ONE API key
3. Client authentication certificate
4. Code signing certificate

## GitHub Secrets Setup

The following GitHub secrets must be configured in your repository:

| Secret Name | Description |
|-------------|-------------|
| `SM_HOST` | DigiCert ONE host URL (e.g., `https://one.digicert.com`) |
| `SM_API_KEY` | DigiCert ONE API key |
| `SM_CLIENT_CERT_FILE_B64` | Base64-encoded client authentication certificate (.p12 file) |
| `SM_CLIENT_CERT_PASSWORD` | Password for the client authentication certificate |
| `SM_CODE_SIGNING_CERT_SHA1_HASH` | SHA1 fingerprint of your code signing certificate |

## How to Generate Required Values

### Creating an API Token

1. Sign in to DigiCert ONE
2. Select the profile icon (top-right)
3. Select Admin Profile
4. Scroll down to API Tokens
5. Select Create API token
6. Store the token securely - it will only be shown once

### Creating a Client Authentication Certificate

1. Sign in to DigiCert ONE
2. Select the profile icon (top-right)
3. Select Admin Profile
4. Scroll down to Authentication certificates
5. Select Create authentication certificate
6. Download the certificate and note the password
7. Convert the certificate to base64 using:

**Windows:**
```powershell
$fileContentBytes = get-content 'YOURFILEPATH.p12' -Encoding Byte
[System.Convert]::ToBase64String($fileContentBytes)
```

**macOS/Linux:**
```bash
base64 -i certificate_file_name.p12
```

### Getting the Certificate Fingerprint

1. In DigiCert ONE, navigate to Code Signing → Certificates
2. Find your certificate and view its details
3. Copy the SHA1 fingerprint

## How It Works

1. The GitHub workflow installs DigiCert client tools
2. Your client certificate is decoded and stored securely
3. Environment variables are set up for the signing process
4. The custom signing script (`scripts/digicert-sign-windows.js`) is executed during the build process

## Troubleshooting

If signing fails, check the workflow logs for detailed error messages. Common issues include:

- Invalid or expired certificates
- Incorrect API key or host
- Missing or incorrectly formatted environment variables
- Permission issues with the DigiCert KeyLocker account

For more detailed information, refer to the [DigiCert KeyLocker documentation](https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-piplelines/plugins/github/install-client-tools-for-standard-keypair-signing-on-github.html). 
