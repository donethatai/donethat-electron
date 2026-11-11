// The one on-device model the app ships support for. Swap the model by editing
// this constant only: everything else (download, verification, inference)
// reads from it.

const MODEL_REPO = 'unsloth/Qwen3.5-2B-GGUF'
const MODEL_REVISION = 'f6d5376be1edb4d416d56da11e5397a961aca8ae'
const MODEL_FILE_NAME = 'Qwen3.5-2B-Q4_K_M.gguf'

const MODEL = Object.freeze({
  id: 'qwen3.5-2b-q4_k_m',
  name: 'Qwen3.5 2B',
  license: 'Apache-2.0',
  repo: MODEL_REPO,
  revision: MODEL_REVISION,
  fileName: MODEL_FILE_NAME,
  sizeBytes: 1280835840,
  sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
  url: `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE_NAME}`
})

// Prompt budget: ~6k tokens of instructions + screen/window text, up to 1000
// tokens of JSON out, plus chat-template overhead. 8192 covers that with ~1k
// tokens of headroom; Qwen3.5's hybrid attention keeps the KV cache for this
// small, so a larger window would only cost memory.
const CONTEXT_SIZE = 8192
const MAX_OUTPUT_TOKENS = 1000
const PROMPT_TOKEN_MARGIN = 64
const MAX_PROMPT_TOKENS = CONTEXT_SIZE - MAX_OUTPUT_TOKENS - PROMPT_TOKEN_MARGIN

const DEFAULT_TEMPERATURE = 0.2
const IDLE_UNLOAD_MS = 10 * 60 * 1000

// huggingface.co serves the file; its /resolve/ endpoint redirects to its own
// CDNs (cdn-lfs*.huggingface.co, cas-bridge.xethub.hf.co).
const ALLOWED_DOWNLOAD_HOST_SUFFIXES = ['huggingface.co', 'hf.co']

function isAllowedDownloadUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch (error) {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return ALLOWED_DOWNLOAD_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
}

module.exports = {
  MODEL,
  CONTEXT_SIZE,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS,
  DEFAULT_TEMPERATURE,
  IDLE_UNLOAD_MS,
  isAllowedDownloadUrl
}
