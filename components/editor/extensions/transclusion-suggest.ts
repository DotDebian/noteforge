/**
 * `![[…]]` transclusion picker.
 *
 * Mirrors the structure of `WikiLink.ts` but, on selection, inserts a
 * `transclusion` node (block embed) rather than a Tiptap Link mark.
 * Triggered by typing `![[` — Tiptap's suggestion plugin then captures
 * further keystrokes as the query and pops the candidate menu.
 *
 * Separating this from the existing WikiLink extension keeps the
 * `[[doc]]` and `![[doc]]` paths from accidentally fighting over the
 * trigger prefix (a single `[` is also a popular markdown character for
 * links — narrower triggers reduce false positives).
 */
import { Extension } from '@tiptap/vue-3'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'

type SuggestionEditor = Parameters<NonNullable<SuggestionOptions['command']>>[0]['editor']
type SuggestionRange = Parameters<NonNullable<SuggestionOptions['command']>>[0]['range']

export interface TransclusionSuggestDoc {
  id: number
  title: string
}

export interface TransclusionSuggestItem {
  docId: number
  title: string
}

export interface TransclusionSuggestOptions {
  currentDocId: number | null
  docs: () => TransclusionSuggestDoc[]
  suggestion: Pick<SuggestionOptions<TransclusionSuggestItem, TransclusionSuggestItem>, 'render'> &
    Partial<Omit<SuggestionOptions<TransclusionSuggestItem, TransclusionSuggestItem>, 'editor' | 'items' | 'command' | 'pluginKey'>>
}

export const transclusionSuggestPluginKey = new PluginKey('transclusionSuggest')

function rankDocs(
  docs: TransclusionSuggestDoc[],
  query: string,
  excludeId: number | null,
): TransclusionSuggestItem[] {
  const filtered = excludeId == null ? docs : docs.filter(d => d.id !== excludeId)
  const q = query.replace(/\]+$/, '').toLowerCase().trim()
  if (!q) {
    return [...filtered]
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, 20)
      .map(d => ({ docId: d.id, title: d.title }))
  }
  type Scored = { item: TransclusionSuggestItem, idx: number, len: number }
  const scored: Scored[] = []
  for (const d of filtered) {
    const idx = d.title.toLowerCase().indexOf(q)
    if (idx < 0) continue
    scored.push({ item: { docId: d.id, title: d.title }, idx, len: d.title.length })
  }
  scored.sort((a, b) => a.idx - b.idx || a.len - b.len || a.item.title.localeCompare(b.item.title))
  return scored.slice(0, 20).map(s => s.item)
}

function insertTransclusionNode(
  editor: SuggestionEditor,
  range: SuggestionRange,
  slug: string,
): void {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent({ type: 'transclusion', attrs: { slug } })
    .run()
}

export const TransclusionSuggest = Extension.create<TransclusionSuggestOptions>({
  name: 'transclusionSuggest',

  addOptions(): TransclusionSuggestOptions {
    return {
      currentDocId: null,
      docs: () => [],
      suggestion: {
        render: () => ({}),
      },
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    const userSuggestion = options.suggestion
    const suggestion: SuggestionOptions<TransclusionSuggestItem, TransclusionSuggestItem> = {
      char: '![[',
      allowSpaces: true,
      startOfLine: false,
      ...userSuggestion,
      editor: this.editor,
      pluginKey: transclusionSuggestPluginKey,
      items: ({ query }) => rankDocs(options.docs(), query, options.currentDocId),
      command: ({ editor, range, props }) => {
        // The slug we persist into the transclusion node is the document
        // id — that's stable across rename and lets the NodeView resolve
        // without depending on a unique-title invariant.
        insertTransclusionNode(editor, range, String(props.docId))
      },
    }
    return [Suggestion<TransclusionSuggestItem, TransclusionSuggestItem>(suggestion)]
  },
})
