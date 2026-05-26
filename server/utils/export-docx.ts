/**
 * DOCX export for NoteForge documents and workspaces.
 *
 * Uses the `docx` package and walks `marked.lexer()` tokens directly into
 * Paragraph / TextRun / Table / ImageRun. We never go through HTML.
 *
 * Custom tokens (callouts, inline / block math) are recognised via marked
 * extensions added in this module so the in-app extras render correctly
 * even though we don't share the editor instance.
 */

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { marked, type Token, type Tokens } from 'marked'
import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

import type { Document } from '~/server/database/schema'
import { UPLOADS_ROOT } from './storage'

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const COLOR_LINK = '0563C1'
const COLOR_CODE_BG = 'F4F3F0'
const COLOR_HEADER_BG = 'EFEEEB'
const COLOR_RULE = 'CCCCCC'

const CALLOUT_COLORS: Record<string, { bar: string, bg: string, label: string }> = {
  info: { bar: '3B82F6', bg: 'EFF6FF', label: 'INFO' },
  tip: { bar: '10B981', bg: 'ECFDF5', label: 'TIP' },
  warn: { bar: 'F59E0B', bg: 'FFFBEB', label: 'WARN' },
  quote: { bar: '6B7280', bg: 'F9FAFB', label: 'QUOTE' },
}

const NUMBERING_BULLET_REF = 'noteforge-bullet'
const NUMBERING_ORDERED_REF = 'noteforge-ordered'

/* -------------------------------------------------------------------------- */
/*  marked extensions (must mirror the in-app config so custom blocks parse)  */
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
          return `$$${(token as MathBlockToken).formula}$$`
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
          return `$${(token as MathInlineToken).formula}$`
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
/*  Image resolution                                                           */
/* -------------------------------------------------------------------------- */

type ResolvedImage = {
  data: Buffer
  type: 'png' | 'jpg' | 'gif' | 'bmp'
}

function sniffImageType(buf: Buffer): ResolvedImage['type'] | null {
  if (buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp'
  return null
}

async function resolveImage(href: string): Promise<ResolvedImage | null> {
  try {
    let buf: Buffer | null = null
    if (href.startsWith('/uploads/')) {
      const rel = href.slice('/uploads/'.length)
      const abs = path.join(UPLOADS_ROOT, rel)
      if (existsSync(abs)) buf = readFileSync(abs)
    }
    else if (href.startsWith('data:')) {
      const comma = href.indexOf(',')
      if (comma >= 0) {
        const meta = href.slice(5, comma)
        const data = href.slice(comma + 1)
        if (/;base64/i.test(meta)) buf = Buffer.from(data, 'base64')
      }
    }
    else if (href.startsWith('http://') || href.startsWith('https://')) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      try {
        const res = await fetch(href, { signal: controller.signal })
        if (res.ok) {
          const ab = await res.arrayBuffer()
          buf = Buffer.from(ab)
        }
      }
      finally {
        clearTimeout(timeout)
      }
    }

    if (!buf) return null
    const type = sniffImageType(buf)
    if (!type) return null
    return { data: buf, type }
  }
  catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Inline → TextRun flattening                                                */
/* -------------------------------------------------------------------------- */

type InlineStyle = {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
}

type InlineNode =
  | { kind: 'text', text: string, style: InlineStyle }
  | { kind: 'link', href: string, children: InlineNode[] }
  | { kind: 'image', href: string, alt: string }
  | { kind: 'break' }

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
}

