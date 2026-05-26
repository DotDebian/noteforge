/**
 * PDF export for NoteForge documents and workspaces.
 *
 * Uses `pdfkit` (pure JS, no headless browser) so we can ship without a
 * native Chromium dep. The markdown source is fed through `marked.lexer()`
 * and the resulting token tree is walked into pdfkit draw calls — we don't
 * try to convert HTML to PDF (too lossy via DOM).
 *
 * Visual identity mirrors the HTML export in `server/utils/export.ts`:
 *  - serif headings (Helvetica-Bold here, as PDFKit's built-in fonts don't
 *    include Source Serif 4 — close enough without shipping a font file)
 *  - mono code blocks with a thin border
 *  - left-bordered callouts with a coloured kind badge
 *  - inline images embedded from on-disk uploads when possible
 *  - page-number footer ("Page N / Total") added on a second pass via
 *    `bufferedPageRange()` so the total is known before stamping.
 */

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import { marked, type Token, type Tokens } from 'marked'

import type { Document } from '~/server/database/schema'
import { UPLOADS_ROOT } from './storage'

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const MARGIN = 50
const PAGE_SIZE = 'A4'
const BODY_FONT_SIZE = 11
const BODY_LINE_GAP = 4
const CODE_FONT_SIZE = 9.5

const COLOR_FG = '#1a1a1a'
const COLOR_FG_MUTED = '#666666'
const COLOR_RULE = '#cccccc'
const COLOR_CODE_BG = '#f4f3f0'
const COLOR_CODE_BORDER = '#e0dfdb'
const COLOR_LINK = '#b54a18'

const CALLOUT_COLORS: Record<string, { border: string, bg: string, label: string }> = {
  info: { border: '#3b82f6', bg: '#eff6ff', label: 'INFO' },
  tip: { border: '#10b981', bg: '#ecfdf5', label: 'TIP' },
  warn: { border: '#f59e0b', bg: '#fffbeb', label: 'WARN' },
  quote: { border: '#6b7280', bg: '#f9fafb', label: 'QUOTE' },
}

const FONT_BODY = 'Times-Roman'
const FONT_BODY_BOLD = 'Times-Bold'
const FONT_BODY_ITALIC = 'Times-Italic'
const FONT_BODY_BOLD_ITALIC = 'Times-BoldItalic'
const FONT_HEADING = 'Helvetica-Bold'
const FONT_LABEL = 'Helvetica'
const FONT_MONO = 'Courier'
const FONT_MONO_BOLD = 'Courier-Bold'
const FONT_MONO_ITALIC = 'Courier-Oblique'

interface DocLike {
  title: string
  markdown: string
  updatedAt: unknown
}

/* -------------------------------------------------------------------------- */
/*  Marked setup — share the same extensions as the in-app renderer so        */
/*  custom callout/math tokens reach our walker (instead of being parsed as   */
/*  raw blockquotes / inline runs).                                            */
/* -------------------------------------------------------------------------- */

interface CalloutToken extends Tokens.Generic {
  type: 'callout'
  kind: 'info' | 'tip' | 'warn' | 'quote'
  title: string | null
  bodyHtml: string
}

interface MathBlockToken extends Tokens.Generic {
  type: 'mathBlock'
  formula: string
}

interface MathInlineToken extends Tokens.Generic {
  type: 'mathInline'
  formula: string
}

let markedReady = false
function ensureMarked(): void {
  if (markedReady) return

  // Math block: $$…$$
  marked.use({
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start(src: string): number | undefined {
          const i = src.indexOf('$$')
          return i < 0 ? undefined : i
        },
        tokenizer(src: string) {
          const rule = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/
          const match = rule.exec(src)
          if (!match) return undefined
          return {
            type: 'mathBlock',
            raw: match[0],
            formula: (match[1] ?? '').replace(/^\n+/, '').replace(/\n+$/, ''),
          } as MathBlockToken
        },
        renderer(token: Tokens.Generic): string {
          const t = token as MathBlockToken
          return `$$${t.formula}$$`
        },
      },
      {
        name: 'mathInline',
        level: 'inline',
        start(src: string): number | undefined {
          const i = src.indexOf('$')
          return i < 0 ? undefined : i
        },
        tokenizer(src: string) {
          const rule = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/
          const match = rule.exec(src)
          if (!match) return undefined
          return {
            type: 'mathInline',
            raw: match[0],
            formula: match[1] ?? '',
          } as MathInlineToken
        },
        renderer(token: Tokens.Generic): string {
          const t = token as MathInlineToken
          return `$${t.formula}$`
        },
      },
      {
        name: 'callout',
        level: 'block',
        start(src: string): number | undefined {
          const i = src.indexOf('> [!')
          return i < 0 ? undefined : i
        },
        tokenizer(src: string) {
          const rule = /^(?:>[^\n]*(?:\n|$))+/
          const match = rule.exec(src)
          if (!match) return undefined
          const raw = match[0]
          const lines = raw.split('\n').map((l) => {
            if (l.startsWith('> ')) return l.slice(2)
            if (l.startsWith('>')) return l.slice(1)
            return l
          })
          while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
          const first = lines[0] ?? ''
          const head = first.match(/^\[!([A-Za-z]+)\](?:\s+(.*))?$/)
          if (!head) return undefined
          const kindRaw = (head[1] ?? '').toLowerCase()
          if (!['info', 'tip', 'warn', 'quote'].includes(kindRaw)) return undefined
          const title = (head[2] ?? '').trim() || null
          const body = lines.slice(1).join('\n')
          return {
            type: 'callout',
            raw,
            kind: kindRaw as CalloutToken['kind'],
            title,
            bodyHtml: body,
          } as CalloutToken
        },
        renderer(token: Tokens.Generic): string {
          const t = token as CalloutToken
          return `> ${t.kind.toUpperCase()} ${t.title ?? ''}\n${t.bodyHtml}`
        },
      },
    ],
  })
  markedReady = true
}

