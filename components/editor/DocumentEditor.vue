<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEditor, EditorContent, VueRenderer, type Editor } from '@tiptap/vue-3'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { useRouter } from 'vue-router'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import CharacterCount from '@tiptap/extension-character-count'
import Image from '@tiptap/extension-image'
import { CodeBlockWithMermaid } from './extensions/code-block-mermaid'
import { MathInline } from './extensions/math-inline'
import { MathBlock } from './extensions/math-block'
import { Callout } from './extensions/callout'
import { FootnoteRef, FootnoteList, FootnoteItem } from './extensions/footnote'
import { Collapsible, CollapsibleSummary, CollapsibleContent } from './extensions/collapsible'
import { TableKit } from './extensions/table'
import { Transclusion } from './extensions/transclusion'
import { Whiteboard } from './extensions/whiteboard'
import { lowlight } from '~/utils/lowlight'
import tippy, { type Instance as TippyInstance, type GetReferenceClientRect } from 'tippy.js'
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from '@tiptap/suggestion'

import type { Document } from '~/server/database/schema'
import EditorToolbar from './EditorToolbar.vue'
import EditorBubbleMenu from './EditorBubbleMenu.vue'
import SlashCommandsMenu from './SlashCommandsMenu.vue'
import WikiLinkMenu from './WikiLinkMenu.vue'
import {
  SlashCommand,
  buildSlashCommandItems,
  filterItems as filterSlashItems,
  type SlashCommandItem,
} from './extensions/slash-command'
import {
  WikiLink,
  type WikiLinkItem,
} from './extensions/WikiLink'
import {
  TransclusionSuggest,
  type TransclusionSuggestItem,
} from './extensions/transclusion-suggest'
import TransclusionMenu from './TransclusionMenu.vue'
import { htmlToMarkdown, looksLikeMarkdown, markdownToHtml } from '~/composables/useEditorMarkdown'
import { useDocumentSaver } from '~/composables/useDocumentSaver'
import { useChatStore } from '~/stores/chat'
import { useTreeStore } from '~/stores/tree'
import { useLocale, useLocalizedTimeAgo } from '~/composables/useLocale'
import { storeToRefs } from 'pinia'

interface Props {
  doc: Document
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:title', value: string): void
  (e: 'update:markdown', value: string): void
}>()

/* -------------------------------------------------------------------- */
/*  Local state                                                         */
/* -------------------------------------------------------------------- */

const title = ref<string>(props.doc.title)
const docId = computed(() => props.doc.id)
const saver = useDocumentSaver(docId, 500)
const ago = useLocalizedTimeAgo(() => saver.lastSavedAt.value ?? new Date())

const chatStore = useChatStore()
const { pendingCitation } = storeToRefs(chatStore)

const treeStore = useTreeStore()
const { t } = useLocale()
const router = useRouter()
const localizedSlashItems = computed(() => buildSlashCommandItems(t))

/* -------------------------------------------------------------------- */
/*  Citation jump — find + select + scroll                              */
/* -------------------------------------------------------------------- */

/**
 * Strip markdown markup + decorations so the snippet matches the editor's
 * plain text. Marker stripping is intentionally NOT anchored to `^` because
 * the server side already collapsed the chunk into a single line, so
 * structure markers (`## `, `- `, `7. `, `> `) appear mid-string. We allow a
 * sentence-end or whitespace before them.
 */
function normalizeForSearch(s: string): string {
  const SEP = '(^|[\\s.,;:!?])'
  return s
    .replace(/```[\s\S]*?```/g, ' ')                              // code fences
    .replace(/`([^`]+)`/g, '$1')                                  // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')                         // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                      // links
    .replace(/\*\*([^*]+)\*\*/g, '$1')                            // bold
    .replace(/__([^_]+)__/g, '$1')                                // bold (alt)
    .replace(/~~([^~]+)~~/g, '$1')                                // strike
    .replace(/(?<=^|[A-Za-z0-9])\*([^*\n]+)\*/g, '$1')            // italic *…*
    .replace(new RegExp(`${SEP}#{1,6}\\s+`, 'g'), '$1')           // headings ##
    .replace(new RegExp(`${SEP}[-*+]\\s+`, 'g'), '$1')            // bullets - * +
    .replace(new RegExp(`${SEP}\\d+\\.\\s+`, 'g'), '$1')          // ordered list 7.
    .replace(new RegExp(`${SEP}>\\s+`, 'g'), '$1')                // blockquote >
    .replace(/[…]+/g, '')                                         // ellipsis decoration
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Walk the ProseMirror doc and return the [from, to] range of the first
 * occurrence of `needle`. We build a flattened text buffer that inserts a
 * single space between block boundaries (so "# Hello\n\nWorld" → "Hello World"
 * matches the editor instead of "HelloWorld"), keeping a position map so we
 * can translate the buffer index back to an editor position.
 */
