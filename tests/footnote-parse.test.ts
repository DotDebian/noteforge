// @vitest-environment jsdom
import { describe, expect, it, beforeAll } from 'vitest'
import { Editor, Node, mergeAttributes } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { markdownToHtml } from '~/composables/useEditorMarkdown'

// Re-declare the footnote nodes WITHOUT the Vue NodeView, since the
// production extension imports a .vue file that requires the Vue plugin.
// The parseHTML/renderHTML logic we want to test is replicated verbatim.

const FootnoteRef = Node.create({
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
          const a = el.tagName === 'A'
            ? (el as HTMLAnchorElement)
            : el.querySelector('a[data-footnote-ref]')
          const id = a?.getAttribute('id') ?? ''
          const m = id.match(/^footnote-ref-(.+)$/)
          if (m && m[1]) return m[1]
          const sup = el.tagName === 'SUP' ? el : el.closest('sup[data-footnote-ref-wrap]')
          const direct = sup?.getAttribute('data-label')
          if (direct && direct.length > 0) return direct
          return (el.textContent ?? '').trim() || '1'
        },
      },
    }
  },
  parseHTML() {
    return [
      { tag: 'sup[data-footnote-ref-wrap]' },
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
    const label = node.attrs.label || '1'
    return ['sup', mergeAttributes(HTMLAttributes, { 'data-footnote-ref-wrap': '', 'data-label': label }),
      ['a', { href: `#footnote-${label}`, 'data-footnote-ref': '' }, label]]
  },
})

const FootnoteItem = Node.create({
  name: 'footnoteItem',
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
        renderHTML: (attrs) => ({ id: `footnote-${attrs.label}`, 'data-label': attrs.label }),
      },
    }
  },
  parseHTML() {
    return [
      { tag: 'li[data-footnote-item]', priority: 100 },
      { tag: 'li[id^="footnote-"]', priority: 100 },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(HTMLAttributes, { class: 'footnote-item', 'data-footnote-item': '' }), 0]
  },
})

const FootnoteList = Node.create({
  name: 'footnoteList',
  group: 'block',
  content: 'footnoteItem+',
  defining: true,
  isolating: true,
  parseHTML() {
    return [
      {
        tag: 'section[data-footnotes]',
        contentElement: (el: HTMLElement) => el.querySelector('ol') ?? el,
      },
      { tag: 'ol[data-footnotes-list]' },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['section', mergeAttributes(HTMLAttributes, { class: 'footnotes', 'data-footnotes': '' }),
      ['ol', { 'data-footnotes-list': '' }, 0]]
  },
})

beforeAll(() => {
  // Tiptap's Editor needs `document.createRange().getClientRects()` for some
  // initialisation paths in jsdom; the polyfill is enough for parsing only.
  if (typeof document !== 'undefined' && !('getClientRects' in Range.prototype)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Range.prototype as any).getClientRects = () => ({ length: 0, item: () => null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Range.prototype as any).getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })
  }
})

function buildEditor(content: string): Editor {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return new Editor({
    element: root,
    extensions: [
      StarterKit,
      Link,
      FootnoteRef,
      FootnoteItem,
      FootnoteList,
    ],
    content,
  })
}

function refsAndItems(editor: Editor): { refs: string[], items: string[] } {
  const refs: string[] = []
  const items: string[] = []
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'footnoteRef') refs.push((n.attrs as { label?: string }).label ?? '')
    if (n.type.name === 'footnoteItem') items.push((n.attrs as { label?: string }).label ?? '')
  })
  return { refs, items }
}

describe('footnote parseHTML — ref/item labels survive the parse', () => {
  // Regression: without `priority: 100` on the FootnoteItem parseHTML rules,
  // marked-footnote's `<li id="footnote-X">` was claimed by StarterKit's
  // generic `li` rule (default priority 50) before our `li[id^="footnote-"]`
  // rule could match. ProseMirror then synthesized a default footnoteItem
  // (label="1") to satisfy FootnoteList's `footnoteItem+` content constraint,
  // leaving every ref orphaned because the ref's real label (e.g. "bienvenue")
  // never matched the synthetic item's "1".
  it('string label survives the parse (regression: priority over StarterKit li)', () => {
    const html = markdownToHtml('Body[^bienvenue] here.\n\n[^bienvenue]: definition body.')
    const { refs, items } = refsAndItems(buildEditor(html))
    expect(refs).toEqual(['bienvenue'])
    expect(items).toEqual(['bienvenue'])
  })

  it('numeric label survives the parse', () => {
    const html = markdownToHtml('Body[^7] here.\n\n[^7]: definition.')
    const { refs, items } = refsAndItems(buildEditor(html))
    expect(refs).toEqual(['7'])
    expect(items).toEqual(['7'])
  })
})
