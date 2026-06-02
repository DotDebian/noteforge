<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

const props = defineProps<{
  docId: number
  isOpen: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'shares-changed', count: number): void
}>()

interface ShareRow {
  id: string
  prefix: string | null
  createdAt: string
  expiresAt: string | null
}

const shares = ref<ShareRow[]>([])
const loading = ref(false)
const creating = ref(false)
const error = ref<string | null>(null)
const expiryChoice = ref<'never' | '1' | '7' | '30'>('never')

// The freshly-minted link (relative URL). Shown exactly once — the server
// stores only the token's hash, so re-opening the dialog can never reproduce
// it. Cleared when the dialog closes or a new link is created.
const newLink = ref<string | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const origin = computed(() =>
  typeof window === 'undefined' ? '' : window.location.origin,
)
const newLinkUrl = computed(() =>
  newLink.value ? `${origin.value}${newLink.value}` : '',
)

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<{ shares: ShareRow[] }>(
      `/api/documents/${props.docId}/shares`,
    )
    shares.value = res.shares
    emit('shares-changed', shares.value.length)
  }
  catch (e) {
    error.value = (e as Error).message || t('share.errorLoad')
  }
  finally {
    loading.value = false
  }
}

async function createLink() {
  if (creating.value) return
  creating.value = true
  error.value = null
  try {
    const body: { expiresInDays?: number } = {}
    if (expiryChoice.value !== 'never') {
      body.expiresInDays = Number(expiryChoice.value)
    }
    const res = await $fetch<{ token: string, url: string }>(
      `/api/documents/${props.docId}/share`,
      { method: 'POST', body },
    )
    newLink.value = res.url
    // Refresh from server so createdAt / expiresAt / prefix are canonical.
    await load()
    // Auto-copy the freshly-minted URL — common share-flow pattern.
    try {
      await navigator.clipboard.writeText(`${origin.value}${res.url}`)
      flashCopied()
    }
    catch {
      // Clipboard write can fail in non-secure contexts. Silently ignore.
    }
  }
  catch (e) {
    error.value = (e as Error).message || t('share.errorCreate')
  }
  finally {
    creating.value = false
  }
}

