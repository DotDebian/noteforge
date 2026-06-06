<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DocAnalysis, Document } from '~/server/database/schema'
import { useChatStore } from '~/stores/chat'
import { useDialog } from '~/composables/useDialog'
import { useAutoAnalysis } from '~/composables/useAutoAnalysis'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

interface Props {
  docId: number
  /**
   * Live markdown surfaced by the editor (so the stale-indicator reflects
   * the user's current text, not just what was last fetched). Optional —
   * falls back to the fetched document's markdown when not provided.
   */
  liveMarkdown?: string
}
const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'open-doc', docId: number): void
}>()

interface DocResponse {
  document: Document
  analysis: DocAnalysis | null
}

interface RelatedHit {
  docId: number
  title: string
  score: number
  snippet: string
}

const docResp = ref<DocResponse | null>(null)
const related = ref<RelatedHit[]>([])
const analyzing = ref(false)
const loading = ref(false)
const loadingRelated = ref(false)
const error = ref<string | null>(null)

interface EmbedStatus {
  chunkCount: number
  indexed: boolean
  lastIndexedAt: string | number | null
  error: string | null
  errorAt: string | number | null
}
const embedStatus = ref<EmbedStatus | null>(null)
const reindexing = ref(false)

async function loadEmbedStatus() {
  try {
    embedStatus.value = await $fetch<EmbedStatus>(`/api/ai/embed/${props.docId}`)
  }
  catch {
    embedStatus.value = null
  }
}

async function reindex() {
  if (reindexing.value) return
  reindexing.value = true
  try {
    const res = await $fetch<{ chunks: number }>(`/api/ai/embed/${props.docId}`, {
      method: 'POST',
    })
    await loadEmbedStatus()
    // Refresh related notes — they'll now include this doc (and may resurface
    // hidden docs whose presence depended on this one's embeddings).
    setTimeout(loadRelated, 200)
    void useDialog().alert({
      title: t('insights.index.toastTitle'),
      message: t('insights.index.toastOk', { n: res.chunks }),
    })
  }
  catch (e) {
    const err = e as { data?: { detail?: string }, statusMessage?: string, message?: string }
    const detail = err?.data?.detail ?? err?.statusMessage ?? err?.message ?? 'unknown error'
    void useDialog().alert({
      title: t('insights.index.failedTitle'),
      message: detail,
    })
    // Refresh status so the persisted embedError surfaces.
    await loadEmbedStatus()
  }
  finally {
    reindexing.value = false
  }
}

const analysis = computed(() => docResp.value?.analysis ?? null)
const hasAnalysis = computed(() => analysis.value !== null)

const tabs = ['summary', 'tags', 'useCases', 'questions', 'actions'] as const
type Tab = typeof tabs[number]
const activeTab = ref<Tab>('summary')
const tabLabel: Record<Tab, string> = {
  summary: 'insights.tab.summary',
  tags: 'insights.tab.tags',
  useCases: 'insights.tab.useCases',
  questions: 'insights.tab.questions',
  actions: 'insights.tab.actions',
}

async function loadDoc() {
  loading.value = true
  error.value = null
  try {
    const resp = await $fetch<DocResponse>(`/api/documents/${props.docId}`)
    docResp.value = resp
  }
  catch (e) {
    error.value = (e as Error).message ?? 'Failed to load document'
  }
  finally {
    loading.value = false
  }
}

async function loadRelated() {
  loadingRelated.value = true
  try {
    related.value = await $fetch<RelatedHit[]>(`/api/ai/related/${props.docId}`)
  }
  catch {
    related.value = []
  }
  finally {
    loadingRelated.value = false
  }
}

