import { z } from 'zod'
import {
  createError,
  defineEventHandler,
  getMethod,
  getRequestHeaders,
  getRequestURL,
  readRawBody,
  setHeader,
  setResponseStatus,
} from 'h3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { eq } from 'drizzle-orm'
import { useDb } from '~/server/database/client'
import { documents, folders, type DocAnalysis, type Document, type User } from '~/server/database/schema'
import { requireMcpUser } from '~/server/utils/mcpAuth'
import { logMcpCall } from '~/server/utils/mcpCalls'
import { setOauthCors } from '~/server/utils/oauth'
import { getWorkspaceKeyForUserById, type WorkspaceKeyCache } from '~/server/utils/workspace-key'
import {
  analyzeUserDocument,
  appendToUserDocument,
  createUserDocument,
  createUserFolder,
  findOrCreateDailyNote,
  findUserDocuments,
  getUserDocument,
  getUserDocumentLinks,
  getUserOverview,
  getUserWorkspace,
  listUserDocuments,
  listUserWorkspaces,
  listUserWorkspaceTags,
  searchUserNotes,
  softDeleteUserDocument,
  softDeleteUserFolder,
  updateUserDocument,
  updateUserFolder,
  type WorkspaceListItem,
} from '~/server/utils/notes'

/* -------------------------------------------------------------------------- */
/*  MCP server (HTTP streamable transport)                                     */
/*                                                                             */
/*  Exposes the authenticated user's notes to external MCP clients (e.g.       */
/*  Claude Desktop). Each HTTP request:                                        */
/*    1. validates the `Authorization: Bearer …` header against `mcp_tokens`   */
/*       via `requireMcpUser` (throws 401 on miss),                            */
/*    2. spins up a per-request McpServer instance with tools that close over  */
/*       the resolved user — no cross-user state, full isolation,              */
/*    3. delegates protocol handling to `WebStandardStreamableHTTPServerTransport`.
 *
 *  Stateless mode (`sessionIdGenerator: undefined`): no session cookies, every
 *  request is independent. Keeps the surface area minimal — Claude Desktop's
 *  MCP HTTP client is happy with it for the read/write tools we expose.
 *
 *  Soft-delete reminder: every NEW read tool added here MUST hide trashed
 *  rows. `notes.ts` (the only call path) applies `activeDocsWhere()` /
 *  `activeFoldersWhere()` on list reads, and lookup-by-id tools call
 *  `getUserDocument(..., { includeTrashed: false })`. Do not bypass.
 *
 *  Encryption reminder: the bearer-unwrapped DEK is the right key ONLY for
 *  solo (`encryptionMode = 'dek'`) workspaces. Shared (`'wek'`) workspaces
 *  encrypt under a per-workspace WEK — every tool that touches content MUST
 *  resolve the key through `keyForWorkspace` / `keyForDocument` /
 *  `keyForFolder` below (or call a notes.ts sweep that resolves keys
 *  internally, like `getUserOverview`). Passing the raw DEK breaks reads
 *  and CORRUPTS writes in shared workspaces.                                 */
/* -------------------------------------------------------------------------- */

/** Wrap an object payload as an MCP tool result with a JSON text part.
 *  Compact (no indentation) — these payloads are read by LLMs, and pretty-
 *  printing inflates token cost for zero benefit. */
function jsonResult(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload) },
    ],
  }
}

/* ---------- Response shaping ----------------------------------------------- */
/*  MCP responses go straight into an LLM context window. Strip fields that    */
/*  are heavy and useless to external clients:                                 */
/*   - `contentJson`: Tiptap mirror of `markdown` (same content, ~2× tokens)   */
/*   - `summaryEmbedding`: 1024-dim Float32 Buffer → ~20 KB of JSON numbers    */
/*   - embed bookkeeping (`embedError`, `embedFailedAt`, length-at-analysis)   */

function toMcpDocument(doc: Document): Omit<Document, 'contentJson'> {
  const { contentJson: _contentJson, ...rest } = doc
  return rest
}

