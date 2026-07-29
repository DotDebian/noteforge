# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NoteForge is a Nuxt 3 + SQLite + Mistral notes app: workspaces → recursive folders → markdown documents with WYSIWYG editing, per-document AI analysis, and a workspace-scoped chat RAG.

## Commands

```bash
pnpm install            # installs + runs `nuxt prepare` (needed before typecheck)
pnpm dev                # http://localhost:3000
pnpm build / preview    # production build + run
pnpm typecheck          # vue-tsc strict (use after edits; CI signal)
pnpm db:generate        # regenerate SQL migrations from server/database/schema.ts
pnpm db:migrate         # apply migrations to data/noteforge.db
pnpm db:studio          # Drizzle Studio
```

Quality gates: `pnpm typecheck` (vue-tsc strict) and `pnpm test` (vitest — covers chunking, vector ops, best-sentence, citations, editor markdown, unified-diff patching). Run both after non-trivial changes.

⚠️ **Local `data/noteforge.db` is an empty dev scaffold — real data lives on a remote prod VPS** (Docker, `DATABASE_URL=/app/data/noteforge.db` in the container). Inspecting the local SQLite file will show 0 rows for every table, so it does NOT reflect what the user sees in screenshots. Don't validate data-shape assumptions against the local DB; reason from the schema/code, or ask the user to run a query on the VPS. Note also that user content columns are encrypted at rest under the per-user DEK — only embeddings (`summary_embedding`, `embedding_blob`) and the FTS5 mirror are cleartext, so even a prod DB dump can't be read for titles/tags/text without the user's key.

`.env` requires `MISTRAL_API_KEY` and `NUXT_SESSION_PASSWORD` (≥ 32 chars). `pnpm-workspace.yaml` whitelists native builds (`better-sqlite3`, `esbuild`, `@parcel/watcher`) — required by pnpm 9+. Native compile is avoided by pinning `better-sqlite3 ^12.10.0` which ships Node 24 prebuilts.

**Restart vs HMR**: `tailwind.config.ts` and `nuxt.config.ts` changes need a dev server restart. Pinia stores hot-reload because every store calls `acceptHMRUpdate(useFooStore, import.meta.hot)` at the bottom — keep that hook when adding new stores.

## Component auto-import

`nuxt.config.ts` sets `components: [{ path: '~/components', pathPrefix: false }]`. Files in `components/sidebar/`, `components/editor/`, `components/chat/` register under their bare filename — `<NewItemMenu>`, `<DocumentEditor>`, `<ChatDrawer>`, NOT `<SidebarNewItemMenu>` etc. The recursive `FolderTreeNode` calls itself by its bare name; don't reintroduce folder prefixes.

## Architecture

### Data model (`server/database/schema.ts`)

- `users / workspaces / folders / documents` — folder parent is self-referential and has **no FK on `parentId`** (cascade deletes are done manually in `folders/[id].delete.ts`, which also reparents orphan docs to `folderId = null`).
- `doc_analyses` — 1:1 with documents; Mistral JSON-mode output (summary short/long, useCases, tags, questions, actionItems, language).
- `doc_chunks` — embedded chunk text. `embedding` is JSON-encoded `number[]` (legacy); `embedding_blob` is the preferred Float32-LE buffer. Retrieval uses `sqlite-vec`'s `MATCH` operator via `retrieveViaVec0` in [server/utils/search.ts](server/utils/search.ts) when `isVecAvailable()`, with JS-cosine (`retrieveViaJsCosine`) as fallback. Each chunk is also mirrored into `doc_chunks_fts` (FTS5, unicode61 tokenizer + accent folding) so BM25 sits alongside cosine in the hybrid retrieval — see "AI flow" below.
- `chat_sessions / chat_messages` — `sources` JSON column was extended via Drizzle `$type` only (no schema migration) to include optional `highlight` (the sentence within the chunk that supports the answer) and `citation` (the original `[#N]` number).

### Auth

`nuxt-auth-utils` auto-imports a scrypt-based `hashPassword` / `verifyPassword` into the Nitro context. To avoid collision, our bcrypt helpers in `server/utils/auth.ts` are named **`bcryptHashPassword` / `bcryptVerifyPassword`** (used by `register.post.ts` / `login.post.ts`). Don't rename them back. `User` type is widened in `types/auth.d.ts` to include optional `displayName`.

