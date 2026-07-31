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
  /* ---- Asymmetric keypair (workspace sharing) ---- */
  /** X25519 public key (SPKI/DER, 44 bytes) — clear. Used to seal a WEK for this user. Null for legacy users until first login post-share-rollout. */
  publicKey: blob('public_key', { mode: 'buffer' }),
  /** X25519 private key (PKCS8/DER, 48 bytes) wrapped under the user's DEK. */
  wrappedPrivateKey: blob('wrapped_private_key', { mode: 'buffer' }),
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
  /**
   * Encryption mode for this workspace's content.
   *  - `'dek'`: solo workspace; content is encrypted under the owner's DEK
   *    (original model). Default for new workspaces.
   *  - `'wek'`: shared workspace; content is encrypted under a per-workspace
   *    Workspace Encryption Key (WEK) that is sealed for each member via the
   *    `workspace_shares` table. The owner has their own `workspace_shares`
   *    row with role `'owner'` so the key-resolution path stays uniform.
   *
   * Flips from `'dek'` to `'wek'` on the first share — see
   * `POST /api/workspaces/[id]/shares`.
   */
  encryptionMode: text('encryption_mode', { enum: ['dek', 'wek'] }).notNull().default('dek'),
})

/**
 * Membership rows for shared workspaces.
 *
 * Exists ONLY for workspaces in `encryptionMode = 'wek'`. The owner has a
 * row here (role `'owner'`) alongside each invited user so the
 * key-resolution path is the same regardless of who is asking.
 *
 * `wrappedWek` is the workspace's WEK sealed for THIS user's public key
 * (sealed-box, see crypto.ts → sealForPublicKey). It is opened with the
 * user's private key at request time.
 *
 * Role semantics:
 *  - `'owner'`: full access (share, revoke, delete workspace, etc.). Only
 *    one owner per workspace; matches `workspaces.ownerId`.
 *  - `'editor'`: read + write content (create/update/delete folders + docs,
 *    run analysis, etc.).
 *  - `'viewer'`: read-only — list/read documents, chat over them.
 *
 * Soft-deletion: when a user is revoked, the row is hard-deleted (the
 * `workspace_shares.wrappedWek` is no longer reachable by them). The
 * audit trail lives in `admin_audit_log`.
 */
export const workspaceShares = sqliteTable(
  'workspace_shares',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
    /** WEK sealed for `userId`'s public key (see crypto.ts → sealForPublicKey). */
    wrappedWek: blob('wrapped_wek', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    /** Who granted this share (owner at the time of share). */
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    workspaceUserUniq: uniqueIndex('workspace_shares_workspace_user_uniq').on(t.workspaceId, t.userId),
    userIdx: index('workspace_shares_user_idx').on(t.userId),
    workspaceIdx: index('workspace_shares_workspace_idx').on(t.workspaceId),
  }),
)

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

/**
 * Document flavours. `'markdown'` is the default and covers every row written
 * before the standalone-drawing feature landed — the column's SQL default keeps
 * old rows valid without a backfill.
 */
