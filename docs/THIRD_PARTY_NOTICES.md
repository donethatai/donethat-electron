# Third-Party Notices

This project uses third-party open-source dependencies. All production dependency licenses are compatible with GPL-3.0-or-later. License terms are provided by each dependency in its `node_modules` directory.

## Production Dependency License Summary

| License | Count |
|---------|-------|
| MIT | 277 |
| Apache-2.0 | 72 |
| ISC | 60 |
| BSD-3-Clause | 15 |
| BlueOak-1.0.0 | 11 |
| BSD-2-Clause | 3 |
| MIT* | 2 |
| Python-2.0 | 1 |
| GPL-3.0-or-later | 1 |
| MPL-2.0 | 1 |
| (MIT AND Zlib) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |

## Notable Non-MIT/Apache/BSD Licenses

- **MPL-2.0**: `mediabunny`. MPL-2.0 is compatible with GPLv3 under Section 3 of the MPL.
- **BlueOak-1.0.0**: `chownr`, `isexe` (two versions), `jackspeak`, `minipass`, `minipass-flush`, `package-json-from-dist`, `path-scurry`, `sax`, `tar`, `yallist`. Permissive license, GPL-compatible.
- **Python-2.0**: `argparse`. Permissive license, GPL-compatible.
- **GPL-3.0-or-later**: `donethat`. Project package included in the license-checker output.
- **0BSD**: `tslib`. Permissive license, GPL-compatible.

Platform-specific native packages (for example `@node-llama-cpp/*`, `@napi-rs/system-ocr-*`, `@crowecawcaw/xa11y-*`) are MIT and differ per operating system; the counts above were taken on macOS arm64.

## Bundled Native Binaries

- **llama.cpp / ggml** (MIT): prebuilt inference libraries shipped through the `@node-llama-cpp/*` packages.

## Downloaded Model Weights

The optional on-device model is not bundled; it is downloaded only when the user requests it.

- **Qwen3.5 2B GGUF** (`unsloth/Qwen3.5-2B-GGUF`, file `Qwen3.5-2B-Q4_K_M.gguf`): Apache-2.0. GGUF conversion by Unsloth of the Qwen3.5 model by the Qwen team (Alibaba Cloud).

## Refresh

```
npx license-checker --production --summary
```
