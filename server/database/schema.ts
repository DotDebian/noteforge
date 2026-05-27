import { relations, sql } from 'drizzle-orm'
import { blob, integer, sqliteTable, text, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core'

/* -------------------------------------------------------------------------- */
/*  Users + sessions                                                          */
/* -------------------------------------------------------------------------- */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  disabledAt: integer('disabled_at', { mode: 'timestamp' }),
  /* ---- At-rest encryption (per-user wrapped DEK) ---- */
  /** scrypt salt used to derive the KDK from the password. */
  kdfSalt: blob('kdf_salt', { mode: 'buffer' }),
  /** DEK encrypted under KDK = scrypt(password, kdfSalt). `iv||tag||ct`. */
  wrappedDek: blob('wrapped_dek', { mode: 'buffer' }),
  /** DEK encrypted under a wrap key derived from the user's recovery key. */
  recoveryWrappedDek: blob('recovery_wrapped_dek', { mode: 'buffer' }),
  /** SHA-256 hex of the normalised recovery key — used to look it up by hash without storing the clear value. */
  recoveryKeyHash: text('recovery_key_hash'),
  /** `1` once the user's data has been encrypted at rest. New users start at `1`; legacy users flip after first-login migration. */
  encryptionEnabled: integer('encryption_enabled', { mode: 'boolean' }).notNull().default(false),
})

/* -------------------------------------------------------------------------- */
/*  Workspaces / folders / documents                                          */
/* -------------------------------------------------------------------------- */

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerId: integer('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  emoji: text('emoji'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const folders = sqliteTable(
  'folders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    parentId: integer('parent_id'),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  },
  (t) => ({
    parentIdx: index('folders_parent_idx').on(t.parentId),
    workspaceIdx: index('folders_workspace_idx').on(t.workspaceId),
  }),
)

export const documents = sqliteTable(
  'documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    folderId: integer('folder_id'),
    title: text('title').notNull().default('Untitled'),
    markdown: text('markdown').notNull().default(''),
    contentJson: text('content_json').notNull().default('{}'),
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  },
  (t) => ({
    folderIdx: index('documents_folder_idx').on(t.folderId),
    workspaceIdx: index('documents_workspace_idx').on(t.workspaceId),
  }),
)

/* -------------------------------------------------------------------------- */
/*  AI analysis + embeddings                                                  */
/* -------------------------------------------------------------------------- */