function findRange(ed: Editor, needle: string): { from: number, to: number } | null {
  let buffer = ''
  // For each char of `buffer`, the corresponding editor position. A separator
  // char (synthetic space) is marked -1.
  const charPos: number[] = []
  let lastWasText = false

  ed.state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (node.isText && node.text) {
      // Block boundary: insert one space separator before this text run.
      if (!lastWasText && buffer.length > 0) {
        buffer += ' '
        charPos.push(-1)
      }
      const text = node.text
      for (let i = 0; i < text.length; i++) charPos.push(pos + i)
      buffer += text
      lastWasText = true
      return false
    }
    lastWasText = false
    return true
  })

  const bufLower = buffer.toLowerCase()
  const idx = bufLower.indexOf(needle.toLowerCase())
  if (idx < 0) return null

  // First non-separator char of the match → editor `from`.
  let from = -1
  for (let i = idx; i < charPos.length; i++) {
    const v = charPos[i]
    if (v !== undefined && v >= 0) { from = v; break }
  }
  if (from < 0) return null

  // The needle was found via plain `indexOf`, which means
  // `buffer[idx .. idx + needle.length]` is literally the needle (separator
  // chars included — they're real `' '` chars in the buffer, but have no
  // editor position). So we walk exactly `needle.length` buffer slots and
  // pick the last position that maps to a real editor char as `to`.
  const end = Math.min(idx + needle.length, charPos.length)
  let to = from + 1
  for (let i = idx; i < end; i++) {
    const v = charPos[i]
    if (v !== undefined && v >= 0) to = v + 1
  }
  return { from, to }
}

