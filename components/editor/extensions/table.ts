/**
 * GFM-style editable tables. Uses Tiptap's official table extensions —
 * `@tiptap/extension-table` (the container), plus `TableRow`, `TableHeader`,
 * `TableCell`.
 *
 * Round-trip:
 *   - markdown  `| h1 | h2 |\n|---|---|\n| a | b |`
 *                 → marked (GFM tables are on) emits the standard
 *                   `<table><thead><tr><th>…</th></tr></thead><tbody>…</tbody></table>`.
 *                 → Tiptap parses that into our Table / TableRow / TableHeader /
 *                   TableCell nodes.
 *   - editor    → renderHTML re-emits the same HTML shell.
 *                 → A turndown rule registered in `useEditorMarkdown.ts`
 *                   reconverts the table back to GFM pipe syntax (cells can
 *                   carry bold / italic / etc).
 */
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'

// The default TableCell ships only with `colspan` / `rowspan` / `colwidth`
// attributes. We extend it with a `textAlign` attribute so the toolbar's
// "set cell align" buttons can persist alignment through the markdown
// round-trip (GFM pipe tables encode alignment via `:---:` / `:---` / `---:`
// hints under the header separator).
const AlignableTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null as 'left' | 'center' | 'right' | null,
        parseHTML: (el) => {
          const style = (el.getAttribute('style') ?? '').toLowerCase()
          const m = style.match(/text-align\s*:\s*(left|center|right)/)
          if (m && m[1]) return m[1]
          const inline = (el.getAttribute('align') ?? '').toLowerCase()
          if (inline === 'left' || inline === 'center' || inline === 'right') return inline
          return null
        },
        renderHTML: (attrs) => {
          const a = (attrs as { textAlign?: string | null }).textAlign
          if (a !== 'left' && a !== 'center' && a !== 'right') return {}
          return { style: `text-align: ${a}` }
        },
      },
    }
  },
})

const AlignableTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null as 'left' | 'center' | 'right' | null,
        parseHTML: (el) => {
          const style = (el.getAttribute('style') ?? '').toLowerCase()
          const m = style.match(/text-align\s*:\s*(left|center|right)/)
          if (m && m[1]) return m[1]
          const inline = (el.getAttribute('align') ?? '').toLowerCase()
          if (inline === 'left' || inline === 'center' || inline === 'right') return inline
          return null
        },
        renderHTML: (attrs) => {
          const a = (attrs as { textAlign?: string | null }).textAlign
          if (a !== 'left' && a !== 'center' && a !== 'right') return {}
          return { style: `text-align: ${a}` }
        },
      },
    }
  },
})

export const TableKit = [
  Table.configure({
    resizable: true,
    lastColumnResizable: true,
    HTMLAttributes: { class: 'editor-table' },
    // Allow tables inside the document body. Default behaviour.
    allowTableNodeSelection: true,
  }),
  TableRow,
  AlignableTableHeader,
  AlignableTableCell,
]
