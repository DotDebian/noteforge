// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { CodeBlockWithMermaid } from '~/components/editor/extensions/code-block-mermaid'
import { MathInline } from '~/components/editor/extensions/math-inline'
import { MathBlock } from '~/components/editor/extensions/math-block'
import { Callout } from '~/components/editor/extensions/callout'
import { FootnoteRef, FootnoteList, FootnoteItem } from '~/components/editor/extensions/footnote'
import { Collapsible, CollapsibleSummary, CollapsibleContent } from '~/components/editor/extensions/collapsible'
import { TableKit } from '~/components/editor/extensions/table'
import { Transclusion } from '~/components/editor/extensions/transclusion'
import { Whiteboard } from '~/components/editor/extensions/whiteboard'
import { lowlight } from '~/utils/lowlight'
import { htmlToMarkdown, markdownToHtml } from '~/composables/useEditorMarkdown'
import { WELCOME_DOCUMENT_MARKDOWN } from '~/server/utils/welcome-document'

/**
 * The real load → save path of DocumentEditor, minus the browser:
 * markdown → marked → Tiptap document (same node extensions as the editor)
 * → getHTML → turndown → markdown. The unit tests in editor-markdown.test.ts
 * cover each half on hand-written strings; only this one catches a shape
 * that marked emits and the Tiptap schema does not parse — which is how
 * task lists silently became bullet lists.
 */
function roundTrip(md: string): string {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false }),
      CodeBlockWithMermaid.configure({ lowlight, defaultLanguage: null }),
      MathInline,
      MathBlock,
      Callout,
      FootnoteRef,
      FootnoteItem,
      FootnoteList,
      CollapsibleSummary,
      CollapsibleContent,
      Collapsible,
      ...TableKit,
      Transclusion,
      Whiteboard,
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image,
    ],
    content: markdownToHtml(md),
  })
  const out = htmlToMarkdown(editor.getHTML())
  editor.destroy()
  return out
}

describe('editor markdown round trip', () => {
  it('keeps task lists, checked state and nesting', () => {
    const md = '- [x] done **bold**\n- [ ] todo\n  - [ ] child\n  - [x] other\n- [ ] last'
    expect(roundTrip(md)).toBe(md)
  })

  it('keeps tight bullet and ordered lists byte for byte', () => {
    const md = '- one\n- two\n  - nested\n    1. a\n    2. b\n- three\n\n3. c\n4. d'
    expect(roundTrip(md)).toBe(md)
  })

  it('keeps task lists inside a callout', () => {
    const md = '> [!TIP] Tip\n> - [ ] todo\n> - [x] done'
    expect(roundTrip(md)).toBe(md)
  })

  it('keeps a multi-block item, and the list around it loose', () => {
    const md = '- one\n\n  more\n\n  ```js\n  code()\n  ```\n\n- two'
    expect(roundTrip(md)).toBe(md)
  })

  it('round-trips the welcome note: lists intact, second pass identical', () => {
    const once = roundTrip(WELCOME_DOCUMENT_MARKDOWN)
    expect(roundTrip(once)).toBe(once)

    const sourceLines = WELCOME_DOCUMENT_MARKDOWN.split('\n')
    const outLines = new Set(once.split('\n'))
    // Every task line survives verbatim.
    const tasks = sourceLines.filter(l => /^- \[[ x]\] /.test(l))
    expect(tasks.length).toBeGreaterThan(0)
    for (const line of tasks) expect(outLines.has(line)).toBe(true)
    // Same number of list items, none padded, no whitespace-only line.
    const isItem = (l: string): boolean => /^\s*(?:-|\d+\.) /.test(l)
    expect(once.split('\n').filter(isItem)).toHaveLength(sourceLines.filter(isItem).length)
    expect(once).not.toMatch(/^-   /m)
    expect(once).not.toMatch(/^[ \t]+$/m)
  })
})
