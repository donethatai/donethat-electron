# Third-Party Notices

This project uses third-party open-source dependencies. All production dependency licenses are compatible with GPL-3.0. License terms are provided by each dependency in its `node_modules` directory.

## Production Dependency License Summary

| License | Count |
|---------|-------|
| MIT | 202 |
| ISC | 59 |
| Apache-2.0 | 57 |
| BSD-3-Clause | 16 |
| BlueOak-1.0.0 | 8 |
| BSD-2-Clause | 3 |
| MPL-2.0 | 1 |
| Python-2.0 | 1 |
| 0BSD | 1 |
| (MIT AND Zlib) | 1 |
| (MIT OR CC0-1.0) | 1 |

## Notable Non-MIT/Apache/BSD Licenses

- **MPL-2.0**: `mediabunny` (and its transitive `lightningcss` / `lightningcss` platform packages). MPL-2.0 is compatible with GPLv3 under Section 3 of the MPL.
- **BlueOak-1.0.0**: `chownr`, `jackspeak`, `minipass`, `package-json-from-dist`, `path-scurry`, `sax`, `tar`, `yallist`. Permissive license, GPL-compatible.
- **Python-2.0**: `argparse`. Permissive license, GPL-compatible.
- **0BSD**: `tslib`. Permissive license, GPL-compatible.

## Refresh

```
npx license-checker --production --summary
```
