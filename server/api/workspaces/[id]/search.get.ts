/**
 * GET /api/workspaces/:id/search
 *
 * Filtered document search. Combines:
 *   - FTS5 (BM25) over `doc_chunks_fts` when `q` is non-empty,
 *   - tag filter via `json_each(doc_analyses.tags)`,
 *   - folder filter (exact match — descendant traversal is a known TODO),
 *   - updatedAt date range,
 *   - sort: `relevance` (BM25 score, only when `q` present), `recent`
 *     (updatedAt desc), `oldest` (createdAt asc).
 *
 * Returns `{ documents, total }` where each document carries a `snippet`
 * (best matching chunk text), `tags`, and metadata.
 */
import { z } from 'zod'
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { defineEventHandler, getValidatedQuery } from 'h3'
import { getRawDb, useDb } from '~/server/database/client'
import { docAnalyses, documents } from '~/server/database/schema'
import { assertWorkspaceAccess, parseIdParam } from '~/server/utils/access'
import { activeDocsWhere } from '~/server/utils/active'
import { getDek } from '~/server/utils/dek'
import { decryptAnalysis, decryptDocument } from '~/server/utils/encrypted-entities'

const Query = z.object({
  q: z.string().max(500).optional(),
  tag: z.string().trim().max(80).optional(),
  folderId: z
    .union([z.literal('root'), z.coerce.number().int().positive()])
    .optional(),
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  sort: z.enum(['relevance', 'recent', 'oldest']).default('recent'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export interface SearchDocumentResult {
  id: number
  title: string
  snippet: string
  tags: string[]
  folderId: number | null
  updatedAt: Date
  createdAt: Date
}

function buildFtsQuery(input: string): string {
  // Same defensive tokenisation as `server/utils/search.ts` — quoted phrases
  // disable FTS5 operators that could leak through user input.
  const tokens = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
  if (tokens.length === 0) return ''
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    unique.push(t)
  }
  return unique.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/** Highlight query terms inside a snippet with `**term**` markdown. */
function highlightTerms(text: string, query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
  if (tokens.length === 0) return text
  // Build a single case-insensitive alternation. Escape regex metachars.
  const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  return text.replace(re, '**$1**')
}

function compactSnippet(s: string, max = 220): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max - 1).trimEnd()}…`
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export default defineEventHandler(async (event) => {
  const workspaceId = parseIdParam(event)
  await assertWorkspaceAccess(event, workspaceId)
  const q = await getValidatedQuery(event, Query.parse)
  const dek = await getDek(event)

  const db = useDb()
  const sqlite = getRawDb()

  const queryText = (q.q ?? '').trim()
  const hasQuery = queryText.length > 0
  const dateFrom = parseDate(q.dateFrom)
  const dateTo = parseDate(q.dateTo)
  const folderFilter = q.folderId

  /* ---------------- Stage 1: FTS5 BM25 (when `q` is present) ---------------- */
  // Map<docId, { snippet, bm25 }> — best chunk per doc.
  const ftsByDoc = new Map<number, { snippet: string, bm25: number, rank: number }>()
  if (hasQuery) {
    const matchExpr = buildFtsQuery(queryText)
    if (matchExpr.length === 0) {
      // No usable tokens after sanitisation — treat as empty query rather
      // than 400ing. The user typed e.g. `??!!`; just fall through to the
      // filter-only path.
    }
    else {
      // Join via doc_chunks → documents to scope to workspace + active.
      // Pull rowid -> docId, text, bm25 for ranking.
      const stmt = sqlite.prepare<[string, number], {
        rowid: number
        docId: number
        text: string
        bm25: number
      }>(
        `SELECT
           doc_chunks_fts.rowid AS rowid,
           doc_chunks.doc_id   AS docId,
           snippet(doc_chunks_fts, 0, '<mark>', '</mark>', '…', 24) AS text,
           bm25(doc_chunks_fts) AS bm25
         FROM doc_chunks_fts
         JOIN doc_chunks ON doc_chunks.id = doc_chunks_fts.rowid
         JOIN documents  ON documents.id = doc_chunks.doc_id
         WHERE doc_chunks_fts MATCH ?
           AND documents.workspace_id = ?
           AND documents.deleted_at IS NULL
         ORDER BY bm25 ASC
         LIMIT 500`,
      )
      let rows: { rowid: number, docId: number, text: string, bm25: number }[]
      try {
        rows = stmt.all(matchExpr, workspaceId)
      }
      catch {
        rows = []
      }

      let r = 0
      for (const row of rows) {
        if (ftsByDoc.has(row.docId)) continue
        ftsByDoc.set(row.docId, { snippet: row.text, bm25: row.bm25, rank: r++ })
      }
    }
  }

  /* ---------------- Stage 2: filter-driven SQL ---------------- */
  const conditions = [
    eq(documents.workspaceId, workspaceId),
    activeDocsWhere(),
  ]
  if (folderFilter === 'root') {
    conditions.push(sql`${documents.folderId} IS NULL`)
  }
  else if (typeof folderFilter === 'number') {
    conditions.push(eq(documents.folderId, folderFilter))
  }
  if (dateFrom) conditions.push(gte(documents.updatedAt, dateFrom))
  if (dateTo) conditions.push(lte(documents.updatedAt, dateTo))

  // Tag filter: once tags are encrypted at rest, the SQL `json_each(...) =
  // ?` predicate can't match (each ciphertext is unique). Compute the
  // matching doc-id set in JS instead and AND it in.
  const tagFilterDocIds: number[] | null = await (async () => {
    if (!q.tag || q.tag.length === 0) return null
    const tag = q.tag.toLowerCase()
    const analyses = await db
      .select({ docId: docAnalyses.docId, tags: docAnalyses.tags })
      .from(docAnalyses)
    const out: number[] = []
    for (const a of analyses) {
      const tags = decryptAnalysis({ tags: a.tags ?? [] }, dek).tags ?? []
      if (tags.some(t => t.toLowerCase() === tag)) out.push(a.docId)
    }
    return out
  })()
  if (tagFilterDocIds) {
    if (tagFilterDocIds.length === 0) {
      return { documents: [] as SearchDocumentResult[], total: 0 }
    }
    conditions.push(inArray(documents.id, tagFilterDocIds))
  }

  // If we have FTS hits, narrow further to those doc ids — otherwise (no `q`)
  // skip the narrowing.
  if (hasQuery && ftsByDoc.size > 0) {
    conditions.push(inArray(documents.id, Array.from(ftsByDoc.keys())))
  }
  else if (hasQuery && ftsByDoc.size === 0) {
    // q present but no matches at all → empty page.
    return { documents: [] as SearchDocumentResult[], total: 0 }
  }

  // Materialise candidate set (apply pagination later).
  const candidates = await db
    .select({
      id: documents.id,
      title: documents.title,
      folderId: documents.folderId,
      markdown: documents.markdown,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(and(...conditions))

  const total = candidates.length

  // Tags lookup in one shot.
  const candidateIds = candidates.map(c => c.id)
  const tagRows = candidateIds.length === 0
    ? []
    : await db
      .select({ docId: docAnalyses.docId, tags: docAnalyses.tags })
      .from(docAnalyses)
      .where(inArray(docAnalyses.docId, candidateIds))
  const tagsByDoc = new Map<number, string[]>(
    tagRows.map((r) => {
      const tags = decryptAnalysis({ tags: Array.isArray(r.tags) ? r.tags : [] }, dek).tags ?? []
      return [r.docId, tags]
    }),
  )

  /* ---------------- Sort ---------------- */
  type Row = (typeof candidates)[number]
  let sorted: Row[]
  if (q.sort === 'relevance' && hasQuery && ftsByDoc.size > 0) {
    sorted = [...candidates].sort((a, b) => {
      const ra = ftsByDoc.get(a.id)?.rank ?? Number.MAX_SAFE_INTEGER
      const rb = ftsByDoc.get(b.id)?.rank ?? Number.MAX_SAFE_INTEGER
      return ra - rb
    })
  }
  else if (q.sort === 'oldest') {
    sorted = [...candidates].sort((a, b) => +a.createdAt - +b.createdAt)
  }
  else {
    // `recent` default
    sorted = [...candidates].sort((a, b) => +b.updatedAt - +a.updatedAt)
  }

  const page = sorted.slice(q.offset, q.offset + q.limit)

  /* ---------------- Build response ---------------- */
  const out: SearchDocumentResult[] = page.map((d) => {
    const plain = decryptDocument({ title: d.title, markdown: d.markdown }, dek)
    const fts = ftsByDoc.get(d.id)
    let snippet: string
    if (fts) {
      // FTS5 mirror stores plaintext — its snippet is already readable; just
      // map <mark> to **markdown** for the client's plain-text renderer.
      snippet = fts.snippet
        .replace(/<mark>/g, '**')
        .replace(/<\/mark>/g, '**')
    }
    else {
      // No FTS hit → pull the first 220 chars of (decrypted) markdown as snippet.
      const md = (plain.markdown ?? '').replace(/[#*_`~>]/g, '').replace(/\s+/g, ' ').trim()
      snippet = compactSnippet(md, 220)
      if (hasQuery && snippet.length > 0) snippet = highlightTerms(snippet, queryText)
    }

    return {
      id: d.id,
      title: plain.title ?? '',
      snippet,
      tags: tagsByDoc.get(d.id) ?? [],
      folderId: d.folderId,
      updatedAt: d.updatedAt,
      createdAt: d.createdAt,
    }
  })

  return { documents: out, total }
})
