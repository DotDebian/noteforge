# Sprint 4 — Network Effects

**Goal:** Turn the app from "a place to write" into "a place where knowledge connects". Backlinks, attachments, import, and doc-scoped chat all multiply the value of every doc the user has already written.

**Estimated duration:** ~2 weeks.

**Items:** F2, F5, F6, F11

---

## F2 — Backlinks & wiki-style `[[doc]]` linking

**Why:** Notes apps live or die on cross-linking. Embeddings are a fuzzy substitute; explicit links are deterministic, reversible, and surface up to "Mentioned in" panels.

**Scope:**

**Editor side:**
- Extend `SlashCommand` (or add a new suggestion extension) to handle `[[`: pop a picker, fuzzy match doc titles in the current workspace, insert as a Tiptap node `docLink` with attrs `{ docId, title }` rendered as `<a class="doc-link" href="/w/:wsId/d/:docId">title</a>`.
- Renders to markdown as `[Title](/w/:wsId/d/:docId)` via the existing turndown layer (reuse the standard link → markdown rule).
- Display: clickable inside the editor (Ctrl/⌘+click to open without losing focus; bare click stays in editing mode).

**Index side:**
- New `doc_links(source_doc_id, target_doc_id, created_at)` table with composite PK + index on `target_doc_id`.
- Server-side: on document save (PATCH), parse the markdown for internal links (regex on `/w/:wsId/d/:docId` patterns) and reconcile the `doc_links` table for that source (delete + insert).
- Endpoint: `GET /api/documents/:id/backlinks` → list of source docs.

**UI:**
- "Mentioned in" section in the right rail (below TOC, above AI insights) listing backlinks with snippets.

**Files touched:** new Tiptap extension under `components/editor/extensions/`, schema, new endpoint, save endpoint reconciliation, new `<DocumentBacklinks />` component.
**Dependencies:** none, but coexists nicely with F1's command palette (reuse the title-fuzz matcher for the `[[` picker).
**Risks:** rename a doc → existing wiki-links still resolve (they store `docId`, not title). But when serialized to markdown the title is frozen at insertion time; consider re-resolving display title on render. Document the trade-off in code.
**Complexity:** Medium.
**DoD:** Typing `[[` in the editor opens a picker; selecting inserts a working link; the target doc shows the source in its backlinks panel.

---

## F5 — Import (markdown files / folders)

**Why:** Closes the data-portability loop with F4 (export). Lowers the barrier for users with existing notes elsewhere.

