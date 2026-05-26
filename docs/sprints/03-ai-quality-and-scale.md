# Sprint 3 — AI Quality & Scale

**Goal:** Make retrieval correct and fast enough to survive a real-sized workspace, close the loop between editing and insights, and protect the Mistral key from abuse. After this sprint, RAG should still feel instant at 10k chunks.

**Estimated duration:** ~2 weeks. The sqlite-vec migration is the long pole.

**Items:** I11, I1, I2, I8, I7

---

## I11 — Migrate embeddings to BLOB column

**Why:** Today `doc_chunks.embedding` is `TEXT` and parsed via `JSON.parse` on every chunk read in `parseEmbedding` ([server/utils/vector.ts](server/utils/vector.ts)). At thousands of chunks this is the per-request bottleneck. It's also a hard prerequisite for I1 (sqlite-vec expects float32 blobs).

**Scope:**
- New migration: `embedding_blob BLOB` column alongside the existing `embedding TEXT`.
- Backfill script (`server/database/migrate-embeddings.ts`): read each row's TEXT, convert to `Float32Array` → `Buffer`, write to `embedding_blob`. Idempotent (skip if already populated). Resumable.
- Update `server/utils/embed-doc.ts` to write BLOBs going forward. Stop writing TEXT after the migration completes.
- Update `parseEmbedding` (rename to `loadEmbedding`) to read BLOB by default, fall back to TEXT if the BLOB is null (keeps the rollback path open until I1 ships).
- Drop the TEXT column in a second migration once I1 has been on `main` for a week.

**Files touched:** schema, new migration, new backfill script, `server/utils/vector.ts`, `server/utils/embed-doc.ts`, callers of `parseEmbedding`.
**Dependencies:** test suite from I12 — add a vector round-trip test before swapping the format.
**Risks:** mismatched endianness (Node Buffer is host endian; sqlite-vec expects little-endian); explicitly use `Float32Array.buffer` with a typed `DataView` if portability matters. Test on Windows + Linux.
**Complexity:** Medium.
**DoD:** Existing chats still return correct citations; new docs write BLOB only; backfill runs in <30s on a workspace of 1k chunks.

---

## I1 — Wire sqlite-vec for similarity queries

**Why:** The extension is already loaded by `server/database/client.ts` but unused. Today `chat.post.ts` reads every chunk in the workspace, parses every embedding, and computes cosine in JS. This is O(n) per query and scans don't compose with the auth filter cleanly.

