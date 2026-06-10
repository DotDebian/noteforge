/**
 * Entity-level encryption helpers.
 *
 * Each row type that holds user-authored content gets a pair of pure
 * functions: `encryptX(row, dek)` / `decryptX(row, dek)`. They return a
 * shallow copy with the protected fields swapped, so callers can pass the
 * result straight to Drizzle insert / select-returning shapes without
 * mutating the input.
 *
 * `dek == null` is a no-op — pass-through. That matches the legacy
 * window between login (where the DEK is unwrapped) and the migration
 * actually completing, and the very small set of callers that
 * intentionally don't decrypt (e.g. ownership checks that only inspect
 * `ownerId`).
 *
 * JSON-mode Drizzle columns (`sources`, `useCases`, `tags`, `questions`,
 * `actionItems`) stay JSON arrays. The protected strings inside them are
 * swapped one-by-one with `encryptField`. This keeps Drizzle's
 * stringify/parse contract intact — writing a bare `enc:v1:…` blob into
 * a `mode: 'json'` column would explode on the next read because Drizzle
 * runs `JSON.parse` on the raw text.
 */
import { decryptField, encryptField, type DecryptFieldContext } from './crypto'
import type {
  ChatMessage,
  DocAnalysis,
  DocChunk,
  Document,
  DocumentVersion,
  Folder,
  Workspace,
} from '../database/schema'

type Maybe<T> = T | null | undefined

function enc(s: string, dek: Buffer | null | undefined): string {
  return encryptField(s, dek ?? null)
}
function dec(s: Maybe<string>, dek: Buffer | null | undefined, ctx?: DecryptFieldContext): string {
  return decryptField(s, dek ?? null, ctx)
}

/* -------------------------------------------------------------------------- */
/*  Workspaces                                                                 */
/* -------------------------------------------------------------------------- */

export function encryptWorkspace<T extends { name?: string }>(row: T, dek: Buffer | null | undefined): T {
  if (!dek) return row
  return { ...row, ...(row.name !== undefined ? { name: enc(row.name, dek) } : {}) }
}

export function decryptWorkspace<T extends { name?: string | null }>(row: T, dek: Buffer | null | undefined): T {
  if (row.name == null) return row
  return { ...row, name: dec(row.name, dek) }
}

/* -------------------------------------------------------------------------- */
/*  Folders                                                                    */
/* -------------------------------------------------------------------------- */

export function encryptFolder<T extends { name?: string }>(row: T, dek: Buffer | null | undefined): T {
  if (!dek) return row
  return { ...row, ...(row.name !== undefined ? { name: enc(row.name, dek) } : {}) }
}

export function decryptFolder<T extends { name?: string | null }>(row: T, dek: Buffer | null | undefined): T {
  if (row.name == null) return row
  return { ...row, name: dec(row.name, dek) }
}

/* -------------------------------------------------------------------------- */
/*  Documents                                                                  */
/* -------------------------------------------------------------------------- */

export function encryptDocument<T extends Partial<Pick<Document, 'title' | 'markdown' | 'contentJson'>>>(
  row: T,
  dek: Buffer | null | undefined,
): T {
  if (!dek) return row
  const patch: Partial<T> = {}
  if (row.title !== undefined) (patch as { title: string }).title = enc(row.title, dek)
  if (row.markdown !== undefined) (patch as { markdown: string }).markdown = enc(row.markdown, dek)
  if (row.contentJson !== undefined) (patch as { contentJson: string }).contentJson = enc(row.contentJson, dek)
  return { ...row, ...patch }
}

export function decryptDocument<T extends Partial<Pick<Document, 'title' | 'markdown' | 'contentJson'>> & { id?: number }>(
  row: T,
  dek: Buffer | null | undefined,
  ctx?: { userId?: number },
): T {
  const patch: Partial<T> = {}
  const base: DecryptFieldContext = {
    entityType: 'document',
    entityId: typeof row.id === 'number' ? row.id : undefined,
    userId: ctx?.userId,
  }
  if (row.title != null) (patch as { title: string }).title = dec(row.title, dek, { ...base, field: 'title' })
  if (row.markdown != null) (patch as { markdown: string }).markdown = dec(row.markdown, dek, { ...base, field: 'markdown' })
  if (row.contentJson != null) (patch as { contentJson: string }).contentJson = dec(row.contentJson, dek, { ...base, field: 'contentJson' })
  return { ...row, ...patch }
}

