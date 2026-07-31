import { Extension } from '@tiptap/vue-3'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'

// Importing these for their module augmentations (`declare module
// '@tiptap/core'`) so that `chain().toggleHeading()` and friends are
// type-checked correctly when this file is type-checked in isolation.
// StarterKit re-exports heading/bullet/ordered list/blockquote/codeBlock/
// horizontalRule, TaskList ships toggleTaskList. The local node extensions
// declare their own commands (`insertCallout` etc.) — importing pulls the
// `declare module` augmentation in here.
import '@tiptap/starter-kit'
import '@tiptap/extension-task-list'
import '@tiptap/extension-table'
import './callout'
import './footnote'
import './collapsible'
import './transclusion'

/**
 * We need the same `Editor` and `Range` types that `@tiptap/suggestion`
 * uses (i.e. from `@tiptap/core`). The Vue-3 Editor is a subclass and
 * therefore not assignable to the parent type used by SuggestionOptions.
 * We extract the types from SuggestionOptions itself.
 */
type SuggestionEditor = Parameters<NonNullable<SuggestionOptions['command']>>[0]['editor']
type SuggestionRange = Parameters<NonNullable<SuggestionOptions['command']>>[0]['range']
export type Editor = SuggestionEditor
export type Range = SuggestionRange

/**
 * A slash-command item. `command` runs when the user picks the item;
 * it must remove the typed `/query` (via `range`) and then issue the
 * Tiptap commands to insert the requested node.
 */
export interface SlashCommandItem {
  title: string
  description: string
  keywords?: string[]
  icon?: string
  command: (args: { editor: Editor, range: Range }) => void
}

/**
 * Translator signature accepted by `buildSlashCommandItems`. Matches the
 * shape returned by `useLocale().t`. Kept loosely-typed (no import) so this
 * module remains import-cycle-free.
 */
export type SlashTranslator = (key: string, params?: Record<string, string | number>) => string

/**
 * Localized strings for slash commands that aren't (yet) in `useLocale.ts`.
 * `t()` falls back to the key when the dictionary lacks an entry, which is
 * not user-friendly. We resolve French + English ourselves for new items.
 *
 * The locale is sniffed from `document.documentElement.lang` (set by
 * `useLocale().setLocale`). That keeps this module reactive without
 * pulling in `useLocale` (and avoiding a Pinia / VueUse cycle).
 */
function pickLocaleString(fr: string, en: string): string {
  if (typeof document === 'undefined') return en
  const lang = document.documentElement.lang || 'en'
  return lang.startsWith('fr') ? fr : en
}

/**
 * Build the localized slash-command catalog. Pass `useLocale().t` from the
 * editor host to localize titles / descriptions; defaults to an identity
 * translator that returns the key (useful only for tests).
 */
