import { Marked, marked, type RendererExtension, type TokenizerExtension, type Tokens } from 'marked'
import markedFootnote from 'marked-footnote'
import TurndownService from 'turndown'

/* -------------------------------------------------------------------- */
/*  Math (KaTeX) marked extensions                                      */
/*                                                                       */
/*  Two custom tokens — `mathBlock` ($$…$$) and `mathInline` ($…$). The  */
/*  block tokenizer runs before the inline one (marked tries block-level */
/*  extensions first). Both emit attribute-bearing HTML shells; the Vue  */
/*  NodeViews defined in components/editor/ pull `data-formula` and run  */
/*  KaTeX.renderToString at render time, so the markdown→HTML path only  */
/*  needs to preserve the source string verbatim.                       */
/* -------------------------------------------------------------------- */

interface MathToken extends Tokens.Generic {
  type: 'mathBlock' | 'mathInline'
  raw: string
  formula: string
}

/**
 * Escape user-supplied formula text for safe HTML-attribute embedding.
 * `data-formula="…"` is double-quoted, so we minimally escape `&`, `<`, `>`
 * and `"`. KaTeX needs `\` and `{`/`}` to pass through untouched.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const mathBlockExtension: TokenizerExtension & RendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    // Cheap pre-scan so marked doesn't call our tokenizer on every block.
    const i = src.indexOf('$$')
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    // Anchored at column 0: matches `$$\n? … \n? $$` possibly preceded by
    // blank lines. Multi-line formulas are common (matrices, alignments).
    const rule = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/
    const match = rule.exec(src)
    if (!match) return undefined
    const raw = match[0]
    const inner = match[1] ?? ''
    // Trim leading/trailing newlines so the formula round-trips cleanly,
    // but preserve internal whitespace which can be significant in LaTeX.
    const formula = inner.replace(/^\n+/, '').replace(/\n+$/, '')
    const token: MathToken = {
      type: 'mathBlock',
      raw,
      formula,
    }
    return token
  },
  renderer(token) {
    const t = token as MathToken
    return `<div class="math-block" data-formula="${escapeAttr(t.formula)}"></div>`
  },
}

const mathInlineExtension: TokenizerExtension & RendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    // Skip occurrences preceded by a backslash (escaped `\$`).
    let i = src.indexOf('$')
    while (i > 0 && src.charAt(i - 1) === '\\') {
      const next = src.indexOf('$', i + 1)
      if (next < 0) return undefined
      i = next
    }
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    // Inline math: a `$`, not preceded by `\` (caller's `start` enforces),
    // a non-empty body without unescaped `$` and without a newline, and a
    // closing `$` not followed by a digit (avoid matching `$5.00 vs $6.00`
    // — a single-line, prose dollar amount).
    //
    // Body matches: any char that isn't `$` or newline, with `\$` allowed.
    const rule = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/
    const match = rule.exec(src)
    if (!match) return undefined
    const formula = match[1] ?? ''
    const token: MathToken = {
      type: 'mathInline',
      raw: match[0],
      formula,
    }
    return token
  },
  renderer(token) {
    const t = token as MathToken
    return `<span class="math-inline" data-formula="${escapeAttr(t.formula)}"></span>`
  },
}

/* -------------------------------------------------------------------- */
/*  Callout (GFM-style admonition) marked extension                     */
/*                                                                       */
/*  A blockquote whose first line is `[!KIND]` (with optional trailing  */
/*  title) becomes a typed admonition card. Recognised kinds are        */
/*  info / tip / warn / quote; anything else falls back to a normal     */
/*  blockquote (the tokenizer returns undefined so marked tries the     */
/*  next handler).                                                       */
/* -------------------------------------------------------------------- */

interface CalloutToken extends Tokens.Generic {
  type: 'callout'
  raw: string
  kind: 'info' | 'tip' | 'warn' | 'quote'
  title: string | null
  bodyHtml: string
}

const CALLOUT_KINDS = new Set(['info', 'tip', 'warn', 'quote'])

