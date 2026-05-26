<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Document } from '~/server/database/schema'
import { useDialog } from '~/composables/useDialog'
import { useMarkdownView } from '~/composables/useMarkdownView'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

const props = defineProps<{
  docId: number
  isOpen: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'restored', doc: Document): void
}>()

const dialog = useDialog()
const { renderMarkdown } = useMarkdownView()

type Reason = 'autosave_snapshot' | 'manual_snapshot' | 'pre_restore'

interface VersionRow {
  id: number
  title: string
  createdAt: string
  reason: Reason
}

interface VersionDetail extends VersionRow {
  markdown: string
  contentJson: string
}

const versions = ref<VersionRow[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const selectedId = ref<number | null>(null)
const detail = ref<VersionDetail | null>(null)
const detailLoading = ref(false)
const restoring = ref(false)
const snapping = ref(false)

const selectedVersion = computed(() =>
  versions.value.find(v => v.id === selectedId.value) ?? null,
)

const renderedMarkdown = computed(() =>
  detail.value ? renderMarkdown(detail.value.markdown || '') : '',
)

function reasonLabel(reason: Reason): string {
  switch (reason) {
    case 'manual_snapshot': return t('history.reason.manual')
    case 'pre_restore': return t('history.reason.pre')
    case 'autosave_snapshot': return t('history.reason.autosave')
  }
}

// One-shot relative-time formatter. Each row is recomputed only when the
// versions list changes — which is exactly the moments where freshness
// matters (after load, after a snapshot). Cheap; no reactivity needed.
function relTime(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('history.rel.justNow')
  if (min < 60) return t('history.rel.minutes', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('history.rel.hours', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('history.rel.days', { n: day })
  return d.toLocaleDateString()
}

async function loadList() {
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<{ versions: VersionRow[] }>(
      `/api/documents/${props.docId}/versions`,
    )
    versions.value = res.versions
    // Auto-select the newest snapshot so the preview pane never starts
    // empty for docs that have history.
    if (versions.value.length > 0) {
      const first = versions.value[0]
      if (first) selectVersion(first.id)
    }
    else {
      selectedId.value = null
      detail.value = null
    }
  }
  catch (e) {
    error.value = (e as Error).message || t('history.errorLoad')
  }
  finally {
    loading.value = false
  }
}

async function selectVersion(id: number) {
  selectedId.value = id
  detail.value = null
  detailLoading.value = true
  try {
    const res = await $fetch<{ version: VersionDetail }>(
      `/api/documents/${props.docId}/versions/${id}`,
    )
    // Only commit if the selection hasn't changed under us.
    if (selectedId.value === id) detail.value = res.version
  }
  catch (e) {
    error.value = (e as Error).message || t('history.errorVersion')
  }
  finally {
    if (selectedId.value === id) detailLoading.value = false
  }
}

async function takeSnapshot() {
  if (snapping.value) return
  snapping.value = true
  error.value = null
  try {
    const res = await $fetch<{ version: VersionRow }>(
      `/api/documents/${props.docId}/versions/snapshot`,
      { method: 'POST' },
    )
    versions.value = [res.version, ...versions.value]
    selectVersion(res.version.id)
  }
  catch (e) {
    error.value = (e as Error).message || t('history.errorSnap')
  }
  finally {
    snapping.value = false
  }
}

async function restoreSelected() {
  if (!selectedId.value || restoring.value) return
  const ok = await dialog.confirm({
    title: t('history.confirmTitle'),
    message: t('history.confirmMsg'),
    confirmLabel: t('history.confirm'),
    destructive: true,
  })
  if (!ok) return
  restoring.value = true
  error.value = null
  try {
    const res = await $fetch<{ document: Document }>(
      `/api/documents/${props.docId}/versions/${selectedId.value}/restore`,
      { method: 'POST' },
    )
    emit('restored', res.document)
    close()
  }
  catch (e) {
    error.value = (e as Error).message || t('history.errorRestore')
  }
  finally {
    restoring.value = false
  }
}

function close() {
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

watch(
  () => props.isOpen,
  (open) => { if (open) loadList() },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div
        v-if="isOpen"
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vh-title"
        @click.self="close"
        @keydown="onKeydown"
      >
        <Transition name="card" appear>
          <div v-if="isOpen" class="card">
            <header class="head">
              <div class="head-text">
                <p class="eyebrow">{{ t('history.eyebrow') }}</p>
                <h2 id="vh-title" class="title">{{ t('history.title') }}</h2>
                <p class="lede">{{ t('history.lede') }}</p>
              </div>
              <button
                type="button"
                class="primary primary--sm"
                :disabled="snapping"
                @click="takeSnapshot"
              >
                {{ snapping ? t('history.saving') : t('history.save') }}
              </button>
            </header>

            <p v-if="error" class="error">{{ error }}</p>

            <section class="body">
              <aside class="timeline" :aria-label="t('history.eyebrow')">
                <p v-if="loading && versions.length === 0" class="muted">{{ t('history.loading') }}</p>
                <p v-else-if="!loading && versions.length === 0" class="muted">
                  {{ t('history.empty') }}
                </p>
                <ul v-else class="rows">
                  <li v-for="v in versions" :key="v.id" class="row">
                    <button
                      type="button"
                      class="row-btn"
                      :class="{ 'row-btn--active': v.id === selectedId }"
                      @click="selectVersion(v.id)"
                    >
                      <span class="row-time">{{ relTime(v.createdAt) }}</span>
                      <span
                        class="row-tag"
                        :class="{
                          'row-tag--manual': v.reason === 'manual_snapshot',
                          'row-tag--pre': v.reason === 'pre_restore',
                        }"
                      >
                        {{ reasonLabel(v.reason) }}
                      </span>
                      <span class="row-title">{{ v.title || t('doc.untitled') }}</span>
                    </button>
                  </li>
                </ul>
              </aside>

              <section class="preview" :aria-label="t('history.title')">
                <div v-if="detailLoading" class="muted">{{ t('history.previewLoading') }}</div>
                <div v-else-if="!detail && !loading" class="muted">
                  {{ t('history.previewSelect') }}
                </div>
                <article v-else-if="detail" class="preview-doc">
                  <h3 class="preview-title">{{ detail.title || t('doc.untitled') }}</h3>
                  <div class="preview-md" v-html="renderedMarkdown" />
                </article>
              </section>
            </section>

            <footer class="foot">
              <button type="button" class="ghost-btn" @click="close">{{ t('history.close') }}</button>
              <button
                type="button"
                class="primary"
                :disabled="!selectedVersion || restoring || detailLoading"
                @click="restoreSelected"
              >
                {{ restoring ? t('history.restoring') : t('history.restore') }}
              </button>
            </footer>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center px-6 py-10;
  background: theme('colors.ink.900' / 35%);
  backdrop-filter: blur(4px);
}
html.dark .overlay {
  background: theme('colors.ink.950' / 70%);
}

.card {
  @apply relative w-full max-w-[920px] rounded-lg bg-ink-50 dark:bg-ink-900 px-8 py-7 flex flex-col;
  height: min(720px, calc(100vh - 5rem));
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
}
html.dark .card {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}

.head { @apply flex items-start justify-between gap-6 mb-4 pb-4 border-b border-ink-200/60; }
html.dark .head { border-bottom-color: theme('colors.ink.800' / 60%); }
.head-text { @apply flex-1 min-w-0; }
.eyebrow { @apply label-mono mb-3; }
.title {
  @apply font-serif text-[1.55rem] leading-[1.15] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.lede { @apply text-[13px] leading-relaxed text-ink-600 dark:text-ink-300 max-w-[60ch]; }

.error {
  @apply font-sans text-[12px] text-accent-700 dark:text-accent-300 mb-3;
}

.body { @apply flex-1 min-h-0 grid gap-6 mb-4; grid-template-columns: 260px 1fr; }

.timeline {
  @apply min-h-0 overflow-auto pr-2;
  border-right: 1px solid theme('colors.ink.200' / 60%);
}
html.dark .timeline { border-right-color: theme('colors.ink.800' / 60%); }

.rows { @apply flex flex-col gap-1 list-none p-0 m-0; }
.row { @apply m-0; }
.row-btn {
  @apply w-full text-left px-3 py-2 rounded flex flex-col gap-1 transition-colors;
  background: transparent;
  border: 1px solid transparent;
}
.row-btn:hover {
  background: theme('colors.ink.100' / 60%);
}
html.dark .row-btn:hover { background: theme('colors.ink.800' / 60%); }
.row-btn--active,
.row-btn--active:hover {
  background: theme('colors.ink.100');
  border-color: theme('colors.ink.200');
}
html.dark .row-btn--active,
html.dark .row-btn--active:hover {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
}

.row-time {
  @apply font-sans text-[12px] font-semibold text-ink-800 dark:text-ink-100;
}
.row-tag {
  @apply inline-flex w-fit items-center px-1.5 py-0.5 rounded font-sans uppercase text-[9px] font-semibold tracking-[0.1em] text-ink-600 dark:text-ink-300;
  background: theme('colors.ink.100');
}
html.dark .row-tag { background: theme('colors.ink.800'); }
.row-tag--manual {
  background: theme('colors.accent.100');
  color: theme('colors.accent.700');
}
html.dark .row-tag--manual {
  background: theme('colors.accent.900' / 40%);
  color: theme('colors.accent.300');
}
.row-tag--pre {
  background: theme('colors.amber.100');
  color: theme('colors.amber.700');
}
html.dark .row-tag--pre {
  background: theme('colors.amber.900' / 40%);
  color: theme('colors.amber.300');
}
.row-title {
  @apply text-[12px] text-ink-500 dark:text-ink-400 truncate;
}

.preview { @apply min-h-0 overflow-auto pr-2; }
.muted { @apply text-[13px] text-ink-500 dark:text-ink-400 py-3; }
.preview-doc { @apply max-w-[60ch]; }
.preview-title {
  @apply font-serif text-[1.25rem] leading-tight text-ink-900 dark:text-ink-100 mb-4;
}
.preview-md {
  @apply font-serif text-[14px] leading-[1.7] text-ink-800 dark:text-ink-200;
}
.preview-md :deep(h1),
.preview-md :deep(h2),
.preview-md :deep(h3) {
  @apply font-serif font-semibold text-ink-900 dark:text-ink-100 mt-5 mb-2;
}
.preview-md :deep(h1) { @apply text-[1.4rem]; }
.preview-md :deep(h2) { @apply text-[1.2rem]; }
.preview-md :deep(h3) { @apply text-[1.05rem]; }
.preview-md :deep(p) { @apply mb-3; }
.preview-md :deep(ul),
.preview-md :deep(ol) { @apply pl-6 mb-3; }
.preview-md :deep(li) { @apply mb-1; }
.preview-md :deep(code) {
  @apply font-mono text-[12.5px] px-1 py-0.5 rounded;
  background: theme('colors.ink.100');
}
html.dark .preview-md :deep(code) { background: theme('colors.ink.800'); }
.preview-md :deep(pre) {
  @apply font-mono text-[12.5px] p-3 rounded overflow-auto mb-3;
  background: theme('colors.ink.100');
}
html.dark .preview-md :deep(pre) { background: theme('colors.ink.800'); }
.preview-md :deep(blockquote) {
  @apply pl-3 italic text-ink-600 dark:text-ink-300 my-3;
  border-left: 2px solid theme('colors.ink.300');
}
html.dark .preview-md :deep(blockquote) { border-left-color: theme('colors.ink.700'); }
.preview-md :deep(a) {
  @apply text-accent-700 dark:text-accent-300 underline;
}

.foot { @apply flex items-center justify-end gap-3 pt-2; }

.primary {
  @apply inline-flex items-center justify-center h-10 px-5 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-white;
  background: theme('colors.ink.900');
  transition: background 120ms ease, color 120ms ease;
}
html.dark .primary {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.primary:hover:not(:disabled) { background: theme('colors.accent.600'); }
html.dark .primary:hover:not(:disabled) { background: theme('colors.accent.600'); color: theme('colors.ink.50'); }
.primary:disabled { opacity: 0.55; cursor: not-allowed; }
.primary--sm { @apply h-8 px-3 text-[10px] tracking-[0.1em]; }

.ghost-btn {
  @apply inline-flex items-center justify-center h-10 px-4 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-ink-700 dark:text-ink-200;
  border: 1px solid theme('colors.ink.200');
  background: transparent;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
html.dark .ghost-btn { border-color: theme('colors.ink.800'); }
.ghost-btn:hover {
  background: theme('colors.ink.100');
  border-color: theme('colors.ink.300');
  color: theme('colors.ink.900');
}
html.dark .ghost-btn:hover {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.50');
}

.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
.card-enter-from { opacity: 0; transform: translateY(8px) scale(0.98); }
.card-enter-to { opacity: 1; transform: translateY(0) scale(1); }
.card-enter-active { transition: opacity 160ms ease, transform 160ms ease; }
</style>