/* -------------------------------------------------------------------------- */
/*  Document versions                                                          */
/* -------------------------------------------------------------------------- */

export function encryptDocumentVersion<T extends Partial<Pick<DocumentVersion, 'title' | 'markdown' | 'contentJson'>>>(
  row: T,
  dek: Buffer | null | undefined,
): T {
  if (!dek) return row
  const patch: Partial<T> = {}
  if (row.title !== undefined) (patch as { title: string }).title = enc(row.title, dek)
  if (row.markdown !== undefined) (patch as { markdown: string }).markdown = enc(row.markdown, dek)
  if (row.contentJson !== undefined) (patch as { contentJson: string }).contentJson = enc(row.contentJson, dek)
  return { ...row, ...patch }
}

export function decryptDocumentVersion<T extends Partial<Pick<DocumentVersion, 'title' | 'markdown' | 'contentJson'>>>(
  row: T,
  dek: Buffer | null | undefined,
): T {
  const patch: Partial<T> = {}
  if (row.title != null) (patch as { title: string }).title = dec(row.title, dek)
  if (row.markdown != null) (patch as { markdown: string }).markdown = dec(row.markdown, dek)
  if (row.contentJson != null) (patch as { contentJson: string }).contentJson = dec(row.contentJson, dek)
  return { ...row, ...patch }
}

/* -------------------------------------------------------------------------- */
/*  Doc analyses                                                               */
/* -------------------------------------------------------------------------- */

type AnalysisLike = Partial<Pick<DocAnalysis,
  | 'summaryShort'
  | 'summaryLong'
  | 'useCases'
  | 'tags'
  | 'questions'
  | 'actionItems'
>>

export function encryptAnalysis<T extends AnalysisLike>(row: T, dek: Buffer | null | undefined): T {
  if (!dek) return row
  const patch: Partial<T> = {}
  if (row.summaryShort !== undefined) (patch as { summaryShort: string }).summaryShort = enc(row.summaryShort, dek)
  if (row.summaryLong !== undefined) (patch as { summaryLong: string }).summaryLong = enc(row.summaryLong, dek)
  if (row.useCases !== undefined) (patch as { useCases: string[] }).useCases = row.useCases.map(s => enc(s, dek))
  if (row.tags !== undefined) (patch as { tags: string[] }).tags = row.tags.map(s => enc(s, dek))
  if (row.questions !== undefined) (patch as { questions: string[] }).questions = row.questions.map(s => enc(s, dek))
  if (row.actionItems !== undefined) {
    (patch as { actionItems: { text: string, done: boolean }[] }).actionItems = row.actionItems.map(it => ({
      text: enc(it.text, dek),
      done: it.done,
    }))
  }
  return { ...row, ...patch }
}

export function decryptAnalysis<T extends AnalysisLike>(row: T, dek: Buffer | null | undefined): T {
  const patch: Partial<T> = {}
  if (row.summaryShort != null) (patch as { summaryShort: string }).summaryShort = dec(row.summaryShort, dek)
  if (row.summaryLong != null) (patch as { summaryLong: string }).summaryLong = dec(row.summaryLong, dek)
  if (row.useCases != null) (patch as { useCases: string[] }).useCases = row.useCases.map(s => dec(s, dek))
  if (row.tags != null) (patch as { tags: string[] }).tags = row.tags.map(s => dec(s, dek))
  if (row.questions != null) (patch as { questions: string[] }).questions = row.questions.map(s => dec(s, dek))
  if (row.actionItems != null) {
    (patch as { actionItems: { text: string, done: boolean }[] }).actionItems = row.actionItems.map(it => ({
      text: dec(it.text, dek),
      done: it.done,
    }))
  }
  return { ...row, ...patch }
}