function toMcpAnalysis(analysis: DocAnalysis | null) {
  if (!analysis) return null
  const {
    summaryEmbedding: _summaryEmbedding,
    embedError: _embedError,
    embedFailedAt: _embedFailedAt,
    markdownLengthAtAnalysis: _markdownLengthAtAnalysis,
    ...rest
  } = analysis
  return rest
}

function toMcpWorkspace(ws: WorkspaceListItem) {
  return { id: ws.id, name: ws.name, emoji: ws.emoji, role: ws.role, shared: ws.shared, createdAt: ws.createdAt }
}

/** Server-local `YYYY-MM-DD` — default date for `get_daily_note`. */
function localDateString(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function buildServer(user: User, dek: Buffer | null, tokenId: number | null): McpServer {
  const server = new McpServer({
    name: 'noteforge',
    version: '0.1.0',
  })

  /* ---------- Per-request workspace-key resolution ----------------------- */
  // DEK for solo workspaces, WEK for shared ones. The caches live for one
  // HTTP request (stateless transport = usually one tool call) but still
  // dedupe the unwrap when a tool chains operations (e.g. get_daily_note
  // find-or-create + append).
  const keyCache: WorkspaceKeyCache = {}
  const keyByWorkspace = new Map<number, Buffer | null>()

  async function keyForWorkspace(workspaceId: number): Promise<Buffer | null> {
    if (!dek) return null
    const hit = keyByWorkspace.get(workspaceId)
    if (hit !== undefined) return hit
    const key = await getWorkspaceKeyForUserById(user.id, workspaceId, dek, keyCache)
    keyByWorkspace.set(workspaceId, key)
    return key
  }

  /** Key for the workspace containing this document. Unknown ids resolve to
   *  `null` — the notes layer raises its canonical 404 right after. */
  async function keyForDocument(documentId: number): Promise<Buffer | null> {
    if (!dek) return null
    const [row] = await useDb()
      .select({ workspaceId: documents.workspaceId })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
    if (!row) return null
    return keyForWorkspace(row.workspaceId)
  }

  /** Key for the workspace containing this folder. Same convention. */
  async function keyForFolder(folderId: number): Promise<Buffer | null> {
    if (!dek) return null
    const [row] = await useDb()
      .select({ workspaceId: folders.workspaceId })
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1)
    if (!row) return null
    return keyForWorkspace(row.workspaceId)
  }

  /**
   * Wrap a tool handler with timing + success/failure logging into
   * `mcp_call_logs`. Errors are re-thrown — the transport surfaces them as
   * JSON-RPC errors to the client; we only intercept to record them.
   */
  function instrument<TArgs>(
    toolName: string,
    handler: (args: TArgs) => Promise<ReturnType<typeof jsonResult>>,
  ): (args: TArgs) => Promise<ReturnType<typeof jsonResult>> {
    return async (args: TArgs) => {
      const start = Date.now()
      try {
        const result = await handler(args)
        logMcpCall({ tokenId: tokenId ?? undefined, userId: user.id, toolName, success: true, latencyMs: Date.now() - start })
        return result
      }
      catch (err) {
        const code = (err as { statusCode?: number | string }).statusCode
        const errorCode = code != null ? String(code) : 'internal'
        logMcpCall({ tokenId: tokenId ?? undefined, userId: user.id, toolName, success: false, latencyMs: Date.now() - start, errorCode })
        throw err
      }
    }
  }

  /* ---------- Overview & lookup (one-call round-trip reducers) ----------- */

  server.registerTool(
    'get_overview',
    {
      title: 'Content overview',
      description:
        'One-shot map of the user\'s content: every workspace (or one, with `workspaceId`) with its folder '
        + 'tree and document list (id, title, folderId, updatedAt). Pass `includeSummaries: true` to attach '
        + 'each document\'s AI summary + tags (more tokens, more signal). PREFER THIS over chaining '
        + 'list_workspaces → get_workspace → list_documents when exploring or when the user references '
        + 'content by name. Documents are capped per workspace (most recently updated first; `truncated` '
        + 'flags a cut, `documentCount` keeps the real total).',
      inputSchema: {
        workspaceId: z.number().int().positive().optional(),
        includeSummaries: z.boolean().optional(),
        maxDocsPerWorkspace: z.number().int().min(1).max(500).optional(),
      },
    },
    instrument('get_overview', async ({ workspaceId, includeSummaries, maxDocsPerWorkspace }: { workspaceId?: number, includeSummaries?: boolean, maxDocsPerWorkspace?: number }) => jsonResult(
      await getUserOverview(user.id, { workspaceId, includeSummaries, maxDocsPerWorkspace }, dek),
    )),
  )

  server.registerTool(
    'find_document',
    {
      title: 'Find document by title',
      description:
        'Resolve "the note called X (in workspace Y)" in ONE call — fuzzy, accent/case-insensitive title '
        + 'match across all workspaces, optionally narrowed by `workspaceId` or fuzzy `workspaceName`. '
        + 'Returns ranked matches (docId, title, workspace, score). With `includeContent: true` the best '
        + 'match\'s full markdown + analysis ride along, so a typical "read note X" needs no follow-up '
        + 'read_document call. If `workspaceName` matches nothing, the response lists the available '
        + 'workspace names so you can retry without calling list_workspaces. For content/meaning-based '
        + 'search use search_notes instead.',
      inputSchema: {
        query: z.string().trim().min(1).max(300),
        workspaceId: z.number().int().positive().optional(),
        workspaceName: z.string().trim().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        includeContent: z.boolean().optional(),
      },
    },
    instrument('find_document', async ({ query, workspaceId, workspaceName, limit, includeContent }: { query: string, workspaceId?: number, workspaceName?: string, limit?: number, includeContent?: boolean }) => {
      const result = await findUserDocuments(user.id, { query, workspaceId, workspaceName, limit }, dek)
      const best = result.matches[0]
      if (!includeContent || !best) return jsonResult(result)
      const key = await keyForWorkspace(best.workspaceId)
      const { document, analysis } = await getUserDocument(user.id, best.docId, { includeTrashed: false }, key)
      return jsonResult({ ...result, document: toMcpDocument(document), analysis: toMcpAnalysis(analysis) })
    }),
  )

  /* ---------- Workspaces ------------------------------------------------- */

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        'Return every workspace the user can access (owned + shared, newest first) with their role. '
        + 'For a full content map (folders + documents included) prefer get_overview.',
    },
    instrument('list_workspaces', async () => jsonResult({
      workspaces: (await listUserWorkspaces(user.id, dek)).map(toMcpWorkspace),
    })),
  )

  server.registerTool(
    'get_workspace',
    {
      title: 'Get workspace',
      description: 'Return a single workspace with its active folders and document counts (trashed items excluded).',
      inputSchema: {
        workspaceId: z.number().int().positive(),
      },
    },
    instrument('get_workspace', async ({ workspaceId }: { workspaceId: number }) => jsonResult(
      await getUserWorkspace(user.id, workspaceId, await keyForWorkspace(workspaceId)),
    )),
  )

  /* ---------- Documents -------------------------------------------------- */

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'List active (non-trashed) documents in a workspace. Optionally filter by folder: pass `"root"` to '
        + 'restrict to documents at the workspace root (folderId IS NULL), or a folder id to scope to that folder. '
        + 'Returns lightweight rows (no markdown / contentJson).',
      inputSchema: {
        workspaceId: z.number().int().positive(),
        folderId: z
          .union([z.literal('root'), z.number().int().positive()])
          .optional(),
      },
    },
    instrument('list_documents', async ({ workspaceId, folderId }: { workspaceId: number, folderId?: 'root' | number }) => jsonResult({
      documents: await listUserDocuments(user.id, workspaceId, { folderId }, await keyForWorkspace(workspaceId)),
    })),
  )

  server.registerTool(
    'read_document',
    {
      title: 'Read document',
      description:
        'Read a single document by id: markdown, AI analysis (if present) and wiki-link neighbourhood '
        + '(`links.outgoing` / `links.backlinks`). Trashed documents raise a 404. If you only know the '
        + 'title, use find_document (with includeContent) instead of listing first.',
      inputSchema: {
        documentId: z.number().int().positive(),
      },
    },
    instrument('read_document', async ({ documentId }: { documentId: number }) => {
      const key = await keyForDocument(documentId)
      const [{ document, analysis }, links] = await Promise.all([
        getUserDocument(user.id, documentId, { includeTrashed: false }, key),
        getUserDocumentLinks(user.id, documentId, key),
      ])
      return jsonResult({ document: toMcpDocument(document), analysis: toMcpAnalysis(analysis), links })
    }),
  )

  server.registerTool(
    'create_document',
    {
      title: 'Create document',
      description: 'Create a new document in a workspace, optionally inside a folder.',
      inputSchema: {
        workspaceId: z.number().int().positive(),
        folderId: z.number().int().positive().nullable().optional(),
        title: z.string().trim().min(1).max(200).optional(),
        markdown: z.string().max(2_000_000).optional(),
      },
    },
    instrument('create_document', async ({ workspaceId, folderId, title, markdown }: { workspaceId: number, folderId?: number | null, title?: string, markdown?: string }) => jsonResult({
      document: toMcpDocument(await createUserDocument(user.id, {
        workspaceId,
        folderId: folderId ?? null,
        title,
        markdown,
      }, await keyForWorkspace(workspaceId))),
    })),
  )

  server.registerTool(
    'update_document',
    {
      title: 'Update document',
      description:
        'Patch a document. Provide any subset of `title` / `markdown` / `folderId`. `markdown` REPLACES the '
        + 'whole body — to add to the end, prefer append_to_document (no prior read needed). Trashed '
        + 'documents cannot be updated — restore first.',
      inputSchema: {
        documentId: z.number().int().positive(),
        title: z.string().trim().min(1).max(200).optional(),
        markdown: z.string().max(2_000_000).optional(),
        folderId: z.number().int().positive().nullable().optional(),
      },
    },
    instrument('update_document', async ({ documentId, title, markdown, folderId }: { documentId: number, title?: string, markdown?: string, folderId?: number | null }) => jsonResult({
      document: toMcpDocument(await updateUserDocument(user.id, documentId, {
        title,
        markdown,
        folderId,
      }, await keyForDocument(documentId))),
    })),
  )

  server.registerTool(
    'append_to_document',
    {
      title: 'Append to document',
      description:
        'Append a markdown block to the END of a document in one call — no need to read the document '
        + 'first. A blank line is inserted between the existing content and the addition. Version '
        + 'snapshots and wiki-link reconciliation behave exactly like update_document.',
      inputSchema: {
        documentId: z.number().int().positive(),
        markdown: z.string().min(1).max(2_000_000),
      },
    },
    instrument('append_to_document', async ({ documentId, markdown }: { documentId: number, markdown: string }) => jsonResult({
      document: toMcpDocument(await appendToUserDocument(user.id, documentId, markdown, await keyForDocument(documentId))),
    })),
  )

  server.registerTool(
    'delete_document',
    {
      title: 'Delete document (soft)',
      description:
        'Soft-delete a document: stamps `deletedAt` so it disappears from list/search/chat but can still be '
        + 'restored from the Trash UI. Idempotent — re-deleting a trashed doc returns the existing timestamp.',
      inputSchema: {
        documentId: z.number().int().positive(),
      },
    },
    instrument('delete_document', async ({ documentId }: { documentId: number }) => jsonResult(
      await softDeleteUserDocument(user.id, documentId),
    )),
  )

  /* ---------- Daily notes (journal) -------------------------------------- */

  server.registerTool(
    'get_daily_note',
    {
      title: 'Get daily note (find-or-create)',
      description:
        'Find or create the journal note for a date (title `YYYY-MM-DD`, at the workspace root). `date` '
        + 'defaults to today (server time). Pass `appendMarkdown` to add content to it in the SAME call — '
        + 'the one-shot way to handle "add X to my daily note / journal".',
      inputSchema: {
        workspaceId: z.number().int().positive(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
        appendMarkdown: z.string().min(1).max(2_000_000).optional(),
      },
    },
    instrument('get_daily_note', async ({ workspaceId, date, appendMarkdown }: { workspaceId: number, date?: string, appendMarkdown?: string }) => {
      const key = await keyForWorkspace(workspaceId)
      const { document, created } = await findOrCreateDailyNote(user.id, workspaceId, date ?? localDateString(), key)
      const finalDoc = appendMarkdown
        ? await appendToUserDocument(user.id, document.id, appendMarkdown, key)
        : document
      return jsonResult({ document: toMcpDocument(finalDoc), created })
    }),
  )

  /* ---------- Folders ---------------------------------------------------- */

  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description: 'Create a new folder in a workspace, optionally nested under a parent folder.',
      inputSchema: {
        workspaceId: z.number().int().positive(),
        parentId: z.number().int().positive().nullable().optional(),
        name: z.string().trim().min(1).max(120),
      },
    },
    instrument('create_folder', async ({ workspaceId, parentId, name }: { workspaceId: number, parentId?: number | null, name: string }) => jsonResult({
      folder: await createUserFolder(user.id, {
        workspaceId,
        parentId: parentId ?? null,
        name,
      }, await keyForWorkspace(workspaceId)),
    })),
  )

  server.registerTool(
    'update_folder',
    {
      title: 'Update folder',
      description:
        'Patch a folder: rename and/or reparent. Cannot move (parentId) and reorder (position) in the same call. '
        + 'Refuses to create a cycle (moving a folder into its own descendant).',
      inputSchema: {
        folderId: z.number().int().positive(),
        name: z.string().trim().min(1).max(120).optional(),
        parentId: z.number().int().positive().nullable().optional(),
      },
    },
    instrument('update_folder', async ({ folderId, name, parentId }: { folderId: number, name?: string, parentId?: number | null }) => jsonResult({
      folder: await updateUserFolder(user.id, folderId, { name, parentId }, await keyForFolder(folderId)),
    })),
  )

  server.registerTool(
    'delete_folder',
    {
      title: 'Delete folder (soft)',
      description:
        'Soft-delete a folder and its entire active subtree (descendant folders + documents). All cascaded rows '
        + 'share the same `deletedAt` timestamp so the Trash UI can restore them as a group.',
      inputSchema: {
        folderId: z.number().int().positive(),
      },
    },
    instrument('delete_folder', async ({ folderId }: { folderId: number }) => jsonResult(
      await softDeleteUserFolder(user.id, folderId),
    )),
  )

  /* ---------- Search & AI ------------------------------------------------ */

  server.registerTool(
    'search_notes',
    {
      title: 'Semantic search',
      description:
        'Semantic + keyword search across the user\'s notes. Hybrid retrieval: Mistral embedding cosine '
        + '+ FTS5 BM25, fused (RRF) and LLM-reranked; returns up to 6 hits (max 2 per document) with '
        + '`docId`, `title`, `workspaceId`, `workspaceName`, the chunk `snippet`, the best-matching '
        + '`highlight` sentence and a relevance `score`. Omit `workspaceId` to search ALL workspaces in '
        + 'one call ("where did I write about X?"). Trashed documents are excluded. To find a note by '
        + 'TITLE, use find_document instead — it\'s cheaper and exact.',
      inputSchema: {
        workspaceId: z.number().int().positive().optional(),
        query: z.string().trim().min(1).max(8000),
      },
    },
    instrument('search_notes', async ({ workspaceId, query }: { workspaceId?: number, query: string }) => jsonResult({
      hits: await searchUserNotes(user.id, query, { workspaceId }, dek),
    })),
  )

  server.registerTool(
    'list_tags',
    {
      title: 'List workspace tags',
      description:
        'Aggregate the AI-analysis tags across a workspace\'s active documents: each tag with its document '
        + 'count and doc ids, sorted by frequency. Useful to grasp the themes of a workspace or to locate '
        + 'documents by topic without a semantic search.',
      inputSchema: {
        workspaceId: z.number().int().positive(),
      },
    },
    instrument('list_tags', async ({ workspaceId }: { workspaceId: number }) => jsonResult({
      tags: await listUserWorkspaceTags(user.id, workspaceId, await keyForWorkspace(workspaceId)),
    })),
  )

  server.registerTool(
    'analyze_document',
    {
      title: 'Analyze document',
      description:
        'Run NoteForge\'s AI analysis on a document: produces summary (short + long), use-cases, tags, '
        + 'follow-up questions, action items, and detected language. Also re-embeds the doc\'s chunks in the '
        + 'background so search/chat pick up the new content. Trashed or empty documents cannot be analyzed.',
      inputSchema: {
        documentId: z.number().int().positive(),
      },
    },
    instrument('analyze_document', async ({ documentId }: { documentId: number }) => jsonResult({
      analysis: toMcpAnalysis(await analyzeUserDocument(user.id, documentId, await keyForDocument(documentId))),
    })),
  )

  return server
}