function escapeAttrFull(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const calloutExtension: TokenizerExtension & RendererExtension = {
  name: 'callout',
  level: 'block',
  start(src) {
    // Cheap pre-scan — only proceed if there's a `[!` somewhere near a `> `.
    const i = src.indexOf('> [!')
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    // Match a contiguous run of `> ` lines (a single blockquote) so we can
    // peek at the first line and decide whether to claim it as a callout.
    const rule = /^(?:>[^\n]*(?:\n|$))+/
    const match = rule.exec(src)
    if (!match) return undefined
    const raw = match[0]
    // Strip the leading `> ` from each line.
    const lines = raw.split('\n').map((l) => {
      if (l.startsWith('> ')) return l.slice(2)
      if (l.startsWith('>')) return l.slice(1)
      return l
    })
    // Drop trailing empty line (from the final `\n`).
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const first = lines[0] ?? ''
    const head = first.match(/^\[!([A-Za-z]+)\](?:\s+(.*))?$/)
    if (!head) return undefined
    const kindRaw = (head[1] ?? '').toLowerCase()
    if (!CALLOUT_KINDS.has(kindRaw)) return undefined
    const kind = kindRaw as CalloutToken['kind']
    const title = (head[2] ?? '').trim() || null
    const body = lines.slice(1).join('\n')
    // Recurse marked on the body so nested markdown (lists, bold, etc.)
    // renders inside the callout. We use a SEPARATE Marked instance that
    // does NOT have marked-footnote registered — the footnote plugin uses
    // closure-scoped state that gets clobbered by recursive parse calls
    // (its `walkTokens` resets `hasFootnotes` mid-outer-parse, causing the
    // outer parse to re-push the footnotes meta token at a second position
    // and emit `<section.footnotes>` twice). Footnotes inside a callout
    // body are intentionally not supported — the body still gets every
    // other extension (math, transclusion, nested callouts).
    const bodyHtml = body.length > 0
      ? (getCalloutMarked().parse(body, { async: false, breaks: false, gfm: true }) as string)
      : '<p></p>'
    const token: CalloutToken = {
      type: 'callout',
      raw,
      kind,
      title,
      bodyHtml,
    }
    return token
  },
  renderer(token) {
    const t = token as CalloutToken
    const attrs = [
      `data-kind="${escapeAttrFull(t.kind)}"`,
      t.title != null ? `data-title="${escapeAttrFull(t.title)}"` : '',
    ].filter(Boolean).join(' ')
    return `<div class="callout" ${attrs}>${t.bodyHtml}</div>`
  },
}

/* -------------------------------------------------------------------- */
/*  Transclusion (`![[doc-slug]]`) marked inline extension              */
/*                                                                       */
/*  Recognises `![[…]]` anywhere in inline context and emits an attribute */
/*  shell that Tiptap's Transclusion node picks up. We escape the slug so */
/*  HTML-ish characters in the slug can't break out of the attribute.    */
/* -------------------------------------------------------------------- */

interface TransclusionToken extends Tokens.Generic {
  type: 'transclusion'
  raw: string
  slug: string
}

const transclusionExtension: TokenizerExtension & RendererExtension = {
  name: 'transclusion',
  level: 'inline',
  start(src) {
    const i = src.indexOf('![[')
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    // Match `![[ … ]]` with the slug being anything that isn't `]` or
    // newline. We allow spaces so `![[My Doc Title]]` works.
    const rule = /^!\[\[([^\]\n]+)\]\]/
    const match = rule.exec(src)
    if (!match) return undefined
    const slug = (match[1] ?? '').trim()
    if (!slug) return undefined
    const token: TransclusionToken = {
      type: 'transclusion',
      raw: match[0],
      slug,
    }
    return token
  },
  renderer(token) {
    const t = token as TransclusionToken
    return `<span class="transclusion" data-slug="${escapeAttrFull(t.slug)}"></span>`
  },
}

/* -------------------------------------------------------------------- */
/*  marked instance                                                     */
/* -------------------------------------------------------------------- */

