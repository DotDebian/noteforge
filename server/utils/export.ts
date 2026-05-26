/**
 * Helpers shared by the document/workspace export endpoints.
 */

import { marked } from 'marked'
import { highlightCode } from '~/utils/lowlight'

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled'
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') {
    // SQLite unixepoch() is in seconds; JS Date in ms.
    return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString()
  }
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date(0).toISOString()
}

function escapeYamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface ExportableDoc {
  title: string
  markdown: string
  createdAt: unknown
  updatedAt: unknown
}

export function buildMarkdown(doc: ExportableDoc): string {
  const frontmatter = [
    '---',
    `title: ${escapeYamlString(doc.title || 'Untitled')}`,
    `createdAt: ${toIso(doc.createdAt)}`,
    `updatedAt: ${toIso(doc.updatedAt)}`,
    '---',
    '',
    '',
  ].join('\n')
  return frontmatter + doc.markdown
}

/* -------------------------------------------------------------------------- */
/*  HTML export                                                                */
/*                                                                             */
/*  Self-contained `<!doctype html>` with inline CSS (mirrors the prose-doc    */
/*  styling in `pages/share/[token].vue` + `assets/css/main.css`), a CDN link  */
/*  to KaTeX for math display, and lowlight-rendered <pre><code> blocks. The   */
/*  user owns the source markdown so no sanitization is applied — the export   */
/*  is meant for local archival.                                               */
/* -------------------------------------------------------------------------- */

const KATEX_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const EXPORT_CSS = `
  :root {
    --fg: #1a1a1a;
    --fg-muted: #555;
    --bg: #fdfdfc;
    --rule: #e5e5e2;
    --code-bg: #f4f3f0;
    --code-border: #e0dfdb;
    --link: #b54a18;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e6e6e3;
      --fg-muted: #a3a3a0;
      --bg: #161614;
      --rule: #2c2c2a;
      --code-bg: #1e1e1c;
      --code-border: #2c2c2a;
      --link: #e07a3f;
      --hl-keyword: #f3a566;
      --hl-string: #6ee7b7;
      --hl-number: #fcd34d;
      --hl-title: #93c5fd;
      --hl-variable: #fda4af;
      --hl-regexp: #f0abfc;
      --hl-comment: #a3a3a0;
    }
  }
  :root {
    --hl-keyword: #b54a18;
    --hl-string: #047857;
    --hl-number: #b45309;
    --hl-title: #0369a1;
    --hl-variable: #be123c;
    --hl-regexp: #a21caf;
    --hl-comment: #737370;
  }
  html, body { background: var(--bg); color: var(--fg); }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.7;
    max-width: 760px;
    margin: 0 auto;
    padding: 48px 24px 96px;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: "Source Serif 4", "Source Serif Pro", Georgia, serif;
    letter-spacing: -0.01em;
    line-height: 1.25;
  }
  h1.doc-title { font-size: 2.2rem; margin: 0 0 2rem; }
  h1 { font-size: 1.6rem; margin: 2.5rem 0 1rem; }
  h2 { font-size: 1.35rem; margin: 2.25rem 0 0.75rem; }
  h3 { font-size: 1.15rem; margin: 1.75rem 0 0.5rem; }
  p { margin: 1rem 0; }
  a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
  ul, ol { margin: 1rem 0; padding-left: 1.5rem; }
  li { margin: 0.25rem 0; }
  blockquote {
    margin: 1.25rem 0;
    padding-left: 1rem;
    border-left: 3px solid var(--rule);
    color: var(--fg-muted);
    font-style: italic;
  }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
  code {
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85em;
    padding: 0.1em 0.35em;
    border-radius: 3px;
    background: var(--code-bg);
  }
  pre {
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85em;
    margin: 1.25rem 0;
    padding: 1rem;
    border-radius: 4px;
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    overflow-x: auto;
  }
  pre code { padding: 0; background: transparent; }
  table { width: 100%; margin: 1.25rem 0; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--rule); }
  th { font-weight: 600; }
  input[type="checkbox"] { margin-right: 0.5rem; vertical-align: middle; }
  .doc-meta {
    font-size: 12px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 2rem;
  }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section,
  .hljs-link, .hljs-built_in, .hljs-doctag { color: var(--hl-keyword); }
  .hljs-string, .hljs-attr, .hljs-symbol, .hljs-bullet,
  .hljs-addition { color: var(--hl-string); }
  .hljs-number, .hljs-meta, .hljs-type { color: var(--hl-number); }
  .hljs-title, .hljs-title.class_, .hljs-title.function_, .hljs-name,
  .hljs-selector-id, .hljs-selector-class { color: var(--hl-title); }
  .hljs-comment, .hljs-quote, .hljs-deletion {
    color: var(--hl-comment); font-style: italic;
  }
  .hljs-variable, .hljs-template-variable, .hljs-tag, .hljs-attribute,
  .hljs-params { color: var(--hl-variable); }
  .hljs-regexp { color: var(--hl-regexp); }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 600; }
`.trim()

/**
 * Render markdown to HTML and replace every `<pre><code class="language-X">…`
 * with lowlight-highlighted spans. Mirrors the approach used by the chat
 * markdown renderer in `composables/useMarkdownView.ts`, but server-side and
 * without DOMParser — we operate on the marked output string directly.
 */
function renderMarkdownToHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false, breaks: true, gfm: true }) as string

  // Walk every `<pre><code class="language-X">…</code></pre>` and rewrite the
  // inner HTML through lowlight. marked emits the source HTML-escaped, so we
  // unescape before handing it to lowlight (which escapes again on its own).
  return html.replace(
    /<pre><code class="language-([a-zA-Z0-9_+-]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_match, language: string, body: string) => {
      const raw = body
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
      const highlighted = highlightCode(raw, language)
      return `<pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>`
    },
  )
}

export function buildHtml(doc: ExportableDoc): string {
  const title = doc.title || 'Untitled'
  const body = renderMarkdownToHtml(doc.markdown)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${KATEX_CDN}">
<style>${EXPORT_CSS}</style>
</head>
<body>
<h1 class="doc-title">${escapeHtml(title)}</h1>
<div class="doc-meta">Exported ${toIso(doc.updatedAt)}</div>
<article class="doc-body">
${body}
</article>
</body>
</html>
`
}