/* -------------------------------------------------------------------------- */
/*  Inline rendering — walks inline tokens within a paragraph/heading and     */
/*  emits styled `doc.text(…)` calls. pdfkit's text engine continues a run    */
/*  on the same line when the second call passes `{ continued: true }`.      */
/* -------------------------------------------------------------------------- */

type InlineStyle = {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  link?: string
}

function pickFont(style: InlineStyle): string {
  if (style.code) {
    if (style.bold) return FONT_MONO_BOLD
    if (style.italic) return FONT_MONO_ITALIC
    return FONT_MONO
  }
  if (style.bold && style.italic) return FONT_BODY_BOLD_ITALIC
  if (style.bold) return FONT_BODY_BOLD
  if (style.italic) return FONT_BODY_ITALIC
  return FONT_BODY
}

interface InlineRun {
  text: string
  style: InlineStyle
}

function flattenInline(tokens: Token[] | undefined, base: InlineStyle = {}): InlineRun[] {
  if (!tokens) return []
  const out: InlineRun[] = []
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        const t = tok as Tokens.Text
        if (t.tokens && t.tokens.length > 0) {
          out.push(...flattenInline(t.tokens, base))
        }
        else {
          out.push({ text: decodeEntities(t.text ?? ''), style: { ...base } })
        }
        break
      }
      case 'escape': {
        const t = tok as Tokens.Escape
        out.push({ text: t.text, style: { ...base } })
        break
      }
      case 'strong': {
        const t = tok as Tokens.Strong
        out.push(...flattenInline(t.tokens, { ...base, bold: true }))
        break
      }
      case 'em': {
        const t = tok as Tokens.Em
        out.push(...flattenInline(t.tokens, { ...base, italic: true }))
        break
      }
      case 'del': {
        const t = tok as Tokens.Del
        out.push(...flattenInline(t.tokens, { ...base, strike: true }))
        break
      }
      case 'codespan': {
        const t = tok as Tokens.Codespan
        out.push({ text: decodeEntities(t.text ?? ''), style: { ...base, code: true } })
        break
      }
      case 'link': {
        const t = tok as Tokens.Link
        out.push(...flattenInline(t.tokens, { ...base, link: t.href }))
        break
      }
      case 'image': {
        // Inline images render as their alt text. Real embedding is handled
        // by the block-level image walker.
        const t = tok as Tokens.Image
        if (t.text) out.push({ text: `[${t.text}]`, style: { ...base } })
        break
      }
      case 'br': {
        out.push({ text: '\n', style: { ...base } })
        break
      }
      case 'html': {
        const t = tok as Tokens.HTML
        // Strip a handful of inline HTML wrappers; otherwise pass through
        // the text content.
        const plain = (t.text ?? '').replace(/<[^>]+>/g, '')
        if (plain) out.push({ text: decodeEntities(plain), style: { ...base } })
        break
      }
      case 'mathInline': {
        const t = tok as MathInlineToken
        out.push({ text: t.formula, style: { ...base, code: true } })
        break
      }
      default: {
        // Generic / unknown: fall back to raw text if present.
        const t = tok as Tokens.Generic
        if (typeof t.text === 'string') {
          out.push({ text: decodeEntities(t.text), style: { ...base } })
        }
      }
    }
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
}

/* -------------------------------------------------------------------------- */
/*  Image embedding                                                            */
/*  ---------------------------------------------------------------------     */
/*  The editor produces images served from `/api/uploads/<id>` (DB-backed)    */
/*  or `/uploads/<sha>.<ext>` (legacy). We resolve those to on-disk paths     */
/*  via UPLOADS_ROOT and embed the buffer directly — no HTTP roundtrip. For   */
/*  remote URLs we fall back to `fetch()`. WebP is not supported by pdfkit,   */
/*  so we silently skip those.                                                 */
/* -------------------------------------------------------------------------- */