export const DOCUMENT_TYPES = ['markdown', 'excalidraw'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export const documents = sqliteTable(
  'documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    folderId: integer('folder_id'),
    title: text('title').notNull().default('Untitled'),
    // What `markdown` / `contentJson` actually hold.
    //  - 'markdown'   — the historical shape: `markdown` is the source of
    //                   truth, `contentJson` its Tiptap mirror.
    //  - 'excalidraw' — `contentJson` is the source of truth (an Excalidraw
    //                   scene, see utils/excalidraw-scene.ts) and `markdown`
    //                   is DERIVED from it on every save: the drawing's text
    //                   elements followed by a PNG data-URL image. That is
    //                   what keeps search, RAG, exports, transclusion and
    //                   public shares working without a special case.
    // Anything that WRITES markdown (MCP patch/append, version restore) must
    // refuse or regenerate for 'excalidraw' rows — see server/utils/notes.ts.
    type: text('type').notNull().default('markdown').$type<DocumentType>(),
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
    /**
     * SHA-256 hex of the raw share token. The raw token lives only in the URL —
     * never persisted — so a stolen `noteforge.db` can't reconstruct a working
     * link nor (via `wrappedKey`) decrypt the shared document. Lookup by hash =
     * lookup by primary key.
     */
    token: text('token').primaryKey(),
    /** First chars of the raw token: a non-secret display handle in the share
     *  list. The full URL is shown only once, at creation. Null on legacy rows. */
    prefix: text('prefix'),
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
    /**
     * Workspace content key (DEK or WEK) wrapped under a key derived from the
     * raw token (`deriveTokenWrapKey`). The unauthenticated public reader
     * re-derives that key from the URL token to decrypt the live document.
     * Null only for pre-encryption workspaces (no key on the session at share
     * time) and legacy rows minted before this column existed.
     */
    wrappedKey: blob('wrapped_key', { mode: 'buffer' }),
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
/*  OAuth 2.1 authorization server (Claude custom connectors)                  */
/*                                                                             */
/*  claude.ai's "custom connector" flow cannot send a static bearer header —   */
/*  it only speaks OAuth. So NoteForge doubles as a (tiny, single-tenant)      */
/*  authorization server for its own MCP resource:                             */
/*                                                                             */
/*    oauth_clients     — one row per connector the user registers. The client */
/*                        secret is stored SHA-256-hashed like `mcp_tokens`.   */
/*    oauth_auth_codes  — short-lived authorization codes (PKCE, single use).  */
/*    oauth_tokens      — issued access + refresh token pairs (one row per     */
/*                        grant; refresh rotates both in place).               */
/*                                                                             */
/*  Every artefact that can authenticate an MCP call carries its own copy of   */
/*  the user's DEK, wrapped under a key derived from that artefact via HKDF    */
/*  (`deriveTokenWrapKey`) — exactly the scheme `mcp_tokens.wrapped_dek` uses.  */
/*  The DEK is captured from the browser session at consent time and handed    */
/*  down the chain code → access token → refreshed access token, so an MCP     */
/*  request can decrypt user content from the bearer alone.                    */
/* -------------------------------------------------------------------------- */

export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    /** Public identifier handed to the connector (`nfc_…`). */
    clientId: text('client_id').notNull(),
    /** SHA-256 hex of the client secret — the clear value is shown once. */
    clientSecretHash: text('client_secret_hash').notNull(),
    /** First ~11 chars of the secret, for UI display only. */
    secretPrefix: text('secret_prefix').notNull(),
    /** Allowed redirect URIs (exact match, plus loopback allowance at check time). */
    redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (t) => ({
    clientIdIdx: uniqueIndex('oauth_clients_client_id_idx').on(t.clientId),
    userIdx: index('oauth_clients_user_idx').on(t.userId),
  }),
)

export const oauthAuthCodes = sqliteTable(
  'oauth_auth_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientRowId: integer('client_row_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    /** PKCE S256 challenge — required, we don't accept `plain`. */
    codeChallenge: text('code_challenge').notNull(),
    /** RFC 8707 audience the client asked for; echoed for bookkeeping only. */
    resource: text('resource'),
    scope: text('scope').notNull(),
    /** DEK wrapped under a key derived from the clear code. */
    wrappedDek: blob('wrapped_dek', { mode: 'buffer' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    codeHashIdx: uniqueIndex('oauth_auth_codes_code_hash_idx').on(t.codeHash),
    expiresIdx: index('oauth_auth_codes_expires_idx').on(t.expiresAt),
  }),
)

export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientRowId: integer('client_row_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The authorization code this grant came from. Kept so a replayed code
     * revokes exactly the tokens it produced (RFC 6749 §10.5) instead of every
     * token the client holds — a network retry must not nuke a working
     * connector. Goes null when the code row is GC'd after expiry, by which
     * point replay is impossible anyway.
     */
    authCodeId: integer('auth_code_id').references(() => oauthAuthCodes.id, { onDelete: 'set null' }),
    accessTokenHash: text('access_token_hash').notNull(),
    refreshTokenHash: text('refresh_token_hash'),
    /** DEK wrapped under a key derived from the clear access token. */
    wrappedDekAccess: blob('wrapped_dek_access', { mode: 'buffer' }),
    /** Same DEK, wrapped under the refresh token so rotation can re-wrap it. */
    wrappedDekRefresh: blob('wrapped_dek_refresh', { mode: 'buffer' }),
    scope: text('scope').notNull(),
    accessExpiresAt: integer('access_expires_at', { mode: 'timestamp' }).notNull(),
    refreshExpiresAt: integer('refresh_expires_at', { mode: 'timestamp' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (t) => ({
    accessHashIdx: uniqueIndex('oauth_tokens_access_hash_idx').on(t.accessTokenHash),
    refreshHashIdx: uniqueIndex('oauth_tokens_refresh_hash_idx').on(t.refreshTokenHash),
    clientIdx: index('oauth_tokens_client_idx').on(t.clientRowId),
    userIdx: index('oauth_tokens_user_idx').on(t.userId),
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
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    userIdx: index('ai_usage_logs_user_idx').on(t.userId),
    createdIdx: index('ai_usage_logs_created_idx').on(t.createdAt),
  }),
)

/* -------------------------------------------------------------------------- */
/*  Admin panel: instrumentation, audit, observability                         */
/* -------------------------------------------------------------------------- */

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    success: integer('success', { mode: 'boolean' }).notNull(),
    errorCode: text('error_code'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    emailIdx: index('login_attempts_email_idx').on(t.email),
    createdIdx: index('login_attempts_created_idx').on(t.createdAt),
  }),
)

export const adminAuditLog = sqliteTable(
  'admin_audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    adminId: integer('admin_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: integer('target_id'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    adminIdx: index('admin_audit_log_admin_idx').on(t.adminId),
    createdIdx: index('admin_audit_log_created_idx').on(t.createdAt),
  }),
)

