/**
 * GFM footnote nodes.
 *
 *   - `footnoteRef` — inline atom, an `attrs.label` (string identifying the
 *     footnote — typically `"1"`, `"2"` …). Renders as a clickable superscript.
 *   - `footnoteList` — block container at the bottom of the doc, holds
 *     `footnoteItem` children.
 *   - `footnoteItem` — block, holds a paragraph with the definition text.
 *
 * Round-trip:
 *   - markdown `text[^1] more.\n\n[^1]: definition.`
 *       →  `markdownToHtml` (marked-footnote plugin)
 *       →  `<sup><a … data-footnote-ref>1</a></sup>` for refs and
 *          `<section.footnotes data-footnotes><ol><li id="footnote-1">…</li></ol></section>`
 *          for the definition list.
 *       →  parseHTML maps each shape to our Tiptap nodes.
 *   - editor →  renderHTML emits the same DOM shape
 *           →  turndown rules re-emit `[^N]` inline and `[^N]: text` definition lines.
 */
import { Node, mergeAttributes, VueNodeViewRenderer, InputRule } from '@tiptap/vue-3'
import FootnoteRefNodeView from '../FootnoteRefNodeView.vue'

export interface FootnoteRefAttributes {
  label: string
}

declare module '@tiptap/vue-3' {
  interface Commands<ReturnType> {
    footnote: {
      /**
       * Insert a footnote at the current cursor. Picks the next free numeric
       * label by scanning existing refs in the doc, appends (or creates) a
       * `footnoteList` at the bottom with an empty `footnoteItem` placeholder,
       * then moves the caret into that placeholder so the user types the
       * definition immediately.
       */
      insertFootnote: () => ReturnType
    }
  }
}

export const FootnoteRef = Node.create({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      label: {
        default: '1',
        parseHTML: (el) => {
          // marked-footnote emits the `<a id="footnote-ref-LABEL">` on the
          // anchor; the visible text is the auto-numbered display number,
          // not the underlying label. We prefer the explicit ID.
          const a = el.tagName === 'A'
            ? (el as HTMLAnchorElement)
            : el.querySelector('a[data-footnote-ref]')
          const id = a?.getAttribute('id') ?? ''
          const m = id.match(/^footnote-ref-(.+)$/)
          if (m && m[1]) return m[1]
          // Direct emit from our renderHTML path: `<sup data-label="…">`.
          const sup = el.tagName === 'SUP'
            ? el
            : el.closest('sup[data-footnote-ref-wrap]')
          const direct = sup?.getAttribute('data-label')
          if (direct && direct.length > 0) return direct
          // Last-ditch: visible text content.
          return (el.textContent ?? '').trim() || '1'
        },
        renderHTML: (attrs) => {
          const label = (attrs as FootnoteRefAttributes).label || '1'
          return { 'data-label': label }
        },
      },
    }
  },

  parseHTML() {
    return [
      // Direct round-trip of our own emit.
      { tag: 'sup[data-footnote-ref-wrap]' },
      // marked-footnote output: `<sup><a data-footnote-ref …>N</a></sup>`.
      {
        tag: 'sup',
        getAttrs: (el) => {
          const anchor = (el as HTMLElement).querySelector('a[data-footnote-ref]')
          return anchor ? null : false
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    const label = (node.attrs as FootnoteRefAttributes).label || '1'
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        class: 'footnote-ref',
        'data-footnote-ref-wrap': '',
        'data-label': label,
      }),
      ['a', { href: `#footnote-${label}`, 'data-footnote-ref': '' }, label],
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(FootnoteRefNodeView)
  },

  addInputRules() {
    // `[^N]` typed inline becomes a footnoteRef + ensures a matching
    // footnoteItem exists at the bottom of the doc. We mutate Tiptap's
    // provided `tr` directly (via `chain().command`) — dispatching from
    // within an input-rule handler via a SEPARATE chain would race with
    // the rule's own commit and drop the changes on the floor.
    return [
      new InputRule({
        find: /\[\^([A-Za-z0-9_-]+)\]$/,
        handler: ({ state, range, match, chain }) => {
          const label = match[1]
          if (!label) return null
          const refType = state.schema.nodes.footnoteRef
          const itemType = state.schema.nodes.footnoteItem
          const listType = state.schema.nodes.footnoteList
          const paraType = state.schema.nodes.paragraph
          if (!refType || !itemType || !listType || !paraType) return null

          chain().command(({ tr }) => {
            // 1) Replace the typed `[^N]` range with the ref node.
            const refNode = refType.create({ label })
            tr.replaceRangeWith(range.from, range.to, refNode)

            // 2) Look for an existing item with this label in the post-replace doc.
            let hasItem = false
            let listPos = -1
            let listSize = 0
            tr.doc.descendants((n, pos) => {
              if (n.type.name === 'footnoteList') {
                listPos = pos
                listSize = n.nodeSize
              }
              if (n.type.name === 'footnoteItem'
                && (n.attrs as { label?: string }).label === label) {
                hasItem = true
              }
            })
            if (hasItem) return true

            const itemNode = itemType.create({ label }, paraType.create())
            if (listPos < 0) {
              const endPos = tr.doc.content.size
              tr.insert(endPos, listType.create({}, itemNode))
            }
            else {
              tr.insert(listPos + listSize - 1, itemNode)
            }
            return true
          }).run()
        },
      }),
    ]
  },
})