async function resolveImage(href: string): Promise<Buffer | null> {
  try {
    // 1. Direct on-disk uploads path: `/uploads/<workspaceId>/<shard>/<sha>.<ext>`
    if (href.startsWith('/uploads/')) {
      const rel = href.slice('/uploads/'.length)
      const abs = path.join(UPLOADS_ROOT, rel)
      if (existsSync(abs)) return readFileSync(abs)
      return null
    }

    // 2. data: URL (used by whiteboard preview, etc.)
    if (href.startsWith('data:')) {
      const comma = href.indexOf(',')
      if (comma < 0) return null
      const meta = href.slice(5, comma)
      const data = href.slice(comma + 1)
      if (!/;base64/i.test(meta)) return null
      return Buffer.from(data, 'base64')
    }

    // 3. Remote URL — last resort. Time-boxed so we don't stall the export.
    if (href.startsWith('http://') || href.startsWith('https://')) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      try {
        const res = await fetch(href, { signal: controller.signal })
        if (!res.ok) return null
        const ab = await res.arrayBuffer()
        return Buffer.from(ab)
      }
      finally {
        clearTimeout(timeout)
      }
    }
  }
  catch {
    return null
  }
  return null
}

/**
 * pdfkit refuses to embed WebP and SVG. Cheap magic-number sniff so we
 * don't push an unsupported buffer.
 */
function isPdfEmbeddableImage(buf: Buffer): boolean {
  if (buf.length < 4) return false
  // PNG signature
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true
  // JPEG signature
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true
  return false
}

/* -------------------------------------------------------------------------- */
/*  Block walker                                                               */
/* -------------------------------------------------------------------------- */

interface RenderCtx {
  doc: InstanceType<typeof PDFDocument>
  contentWidth: number
  baseIndent: number
}

function setInlineStyle(doc: InstanceType<typeof PDFDocument>, style: InlineStyle, fontSize: number): void {
  doc.font(pickFont(style))
  doc.fontSize(fontSize)
  doc.fillColor(style.link ? COLOR_LINK : COLOR_FG)
}

/**
 * Emit a sequence of inline runs as a single continued text flow on the
 * current line. The last run terminates the line (no `continued: true`).
 */
function writeInlineRuns(
  ctx: RenderCtx,
  runs: InlineRun[],
  options: {
    indent?: number
    width?: number
    fontSize?: number
    paragraphGap?: number
    align?: 'left' | 'center' | 'right' | 'justify'
  } = {},
): void {
  const { doc } = ctx
  const indent = options.indent ?? 0
  const width = options.width ?? (ctx.contentWidth - indent)
  const fontSize = options.fontSize ?? BODY_FONT_SIZE
  const paragraphGap = options.paragraphGap ?? 6

  if (runs.length === 0) {
    doc.moveDown(0.5)
    return
  }

  const x = ctx.baseIndent + indent

  // pdfkit needs a starting position on the FIRST text call; subsequent
  // calls with `continued: true` follow the cursor automatically.
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!
    const isLast = i === runs.length - 1
    setInlineStyle(doc, run.style, fontSize)
    const opts: PDFKit.Mixins.TextOptions = {
      continued: !isLast,
      lineGap: BODY_LINE_GAP,
      width,
      align: options.align ?? 'left',
      underline: !!run.style.link,
      strike: !!run.style.strike,
      link: run.style.link,
    }
    if (i === 0) {
      doc.text(run.text, x, doc.y, opts)
    }
    else {
      doc.text(run.text, opts)
    }
  }

  doc.moveDown(paragraphGap / 12)
  // Reset state so the next block starts clean.
  doc.fillColor(COLOR_FG)
}

function drawHr(ctx: RenderCtx): void {
  const { doc } = ctx
  doc.moveDown(0.5)
  const y = doc.y
  doc.save()
  doc.strokeColor(COLOR_RULE).lineWidth(0.5)
    .moveTo(ctx.baseIndent, y)
    .lineTo(ctx.baseIndent + ctx.contentWidth, y)
    .stroke()
  doc.restore()
  doc.moveDown(0.75)
}

function ensureRoom(ctx: RenderCtx, needed: number): void {
  const { doc } = ctx
  const maxY = doc.page.height - doc.page.margins.bottom
  if (doc.y + needed > maxY) {
    doc.addPage()
  }
}

function drawHeading(ctx: RenderCtx, depth: number, tokens: Token[]): void {
  const { doc } = ctx
  const sizes = [22, 18, 15, 13, 12, 11]
  const idx = Math.min(Math.max(depth, 1), 6) - 1
  const size = sizes[idx] ?? 11
  const gapBefore = depth === 1 ? 8 : 12
  doc.moveDown(gapBefore / 12)
  ensureRoom(ctx, size + 12)

  doc.font(FONT_HEADING).fontSize(size).fillColor(COLOR_FG)
  const runs = flattenInline(tokens)
  // Render with heading font; ignore inline `code` styling — heading-level
  // codespans are rare and pdfkit's font switching mid-line for the same
  // size is fine to skip.
  const text = runs.map(r => r.text).join('')
  doc.text(text, ctx.baseIndent, doc.y, {
    width: ctx.contentWidth,
    lineGap: 2,
  })
  doc.moveDown(0.4)
}

