# Third-Party Notices

This project uses third-party open-source dependencies. All production dependency licenses are compatible with GPL-3.0-or-later. License terms are provided by each dependency in its `node_modules` directory.

## Production Dependency License Summary

| License | Count |
|---------|-------|
| MIT | 210 |
| Apache-2.0 | 68 |
| ISC | 60 |
| BSD-3-Clause | 17 |
| BlueOak-1.0.0 | 8 |
| MIT* | 4 |
| BSD-2-Clause | 4 |
| Python-2.0 | 1 |
| GPL-3.0-or-later | 1 |
| MPL-2.0 | 1 |
| (MIT AND Zlib) | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |

## Notable Non-MIT/Apache/BSD Licenses

- **MPL-2.0**: `mediabunny`. MPL-2.0 is compatible with GPLv3 under Section 3 of the MPL.
- **BlueOak-1.0.0**: `chownr`, `jackspeak`, `minipass`, `package-json-from-dist`, `path-scurry`, `sax`, `tar`, `yallist`. Permissive license, GPL-compatible.
- **Python-2.0**: `argparse`. Permissive license, GPL-compatible.
- **GPL-3.0-or-later**: `donethat`. Project package included in the license-checker output.
- **0BSD**: `tslib`. Permissive license, GPL-compatible.

## Refresh

```
npx license-checker --production --summary
```