**Scope:**
- UI: dropzone overlay on the sidebar when files are dragged from the OS. Accept `.md`, `.markdown`, `.txt`. Accept folder drops (`webkitGetAsEntry`).
- Upload endpoint: `POST /api/import/markdown` — multipart with file paths preserved. Reconstruct folder structure into the target workspace.
- Frontmatter parsing: if a YAML frontmatter exists with `title` / `tags` / `createdAt`, honor it. Otherwise derive title from H1 or filename.
- After import, kick off the analyze pipeline per doc (fire-and-forget, same as today's flow).
- Show a small import summary toast: "Imported 42 docs in 5 folders".

**Files touched:** new `components/ImportDropzone.vue` (mounted from `AppSidebar.vue`), new endpoint `server/api/import/markdown.post.ts`, helpers for frontmatter parsing (`marked`'s tokenizer or a tiny YAML lib).
**Dependencies:** Sprint 3's I7 / I8 — bulk import should respect the analyze rate limit (queue, don't fire-hose).
**Risks:** large imports — stream parse, don't buffer all files in memory. Sanitize filenames. Slugify paths back into folder names. Conflict resolution if a folder with the same name exists (merge vs. create new).
**Complexity:** Medium.
**DoD:** Dragging a folder of 50 `.md` files into the sidebar creates a matching subtree, with H1 titles correctly extracted and analysis queued.

---

## F6 — Image attachments

**Why:** The editor is text-only today. Pasting a screenshot into a meeting note should just work.

**Scope:**

**Storage:**
- Schema: new `attachments(id, workspace_id, doc_id (nullable), filename, mime, byte_size, sha256, created_by, created_at)`.
- On-disk: `data/uploads/<workspaceId>/<sha256_prefix>/<sha256>.<ext>`. Content-addressed = dedupes identical pastes; workspace-scoped path = clean delete on workspace delete.
- Decision point: stay on local disk or pluggable storage (S3-compatible)? Recommend local first, with the storage call abstracted behind `server/utils/storage.ts` so swap is a single-file change later.

**Upload:**
- `POST /api/uploads` — multipart, size cap (10 MB initially), MIME allowlist (PNG, JPG, GIF, WebP, SVG with sanitization). Returns `{ id, url }`.
- Serve via `GET /api/uploads/:id` — authenticated, asserts workspace access, sets `Content-Type` and `Cache-Control: private, max-age=86400`.

**Editor integration:**
- Extend Tiptap with `@tiptap/extension-image` (or a custom node) that takes a URL attr.
- Paste/drop handler in `DocumentEditor.vue` `editorProps.handlePaste` / `handleDrop`: if image, upload first, then insert the node with the returned URL.
- Markdown round-trip: turndown rule maps the image node → `![alt](/api/uploads/:id)`.

**Files touched:** schema, new endpoints, `server/utils/storage.ts`, `DocumentEditor.vue`, new extension under `components/editor/extensions/`.
**Dependencies:** none.
**Risks:** SVG XSS — either disallow SVG or sanitize through DOMPurify before serving. Auth must run on every upload fetch (private docs leak otherwise). Set `Content-Disposition: inline` only for images; force `attachment` for anything else.
**Complexity:** Medium.
**DoD:** Pasting a screenshot into the editor uploads it, embeds it, persists across reload. Trying to upload a 20 MB file or a script-bearing SVG is rejected.

---

## F11 — Doc-scoped chat

**Why:** Users with long docs want to chat *with that doc* — lower latency than workspace scope, higher precision. Schema and code already support folder-scope; doc-scope is a parallel addition.

**Scope:**
- Schema: extend `chat_sessions.scope_folder_id` semantics OR add `scope_doc_id` (cleaner). Recommend the latter — clear which scope is active.
- Update `chat.post.ts`:
  - If `scopeDocId` is set, retrieval only considers chunks where `docId = scopeDocId`.
  - Skip the per-doc cap (it's irrelevant for single-doc scope).
- UI: a small "Ask this doc" button next to the title in the doc header. Opens the chat drawer with `scopeDocId` set. The drawer's scope dropdown shows the doc title pinned at the top.
- The chat store's `setWorkspace` becomes `setScope({ workspaceId, folderId?, docId? })`.

**Files touched:** schema + migration, `stores/chat.ts`, `components/chat/ChatDrawer.vue`, `server/api/ai/chat.post.ts`, `pages/w/[workspaceId]/d/[docId].vue` (button in the header).
**Dependencies:** none, but I1 (sqlite-vec) makes the retrieval cleaner via a single-doc WHERE filter.
**Risks:** session history — a doc-scoped session shouldn't be globally listed under the workspace. Filter `loadSessions` accordingly. Renaming a doc shouldn't break a session pinned to it; rely on docId only.
**Complexity:** Low.
**DoD:** "Ask this doc" opens chat scoped to the open doc; switching scope inside the drawer works; deleting the doc gracefully transitions the session to workspace scope (with a banner).

---

## Sprint-level DoD

- Wiki-links work in both directions (forward + backlink), survive renames, and survive markdown round-trip.
- Import accepts a real-world Obsidian / Bear / Notion-exported markdown folder.
- Attachments work for paste and drop, are workspace-scoped on disk, and require auth to read.
- Doc-scoped chat is reachable from any doc in one click.
- New tests: backlink reconciliation, attachment MIME allowlist, import frontmatter parse.

## Out of scope

- Real-time collaboration on a doc with multiple users (would require Yjs or similar — out of scope for the whole roadmap until requested).
- Non-image attachments (PDFs, etc.) — separate scope discussion; today's editor doesn't render them inline.
- "Unlinked mentions" detection (find places where a doc title appears as plain text and offer to convert to a link) — a Sprint 5+ nicety.
- Cross-workspace links — explicitly not supported (workspaces are an isolation boundary).