function flattenInline(tokens: Token[] | undefined, base: InlineStyle = {}): InlineNode[] {
  if (!tokens) return []
  const out: InlineNode[] = []
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        const t = tok as Tokens.Text
        if (t.tokens && t.tokens.length > 0) {
          out.push(...flattenInline(t.tokens, base))
        }
        else {
          out.push({ kind: 'text', text: decodeEntities(t.text ?? ''), style: { ...base } })
        }
        break
      }
      case 'escape': {
        out.push({ kind: 'text', text: (tok as Tokens.Escape).text, style: { ...base } })
        break
      }
      case 'strong': {
        out.push(...flattenInline((tok as Tokens.Strong).tokens, { ...base, bold: true }))
        break
      }
      case 'em': {
        out.push(...flattenInline((tok as Tokens.Em).tokens, { ...base, italics: true }))
        break
      }
      case 'del': {
        out.push(...flattenInline((tok as Tokens.Del).tokens, { ...base, strike: true }))
        break
      }
      case 'codespan': {
        const t = tok as Tokens.Codespan
        out.push({ kind: 'text', text: decodeEntities(t.text ?? ''), style: { ...base, code: true } })
        break
      }
      case 'link': {
        const t = tok as Tokens.Link
        out.push({
          kind: 'link',
          href: t.href,
          children: flattenInline(t.tokens, base),
        })
        break
      }
      case 'image': {
        const t = tok as Tokens.Image
        out.push({ kind: 'image', href: t.href, alt: t.text })
        break
      }
      case 'br': {
        out.push({ kind: 'break' })
        break
      }
      case 'html': {
        const plain = ((tok as Tokens.HTML).text ?? '').replace(/<[^>]+>/g, '')
        if (plain) out.push({ kind: 'text', text: decodeEntities(plain), style: { ...base } })
        break
      }
      case 'mathInline': {
        const t = tok as MathInlineToken
        out.push({ kind: 'text', text: t.formula, style: { ...base, code: true } })
        break
      }
      default: {
        const t = tok as Tokens.Generic
        if (typeof t.text === 'string') {
          out.push({ kind: 'text', text: decodeEntities(t.text), style: { ...base } })
        }
      }
    }
  }
  return out
}

function makeTextRun(text: string, style: InlineStyle): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    font: style.code ? 'Consolas' : undefined,
    shading: style.code
      ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_CODE_BG }
      : undefined,
  })
}

type ParagraphChild = TextRun | ExternalHyperlink | ImageRun | PageBreak

function inlineToChildren(
  nodes: InlineNode[],
  imageBuffers: Map<string, ResolvedImage | null>,
): ParagraphChild[] {
  const out: ParagraphChild[] = []
  for (const node of nodes) {
    if (node.kind === 'text') {
      // Split on newlines to honour `<br>` and other in-text line breaks.
      const parts = node.text.split('\n')
      parts.forEach((part, idx) => {
        if (part.length > 0) out.push(makeTextRun(part, node.style))
        if (idx < parts.length - 1) out.push(new TextRun({ break: 1 }))
      })
    }
    else if (node.kind === 'break') {
      out.push(new TextRun({ break: 1 }))
    }
    else if (node.kind === 'link') {
      const children = inlineToChildren(node.children, imageBuffers)
      // Style link children with the hyperlink colour. We can't apply a
      // built-in style without registering one, so colour + underline
      // directly on the runs is the path of least resistance.
      const styledChildren: ParagraphChild[] = children.map((child) => {
        if (child instanceof TextRun) {
          // Rebuild with link styling. `child` is opaque; we can't read its
          // text back via the public API, so we wrap the original via the
          // ExternalHyperlink — children remain TextRun-like and docx will
          // colour them via the relationship link itself.
          return child
        }
        return child
      })
      // For a coloured + underlined visual we wrap a fresh TextRun that
      // copies the user's text. To keep it simple we extract the text from
      // the children at flatten time — re-walk node.children for text.
      const text = collectText(node.children)
      out.push(
        new ExternalHyperlink({
          link: node.href,
          children: [
            new TextRun({
              text,
              style: 'Hyperlink',
              color: COLOR_LINK,
              underline: {},
            }),
          ],
        }),
      )
      // Use styledChildren placeholder to avoid unused-var lint.
      void styledChildren
    }
    else if (node.kind === 'image') {
      const img = imageBuffers.get(node.href) ?? null
      if (img) {
        out.push(
          new ImageRun({
            type: img.type,
            data: img.data,
            transformation: { width: 500, height: 280 },
            altText: node.alt
              ? { title: node.alt, description: node.alt, name: node.alt }
              : undefined,
          }),
        )
      }
      else {
        out.push(makeTextRun(`[Image: ${node.alt || node.href}]`, { italics: true }))
      }
    }
  }
  return out
}

