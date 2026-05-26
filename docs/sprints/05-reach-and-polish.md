# Sprint 5 — Reach & Polish

**Goal:** Take the app from "great on a laptop" to "great everywhere, shareable, and recoverable". This sprint closes the original roadmap.

**Estimated duration:** ~2 weeks.

**Items:** F9, F10, I9, I10

---

## F9 — Public share links (read-only)

**Why:** Often the killer feature that gets a notes app shared with the outside world. Pair with the trust foundation laid in Sprint 1 (trash, export).

**Scope:**

**Schema:**
- New table `share_tokens(token TEXT PK, doc_id, created_by, created_at, expires_at NULLABLE, revoked_at NULLABLE)`. Token = `crypto.randomBytes(24).toString('base64url')`.

**API:**
- `POST /api/documents/:id/share` → create a token. Optional `expiresInDays`.
- `DELETE /api/documents/:id/share/:token` → revoke (sets `revoked_at`).
- `GET /api/documents/:id/shares` → list active tokens (for the share modal).
- `GET /api/public/docs/:token` → unauthenticated. Resolves token, returns `{ document: { title, markdown, updatedAt } }`. No analysis, no chunks, no related docs. Reject if expired or revoked.

**Routing:**
- New unauthenticated page `/share/[token].vue` → renders the doc using the sanitized markdown renderer from `useMarkdownView.ts` (which already exists for chat — extend it to handle a full document).
- A banner on the public page: "Viewing a shared document from <workspace name>". A "Copy markdown" button.

**UI in app:**
- "Share" button in the doc header. Opens a modal with a "Create link" button → reveals the URL with one-click copy. Lists active links with revoke buttons.
- Soft signal in the doc title row when a doc has active share links.