export const mcpCallLogs = sqliteTable(
  'mcp_call_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenId: integer('token_id').references(() => mcpTokens.id, { onDelete: 'set null' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    toolName: text('tool_name').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    tokenIdx: index('mcp_call_logs_token_idx').on(t.tokenId),
    userIdx: index('mcp_call_logs_user_idx').on(t.userId),
    toolIdx: index('mcp_call_logs_tool_idx').on(t.toolName),
    createdIdx: index('mcp_call_logs_created_idx').on(t.createdAt),
  }),
)

export const ragQualityLogs = sqliteTable(
  'rag_quality_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    chunksReturned: integer('chunks_returned').notNull().default(0),
    rerankScoreAvg: text('rerank_score_avg'),
    citationsEmitted: integer('citations_emitted').notNull().default(0),
    hasCitation: integer('has_citation', { mode: 'boolean' }).notNull().default(false),
    rewriterUsed: integer('rewriter_used', { mode: 'boolean' }).notNull().default(false),
    rerankerUsed: integer('reranker_used', { mode: 'boolean' }).notNull().default(false),
    latencyMs: integer('latency_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    userIdx: index('rag_quality_logs_user_idx').on(t.userId),
    createdIdx: index('rag_quality_logs_created_idx').on(t.createdAt),
  }),
)

export const healthSnapshots = sqliteTable(
  'health_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dbSizeBytes: integer('db_size_bytes').notNull().default(0),
    usersCount: integer('users_count').notNull().default(0),
    docsCount: integer('docs_count').notNull().default(0),
    chunksCount: integer('chunks_count').notNull().default(0),
    sessionsCount: integer('sessions_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    createdIdx: index('health_snapshots_created_idx').on(t.createdAt),
  }),
)

export const userQuotas = sqliteTable('user_quotas', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  maxDocs: integer('max_docs'),
  maxTokensMonth: integer('max_tokens_month'),
  maxWorkspaces: integer('max_workspaces'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const appLogs = sqliteTable(
  'app_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull(),
    source: text('source').notNull(),
    message: text('message').notNull(),
    context: text('context', { mode: 'json' }).$type<Record<string, unknown>>(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    levelIdx: index('app_logs_level_idx').on(t.level),
    createdIdx: index('app_logs_created_idx').on(t.createdAt),
  }),
)

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    durationMs: integer('duration_ms'),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    statusIdx: index('jobs_status_idx').on(t.status),
    typeIdx: index('jobs_type_idx').on(t.type),
    createdIdx: index('jobs_created_idx').on(t.createdAt),
  }),
)

export const decryptionFailures = sqliteTable(
  'decryption_failures',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id'),
    field: text('field').notNull(),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    userIdx: index('decryption_failures_user_idx').on(t.userId),
    createdIdx: index('decryption_failures_created_idx').on(t.createdAt),
  }),
)