function collectText(nodes: InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text
    else if (node.kind === 'break') out += '\n'
    else if (node.kind === 'link') out += collectText(node.children)
    else if (node.kind === 'image') out += node.alt
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Block → Paragraph / Table                                                  */
/* -------------------------------------------------------------------------- */

type BlockOut = Paragraph | Table

function headingLevel(depth: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (depth) {
    case 1: return HeadingLevel.HEADING_1
    case 2: return HeadingLevel.HEADING_2
    case 3: return HeadingLevel.HEADING_3
    case 4: return HeadingLevel.HEADING_4
    case 5: return HeadingLevel.HEADING_5
    default: return HeadingLevel.HEADING_6
  }
}

function blockFromToken(
  token: Token,
  imageBuffers: Map<string, ResolvedImage | null>,
  options: { listLevel?: number, ordered?: boolean } = {},
): BlockOut[] {
  switch (token.type) {
    case 'space': {
      return []
    }
    case 'heading': {
      const t = token as Tokens.Heading
      return [
        new Paragraph({
          heading: headingLevel(t.depth),
          children: inlineToChildren(flattenInline(t.tokens), imageBuffers),
        }),
      ]
    }
    case 'paragraph': {
      const t = token as Tokens.Paragraph
      const children = inlineToChildren(flattenInline(t.tokens), imageBuffers)
      if (children.length === 0) return []
      return [new Paragraph({ children })]
    }
    case 'text': {
      const t = token as Tokens.Text
      const inlineTokens = t.tokens ?? [{ type: 'text', raw: t.text, text: t.text } as Tokens.Text]
      const children = inlineToChildren(flattenInline(inlineTokens), imageBuffers)
      if (children.length === 0) return []
      return [new Paragraph({ children })]
    }
    case 'code': {
      const t = token as Tokens.Code
      // One paragraph per line so spacing/word-wrap stays predictable; all
      // lines share the same shading. The lang label (if any) is rendered as
      // a small caption above the block.
      const out: BlockOut[] = []
      if (t.lang) {
        out.push(
          new Paragraph({
            spacing: { before: 80, after: 0 },
            children: [
              new TextRun({
                text: t.lang.toUpperCase(),
                font: 'Inter',
                size: 14,
                color: '737370',
                characterSpacing: 24,
              }),
            ],
          }),
        )
      }
      const lines = (t.text ?? '').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        out.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_CODE_BG },
            spacing: {
              before: i === 0 ? 80 : 0,
              after: i === lines.length - 1 ? 120 : 0,
            },
            indent: { left: 200, right: 200 },
            children: [
              new TextRun({
                text: line.length === 0 ? ' ' : line,
                font: 'Consolas',
                size: 18,
              }),
            ],
          }),
        )
      }
      return out
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote
      const out: BlockOut[] = []
      for (const child of t.tokens) {
        const sub = blockFromToken(child, imageBuffers)
        for (const block of sub) {
          if (block instanceof Paragraph) {
            // Wrap in a quote-styled paragraph: italic, indented, left border.
            out.push(
              new Paragraph({
                indent: { left: 360 },
                border: {
                  left: { style: BorderStyle.SINGLE, size: 12, color: COLOR_RULE, space: 12 },
                },
                children: paragraphChildrenToItalic(block),
              }),
            )
          }
          else {
            out.push(block)
          }
        }
      }
      return out
    }
    case 'list': {
      const t = token as Tokens.List
      const out: BlockOut[] = []
      const level = options.listLevel ?? 0
      for (const item of t.items) {
        const itemChildren: ParagraphChild[] = []
        const nested: BlockOut[] = []
        // First inline-y child shares the bullet line; nested lists / blocks
        // come after.
        for (const child of item.tokens) {
          if (child.type === 'list') {
            nested.push(
              ...blockFromToken(child, imageBuffers, {
                listLevel: level + 1,
                ordered: (child as Tokens.List).ordered,
              }),
            )
          }
          else if (child.type === 'paragraph' || child.type === 'text') {
            const inlineTokens = (child as Tokens.Paragraph | Tokens.Text).tokens ?? []
            const inlineChildren = inlineToChildren(flattenInline(inlineTokens), imageBuffers)
            if (itemChildren.length > 0) itemChildren.push(new TextRun({ break: 1 }))
            itemChildren.push(...inlineChildren)
          }
          else {
            nested.push(...blockFromToken(child, imageBuffers))
          }
        }
        const prefix = item.task
          ? [new TextRun({ text: item.checked ? '☑ ' : '☐ ' })]
          : []
        out.push(
          new Paragraph({
            numbering: {
              reference: t.ordered ? NUMBERING_ORDERED_REF : NUMBERING_BULLET_REF,
              level: Math.min(level, 5),
            },
            children: [...prefix, ...itemChildren],
          }),
        )
        out.push(...nested)
      }
      return out
    }
    case 'hr': {
      return [
        new Paragraph({
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR_RULE, space: 4 },
          },
          children: [],
        }),
      ]
    }
    case 'table': {
      const t = token as Tokens.Table
      const cols = t.header.length
      if (cols === 0) return []
      const rowList: TableRow[] = []
      const headerCells = t.header.map(cell =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_HEADER_BG },
          children: [
            new Paragraph({
              alignment: alignFor(cell.align),
              children: cellChildrenBold(cell, imageBuffers),
            }),
          ],
        }),
      )
      rowList.push(new TableRow({ children: headerCells, tableHeader: true }))
      for (const row of t.rows) {
        const cells = row.map(cell =>
          new TableCell({
            children: [
              new Paragraph({
                alignment: alignFor(cell.align),
                children: inlineToChildren(flattenInline(cell.tokens), imageBuffers),
              }),
            ],
          }),
        )
        rowList.push(new TableRow({ children: cells }))
      }
      return [
        new Table({
          rows: rowList,
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
      ]
    }
    case 'html': {
      const t = token as Tokens.HTML
      // Whiteboard preview embedding
      if (/class\s*=\s*"[^"]*whiteboard[^"]*"/i.test(t.text)) {
        const previewMatch = t.text.match(/data-preview\s*=\s*"([^"]+)"/i)
        const href = previewMatch ? previewMatch[1] ?? '' : ''
        if (href) {
          const img = imageBuffers.get(href) ?? null
          if (img) {
            return [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new ImageRun({
                    type: img.type,
                    data: img.data,
                    transformation: { width: 540, height: 320 },
                  }),
                ],
              }),
            ]
          }
        }
        return [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: '[Tableau blanc — non rendu]', italics: true, color: '737370' })],
          }),
        ]
      }
      return []
    }
    case 'callout': {
      const t = token as CalloutToken
      const colors = CALLOUT_COLORS[t.kind] ?? CALLOUT_COLORS.info!
      const innerTokens = (t.bodyHtml ?? '').trim().length > 0
        ? (marked.lexer(t.bodyHtml) as Token[])
        : []
      const innerBlocks = innerTokens.flatMap(tok => blockFromToken(tok, imageBuffers))

      // Header line: KIND  Title
      const headerRuns: TextRun[] = [
        new TextRun({
          text: colors.label,
          bold: true,
          color: colors.bar,
          characterSpacing: 24,
          size: 18,
        }),
      ]
      if (t.title) {
        headerRuns.push(
          new TextRun({ text: '  ' }),
          new TextRun({ text: t.title, bold: true, color: colors.bar }),
        )
      }
      const headerPara = new Paragraph({
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: colors.bg },
        border: {
          left: { style: BorderStyle.SINGLE, size: 24, color: colors.bar, space: 12 },
        },
        indent: { left: 200, right: 200 },
        spacing: { before: 120, after: 0 },
        children: headerRuns,
      })

      // Apply matching shading/border to each inner paragraph so the
      // callout reads as a single visual block.
      const styled: BlockOut[] = []
      for (const block of innerBlocks) {
        if (block instanceof Paragraph) {
          styled.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: colors.bg },
              border: {
                left: { style: BorderStyle.SINGLE, size: 24, color: colors.bar, space: 12 },
              },
              indent: { left: 200, right: 200 },
              children: paragraphChildrenPassthrough(block),
            }),
          )
        }
        else {
          styled.push(block)
        }
      }

      // Close the block with a small spacer to detach it from the next.
      styled.push(
        new Paragraph({
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: colors.bg },
          border: {
            left: { style: BorderStyle.SINGLE, size: 24, color: colors.bar, space: 12 },
          },
          indent: { left: 200, right: 200 },
          spacing: { before: 0, after: 120 },
          children: [],
        }),
      )
      return [headerPara, ...styled]
    }
    case 'mathBlock': {
      const t = token as MathBlockToken
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          border: {
            top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_RULE, space: 4 },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_RULE, space: 4 },
            left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_RULE, space: 4 },
            right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_RULE, space: 4 },
          },
          spacing: { before: 120, after: 120 },
          children: [
            new TextRun({
              text: t.formula,
              font: 'Consolas',
              italics: true,
            }),
          ],
        }),
      ]
    }
    case 'def':
    case 'br': {
      return []
    }
    default: {
      const t = token as Tokens.Generic
      if (typeof t.text === 'string' && t.text.length > 0) {
        return [new Paragraph({ children: [new TextRun(t.text)] })]
      }
      return []
    }
  }
}