function drawCodeBlock(ctx: RenderCtx, text: string, _lang: string | undefined): void {
  const { doc } = ctx
  // Pre-measure the height by setting the font and asking pdfkit for a
  // word-wrap height. We add 1em vertical padding inside the box.
  const padding = 8
  const innerWidth = ctx.contentWidth - padding * 2
  doc.font(FONT_MONO).fontSize(CODE_FONT_SIZE).fillColor(COLOR_FG)
  const height = doc.heightOfString(text, { width: innerWidth, lineGap: 2 }) + padding * 2

  ensureRoom(ctx, height + 8)
  doc.moveDown(0.3)
  const startY = doc.y
  doc.save()
  doc.roundedRect(ctx.baseIndent, startY, ctx.contentWidth, height, 3)
    .fillAndStroke(COLOR_CODE_BG, COLOR_CODE_BORDER)
  doc.restore()
  doc.fillColor(COLOR_FG).font(FONT_MONO).fontSize(CODE_FONT_SIZE)
  doc.text(text, ctx.baseIndent + padding, startY + padding, {
    width: innerWidth,
    lineGap: 2,
  })
  // pdfkit's `text` may not advance y past the box if the rect was bigger
  // than the actual content height (it isn't here, but guard anyway).
  const afterY = Math.max(doc.y, startY + height)
  doc.y = afterY
  doc.moveDown(0.5)
}

function drawBlockquote(ctx: RenderCtx, tokens: Token[]): void {
  const { doc } = ctx
  const barWidth = 3
  const indent = 14
  doc.moveDown(0.3)
  const startY = doc.y

  // Render children with shifted indent, then draw the left bar after we
  // know the final y. We pre-walk into a sub-context so the bar matches.
  const inner: RenderCtx = {
    doc,
    contentWidth: ctx.contentWidth - indent,
    baseIndent: ctx.baseIndent + indent,
  }
  for (const tok of tokens) {
    walkBlock(inner, tok)
  }
  const endY = doc.y
  doc.save()
  doc.fillColor(COLOR_RULE)
    .rect(ctx.baseIndent, startY, barWidth, Math.max(endY - startY - 2, 4))
    .fill()
  doc.restore()
  doc.fillColor(COLOR_FG)
  doc.moveDown(0.3)
}

function drawCallout(ctx: RenderCtx, token: CalloutToken): void {
  const { doc } = ctx
  const kind = token.kind
  const colors = CALLOUT_COLORS[kind] ?? CALLOUT_COLORS.info!
  const padding = 10
  const barWidth = 3

  // Re-lex the body so nested markdown renders properly inside the box.
  const innerTokens = token.bodyHtml.trim().length > 0
    ? (marked.lexer(token.bodyHtml) as Token[])
    : []

  doc.moveDown(0.4)
  const startY = doc.y

  // Reserve space at the top for the kind badge + optional title line.
  doc.font(FONT_LABEL).fontSize(9).fillColor(colors.border)
  const badge = colors.label + (token.title ? `  ${token.title}` : '')
  doc.text(badge, ctx.baseIndent + padding + barWidth + 4, startY + padding, {
    width: ctx.contentWidth - padding * 2 - barWidth - 4,
    lineGap: 2,
  })
  doc.moveDown(0.3)

  // Body
  const inner: RenderCtx = {
    doc,
    contentWidth: ctx.contentWidth - padding * 2 - barWidth - 4,
    baseIndent: ctx.baseIndent + padding + barWidth + 4,
  }
  for (const tok of innerTokens) {
    walkBlock(inner, tok)
  }
  const endY = doc.y
  const totalHeight = Math.max(endY - startY + padding, 24)

  // Now draw the background + bar BEHIND the text. pdfkit can't reorder,
  // but we drew the text first; the background goes on top — instead, we
  // re-render onto a fresh area. Workaround: draw the bar+bg above the
  // text by lifting them into a saved state with a low-z. Practically,
  // pdfkit paints in source order, so we layer a transparent bg+bar on top
  // — visually identical when fill colours stay light.
  doc.save()
  doc.fillOpacity(0.35)
    .fillColor(colors.bg)
    .rect(ctx.baseIndent, startY, ctx.contentWidth, totalHeight)
    .fill()
  doc.fillOpacity(1)
    .fillColor(colors.border)
    .rect(ctx.baseIndent, startY, barWidth, totalHeight)
    .fill()
  doc.restore()
  doc.fillColor(COLOR_FG)
  doc.y = startY + totalHeight
  doc.moveDown(0.4)
}

