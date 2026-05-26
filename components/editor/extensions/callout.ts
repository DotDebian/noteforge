/**
 * GFM-style callout block. A blockquote whose first line is `[!KIND]` (with an
 * optional title) becomes a typed admonition card.
 *
 * Round-trip:
 *   - markdown  `> [!INFO] Title\n> body…`
 *                              →  `markdownToHtml` (marked extension)
 *                              →  `<div class="callout" data-kind="info" data-title="Title">…</div>`
 *                              →  parseHTML pulls `data-kind` / `data-title`
 *   - editor    attrs.{kind,title}
 *                              →  renderHTML emits the same div with inner block content
 *                              →  `htmlToMarkdown` (turndown rule) re-emits the
 *                                 `> [!KIND] Title` blockquote form.
 */
import { Node, mergeAttributes, VueNodeViewRenderer } from '@tiptap/vue-3'
import CalloutNodeView from '../CalloutNodeView.vue'

export type CalloutKind = 'info' | 'tip' | 'warn' | 'quote'

const CALLOUT_KINDS: readonly CalloutKind[] = ['info', 'tip', 'warn', 'quote'] as const

export interface CalloutAttributes {
  kind: CalloutKind
  title: string | null
}

declare module '@tiptap/vue-3' {
  interface Commands<ReturnType> {
    callout: {
      /**
       * Insert a callout block at the current selection with an empty body
       * paragraph. The default kind is `info`.
       */
      insertCallout: (kind?: CalloutKind, title?: string) => ReturnType
    }
  }
}

function normalizeKind(raw: string | null | undefined): CalloutKind {
  if (!raw) return 'info'
  const k = raw.toLowerCase()
  return (CALLOUT_KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : 'info'
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  // Block-level container: holds one or more block children (paragraphs,
  // lists, headings…). `defining` keeps the boundary stable when the user
  // backspaces from inside the body.
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'info' as CalloutKind,
        parseHTML: (el) => normalizeKind(el.getAttribute('data-kind')),
        renderHTML: (attrs) => {
          const kind = normalizeKind((attrs as CalloutAttributes).kind)
          return { 'data-kind': kind }
        },
      },
      title: {
        default: null as string | null,
        parseHTML: (el) => {
          const t = el.getAttribute('data-title')
          return t && t.length > 0 ? t : null
        },
        renderHTML: (attrs) => {
          const t = (attrs as CalloutAttributes).title
          if (typeof t === 'string' && t.length > 0) return { 'data-title': t }
          return {}
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div.callout' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'callout' }),
      0,
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(CalloutNodeView)
  },

  addCommands() {
    return {
      insertCallout: (kind: CalloutKind = 'info', title?: string) =>
        ({ chain }) => {
          return chain()
            .focus()
            .insertContent({
              type: this.name,
              attrs: {
                kind,
                title: title && title.length > 0 ? title : null,
              },
              content: [{ type: 'paragraph' }],
            })
            .run()
        },
    }
  },
})