async function runAnalysis(opts: { silent?: boolean } = {}) {
  analyzing.value = true
  if (!opts.silent) error.value = null
  try {
    const resp = await $fetch<{ analysis: DocAnalysis | null }>(`/api/ai/analyze/${props.docId}`, {
      method: 'POST',
    })
    if (docResp.value) {
      docResp.value = { ...docResp.value, analysis: resp.analysis }
    }
    // Related is populated by the background embedding job — give it a beat,
    // then also refresh the embed-status badge so a silent failure surfaces.
    setTimeout(() => {
      void loadRelated()
      void loadEmbedStatus()
    }, 1500)
  }
  catch (e) {
    if (opts.silent) {
      // Re-throw so the auto-analysis composable can identify 429s and
      // swallow them without surfacing a toast.
      analyzing.value = false
      throw e
    }
    const err = e as {
      statusCode?: number
      status?: number
      response?: { status?: number, headers?: { get?: (k: string) => string | null } }
      data?: { data?: { detail?: string }, retryAfterSec?: number }
      statusMessage?: string
      message?: string
    }
    const status = err.statusCode ?? err.status ?? err.response?.status
    if (status === 429) {
      const retryAfter
        = (err.data?.retryAfterSec
          ?? Number(err.response?.headers?.get?.('Retry-After')))
        || 0
      const hint = retryAfter > 0
        ? (retryAfter === 1
          ? t('insights.rateLimit.tryAgainSec', { n: retryAfter })
          : t('insights.rateLimit.tryAgainSecs', { n: retryAfter }))
        : t('insights.rateLimit.tryAgainSoon')
      void useDialog().alert({
        title: t('insights.rateLimit.title'),
        message: t('insights.rateLimit.message', { hint }),
      })
      error.value = null
    }
    else {
      error.value = err.data?.data?.detail ?? err.statusMessage ?? err.message ?? t('insights.error.failed')
    }
  }
  finally {
    analyzing.value = false
  }
}

/* ------------------------------------------------------------------ */
/*  Sprint 3 / I7 — stale indicator + inactivity-triggered auto-run    */
/* ------------------------------------------------------------------ */

// Reactive view of the doc shape the composable wants. Markdown prefers
// the live editor value (props.liveMarkdown) and falls back to the fetched
// document's markdown.
const autoDoc = computed(() => {
  if (!docResp.value) return null
  const md = props.liveMarkdown ?? docResp.value.document.markdown
  return { id: docResp.value.document.id, markdown: md }
})
const autoAnalysis = computed(() => analysis.value)

const { isStale, staleHint, isRunning: autoRunning } = useAutoAnalysis(
  autoDoc,
  autoAnalysis,
  () => runAnalysis({ silent: true }),
)

const chat = useChatStore()
function askQuestion(q: string) {
  chat.openWithQuestion(q)
}

async function toggleActionItem(index: number) {
  if (!docResp.value?.analysis) return
  const current = docResp.value.analysis.actionItems
  const target = current[index]
  if (!target) return

  // Optimistic update — replace the array reference so Vue picks it up.
  const next = current.map((it, i) =>
    i === index ? { text: it.text, done: !it.done } : it,
  )
  docResp.value = {
    ...docResp.value,
    analysis: { ...docResp.value.analysis, actionItems: next },
  }

  try {
    await $fetch<{ actionItems: { text: string, done: boolean }[] }>(
      `/api/ai/analyze/${props.docId}/action-items`,
      { method: 'PATCH', body: { actionItems: next } },
    )
  }
  catch (e) {
    // Revert on failure.
    if (docResp.value?.analysis) {
      docResp.value = {
        ...docResp.value,
        analysis: { ...docResp.value.analysis, actionItems: current },
      }
    }
    const err = e as { statusMessage?: string, message?: string }
    error.value = err.statusMessage ?? err.message ?? t('insights.error.actionFailed')
    console.error('[insights] toggleActionItem failed', e)
  }
}

function openRelated(docId: number) {
  emit('open-doc', docId)
}

watch(() => props.docId, async () => {
  docResp.value = null
  related.value = []
  embedStatus.value = null
  await loadDoc()
  await loadRelated()
  await loadEmbedStatus()
}, { immediate: true })