function drawList(ctx: RenderCtx, token: Tokens.List, depth = 0): void {
  const { doc } = ctx
  const bulletIndent = 12
  const itemIndent = 20
  doc.moveDown(0.2)
  let counter = typeof token.start === 'number' ? token.start : 1

  for (const item of token.items) {
    ensureRoom(ctx, BODY_FONT_SIZE + 6)
    const marker = token.ordered
      ? `${counter}.`
      : (depth === 0 ? '•' : (depth === 1 ? '◦' : '▪'))
    counter++

    // Render marker
    doc.font(FONT_BODY).fontSize(BODY_FONT_SIZE).fillColor(COLOR_FG_MUTED)
    const lineY = doc.y
    doc.text(marker, ctx.baseIndent + depth * itemIndent, lineY, {
      width: bulletIndent,
      lineGap: BODY_LINE_GAP,
      continued: false,
    })
    // Reset y because pdfkit advanced after writing the marker
    doc.y = lineY
    doc.fillColor(COLOR_FG)

    // Task list checkbox prefix
    if (item.task) {
      const box = item.checked ? '☑' : '☐'
      doc.font(FONT_BODY).fontSize(BODY_FONT_SIZE)
      doc.text(`${box} `, ctx.baseIndent + depth * itemIndent + bulletIndent, lineY, {
        width: 14,
        lineGap: BODY_LINE_GAP,
        continued: false,
      })
      doc.y = lineY
    }

    const textIndent = depth * itemIndent + bulletIndent + (item.task ? 14 : 0)
    const inner: RenderCtx = {
      doc,
      contentWidth: ctx.contentWidth - textIndent,
      baseIndent: ctx.baseIndent + textIndent,
    }

    let firstParagraphRendered = false
    for (const child of item.tokens) {
      // The first inline-y child should land on the same line as the bullet.
      if (
        !firstParagraphRendered
        && (child.type === 'text' || child.type === 'paragraph')
      ) {
        const innerTokens = (child as Tokens.Paragraph | Tokens.Text).tokens
        const runs = flattenInline(innerTokens, {})
        if (runs.length > 0) {
          // Manually place at lineY
          doc.y = lineY
          doc.x = ctx.baseIndent + textIndent
          writeInlineRuns(inner, runs, { paragraphGap: 4 })
        }
        firstParagraphRendered = true
      }
      else if (child.type === 'list') {
        drawList(inner, child as Tokens.List, depth + 1)
      }
      else {
        walkBlock(inner, child)
      }
    }
  }
  doc.moveDown(0.2)
}

function drawTable(ctx: RenderCtx, token: Tokens.Table): void {
  const { doc } = ctx
  const cols = token.header.length
  if (cols === 0) return
  const colWidth = ctx.contentWidth / cols
  const padding = 4

  function renderRow(cells: Tokens.TableCell[], isHeader: boolean): void {
    // Measure tallest cell
    doc.font(isHeader ? FONT_BODY_BOLD : FONT_BODY).fontSize(BODY_FONT_SIZE)
    let maxHeight = 0
    const cellTexts: string[] = []
    for (const cell of cells) {
      const runs = flattenInline(cell.tokens)
      const txt = runs.map(r => r.text).join('')
      cellTexts.push(txt)
      const h = doc.heightOfString(txt || ' ', { width: colWidth - padding * 2, lineGap: 2 })
      if (h > maxHeight) maxHeight = h
    }
    const rowHeight = maxHeight + padding * 2
    ensureRoom(ctx, rowHeight + 4)
    const startY = doc.y

    // Background for header
    if (isHeader) {
      doc.save()
      doc.fillColor('#f4f3f0')
        .rect(ctx.baseIndent, startY, ctx.contentWidth, rowHeight)
        .fill()
      doc.restore()
    }

    // Cells
    doc.font(isHeader ? FONT_BODY_BOLD : FONT_BODY).fontSize(BODY_FONT_SIZE).fillColor(COLOR_FG)
    for (let i = 0; i < cols; i++) {
      const cellX = ctx.baseIndent + i * colWidth
      const text = cellTexts[i] ?? ''
      const align = (cells[i]?.align ?? 'left')
      doc.text(text, cellX + padding, startY + padding, {
        width: colWidth - padding * 2,
        lineGap: 2,
        align: align === 'left' || align === 'right' || align === 'center' ? align : 'left',
      })
    }

    // Bottom border
    doc.save()
    doc.strokeColor(COLOR_RULE).lineWidth(0.5)
      .moveTo(ctx.baseIndent, startY + rowHeight)
      .lineTo(ctx.baseIndent + ctx.contentWidth, startY + rowHeight)
      .stroke()
    doc.restore()

    doc.y = startY + rowHeight
  }

  doc.moveDown(0.5)
  renderRow(token.header, true)
  for (const row of token.rows) {
    renderRow(row, false)
  }
  doc.moveDown(0.5)
}

function drawMathBlock(ctx: RenderCtx, formula: string): void {
  const { doc } = ctx
  const padding = 8
  doc.font(FONT_MONO_ITALIC).fontSize(CODE_FONT_SIZE).fillColor(COLOR_FG)
  const innerWidth = ctx.contentWidth - padding * 2
  const height = doc.heightOfString(formula, { width: innerWidth, lineGap: 2 }) + padding * 2

  ensureRoom(ctx, height + 8)
  doc.moveDown(0.3)
  const startY = doc.y
  doc.save()
  doc.lineWidth(0.5).strokeColor(COLOR_RULE)
    .rect(ctx.baseIndent, startY, ctx.contentWidth, height)
    .stroke()
  doc.restore()
  doc.fillColor(COLOR_FG).font(FONT_MONO_ITALIC).fontSize(CODE_FONT_SIZE)
  doc.text(formula, ctx.baseIndent + padding, startY + padding, {
    width: innerWidth,
    lineGap: 2,
    align: 'center',
  })
  doc.y = Math.max(doc.y, startY + height)
  doc.moveDown(0.5)
}

