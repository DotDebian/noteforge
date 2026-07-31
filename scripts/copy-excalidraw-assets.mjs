#!/usr/bin/env node
/**
 * Copy Excalidraw's runtime font assets into `public/excalidraw/`.
 *
 * Excalidraw resolves its handwriting fonts (Excalifont, Virgil, Cascadia,
 * Xiaolai…) at runtime from `window.EXCALIDRAW_ASSET_PATH`, falling back to
 * `https://esm.sh/@excalidraw/excalidraw@<v>/dist/prod/` when that global is
 * unset. NoteForge is self-hosted behind a reverse proxy and must not phone
 * home for fonts, so `WhiteboardNodeView.vue` pins the global to
 * `/excalidraw/` and this script puts the files there.
 *
 * The copy is generated, not committed (`public/excalidraw/` is gitignored) —
 * it runs from the `dev` and `build` npm scripts so both the local server and
 * the Docker image get it. Re-running is cheap: identical files are skipped.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Resolve the installed package's `dist/prod` without hard-coding a pnpm store
 * path. The package's `exports` map deliberately shadows `./package.json`, so
 * we resolve the main entry (`dist/prod/index.js`) and walk up from there.
 */
function excalidrawDistDir() {
  return dirname(require.resolve('@excalidraw/excalidraw'))
}

async function main() {
  const dist = excalidrawDistDir()
  const src = join(dist, 'fonts')
  if (!existsSync(src)) {
    console.error(`[excalidraw-assets] fonts not found at ${src} — did pnpm install run?`)
    process.exitCode = 1
    return
  }

  const version = JSON.parse(
    await readFile(join(dist, '..', '..', 'package.json'), 'utf-8'),
  ).version
  const stamp = createHash('sha256').update(`${version}:${src}`).digest('hex').slice(0, 16)

  const outDir = join(root, 'public', 'excalidraw')
  const stampFile = join(outDir, '.assets-version')

  if (existsSync(stampFile) && (await readFile(stampFile, 'utf-8')).trim() === stamp) {
    console.log(`[excalidraw-assets] up to date (v${version})`)
    return
  }

  await mkdir(outDir, { recursive: true })
  await cp(src, join(outDir, 'fonts'), { recursive: true, force: true })
  await writeFile(stampFile, `${stamp}\n`, 'utf-8')
  console.log(`[excalidraw-assets] copied fonts for @excalidraw/excalidraw@${version} → public/excalidraw/fonts`)
}

await main()
