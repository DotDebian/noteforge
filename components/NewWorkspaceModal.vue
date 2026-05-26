<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', id: number): void
}>()

const router = useRouter()
const workspaces = useWorkspacesStore()

const name = ref('')
const emoji = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

const SUGGESTED_EMOJI = ['§', '✶', '◌', '✷', '⌘', '☘︎', '★', '✦']

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      name.value = ''
      emoji.value = ''
      error.value = null
      await nextTick()
      nameInput.value?.focus()
    }
  },
)

function close() {
  if (submitting.value) return
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

async function onSubmit() {
  const trimmed = name.value.trim()
  if (!trimmed || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const ws = await workspaces.create(trimmed, emoji.value || undefined)
    emit('created', ws.id)
    emit('close')
    await router.push(`/w/${ws.id}`)
  }
  catch (e) {
    error.value = (e as Error).message || t('workspace.new.errorGeneric')
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div
        v-if="open"
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-workspace-title"
        @click.self="close"
        @keydown="onKeydown"
      >
        <Transition name="card" appear>
          <div v-if="open" class="card">
            <header class="head">
              <p class="eyebrow">{{ t('workspace.new.eyebrow') }}</p>
              <h2 id="new-workspace-title" class="title">{{ t('workspace.new.title') }}</h2>
              <p class="lede">{{ t('workspace.new.lede') }}</p>
            </header>

            <form class="form" @submit.prevent="onSubmit">
              <label class="field">
                <span class="label">{{ t('workspace.new.name') }}</span>
                <input
                  ref="nameInput"
                  v-model="name"
                  type="text"
                  required
                  maxlength="120"
                  :placeholder="t('workspace.new.namePlaceholder')"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>

              <fieldset class="field">
                <legend class="label">{{ t('workspace.new.glyph') }}</legend>
                <div class="emoji-grid">
                  <button
                    v-for="g in SUGGESTED_EMOJI"
                    :key="g"
                    type="button"
                    class="emoji-btn"
                    :class="{ 'emoji-btn--active': emoji === g }"
                    @click="emoji = emoji === g ? '' : g"
                  >
                    {{ g }}
                  </button>
                  <input
                    v-model="emoji"
                    type="text"
                    maxlength="4"
                    placeholder="✎"
                    class="emoji-custom"
                    :aria-label="t('workspace.new.glyphPlaceholder')"
                  />
                </div>
              </fieldset>

              <p v-if="error" class="error">{{ error }}</p>

              <div class="actions">
                <button type="button" class="ghost-btn" :disabled="submitting" @click="close">
                  {{ t('workspace.new.cancel') }}
                </button>
                <button type="submit" class="primary" :disabled="submitting || !name.trim()">
                  <span v-if="!submitting">{{ t('workspace.new.create') }}</span>
                  <span v-else>{{ t('workspace.new.creating') }}</span>
                </button>
              </div>
            </form>
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
  @apply relative w-full max-w-[440px] rounded-lg bg-ink-50 dark:bg-ink-900 px-8 py-7;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
}
html.dark .card {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}

.head { @apply mb-6; }
.eyebrow {
  @apply label-mono mb-3;
}
.title {
  @apply font-serif text-[1.7rem] leading-[1.1] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.lede {
  @apply text-[13px] leading-relaxed text-ink-600 dark:text-ink-300;
}

.form { @apply flex flex-col gap-5; }
.field { @apply flex flex-col gap-2 border-0 p-0; }
.label {
  @apply label-mono;
}
.field input[type="text"] {
  @apply bg-transparent border-0 border-b border-ink-300 dark:border-ink-700 px-0 py-2 text-[15px] text-ink-900 dark:text-ink-100;
  outline: none;
  transition: border-color 140ms ease;
}
.field input[type="text"]::placeholder { @apply text-ink-300 dark:text-ink-600; }
.field input[type="text"]:focus { @apply border-ink-900; }
html.dark .field input[type="text"]:focus { border-color: theme('colors.ink.100'); }

.emoji-grid {
  @apply flex flex-wrap items-center gap-1.5;
}
.emoji-btn {
  @apply inline-flex items-center justify-center h-8 w-8 rounded text-[15px] text-ink-700 dark:text-ink-200;
  border: 1px solid theme('colors.ink.200');
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
html.dark .emoji-btn {
  border-color: theme('colors.ink.800');
}
.emoji-btn:hover {
  background: theme('colors.ink.100');
  border-color: theme('colors.ink.300');
}
html.dark .emoji-btn:hover {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
}
.emoji-btn--active {
  background: theme('colors.ink.900');
  color: white;
  border-color: theme('colors.ink.900');
}
html.dark .emoji-btn--active {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  border-color: theme('colors.ink.100');
}
.emoji-custom {
  @apply h-8 w-12 rounded text-center text-[15px] text-ink-900 dark:text-ink-100;
  border: 1px solid theme('colors.ink.200');
  background: transparent;
  outline: none;
  transition: border-color 140ms ease;
}
html.dark .emoji-custom { border-color: theme('colors.ink.800'); }
.emoji-custom:focus { border-color: theme('colors.ink.900'); }
html.dark .emoji-custom:focus { border-color: theme('colors.ink.100'); }

.actions {
  @apply flex items-center justify-end gap-3 pt-2;
}

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
.ghost-btn:hover:not(:disabled) {
  background: theme('colors.ink.100');
  border-color: theme('colors.ink.300');
  color: theme('colors.ink.900');
}
html.dark .ghost-btn:hover:not(:disabled) {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.50');
}
.ghost-btn:disabled { opacity: 0.55; cursor: not-allowed; }

.error {
  @apply font-sans text-[12px] text-accent-700 dark:text-accent-300;
}

/* Transitions */
.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
.card-enter-from { opacity: 0; transform: translateY(8px) scale(0.98); }
.card-enter-to { opacity: 1; transform: translateY(0) scale(1); }
.card-enter-active { transition: opacity 160ms ease, transform 160ms ease; }
</style>
