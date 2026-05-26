# Sprint 2 — UX Leap

**Goal:** Make the app fast to navigate and pleasant to organize. After this sprint, a user with hundreds of docs can find anything in two keystrokes, reorder freely, and orient inside long documents.

**Estimated duration:** ~1.5 weeks.

**Items:** F1, F8, I4, I5, F7

---

## F1 — Command palette (⌘K / Ctrl+K)

**Why:** The sidebar is the only way to find a doc today. A command palette compounds value with every later feature (it becomes the entry point for "Search", "Switch workspace", "Toggle theme", "Run command", etc.).

**Scope (v1 — title-only fuzz):**
- Global keydown listener in `layouts/default.vue` mirroring the ⌘N pattern from `usePlatform.ts`. ⌘K on macOS / Ctrl+K on Win/Linux. Single shortcut, no platform-specific divergence (Ctrl+K is not browser-reserved).
- New `<CommandPalette />` component hosted from `default.vue`, controlled by a `usePaletteStore` (Pinia).
- Sections in order of relevance: **Recent docs** (last 10 opened — track in localStorage), **Docs** (fuzzy match on title — `fuse.js` or a simple subsequence matcher), **Actions** ("New document", "New folder", "Open chat", "Toggle theme", "Go to trash"), **Workspaces** (switch).
- Keyboard navigation: ↑/↓ to move, Enter to select, Esc to close.
- A11y: `role="dialog"`, focus trap, ARIA active descendant pattern.

**Scope (v2 — semantic, deferred to Sprint 3):**
- Add a "Semantic results" section that calls a new endpoint hitting `doc_chunks` via sqlite-vec. Lands after I1.

**Files touched:** new `components/CommandPalette.vue`, new `stores/palette.ts`, hook in `layouts/default.vue`.
**Dependencies:** new dep `fuse.js` (small, ~6kb gz) or hand-rolled fuzzy matcher.
**Risks:** focus management with the existing `DialogHost` — make sure Esc only closes the palette, not the underlying dialog. Test interaction with chat drawer.
**Complexity:** Medium.
**DoD:** ⌘K opens an overlay in <50 ms; typing 2 chars surfaces relevant docs; Enter navigates; Esc returns focus to where it was.

---

## F8 — Favorites / pinned docs

**Why:** Power-user feature with a tiny surface. Pairs with the command palette (pinned docs sort first in Recents).

**Scope:**
- Schema: new `favorites(user_id, doc_id, created_at)` join table with composite PK.
- API: `POST /api/documents/:id/favorite`, `DELETE /api/documents/:id/favorite`, `GET /api/favorites?workspaceId=…`.
- UI: star icon next to doc title in the editor header; a pinned section at the top of `AppSidebar` (above Outline) when there's at least one favorite.

**Files touched:** schema + migration, new endpoints, `AppSidebar.vue`, doc header in `pages/w/[workspaceId]/d/[docId].vue`, possibly a small `useFavorites` composable.
**Dependencies:** F1 surfaces favorites first in its Recents section (loose coupling — ship without it if needed).
**Risks:** none.
**Complexity:** Low.
**DoD:** Starring a doc pins it; pinned list survives reload; unstarring removes it.

---

## I4 — Document & folder reordering

**Why:** `documents.position` and `folders.position` columns already exist and are sorted everywhere — the UI just doesn't expose the reorder gesture. Pure UI work on top of a ready DB.

**Scope:**
- Drag handles inside `FolderTreeNode` rows and the workspace-root rows for both docs and folders.
- Use HTML5 native DnD (consistent with existing drag-to-folder behavior in `stores/drag.ts`) — extend the drag store with an `insertBefore` target type, distinct from the existing `over` target.
- On drop: compute the new `position` value as midpoint between neighbors (no immediate reflow); periodically renumber if positions get too dense (rare).
- New endpoint or extension of existing PATCH: accept a `position` field; reject if it conflicts with `folderId` change in the same call (keep moves and reorders separate to keep optimistic logic simple).

**Files touched:** `stores/drag.ts`, `components/sidebar/FolderTreeNode.vue`, `components/AppSidebar.vue`, `stores/tree.ts`, document/folder PATCH endpoints.
**Dependencies:** none.
**Risks:** drop targets become subtle (above vs. below vs. into-folder). Visual feedback is critical — different cursor/line affordance. Test with nested folders.
**Complexity:** Medium.
**DoD:** Drag a doc above another, refresh, order persists. Drag a folder above another, same. Move-to-folder (existing) still works without regression.

---

## I5 — Folder drag & drop into other folders

**Why:** Asymmetric UX feels broken — docs can be moved but folders are stuck. Once I4 ships, this is a small extension.

**Scope:**
- Extend `stores/drag.ts` with `draggedFolderId` parallel to `draggedDocId`.
- Drop targets in `FolderTreeNode` accept either a doc or a folder; reject if dropping a folder onto itself or any descendant (server enforces; client also greys out invalid targets).
- Existing `PATCH /api/folders/:id` already accepts `parentId` via the schema (verify); server-side guard against cycles.

**Files touched:** `stores/drag.ts`, `FolderTreeNode.vue`, `AppSidebar.vue`, `server/api/folders/[id].patch.ts`.
**Dependencies:** I4 (shared drag store extensions).
**Risks:** cycle detection — easy to bug. Add a server-side guard *and* a small recursive client check. Watch for performance on deep trees.
**Complexity:** Medium.
**DoD:** Drag a subfolder into another folder, refresh, structure persists. Dragging onto a descendant shows a forbidden cursor and is rejected by the server.

---

## F7 — Table of contents (in-doc outline)

**Why:** The right rail is empty when no AI analysis exists. Cheap real estate, immediate value for any doc with headings.

**Scope:**
- New `<DocumentOutline />` component above (or below) the AI insights panel.
- Tiptap exposes the doc state; walk `editor.state.doc.descendants` for `heading` nodes with their level + text + position.
- Render as a tree (h1 → h2 indented), click scrolls into view using the existing `.editor-scroll` scroll container + `view.domAtPos` (reuse the `jumpToCitation` mechanism).
- Highlight the heading nearest to the current scroll position with an IntersectionObserver on heading DOM nodes.
- Hide when fewer than 2 headings exist.

**Files touched:** new `components/DocumentOutline.vue`, mounted from `pages/w/[workspaceId]/d/[docId].vue` or `DocumentInsightsPanel.vue`.
**Dependencies:** none (reuses existing editor instance via prop or provide/inject).
**Risks:** outline freshness during editing — debounce a recompute on `editor.on('update')`. Don't recompute on every keystroke.
**Complexity:** Low.
**DoD:** Opening a doc with 5+ headings shows a clickable outline; clicking jumps and highlights; editing the doc updates the outline within 500 ms.

---

## Sprint-level DoD

- ⌘K opens a palette; ⌘N still works (Sprint 1 of pre-sprint shortcut).
- Sidebar supports reordering both docs and folders, and dropping folders into folders.
- Favorites pin to the top of the sidebar.
- Right rail shows a TOC for any multi-heading document.
- Test coverage extended from Sprint 1: at least one test for the palette's fuzzy matcher and one for the position-midpoint computation.

## Out of scope

- Semantic search inside the palette (waits for I1 in Sprint 3).
- Cross-workspace search (only current workspace for v1).
- TOC for code-block sections or admonitions (just headings).
- Mobile-responsive sidebar (Sprint 5, F10).