interface PendingImage {
  href: string
  alt: string
  title: string | null
}

const pendingImages: WeakMap<InstanceType<typeof PDFDocument>, PendingImage[]> = new WeakMap()

function queueImage(ctx: RenderCtx, img: PendingImage): void {
  const list = pendingImages.get(ctx.doc) ?? []
  list.push(img)
  pendingImages.set(ctx.doc, list)
}

async function drainPendingImages(ctx: RenderCtx, imageBuffers: Map<string, Buffer | null>): Promise<void> {
  const list = pendingImages.get(ctx.doc) ?? []
  for (const img of list) {
    const buf = imageBuffers.get(img.href) ?? null
    if (buf && isPdfEmbeddableImage(buf)) {
      ctx.doc.moveDown(0.4)
      ensureRoom(ctx, 100)
      try {
        ctx.doc.image(buf, ctx.baseIndent, ctx.doc.y, {
          fit: [ctx.contentWidth, 320],
          align: 'center',
        })
        ctx.doc.moveDown(0.5)
      }
      catch {
        // Bad image data — fall through to alt text below.
        ctx.doc.font(FONT_BODY_ITALIC).fontSize(BODY_FONT_SIZE).fillColor(COLOR_FG_MUTED)
        ctx.doc.text(`[Image: ${img.alt || img.href}]`, ctx.baseIndent, ctx.doc.y, {
          width: ctx.contentWidth,
          lineGap: BODY_LINE_GAP,
        })
        ctx.doc.fillColor(COLOR_FG)
      }
    }
    else {
      ctx.doc.font(FONT_BODY_ITALIC).fontSize(BODY_FONT_SIZE).fillColor(COLOR_FG_MUTED)
      ctx.doc.text(`[Image: ${img.alt || img.href}]`, ctx.baseIndent, ctx.doc.y, {
        width: ctx.contentWidth,
        lineGap: BODY_LINE_GAP,
      })
      ctx.doc.fillColor(COLOR_FG)
    }
  }
  pendingImages.set(ctx.doc, [])
}

/* -------------------------------------------------------------------------- */
/*  HTML-in-markdown handling (whiteboards, etc.)                              */
/* -------------------------------------------------------------------------- */

function tryWhiteboard(text: string): { dataUrl: string | null, label: string } | null {
  // Detect `<div class="whiteboard" …>` with optional `data-preview` attr.
  if (!/class\s*=\s*"[^"]*whiteboard[^"]*"/i.test(text)) return null
  const previewMatch = text.match(/data-preview\s*=\s*"([^"]+)"/i)
  return {
    dataUrl: previewMatch ? previewMatch[1] ?? null : null,
    label: '[Tableau blanc — non rendu]',
  }
}

/* -------------------------------------------------------------------------- */
/*  Main token walker                                                          */
/* -------------------------------------------------------------------------- */