**Files touched:** schema + migration, new endpoints, new public page, new share modal component, doc header.
**Dependencies:** the markdown sanitizer in `useMarkdownView.ts` must cover the full editor's HTML surface (today it's tuned for chat output). Audit before exposing publicly.
**Risks:** XSS is the dominant concern. The sanitizer allowlist must be enforced server-side too (don't trust client rendering on a public route). Tokens must be cryptographically random and constant-time compared. Rate-limit `/api/public/docs/:token` to prevent enumeration.
**Complexity:** Medium.
**DoD:** A public link in a private window renders the doc; revoking works immediately; tampering with the token returns 404, not 500; the public page passes a basic XSS audit (script tags, event handlers, `javascript:` URLs all stripped).

---

## F10 — Mobile-responsive layout

**Why:** The app is desktop-only today. `AppSidebar` is a hard-coded 300 px. The right rail (`.doc-rail`) is `hidden lg:flex`. The chat drawer assumes wide screens.

**Scope:**

**Sidebar:**
- Below `md` breakpoint (640 px): sidebar becomes a slide-over drawer triggered by a hamburger button in a thin top app-bar.
- Overlay backdrop closes it on tap.
- Auto-close on doc navigation.

**Doc page:**
- Below `lg`: right rail (AI insights + TOC + backlinks) moves to a bottom sheet accessible via a "Insights" button.
- Doc title row + meta wrap on narrow widths instead of overflowing.
- Editor column width caps remain; tap targets in toolbar bumped to 36 px min.

**Chat drawer:**
- Full-screen overlay on mobile; current side-drawer behavior preserved on desktop.
- Session list becomes a separate route step (back button) instead of a sub-panel.

**Misc:**
- Add a viewport meta if not already present.
- Verify keyboard shortcuts on iPad (⌘N from external keyboard should work).
- Verify the citation jump-scroll still works inside the mobile editor scroll container.

**Files touched:** `layouts/default.vue`, `components/AppSidebar.vue`, `pages/w/[workspaceId]/d/[docId].vue`, `components/chat/ChatDrawer.vue`, `assets/css/main.css` for breakpoint helpers.
**Dependencies:** none.
**Risks:** breaks the carefully tuned `.editor-scroll` layout (CLAUDE.md flags this as fragile). Test on real iOS Safari, not just Chrome devtools — virtual keyboard, momentum scroll, and pull-to-refresh all interact with the scroll container.
**Complexity:** Medium.
**DoD:** App is usable on a 375×667 viewport: navigation, editing, AI insights, and chat all reachable in ≤2 taps.

---

## I9 — Document version history

**Why:** Autosave is great until it isn't. A power user wants to roll back to "yesterday's draft" without a manual export. Adds the second half of the trust story started by F3 (trash).

**Scope:**

**Schema:**
- New table `document_versions(id, doc_id, markdown, content_json, title, created_at, created_by, reason TEXT)` — `reason` is `'autosave_snapshot' | 'manual_snapshot' | 'pre_restore'`.

**Snapshot policy:**
- One snapshot per autosave session: on first edit of a session (defined as 30 min since last edit), snapshot the *previous* state before saving. Cheap, bounded, and matches "what was it like before I started today's edits".
- Optional manual snapshot via a doc header action.
- Retention: keep all snapshots for 30 days, then collapse to one per day for 90 days, then one per month indefinitely. Implement as a daily cron-style cleanup (or a lazy cleanup on read).

**UI:**
- "History" item in the doc header opens a modal: timeline of snapshots, click to preview (read-only render), Restore button.
- Restore writes a new snapshot of the current state (reason: `pre_restore`) then replaces the live doc with the chosen version.

**Files touched:** schema + migration, new endpoint `GET /api/documents/:id/versions`, `GET /api/documents/:id/versions/:versionId`, `POST /api/documents/:id/versions/:versionId/restore`, new history modal component, doc header.
**Dependencies:** F3 (trash) sets the pattern for "preview before destructive action".
**Risks:** storage growth — `markdown` columns balloon with snapshots. Compress (`zlib`) the markdown column server-side, or store only diffs (more work; defer to v2 if storage is a real problem).
**Complexity:** Medium.
**DoD:** Editing a doc, returning the next day, opening History reveals a snapshot from before today's edits, and restoring brings it back with another snapshot saved automatically.

---

## I10 — Editor focus mode + slash-menu discoverability

**Why:** Two small polish items rolled together. Focus mode is a one-keystroke distraction killer. Slash-menu discoverability addresses a real onboarding gap — new users don't know `/` exists.

**Scope:**

**Focus mode:**
- New keyboard shortcut: ⌘. / Ctrl+. (or a button in the toolbar).
- Toggles a `focus-mode` class on `app-shell` that:
  - Hides the sidebar with a slide-out animation.
  - Hides the right rail.
  - Hides the chat FAB.
- Esc exits focus mode.
- Persist preference in localStorage so a user who prefers focus mode keeps it across sessions.

**Slash-menu discoverability:**
- In empty new documents (zero content), show a subtle ghost-text hint: "Type / for commands · ⌘B for bold". Hide on first keystroke.
- Use Tiptap's `Placeholder` extension's `emptyEditorClass` and a CSS pseudo-element with the full hint, not just the existing "Start writing…" placeholder.

**Files touched:** `layouts/default.vue`, `components/editor/DocumentEditor.vue`, `assets/css/main.css`, `composables/usePlatform.ts` (extend with a focus-mode shortcut helper).
**Dependencies:** none.
**Risks:** none. Make sure focus mode doesn't break the chat citation jump (chat drawer still openable via FAB or keyboard).
**Complexity:** Low.
**DoD:** ⌘. enters focus mode; Esc exits; preference persists. An empty new doc shows a hint that disappears once typing starts.

---

## Sprint-level DoD

- A public share link survives a third-party security review (basic XSS, token enumeration, expiry).
- App works on a phone-sized viewport.
- A user can recover yesterday's version of any doc.
- Focus mode is one keystroke away.
- Test suite covers the share-token lifecycle and the version snapshot policy.

## Final-state checklist (across all five sprints)

By the end of Sprint 5, NoteForge should have:

- [x] Auth, workspaces, folders, documents, autosave
- [ ] Trash + restore, export, import
- [ ] Command palette + favorites + reordering + folder DnD + TOC
- [ ] sqlite-vec retrieval, section-aware chunking, rate limiting, auto-reanalysis
- [ ] Wiki-links + backlinks, image attachments, doc-scoped chat
- [ ] Public share, mobile, version history, focus mode
- [ ] Test suite covering vector math, chunking, citation extraction, sharing, versioning
- [ ] Health endpoint + Docker rollout path unblocked

## Out of scope (deliberately deferred beyond Sprint 5)

- Real-time collaboration (Yjs / CRDT).
- Multi-user workspaces with ACLs (today's `ownerId` model is single-owner; sharing covers most of the use case).
- Non-Mistral AI providers / model picker.
- Mobile-native apps.
- Plugin system / user-defined slash commands.
- Encrypted-at-rest documents (client-side encryption).