function jumpToCitation(snippet: string) {
  const ed = editor.value
  if (!ed) return
  const clean = normalizeForSearch(snippet)
  if (clean.length < 8) return

  // Try a sequence of progressively shorter / shifted candidates. The
  // chunker overlaps by ~150 chars so a chunk often starts mid-word — to
  // recover from that, we also try substrings that skip the first 1-2
  // words.
  const skipFirstWord = (() => {
    const sp = clean.indexOf(' ')
    return sp > 0 && sp < 20 ? clean.slice(sp + 1) : null
  })()
  const skipTwoWords = (() => {
    if (!skipFirstWord) return null
    const sp = skipFirstWord.indexOf(' ')
    return sp > 0 && sp < 20 ? skipFirstWord.slice(sp + 1) : null
  })()

  const candidates = [
    clean,
    clean.slice(0, 200),
    clean.slice(0, 120),
    clean.slice(0, 80),
    clean.slice(0, 40),
    skipFirstWord ?? '',
    skipFirstWord ? skipFirstWord.slice(0, 120) : '',
    skipFirstWord ? skipFirstWord.slice(0, 60) : '',
    skipTwoWords ?? '',
    skipTwoWords ? skipTwoWords.slice(0, 80) : '',
  ].filter((c, i, a) => c.length >= 16 && a.indexOf(c) === i)

  for (const c of candidates) {
    const range = findRange(ed as Editor, c)
    if (range) {
      ed.chain().focus().setTextSelection(range).scrollIntoView().run()
      // Tiptap's scrollIntoView only scrolls the editor's own viewport.
      // Our scroll container is `EditorContent` (`.editor-scroll`) which
      // wraps `.ProseMirror`, so we also manually scrollIntoView on the
      // DOM node of the selection. requestAnimationFrame lets ProseMirror
      // finish its render so domAtPos returns the up-to-date node.
      requestAnimationFrame(() => {
        try {
          const dom = ed.view.domAtPos(range.from)
          const node = dom.node
          const el = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        catch { /* node may have been detached — ignore */ }
      })
      return
    }
  }
}

function tryConsumeCitation() {
  const snippet = chatStore.consumePendingCitation(props.doc.id)
  if (snippet) jumpToCitation(snippet)
}

// React to citations queued while the editor is already mounted for this doc.
watch(pendingCitation, (next) => {
  if (next && next.docId === props.doc.id) {
    // Wait a microtask so the chat drawer's UI close (if any) finishes first.
    queueMicrotask(tryConsumeCitation)
  }
})

const statusLabel = computed<string>(() => {
  switch (saver.status.value) {
    case 'saving':
      return t('doc.status.saving')
    case 'error':
      return saver.error.value
        ? `${t('doc.status.errorPrefix')}: ${saver.error.value}`
        : t('doc.status.error')
    case 'saved':
      return saver.lastSavedAt.value
        ? t('doc.status.savedAt', { time: ago.value })
        : t('doc.status.saved')
    default:
      return saver.lastSavedAt.value
        ? t('doc.status.savedAt', { time: ago.value })
        : ''
  }
})

const characters = ref(0)
const words = ref(0)

/* -------------------------------------------------------------------- */
/*  Slash command tippy wiring                                          */
/* -------------------------------------------------------------------- */

/**
 * Build the suggestion `render()` callbacks. Mounting a `SlashCommandsMenu`
 * inside a tippy.js popper lets us reuse the menu component while keeping
 * positioning tied to the cursor's client rect.
 */
function createSlashRender() {
  let renderer: VueRenderer | null = null
  let popup: TippyInstance | null = null

  return () => ({
    onStart: (suggestionProps: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      if (!suggestionProps.clientRect) return

      renderer = new VueRenderer(SlashCommandsMenu, {
        // VueRenderer expects a Tiptap (vue-3) Editor; the type from
        // suggestion is the core Editor — cast through unknown.
        editor: suggestionProps.editor as unknown as import('@tiptap/vue-3').Editor,
        props: {
          items: suggestionProps.items,
          command: (item: SlashCommandItem) => {
            suggestionProps.command(item)
          },
        },
      })

      popup = tippy('body', {
        getReferenceClientRect: suggestionProps.clientRect as GetReferenceClientRect,
        appendTo: () => document.body,
        content: renderer.element as Element,
        showOnCreate: true,
        interactive: true,
        trigger: 'manual',
        placement: 'bottom-start',
        arrow: false,
        offset: [0, 6],
        theme: 'noteforge-slash',
      })[0] ?? null
    },

    onUpdate: (suggestionProps: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      renderer?.updateProps({
        items: suggestionProps.items,
        command: (item: SlashCommandItem) => {
          suggestionProps.command(item)
        },
      })
      // Reset highlight to the first item whenever the query changes.
      const exposed = renderer?.ref as { resetSelection?: () => void } | undefined
      exposed?.resetSelection?.()
      if (suggestionProps.clientRect) {
        popup?.setProps({
          getReferenceClientRect: suggestionProps.clientRect as GetReferenceClientRect,
        })
      }
    },

    onKeyDown: (keyProps: SuggestionKeyDownProps): boolean => {
      if (keyProps.event.key === 'Escape') {
        popup?.hide()
        return true
      }
      const exposed = renderer?.ref as
        | { onKeyDown?: (e: KeyboardEvent) => boolean }
        | undefined
      return exposed?.onKeyDown?.(keyProps.event) ?? false
    },

    onExit: () => {
      popup?.destroy()
      renderer?.destroy()
      popup = null
      renderer = null
    },
  })
}

/* -------------------------------------------------------------------- */
/*  WikiLink ([[…]]) tippy wiring                                       */
/* -------------------------------------------------------------------- */

/**
 * Mirror of `createSlashRender` for the `[[…]]` doc picker. We keep them
 * separate functions (rather than generalising) because the lifecycle is
 * identical but the prop shapes differ enough that a generic would harm
 * readability without saving lines.
 */
function createWikiRender() {
  let renderer: VueRenderer | null = null
  let popup: TippyInstance | null = null

  return () => ({
    onStart: (suggestionProps: SuggestionProps<WikiLinkItem, WikiLinkItem>) => {
      if (!suggestionProps.clientRect) return

      renderer = new VueRenderer(WikiLinkMenu, {
        editor: suggestionProps.editor as unknown as import('@tiptap/vue-3').Editor,
        props: {
          items: suggestionProps.items,
          command: (item: WikiLinkItem) => {
            suggestionProps.command(item)
          },
        },
      })

      popup = tippy('body', {
        getReferenceClientRect: suggestionProps.clientRect as GetReferenceClientRect,
        appendTo: () => document.body,
        content: renderer.element as Element,
        showOnCreate: true,
        interactive: true,
        trigger: 'manual',
        placement: 'bottom-start',
        arrow: false,
        offset: [0, 6],
        theme: 'noteforge-slash',
      })[0] ?? null
    },

    onUpdate: (suggestionProps: SuggestionProps<WikiLinkItem, WikiLinkItem>) => {
      renderer?.updateProps({
        items: suggestionProps.items,
        command: (item: WikiLinkItem) => {
          suggestionProps.command(item)
        },
      })
      const exposed = renderer?.ref as { resetSelection?: () => void } | undefined
      exposed?.resetSelection?.()
      if (suggestionProps.clientRect) {
        popup?.setProps({
          getReferenceClientRect: suggestionProps.clientRect as GetReferenceClientRect,
        })
      }
    },

    onKeyDown: (keyProps: SuggestionKeyDownProps): boolean => {
      if (keyProps.event.key === 'Escape') {
        popup?.hide()
        return true
      }
      const exposed = renderer?.ref as
        | { onKeyDown?: (e: KeyboardEvent) => boolean }
        | undefined
      return exposed?.onKeyDown?.(keyProps.event) ?? false
    },

    onExit: () => {
      popup?.destroy()
      renderer?.destroy()
      popup = null
      renderer = null
    },
  })
}

/* -------------------------------------------------------------------- */
/*  Transclusion `![[` tippy wiring                                     */
/* -------------------------------------------------------------------- */

function createTransclusionRender() {
  let renderer: VueRenderer | null = null
  let popup: TippyInstance | null = null

  return () => ({
    onStart: (suggestionProps: SuggestionProps<TransclusionSuggestItem, TransclusionSuggestItem>) => {
      if (!suggestionProps.clientRect) return

      renderer = new VueRenderer(TransclusionMenu, {
        editor: suggestionProps.editor as unknown as import('@tiptap/vue-3').Editor,
        props: {
          items: suggestionProps.items,
          command: (item: TransclusionSuggestItem) => {
            suggestionProps.command(item)
          },
        },
      })

      popup = tippy('body', {
        getReferenceClientRect: suggestionProps.clientRect as GetReferenceClientRect,
        appendTo: () => document.body,
        content: renderer.element as Element,
        showOnCreate: true,
        interactive: true,
        trigger: 'manual',
        placement: 'bottom-start',
        arrow: false,
        offset: [0, 6],
        theme: 'noteforge-slash',
      })[0] ?? null
    },

    onUpdate: (suggestionProps: SuggestionProps<TransclusionSuggestItem, TransclusionSuggestItem>) => {
      renderer?.updateProps({
        items: suggestionProps.items,
        command: (item: TransclusionSuggestItem) => {
          suggestionProps.command(item)
        },
      })
      const exposed = renderer?.ref as { resetSelection?: () => void } | undefined
      exposed?.resetSelection?.()
      if (suggestionProps.clientRect) {
        popup?.setProps({
          getReferenceClientRect: suggestionProps.clientRect as GetReferenceClientRect,
        })
      }
    },

    onKeyDown: (keyProps: SuggestionKeyDownProps): boolean => {
      if (keyProps.event.key === 'Escape') {
        popup?.hide()
        return true
      }
      const exposed = renderer?.ref as
        | { onKeyDown?: (e: KeyboardEvent) => boolean }
        | undefined
      return exposed?.onKeyDown?.(keyProps.event) ?? false
    },

    onExit: () => {
      popup?.destroy()
      renderer?.destroy()
      popup = null
      renderer = null
    },
  })
}

/* -------------------------------------------------------------------- */
/*  Image upload (F6)                                                   */
/* -------------------------------------------------------------------- */

/**
 * Allowed MIME types for client-side image extraction. Mirrors the
 * server's allowlist in `server/api/uploads.post.ts` so we don't bother
 * the user with a network round-trip just to get a 415 back. SVG is
 * intentionally absent — see the upload endpoint for rationale.
 */
const ACCEPTED_IMAGE_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/**
 * Pull image files out of a `DataTransferList`-style FileList. Returns
 * an empty array if nothing matches our allowlist.
 */
function extractImageFiles(files: FileList | null | undefined): File[] {
  if (!files || files.length === 0) return []
  const out: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)
    if (!f) continue
    if (ACCEPTED_IMAGE_MIME.has(f.type.toLowerCase())) out.push(f)
  }
  return out
}