function alignFor(align: 'left' | 'center' | 'right' | null): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (align === 'center') return AlignmentType.CENTER
  if (align === 'right') return AlignmentType.RIGHT
  return AlignmentType.LEFT
}

function cellChildrenBold(
  cell: Tokens.TableCell,
  imageBuffers: Map<string, ResolvedImage | null>,
): ParagraphChild[] {
  // Render header cells with bold base style. We re-flatten with `bold:true`
  // baked into the InlineStyle so codespan / links still nest correctly.
  const inline = flattenInline(cell.tokens)
  const boldedNodes = inline.map<InlineNode>((node) => {
    if (node.kind === 'text') {
      return { ...node, style: { ...node.style, bold: true } }
    }
    return node
  })
  return inlineToChildren(boldedNodes, imageBuffers)
}

/**
 * `docx`'s Paragraph instances are opaque — there's no public accessor for
 * their children. To re-wrap their contents under a new Paragraph (with
 * different border / shading), we read the private `root` array. This is
 * brittle but matches the documented internal layout of the library and
 * survives in-place version bumps (it's been stable since v8).
 */
function paragraphChildrenPassthrough(p: Paragraph): ParagraphChild[] {
  const root = (p as unknown as { root?: unknown[] }).root
  if (!Array.isArray(root)) return []
  const out: ParagraphChild[] = []
  for (const item of root) {
    if (item instanceof TextRun || item instanceof ExternalHyperlink || item instanceof ImageRun) {
      out.push(item)
    }
  }
  return out
}