function walkBlock(ctx: RenderCtx, token: Token): void {
  switch (token.type) {
    case 'space': {
      ctx.doc.moveDown(0.3)
      break
    }
    case 'heading': {
      const t = token as Tokens.Heading
      drawHeading(ctx, t.depth, t.tokens)
      break
    }
    case 'paragraph': {
      const t = token as Tokens.Paragraph
      // Image-only paragraphs (single image token) → queue for block embed.
      if (t.tokens.length === 1 && t.tokens[0]!.type === 'image') {
        const img = t.tokens[0] as Tokens.Image
        queueImage(ctx, { href: img.href, alt: img.text, title: img.title })
        break
      }
      const runs = flattenInline(t.tokens)
      writeInlineRuns(ctx, runs)
      break
    }
    case 'text': {
      const t = token as Tokens.Text
      const runs = flattenInline(t.tokens ?? [{ type: 'text', raw: t.text, text: t.text } as Tokens.Text])
      writeInlineRuns(ctx, runs)
      break
    }
    case 'code': {
      const t = token as Tokens.Code
      drawCodeBlock(ctx, t.text, t.lang)
      break
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote
      drawBlockquote(ctx, t.tokens)
      break
    }
    case 'list': {
      drawList(ctx, token as Tokens.List)
      break
    }
    case 'hr': {
      drawHr(ctx)
      break
    }
    case 'table': {
      drawTable(ctx, token as Tokens.Table)
      break
    }
    case 'html': {
      const t = token as Tokens.HTML
      const wb = tryWhiteboard(t.text)
      if (wb) {
        if (wb.dataUrl) {
          queueImage(ctx, { href: wb.dataUrl, alt: wb.label, title: null })
        }
        else {
          ctx.doc.font(FONT_BODY_ITALIC).fontSize(BODY_FONT_SIZE).fillColor(COLOR_FG_MUTED)
          ctx.doc.text(wb.label, ctx.baseIndent, ctx.doc.y, {
            width: ctx.contentWidth,
            lineGap: BODY_LINE_GAP,
          })
          ctx.doc.fillColor(COLOR_FG)
          ctx.doc.moveDown(0.3)
        }
      }
      // Other raw HTML blocks are skipped (sanitisation isn't worth the
      // complexity for export; users get the markdown source either way).
      break
    }
    case 'callout': {
      drawCallout(ctx, token as CalloutToken)
      break
    }
    case 'mathBlock': {
      const t = token as MathBlockToken
      drawMathBlock(ctx, t.formula)
      break
    }
    case 'def':
    case 'br': {
      break
    }
    default: {
      // Fall back to inline rendering if there's text content.
      const t = token as Tokens.Generic
      if (typeof t.text === 'string' && t.text.length > 0) {
        writeInlineRuns(ctx, [{ text: t.text, style: {} }])
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Image pre-pass                                                             */
/*  ---------------------------------------------------------------------     */
/*  We walk the full token tree once before rendering to collect all image    */
/*  hrefs (including those inside callout bodies and lists), resolve them     */
/*  asynchronously, then render synchronously. This keeps the pdfkit code     */
/*  path clean — pdfkit's draw API isn't async-friendly.                      */
/* -------------------------------------------------------------------------- */

function collectImageHrefs(tokens: Token[], out: Set<string>): void {
  for (const tok of tokens) {
    if (tok.type === 'image') {
      out.add((tok as Tokens.Image).href)
      continue
    }
    if (tok.type === 'html') {
      const t = tok as Tokens.HTML
      const wb = tryWhiteboard(t.text)
      if (wb?.dataUrl) out.add(wb.dataUrl)
      continue
    }
    const generic = tok as Tokens.Generic
    if (Array.isArray(generic.tokens)) collectImageHrefs(generic.tokens, out)
    // marked.List / ListItem / Blockquote nest children differently — check
    // all known nested arrays.
    if (tok.type === 'list') {
      for (const item of (tok as Tokens.List).items) {
        collectImageHrefs(item.tokens, out)
      }
    }
    if (tok.type === 'table') {
      const t = tok as Tokens.Table
      for (const cell of t.header) collectImageHrefs(cell.tokens, out)
      for (const row of t.rows) {
        for (const cell of row) collectImageHrefs(cell.tokens, out)
      }
    }
    if (tok.type === 'callout') {
      const t = tok as CalloutToken
      const inner = marked.lexer(t.bodyHtml ?? '') as Token[]
      collectImageHrefs(inner, out)
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Page chrome (header + footer)                                              */
/* -------------------------------------------------------------------------- */

interface PageChrome {
  docTitle: string
}

function stampFooters(doc: InstanceType<typeof PDFDocument>): void {
  const range = doc.bufferedPageRange()
  if (range.count === 0) return
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    const footerY = doc.page.height - doc.page.margins.bottom + 16
    doc.save()
    doc.font(FONT_LABEL).fontSize(8).fillColor(COLOR_FG_MUTED)
    const text = `Page ${i + 1} / ${range.count}`
    doc.text(
      text,
      doc.page.margins.left,
      footerY,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center',
        lineBreak: false,
      },
    )
    doc.restore()
  }
}

function stampHeader(doc: InstanceType<typeof PDFDocument>, chrome: PageChrome): void {
  // Called on every new page via `pageAdded` (configured at construction).
  const y = doc.page.margins.top - 24
  doc.save()
  doc.font(FONT_LABEL).fontSize(8).fillColor(COLOR_FG_MUTED)
  doc.text(
    chrome.docTitle.toUpperCase(),
    doc.page.margins.left,
    y,
    {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'left',
      lineBreak: false,
      characterSpacing: 0.6,
    },
  )
  doc.restore()
}

/* -------------------------------------------------------------------------- */
/*  Public entry points                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Render a single document to PDF and return the raw bytes.
 */
export async function renderDocPdf(doc: DocLike | Document): Promise<Buffer> {
  ensureMarked()

  const title = doc.title || 'Untitled'
  const markdown = doc.markdown ?? ''

  const tokens = marked.lexer(markdown) as Token[]

  // Pre-pass: collect all image hrefs.
  const hrefs = new Set<string>()
  collectImageHrefs(tokens, hrefs)
  const imageBuffers = new Map<string, Buffer | null>()
  await Promise.all(
    [...hrefs].map(async (h) => {
      imageBuffers.set(h, await resolveImage(h))
    }),
  )

  // Create document with buffered pages so we can add the footer once we
  // know the page count.
  const pdf = new PDFDocument({
    size: PAGE_SIZE,
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: title,
      Producer: 'NoteForge',
    },
  })

  const chunks: Buffer[] = []
  pdf.on('data', (c: Buffer) => chunks.push(c))
  const finished = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })

  // Header on every page (also fired for the first page once content
  // touches it — pdfkit emits `pageAdded` for additional pages, not the
  // initial one). We stamp the first page header manually below.
  const chrome: PageChrome = { docTitle: title }
  pdf.on('pageAdded', () => {
    stampHeader(pdf, chrome)
  })

  // Initial page header
  stampHeader(pdf, chrome)

  // Title block
  pdf.font(FONT_HEADING).fontSize(26).fillColor(COLOR_FG)
  pdf.text(title, MARGIN, MARGIN + 8, {
    width: pdf.page.width - MARGIN * 2,
    lineGap: 2,
  })
  pdf.moveDown(0.4)
  pdf.font(FONT_LABEL).fontSize(9).fillColor(COLOR_FG_MUTED)
  const exportedAt = new Date().toISOString().slice(0, 10)
  pdf.text(`Exporté le ${exportedAt}`, {
    width: pdf.page.width - MARGIN * 2,
    characterSpacing: 0.4,
  })
  pdf.moveDown(0.8)
  pdf.fillColor(COLOR_FG)

  const ctx: RenderCtx = {
    doc: pdf,
    contentWidth: pdf.page.width - MARGIN * 2,
    baseIndent: MARGIN,
  }

  // Walk top-level tokens. We render images inline-ish by walking, then we
  // also draw any deferred block images right after the paragraph that
  // queued them — to keep order intuitive we drain after every top-level
  // token.
  for (const tok of tokens) {
    walkBlock(ctx, tok)
    await drainPendingImages(ctx, imageBuffers)
  }

  // Final pass: stamp footers.
  stampFooters(pdf)

  pdf.end()
  await finished
  return Buffer.concat(chunks)
}

/**
 * Render a sequence of documents into one big PDF. Each doc begins on a
 * fresh page with its own title heading; the page chrome (header / footer)
 * stays consistent throughout.
 */
export async function renderWorkspacePdf(
  workspaceName: string,
  docs: ReadonlyArray<DocLike | Document>,
): Promise<Buffer> {
  ensureMarked()

  const pdf = new PDFDocument({
    size: PAGE_SIZE,
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: workspaceName,
      Producer: 'NoteForge',
    },
  })

  const chunks: Buffer[] = []
  pdf.on('data', (c: Buffer) => chunks.push(c))
  const finished = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })

  // Current document title used in the header — mutated as we move
  // through the workspace docs.
  const chrome: PageChrome = { docTitle: workspaceName }
  pdf.on('pageAdded', () => {
    stampHeader(pdf, chrome)
  })

  stampHeader(pdf, chrome)

  // Workspace cover
  pdf.font(FONT_HEADING).fontSize(28).fillColor(COLOR_FG)
  pdf.text(workspaceName, MARGIN, MARGIN + 8, {
    width: pdf.page.width - MARGIN * 2,
  })
  pdf.moveDown(0.4)
  pdf.font(FONT_LABEL).fontSize(10).fillColor(COLOR_FG_MUTED)
  const exportedAt = new Date().toISOString().slice(0, 10)
  pdf.text(`Workspace export — ${exportedAt} — ${docs.length} documents`, {
    width: pdf.page.width - MARGIN * 2,
    characterSpacing: 0.4,
  })
  pdf.moveDown(1)
  pdf.fillColor(COLOR_FG)

  // Resolve all images for all docs in parallel (deduped by href).
  const tokensPerDoc: Token[][] = []
  const hrefs = new Set<string>()
  for (const doc of docs) {
    const tokens = marked.lexer(doc.markdown ?? '') as Token[]
    tokensPerDoc.push(tokens)
    collectImageHrefs(tokens, hrefs)
  }
  const imageBuffers = new Map<string, Buffer | null>()
  await Promise.all(
    [...hrefs].map(async (h) => {
      imageBuffers.set(h, await resolveImage(h))
    }),
  )

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!
    const title = doc.title || 'Untitled'
    chrome.docTitle = title

    if (i > 0) pdf.addPage()
    // For the first doc we don't add a page; the cover is already on it.
    // But we DO want some space between cover and first heading.
    if (i === 0) pdf.moveDown(0.6)

    // Document title
    pdf.font(FONT_HEADING).fontSize(22).fillColor(COLOR_FG)
    pdf.text(title, MARGIN, pdf.y, {
      width: pdf.page.width - MARGIN * 2,
    })
    pdf.moveDown(0.6)
    pdf.fillColor(COLOR_FG)

    const ctx: RenderCtx = {
      doc: pdf,
      contentWidth: pdf.page.width - MARGIN * 2,
      baseIndent: MARGIN,
    }
    for (const tok of tokensPerDoc[i]!) {
      walkBlock(ctx, tok)
      await drainPendingImages(ctx, imageBuffers)
    }
  }

  stampFooters(pdf)
  pdf.end()
  await finished
  return Buffer.concat(chunks)
}