export function buildSlashCommandItems(t: SlashTranslator): SlashCommandItem[] {
  const tableTitle = pickLocaleString('Tableau', 'Table')
  const tableDesc = pickLocaleString('Tableau modifiable avec en-têtes', 'Editable table with headers')
  const embedTitle = pickLocaleString('Inclure un document', 'Embed document')
  const embedDesc = pickLocaleString('Transclusion d\'un autre document', 'Transclude another document')
  return [
    {
      title: t('slash.h1.title'),
      description: t('slash.h1.desc'),
      keywords: ['h1', 'title', 'titre'],
      icon: 'H1',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run()
      },
    },
    {
      title: t('slash.h2.title'),
      description: t('slash.h2.desc'),
      keywords: ['h2', 'subtitle', 'sous-titre'],
      icon: 'H2',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run()
      },
    },
    {
      title: t('slash.h3.title'),
      description: t('slash.h3.desc'),
      keywords: ['h3'],
      icon: 'H3',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run()
      },
    },
    {
      title: t('slash.bullet.title'),
      description: t('slash.bullet.desc'),
      keywords: ['bullet', 'ul', 'unordered', 'puce', 'liste'],
      icon: '•',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run()
      },
    },
    {
      title: t('slash.numbered.title'),
      description: t('slash.numbered.desc'),
      keywords: ['ol', 'ordered', 'number', 'numérotée'],
      icon: '1.',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run()
      },
    },
    {
      title: t('slash.task.title'),
      description: t('slash.task.desc'),
      keywords: ['todo', 'checkbox', 'task', 'tâche', 'case'],
      icon: '☐',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleTaskList().run()
      },
    },
    {
      title: t('slash.code.title'),
      description: t('slash.code.desc'),
      keywords: ['code', 'pre', 'snippet'],
      icon: '</>',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
      },
    },
    {
      title: t('slash.mermaid.title'),
      description: t('slash.mermaid.desc'),
      keywords: ['mermaid', 'diagram', 'diagramme', 'graph', 'flow', 'sequence', 'schéma'],
      icon: '▦',
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: 'codeBlock',
            attrs: { language: 'mermaid' },
            content: [{ type: 'text', text: 'graph TD\n  A[Start] --> B[End]' }],
          })
          .run()
      },
    },
    {
      title: t('slash.math.title'),
      description: t('slash.math.desc'),
      keywords: ['math', 'latex', 'tex', 'katex', 'inline', 'formule', 'équation'],
      icon: '∑',
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({ type: 'mathInline', attrs: { formula: '' } })
          .run()
      },
    },
    {
      title: t('slash.equation.title'),
      description: t('slash.equation.desc'),
      keywords: ['equation', 'équation', 'math', 'latex', 'tex', 'katex', 'block', 'display', 'formule'],
      icon: '∫',
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({ type: 'mathBlock', attrs: { formula: '' } })
          .run()
      },
    },
    {
      title: t('slash.quote.title'),
      description: t('slash.quote.desc'),
      keywords: ['blockquote', 'quote', 'citation'],
      icon: '"',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run()
      },
    },
    {
      title: t('slash.callout.title'),
      description: t('slash.callout.desc'),
      keywords: ['callout', 'admonition', 'note', 'info', 'tip', 'warn', 'warning', 'avertissement', 'astuce'],
      icon: '!',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).insertCallout('info').run()
      },
    },
    {
      title: t('slash.footnote.title'),
      description: t('slash.footnote.desc'),
      keywords: ['footnote', 'note', 'reference', 'référence', 'bas-de-page'],
      icon: '†',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).insertFootnote().run()
      },
    },
    {
      title: t('slash.collapsible.title'),
      description: t('slash.collapsible.desc'),
      keywords: ['collapse', 'toggle', 'details', 'fold', 'accordion', 'repliable', 'pliage'],
      icon: '▸',
      command: ({ editor, range }) => {
        const title = pickLocaleString('Titre', 'Title')
        editor.chain().focus().deleteRange(range).insertCollapsible(true, title).run()
      },
    },
    {
      title: tableTitle,
      description: tableDesc,
      keywords: ['table', 'tableau', 'grid', 'spreadsheet', 'data'],
      icon: '⊞',
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run()
      },
    },
    {
      title: embedTitle,
      description: embedDesc,
      keywords: ['embed', 'transclusion', 'reference', 'mention', 'inclusion', 'inclure', 'transclure'],
      icon: '↪',
      command: ({ editor, range }) => {
        // Insert the `![[` prefix so the wiki-link suggestion plugin
        // takes over and opens its picker. The user then types the doc
        // title (or an integer id) and selects; the WikiLink handler
        // inserts the actual link. For dedicated transclusion behaviour
        // (block embed of the doc body) the user can manually type
        // `![[…]]` literally — the marked extension converts it to a
        // Transclusion node on the next render.
        //
        // We use the literal text `![[` and let the user keep typing.
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent('![[')
          .run()
      },
    },
    {
      title: t('slash.divider.title'),
      description: t('slash.divider.desc'),
      keywords: ['hr', 'rule', 'divider', 'line', 'séparateur', 'trait'],
      icon: '—',
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run()
      },
    },
    {
      title: t('slash.image.title'),
      description: t('slash.image.desc'),
      keywords: ['image', 'img', 'picture'],
      icon: '🖼',
      command: async ({ editor, range }) => {
        // Pull the store lazily so this module stays import-cycle-free.
        const { useDialogStore } = await import('~/stores/dialog')
        const dialog = useDialogStore()
        const url = await dialog.prompt({
          title: t('slash.image.promptTitle'),
          placeholder: t('slash.image.promptPlaceholder'),
          confirmLabel: t('slash.image.confirm'),
        })
        if (!url) {
          editor.chain().focus().deleteRange(range).run()
          return
        }
        // StarterKit doesn't ship image — fall back to a markdown-friendly
        // link with the URL as text so it round-trips through turndown.
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent(`![](${url})`)
          .run()
      },
    },
  ]
}

const identityTranslator: SlashTranslator = (k) => k
export const slashCommandItems: SlashCommandItem[] = buildSlashCommandItems(identityTranslator)

export function filterItems(query: string, items: SlashCommandItem[] = slashCommandItems): SlashCommandItem[] {
  const q = query.toLowerCase().trim()
  if (!q) return items
  return items.filter((item) => {
    if (item.title.toLowerCase().includes(q)) return true
    if (item.description.toLowerCase().includes(q)) return true
    return item.keywords?.some((k) => k.includes(q)) ?? false
  })
}

export const slashCommandPluginKey = new PluginKey('slashCommand')

/**
 * The `render` half of the suggestion config is left for the component
 * to provide — `SlashCommandsMenu.vue` injects its own render callbacks
 * via `SlashCommand.configure({ suggestion: { render } })`.
 */
export type SlashSuggestionRender = SuggestionOptions<SlashCommandItem, SlashCommandItem>['render']

export interface SlashCommandOptions {
  suggestion: Omit<SuggestionOptions<SlashCommandItem, SlashCommandItem>, 'editor'>
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions(): SlashCommandOptions {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        pluginKey: slashCommandPluginKey,
        command: ({ editor, range, props }) => {
          props.command({ editor, range })
        },
        items: ({ query }) => filterItems(query),
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ]
  },
})

export { filterItems as filterSlashItems }