export const docAnalyses = sqliteTable('doc_analyses', {
  docId: integer('doc_id')
    .primaryKey()
    .references(() => documents.id, { onDelete: 'cascade' }),
  summaryShort: text('summary_short').notNull().default(''),
  summaryLong: text('summary_long').notNull().default(''),
  useCases: text('use_cases', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  questions: text('questions', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  actionItems: text('action_items', { mode: 'json' })
    .$type<{ text: string, done: boolean }[]>()
    .notNull()
    .default(sql`'[]'`),
  language: text('language'),
  generatedAt: integer('generated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  /**
   * Length (chars) of `documents.markdown` at the time of analysis. Used by
   * the client-side stale-indicator (Sprint 3 / I7) to compute char-delta
   * and decide whether to auto-reanalyze.
   */
  markdownLengthAtAnalysis: integer('markdown_length_at_analysis').notNull().default(0),
  /**
   * Last error message produced by the background `embedDocument` step. Null
   * when the most-recent embed run succeeded (or hasn't run yet). Surfaced
   * by the Insights panel so silent failures (Mistral 429, network drops,
   * etc.) don't leave the doc invisible to chat + related-notes.
   */
  embedError: text('embed_error'),
  embedFailedAt: integer('embed_failed_at', { mode: 'timestamp' }),
  /**
   * Doc-level "what is this about" vector, used by /api/ai/related to score
   * doc-to-doc similarity without averaging chunk embeddings (which dilutes
   * the signal). Built from title + summary + tags and embedded via
   * `mistralEmbed`. Float32 little-endian buffer, 1024 dims.
   *
   * Null when analysis predates this column (backfilled lazily on the next
   * re-analyze) or when the summary-embed call failed.
   */
  summaryEmbedding: blob('summary_embedding', { mode: 'buffer' }),
})

export const docChunks = sqliteTable(
  'doc_chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    docId: integer('doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    /**
     * Legacy embedding column (JSON-encoded `number[]`). Retained for the
     * transition window; new writes also populate `embeddingBlob`. Will be
     * dropped in a follow-up migration once all callers read from BLOB.
     */
    embedding: text('embedding'),
    /**
     * Float32 little-endian buffer of the embedding vector. Preferred over
     * the JSON TEXT column going forward — matches sqlite-vec's expected
     * layout.
     */
    embeddingBlob: blob('embedding_blob', { mode: 'buffer' }),
    /**
     * Heading-hierarchy path that produced this chunk, e.g. `['Intro', 'Goals']`.
     * Null for legacy chunks written before section-aware chunking landed
     * (Sprint 3 / I2); they will be replaced next time their doc is analyzed.
     * Empty array means "preamble" — text before any heading.
     */
    sectionPath: text('section_path', { mode: 'json' }).$type<string[]>(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    docIdx: index('doc_chunks_doc_idx').on(t.docId),
    uniqDocIdx: uniqueIndex('doc_chunks_doc_idx_unique').on(t.docId, t.idx),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Favorites (pinned docs)                                                    */
/* -------------------------------------------------------------------------- */

export const favorites = sqliteTable(
  'favorites',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    docId: integer('doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.docId] }),
    userIdx: index('favorites_user_idx').on(t.userId),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Doc-to-doc links (wiki-style backlinks)                                   */
/* -------------------------------------------------------------------------- */

export const docLinks = sqliteTable(
  'doc_links',
  {
    sourceDocId: integer('source_doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    targetDocId: integer('target_doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceDocId, t.targetDocId] }),
    targetIdx: index('doc_links_target_idx').on(t.targetDocId),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Attachments (image uploads)                                                */
/* -------------------------------------------------------------------------- */

export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    docId: integer('doc_id').references(() => documents.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    workspaceIdx: index('attachments_workspace_idx').on(t.workspaceId),
    sha256Idx: index('attachments_sha256_idx').on(t.sha256),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Public share tokens (Sprint 5 / F9)                                        */
/* -------------------------------------------------------------------------- */

export const shareTokens = sqliteTable(
  'share_tokens',
  {
    token: text('token').primaryKey(),
    docId: integer('doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (t) => ({
    docIdx: index('share_tokens_doc_idx').on(t.docId),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Document version history (Sprint 5 / I9)                                   */
/* -------------------------------------------------------------------------- */

export const documentVersions = sqliteTable(
  'document_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    docId: integer('doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    markdown: text('markdown').notNull(),
    contentJson: text('content_json').notNull().default('{}'),
    title: text('title').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * - `autosave_snapshot`: snapshot taken on first edit of a new edit
     *   session (>= 30 min since the last existing snapshot). Captures the
     *   prior state of the document.
     * - `manual_snapshot`: user-initiated checkpoint via the version-history
     *   modal.
     * - `pre_restore`: snapshot of the doc taken immediately before a restore
     *   overwrites it — gives the user an undo path.
     */
    reason: text('reason', {
      enum: ['autosave_snapshot', 'manual_snapshot', 'pre_restore'],
    }).notNull(),
  },
  (t) => ({
    docIdx: index('document_versions_doc_idx').on(t.docId, t.createdAt),
  }),
)

/* -------------------------------------------------------------------------- */
/*  MCP bearer tokens                                                          */
/*                                                                             */
/*  Per-user bearer tokens that authenticate the MCP server endpoint           */
/*  (`/api/mcp`) so external clients (e.g. Claude Desktop) can read/write a    */
/*  user's notes. Tokens are stored as SHA-256 hex (`tokenHash`, UNIQUE), not  */
/*  the clear value — the clear token is shown to the user once at creation   */
/*  and never persisted. `prefix` is the first ~8 chars (for UI display only).*/
/*  Revocation is soft: stamp `revokedAt`, never hard-delete, so the audit    */
/*  trail (creation / last use) survives.                                     */
/* -------------------------------------------------------------------------- */

export const mcpTokens = sqliteTable(
  'mcp_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    /** DEK encrypted under a wrap key derived from the bearer (HKDF). Null for legacy tokens minted before encryption shipped. */
    wrappedDek: blob('wrapped_dek', { mode: 'buffer' }),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('mcp_tokens_token_hash_idx').on(t.tokenHash),
    userIdx: index('mcp_tokens_user_idx').on(t.userId),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Chat RAG                                                                   */
/* -------------------------------------------------------------------------- */

export const chatSessions = sqliteTable('chat_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeFolderId: integer('scope_folder_id'),
  /**
   * Doc-scoped chat (Sprint 4 / F11). Mutually exclusive with `scopeFolderId`
   * in practice — when both are set, doc scope wins server-side. `set null`
   * lets a deleted doc gracefully demote the session to workspace scope.
   */
  scopeDocId: integer('scope_doc_id')
    .references(() => documents.id, { onDelete: 'set null' }),
  title: text('title').notNull().default('New chat'),
  /**
   * Chat branching: if this session was created by branching from an
   * existing one, `parentSessionId` is that session's id and
   * `branchFromMessageId` is the chat_messages id we forked from. Both null
   * for top-level sessions.
   */
  parentSessionId: integer('parent_session_id'),
  branchFromMessageId: integer('branch_from_message_id'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/* -------------------------------------------------------------------------- */
/*  Per-user settings (Editor / AI / Notifications)                            */
/* -------------------------------------------------------------------------- */

export const userPreferences = sqliteTable('user_preferences', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /**
   * Editor preferences: { columnWidth: 'narrow'|'normal'|'wide', fontSize: 'small'|'normal'|'large', focusModeDefault: boolean }
   */
  editor: text('editor', { mode: 'json' })
    .$type<{ columnWidth?: 'narrow' | 'normal' | 'wide', fontSize?: 'small' | 'normal' | 'large', focusModeDefault?: boolean }>()
    .notNull()
    .default(sql`'{}'`),
  /**
   * AI preferences: { chatModel: string, temperature: number, disableRewriter: boolean, disableReranker: boolean }
   */
  ai: text('ai', { mode: 'json' })
    .$type<{ chatModel?: string, temperature?: number, disableRewriter?: boolean, disableReranker?: boolean }>()
    .notNull()
    .default(sql`'{}'`),
  /**
   * Notifications: { analysisDone: boolean, mentionInDoc: boolean, weeklyDigest: boolean }
   */
  notifications: text('notifications', { mode: 'json' })
    .$type<{ analysisDone?: boolean, mentionInDoc?: boolean, weeklyDigest?: boolean }>()
    .notNull()
    .default(sql`'{}'`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/* -------------------------------------------------------------------------- */
/*  TOTP / 2FA                                                                 */
/* -------------------------------------------------------------------------- */

export const userTotp = sqliteTable('user_totp', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Base32 TOTP secret. Encrypted at rest (xor with NUXT_SESSION_PASSWORD-derived key). */
  secretEncrypted: text('secret_encrypted').notNull(),
  /** Stays false while user is mid-enrollment (secret generated, not yet verified). */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** Single-use backup codes, hashed (SHA-256 hex). Stored as JSON array of strings. */
  backupCodes: text('backup_codes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  enabledAt: integer('enabled_at', { mode: 'timestamp' }),
})

/* -------------------------------------------------------------------------- */
/*  Saved searches                                                             */
/* -------------------------------------------------------------------------- */

export const savedSearches = sqliteTable(
  'saved_searches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Captured search query — { q, tags, folderId, dateFrom, dateTo, sort }. */
    queryJson: text('query_json', { mode: 'json' })
      .$type<{
        q?: string
        tags?: string[]
        folderId?: number | null
        dateFrom?: string | null
        dateTo?: string | null
        sort?: 'relevance' | 'recent' | 'oldest'
      }>()
      .notNull()
      .default(sql`'{}'`),
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    userIdx: index('saved_searches_user_idx').on(t.userId),
    workspaceIdx: index('saved_searches_workspace_idx').on(t.workspaceId),
  }),
)

/* -------------------------------------------------------------------------- */
/*  AI usage logging                                                           */
/* -------------------------------------------------------------------------- */

export const aiUsageLogs = sqliteTable(
  'ai_usage_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    operation: text('operation').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    userIdx: index('ai_usage_logs_user_idx').on(t.userId),
    createdIdx: index('ai_usage_logs_created_idx').on(t.createdAt),
  }),
)

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    sources: text('sources', { mode: 'json' })
      .$type<{
        docId: number
        chunkIdx: number
        snippet: string
        /** Best-matching sentence inside the chunk (post-stream refinement). */
        highlight?: string
        /** Original [#N] citation number used in the assistant's text. */
        citation?: number
      }[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    sessionIdx: index('chat_messages_session_idx').on(t.sessionId),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const usersRelations = relations(users, ({ many }) => ({
  workspaces: many(workspaces),
}))

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id] }),
  folders: many(folders),
  documents: many(documents),
}))

export const foldersRelations = relations(folders, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [folders.workspaceId], references: [workspaces.id] }),
  parent: one(folders, { fields: [folders.parentId], references: [folders.id], relationName: 'folder_parent' }),
  children: many(folders, { relationName: 'folder_parent' }),
  documents: many(documents),
}))

export const documentsRelations = relations(documents, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [documents.workspaceId], references: [workspaces.id] }),
  folder: one(folders, { fields: [documents.folderId], references: [folders.id] }),
  analysis: one(docAnalyses, { fields: [documents.id], references: [docAnalyses.docId] }),
  chunks: many(docChunks),
}))