**Scope:**
- Introduce a `vec0` virtual table `doc_chunks_vec(embedding float[1024])` (dimension matches `mistral-embed`'s output — verify at runtime).
- Migration: create the vec table and populate from `doc_chunks.embedding_blob`. Keep `doc_chunks` as the source-of-truth metadata; `vec0` only stores vectors keyed by chunk id.
- Update `embed-doc.ts` to insert into both tables in a transaction.
- Rewrite the retrieval path in `chat.post.ts`:
  - Embed user query.
  - `SELECT chunk_id FROM doc_chunks_vec WHERE embedding MATCH ? AND k = ?` with a join filter on workspace via a `WHERE chunk_id IN (chunks_for_workspace)` CTE.
  - Apply existing top-K, per-doc cap, and MIN_SCORE logic on the returned distances.
- Same for `/api/ai/related/:docId`.
- Remove the JS cosine loop (keep the function for tests).

**Files touched:** schema, new migration, `server/utils/embed-doc.ts`, `server/api/ai/chat.post.ts`, `server/api/ai/related/[docId].get.ts`, `server/utils/vector.ts` (slim down).
**Dependencies:** I11 must land first.
**Risks:** sqlite-vec MATCH ranking returns distance (lower is better) while existing code compares cosine similarity (higher is better) — translate carefully and re-verify MIN_SCORE threshold. Verify behavior with the access-scoping CTE on large workspaces; add an index on `doc_chunks.doc_id` if not already present.
**Complexity:** Medium–High.
**DoD:** A workspace with 10k chunks returns chat answers in <300 ms p50 retrieval time; citations and highlights remain accurate.

---

## I2 — Section-aware chunking

**Why:** Fixed 1200/150 chunking can split mid-word or mid-sentence; that's why `jumpToCitation` has a `skipFirstWord` fallback. Better chunk boundaries → better retrieval precision *and* a simpler citation jump.

**Scope:**
- Rewrite `server/utils/chunking.ts`:
  - Primary split on headings (markdown `^#{1,6} `).
  - Secondary split on blank-line paragraph boundaries.
  - Hard size cap (~1500 chars) — if a paragraph exceeds it, fall back to sentence-aware split.
  - Overlap is now optional: only overlap inside the same section to maintain context across long paragraphs; don't overlap across heading boundaries (a new section is a clean break).
- Emit chunk metadata: `{ text, sectionPath: string[] }` where `sectionPath` is `["H1 Title", "H2 Subtitle"]` — useful later for showing breadcrumbs in chat sources.
- Update `embed-doc.ts` to pass through `sectionPath` (schema addition: `section_path` TEXT JSON column on `doc_chunks`, nullable).

**Files touched:** `server/utils/chunking.ts`, `server/utils/embed-doc.ts`, schema, migration. Optionally `components/chat/ChatDrawer.vue` to render the breadcrumb under the source title.
**Dependencies:** test suite from I12 (chunker is the prime candidate for property-based tests).
**Risks:** existing chunks become "legacy" — either re-embed all docs on next analyze, or accept that older content uses old chunks. A one-time rebuild script is the cleanest option.
**Complexity:** Medium.
**DoD:** Chunk boundaries never split mid-word; `jumpToCitation` can drop the `skipFirstWord` path (or keeps it only as defense in depth).

---

## I8 — Rate limiting on AI endpoints

**Why:** No throttling on `/api/ai/chat`, `/api/ai/analyze/:id`, or `/api/ai/embed/:id`. One user (or a runaway client) can exhaust the Mistral budget.

**Scope:**
- In-memory token bucket keyed by `user_id`:
  - `/api/ai/analyze/:id` — 10/min, 50/hour per user.
  - `/api/ai/chat` — 30/min, 200/hour per user.
  - `/api/ai/embed/:id` — 20/min per user (mostly fire-and-forget after analyze).
- Surface 429 with a `Retry-After` header.
- Client-side: catch 429 in `stores/chat.ts` / analyze action and show a friendly toast via the dialog system.
- Server logs at INFO when a user is throttled; WARN if the same user hits the limit 5x in 10 minutes.

**Files touched:** new `server/utils/rate-limit.ts`, all `server/api/ai/*` handlers, client error handling in `stores/chat.ts` and `DocumentInsightsPanel.vue`.
**Dependencies:** none.
**Risks:** in-memory buckets don't survive restarts (acceptable for single-instance dev; revisit if we go multi-process). Don't accidentally throttle the health endpoint or static asset paths.
**Complexity:** Low.
**DoD:** Hammering analyze 20x in a row trips the limit; the UI shows a useful message; the bucket refills correctly after the window passes.

---

## I7 — Auto-reanalyze on substantive change

**Why:** Analysis is manual today. Insights drift as the doc grows. A user shouldn't have to remember to click "Analyze".

**Scope:**
- Stale indicator on the insights panel: badge + tooltip ("Insights are 1,200 words behind") computed from `documents.markdown.length` at last analysis vs. current.
- Auto-trigger logic in `useDocumentSaver` (or a new `useAutoAnalysis` composable):
  - After autosave, if word-count delta since last analysis > 30% AND the doc has >300 words, schedule a reanalysis.
  - Debounce 30s of inactivity before triggering (don't fire mid-typing burst).
  - Coalesce — never more than one analyze in flight per doc.
- Store `markdown_length_at_analysis` on `doc_analyses` to compute drift (schema addition).
- Hard-disabled if the user has hit their rate limit (I8 prerequisite).

**Files touched:** schema, `composables/useDocumentSaver.ts` (or new composable), `DocumentInsightsPanel.vue`, `server/api/ai/analyze/[docId].post.ts`.
**Dependencies:** I8 must ship first so auto-fires can't cause a cost spiral.
**Risks:** users in the middle of writing don't want a flash on the panel. Hide the reanalysis spinner behind a subtle indicator, don't replace the content until the new payload arrives. Make sure manual action items (I3) survive — merge by text.
**Complexity:** Medium.
**DoD:** Adding ~500 words to a 1500-word doc and pausing 30s triggers a quiet reanalysis; the panel updates without flicker; the user's checked action items survive.

---

## Sprint-level DoD

- A representative workspace of 10k chunks reads chat responses in <500 ms total retrieval + <2 s first token.
- Auto-reanalysis fires for editing sessions matching the heuristic; never fires in violation of the rate limit.
- New benchmark script (`pnpm bench:rag`) prints p50/p95 retrieval latency for the test corpus.
- All vector code paths exercised by the test suite from Sprint 1's I12.

## Out of scope

- Multi-tenant rate limiting (single in-memory bucket is fine for now).
- Replacing Mistral / adding a fallback provider (a separate, larger initiative).
- Streaming the analysis JSON (current call is blocking; users see a spinner; acceptable until UX feedback says otherwise).
- Re-chunking existing docs on the new chunker — either accept "old chunks until next analyze" or write a one-shot rebuild script (decide during sprint planning).