Every endpoint goes through `requireUser(event)` then `assertWorkspaceAccess / assertFolderAccess / assertDocumentAccess` from `server/utils/access.ts`. `parseIdParam(event)` validates router params as positive integers.

### At-rest encryption (per-user DEK)

User-authored content (titles, markdown, contentJson, chunk text, analyses, chat content/sources, document version snapshots) is encrypted at rest under a per-user **Data Encryption Key (DEK)**. The threat model is "stolen `data/noteforge.db`": notes are unreadable without the user's password OR recovery key. A live server compromise is NOT covered (the DEK lives in memory during sessions), and Mistral still sees plaintext (analyze/embed/chat). Embeddings (`embedding_blob`, `summary_embedding`) and FTS5 (`doc_chunks_fts`) stay **unencrypted** — vec0 and BM25 need cleartext to be useful; this leaks topical / token-level fingerprints but not raw chunk bodies.

Key files:
- [server/utils/crypto.ts](server/utils/crypto.ts) — scrypt KDK, AES-256-GCM wrap/unwrap, recovery-key generation + normaliser, field-level envelope `enc:v1:<base64url(iv||tag||ct)>`. `encryptField/decryptField` are idempotent and self-detecting (plaintext flows through `decryptField` unchanged), so reads stay safe during the migration window.
- [server/utils/encrypted-entities.ts](server/utils/encrypted-entities.ts) — entity-level encrypt/decrypt helpers (documents, folders, workspaces, analyses, chunks, chat sessions/messages). JSON-mode columns (`sources`, `useCases`, `tags`, ...) are encrypted **per-string-inside** so Drizzle's stringify/parse contract still works — never write an opaque envelope into a `mode: 'json'` column directly.
- [server/utils/dek.ts](server/utils/dek.ts) — `getDek(event)` lifts the DEK Buffer from the encrypted `nuxt-auth-utils` session and caches it on `event.context`. REST endpoints call `getDek(event)` and pass it through to service functions. MCP requests get the DEK from the token row via `requireMcpUser(event)` (returns `{ user, dek }`).
- [server/utils/encryption-migration.ts](server/utils/encryption-migration.ts) — one-shot legacy-user migration that runs the first time an existing user logs in after the rollout. Wrapped in a single sqlite transaction; aborts cleanly on failure.

Auth flows that touch crypto material:
- `register.post.ts` — generates `kdfSalt`, DEK, recovery key; double-wraps DEK (password + recovery); returns the clear recovery key **once**.
- `login.post.ts` — derives KDK from typed password, unwraps DEK, parks it on the session. Migrates legacy users on the fly and surfaces a fresh recovery key in the response.
- `recover.post.ts` — accepts `{ email, recoveryKey, newPassword }`. Verifies the recovery key by `hashRecoveryKey`, unwraps DEK via the recovery wrap key, re-wraps under a new KDK, rotates the recovery key.
- `password.post.ts` — verifies current password, re-wraps DEK under a fresh KDK, rotates recovery key.
- MCP tokens — at creation, the DEK is also wrapped under a key derived from the bearer (HKDF) and stored on `mcp_tokens.wrapped_dek`. `requireMcpUser` unwraps it per-request.

⚠️ **Adding a new endpoint that reads/writes user content**: call `getDek(event)` and pass it through to `notes.ts` / `encrypted-entities.ts` helpers. Encrypted titles can't be filtered by SQL `=` / `LIKE` (fresh IV → different ciphertext) — fetch + decrypt + JS-filter when you need to query by title (see `findOrCreateDailyNote`, `tags.get.ts`). FTS5 indexing in `embed-doc.ts` always gets PLAINTEXT into `doc_chunks_fts`, even when `doc_chunks.text` is ciphertext.

### API response envelopes

Backend wraps single entities and lists:

| Endpoint | Response shape |
|----------|----------------|
| `GET /api/workspaces` | `{ workspaces: Workspace[] }` |
| `POST /api/workspaces`, `PATCH /api/workspaces/:id` | `{ workspace }` |
| `GET /api/workspaces/:id` | `{ workspace, folders, counts }` (no `documents` — fetch separately) |
| `GET /api/documents?workspaceId=…` | `{ documents }` (lightweight — no markdown/contentJson) |
| `GET /api/documents/:id` | `{ document, analysis }` |
| `POST /api/folders`, `PATCH /api/folders/:id` | `{ folder }` |
| `POST /api/documents`, `PATCH /api/documents/:id` | `{ document }` |
| `GET /api/ai/related/:docId` | `RelatedHit[]` (raw array — exception) |

