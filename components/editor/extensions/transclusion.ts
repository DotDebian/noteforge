/**
 * Transclusion node — `![[doc-slug]]` embed.
 *
 * Round-trip:
 *   - markdown  `![[Some Title]]` or `![[42]]`
 *       → marked inline extension (registered in `useEditorMarkdown.ts`)
 *         emits `<span class="transclusion" data-slug="…"></span>`.
 *       → parseHTML picks up the slug attribute into `attrs.slug`.
 *   - editor → renderHTML emits the same span.
 *           → turndown rule (in `useEditorMarkdown.ts`) re-emits `![[slug]]`.
 *
 * The NodeView resolves the slug on every render — it tries integer parse
 * first (numeric id), then case-insensitive title lookup via the tree
 * store. If the doc updates, the NodeView refetches via a watch on the
 * resolved doc id.
 */
import { Node, mergeAttributes, VueNodeViewRenderer, InputRule } from '@tiptap/vue-3'
import TransclusionNodeView from '../TransclusionNodeView.vue'

export interface TransclusionAttributes {
  slug: string
}

declare module '@tiptap/vue-3' {
  interface Commands<ReturnType> {
    transclusion: {
      /**
       * Insert a transclusion node referencing `slug` at the current
       * selection. The slug is either a numeric document id, or a
       * case-insensitive title.
       */
      insertTransclusion: (slug: string) => ReturnType
    }
  }
}

export const Transclusion = Node.create({
  name: 'transclusion',
  // Block embed: easier to lay out as a card, and it lines up with how
  // Obsidian / Logseq render `![[…]]` (a block boundary above + below).
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  defining: true,

  addAttributes() {
    return {
      slug: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-slug') ?? '',
        renderHTML: (attrs) => {
          const s = (attrs as TransclusionAttributes).slug ?? ''
          return { 'data-slug': s }
        },
      },
    }
  },

  parseHTML() {
    return [
      // Inline span (marked extension output).
      {
        tag: 'span.transclusion',
        getAttrs: (el) => {
          const slug = (el as HTMLElement).getAttribute('data-slug') ?? ''
          return slug.length > 0 ? { slug } : false
        },
      },
      // Block div fallback (in case a user hand-writes this).
      {
        tag: 'div.transclusion',
        getAttrs: (el) => {
          const slug = (el as HTMLElement).getAttribute('data-slug') ?? ''
          return slug.length > 0 ? { slug } : false
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'transclusion' }),
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(TransclusionNodeView)
  },

  addCommands() {
    return {
      insertTransclusion: (slug: string) => ({ chain }) => {
        return chain()
          .focus()
          .insertContent({
            type: this.name,
            attrs: { slug },
          })
          .run()
      },
    }
  },

  // Inline input rule: typing `![[…]]` in the editor converts the run into
  // a transclusion node immediately. The earlier implementation built a
  // node off `state.schema` and dispatched it via a sub-chain — which
  // raced with the input-rule's own commit and silently dropped the work.
  // Mutating the rule's `tr` keeps it atomic.
  addInputRules() {
    return [
      new InputRule({
        find: /!\[\[([^\]\n]+)\]\]$/,
        handler: ({ state, range, match, chain }) => {
          const slug = (match[1] ?? '').trim()
          if (!slug) return null
          const type = state.schema.nodes.transclusion
          if (!type) return null
          chain().command(({ tr }) => {
            tr.replaceRangeWith(range.from, range.to, type.create({ slug }))
            return true
          }).run()
        },
      }),
    ]
  },
})
