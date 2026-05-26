# Sprint 1 — Foundation & Quick Wins

**Goal:** Close obvious safety + ergonomics gaps before building anything ambitious. Every later sprint depends on a test scaffold, a way to undo destructive actions, and an export path that proves the data isn't trapped.

**Estimated duration:** ~1 week of focused work.

**Items:** I3, I6, F3, F4, I12, F12

---

## I3 — Action-item completion toggle

**Why:** `doc_analyses.actionItems` is already modeled as `{ text: string, done: boolean }[]` ([server/database/schema.ts:92](server/database/schema.ts:92)). `done` is dead today — analysis writes it but no UI mutates it. Cheapest user-visible win in the codebase.

**Scope:**
- `DocumentInsightsPanel` renders a checkbox per action item bound to `done`.
- New endpoint `PATCH /api/ai/analyze/:docId/action-items` (or extend the existing analyze endpoint with a body shape that only updates `actionItems`) — accept a full replacement array.
- Optimistic update in the panel; revert on error.

**Files touched:** `components/DocumentInsightsPanel.vue`, `server/api/ai/analyze/[docId].post.ts` (or a new sibling), maybe a thin store/composable for analysis state.

**Dependencies:** none.
**Risks:** none material. Watch for concurrent re-analysis overwriting user toggles — server-side merge should preserve existing `done` flags when text matches.
**Complexity:** Low.
**DoD:** Checking a box persists across reload; re-running analysis doesn't lose ticks for unchanged items.

---

## I6 — Auto-title chat sessions

**Why:** `chat_sessions.title` defaults to "New chat" and never updates, so the session list is unusable past 3 sessions.

**Scope:**
- After the first user message in a session, derive a title: take the first 6–10 words of the user message, trim punctuation, capitalize.
- Persist via `UPDATE chat_sessions SET title = ?` once, server-side, inside the existing chat handler.
- Optional v2: a cheap one-shot Mistral call ("Summarize this question in 4 words") — guard behind a feature flag if model cost matters.

**Files touched:** `server/api/ai/chat.post.ts`, possibly `stores/chat.ts` for live update of the sidebar list.
**Dependencies:** none.
**Risks:** trivial. Make sure the title isn't overwritten on subsequent messages.
**Complexity:** Low.
**DoD:** New sessions show a meaningful title within 1s of the first answer streaming.

---

## F3 — Trash / soft delete

**Why:** Every delete is permanent today, and folder deletes cascade. One misclick wipes a workspace's subtree. This is the single biggest trust gap.

**Scope:**
- Schema: add nullable `deleted_at` timestamp on `documents` and `folders`.
- API: change `DELETE /api/documents/:id` and `DELETE /api/folders/:id` to set `deleted_at = now()` instead of `DELETE`. Add `POST /api/documents/:id/restore` and same for folders. Add `GET /api/trash?workspaceId=…`.
- Every query that lists docs/folders adds `WHERE deleted_at IS NULL`.
- New `Trash` view in the sidebar footer (or a workspace-level page) listing soft-deleted items grouped by recency, with Restore and Delete-forever buttons.
- Empty-trash action with a confirm dialog and a retention reminder.
- Decide whether soft-deleting a folder also marks its children as deleted, or leaves them and uses `parentId` traversal to hide them.

**Files touched:** schema + new migration, every list endpoint, sidebar footer, new `pages/w/[workspaceId]/trash.vue`.
**Dependencies:** none.
**Risks:** every list query needs the filter — easy to miss one. Add a small SQL helper or a Drizzle utility (`activeDocuments()`) and use it consistently.
**Complexity:** Low–Medium.
**DoD:** Deleting a doc surfaces an undo toast; the trash view restores it; permanent delete prompts a destructive confirm.

---

## F4 — Export (single doc + workspace zip)

**Why:** Portability and trust. Pairs naturally with F3 (a deleted doc should be downloadable from trash too).

