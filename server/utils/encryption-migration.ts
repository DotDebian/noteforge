/**
 * One-shot migration that encrypts a legacy user's data at first login.
 *
 * Triggered from `login.post.ts` when the bcrypt verification succeeds but
 * `users.encryptionEnabled = 0`. The user typed their password this turn,
 * so we can derive the KDK and generate the per-user wrapping artefacts
 * on the fly.
 *
 * After this completes:
 *   - users row carries `kdfSalt`, `wrappedDek`, `recoveryWrappedDek`,
 *     `recoveryKeyHash`, `encryptionEnabled = true`
 *   - all rows owned by the user that contain user-authored content are
 *     replaced with their ciphertext form (`enc:v1:` envelope)
 *   - the clear recovery key is returned exactly once and surfaced to the
 *     login UI so the user can save it.
 *
 * Everything happens inside a single transaction so a crash mid-migration
 * leaves the user unchanged (and they can retry next login).
 */
import { eq, inArray } from 'drizzle-orm'
import { getRawDb, useDb } from '~/server/database/client'
import {
  chatMessages,
  chatSessions,
  docAnalyses,
  docChunks,
  documentVersions,
  documents,
  folders,
  users,
  workspaces,
} from '~/server/database/schema'
import {
  deriveKdk,
  deriveRecoveryWrapKey,
  encryptField,
  generateDek,
  generateRecoveryKey,
  generateSalt,
  generateUserKeyPair,
  hashRecoveryKey,
  isEncrypted,
  wrap,
} from './crypto'

export interface MigrationResult {
  /** Buffer holding the freshly-generated DEK — caller must put this in the session. */
  dek: Buffer
  /** Clear recovery key to surface to the user exactly once. */
  recoveryKey: string
}

/**
 * Run the encryption migration for `userId`. Assumes the password has
 * already been verified — this function does NOT re-check.
 */
