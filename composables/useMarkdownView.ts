import { marked } from 'marked'
import { highlightCode } from '~/utils/lowlight'

/**
 * Read-only markdown renderer for AI / chat content. Uses `marked` (already
 * in deps) and runs a small allowlist-based sanitizer on the output so that
 * a hypothetical `<script>` or `onerror=` injection from the model can't
 * execute. Tag and attribute lists are intentionally conservative.
 */

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'CODE', 'PRE',
  'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  // Marked GFM emits an <input type=checkbox disabled> for task-list items;
  // allowing it lets `[ ]` / `[x]` render with a real checkbox.
  'INPUT',
  // Lowlight emits `<span class="hljs-*">` inside code blocks for token
  // coloring. The sanitizer below already strips everything except `class`.
  'SPAN',
])

const ALLOWED_URL_PREFIXES = ['http://', 'https://', 'mailto:', '#']

function isSafeHref(value: string): boolean {
  const v = value.trim().toLowerCase()
  // Explicit deny for the obvious cross-protocol footguns. The allowlist
  // below also catches these but being explicit makes the intent obvious
  // when this file is grepped during security review.
  if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:')) {
    return false
  }
  return ALLOWED_URL_PREFIXES.some(p => v.startsWith(p))
}

function sanitizeNode(node: Element, doc: Document): void {
  // Walk children defensively because we mutate during iteration.
  const children = Array.from(node.children)
  for (const child of children) {
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // Replace disallowed elements with their text content (safe defang).
      const fallback = doc.createTextNode(child.textContent ?? '')
      node.replaceChild(fallback, child)
      continue
    }
    // INPUT gets special treatment — only the task-list checkbox shape is
    // ever legitimate output from marked, so we strip everything else.
    if (child.tagName === 'INPUT') {
      const isCheckbox = (child.getAttribute('type') || '').toLowerCase() === 'checkbox'
      if (!isCheckbox) {
        const fallback = doc.createTextNode('')
        node.replaceChild(fallback, child)
        continue
      }
      const wasChecked = child.hasAttribute('checked')
      // Wipe all attrs then re-apply the safe minimum.
      for (const attr of Array.from(child.attributes)) {
        child.removeAttribute(attr.name)
      }
      child.setAttribute('type', 'checkbox')
      child.setAttribute('disabled', '')
      if (wasChecked) child.setAttribute('checked', '')
      continue
    }
    // Strip dangerous attributes.
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        child.removeAttribute(attr.name)
        continue
      }
      if (name === 'href') {
        if (!isSafeHref(attr.value)) child.setAttribute('href', '#')
        // Always force safe link behaviour.
        child.setAttribute('rel', 'noopener noreferrer')
        child.setAttribute('target', '_blank')
        continue
      }
      // Allow `class` (used by marked for code-block language hints).
      if (name === 'class') continue
      // Strip everything else — `style`, `id`, custom data, src, etc.
      child.removeAttribute(attr.name)
    }
    sanitizeNode(child, doc)
  }
}

/**
 * For each `<pre><code class="language-X">…</code></pre>` produced by marked,
 * run lowlight against the raw text and replace the inner HTML with the
 * highlighted hljs-span tree. Adds the `hljs` class so global token CSS
 * applies. We do this BEFORE the sanitizer so its allowlist also vets the
 * spans lowlight emits (defensive even though `highlightCode` is trusted).
 */
function highlightCodeBlocks(root: HTMLElement): void {
  const codes = root.querySelectorAll('pre > code')
  for (const code of Array.from(codes)) {
    const text = code.textContent ?? ''
    if (!text) continue
    let language: string | null = null
    for (const cls of Array.from(code.classList)) {
      if (cls.startsWith('language-')) { language = cls.slice('language-'.length); break }
    }
    code.innerHTML = highlightCode(text, language)
    code.classList.add('hljs')
  }
}

function sanitizeHtml(html: string): string {
  // SSR has no DOMParser; defer rendering until the client mounts.
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return ''
  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const wrapper = parsed.body.firstElementChild as HTMLElement | null
  if (!wrapper) return ''
  highlightCodeBlocks(wrapper)
  sanitizeNode(wrapper, parsed)
  return wrapper.innerHTML
}

export function renderMarkdown(md: string): string {
  if (!md) return ''
  const html = marked.parse(md, { async: false, breaks: true, gfm: true }) as string
  return sanitizeHtml(html)
}

/**
 * Sprint 5 / F9 — public-share variant. Uses the same allowlist sanitizer
 * as `renderMarkdown` (no new tags are accepted). Inline images are
 * intentionally NOT rendered: `<img>` is not in the allowlist, and since
 * `/api/uploads/*` requires an authenticated session, even if we did
 * render the tag the asset wouldn't load. Authors who need images in a
 * shared doc should link out instead.
 */
export function renderPublicMarkdown(md: string): string {
  if (!md) return ''
  const html = marked.parse(md, { async: false, breaks: true, gfm: true }) as string
  return sanitizeHtml(html)
}

export function useMarkdownView() {
  return { renderMarkdown, renderPublicMarkdown }
}