/* -------------------------------------------------------------------------- */
/*  Doc chunks                                                                 */
/* -------------------------------------------------------------------------- */

export function encryptChunkText(text: string, dek: Buffer | null | undefined): string {
  return enc(text, dek)
}

export function decryptChunkText(text: Maybe<string>, dek: Buffer | null | undefined): string {
  return dec(text, dek)
}

export function decryptChunk<T extends Partial<Pick<DocChunk, 'text'>>>(row: T, dek: Buffer | null | undefined): T {
  if (row.text == null) return row
  return { ...row, text: dec(row.text, dek) }
}

/* -------------------------------------------------------------------------- */
/*  Chat sessions + messages                                                   */
/* -------------------------------------------------------------------------- */

export function encryptChatSessionTitle(title: string, dek: Buffer | null | undefined): string {
  return enc(title, dek)
}

export function decryptChatSessionTitle(title: Maybe<string>, dek: Buffer | null | undefined): string {
  return dec(title, dek)
}

type ChatSource = NonNullable<ChatMessage['sources']>[number]

export function encryptChatSources(sources: ChatSource[], dek: Buffer | null | undefined): ChatSource[] {
  if (!dek) return sources
  return sources.map(s => ({
    ...s,
    snippet: enc(s.snippet, dek),
    ...(s.highlight !== undefined ? { highlight: enc(s.highlight, dek) } : {}),
    // Web sources carry their own title and url; both are user-context and
    // are encrypted at rest. Note sources reconstruct title from the doc
    // row and historically have not persisted it here, so we leave any
    // stored title alone for those.
    ...(s.title !== undefined ? { title: enc(s.title, dek) } : {}),
    ...(s.url !== undefined ? { url: enc(s.url, dek) } : {}),
  }))
}

export function decryptChatSources(sources: ChatSource[] | null | undefined, dek: Buffer | null | undefined): ChatSource[] {
  if (!sources || sources.length === 0) return []
  return sources.map(s => ({
    ...s,
    snippet: dec(s.snippet, dek),
    ...(s.highlight !== undefined && s.highlight !== null ? { highlight: dec(s.highlight, dek) } : {}),
    ...(s.title !== undefined && s.title !== null ? { title: dec(s.title, dek) } : {}),
    ...(s.url !== undefined && s.url !== null ? { url: dec(s.url, dek) } : {}),
  }))
}

export function encryptChatMessageContent(content: string, dek: Buffer | null | undefined): string {
  return enc(content, dek)
}

export function decryptChatMessageContent(content: Maybe<string>, dek: Buffer | null | undefined): string {
  return dec(content, dek)
}

/**
 * Per-turn assistant metadata (model, web-search state, retrieval query, scope…)
 * persisted alongside the message so reopening a session reconstructs the live
 * debug panel + web badge. Stored as an encrypted JSON string in a plain TEXT
 * column — never SQL-queried, so whole-value envelope encryption is fine.
 */
export type ChatMeta = Record<string, unknown>

/** Follow-up suggestion chips. Encrypted JSON string of `string[]`. */
export function encryptChatFollowups(followups: string[], dek: Buffer | null | undefined): string {
  return enc(JSON.stringify(followups ?? []), dek)
}

export function decryptChatFollowups(value: Maybe<string>, dek: Buffer | null | undefined): string[] {
  if (value === null || value === undefined || value === '') return []
  try {
    const parsed = JSON.parse(dec(value, dek)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((q): q is string => typeof q === 'string')
  }
  catch {
    return []
  }
}

export function encryptChatMeta(meta: ChatMeta, dek: Buffer | null | undefined): string {
  return enc(JSON.stringify(meta ?? {}), dek)
}

export function decryptChatMeta(value: Maybe<string>, dek: Buffer | null | undefined): ChatMeta | null {
  if (value === null || value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(dec(value, dek)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ChatMeta
  }
  catch {
    return null
  }
}
