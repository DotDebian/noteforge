/**
 * Collapsible (`<details>`/`<summary>`) nodes.
 *
 *   - `collapsible` — block, holds exactly one `collapsibleSummary` followed by
 *     `collapsibleContent`. `attrs.open` controls the open/closed state.
 *   - `collapsibleSummary` — inline content, the disclosure title.
 *   - `collapsibleContent` — block content, the body shown when expanded.
 *
 * Implementation notes:
 *   - The browser's native `<details>` disclosure does NOT fire when the
 *     `<summary>` is contenteditable — clicking just places the caret. So we
 *     can't rely on the native toggle here. Instead the NodeView renders a
 *     dedicated chevron button (contenteditable=false) that flips the
 *     `open` attribute; CSS shows/hides the body based on the resulting
 *     class.
 *   - The wrapper remains `<details>` so the markdown round-trip (see
 *     useEditorMarkdown.ts) keeps reading the `open` attribute back out.
 */
import { Node, mergeAttributes, VueNodeViewRenderer } from '@tiptap/vue-3'
import CollapsibleNodeView from '../CollapsibleNodeView.vue'

export interface CollapsibleAttributes {
  open: boolean
}

declare module '@tiptap/vue-3' {
  interface Commands<ReturnType> {
    collapsible: {
      /**
       * Insert an open `<details>` collapsible at the cursor with a
       * placeholder summary and one empty body paragraph.
       */
      insertCollapsible: (open?: boolean, title?: string) => ReturnType
    }
  }
}

export const CollapsibleSummary = Node.create({
  name: 'collapsibleSummary',
  content: 'inline*',
  defining: true,
  // Inline content but the node itself is block-level — it sits next to the
  // body inside the collapsible container. Allow any marks so bold/italic
  // work inside the title.
  marks: '_',
  selectable: false,

  parseHTML() {
    return [{ tag: 'summary' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'summary',
      mergeAttributes(HTMLAttributes, { class: 'collapsible-summary' }),
      0,
    ]
  },
})

export const CollapsibleContent = Node.create({
  name: 'collapsibleContent',
  content: 'block+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-collapsible-content]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'collapsible-content',
        'data-collapsible-content': '',
      }),
      0,
    ]
  },
})

export const Collapsible = Node.create({
  name: 'collapsible',
  group: 'block',
  content: 'collapsibleSummary collapsibleContent',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.hasAttribute('open'),
        renderHTML: (attrs) => {
          const open = (attrs as CollapsibleAttributes).open
          return open ? { open: '' } : {}
        },
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'details',
        // Group non-<summary> children into a synthetic
        // `<div data-collapsible-content>` so the content matcher can fit
        // them under the `collapsibleContent` slot. We mutate a CLONE so
        // the editor's input document isn't disturbed.
        contentElement: (el) => {
          const root = (el as HTMLElement).cloneNode(true) as HTMLElement
          const summary = root.querySelector(':scope > summary')
          const wrapper = root.ownerDocument.createElement('div')
          wrapper.setAttribute('data-collapsible-content', '')
          const children = Array.from(root.childNodes)
          for (const child of children) {
            if (child === summary) continue
            wrapper.appendChild(child)
          }
          while (root.firstChild) root.removeChild(root.firstChild)
          if (summary) root.appendChild(summary)
          root.appendChild(wrapper)
          return root
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes, { class: 'collapsible' }),
      0,
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(CollapsibleNodeView)
  },

  addCommands() {
    return {
      insertCollapsible: (open = true, title = 'Titre') => ({ chain }) => {
        const summaryContent = title.length > 0
          ? [{ type: 'text', text: title }]
          : []
        return chain()
          .focus()
          .insertContent({
            type: this.name,
            attrs: { open },
            content: [
              { type: 'collapsibleSummary', content: summaryContent },
              {
                type: 'collapsibleContent',
                content: [{ type: 'paragraph' }],
              },
            ],
          })
          .run()
      },
    }
  },
})