/* -------------------------------------------------------------------------- */
/*  H3 entry point                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a Web-Standard `Request` from the H3 event. We can't rely on
 * `event.web?.request` because Nuxt's Node runtime doesn't populate it —
 * construct one manually instead.
 */
async function toWebRequest(event: Parameters<Parameters<typeof defineEventHandler>[0]>[0]): Promise<Request> {
  const url = getRequestURL(event)
  const method = getMethod(event)
  const headers = new Headers()
  const incoming = getRequestHeaders(event)
  for (const [name, value] of Object.entries(incoming)) {
    if (value == null) continue
    if (Array.isArray(value)) headers.set(name, value.join(', '))
    else headers.set(name, value)
  }

  let body: BodyInit | undefined
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    // MCP payloads are JSON — reading as utf-8 keeps the body BodyInit-safe
    // (DOM `Request` doesn't accept Node's `Buffer` directly).
    const raw = await readRawBody(event, 'utf-8')
    if (raw != null) body = raw
  }

  return new Request(url.toString(), { method, headers, body })
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event)

  // Preflight has to answer BEFORE auth — browsers never attach the
  // Authorization header to an OPTIONS probe, so authenticating first would
  // 401 every cross-origin client (MCP Inspector, browser-side transports).
  setOauthCors(event)
  if (method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return null
  }

  const { user, dek, tokenId } = await requireMcpUser(event)

  // The transport implements POST (RPC messages), GET (server-initiated SSE
  // stream) and DELETE (session termination). Reject anything else early so
  // we don't pay the build-server cost on probes.
  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method Not Allowed',
    })
  }

  const server = buildServer(user, dek, tokenId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode: no session cookie, every request is independent.
    sessionIdGenerator: undefined,
    // Allow JSON-only responses when the client doesn't request SSE. Claude
    // Desktop happily consumes either; JSON keeps the trace simpler for
    // single-shot tool calls.
    enableJsonResponse: true,
  })

  try {
    await server.connect(transport)
    const webReq = await toWebRequest(event)
    const webRes = await transport.handleRequest(webReq)

    setResponseStatus(event, webRes.status)
    webRes.headers.forEach((value, name) => {
      setHeader(event, name, value)
    })

    if (!webRes.body) return null

    // Buffer the body so we can return it as-is — keeps the response simple
    // and avoids subtle issues with returning a Web ReadableStream from H3.
    // Tool responses are small (JSON blobs); SSE streams will be short-lived
    // because we're in stateless mode.
    const buf = await webRes.arrayBuffer()
    return Buffer.from(buf)
  }
  finally {
    // Make sure we release resources even if the client disconnected mid-flight.
    void transport.close().catch(() => { /* ignore */ })
    void server.close().catch(() => { /* ignore */ })
  }
})