export interface FootnoteItemAttributes {
  label: string
}

export const FootnoteItem = Node.create({
  name: 'footnoteItem',
  // Lives inside `footnoteList` and holds a single paragraph (definition body).
  group: 'footnoteItem',
  content: 'paragraph+',
  defining: true,

  addAttributes() {
    return {
      label: {
        default: '1',
        parseHTML: (el) => {
          const id = el.getAttribute('id') ?? ''
          const m = id.match(/^footnote-(.+)$/)
          if (m && m[1]) return m[1]
          const direct = el.getAttribute('data-label')
          return direct && direct.length > 0 ? direct : '1'
        },
        renderHTML: (attrs) => {
          const label = (attrs as FootnoteItemAttributes).label || '1'
          return {
            id: `footnote-${label}`,
            'data-label': label,
          }
        },
      },
    }
  },

  parseHTML() {
    // `priority: 100` beats StarterKit's `li` parseHTML (default 50). Without
    // it, marked-footnote's `<li id="footnote-X">` was being claimed by the
    // generic listItem rule first, then ProseMirror had to satisfy
    // FootnoteList's `footnoteItem+` content constraint by inserting a
    // DEFAULT (label="1") footnoteItem — which is why the ref → item lookup
    // failed: ref label was "bienvenue" but item label was the synthetic "1".
    return [
      { tag: 'li[data-footnote-item]', priority: 100 },
      { tag: 'li[id^="footnote-"]', priority: 100 },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'li',
      mergeAttributes(HTMLAttributes, {
        class: 'footnote-item',
        'data-footnote-item': '',
      }),
      0,
    ]
  },
})

export const FootnoteList = Node.create({
  name: 'footnoteList',
  group: 'block',
  content: 'footnoteItem+',
  defining: true,
  isolating: true,

  parseHTML() {
    return [
      // marked-footnote emits `<section data-footnotes><h2 class="sr-only">…</h2><ol><li id="footnote-X">…</li></ol></section>`.
      // Without `contentElement`, ProseMirror walks the section's direct
      // children (the sr-only H2 and the OL) — neither matches
      // `footnoteItem`, so the H2 gets ejected as a sibling heading and the
      // OL becomes a stray `<ol>` carrying the LIs as plain OrderedList
      // items. Visible symptom: a phantom "1." block and a duplicated
      // "Footnotes" heading right above the real list. Pointing
      // contentElement at the inner OL skips both wrappers and feeds the
      // LIs straight into the FootnoteList content.
      {
        tag: 'section[data-footnotes]',
        priority: 100,
        contentElement: (el: HTMLElement) => el.querySelector('ol') ?? el,
      },
      { tag: 'ol[data-footnotes-list]', priority: 100 },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    // Wrap the OL in a section so marked-footnote-style consumers can find it
    // again. The OL holds the footnoteItems (mapped via parseHTML on `li`).
    return [
      'section',
      mergeAttributes(HTMLAttributes, {
        class: 'footnotes',
        'data-footnotes': '',
      }),
      ['ol', { 'data-footnotes-list': '' }, 0],
    ]
  },

  addCommands() {
    return {
      // Single-transaction insert: the inline ref AND the matching item are
      // both written into `tr` so they participate in the parent chain
      // (e.g. the slash command's `deleteRange(range)` before us). The
      // earlier implementation kicked off an inner `chain().run()` here,
      // which dispatched its own transaction, bypassed the outer
      // `deleteRange`, and left the `/foot` text behind.
      insertFootnote: () => ({ state, tr, dispatch }) => {
        const refType = state.schema.nodes.footnoteRef
        const itemType = state.schema.nodes.footnoteItem
        const listType = state.schema.nodes.footnoteList
        const paraType = state.schema.nodes.paragraph
        if (!refType || !itemType || !listType || !paraType) return false

        // Pick the next free numeric label.
        const used = new Set<number>()
        state.doc.descendants((n) => {
          if (n.type.name === 'footnoteRef' || n.type.name === 'footnoteItem') {
            const lab = (n.attrs as { label?: string }).label
            const num = Number.parseInt(lab ?? '', 10)
            if (Number.isFinite(num)) used.add(num)
          }
        })
        let next = 1
        while (used.has(next)) next++
        const label = String(next)

        if (!dispatch) return true

        // Step 1: insert the inline ref at the current selection.
        const refNode = refType.create({ label })
        tr.replaceSelectionWith(refNode, false)

        // Step 2: look for an existing footnoteList in the (post-ref) doc.
        // tr.doc reflects mutations made so far in this transaction.
        let listPos = -1
        let listSize = 0
        tr.doc.descendants((n, pos) => {
          if (n.type.name === 'footnoteList') {
            listPos = pos
            listSize = n.nodeSize
            return false
          }
          return true
        })

        const itemNode = itemType.create({ label }, paraType.create())

        if (listPos < 0) {
          // No list yet — append a fresh one with our item at the end.
          const endPos = tr.doc.content.size
          tr.insert(endPos, listType.create({}, itemNode))
        }
        else {
          // Append our item to the existing list (just before the closing tag).
          const insertAt = listPos + listSize - 1
          tr.insert(insertAt, itemNode)
        }
        return true
      },
    }
  },
})

