import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, markdownToHtml } from '~/composables/useEditorMarkdown'

describe('markdownToHtml', () => {
  it('renders bold, italic and inline code', () => {
    const html = markdownToHtml('**bold** and *italic* and `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<code>code</code>')
  })

  it('renders a fenced code block', () => {
    const html = markdownToHtml('```\nconst x = 1\n```\n')
    expect(html).toContain('<pre>')
    expect(html).toContain('const x = 1')
  })

  it('renders a link', () => {
    const html = markdownToHtml('[NoteForge](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('>NoteForge</a>')
  })

  it('returns empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('')
  })
})

describe('htmlToMarkdown', () => {
  it('converts bold and italic back to markdown', () => {
    expect(htmlToMarkdown('<p><strong>bold</strong> <em>italic</em></p>'))
      .toContain('**bold**')
    expect(htmlToMarkdown('<p><em>just italic</em></p>'))
      .toContain('*just italic*')
  })

  it('converts <s> / <del> / <strike> to ~~strike~~', () => {
    expect(htmlToMarkdown('<p><s>gone</s></p>')).toContain('~~gone~~')
    expect(htmlToMarkdown('<p><del>old</del></p>')).toContain('~~old~~')
  })

  it('converts Tiptap task list items to GFM checkboxes', () => {
    const html = `
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="false"><p>todo</p></li>
        <li data-type="taskItem" data-checked="true"><p>done</p></li>
      </ul>
    `
    const md = htmlToMarkdown(html)
    expect(md).toMatch(/-\s\[ \]\s+todo/)
    expect(md).toMatch(/-\s\[x\]\s+done/)
  })

  it('converts a link back to markdown', () => {
    expect(htmlToMarkdown('<p><a href="https://example.com">site</a></p>'))
      .toContain('[site](https://example.com)')
  })

  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('')
  })
})

describe('markdown round-trip', () => {
  it('preserves bold, italic, code, link, strike', () => {
    const original = '**bold** *italic* `code` [link](https://example.com) ~~struck~~'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toContain('**bold**')
    expect(back).toContain('*italic*')
    expect(back).toContain('`code`')
    expect(back).toContain('[link](https://example.com)')
    expect(back).toContain('~~struck~~')
  })
})

describe('LaTeX math', () => {
  it('parses inline $…$ math into a placeholder span', () => {
    const html = markdownToHtml('Inline $a^2 + b^2 = c^2$ here.')
    expect(html).toContain('<span class="math-inline"')
    expect(html).toContain('data-formula="a^2 + b^2 = c^2"')
  })

  it('parses $$…$$ block math into a placeholder div', () => {
    const html = markdownToHtml('$$E = mc^2$$')
    expect(html).toContain('<div class="math-block"')
    expect(html).toContain('data-formula="E = mc^2"')
  })

  it('round-trips block + inline math through HTML', () => {
    const original = '# Title\n\n$$E = mc^2$$\n\nInline $a^2 + b^2 = c^2$ here.'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toContain('# Title')
    expect(back).toContain('$$E = mc^2$$')
    expect(back).toContain('$a^2 + b^2 = c^2$')
  })

  it('treats escaped \\$ as literal dollar sign, not math', () => {
    const html = markdownToHtml('Buy for \\$5 today.')
    expect(html).not.toContain('class="math-inline"')
  })

  it('preserves multi-line block math (matrix-style)', () => {
    const original = '$$\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}$$'
    const html = markdownToHtml(original)
    expect(html).toContain('class="math-block"')
    const back = htmlToMarkdown(html)
    expect(back).toContain('$$\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}$$')
  })
})