export async function migrateUserToEncrypted(
  userId: number,
  password: string,
): Promise<MigrationResult> {
  const db = useDb()

  /* ---- 1. Generate per-user crypto material ----------------------------- */
  const kdfSalt = generateSalt()
  const kdk = deriveKdk(password, kdfSalt)
  const dek = generateDek()
  const wrappedDek = wrap(dek, kdk)
  const recovery = generateRecoveryKey()
  const recoveryWrapKey = deriveRecoveryWrapKey(recovery.normalised, kdfSalt)
  const recoveryWrappedDek = wrap(dek, recoveryWrapKey)
  const recoveryKeyHash = hashRecoveryKey(recovery.normalised)

  const keypair = generateUserKeyPair()
  const wrappedPrivateKey = wrap(keypair.privateKey, dek)

  /* ---- 2. Pull every row that needs rewriting --------------------------- */
  const ownedWorkspaces = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId))
  const workspaceIds = ownedWorkspaces.map(w => w.id)

  const ownedFolders = workspaceIds.length > 0
    ? await db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .where(inArray(folders.workspaceId, workspaceIds))
    : []

  const ownedDocs = workspaceIds.length > 0
    ? await db
      .select({
        id: documents.id,
        title: documents.title,
        markdown: documents.markdown,
        contentJson: documents.contentJson,
      })
      .from(documents)
      .where(inArray(documents.workspaceId, workspaceIds))
    : []
  const docIds = ownedDocs.map(d => d.id)

  const ownedAnalyses = docIds.length > 0
    ? await db
      .select({
        docId: docAnalyses.docId,
        summaryShort: docAnalyses.summaryShort,
        summaryLong: docAnalyses.summaryLong,
        useCases: docAnalyses.useCases,
        tags: docAnalyses.tags,
        questions: docAnalyses.questions,
        actionItems: docAnalyses.actionItems,
      })
      .from(docAnalyses)
      .where(inArray(docAnalyses.docId, docIds))
    : []

  const ownedChunks = docIds.length > 0
    ? await db
      .select({ id: docChunks.id, text: docChunks.text })
      .from(docChunks)
      .where(inArray(docChunks.docId, docIds))
    : []

  const ownedVersions = docIds.length > 0
    ? await db
      .select({
        id: documentVersions.id,
        title: documentVersions.title,
        markdown: documentVersions.markdown,
        contentJson: documentVersions.contentJson,
      })
      .from(documentVersions)
      .where(inArray(documentVersions.docId, docIds))
    : []

  const ownedChatSessions = workspaceIds.length > 0
    ? await db
      .select({ id: chatSessions.id, title: chatSessions.title })
      .from(chatSessions)
      .where(inArray(chatSessions.workspaceId, workspaceIds))
    : []
  const chatSessionIds = ownedChatSessions.map(s => s.id)

  const ownedChatMessages = chatSessionIds.length > 0
    ? await db
      .select({
        id: chatMessages.id,
        content: chatMessages.content,
        sources: chatMessages.sources,
      })
      .from(chatMessages)
      .where(inArray(chatMessages.sessionId, chatSessionIds))
    : []

  /* ---- 3. Rewrite atomically ------------------------------------------- */
  const sqlite = getRawDb()
  const tx = sqlite.transaction(() => {
    const updWorkspace = sqlite.prepare('UPDATE workspaces SET name = ? WHERE id = ?')
    for (const w of ownedWorkspaces) {
      if (isEncrypted(w.name)) continue
      updWorkspace.run(encryptField(w.name, dek), w.id)
    }

    const updFolder = sqlite.prepare('UPDATE folders SET name = ? WHERE id = ?')
    for (const f of ownedFolders) {
      if (isEncrypted(f.name)) continue
      updFolder.run(encryptField(f.name, dek), f.id)
    }

    const updDoc = sqlite.prepare(
      'UPDATE documents SET title = ?, markdown = ?, content_json = ? WHERE id = ?',
    )
    for (const d of ownedDocs) {
      updDoc.run(
        isEncrypted(d.title) ? d.title : encryptField(d.title, dek),
        isEncrypted(d.markdown) ? d.markdown : encryptField(d.markdown, dek),
        isEncrypted(d.contentJson) ? d.contentJson : encryptField(d.contentJson, dek),
        d.id,
      )
    }

    const updAnalysis = sqlite.prepare(
      `UPDATE doc_analyses SET
         summary_short = ?,
         summary_long  = ?,
         use_cases     = ?,
         tags          = ?,
         questions     = ?,
         action_items  = ?
       WHERE doc_id = ?`,
    )
    const encStrList = (arr: string[]): string => JSON.stringify(
      arr.map(s => (isEncrypted(s) ? s : encryptField(s, dek))),
    )
    const encActionItems = (arr: { text: string, done: boolean }[]): string => JSON.stringify(
      arr.map(it => ({
        text: isEncrypted(it.text) ? it.text : encryptField(it.text, dek),
        done: it.done,
      })),
    )
    for (const a of ownedAnalyses) {
      updAnalysis.run(
        isEncrypted(a.summaryShort) ? a.summaryShort : encryptField(a.summaryShort, dek),
        isEncrypted(a.summaryLong) ? a.summaryLong : encryptField(a.summaryLong, dek),
        encStrList(a.useCases ?? []),
        encStrList(a.tags ?? []),
        encStrList(a.questions ?? []),
        encActionItems(a.actionItems ?? []),
        a.docId,
      )
    }

    const updChunk = sqlite.prepare('UPDATE doc_chunks SET text = ? WHERE id = ?')
    for (const c of ownedChunks) {
      if (isEncrypted(c.text)) continue
      updChunk.run(encryptField(c.text, dek), c.id)
    }
    // doc_chunks_fts stays UNENCRYPTED — it holds the plaintext tokens
    // BM25 needs. Same for embeddings (vec0). Documented in CLAUDE.md.

    const updVersion = sqlite.prepare(
      'UPDATE document_versions SET title = ?, markdown = ?, content_json = ? WHERE id = ?',
    )
    for (const v of ownedVersions) {
      updVersion.run(
        isEncrypted(v.title) ? v.title : encryptField(v.title, dek),
        isEncrypted(v.markdown) ? v.markdown : encryptField(v.markdown, dek),
        isEncrypted(v.contentJson) ? v.contentJson : encryptField(v.contentJson, dek),
        v.id,
      )
    }

    const updChatSession = sqlite.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?')
    for (const s of ownedChatSessions) {
      if (isEncrypted(s.title)) continue
      updChatSession.run(encryptField(s.title, dek), s.id)
    }

    const updChatMessage = sqlite.prepare(
      'UPDATE chat_messages SET content = ?, sources = ? WHERE id = ?',
    )
    const encChatSources = (
      sources: { docId: number, chunkIdx: number, snippet: string, highlight?: string, citation?: number }[],
    ): string => JSON.stringify(
      sources.map(s => ({
        ...s,
        snippet: isEncrypted(s.snippet) ? s.snippet : encryptField(s.snippet, dek),
        ...(s.highlight !== undefined
          ? { highlight: isEncrypted(s.highlight) ? s.highlight : encryptField(s.highlight, dek) }
          : {}),
      })),
    )
    for (const m of ownedChatMessages) {
      updChatMessage.run(
        isEncrypted(m.content) ? m.content : encryptField(m.content, dek),
        encChatSources(m.sources ?? []),
        m.id,
      )
    }

    /* ---- Finalise on the users row ------------------------------------- */
    sqlite.prepare(
      `UPDATE users SET
         kdf_salt = ?,
         wrapped_dek = ?,
         recovery_wrapped_dek = ?,
         recovery_key_hash = ?,
         encryption_enabled = 1,
         public_key = ?,
         wrapped_private_key = ?
       WHERE id = ?`,
    ).run(kdfSalt, wrappedDek, recoveryWrappedDek, recoveryKeyHash, keypair.publicKey, wrappedPrivateKey, userId)
  })

  tx()

  return { dek, recoveryKey: recovery.display }
}