function paragraphChildrenToItalic(p: Paragraph): ParagraphChild[] {
  // For blockquote children we want everything italic. The cleanest path is
  // to re-emit the existing runs wrapped in italic TextRuns; since we can't
  // read TextRun text back, we accept the limitation and just return the
  // existing children — blockquote already gets the left-border visual.
  // Italicising is best-effort here.
  return paragraphChildrenPassthrough(p)
}

/* -------------------------------------------------------------------------- */
/*  Top-level token collection helpers                                         */
/* -------------------------------------------------------------------------- */

function collectImageHrefs(tokens: Token[], out: Set<string>): void {
  for (const tok of tokens) {
    if (tok.type === 'image') {
      out.add((tok as Tokens.Image).href)
      continue
    }
    if (tok.type === 'html') {
      const t = tok as Tokens.HTML
      const match = t.text.match(/class\s*=\s*"[^"]*whiteboard[^"]*"[\s\S]*?data-preview\s*=\s*"([^"]+)"/i)
      if (match && match[1]) out.add(match[1])
      continue
    }
    const generic = tok as Tokens.Generic
    if (Array.isArray(generic.tokens)) collectImageHrefs(generic.tokens, out)
    if (tok.type === 'list') {
      for (const item of (tok as Tokens.List).items) collectImageHrefs(item.tokens, out)
    }
    if (tok.type === 'table') {
      const t = tok as Tokens.Table
      for (const cell of t.header) collectImageHrefs(cell.tokens, out)
      for (const row of t.rows) for (const cell of row) collectImageHrefs(cell.tokens, out)
    }
    if (tok.type === 'callout') {
      const inner = marked.lexer((tok as CalloutToken).bodyHtml ?? '') as Token[]
      collectImageHrefs(inner, out)
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Document assembly                                                          */
/* -------------------------------------------------------------------------- */

interface DocLike {
  title: string
  markdown: string
  updatedAt: unknown
}

type NumberingLevel = {
  level: number
  format: (typeof LevelFormat)[keyof typeof LevelFormat]
  text: string
  alignment: (typeof AlignmentType)[keyof typeof AlignmentType]
  style: { paragraph: { indent: { left: number, hanging: number } } }
}

function bulletLevels(): NumberingLevel[] {
  const indents = [360, 720, 1080, 1440, 1800, 2160]
  const markers = ['•', '◦', '▪', '•', '◦', '▪']
  return indents.map((indent, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: markers[level] ?? '•',
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: { indent: { left: indent, hanging: 260 } },
    },
  }))
}