let markedReady = false
function ensureMarked(): void {
  if (markedReady) return
  marked.use({
    extensions: [
      // Callout must come BEFORE the built-in blockquote tokenizer so we
      // can intercept `> [!X]` shapes; non-callout blockquotes fall through
      // (the tokenizer returns undefined).
      calloutExtension,
      mathBlockExtension,
      mathInlineExtension,
      transclusionExtension,
    ],
  })
  // GFM footnotes via the marked-footnote plugin. Emits the standard
  // `<sup><a data-footnote-ref>` refs and `<section.footnotes>` block our
  // Tiptap parseHTML rules pick up.
  marked.use(markedFootnote())
  markedReady = true
}

/**
 * Dedicated Marked instance for parsing callout bodies recursively. It
 * mirrors the global instance's extensions BUT intentionally omits
 * marked-footnote: that plugin keeps closure-scoped state that gets
 * corrupted by nested parse calls (see comment in `calloutExtension`).
 * Isolating the recursive parse on its own instance keeps the outer
 * footnote pipeline clean.
 */
let calloutMarkedInstance: Marked | null = null
function getCalloutMarked(): Marked {
  if (calloutMarkedInstance) return calloutMarkedInstance
  const instance = new Marked()
  instance.use({
    extensions: [
      calloutExtension,
      mathBlockExtension,
      mathInlineExtension,
      transclusionExtension,
    ],
  })
  calloutMarkedInstance = instance
  return instance
}

/* -------------------------------------------------------------------- */
/*  Turndown                                                            */
/* -------------------------------------------------------------------- */

/**
 * Memoized Turndown service. We configure it once because Turndown is a
 * relatively heavy class to instantiate and the rule set never changes.
 */
let turndownInstance: TurndownService | null = null

