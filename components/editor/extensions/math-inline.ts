/**
 * Inline LaTeX math node. The node is atomic (the user can't position the
 * caret inside it) and renders via a Vue NodeView that swaps between a
 * KaTeX-rendered HTML view and a raw `$…$` source editor on click / focus.
 *
 * Round-trip:
 *   - markdown  `$x^2$`   →  `markdownToHtml` (marked extension)
 *                          →  `<span class="math-inline" data-formula="x^2"></span>`
 *                          →  parseHTML pulls `data-formula` into attrs.formula
 *   - editor    attrs.formula
 *                          →  renderHTML emits the same span
 *                          →  `htmlToMarkdown` (turndown rule) re-emits `$x^2$`
 */
import { Node, mergeAttributes, VueNodeViewRenderer } from '@tiptap/vue-3'
import MathInlineNodeView from '../MathInlineNodeView.vue'

export interface MathInlineAttributes {
  formula: string
}

declare module '@tiptap/vue-3' {
  interface Commands<ReturnType> {
    mathInline: {
      /**
       * Insert an inline math node at the current selection. Replaces the
       * selection (if any) with a single `mathInline` node.
       */
      insertMathInline: (formula?: string) => ReturnType
    }
  }
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  // Spaces inside the formula are significant for LaTeX, so we let them through.
  // The atom flag means the formula is opaque to ProseMirror's text-walker —
  // the NodeView owns the inner UX.

  addAttributes() {
    return {
      formula: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-formula') ?? '',
        renderHTML: (attrs) => {
          const formula = (attrs as MathInlineAttributes).formula ?? ''
          return { 'data-formula': formula }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span.math-inline' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'math-inline' }),
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(MathInlineNodeView)
  },

  addCommands() {
    return {
      insertMathInline: (formula = '') => ({ chain }) => {
        return chain()
          .focus()
          .insertContent({ type: this.name, attrs: { formula } })
          .run()
      },
    }
  },
})
