/**
 * Legacy in-note whiteboard block — PARSE AND RENDER ONLY.
 *
 * Drawings are standalone documents now (`documents.type = 'excalidraw'`, see
 * `ExcalidrawEditor.vue`). There is deliberately **no insert command and no
 * slash-command entry**: a drawing buried inside a note could not be reached by
 * MCP, bloated the note it lived in, and had no identity of its own.
 *
 * What remains is the read path. Notes authored before the change still carry
 * `<div class="whiteboard" data-scene="…" data-preview="…">`, whose `data-scene`
 * is a Konva layer graph — Konva is no longer a dependency, so the node view
 * renders the stored `data-preview` PNG read-only and offers to convert the
 * block into a plain markdown image.
 *
 * Round-trip (unchanged, so old notes survive an edit + save untouched):
 *   - markdown / HTML  `<div class="whiteboard" data-scene="…" data-w="800" data-h="480"></div>`
 *       → marked passes raw HTML blocks through verbatim.
 *       → parseHTML grabs `data-scene` / `data-w` / `data-h` into attrs.
 *   - editor → renderHTML emits the same div.
 *           → turndown rule (in `useEditorMarkdown.ts`) re-emits the HTML.
 *
 * `data-preview` (a PNG data URL) is also what the PDF / DOCX exporters embed
 * for these blocks — see `server/utils/export-pdf.ts`.
 */
import { Node, mergeAttributes, VueNodeViewRenderer } from '@tiptap/vue-3'
import WhiteboardNodeView from '../WhiteboardNodeView.vue'

export interface WhiteboardAttributes {
  scene: string
  width: number
  height: number
  preview: string
}

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 480

function parsePositiveInt(v: string | null, fallback: number): number {
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const Whiteboard = Node.create({
  name: 'whiteboard',
  group: 'block',
  // Atom: the editor never selects into the canvas; the NodeView owns its
  // own keyboard / pointer surface.
  atom: true,
  selectable: true,
  // NOTE: `draggable: false` is intentional. With `draggable: true`,
  // ProseMirror starts a node-drag the instant the user presses on the
  // whiteboard area — which is exactly the gesture they use to draw,
  // so every stroke would turn into a browser image-drag. Disabling the
  // PM drag here lets pointerdown reach the Excalidraw canvas cleanly.
  // Users can still reorder the node via cut/paste.
  draggable: false,
  defining: true,

  addAttributes() {
    return {
      scene: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-scene') ?? '',
        renderHTML: (attrs) => {
          const s = (attrs as WhiteboardAttributes).scene ?? ''
          return s.length > 0 ? { 'data-scene': s } : {}
        },
      },
      width: {
        default: DEFAULT_WIDTH,
        parseHTML: (el) => parsePositiveInt(el.getAttribute('data-w'), DEFAULT_WIDTH),
        renderHTML: (attrs) => {
          const w = (attrs as WhiteboardAttributes).width ?? DEFAULT_WIDTH
          return { 'data-w': String(w) }
        },
      },
      height: {
        default: DEFAULT_HEIGHT,
        parseHTML: (el) => parsePositiveInt(el.getAttribute('data-h'), DEFAULT_HEIGHT),
        renderHTML: (attrs) => {
          const h = (attrs as WhiteboardAttributes).height ?? DEFAULT_HEIGHT
          return { 'data-h': String(h) }
        },
      },
      preview: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-preview') ?? '',
        renderHTML: (attrs) => {
          const p = (attrs as WhiteboardAttributes).preview ?? ''
          // Avoid bloating the markdown — only persist when set.
          return p.length > 0 ? { 'data-preview': p } : {}
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div.whiteboard' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'whiteboard' }),
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(WhiteboardNodeView)
  },
})
