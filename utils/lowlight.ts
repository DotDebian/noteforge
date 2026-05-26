import { createLowlight, common } from 'lowlight'
import type { ElementContent, Root, RootContent } from 'hast'

/**
 * Shared lowlight instance used by the Tiptap editor (CodeBlockLowlight) and
 * the chat / share markdown renderers. `common` ships ~37 widely used
 * languages (js, ts, python, bash, json, yaml, html, css, sql, etc.); plenty
 * for a notes app and stays well under the bundle budget. Swap to a curated
 * `register({})` list if we ever need to shrink the bundle further.
 */
export const lowlight = createLowlight(common)

/**
 * Render a code string to highlight.js-flavoured HTML (hljs-* spans). The
 * caller is responsible for wrapping it in `<pre><code class="hljs language-X">…</code></pre>`.
 * Used by the marked renderer in `useMarkdownView.ts`. Returns the escaped
 * source as-is when the language is unknown so the block still renders.
 */
export function highlightCode(code: string, language: string | null | undefined): string {
  if (language && lowlight.registered(language)) {
    const tree = lowlight.highlight(language, code)
    return rootToHtml(tree)
  }
  return escapeHtml(code)
}

function rootToHtml(root: Root): string {
  return root.children.map(serializeNode).join('')
}

function serializeNode(node: RootContent | ElementContent): string {
  if (node.type === 'text') return escapeHtml(node.value)
  if (node.type === 'element') {
    const cls = node.properties?.className
    const className = Array.isArray(cls)
      ? cls.join(' ')
      : typeof cls === 'string'
        ? cls
        : ''
    const attrs = className ? ` class="${escapeAttr(className)}"` : ''
    const inner = node.children.map(serializeNode).join('')
    return `<${node.tagName}${attrs}>${inner}</${node.tagName}>`
  }
  // hast 'comment' / 'doctype' / 'raw' don't occur in lowlight output — ignore.
  return ''
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;')
}