async function revoke(id: string) {
  error.value = null
  try {
    await $fetch(`/api/documents/${props.docId}/share/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    shares.value = shares.value.filter(s => s.id !== id)
    emit('shares-changed', shares.value.length)
  }
  catch (e) {
    error.value = (e as Error).message || t('share.errorRevoke')
  }
}

async function copyNew() {
  if (!newLinkUrl.value) return
  try {
    await navigator.clipboard.writeText(newLinkUrl.value)
    flashCopied()
  }
  catch {
    // No-op; the input is also selectable.
  }
}

function flashCopied() {
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1500)
}

function close() {
  newLink.value = null
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

// Load whenever the dialog opens (and the docId is set). We don't preload
// on mount — share-link existence isn't shown in the doc header until a
// link is created in-session, so the dialog is the canonical place.
watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      newLink.value = null
      load()
    }
  },
)

function formatExpiry(iso: string | null): string {
  if (!iso) return t('share.expiry.never')
  const d = new Date(iso)
  const now = Date.now()
  const diffDays = Math.round((d.getTime() - now) / (24 * 60 * 60 * 1000))
  if (diffDays <= 0) return t('share.expiry.expired')
  if (diffDays === 1) return t('share.expiry.in1Day')
  if (diffDays < 30) return t('share.expiry.inDays', { n: diffDays })
  return d.toLocaleDateString()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div
        v-if="isOpen"
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        @click.self="close"
        @keydown="onKeydown"
      >
        <Transition name="card" appear>
          <div v-if="isOpen" class="card">
            <header class="head">
              <p class="eyebrow">{{ t('share.eyebrow') }}</p>
              <h2 id="share-dialog-title" class="title">{{ t('share.title') }}</h2>
              <p class="lede">{{ t('share.lede') }}</p>
            </header>

            <section class="create">
              <label class="field">
                <span class="label">{{ t('share.expires') }}</span>
                <select v-model="expiryChoice" class="select">
                  <option value="never">{{ t('share.expires.never') }}</option>
                  <option value="1">{{ t('share.expires.1') }}</option>
                  <option value="7">{{ t('share.expires.7') }}</option>
                  <option value="30">{{ t('share.expires.30') }}</option>
                </select>
              </label>
              <button
                type="button"
                class="primary"
                :disabled="creating"
                @click="createLink"
              >
                <span v-if="!creating">{{ t('share.createLink') }}</span>
                <span v-else>{{ t('share.creating') }}</span>
              </button>
            </section>

            <p v-if="error" class="error">{{ error }}</p>

            <section v-if="newLink" class="new-link">
              <p class="new-link-note">{{ t('share.showOnce') }}</p>
              <div class="row-main">
                <input
                  :value="newLinkUrl"
                  readonly
                  class="row-input"
                  :title="newLinkUrl"
                  @focus="($event.target as HTMLInputElement).select()"
                />
                <button
                  type="button"
                  class="ghost-btn ghost-btn--sm"
                  @click="copyNew"
                >
                  {{ copied ? t('share.copied') : t('share.copy') }}
                </button>
              </div>
            </section>

            <section class="list" :aria-label="t('share.eyebrow')">
              <p v-if="loading && shares.length === 0" class="muted">{{ t('share.loading') }}</p>
              <p v-else-if="!loading && shares.length === 0" class="muted">
                {{ t('share.noLinks') }}
              </p>
              <ul v-else class="rows">
                <li v-for="s in shares" :key="s.id" class="row">
                  <div class="row-main">
                    <span class="row-handle" :title="t('share.linkHiddenTitle')">
                      {{ s.prefix ? `${s.prefix}…` : t('share.linkHandleFallback') }}
                    </span>
                    <div class="row-actions">
                      <button
                        type="button"
                        class="ghost-btn ghost-btn--sm ghost-btn--danger"
                        @click="revoke(s.id)"
                      >
                        {{ t('share.revoke') }}
                      </button>
                    </div>
                  </div>
                  <div class="row-meta">
                    {{ t('share.expiresLabel', { when: formatExpiry(s.expiresAt) }) }}
                  </div>
                </li>
              </ul>
            </section>

            <footer class="foot">
              <button type="button" class="ghost-btn" @click="close">{{ t('share.close') }}</button>
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
  @apply relative w-full max-w-[520px] rounded-lg bg-ink-50 dark:bg-ink-900 px-8 py-7;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
}
html.dark .card {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}

.head { @apply mb-5; }
.eyebrow { @apply label-mono mb-3; }
.title {
  @apply font-serif text-[1.55rem] leading-[1.15] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.lede { @apply text-[13px] leading-relaxed text-ink-600 dark:text-ink-300; }

.create {
  @apply flex items-end gap-3 mb-4 pb-4 border-b border-ink-200/60;
}
html.dark .create { border-bottom-color: theme('colors.ink.800' / 60%); }

.field { @apply flex flex-col gap-1.5 flex-1; }
.label { @apply label-mono; }
.select {
  @apply h-10 px-3 rounded bg-transparent text-[14px] text-ink-900 dark:text-ink-100;
  border: 1px solid theme('colors.ink.200');
  outline: none;
  transition: border-color 140ms ease;
}
html.dark .select { border-color: theme('colors.ink.800'); }
.select:focus { border-color: theme('colors.ink.900'); }
html.dark .select:focus { border-color: theme('colors.ink.100'); }

.error {
  @apply font-sans text-[12px] text-accent-700 dark:text-accent-300 mb-3;
}

.new-link {
  @apply rounded p-3 mb-4;
  border: 1px solid theme('colors.accent.300');
  background: theme('colors.accent.50' / 60%);
}
html.dark .new-link {
  border-color: theme('colors.accent.600');
  background: theme('colors.accent.600' / 12%);
}
.new-link-note {
  @apply font-sans text-[12px] leading-relaxed text-ink-700 dark:text-ink-200 mb-2;
}

.list { @apply mb-5; }
.muted { @apply text-[13px] text-ink-500 dark:text-ink-400 py-3; }
.row-handle {
  @apply flex-1 min-w-0 truncate font-mono text-[12px] text-ink-600 dark:text-ink-300;
}
.rows { @apply flex flex-col gap-3 list-none p-0 m-0; }
.row {
  @apply rounded p-3;
  border: 1px solid theme('colors.ink.200');
}
html.dark .row { border-color: theme('colors.ink.800'); }
.row-main { @apply flex items-center gap-2; }
.row-input {
  @apply flex-1 min-w-0 h-9 px-2 rounded font-mono text-[12px] bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-100;
  border: 1px solid transparent;
  outline: none;
}
.row-input:focus { border-color: theme('colors.ink.300'); }
html.dark .row-input:focus { border-color: theme('colors.ink.700'); }
.row-actions { @apply flex items-center gap-2; }
.row-meta {
  @apply mt-2 font-sans uppercase text-[10px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
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
.ghost-btn--sm { @apply h-8 px-3 text-[10px]; }
.ghost-btn--danger:hover {
  color: theme('colors.accent.700');
  border-color: theme('colors.accent.300');
}
html.dark .ghost-btn--danger:hover {
  color: theme('colors.accent.300');
  border-color: theme('colors.accent.600');
}

.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
.card-enter-from { opacity: 0; transform: translateY(8px) scale(0.98); }
.card-enter-to { opacity: 1; transform: translateY(0) scale(1); }
.card-enter-active { transition: opacity 160ms ease, transform 160ms ease; }
</style>