export const retentionPolicy = sqliteTable('retention_policy', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

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
        /** Title of the source doc (denormalised for source-chip render). */
        title?: string
        /**
         * Source kind: 'note' (default) for retrieved doc chunks, 'web' for
         * web-search results when the web-fallback toggle is on (Wave 2 / N5).
         */
        kind?: 'note' | 'web'
        /** URL for web sources. Unused for note sources. */
        url?: string
        /**
         * `documents.updatedAt` unix-seconds snapshot at the time the answer
         * was streamed. The UI compares this with the message `createdAt` to
         * surface a "stale source" badge (Wave 2 / I4) when the underlying
         * doc was edited after the answer.
         */
        docUpdatedAt?: number
      }[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * User feedback on assistant answers (Wave 2 / N3). NULL = no feedback,
     * 1 = thumbs up, -1 = thumbs down. Set via the per-message thumbs
     * buttons in the chat drawer; only meaningful for assistant rows.
     */
    userFeedback: integer('user_feedback'),
    /**
     * Suggested follow-up question chips (Wave 5). Encrypted JSON string of
     * `string[]` (plain TEXT, whole-value envelope — never SQL-queried). NULL
     * for legacy rows / user messages. Persisted so reopening a session shows
     * the same follow-up chips as the live turn.
     */
    followups: text('followups'),
    /**
     * Per-turn assistant metadata (model, web-search state, retrieval query,
     * scope, temperature…) as an encrypted JSON string. Backs the debug panel
     * and the "web search ran" badge on reload. NULL for legacy / user rows.
     */
    meta: text('meta'),
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
export type WorkspaceShare = typeof workspaceShares.$inferSelect
export type NewWorkspaceShare = typeof workspaceShares.$inferInsert
export type WorkspaceRole = WorkspaceShare['role']
export type DocumentVersion = typeof documentVersions.$inferSelect
export type NewDocumentVersion = typeof documentVersions.$inferInsert
export type McpToken = typeof mcpTokens.$inferSelect
export type NewMcpToken = typeof mcpTokens.$inferInsert
export type OauthClient = typeof oauthClients.$inferSelect
export type NewOauthClient = typeof oauthClients.$inferInsert
export type OauthAuthCode = typeof oauthAuthCodes.$inferSelect
export type NewOauthAuthCode = typeof oauthAuthCodes.$inferInsert
export type OauthToken = typeof oauthTokens.$inferSelect
export type NewOauthToken = typeof oauthTokens.$inferInsert
export type UserPreferences = typeof userPreferences.$inferSelect
export type NewUserPreferences = typeof userPreferences.$inferInsert
export type UserTotp = typeof userTotp.$inferSelect
export type NewUserTotp = typeof userTotp.$inferInsert
export type SavedSearch = typeof savedSearches.$inferSelect
export type NewSavedSearch = typeof savedSearches.$inferInsert
export type AiUsageLog = typeof aiUsageLogs.$inferSelect
export type NewAiUsageLog = typeof aiUsageLogs.$inferInsert
export type LoginAttempt = typeof loginAttempts.$inferSelect
export type NewLoginAttempt = typeof loginAttempts.$inferInsert
export type AdminAuditLog = typeof adminAuditLog.$inferSelect
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert
export type McpCallLog = typeof mcpCallLogs.$inferSelect
export type NewMcpCallLog = typeof mcpCallLogs.$inferInsert
export type RagQualityLog = typeof ragQualityLogs.$inferSelect
export type NewRagQualityLog = typeof ragQualityLogs.$inferInsert
export type HealthSnapshot = typeof healthSnapshots.$inferSelect
export type NewHealthSnapshot = typeof healthSnapshots.$inferInsert
export type UserQuota = typeof userQuotas.$inferSelect
export type NewUserQuota = typeof userQuotas.$inferInsert
export type AppLog = typeof appLogs.$inferSelect
export type NewAppLog = typeof appLogs.$inferInsert
export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type DecryptionFailure = typeof decryptionFailures.$inferSelect
export type NewDecryptionFailure = typeof decryptionFailures.$inferInsert
export type RetentionPolicy = typeof retentionPolicy.$inferSelect
export type NewRetentionPolicy = typeof retentionPolicy.$inferInsert
