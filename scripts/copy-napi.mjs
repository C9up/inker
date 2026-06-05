// PATTERN: copy-and-rename for 55.2/55.3/55.4 — Rust hot-path packages.
// Mirrors packages/sigil/scripts/copy-napi.mjs verbatim modulo the crate name.
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const suffixMap = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

const suffix = suffixMap[`${platform}-${arch}`]
if (!suffix) {
  throw new Error(`[inker:napi] unsupported platform/arch: ${platform}-${arch}`)
}

const candidates = platform === 'win32'
  ? [
      join(root, 'target', 'release', 'inker_engine_napi.dll'),
      join(root, 'target', 'release', 'libinker_engine_napi.dll'),
    ]
  : platform === 'darwin'
  ? [join(root, 'target', 'release', 'libinker_engine_napi.dylib')]
  : [join(root, 'target', 'release', 'libinker_engine_napi.so')]

const source = candidates.find((candidate) => existsSync(candidate))
if (!source) {
  throw new Error(
    `[inker:napi] native library not found. Looked for:\n${candidates.map((p) => `- ${p}`).join('\n')}`,
  )
}

const target = join(root, `index.${suffix}.node`)
copyFileSync(source, target)
console.log(`[inker:napi] copied ${source} -> ${target}`)