Pinia stores unwrap the envelope, so when adding endpoints keep them consistent.

`PATCH /api/documents/:id` accepts `contentJson` as a **string** (TEXT column). `useDocumentSaver` `JSON.stringify`s the object before sending.

### Editor (Tiptap)

`components/editor/DocumentEditor.vue` is the entrypoint. Round-trip:
- Load: `markdownToHtml(doc.markdown)` via `marked` → `setContent`
- Save: `editor.getHTML()` → `htmlToMarkdown` via `turndown` (configured in `composables/useEditorMarkdown.ts` with custom rules for task lists `[ ]/[x]` and `~~strike~~`)

Autosave is `useDocumentSaver(docId, 500ms)` — debounced PATCH, merges title + markdown + contentJson in one request. Title changes emit `update:title` so the page page can update the sidebar / crumbs / `<title>` instantly without waiting for a refetch.

**Paste handler** in `editorProps.handlePaste`: if clipboard has `text/html`, Tiptap handles it natively. If plain-text only AND `looksLikeMarkdown(text)`, run through `markdownToHtml` and insert as HTML. Plain prose pastes literally. Code blocks always paste literally.

**Editor scroll layout**: the scroll container is `<EditorContent class="editor-scroll …">` itself (the centered text column), NOT the outer wrapper — so the scrollbar sits at the edge of the writing area. The outer flex wrapper is `overflow-hidden`. `.editor-scroll` is defined globally in `main.css`. Don't refactor the wrapper to scroll itself or the scrollbar jumps to the rail edge.

### AI flow

- `mistralChat` / `mistralChatStream` / `mistralEmbed` in `server/utils/mistral.ts` (raw fetch, no SDK). `mistralChatStream` is an async generator over SSE deltas.
- `analyze/[docId].post.ts`: one JSON-mode call returns the analysis schema, upserts `doc_analyses` via `onConflictDoUpdate`, then kicks off `embedDocument(docId)` fire-and-forget (chunks via `server/utils/chunking.ts` → batched `mistralEmbed` → bulk insert into `doc_chunks`).
- `chat.post.ts` — full RAG pipeline:
  1. **Query rewriting** ([server/utils/query-rewrite.ts](server/utils/query-rewrite.ts)) — when there's prior history, a `mistral-small-latest` JSON call rewrites the user's message into a standalone retrieval query that resolves pronouns/anaphora ("et le second point ?" → "le deuxième point sur X"). Failures fall back to the original message. The original message is what the chat model still sees; only retrieval embeds the rewrite.
  2. **Hybrid first-stage retrieval** ([server/utils/search.ts](server/utils/search.ts) `rankChunks` with `queryText`) — runs vec0 cosine (top-30, no MIN_SCORE in hybrid mode) AND FTS5 BM25 (top-30) in parallel, fuses via Reciprocal Rank Fusion (`k = 60`), oversampled to `RERANK_POOL = 18`.
  3. **LLM reranker** ([server/utils/rerank.ts](server/utils/rerank.ts)) — `mistral-small-latest` JSON call scores each pool candidate 0-10 against the query; combined with the prior retrieval score (`LLM_WEIGHT = 0.7`). Failures pass the pool through unchanged.
  4. Apply per-doc cap (`= 2`, skipped in doc-scope) and trim to `SEARCH_TOP_K = 6`. Build `CONTEXT` block, stream Mistral SSE deltas as `data: {type:'delta',text}` frames.
  5. **After streaming**: parse citations from the answer with `extractCitations` (handles `[#1]`, `[#1, #2]`, `[#1,2,3]`, `[#1; #5]`, `[#1 #2]`), filter sources to only those actually cited, and compute `highlight` per source via `bestSentence(chunk, answer)` (token-overlap normalised by √sentence-length).
  6. Emit `data: {type:'done', sources}` with the refined list AND persist that refined list to `chat_messages.sources`. The early `sources` frame is intentionally NOT emitted — only cited sources reach the client.