/**
 * Renormalise the related score for display. Raw mistral-embed cosines
 * compress into ~[0.65, 0.95] (two unrelated docs already sit at ~0.75), so
 * showing them as-is made everything read "75%+". Map that window onto
 * 0-100% instead. Keep in sync with `server/utils/related-scoring.ts`
 * (DISPLAY_FLOOR / DISPLAY_CEIL).
 */
const SCORE_DISPLAY_FLOOR = 0.65
const SCORE_DISPLAY_CEIL = 0.95

function formatScore(n: number): string {
  const t = (n - SCORE_DISPLAY_FLOOR) / (SCORE_DISPLAY_CEIL - SCORE_DISPLAY_FLOOR)
  return `${Math.round(Math.min(1, Math.max(0, t)) * 100)}%`
}
</script>

<template>
  <!-- Mobile (DocInsightsSheet): natural height, the sheet body scrolls.
       Desktop rail (lg+): the rail is overflow-hidden and this panel is the
       flex-1 block — it owns the leftover height and scrolls internally
       (tab content + related list each scroll on their own; header, tab nav
       and the related card stay pinned). -->
  <aside class="flex h-full w-full flex-col gap-4 overflow-y-auto bg-ink-50/60 p-4 text-sm text-ink-800 dark:bg-ink-900/60 dark:text-ink-200 lg:h-auto lg:min-h-0 lg:flex-1 lg:overflow-hidden">
    <header class="flex shrink-0 items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2">
        <h2 class="font-serif text-base font-semibold text-ink-900 dark:text-ink-50">{{ t('insights.title') }}</h2>
        <!-- Refreshing pill — auto-reanalysis in flight. Does NOT replace
             the existing content; sits beside the heading instead. -->
        <span
          v-if="autoRunning"
          class="label-mono inline-flex items-center gap-1 rounded-full bg-accent-100 px-2 py-0.5 text-[10px] text-accent-800 dark:bg-accent-900/40 dark:text-accent-200"
          :title="t('insights.refreshingTitle')"
        >
          <span class="refresh-dot" aria-hidden="true" />
          {{ t('insights.refreshing') }}
        </span>
        <!-- Stale badge — only when stale AND no auto-run currently in
             progress (avoids stacking with the refreshing pill). -->
        <span
          v-else-if="isStale && hasAnalysis"
          class="label-mono inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
          :title="staleHint ? `${staleHint} — ${t('insights.staleHintSuffix')}` : t('insights.staleHintSuffix')"
        >
          {{ staleHint ?? t('insights.stale') }}
        </span>
      </div>
      <button
        v-if="hasAnalysis"
        :disabled="analyzing"
        class="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-600 hover:bg-ink-100 disabled:opacity-50 dark:border-ink-800 dark:text-ink-300 dark:hover:bg-ink-800"
        @click="runAnalysis()"
      >
        {{ analyzing ? t('insights.analyzing') : t('insights.reanalyze') }}
      </button>
    </header>

    <!-- Embed-status row: visible whenever we have a status payload. -->
    <div
      v-if="embedStatus"
      class="flex shrink-0 items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
      :class="embedStatus.error
        ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200'
        : embedStatus.indexed
          ? 'border-ink-200 bg-ink-50/60 text-ink-600 dark:border-ink-800 dark:bg-ink-800/40 dark:text-ink-300'
          : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200'"
      :title="embedStatus.error
        ? t('insights.index.tooltipError', { detail: embedStatus.error })
        : embedStatus.indexed
          ? t('insights.index.tooltipOk', { n: embedStatus.chunkCount })
          : t('insights.index.tooltipMissing')"
    >
      <span class="inline-flex items-center gap-1.5 min-w-0">
        <span
          class="inline-block h-1.5 w-1.5 rounded-full shrink-0"
          :class="embedStatus.error
            ? 'bg-red-500'
            : embedStatus.indexed
              ? 'bg-emerald-500'
              : 'bg-amber-500'"
          aria-hidden="true"
        />
        <span class="truncate">
          {{ embedStatus.error
            ? t('insights.index.failed')
            : embedStatus.indexed
              ? `${t('insights.index.indexed')} · ${embedStatus.chunkCount}`
              : t('insights.index.notIndexed') }}
        </span>
      </span>
      <button
        type="button"
        :disabled="reindexing"
        class="shrink-0 rounded border border-current/30 px-2 py-0.5 text-[11px] font-medium hover:bg-white/40 disabled:opacity-50 dark:hover:bg-black/20"
        @click="reindex"
      >
        {{ reindexing
          ? t('insights.index.indexing')
          : embedStatus.error
            ? t('insights.index.retry')
            : t('insights.index.reindex') }}
      </button>
    </div>

    <p v-if="error" class="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
      {{ error }}
    </p>

    <div v-if="loading" class="text-ink-400 dark:text-ink-500">{{ t('insights.loading') }}</div>

    <!-- Empty state: prompt to run analysis -->
    <section v-else-if="!hasAnalysis" class="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-ink-200 p-6 text-center dark:border-ink-800">
      <p class="text-ink-600 dark:text-ink-300">{{ t('insights.empty') }}</p>
      <button
        :disabled="analyzing"
        class="rounded-lg bg-accent-500 px-4 py-2 font-medium text-white hover:bg-accent-600 disabled:opacity-50"
        @click="runAnalysis()"
      >
        {{ analyzing ? t('insights.analyzeRunning') : t('insights.analyze') }}
      </button>
    </section>

    <!-- Populated state. Desktop: flex-1 so the analysis block absorbs the
         leftover rail height; the tab nav stays pinned and only the active
         tab's content scrolls. Mobile: plain flow, the sheet scrolls. -->
    <div v-else-if="analysis" class="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
      <!-- Tabs (single row at 378px+ rail) -->
      <nav class="flex shrink-0 flex-nowrap gap-1 overflow-x-auto border-b border-ink-200 text-xs dark:border-ink-800">
        <button
          v-for="tab in tabs"
          :key="tab"
          class="shrink-0 whitespace-nowrap rounded-t-md px-2 py-1 transition-colors"
          :class="activeTab === tab
            ? 'border border-b-transparent border-ink-200 bg-ink-50 font-medium text-ink-900 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-50'
            : 'text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-100'"
          @click="activeTab = tab"
        >
          {{ t(tabLabel[tab]) }}
        </button>
      </nav>

      <!-- Scroll container for the active tab's content (desktop only —
           keeps the tab nav visible no matter how long the content is). -->
      <div class="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">

        <!-- Summary tab -->
        <section v-show="activeTab === 'summary'" class="space-y-3">
          <div>
            <h3 class="label-mono mb-1">{{ t('insights.summary.tldr') }}</h3>
            <p class="text-ink-900 dark:text-ink-100">{{ analysis.summaryShort || '—' }}</p>
          </div>
          <div>
            <h3 class="label-mono mb-1">{{ t('insights.summary.full') }}</h3>
            <p class="whitespace-pre-line text-ink-700 dark:text-ink-200">{{ analysis.summaryLong || '—' }}</p>
          </div>
          <p v-if="analysis.language" class="text-xs text-ink-400 dark:text-ink-500">
            {{ t('insights.summary.language', { lang: analysis.language }) }}
          </p>
        </section>

        <!-- Tags -->
        <section v-show="activeTab === 'tags'" class="flex flex-wrap gap-1.5">
          <span v-if="analysis.tags.length === 0" class="text-ink-400 dark:text-ink-500">{{ t('insights.tags.none') }}</span>
          <span
            v-for="t in analysis.tags"
            :key="t"
            class="rounded-full bg-accent-100 px-2.5 py-0.5 text-xs font-medium text-accent-800 dark:bg-accent-900/40 dark:text-accent-200"
          >
            #{{ t }}
          </span>
        </section>

        <!-- Use cases -->
        <section v-show="activeTab === 'useCases'">
          <ul v-if="analysis.useCases.length" class="space-y-2">
            <li
              v-for="(uc, i) in analysis.useCases"
              :key="i"
              class="flex gap-2 rounded-md bg-white p-2 shadow-sm ring-1 ring-ink-100 dark:bg-ink-800 dark:ring-ink-700/60"
            >
              <span class="text-accent-500">→</span>
              <span class="text-ink-800 dark:text-ink-200">{{ uc }}</span>
            </li>
          </ul>
          <p v-else class="text-ink-400 dark:text-ink-500">{{ t('insights.useCases.none') }}</p>
        </section>

        <!-- Questions -->
        <section v-show="activeTab === 'questions'">
          <ul v-if="analysis.questions.length" class="space-y-2">
            <li v-for="(q, i) in analysis.questions" :key="i">
              <button
                class="w-full rounded-md border border-ink-200 bg-white p-2 text-left text-ink-800 transition hover:border-accent-300 hover:bg-accent-50 dark:border-ink-800 dark:bg-ink-800 dark:text-ink-200 dark:hover:border-accent-500 dark:hover:bg-ink-800/80"
                @click="askQuestion(q)"
              >
                <span class="mr-1 text-accent-500">?</span>{{ q }}
              </button>
            </li>
          </ul>
          <p v-else class="text-ink-400 dark:text-ink-500">{{ t('insights.questions.none') }}</p>
        </section>

        <!-- Action items -->
        <section v-show="activeTab === 'actions'">
          <ul v-if="analysis.actionItems.length" class="space-y-1.5">
            <li
              v-for="(it, i) in analysis.actionItems"
              :key="i"
            >
              <label class="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  :checked="it.done"
                  class="mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-500 focus:ring-accent-400 dark:border-ink-700"
                  @change="toggleActionItem(i)"
                >
                <span
                  class="text-ink-800 dark:text-ink-200"
                  :class="it.done ? 'line-through text-ink-400 dark:text-ink-500' : ''"
                >
                  {{ it.text }}
                </span>
              </label>
            </li>
          </ul>
          <p v-else class="text-ink-400 dark:text-ink-500">{{ t('insights.actions.none') }}</p>
        </section>
      </div>
    </div>

    <!-- Related notes — pinned at the bottom on desktop; the list caps at
         ~2 cards (3rd peeks to signal scrollability) and scrolls inside. -->
    <section class="mt-4 shrink-0 border-t border-ink-200 pt-4 dark:border-ink-800/60">
      <header class="mb-2 flex items-center justify-between">
        <h3 class="font-serif text-sm font-semibold text-ink-900 dark:text-ink-50">{{ t('insights.related.title') }}</h3>
        <button
          class="text-xs text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-100"
          :disabled="loadingRelated"
          @click="loadRelated"
        >
          {{ loadingRelated ? '…' : t('insights.related.refresh') }}
        </button>
      </header>
      <ul v-if="related.length" class="space-y-1.5 lg:max-h-48 lg:overflow-y-auto">
        <li v-for="r in related" :key="r.docId">
          <button
            class="block w-full rounded-md border border-ink-200 bg-white p-2 text-left transition hover:border-accent-300 hover:bg-accent-50 dark:border-ink-800 dark:bg-ink-800 dark:hover:border-accent-500 dark:hover:bg-ink-800/80"
            @click="openRelated(r.docId)"
          >
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate font-medium text-ink-900 dark:text-ink-100">{{ r.title || t('doc.untitled') }}</span>
              <span class="text-xs text-ink-400 dark:text-ink-500">{{ formatScore(r.score) }}</span>
            </div>
            <p class="mt-0.5 line-clamp-2 text-xs text-ink-500 dark:text-ink-400">{{ r.snippet }}</p>
          </button>
        </li>
      </ul>
      <p v-else-if="!loadingRelated" class="text-xs text-ink-400 dark:text-ink-500">
        {{ t('insights.related.empty') }}
      </p>
    </section>
  </aside>
</template>

<style scoped>
/* Tiny pulsing dot for the "Refreshing" pill — signals an auto-reanalysis
   without replacing existing panel content. */
.refresh-dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-accent-500;
  animation: refresh-pulse 1.2s ease-in-out infinite;
}
@keyframes refresh-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
</style>