function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance

  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    hr: '---',
    // Turndown's default rule selector short-circuits on visually-blank
    // nodes (empty <div>, empty <span>) and returns its `blankRule` BEFORE
    // user rules get a chance. The math NodeViews emit attribute-only
    // shells (`<div class="math-block" data-formula="…"></div>`), so we
    // intercept the blank path and rescue them via `data-formula`.
    blankReplacement: (_content, node) => {
      const el = node as HTMLElement
      if (typeof el.getAttribute !== 'function') return ''
      const formula = el.getAttribute('data-formula')
      if (formula !== null) {
        if (el.classList.contains('math-inline')) return `$${formula}$`
        if (el.classList.contains('math-block')) return `\n\n$$${formula}$$\n\n`
      }
      // Fall back to Turndown's default: block nodes get blank lines, inline
      // get an empty string. Matches the library's own implementation.
      return (node as HTMLElement & { isBlock?: boolean }).isBlock ? '\n\n' : ''
    },
  })

  // Tiptap renders task lists as <ul data-type="taskList"> with
  // <li data-type="taskItem" data-checked="true|false">. Convert those
  // to GitHub-flavoured `- [ ] item` / `- [x] item` markdown.
  td.addRule('taskListItem', {
    filter: (node) =>
      node.nodeName === 'LI' && (node as HTMLElement).getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => {
      const checked = (node as HTMLElement).getAttribute('data-checked') === 'true'
      const box = checked ? '[x]' : '[ ]'
      const text = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
        .replace(/\n/g, '\n  ')
      return `- ${box} ${text}\n`
    },
  })

  // Don't wrap the taskList <ul> with anything special — let the items
  // produce their own lines.
  td.addRule('taskList', {
    filter: (node) =>
      node.nodeName === 'UL' && (node as HTMLElement).getAttribute('data-type') === 'taskList',
    replacement: (content) => `\n${content}\n`,
  })

  // Strikethrough (StarterKit's `strike` extension renders as <s>).
  td.addRule('strikethrough', {
    filter: ['s', 'del', 'strike'] as TurndownService.Filter,
    replacement: (content) => `~~${content}~~`,
  })

  // Inline math — Tiptap's MathInline NodeView emits
  // <span class="math-inline" data-formula="…"></span>. Re-emit as `$…$`.
  td.addRule('mathInline', {
    filter: (node) =>
      node.nodeName === 'SPAN'
      && (node as HTMLElement).classList.contains('math-inline'),
    replacement: (_content, node) => {
      const formula = (node as HTMLElement).getAttribute('data-formula') ?? ''
      return `$${formula}$`
    },
  })

  // Block math — Tiptap's MathBlock NodeView emits
  // <div class="math-block" data-formula="…"></div>. Re-emit as `$$…$$`
  // surrounded by blank lines so the marked block tokenizer can re-pick it.
  td.addRule('mathBlock', {
    filter: (node) =>
      node.nodeName === 'DIV'
      && (node as HTMLElement).classList.contains('math-block'),
    replacement: (_content, node) => {
      const formula = (node as HTMLElement).getAttribute('data-formula') ?? ''
      return `\n\n$$${formula}$$\n\n`
    },
  })

  // Callouts — Tiptap's Callout NodeView emits
  // `<div class="callout" data-kind="…" data-title="…">…body…</div>`. We
  // emit it back as `> [!KIND] Title` plus indented blockquote lines.
  td.addRule('callout', {
    filter: (node) =>
      node.nodeName === 'DIV'
      && (node as HTMLElement).classList.contains('callout'),
    replacement: (content, node) => {
      const el = node as HTMLElement
      const kind = (el.getAttribute('data-kind') ?? 'info').toUpperCase()
      const title = el.getAttribute('data-title') ?? ''
      const header = title.length > 0 ? `[!${kind}] ${title}` : `[!${kind}]`
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '')
      const lines = body.length > 0 ? body.split('\n') : []
      const prefixed = lines.map((l) => (l.length > 0 ? `> ${l}` : '>'))
      const out = [`> ${header}`, ...prefixed].join('\n')
      return `\n\n${out}\n\n`
    },
  })

  // Footnote reference — Tiptap emits
  // `<sup data-footnote-ref-wrap data-label="N"><a …>N</a></sup>`. We also
  // accept marked-footnote's original `<sup><a data-footnote-ref id="footnote-ref-N">`
  // shape so a freshly-rendered HTML string round-trips even before parseHTML
  // has had a chance to canonicalise it.
  td.addRule('footnoteRef', {
    filter: (node) => {
      if (node.nodeName !== 'SUP') return false
      const el = node as HTMLElement
      if (el.hasAttribute('data-footnote-ref-wrap')) return true
      return el.querySelector('a[data-footnote-ref]') !== null
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement
      let label = el.getAttribute('data-label') ?? ''
      if (!label) {
        const a = el.querySelector('a[data-footnote-ref]')
        const id = a?.getAttribute('id') ?? ''
        const m = id.match(/^footnote-ref-(.+)$/)
        if (m && m[1]) label = m[1]
        else label = (a?.textContent ?? el.textContent ?? '').trim()
      }
      return `[^${label}]`
    },
  })

  // Footnote list — wrap the items so they end up at the end of the doc.
  // Both Tiptap (`<section class="footnotes">`) and marked-footnote
  // (`<section data-footnotes>`) shapes are covered by the same filter.
  td.addRule('footnoteList', {
    filter: (node) => {
      if (node.nodeName === 'SECTION') {
        const el = node as HTMLElement
        return el.hasAttribute('data-footnotes')
          || el.classList.contains('footnotes')
      }
      if (node.nodeName === 'OL') {
        return (node as HTMLElement).hasAttribute('data-footnotes-list')
      }
      return false
    },
    replacement: (content) => {
      // Strip the screen-reader-only "Footnotes" heading that marked-footnote
      // emits at the top of its <section>.
      const cleaned = content
        .replace(/^\s*##?\s+Footnotes\s*\n+/i, '')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
      return `\n\n${cleaned}\n\n`
    },
  })

  // Individual footnote item. The structure expected on the way back is
  // `[^label]: text`. We accept both our own `<li data-footnote-item …>` and
  // marked-footnote's `<li id="footnote-LABEL">` shapes.
  td.addRule('footnoteItem', {
    filter: (node) => {
      if (node.nodeName !== 'LI') return false
      const el = node as HTMLElement
      if (el.hasAttribute('data-footnote-item')) return true
      const id = el.getAttribute('id') ?? ''
      return /^footnote-.+$/.test(id)
    },
    replacement: (content, node) => {
      const el = node as HTMLElement
      let label = el.getAttribute('data-label') ?? ''
      if (!label) {
        const id = el.getAttribute('id') ?? ''
        const m = id.match(/^footnote-(.+)$/)
        if (m && m[1]) label = m[1]
      }
      if (!label) label = '1'
      // Strip the marked-footnote `↩` back-reference link from the body —
      // it's a presentational artefact that doesn't belong in the source.
      const body = content
        .replace(/\s*\[↩\]\([^)]*\)\s*$/m, '')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
      return `[^${label}]: ${body}\n`
    },
  })

  // Collapsible. We re-emit `<details>` literally so the markdown round-trips
  // (marked + browser pass `<details>` through). Turndown's default behaviour
  // for unknown elements is to render their inner content; an explicit rule
  // lets us preserve the `open` attribute and strip our cosmetic classes.
  //
  // Turndown's underlying HTML parser (domino) does NOT implement `:scope`,
  // so we walk `children` manually to split the summary off the rest of the
  // body without falling back to a query selector.
  td.addRule('collapsible', {
    filter: (node) =>
      node.nodeName === 'DETAILS',
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const isOpen = el.hasAttribute('open')
      // Find the first <summary> direct child and any data-collapsible-content
      // wrapper. Anything else collected after the summary is treated as body.
      let summaryEl: HTMLElement | null = null
      let bodyWrapper: HTMLElement | null = null
      const bodyChildren: HTMLElement[] = []
      for (const child of Array.from(el.children) as HTMLElement[]) {
        if (!summaryEl && child.tagName === 'SUMMARY') {
          summaryEl = child
          continue
        }
        if (!bodyWrapper && child.hasAttribute('data-collapsible-content')) {
          bodyWrapper = child
          continue
        }
        bodyChildren.push(child)
      }
      const summaryMd = summaryEl
        ? td.turndown(summaryEl.innerHTML).trim()
        : ''
      let bodyHtml = ''
      if (bodyWrapper) {
        bodyHtml = bodyWrapper.innerHTML
      }
      else {
        bodyHtml = bodyChildren.map((c) => c.outerHTML).join('')
      }
      const bodyMd = bodyHtml ? td.turndown(bodyHtml).trim() : ''
      const openAttr = isOpen ? ' open' : ''
      const lines = [`<details${openAttr}>`, `<summary>${summaryMd}</summary>`, '']
      if (bodyMd.length > 0) lines.push(bodyMd, '')
      lines.push('</details>')
      return `\n\n${lines.join('\n')}\n\n`
    },
  })

  /* ------------------------------------------------------------------ */
  /*  Tables — GFM pipe syntax                                          */
  /* ------------------------------------------------------------------ */
  //
  // Tiptap's table extensions emit a standard `<table><thead>…</thead>
  // <tbody>…</tbody></table>` (or only `<tbody>` if no header row). The
  // built-in `gfm: true` parser on marked already understands the pipe
  // syntax on the way in; we just need to emit it on the way out.
  //
  // We intentionally swallow the inner `<thead>`, `<tbody>`, and `<tr>`
  // rules so they don't double-emit; the parent `<table>` rule walks
  // them itself.

  function escapePipeCell(text: string): string {
    // GFM: `|` and `\n` are the only structural characters inside a cell.
    // Newlines must be replaced with `<br>` since pipe syntax is single-line.
    return text
      .replace(/\|/g, '\\|')
      .replace(/\n+/g, ' <br> ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function alignSpec(align: string | null): string {
    if (align === 'center') return ':---:'
    if (align === 'right') return '---:'
    if (align === 'left') return ':---'
    return '---'
  }

  td.addRule('tableCell', {
    filter: (node) => node.nodeName === 'TD' || node.nodeName === 'TH',
    replacement: (content) => escapePipeCell(content),
  })

  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (_content, node) => {
      const cells = Array.from((node as HTMLElement).childNodes).filter(
        (c) => c.nodeName === 'TD' || c.nodeName === 'TH',
      ) as HTMLElement[]
      const rendered = cells.map(c => escapePipeCell(td.turndown(c.innerHTML)))
      return `| ${rendered.join(' | ')} |`
    },
  })

  td.addRule('tableSection', {
    filter: (node) => node.nodeName === 'THEAD' || node.nodeName === 'TBODY',
    replacement: (content) => content,
  })

  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const allRows = Array.from(el.querySelectorAll('tr')) as HTMLElement[]
      if (allRows.length === 0) return ''
      // Find the header row: prefer rows inside <thead>, else if the first
      // row has any <th> child, treat it as header.
      const theadRows = Array.from(el.querySelectorAll('thead > tr')) as HTMLElement[]
      let headerRow: HTMLElement | null = null
      let bodyRows: HTMLElement[] = []
      if (theadRows.length > 0) {
        headerRow = theadRows[0] ?? null
        bodyRows = Array.from(el.querySelectorAll('tbody > tr')) as HTMLElement[]
      }
      else {
        const first = allRows[0] ?? null
        if (first && first.querySelector('th')) {
          headerRow = first
          bodyRows = allRows.slice(1)
        }
        else {
          // All rows are body — synthesize a blank header so the markdown
          // stays valid GFM (otherwise marked won't re-parse it as a table).
          bodyRows = allRows
        }
      }

      function rowToCells(row: HTMLElement): HTMLElement[] {
        return Array.from(row.children).filter(
          (c) => c.nodeName === 'TD' || c.nodeName === 'TH',
        ) as HTMLElement[]
      }

      const headerCells = headerRow ? rowToCells(headerRow) : []
      const sampleBodyCells = bodyRows[0] ? rowToCells(bodyRows[0]) : []
      const colCount = Math.max(
        headerCells.length,
        sampleBodyCells.length,
        ...bodyRows.map(r => rowToCells(r).length),
      )
      if (colCount === 0) return ''

      function renderCell(cell: HTMLElement | undefined): string {
        if (!cell) return ''
        return escapePipeCell(td.turndown(cell.innerHTML))
      }

      function padCells(cells: HTMLElement[]): string[] {
        const out: string[] = []
        for (let i = 0; i < colCount; i++) out.push(renderCell(cells[i]))
        return out
      }

      const headerCellsPadded = padCells(headerCells.length > 0
        ? headerCells
        : Array.from({ length: colCount }, () => null as unknown as HTMLElement))
      // Collect alignment from header cells (where available) — falls back
      // to scanning the first body row.
      const aligns: (string | null)[] = []
      for (let i = 0; i < colCount; i++) {
        const probe = headerCells[i] ?? sampleBodyCells[i] ?? null
        if (!probe) { aligns.push(null); continue }
        const style = (probe.getAttribute('style') ?? '').toLowerCase()
        const m = style.match(/text-align\s*:\s*(left|center|right)/)
        if (m && m[1]) { aligns.push(m[1]); continue }
        const inline = (probe.getAttribute('align') ?? '').toLowerCase()
        if (inline === 'left' || inline === 'center' || inline === 'right') {
          aligns.push(inline)
          continue
        }
        aligns.push(null)
      }
      const headerLine = `| ${headerCellsPadded.join(' | ')} |`
      const sepLine = `| ${aligns.map(a => alignSpec(a)).join(' | ')} |`
      const bodyLines = bodyRows.map((r) => {
        const cells = padCells(rowToCells(r))
        return `| ${cells.join(' | ')} |`
      })
      const lines = [headerLine, sepLine, ...bodyLines]
      return `\n\n${lines.join('\n')}\n\n`
    },
  })

  /* ------------------------------------------------------------------ */
  /*  Transclusion — `![[slug]]`                                        */
  /* ------------------------------------------------------------------ */
  td.addRule('transclusion', {
    filter: (node) =>
      (node.nodeName === 'SPAN' || node.nodeName === 'DIV')
      && (node as HTMLElement).classList.contains('transclusion'),
    replacement: (_content, node) => {
      const slug = (node as HTMLElement).getAttribute('data-slug') ?? ''
      if (!slug) return ''
      return `![[${slug}]]`
    },
  })

  /* ------------------------------------------------------------------ */
  /*  Whiteboard — pass through as raw HTML block                       */
  /* ------------------------------------------------------------------ */
  td.addRule('whiteboard', {
    filter: (node) =>
      node.nodeName === 'DIV'
      && (node as HTMLElement).classList.contains('whiteboard'),
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const scene = el.getAttribute('data-scene') ?? ''
      const w = el.getAttribute('data-w') ?? '800'
      const h = el.getAttribute('data-h') ?? '480'
      const preview = el.getAttribute('data-preview') ?? ''
      const attrs = [
        `class="whiteboard"`,
        scene ? `data-scene="${scene}"` : '',
        `data-w="${w}"`,
        `data-h="${h}"`,
        preview ? `data-preview="${preview}"` : '',
      ].filter(Boolean).join(' ')
      return `\n\n<div ${attrs}></div>\n\n`
    },
  })

  turndownInstance = td
  return td
}