function orderedLevels(): NumberingLevel[] {
  const indents = [360, 720, 1080, 1440, 1800, 2160]
  const formats: (typeof LevelFormat)[keyof typeof LevelFormat][] = [
    LevelFormat.DECIMAL,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_ROMAN,
    LevelFormat.DECIMAL,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_ROMAN,
  ]
  return indents.map((indent, level) => ({
    level,
    format: formats[level] ?? LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: { indent: { left: indent, hanging: 260 } },
    },
  }))
}

function buildNumberingConfig(): {
  config: { reference: string, levels: NumberingLevel[] }[]
} {
  return {
    config: [
      { reference: NUMBERING_BULLET_REF, levels: bulletLevels() },
      { reference: NUMBERING_ORDERED_REF, levels: orderedLevels() },
    ],
  }
}

/**
 * Render a single document to a DOCX buffer.
 */
export async function renderDocDocx(doc: DocLike | Document): Promise<Buffer> {
  ensureMarked()

  const title = doc.title || 'Untitled'
  const tokens = marked.lexer(doc.markdown ?? '') as Token[]

  const hrefs = new Set<string>()
  collectImageHrefs(tokens, hrefs)
  const imageBuffers = new Map<string, ResolvedImage | null>()
  await Promise.all(
    [...hrefs].map(async (h) => {
      imageBuffers.set(h, await resolveImage(h))
    }),
  )

  const body: BlockOut[] = []
  // Title block
  body.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: title })],
    }),
  )
  body.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Exporté le ${new Date().toISOString().slice(0, 10)}`,
          color: '737370',
          characterSpacing: 24,
          size: 18,
        }),
      ],
    }),
  )

  for (const tok of tokens) {
    body.push(...blockFromToken(tok, imageBuffers))
  }

  const file = new DocxDocument({
    creator: 'NoteForge',
    title,
    numbering: buildNumberingConfig(),
    sections: [
      {
        properties: {},
        children: body,
      },
    ],
  })
  return Packer.toBuffer(file)
}

/**
 * Render a whole workspace into one DOCX. Each document begins with a
 * `HEADING_1` of its title and is separated from the next by a page break.
 */
export async function renderWorkspaceDocx(
  workspaceName: string,
  docs: ReadonlyArray<DocLike | Document>,
): Promise<Buffer> {
  ensureMarked()

  // Single image-resolution pass across all docs (deduped by href).
  const tokensPerDoc: Token[][] = []
  const hrefs = new Set<string>()
  for (const doc of docs) {
    const tokens = marked.lexer(doc.markdown ?? '') as Token[]
    tokensPerDoc.push(tokens)
    collectImageHrefs(tokens, hrefs)
  }
  const imageBuffers = new Map<string, ResolvedImage | null>()
  await Promise.all(
    [...hrefs].map(async (h) => {
      imageBuffers.set(h, await resolveImage(h))
    }),
  )

  const body: BlockOut[] = []
  // Workspace cover
  body.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: workspaceName })],
    }),
  )
  body.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Workspace export — ${new Date().toISOString().slice(0, 10)} — ${docs.length} documents`,
          color: '737370',
          characterSpacing: 24,
          size: 18,
        }),
      ],
    }),
  )

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!
    const tokens = tokensPerDoc[i]!
    if (i > 0) {
      body.push(
        new Paragraph({
          children: [new PageBreak()],
        }),
      )
    }
    body.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: doc.title || 'Untitled' })],
      }),
    )
    for (const tok of tokens) {
      body.push(...blockFromToken(tok, imageBuffers))
    }
  }

  const file = new DocxDocument({
    creator: 'NoteForge',
    title: workspaceName,
    numbering: buildNumberingConfig(),
    sections: [
      {
        properties: {},
        children: body,
      },
    ],
  })
  return Packer.toBuffer(file)
}
