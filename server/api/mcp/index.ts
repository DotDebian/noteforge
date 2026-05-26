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
import type { User } from '~/server/database/schema'
import { requireMcpUser } from '~/server/utils/mcpAuth'
import {
  analyzeUserDocument,
  createUserDocument,
  createUserFolder,
  getUserDocument,
  getUserWorkspace,
  listUserDocuments,
  listUserWorkspaces,
  searchUserWorkspace,
  softDeleteUserDocument,
  softDeleteUserFolder,
  updateUserDocument,
  updateUserFolder,
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
 *  `getUserDocument(..., { includeTrashed: false })`. Do not bypass.        */
/* -------------------------------------------------------------------------- */

/** Wrap an object payload as an MCP tool result with a JSON text part. */
function jsonResult(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
  }
}

function buildServer(user: User, dek: Buffer | null): McpServer {
  const server = new McpServer({
    name: 'noteforge',
    version: '0.1.0',
  })

  /* ---------- Workspaces ------------------------------------------------- */

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: 'Return every workspace owned by the authenticated user (newest first).',
    },
    async () => jsonResult({ workspaces: await listUserWorkspaces(user.id, dek) }),
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
    async ({ workspaceId }) => jsonResult(await getUserWorkspace(user.id, workspaceId, dek)),
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
    async ({ workspaceId, folderId }) => jsonResult({
      documents: await listUserDocuments(user.id, workspaceId, { folderId }, dek),
    }),
  )

  server.registerTool(
    'read_document',
    {
      title: 'Read document',
      description:
        'Read a single document (markdown + contentJson + analysis if present). Trashed documents are '
        + 'NOT returned — they raise a 404 to keep the MCP surface consistent with list endpoints.',
      inputSchema: {
        documentId: z.number().int().positive(),
      },
    },
    async ({ documentId }) => jsonResult(
      await getUserDocument(user.id, documentId, { includeTrashed: false }, dek),
    ),
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
    async ({ workspaceId, folderId, title, markdown }) => jsonResult({
      document: await createUserDocument(user.id, {
        workspaceId,
        folderId: folderId ?? null,
        title,
        markdown,
      }, dek),
    }),
  )

  server.registerTool(
    'update_document',
    {
      title: 'Update document',
      description:
        'Patch a document. Provide any subset of `title` / `markdown` / `folderId`. Cannot move (folderId) '
        + 'and reorder (position) in the same call. Trashed documents cannot be updated — restore first.',
      inputSchema: {
        documentId: z.number().int().positive(),
        title: z.string().trim().min(1).max(200).optional(),
        markdown: z.string().max(2_000_000).optional(),
        folderId: z.number().int().positive().nullable().optional(),
      },
    },
    async ({ documentId, title, markdown, folderId }) => jsonResult({
      document: await updateUserDocument(user.id, documentId, {
        title,
        markdown,
        folderId,
      }, dek),
    }),
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
    async ({ documentId }) => jsonResult(
      await softDeleteUserDocument(user.id, documentId),
    ),
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
    async ({ workspaceId, parentId, name }) => jsonResult({
      folder: await createUserFolder(user.id, {
        workspaceId,
        parentId: parentId ?? null,
        name,
      }, dek),
    }),
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
    async ({ folderId, name, parentId }) => jsonResult({
      folder: await updateUserFolder(user.id, folderId, { name, parentId }, dek),
    }),
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
    async ({ folderId }) => jsonResult(
      await softDeleteUserFolder(user.id, folderId),
    ),
  )

  /* ---------- Search & AI ------------------------------------------------ */

  server.registerTool(
    'search_notes',
    {
      title: 'Semantic search',
      description:
        'Workspace-scoped semantic search across the user\'s notes. Embeds the query via Mistral, scores '
        + 'document chunks by cosine similarity (MIN_SCORE=0.45), and returns up to 6 hits with a per-doc cap '
        + 'of 2. Trashed documents are excluded. Each hit includes `docId`, `title`, `chunkIdx`, full chunk '
        + '`snippet`, the best-matching `highlight` sentence relative to the query, and the cosine `score`.',
      inputSchema: {
        workspaceId: z.number().int().positive(),
        query: z.string().trim().min(1).max(8000),
      },
    },
    async ({ workspaceId, query }) => jsonResult({
      hits: await searchUserWorkspace(user.id, workspaceId, query, dek),
    }),
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
    async ({ documentId }) => jsonResult({
      analysis: await analyzeUserDocument(user.id, documentId, dek),
    }),
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
  const { user, dek } = await requireMcpUser(event)
  const method = getMethod(event)

  // The transport implements POST (RPC messages), GET (server-initiated SSE
  // stream) and DELETE (session termination). Reject anything else early so
  // we don't pay the build-server cost on probes.
  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method Not Allowed',
    })
  }

  const server = buildServer(user, dek)
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