- `related/[docId].get.ts` — doc-to-doc similarity. Path A: cosine over `doc_analyses.summary_embedding` (preferred). Path B fallback: max-of-chunks cosine. On top of cosine, adds Jaccard tag overlap (× `TAG_WEIGHT = 0.15`) and a flat `LINK_BONUS = 0.1` for explicit `doc_links` in either direction.
- `searchWorkspaceChunks` (MCP `search_notes`) shares the same hybrid pipeline and additionally runs the reranker before returning, since MCP callers don't generate text themselves.

### Citation jump in editor

When a chat source chip is clicked, `ChatDrawer.openSource` queues `{ docId, target }` in the chat store (`target` = source's `highlight` if available, else `snippet`) and closes the drawer. The router navigates. `DocumentEditor.onCreate` (and a `watch(pendingCitation, …)` for already-mounted editors) calls `chatStore.consumePendingCitation(docId)` and runs `jumpToCitation`:

1. `normalizeForSearch` strips markdown markers anywhere in the string (server collapses chunks to one line, so anchored-to-`^` regexes won't fire — markers are matched with `(^|[\s.,;:!?])` prefix instead). Also strips trailing `…` decoration from `truncate()`.
2. `findRange` walks `editor.state.doc.descendants` and builds a flat text buffer with a **synthetic space separator** between block transitions (so `<li>X</li><li>Y</li>` → `"X Y"`, not `"XY"`). A parallel `charPos[]` maps each buffer char to an editor position (`-1` for separators).
3. After `indexOf`, set `to` by walking **`needle.length` buffer slots** (not by counting real chars — that walked past the needle and selected too much).
4. `editor.chain().focus().setTextSelection(range).scrollIntoView().run()` THEN a `requestAnimationFrame` doing a manual `element.scrollIntoView({behavior:'smooth', block:'center'})` on `view.domAtPos(range.from).node`. Tiptap's `.scrollIntoView()` alone only scrolls the ProseMirror viewport, not the `.editor-scroll` ancestor.

Native browser `::selection` (orange — set in `main.css`) is the visual highlight; no custom mark is applied.

### MCP server

NoteForge exposes its notes to external MCP clients (Claude Desktop and friends) at **`POST /api/mcp`** (also accepts GET / DELETE for the streaming + session-close paths the transport supports). The implementation lives in [server/api/mcp/index.ts](server/api/mcp/index.ts) and uses `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport` in **stateless mode** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`).

**Auth**: every request must carry `Authorization: Bearer …`, and `requireMcpUser` accepts **two credential families**, dispatched on prefix — `nf_…` (static token, below) and `nfat_…` (OAuth access token, see "OAuth custom connectors"). Both resolve to the same `{ user, dek, tokenId }` shape; `tokenId` is `null` for OAuth callers because `mcp_call_logs.token_id` FKs `mcp_tokens` (the log still carries `userId`, which is what the admin MCP panel groups by). A 401 from any path sets `WWW-Authenticate: Bearer resource_metadata="…"` — that header is how an OAuth client bootstraps discovery.

Tokens live in the `mcp_tokens` table (id, userId FK→users.id ON DELETE CASCADE, name, **tokenHash** (SHA-256 hex, UNIQUE INDEX), **prefix** (first 11 chars — display only), lastUsedAt, createdAt, revokedAt). Generation + lookup helpers in [server/utils/mcpAuth.ts](server/utils/mcpAuth.ts):
- `generateMcpToken()` → `nf_` + 32 random bytes base64url, shown once at creation
- `hashMcpToken(token)` → SHA-256 hex (deterministic so the UNIQUE INDEX gives an O(1) lookup — no bcrypt, the token entropy is already 256 bits)
- `requireMcpUser(event)` → validates the bearer, fire-and-forgets `lastUsedAt`, throws 401 on miss/revoke

Token CRUD endpoints (session-authenticated, called by the front):
- `GET /api/mcp/tokens` → `{ tokens: [{id, name, prefix, lastUsedAt, createdAt}] }` (never the hash)
- `POST /api/mcp/tokens` (body `{ name? }`) → `{ token, mcpToken }` — clear token shown ONCE
- `DELETE /api/mcp/tokens/:id` → stamps `revokedAt`. Soft delete; audit trail preserved.

**Per-request server**: each HTTP hit builds a fresh `McpServer` with tools that close over the resolved user. No cross-request state, no shared session map. The transport handles its own start/close lifecycle in the request's `finally` block.

**Tools exposed** (see [server/api/mcp/index.ts](server/api/mcp/index.ts) for the wire schemas — all closure over the authenticated user, all scoped to that user's workspaces):
- `get_overview(workspaceId?, includeSummaries?, maxDocsPerWorkspace?)` — one-shot content map (workspaces → folders → doc titles, optional analysis summaries/tags); the round-trip reducer MCP clients should prefer over chaining list calls
- `find_document(query, workspaceId?, workspaceName?, limit?, includeContent?)` — fuzzy accent-insensitive title resolution ([server/utils/title-match.ts](server/utils/title-match.ts)); `includeContent` embeds the best match's full markdown + analysis; a `workspaceName` miss returns the available names so the client self-corrects without a list call
- `list_workspaces` / `get_workspace(workspaceId)`
- `list_documents(workspaceId, folderId?)` / `read_document(documentId)` — read tools pass `{ includeTrashed: false }` so trashed docs raise 404 over MCP, even though the REST `GET /api/documents/:id` returns them (trash UI needs them). `read_document` also returns the wiki-link neighbourhood (`links.outgoing` / `links.backlinks`)
- `create_document` / `update_document` / `delete_document` (soft)
- `append_to_document(documentId, markdown)` — append without read-merge-rewrite; reuses `updateUserDocument` so snapshots + doc-link reconcile still run
- `patch_document(documentId, patch, dryRun?)` — edit the MIDDLE of a doc with a git-style unified diff instead of re-emitting the whole body (the whole point: token cost on long notes). Engine is [server/utils/patch.ts](server/utils/patch.ts) — pure module, no `h3`/db, so `tests/patch.test.ts` can import it (same split rationale as `oauth-policy.ts`). **Hunks are located by content, not by line number**: exact match → whitespace-insensitive → fuzz (trim up to 3 shared context lines per side), nearest occurrence to the declared `@@` position wins, and a cursor forbids a later hunk from matching above an earlier one. All-or-nothing: a miss throws 422 whose `message` carries the expected block + the real document window (and detects "already applied"), so the caller retries without re-reading. Response returns document **metadata only** (`toMcpDocumentMeta` also strips `markdown`) — echoing the patched body back would undo the saving. Parser leniencies (fenced patch, `diff --git` preamble, unprefixed context lines, trailing-newline trim) are reported in `warnings`
- `get_daily_note(workspaceId, date?, appendMarkdown?)` — find-or-create the `YYYY-MM-DD` journal note (date defaults to server-today), optional same-call append
- `create_folder` / `update_folder` / `delete_folder` (soft — cascades the whole subtree with a shared `deletedAt` timestamp)
- `search_notes(workspaceId?, query)` — hybrid (vec + FTS5 BM25 + RRF) + Mistral reranker, top-6 with max 2/doc (same shared primitives as chat RAG, but reranked end-to-end since MCP returns results directly). `workspaceId` omitted = cross-workspace: one embed + one rerank total via `searchChunkGroups` (one group per workspace key)
- `list_tags(workspaceId)` — analysis-tag aggregate (shared with `GET /api/workspaces/:id/tags` via `listUserWorkspaceTags`)
- `analyze_document(documentId)` — runs the Mistral JSON analysis + fire-and-forget re-embed

⚠️ **MCP responses are LLM context**: tool handlers strip `contentJson` (Tiptap mirror of markdown) and `summaryEmbedding` / embed bookkeeping (a serialized Float32 buffer is ~20 KB of JSON numbers) via `toMcpDocument` / `toMcpAnalysis`, and `jsonResult` serializes compact (no indent). Keep new tools on that diet.

⚠️ **MCP + shared workspaces**: the bearer-unwrapped DEK only decrypts solo (`'dek'`) workspaces. Every tool touching content resolves the real key through `keyForWorkspace` / `keyForDocument` / `keyForFolder` (per-request cached, backed by `getWorkspaceKeyForUserById`). Multi-workspace sweeps in `notes.ts` (`getUserOverview`, `findUserDocuments`, `searchUserNotes`) resolve per-workspace keys internally and degrade a failed WEK unwrap to `null` instead of failing the sweep.

**Shared service layer**: [server/utils/notes.ts](server/utils/notes.ts) is the single source of truth for these operations. REST endpoints in `server/api/{workspaces,documents,folders,ai/analyze}` delegate to it; MCP tools call it directly. Retrieval (chat + `search_notes`) shares [server/utils/search.ts](server/utils/search.ts) (`rankChunks`, `searchWorkspaceChunks`) so tuning a constant takes effect in both. Ownership checks use the **`assert*Ownership(userId, …)`** variants from [server/utils/access.ts](server/utils/access.ts) (the H3-event `assert*Access` wrappers still exist and resolve the user via `requireUser` before delegating).

⚠️ **Soft-delete invariant**: every NEW read tool added here MUST hide trashed rows. `notes.ts` list functions apply `activeDocsWhere()` / `activeFoldersWhere()` already; lookup-by-id functions take an `{ includeTrashed }` flag — MCP read tools must pass `false` (REST single-doc fetches pass `true` because the trash UI needs them).

**Frontend install flow**: [components/McpTokensDialog.vue](components/McpTokensDialog.vue) (triggered from a plug-icon button in the sidebar footer next to the theme toggle) has a **mode switch at the top — `bearer` vs `oauth`** — and renders one of two 3-step flows plus the matching credential list. Bearer: generate a token, copy the Claude Desktop config snippet, restart. OAuth: create a connector, copy URL / client ID / client secret, connect from Claude. Both reveal their secret ONCE and revoke via `useDialog().confirm`. Stores: [stores/mcpTokens.ts](stores/mcpTokens.ts) and [stores/mcpConnectors.ts](stores/mcpConnectors.ts), optimistic + rollback like the other stores.

### OAuth custom connectors (claude.ai)

claude.ai's "custom connector" cannot send a custom header, so a static bearer is unusable there — it only speaks OAuth. NoteForge therefore doubles as a **single-tenant OAuth 2.1 authorization server** for its own MCP resource. The user registers a connector in the MCP dialog and pastes **URL + client ID + client secret** into Claude's *Advanced settings*.

- [server/utils/oauth-policy.ts](server/utils/oauth-policy.ts) — the pure half: credential shapes/prefixes, `hashOauthSecret`, `verifyClientSecret`, `verifyPkce` (**S256 only**, `plain` must fail), `isRedirectUriAllowed` (**exact match** on registered URIs + the RFC 8252 loopback carve-out). Split from `oauth.ts` because vitest can't resolve `h3` from the pnpm store — that's what makes `tests/oauth.test.ts` possible. `oauth.ts` re-exports the whole surface, so callers only ever import `~/server/utils/oauth`.
- [server/utils/oauth.ts](server/utils/oauth.ts) — stateful half: client lookup, code issuance, code→token exchange, refresh rotation, access-token resolution, `publicOrigin` / `setOauthCors`.
- Tables: `oauth_clients` (secret stored SHA-256, `redirectUris` JSON, soft-revoked), `oauth_auth_codes` (single-use, 5 min, PKCE challenge, GC'd opportunistically on each issue), `oauth_tokens` (one row per grant; refresh **rotates both tokens in place**, so the previous access token dies immediately). `oauth_tokens.auth_code_id` exists so a replayed code revokes **only the tokens that code produced** — revoking every token the client holds would let one retried request kill a working connector.
- Endpoints: discovery documents are registered explicitly in `nitro.handlers` (nuxt.config.ts) at `/.well-known/oauth-protected-resource[/api/mcp]` and `/.well-known/oauth-authorization-server[/api/mcp]` — **not** via `server/routes/.well-known/`, whose dot-directory the file scanner isn't guaranteed to pick up, and which would otherwise fall through to the SPA and 302 to `/login`. Then `GET|POST /api/oauth/authorize`, `POST /api/oauth/token`, `POST /api/oauth/revoke`, and connector CRUD under `/api/mcp/connectors`.
- `authorization_endpoint` is a **Nuxt page** ([pages/oauth/authorize.vue](pages/oauth/authorize.vue)), not an API route: it needs the session cookie, and the global auth middleware already bounces anonymous visitors through `/login?redirect=…` and back.
- ⚠️ **No dynamic client registration on purpose** — the AS metadata deliberately omits `registration_endpoint`, which is what makes Claude ask for the id/secret instead of self-registering.
- ⚠️ **DEK chain**: the per-user DEK is lifted from the browser session at *consent* time (the only moment a session exists) and re-wrapped under `deriveTokenWrapKey(<clear artefact>)` at each hop: authorization code → access token → rotated access token. That's what lets an MCP call authenticated by a bare OAuth token decrypt content. Any new artefact in that chain MUST carry a wrapped DEK forward or reads silently return ciphertext.
- ⚠️ **Behind the prod reverse proxy** `publicOrigin` relies on `X-Forwarded-Proto` / `X-Forwarded-Host`; the advertised issuer must match the public HTTPS URL or Claude rejects discovery. Set `NOTEFORGE_PUBLIC_URL` to override if the proxy doesn't forward them.

### Frontend chrome

- **Sidebar drag & drop**: HTML5 native. `stores/drag.ts` holds reactive `draggedDocId / sourceFolderId / overTarget` so all components can react. Drop targets are folder rows in `FolderTreeNode` and the `.tree` container in `AppSidebar` (= root). The tree store's `moveDocument(id, folderId)` is optimistic with rollback.
- **Dialogs**: `useDialog()` (`composables/useDialog.ts`) replaces `window.confirm / prompt / alert` — promise-based, themed, dark-mode aware. Backed by `stores/dialog.ts` and rendered once by `<DialogHost />` in `layouts/default.vue`. Don't reintroduce native browser dialogs (with the exception of `<code>`/`<kbd>` style displays that intentionally stay mono — see below).
- **Theme**: `composables/useTheme.ts` wraps `useDark` from VueUse (key `noteforge-theme`, toggles `.dark` on `<html>`). `<ThemeToggle />` lives in the sidebar footer.
- **Markdown rendering for chat**: `composables/useMarkdownView.ts` → `renderMarkdown(md)` runs `marked` then a custom DOMParser-based sanitizer (allowlist tags, strips `on*` attrs, forces `rel="noopener noreferrer" target="_blank"` on links, validates href schemes). Used via `v-html` in `ChatDrawer.msg-md` only for assistant messages.

### Tailwind specifics

- `darkMode: 'class'`. Dark variants are sprinkled in templates and `<style scoped>` blocks (`html.dark .foo { … }`).
- `tailwind.config.ts` exports a small inline plugin (`labelComponents`) that adds **`.label-mono`** and **`.label-mono-strong`** as real Tailwind components. This is required so `@apply label-mono` works inside Vue `<style scoped>` blocks (each scoped block is processed in isolation and can't see classes defined in `main.css`'s `@layer`).
- Despite the name, `.label-mono` uses **Inter sans-serif** uppercase (the design decision was to abandon mono labels — they were illegible at 11px). Real mono content (code blocks, kbd hints, the `< >` toolbar code icon) still uses `font-mono` which resolves to `ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace` (no web font loaded for mono).
- Fonts loaded from Google Fonts in `nuxt.config.ts → app.head.link`: Inter (400/500/600/700) and Source Serif 4 (variable, 400/600/700). Adding new weights requires updating that URL.
- Editor column width is responsive: `max-w-3xl xl:max-w-4xl 2xl:max-w-6xl` applied to title row, toolbar, and `EditorContent` — change all three if you change one.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` enabled. No `any`. Index accesses on arrays return `T | undefined` — guard or assert.
- All API routes validate body / query with `zod` schemas (`readValidatedBody`, `getValidatedQuery`).
- Server returns errors via `createError({ statusCode, statusMessage })`.
- Don't commit changes to `.env` (gitignored) or to `data/*.db` (also gitignored).

## Known thin spots

- Chunking is section-aware ([server/utils/chunking.ts](server/utils/chunking.ts), 1500/150 chars greedy with sentence-overlap), but a chunk emitted from an oversized paragraph hard-window can still start mid-word — that's why `jumpToCitation` has a `skipFirstWord` fallback path.
- RAG auxiliary calls (rewriter + reranker) each cost one `mistral-small-latest` round-trip per chat turn. Both are failure-soft: a 5xx or parse error falls back to the previous stage's output instead of bubbling up. Watch the Mistral health panel if quality drops — silent failures degrade retrieval without surfacing an error.
- FTS5 sync lives in [server/utils/embed-doc.ts](server/utils/embed-doc.ts) — every chunk write mirrors to `doc_chunks_fts` (rowid = `doc_chunks.id`). If you add a new write path that touches `doc_chunks`, mirror it there too or hybrid retrieval silently misses those rows.
- Docker scaffold (`Dockerfile`, `docker-compose.yml`) exists but hasn't been used — see README roadmap.
