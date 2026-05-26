import { Extension } from '@tiptap/vue-3'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import '@tiptap/extension-link'

/**
 * Sprint 4 / F2 — `[[wiki link]]` doc picker.
 *
 * Triggered by typing `[[`. The matching `]]` is not part of the
 * suggestion grammar — the user just keeps typing the query, and Tiptap's
 * suggestion plugin auto-closes on stop characters or selection. On
 * select, we delete the typed `[[query` range and insert a real Tiptap
 * LINK node pointing at `/w/:wsId/d/:docId`. Turndown (already configured
 * in `useEditorMarkdown.ts`) round-trips the link as
 * `[Title](/w/:wsId/d/:docId)` markdown, which is exactly what
 * `extractDocLinks` looks for on save.
 *
 * Sprint addendum — daily-note auto-create. When the user types
 * `[[YYYY-MM-DD]]` the picker prepends a "Create daily note" item that,
 * when accepted, calls `POST /api/workspaces/:id/daily-note` (idempotent
 * find-or-create) and inserts a link to the resulting doc. Picking an
 * existing doc still works the same way.
 */

type SuggestionEditor = Parameters<NonNullable<SuggestionOptions['command']>>[0]['editor']
type SuggestionRange = Parameters<NonNullable<SuggestionOptions['command']>>[0]['range']
export type WikiLinkEditor = SuggestionEditor
export type WikiLinkRange = SuggestionRange

export interface WikiLinkDoc {
  id: number
  title: string
}

/** A picker entry. Two flavours: an existing doc, or a "create daily note"
 *  pseudo-entry whose acceptance calls the daily-note endpoint. */
export interface WikiLinkItem {
  /** -1 sentinel for the "create daily note" pseudo-entry. */
  docId: number
  title: string
  /** Distinguishes the daily-note pseudo-entry from a normal doc link. */
  kind?: 'doc' | 'createDaily'
  /** Only populated when `kind === 'createDaily'`. */
  date?: string
}

export interface WikiLinkOptions {
  /** Workspace this editor is editing inside. */
  workspaceId: number
  /** Current doc id — excluded from the picker (no self-links). */
  currentDocId: number | null
  /**
   * Pluggable doc list — called fresh on every keystroke. Implementations
   * typically pull from a Pinia store; passed as a function so the
   * extension stays import-cycle-free and reactive without watchers.
   */
  docs: () => WikiLinkDoc[]
  /**
   * The suggestion config minus `editor`, `items`, `command`, and
   * `pluginKey` — those are set by the extension. Consumers supply
   * `render` (the popover lifecycle) and may override `char` if desired.
   */
  suggestion: Pick<SuggestionOptions<WikiLinkItem, WikiLinkItem>, 'render'> &
    Partial<Omit<SuggestionOptions<WikiLinkItem, WikiLinkItem>, 'editor' | 'items' | 'command' | 'pluginKey'>>
}

export const wikiLinkPluginKey = new PluginKey('wikiLink')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Fuzzy match by case-insensitive substring on title. Empty query returns
 * the first 20 docs sorted by title. If the query is a `YYYY-MM-DD` date,
 * a "create daily note" pseudo-entry is prepended (idempotent — the
 * endpoint finds-or-creates).
 */
function rankDocs(docs: WikiLinkDoc[], query: string, excludeId: number | null): WikiLinkItem[] {
  const filtered = excludeId == null ? docs : docs.filter(d => d.id !== excludeId)
  // Strip stray closing brackets — the wiki-style `[[query]]` is auto-closed
  // by the selection insert, but a user who types the closers manually
  // shouldn't break the search.
  const q = query.replace(/\]+$/, '').toLowerCase().trim()
  const items: WikiLinkItem[] = []

  // Daily-note auto-create: prepend a pseudo-entry whenever the query is
  // a YYYY-MM-DD date. We always show it — the endpoint is idempotent and
  // the user might want to re-open an existing daily note via this path.
  if (DATE_RE.test(q)) {
    items.push({
      kind: 'createDaily',
      docId: -1,
      title: q,
      date: q,
    })
  }

  if (!q) {
    items.push(
      ...[...filtered]
        .sort((a, b) => a.title.localeCompare(b.title))
        .slice(0, 20)
        .map<WikiLinkItem>(d => ({ docId: d.id, title: d.title, kind: 'doc' })),
    )
    return items
  }

  type Scored = { item: WikiLinkItem, idx: number, len: number }
  const scored: Scored[] = []
  for (const d of filtered) {
    const idx = d.title.toLowerCase().indexOf(q)
    if (idx < 0) continue
    scored.push({ item: { docId: d.id, title: d.title, kind: 'doc' }, idx, len: d.title.length })
  }
  scored.sort((a, b) => a.idx - b.idx || a.len - b.len || a.item.title.localeCompare(b.item.title))
  items.push(...scored.slice(0, 20).map(s => s.item))
  return items
}