interface UploadResponse {
  id: number
  url: string
}

/**
 * Upload each image to `/api/uploads` and insert it as a Tiptap image
 * node at the current selection. Uploads run sequentially so the inserted
 * order matches the user's drop/paste order.
 */
async function uploadAndInsertImages(files: File[]): Promise<void> {
  for (const file of files) {
    const fd = new FormData()
    fd.set('workspaceId', String(props.doc.workspaceId))
    fd.set('file', file, file.name)
    try {
      const res = await $fetch<UploadResponse>('/api/uploads', {
        method: 'POST',
        body: fd,
      })
      editor.value
        ?.chain()
        .focus()
        .setImage({ src: res.url, alt: file.name })
        .run()
    }
    catch (err) {
      // Swallow per-file errors so one bad file doesn't abort the rest.
      // The user already sees the missing image; surfacing a dialog here
      // would be more disruptive than helpful.
      console.error('[upload] failed to upload image', file.name, err)
    }
  }
}

/* -------------------------------------------------------------------- */
/*  Editor                                                              */
/* -------------------------------------------------------------------- */

const editor = useEditor({
  content: markdownToHtml(props.doc.markdown ?? ''),
  extensions: [
    StarterKit.configure({
      // StarterKit already includes: heading, bold, italic, strike, code,
      // codeBlock, blockquote, bulletList, orderedList, hardBreak,
      // horizontalRule, listItem, paragraph, history, dropcursor, gapcursor.
      heading: { levels: [1, 2, 3] },
      // Disable StarterKit's plain codeBlock — replaced below by
      // CodeBlockLowlight for syntax highlighting via lowlight/highlight.js.
      codeBlock: false,
      // We provide our own Link extension below for the openOnClick option.
    }),
    CodeBlockWithMermaid.configure({
      lowlight,
      // spellcheck="false" propagates to the nested <code> so the browser
      // stops underlining identifiers / strings inside source code.
      HTMLAttributes: { class: 'code-block hljs', spellcheck: 'false' },
      defaultLanguage: null,
    }),
    MathInline,
    MathBlock,
    Callout,
    FootnoteRef,
    FootnoteItem,
    FootnoteList,
    CollapsibleSummary,
    CollapsibleContent,
    Collapsible,
    ...TableKit,
    Transclusion,
    Whiteboard,
    Placeholder.configure({
      // I10: keep this short — the rich keyboard hint
      // ("Type / for commands · Ctrl+B for bold") is layered as a ::after
      // pseudo-element on the empty first paragraph in main.css.
      placeholder: t('doc.editor.placeholder'),
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: {
        class: 'editor-link',
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }).extend({
      // Ctrl/Cmd+click on a link navigates: internal wiki-links
      // (`/w/:wsId/d/:id`) route through Vue, external URLs open in a new
      // tab. Plain clicks stay no-op so the user can place their caret
      // inside link text without losing focus.
      addProseMirrorPlugins() {
        const parent = this.parent?.() ?? []
        return [
          ...parent,
          new Plugin({
            key: new PluginKey('linkCtrlClick'),
            props: {
              handleClick: (view, _pos, event) => {
                const el = event.target as HTMLElement | null

                // Footnote backref ↩ — marked-footnote emits
                // `<a href="#footnote-ref-LABEL" data-footnote-backref>↩</a>`
                // inside each footnote item. Our FootnoteRef NodeView doesn't
                // expose an `id="footnote-ref-LABEL"` anchor target, so the
                // native hash navigation would scroll to nothing AND dirty
                // the URL. Resolve the ref via editor state and scroll there.
                const backHref = (el?.closest('a') as HTMLAnchorElement | null)?.getAttribute('href') ?? ''
                const backMatch = backHref.match(/^#footnote-ref-(.+)$/)
                if (backMatch && backMatch[1]) {
                  const label = decodeURIComponent(backMatch[1])
                  let refPos = -1
                  view.state.doc.descendants((n, pos) => {
                    if (refPos !== -1) return false
                    if (n.type.name === 'footnoteRef'
                      && (n.attrs as { label?: string }).label === label) {
                      refPos = pos
                      return false
                    }
                    return true
                  })
                  if (refPos !== -1) {
                    event.preventDefault()
                    requestAnimationFrame(() => {
                      try {
                        const dom = view.domAtPos(refPos)
                        const node = dom.node.nodeType === 1
                          ? (dom.node as HTMLElement)
                          : dom.node.parentElement
                        if (!node) return
                        node.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        node.classList.add('footnote-target-flash')
                        window.setTimeout(
                          () => node.classList.remove('footnote-target-flash'),
                          1400,
                        )
                      }
                      catch { /* node detached — silent */ }
                    })
                    return true
                  }
                }

                // Ctrl/Cmd+click on a link navigates: internal wiki-links
                // (`/w/:wsId/d/:id`) route through Vue, external URLs open
                // in a new tab. Plain clicks stay no-op so the user can
                // place their caret inside link text without losing focus.
                if (!event.ctrlKey && !event.metaKey) return false
                const anchor = el?.closest('a.editor-link') as HTMLAnchorElement | null
                if (!anchor) return false
                const href = anchor.getAttribute('href') ?? ''
                if (!href) return false
                event.preventDefault()
                if (/^\/w\/\d+\/d\/\d+/.test(href)) {
                  void router.push(href)
                }
                else {
                  window.open(href, '_blank', 'noopener,noreferrer')
                }
                return true
              },
            },
          }),
        ]
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    CharacterCount,
    Image.configure({
      // We always serve uploads through our authenticated endpoint, so
      // inline base64 is unnecessary. allowBase64=false prevents accidental
      // pastes of huge data: URIs into the markdown.
      allowBase64: false,
      HTMLAttributes: { class: 'editor-image' },
    }),
    SlashCommand.configure({
      suggestion: {
        render: createSlashRender(),
        items: ({ query }) => filterSlashItems(query, localizedSlashItems.value),
      },
    }),
    WikiLink.configure({
      workspaceId: props.doc.workspaceId,
      currentDocId: props.doc.id,
      // Pull live from the tree store. The store is populated by the
      // sidebar on mount, so the picker has docs as soon as the tree
      // sidebar has rendered. Soft-deleted docs are already excluded
      // there.
      docs: () => treeStore.documents.map(d => ({ id: d.id, title: d.title })),
      suggestion: { render: createWikiRender() },
    }),
    TransclusionSuggest.configure({
      currentDocId: props.doc.id,
      docs: () => treeStore.documents.map(d => ({ id: d.id, title: d.title })),
      suggestion: { render: createTransclusionRender() },
    }),
  ],
  editorProps: {
    attributes: {
      class: 'ProseMirror prose-document',
      spellcheck: 'true',
    },
    handlePaste(view, event) {
      const cd = event.clipboardData
      if (!cd) return false

      // F6: image attachments — image files in the clipboard take precedence
      // over text. Tiptap's StarterKit drops them on the floor otherwise.
      const imageFiles = extractImageFiles(cd.files)
      if (imageFiles.length > 0) {
        event.preventDefault()
        void uploadAndInsertImages(imageFiles)
        return true
      }

      // Inside a code block, keep paste literal regardless of clipboard format.
      const parentName = view.state.selection.$from.parent.type.name
      if (parentName === 'codeBlock') return false

      const text = cd.getData('text/plain')
      const html = cd.getData('text/html')

      // Prefer the plain-text → marked path when the text carries markdown
      // structure (fences, headings, lists, tables…). Terminals and chat UIs
      // ship both text/plain AND a cosmetic text/html with styled spans — if
      // we let Tiptap parse that HTML, a fenced ```block``` becomes literal
      // backticks in a paragraph. The plain text still has the real syntax.
      if (text && looksLikeMarkdown(text)) {
        // When the doc is still untitled and empty, and the paste starts
        // with a `# heading`, lift that into the doc title and drop it
        // from the body — that's the case for "I copied a whole article
        // and the title is its first line".
        let toConvert = text
        const lifted = maybeLiftTitle(text)
        if (lifted) {
          applyLiftedTitle(lifted.title)
          toConvert = lifted.body
        }
        const converted = markdownToHtml(toConvert)
        if (converted) {
          event.preventDefault()
          editor.value?.chain().focus().insertContent(converted).run()
          return true
        }
      }

      // Rich HTML (Google Docs, Notion, web pages…) — let Tiptap handle it
      // natively. Its built-in sanitiser keeps the structural elements we care
      // about and drops the rest.
      if (html && html.trim().length > 0) return false

      // Plain text with no markdown structure — Tiptap's default text paste
      // handles position and breaks correctly, no need to intervene.
      return false
    },
    handleDrop(view, event, _slice, moved) {
      // Internal drag (e.g. node reordering) — let ProseMirror handle it.
      if (moved) return false
      const dt = (event as DragEvent).dataTransfer
      if (!dt) return false
      const imageFiles = extractImageFiles(dt.files)
      if (imageFiles.length === 0) return false

      event.preventDefault()
      // Move the selection to the drop point so the image lands where the
      // user actually aimed.
      const pos = view.posAtCoords({
        left: (event as DragEvent).clientX,
        top: (event as DragEvent).clientY,
      })
      if (pos) {
        editor.value?.chain().focus().setTextSelection(pos.pos).run()
      }
      void uploadAndInsertImages(imageFiles)
      return true
    },
  },
  onUpdate({ editor }) {
    const html = editor.getHTML()
    const markdown = htmlToMarkdown(html)
    const contentJson = editor.getJSON()
    characters.value = editor.storage.characterCount?.characters?.() ?? 0
    words.value = editor.storage.characterCount?.words?.() ?? 0
    saver.save({ markdown, contentJson })
    // Surface the live markdown so panels (e.g. insights stale-indicator)
    // can react without waiting for a server round-trip.
    emit('update:markdown', markdown)
  },
  onCreate({ editor }) {
    characters.value = editor.storage.characterCount?.characters?.() ?? 0
    words.value = editor.storage.characterCount?.words?.() ?? 0
    // If we navigated to this doc with a queued citation, jump to it
    // once the editor's first paint is in.
    queueMicrotask(tryConsumeCitation)
  },
})

/* -------------------------------------------------------------------- */
/*  Title autosave (separate channel — saves on blur + 500ms debounce)  */
/* -------------------------------------------------------------------- */

function onTitleInput() {
  const next = title.value.trim() || t('doc.untitled')
  saver.save({ title: next })
  emit('update:title', next)
}

/**
 * If the document still has its default "Untitled" placeholder AND the
 * editor body is empty, and the pasted markdown begins with a `# Heading`,
 * return `{ title, body }` where `title` is the heading text and `body`
 * is the pasted text with that heading line stripped.
 *
 * Returns `null` when none of those conditions hold — the paste is then
 * inserted verbatim.
 */
function maybeLiftTitle(text: string): { title: string, body: string } | null {
  const current = title.value.trim()
  // The server stores 'Untitled' verbatim (server/utils/notes.ts), so we
  // check the literal too — under a non-EN locale t('doc.untitled') is a
  // different string ('Sans titre' in FR) and won't match the stored value.
  const isUntitled = current === '' || current === 'Untitled' || current === t('doc.untitled')
  if (!isUntitled) return null
  // Empty body = the user hasn't typed anything yet. characters is updated
  // by the editor's onUpdate; on a fresh doc it's still 0.
  if (characters.value > 0) return null

  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  const first = lines[i] ?? ''
  const m = first.match(/^#\s+(.+?)\s*#*\s*$/)
  if (!m) return null
  const lifted = m[1]?.trim()
  if (!lifted) return null
  // Strip the heading line + immediately-following blank lines.
  const rest = lines.slice(i + 1).join('\n').replace(/^\n+/, '')
  return { title: lifted, body: rest }
}

function applyLiftedTitle(next: string): void {
  title.value = next
  saver.save({ title: next })
  emit('update:title', next)
}

function onTitleBlur() {
  const trimmed = title.value.trim()
  if (!trimmed) {
    const fallback = t('doc.untitled')
    title.value = fallback
    emit('update:title', fallback)
  }
}

// If the parent swaps the doc prop (route change), reset local title and
// editor content. We compare by id so editing the same doc doesn't reset.
watch(
  () => props.doc.id,
  (newId, oldId) => {
    if (newId === oldId) return
    title.value = props.doc.title
    const html = markdownToHtml(props.doc.markdown ?? '')
    editor.value?.commands.setContent(html, false)
    // If switching docs landed us on the citation target, jump after the
    // new content has been set.
    queueMicrotask(tryConsumeCitation)
  },
)

onBeforeUnmount(() => {
  // Flush any pending save before tearing down.
  void saver.flush({})
  editor.value?.destroy()
})

// Expose the Tiptap editor instance so siblings (e.g. <DocumentOutline />
// in the doc page's right rail) can read headings, scroll on click, etc.
defineExpose({ editor })
</script>

<template>
  <div class="flex flex-1 min-h-0 flex-col bg-ink-50 dark:bg-ink-950">
    <!-- Title row -->
    <div class="mx-auto w-full max-w-3xl xl:max-w-4xl 2xl:max-w-6xl px-6 pt-4">
      <div class="mb-2 flex items-center justify-between gap-3">
        <span
          class="label-mono"
          aria-live="polite"
        >
          {{ statusLabel }}
        </span>
        <span class="label-mono normal-case tracking-normal">
          {{ words }} {{ words === 1 ? t('doc.editor.word') : t('doc.editor.words') }}
        </span>
      </div>
      <input
        v-model="title"
        type="text"
        :placeholder="t('doc.editor.titlePlaceholder')"
        class="title-input"
        spellcheck="true"
        @input="onTitleInput"
        @blur="onTitleBlur"
      >
    </div>

    <!-- Toolbar -->
    <div class="mx-auto mt-6 w-full max-w-3xl xl:max-w-4xl 2xl:max-w-6xl px-6">
      <EditorToolbar :editor="editor" />
    </div>

    <!-- Editor canvas -->
    <!-- The scroll container is the centered text column itself (not the
         full-width wrapper) so the scrollbar sits at the edge of the
         editor's writing area, not against the right rail. -->
    <div class="flex-1 min-h-0 overflow-hidden">
      <EditorContent
        :editor="editor"
        class="editor-scroll prose-document mx-auto h-full max-w-3xl xl:max-w-4xl 2xl:max-w-6xl overflow-y-auto px-6 py-8"
      />
    </div>

    <!-- Bubble menu (portaled by Tiptap) -->
    <EditorBubbleMenu :editor="editor" />

    <!-- Footer -->
    <footer
      class="footer-bar flex items-center justify-between border-t border-ink-200 bg-ink-50/90 px-6 py-2 backdrop-blur dark:border-ink-800/60 dark:bg-ink-950/80"
    >
      <span class="label-mono normal-case tracking-normal">{{ characters }} {{ t('doc.editor.characters') }}</span>
      <span class="label-mono normal-case tracking-normal">{{ words }} {{ words === 1 ? t('doc.editor.word') : t('doc.editor.words') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.title-input {
  @apply w-full border-0 bg-transparent font-serif text-4xl font-semibold leading-tight tracking-tight text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-0;
}
html.dark .title-input {
  color: theme('colors.ink.50');
}
html.dark .title-input::placeholder {
  color: theme('colors.ink.600');
}

/* -------------------------------------------------------------------- */
/*  ProseMirror editorial styles                                        */
/*  Scoped to .prose-document so they only affect this editor's body.   */
/* -------------------------------------------------------------------- */

.prose-document :deep(.ProseMirror) {
  @apply font-sans text-base leading-[1.75] text-ink-800;
}
html.dark .prose-document :deep(.ProseMirror) {
  color: theme('colors.ink.100');
}

.prose-document :deep(.ProseMirror > * + *) {
  @apply mt-4;
}

.prose-document :deep(.ProseMirror h1) {
  @apply mt-10 font-serif text-3xl font-semibold leading-tight tracking-tight text-ink-900;
}
html.dark .prose-document :deep(.ProseMirror h1) { color: theme('colors.ink.50'); }
.prose-document :deep(.ProseMirror h2) {
  @apply mt-8 font-serif text-2xl font-semibold leading-snug tracking-tight text-ink-900;
}
html.dark .prose-document :deep(.ProseMirror h2) { color: theme('colors.ink.50'); }
.prose-document :deep(.ProseMirror h3) {
  @apply mt-6 font-serif text-xl font-semibold leading-snug text-ink-900;
}
html.dark .prose-document :deep(.ProseMirror h3) { color: theme('colors.ink.50'); }

.prose-document :deep(.ProseMirror p) {
  @apply text-ink-800;
}
html.dark .prose-document :deep(.ProseMirror p) { color: theme('colors.ink.100'); }

.prose-document :deep(.ProseMirror a),
.prose-document :deep(.ProseMirror .editor-link) {
  @apply text-accent-600 underline decoration-accent-300 decoration-2 underline-offset-2 transition-colors hover:text-accent-700;
}
html.dark .prose-document :deep(.ProseMirror a),
html.dark .prose-document :deep(.ProseMirror .editor-link) {
  color: theme('colors.accent.400');
}
html.dark .prose-document :deep(.ProseMirror a:hover),
html.dark .prose-document :deep(.ProseMirror .editor-link:hover) {
  color: theme('colors.accent.300');
}

.prose-document :deep(.ProseMirror strong) {
  @apply font-semibold text-ink-900;
}
html.dark .prose-document :deep(.ProseMirror strong) { color: theme('colors.ink.50'); }

.prose-document :deep(.ProseMirror em) {
  @apply italic;
}

.prose-document :deep(.ProseMirror code) {
  @apply rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.9em] text-ink-800;
}
html.dark .prose-document :deep(.ProseMirror code) {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}

.prose-document :deep(.ProseMirror pre) {
  @apply my-6 overflow-x-auto rounded-lg border border-ink-200 bg-ink-900 p-4 font-mono text-sm leading-relaxed text-ink-50;
}
html.dark .prose-document :deep(.ProseMirror pre) {
  border-color: theme('colors.ink.800');
  background: theme('colors.ink.950');
}
.prose-document :deep(.ProseMirror pre code) {
  @apply bg-transparent p-0 text-inherit;
}

.prose-document :deep(.ProseMirror blockquote) {
  @apply my-6 border-l-4 border-accent-500 bg-accent-50/40 py-1 pl-5 font-serif italic text-ink-700;
}
html.dark .prose-document :deep(.ProseMirror blockquote) {
  background: theme('colors.accent.900' / 20%);
  color: theme('colors.ink.200');
}

.prose-document :deep(.ProseMirror ul),
.prose-document :deep(.ProseMirror ol) {
  @apply my-4 pl-6;
}
.prose-document :deep(.ProseMirror ul) {
  @apply list-disc marker:text-ink-400;
}
.prose-document :deep(.ProseMirror ol) {
  @apply list-decimal marker:text-ink-400;
}
html.dark .prose-document :deep(.ProseMirror ul),
html.dark .prose-document :deep(.ProseMirror ol) {
  /* marker color via class can't easily be overridden with html.dark; the
     marker:text-ink-400 utility maps to color: var(--tw-...); fall back to
     direct ::marker rule. */
}
html.dark .prose-document :deep(.ProseMirror ul li::marker),
html.dark .prose-document :deep(.ProseMirror ol li::marker) {
  color: theme('colors.ink.500');
}
.prose-document :deep(.ProseMirror li) {
  @apply my-1.5;
}
.prose-document :deep(.ProseMirror li > p) {
  @apply my-0 inline;
}

/* Task list (TaskItem ships as <li data-type="taskItem">) */
.prose-document :deep(.ProseMirror ul[data-type='taskList']) {
  @apply list-none pl-0;
}
.prose-document :deep(.ProseMirror ul[data-type='taskList'] li) {
  @apply flex items-start gap-2;
}
.prose-document :deep(.ProseMirror ul[data-type='taskList'] li > label) {
  @apply mt-1 flex-shrink-0 select-none;
}
.prose-document :deep(.ProseMirror ul[data-type='taskList'] li > div) {
  @apply flex-1;
}
.prose-document :deep(.ProseMirror ul[data-type='taskList'] input[type='checkbox']) {
  @apply h-4 w-4 cursor-pointer rounded border-ink-300 accent-accent-500;
}
html.dark .prose-document :deep(.ProseMirror ul[data-type='taskList'] input[type='checkbox']) {
  border-color: theme('colors.ink.700');
}

/* Image nodes (F6). Constrain to the writing column and keep them block-level. */
.prose-document :deep(.ProseMirror .editor-image),
.prose-document :deep(.ProseMirror img) {
  @apply my-4 block h-auto max-w-full rounded-md border border-ink-200;
}
html.dark .prose-document :deep(.ProseMirror .editor-image),
html.dark .prose-document :deep(.ProseMirror img) {
  border-color: theme('colors.ink.800');
}
.prose-document :deep(.ProseMirror .editor-image.ProseMirror-selectednode),
.prose-document :deep(.ProseMirror img.ProseMirror-selectednode) {
  @apply outline outline-2 outline-accent-500;
}

.prose-document :deep(.ProseMirror hr) {
  @apply my-10 border-0 border-t border-ink-200;
}
html.dark .prose-document :deep(.ProseMirror hr) {
  border-top-color: theme('colors.ink.800');
}

.prose-document :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  @apply text-ink-400;
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}
html.dark .prose-document :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  color: theme('colors.ink.500');
}

/* -------------------------------------------------------------------- */
/*  Editable tables                                                     */
/* -------------------------------------------------------------------- */
.prose-document :deep(.ProseMirror table.editor-table) {
  @apply my-5 w-full border-collapse overflow-hidden rounded-md;
  table-layout: fixed;
}
.prose-document :deep(.ProseMirror table.editor-table td),
.prose-document :deep(.ProseMirror table.editor-table th) {
  @apply border border-ink-200 px-3 py-2 align-top text-sm;
  min-width: 4rem;
  position: relative;
}
.prose-document :deep(.ProseMirror table.editor-table th) {
  @apply bg-ink-50 font-semibold text-ink-900;
}
html.dark .prose-document :deep(.ProseMirror table.editor-table td),
html.dark .prose-document :deep(.ProseMirror table.editor-table th) {
  border-color: theme('colors.ink.800');
}
html.dark .prose-document :deep(.ProseMirror table.editor-table th) {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
.prose-document :deep(.ProseMirror table.editor-table .selectedCell) {
  @apply bg-accent-50;
}
html.dark .prose-document :deep(.ProseMirror table.editor-table .selectedCell) {
  background: theme('colors.accent.900' / 30%);
}
.prose-document :deep(.ProseMirror .column-resize-handle) {
  @apply pointer-events-none absolute top-0 bottom-0 -right-1 w-1 bg-accent-500;
}
.prose-document :deep(.ProseMirror.resize-cursor) {
  cursor: col-resize;
}

/* Slash-command suggestion decoration (the ghost "/" in the doc) */
.prose-document :deep(.suggestion) {
  @apply rounded bg-accent-100/60 px-0.5 text-ink-900;
}
html.dark .prose-document :deep(.suggestion) {
  background: theme('colors.accent.900' / 40%);
  color: theme('colors.ink.50');
}
</style>
