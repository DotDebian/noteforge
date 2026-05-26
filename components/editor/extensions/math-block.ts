/**
 * Block LaTeX math node. Like its inline sibling, an atom whose NodeView
 * renders KaTeX in display mode by default and swaps to a textarea source
 * editor when selected / clicked.
 *
 * Round-trip:
 *   - markdown  `$$E=mc^2$$`  →  `markdownToHtml` (marked extension)
 *                              →  `<div class="math-block" data-formula="E=mc^2"></div>`
 *                              →  parseHTML pulls `data-formula` into attrs.formula
 *   - editor    attrs.formula
 *                              →  renderHTML emits the same div
 *                              →  `htmlToMarkdown` (turndown rule) re-emits `$$…$$`
 */
import { Node, mergeAttributes, VueNodeViewRenderer } from '@tiptap/vue-3'
import MathBlockNodeView from '../MathBlockNodeView.vue'

export interface MathBlockAttributes {
  formula: string
}

declare module '@tiptap/vue-3' {
  interface Commands<ReturnType> {
    mathBlock: {
      /**
       * Insert a block math node at the current selection. Replaces the
       * selection (if any) with a single `mathBlock` node on its own line.
       */
      insertMathBlock: (formula?: string) => ReturnType
    }
  }
}

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  // Block-level atom: top-level, not nested inside paragraphs, no editable text.
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      formula: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-formula') ?? '',
        renderHTML: (attrs) => {
          const formula = (attrs as MathBlockAttributes).formula ?? ''
          return { 'data-formula': formula }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div.math-block' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'math-block' }),
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(MathBlockNodeView)
  },

  addCommands() {
    return {
      insertMathBlock: (formula = '') => ({ chain }) => {
        return chain()
          .focus()
          .insertContent({ type: this.name, attrs: { formula } })
          .run()
      },
    }
  },
})