interface DailyNoteResponse {
  document: { id: number, title: string }
  created: boolean
}

/**
 * Insert a Tiptap link mark at the (cleared) suggestion range.
 */
function insertDocLink(
  editor: WikiLinkEditor,
  range: WikiLinkRange,
  workspaceId: number,
  docId: number,
  title: string,
): void {
  const href = `/w/${workspaceId}/d/${docId}`
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent([
      {
        type: 'text',
        text: title,
        marks: [{ type: 'link', attrs: { href } }],
      },
      { type: 'text', text: ' ' },
    ])
    .run()
}

export const WikiLink = Extension.create<WikiLinkOptions>({
  name: 'wikiLink',

  addOptions(): WikiLinkOptions {
    return {
      workspaceId: 0,
      currentDocId: null,
      docs: () => [],
      suggestion: {
        // No-op render; the real one is supplied by the consumer via
        // `WikiLink.configure({ suggestion: { render } })`.
        render: () => ({}),
      },
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    const userSuggestion = options.suggestion

    const suggestion: SuggestionOptions<WikiLinkItem, WikiLinkItem> = {
      // Defaults that the consumer can override (e.g. tweak `char`).
      char: '[[',
      allowSpaces: true,
      startOfLine: false,
      // Spread the consumer-provided bits (`render`, plus any optional
      // overrides like `char` / `allowSpaces`).
      ...userSuggestion,
      // Things the extension itself owns — must come AFTER the spread so
      // a consumer can't accidentally clobber them.
      editor: this.editor,
      pluginKey: wikiLinkPluginKey,
      items: ({ query }) => rankDocs(options.docs(), query, options.currentDocId),
      command: ({ editor, range, props }) => {
        // Daily-note pseudo-entry: hit the find-or-create endpoint THEN
        // insert the link. We can't await here (Tiptap's command signature
        // is synchronous), but we can fire the request and patch the link
        // once it resolves. For UX we insert a placeholder link first that
        // points at a temporary path, then replace it on resolve. This
        // also covers the slow-network case where the picker shouldn't
        // freeze.
        if (props.kind === 'createDaily' && props.date) {
          // Insert a "loading" placeholder at the cleared range so the
          // caret moves on immediately.
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              { type: 'text', text: props.date, marks: [] },
              { type: 'text', text: ' ' },
            ])
            .run()
          const placeholderFrom = range.from
          const placeholderTo = placeholderFrom + props.date.length

          // Fire-and-forget: on success, rewrite the placeholder text into
          // a real link to the resolved daily note. On failure, leave the
          // bare date text in place.
          $fetch<DailyNoteResponse>(
            `/api/workspaces/${options.workspaceId}/daily-note`,
            {
              method: 'POST',
              body: { date: props.date },
            },
          )
            .then((res) => {
              const href = `/w/${options.workspaceId}/d/${res.document.id}`
              const title = res.document.title || props.date
              // Replace the placeholder span. If the user typed elsewhere
              // in the meantime, the range might no longer point at the
              // placeholder text — bail in that case.
              try {
                editor
                  .chain()
                  .focus()
                  .setTextSelection({ from: placeholderFrom, to: placeholderTo })
                  .deleteSelection()
                  .insertContent([
                    {
                      type: 'text',
                      text: title,
                      marks: [{ type: 'link', attrs: { href } }],
                    },
                  ])
                  .run()
              }
              catch (err) {
                console.warn('[wiki-link] could not replace daily-note placeholder', err)
              }
            })
            .catch((err) => {
              console.warn('[wiki-link] daily-note create failed', err)
            })
          return
        }

        // Normal doc-link path.
        insertDocLink(editor, range, options.workspaceId, props.docId, props.title)
      },
    }

    return [Suggestion<WikiLinkItem, WikiLinkItem>(suggestion)]
  },
})