export const docChunksRelations = relations(docChunks, ({ one }) => ({
  document: one(documents, { fields: [docChunks.docId], references: [documents.id] }),
}))

export const chatSessionsRelations = relations(chatSessions, ({ one, many }) => ({
  user: one(users, { fields: [chatSessions.userId], references: [users.id] }),
  workspace: one(workspaces, { fields: [chatSessions.workspaceId], references: [workspaces.id] }),
  messages: many(chatMessages),
}))

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  session: one(chatSessions, { fields: [chatMessages.sessionId], references: [chatSessions.id] }),
}))

/* -------------------------------------------------------------------------- */
/*  Inferred types (importables partout)                                       */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type Folder = typeof folders.$inferSelect
export type NewFolder = typeof folders.$inferInsert
export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
export type DocAnalysis = typeof docAnalyses.$inferSelect
export type DocChunk = typeof docChunks.$inferSelect
export type NewDocChunk = typeof docChunks.$inferInsert
export type ChatSession = typeof chatSessions.$inferSelect
export type ChatMessage = typeof chatMessages.$inferSelect
export type Favorite = typeof favorites.$inferSelect
export type NewFavorite = typeof favorites.$inferInsert
export type DocLink = typeof docLinks.$inferSelect
export type NewDocLink = typeof docLinks.$inferInsert
export type Attachment = typeof attachments.$inferSelect
export type NewAttachment = typeof attachments.$inferInsert
export type ShareToken = typeof shareTokens.$inferSelect
export type NewShareToken = typeof shareTokens.$inferInsert
export type DocumentVersion = typeof documentVersions.$inferSelect
export type NewDocumentVersion = typeof documentVersions.$inferInsert
export type McpToken = typeof mcpTokens.$inferSelect
export type NewMcpToken = typeof mcpTokens.$inferInsert
export type UserPreferences = typeof userPreferences.$inferSelect
export type NewUserPreferences = typeof userPreferences.$inferInsert
export type UserTotp = typeof userTotp.$inferSelect
export type NewUserTotp = typeof userTotp.$inferInsert
export type SavedSearch = typeof savedSearches.$inferSelect
export type NewSavedSearch = typeof savedSearches.$inferInsert
export type AiUsageLog = typeof aiUsageLogs.$inferSelect
export type NewAiUsageLog = typeof aiUsageLogs.$inferInsert