describe('Callouts (GFM admonitions)', () => {
  it('parses [!INFO] callout with title into a card div', () => {
    const html = markdownToHtml('> [!INFO] Optional title\n> Body of the callout.\n> Across multiple lines.')
    expect(html).toContain('<div class="callout"')
    expect(html).toContain('data-kind="info"')
    expect(html).toContain('data-title="Optional title"')
    expect(html).toContain('Body of the callout.')
  })

  it('falls through to a normal blockquote when the kind is unknown', () => {
    const html = markdownToHtml('> [!UNKNOWN] hello\n> body')
    expect(html).not.toContain('class="callout"')
    expect(html).toContain('<blockquote>')
  })

  it('accepts all four kinds (info, tip, warn, quote)', () => {
    for (const k of ['INFO', 'TIP', 'WARN', 'QUOTE']) {
      const html = markdownToHtml(`> [!${k}]\n> body`)
      expect(html).toContain('class="callout"')
      expect(html).toContain(`data-kind="${k.toLowerCase()}"`)
    }
  })

  it('round-trips a callout through HTML', () => {
    const original = '> [!TIP] Pro tip\n> Use ctrl+k\n'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toMatch(/> \[!TIP\] Pro tip/)
    expect(back).toMatch(/> Use ctrl\+k/)
  })

  it('round-trips a titleless callout', () => {
    const original = '> [!WARN]\n> mind the gap'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toContain('> [!WARN]')
    expect(back).toContain('> mind the gap')
  })
})

describe('Footnotes', () => {
  it('parses an inline footnote ref into a <sup>', () => {
    const html = markdownToHtml('See note[^1].\n\n[^1]: First.')
    expect(html).toContain('<sup')
    expect(html).toContain('data-footnote-ref')
    expect(html).toContain('First.')
  })

  it('emits a <section.footnotes> list for definitions', () => {
    const html = markdownToHtml('Hello[^x].\n\n[^x]: definition body.')
    expect(html).toMatch(/<section[^>]*data-footnotes/)
    expect(html).toContain('definition body.')
  })

  it('round-trips footnote refs and definitions', () => {
    const original = 'Body text with a note[^1] inside.\n\n[^1]: The actual footnote.'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toMatch(/\[\^1\]/)
    expect(back).toMatch(/\[\^1\]:\s+The actual footnote/)
  })

  it('supports non-numeric labels', () => {
    const original = 'Cite[^alpha] me.\n\n[^alpha]: source A.'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toContain('[^alpha]')
    expect(back).toMatch(/\[\^alpha\]:\s+source A/)
  })

  // Regression: when a doc contained both a callout (`> [!TIP]`) and a
  // footnote definition, the callout's recursive `marked.parse(body)` call
  // mutated marked-footnote's closure-scoped `hasFootnotes` flag mid-parse
  // (its walkTokens reset it on the way out of the inner parse), causing
  // the outer parse to re-push the footnotes meta token at a second
  // position and emit `<section.footnotes>` twice. The fix routes callout
  // body parsing through a separate `Marked` instance without the footnote
  // plugin.
  it('emits a single footnotes section even when a callout precedes the footnote', () => {
    const md = `# Intro

> [!TIP] Astuce
> Body of the callout.

Paragraph with a ref[^x] inside.

[^x]: definition body.
`
    const html = markdownToHtml(md)
    const sectionMatches = html.match(/<section[^>]*data-footnotes/g) ?? []
    expect(sectionMatches.length).toBe(1)
    // And the section still carries the actual footnote item.
    expect(html).toContain('id="footnote-x"')
    expect(html).toContain('definition body.')
  })
})

describe('Collapsible <details>', () => {
  it('lets markdown <details> pass through to HTML', () => {
    const md = '<details><summary>Open me</summary>\n\nHidden body.\n\n</details>'
    const html = markdownToHtml(md)
    expect(html).toContain('<details')
    expect(html).toContain('<summary>Open me</summary>')
    expect(html).toContain('Hidden body.')
  })

  it('round-trips an open details block', () => {
    const original = '<details open>\n<summary>Title here</summary>\n\nBody paragraph.\n\n</details>'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toMatch(/<details open>/)
    expect(back).toMatch(/<summary>Title here<\/summary>/)
    expect(back).toMatch(/Body paragraph\./)
    expect(back).toMatch(/<\/details>/)
  })

  it('round-trips a closed details block (no open attr)', () => {
    const original = '<details>\n<summary>Hidden</summary>\n\nBody.\n\n</details>'
    const html = markdownToHtml(original)
    const back = htmlToMarkdown(html)
    expect(back).toMatch(/<details>/)
    expect(back).not.toMatch(/<details open>/)
  })
})
