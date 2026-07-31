/**
 * Excalidraw resolves its handwriting fonts at runtime from this global,
 * falling back to a public esm.sh URL when it is unset. `WhiteboardNodeView`
 * pins it to `/excalidraw/` (populated by `scripts/copy-excalidraw-assets.mjs`)
 * so a self-hosted NoteForge never fetches assets from a third party.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

/**
 * The package's `exports` map routes every subpath to a `.d.ts` under
 * `dist/types/`, which leaves the stylesheet subpath without a declaration.
 * It is imported for its side effect only.
 */
declare module '@excalidraw/excalidraw/index.css' {
  const css: string
  export default css
}

export {}