**Scope:**
- Single doc: `GET /api/documents/:id/export` → `Content-Disposition: attachment; filename="<slug>.md"`, body = stored markdown. Include a small YAML frontmatter with title + timestamps.
- Workspace zip: `GET /api/workspaces/:id/export` → streams a `.zip` mirroring the folder tree, `.md` files inside. Use a stream-friendly zip lib (`archiver`).
- UI: Export button in doc header meta + Export item in workspace switcher menu.

**Files touched:** new endpoints, `WorkspaceSwitcher.vue`, doc header in `pages/w/[workspaceId]/d/[docId].vue`.
**Dependencies:** new dep `archiver` (or `jszip` if pure JS preferred — `archiver` streams better).
**Risks:** large workspaces — stream to response, don't buffer. Slugify titles to avoid filesystem-illegal chars; deduplicate name collisions.
**Complexity:** Low.
**DoD:** Workspace with nested folders downloads as a zip whose structure mirrors the sidebar tree.

---

## I12 — Test scaffolding

**Why:** Today `pnpm typecheck` is the only gate. Every refactor in `jumpToCitation`, the citation extractor, or the chunker is a coin toss.

**Scope:**
- Add Vitest with Nuxt's recommended config (`@nuxt/test-utils`).
- Unit tests for the high-leverage pure modules:
  - `server/utils/vector.ts` — cosine, parseEmbedding round-trip.
  - `server/utils/chunking.ts` — chunk count and overlap invariants.
  - `composables/useEditorMarkdown.ts` — markdown ↔ HTML round-trip for the patterns used in the editor (task lists, strike, code, links).
  - Citation extractor inside `server/api/ai/chat.post.ts` (extract `[#1, #2]`, `[#1; #5]`, `[#1 #2]`). May need to extract `extractCitations` to its own file for testability.
  - `bestSentence` scoring in the same file (same refactor).
- Add `pnpm test` to scripts.
- One thin integration test for `/api/workspaces` (register → create workspace → fetch) using better-sqlite3 in-memory.

**Files touched:** new `vitest.config.ts`, new `tests/` directory, minor refactors to extract testable pure functions out of `chat.post.ts`.
**Dependencies:** new dev deps (`vitest`, `@nuxt/test-utils`).
**Risks:** Nuxt 3 + Vitest setup has historically been finicky around imports + auto-imports. Keep server tests focused on the pure utils initially to avoid that.
**Complexity:** Medium.
**DoD:** `pnpm test` runs green in <10s with at least 25 assertions across the listed modules.

---

## F12 — Health endpoint

**Why:** Prerequisite for the Docker rollout the README already commits to. Cheap on its own.

**Scope:**
- `GET /api/health` returns `{ status: 'ok', db: 'ok' | 'down', mistral: 'ok' | 'down', uptimeMs }`.
- DB check: a tiny `SELECT 1` via the shared client.
- Mistral check: don't call the API on every health hit. Cache last successful call timestamp from real traffic and report `ok` if seen in last 5 min; otherwise `unknown`. Avoid burning the rate budget on healthchecks.
- Unauthenticated.

**Files touched:** new `server/api/health.get.ts`, optional middleware to record Mistral success timestamps.
**Dependencies:** none.
**Risks:** none. Make sure the auth middleware allowlists this route.
**Complexity:** Low.
**DoD:** `curl /api/health` returns 200 with valid JSON when running; reports `db: 'down'` if the DB file is unreachable.

---

## Sprint-level DoD

- All six items merged with passing typecheck + tests.
- A migration adds `deleted_at` columns and is committed to `server/database/migrations/`.
- README updated with: `pnpm test`, the trash behavior, and the export route.
- Manual smoke test: register → create doc → delete → restore from trash → export workspace → unzip and verify.

## Out of scope (deferred)

- Doc-level version history (Sprint 5, I9).
- Auto re-analyze on content change (Sprint 3, I7).
- Any rate limiting on AI endpoints (Sprint 3, I8).
- Actually shipping Docker (depends on F12 but the image work itself stays in the README roadmap).