export function htmlToMarkdown(html: string): string {
  if (!html) return ''
  return getTurndown().turndown(html)
}

export function markdownToHtml(md: string): string {
  if (!md) return ''
  ensureMarked()
  // marked.parse can return a Promise when async extensions are registered;
  // we don't use any, so we cast to string.
  return marked.parse(md, { async: false, breaks: false, gfm: true }) as string
}

/**
 * Heuristic: does this text contain markdown-y syntax that would be lost if
 * we pasted it as plain text? Used by the editor's paste handler to decide
 * whether to round-trip through `markdownToHtml`.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 2) return false
  const patterns: RegExp[] = [
    /^#{1,6}\s+\S/m,            // headings
    /^\s*[-*+]\s+\S/m,          // bullet list
    /^\s*\d+\.\s+\S/m,          // ordered list
    /^\s*>\s+\S/m,              // blockquote
    /^\s*```/m,                 // fenced code block
    /^\s*~~~/m,                 // fenced code block (alt)
    /^\s{0,3}---+\s*$/m,        // horizontal rule
    /^\s*- \[[ xX]\]\s/m,       // task list
    /\[[^\]\n]+\]\([^)\n]+\)/,  // [text](url) link
    /!\[[^\]\n]*\]\([^)\n]+\)/, // image
    /\*\*[^*\n]+\*\*/,          // **bold**
    /__[^_\n]+__/,              // __bold__
    /~~[^~\n]+~~/,              // ~~strike~~
    /`[^`\n]+`/,                // `inline code`
    /\$\$[\s\S]+?\$\$/,         // $$ block math $$
    /(?<!\\)\$[^$\n]+?(?<!\\)\$/, // $ inline math $ (no escapes)
    /^\s*>\s*\[!(?:INFO|TIP|WARN|QUOTE)\]/im, // GFM-style callout
    /\[\^[^\]\n]+\]/,           // [^1] footnote ref / definition prefix
    /<details(?:\s[^>]*)?>/i,   // <details> collapsible
    /!\[\[[^\]\n]+\]\]/,        // ![[transclusion]]
    /<div\s+class="whiteboard"/i, // whiteboard block
    /^\|.*\|.*\n\|[\s:|-]+\|/m, // GFM pipe table
  ]
  return patterns.some(p => p.test(text))
}

export function useEditorMarkdown() {
  return { htmlToMarkdown, markdownToHtml, looksLikeMarkdown }
}
