<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useDialogStore } from '~/stores/dialog'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

const store = useDialogStore()
const { open, kind, title, message, defaultValue, placeholder, confirmLabel, cancelLabel, destructive, multiline } = storeToRefs(store)

const eyebrowText = computed(() => {
  if (kind.value === 'confirm') return destructive.value ? t('dialog.eyebrow.destructive') : t('dialog.eyebrow.confirm')
  if (kind.value === 'prompt') return t('dialog.eyebrow.prompt')
  return t('dialog.eyebrow.alert')
})

const localizedConfirm = computed(() => {
  const v = confirmLabel.value
  // Map the store's English defaults to localized fallbacks; pass-through anything else.
  if (v === 'Confirm') return t('dialog.confirm')
  if (v === 'OK') return t('dialog.ok')
  return v
})
const localizedCancel = computed(() => {
  const v = cancelLabel.value
  if (v === 'Cancel') return t('dialog.cancel')
  return v
})

const value = ref('')
const inputEl = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

watch(open, async (isOpen) => {
  if (isOpen) {
    value.value = defaultValue.value
    await nextTick()
    inputEl.value?.focus()
    if (inputEl.value instanceof HTMLInputElement) inputEl.value.select()
  }
})

function onConfirm() {
  if (kind.value === 'prompt') {
    store.resolve(value.value.trim())
  }
  else {
    store.resolve(true)
  }
}

function onCancel() {
  store.cancel()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    onCancel()
    return
  }
  if (e.key === 'Enter') {
    // For prompt + non-multiline, Enter submits. Same for confirm/alert.
    if (kind.value === 'prompt' && multiline.value) return
    if (kind.value === 'prompt') {
      e.preventDefault()
    }
    onConfirm()
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
        :aria-labelledby="`dialog-title-${kind}`"
        @click.self="onCancel"
        @keydown="onKeydown"
      >
        <Transition name="card" appear>
          <div v-if="open" class="card">
            <header class="head">
              <p class="eyebrow">
                {{ eyebrowText }}
              </p>
              <h2 :id="`dialog-title-${kind}`" class="title">{{ title }}</h2>
              <p v-if="message" class="lede">{{ message }}</p>
            </header>

            <div v-if="kind === 'prompt'" class="body">
              <input
                v-if="!multiline"
                ref="inputEl"
                v-model="value"
                type="text"
                class="prompt-input"
                :placeholder="placeholder"
                autocomplete="off"
                spellcheck="false"
              />
              <textarea
                v-else
                ref="inputEl"
                v-model="value"
                class="prompt-textarea"
                :placeholder="placeholder"
                rows="4"
                spellcheck="false"
              />
            </div>

            <div class="actions">
              <button
                v-if="kind !== 'alert'"
                type="button"
                class="btn btn-ghost"
                @click="onCancel"
              >
                {{ localizedCancel }}
              </button>
              <button
                type="button"
                class="btn"
                :class="destructive ? 'btn-danger' : 'btn-primary'"
                @click="onConfirm"
              >
                {{ localizedConfirm }}
              </button>
            </div>
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
  @apply relative w-full max-w-[440px] rounded-lg bg-ink-50 dark:bg-ink-900 px-7 py-6;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
}
html.dark .card {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}

.head { @apply mb-5; }
.eyebrow {
  @apply label-mono mb-2;
}
.title {
  @apply font-serif text-[1.45rem] leading-[1.15] tracking-tight text-ink-900 dark:text-ink-50 mb-2;
}
.lede {
  @apply text-[13px] leading-relaxed text-ink-600 dark:text-ink-300;
}

.body { @apply mb-5; }

.prompt-input,
.prompt-textarea {
  @apply w-full bg-transparent border-0 border-b border-ink-300 dark:border-ink-700 px-0 py-2 text-[15px] text-ink-900 dark:text-ink-50;
  outline: none;
  transition: border-color 140ms ease;
}
.prompt-input::placeholder,
.prompt-textarea::placeholder { @apply text-ink-300 dark:text-ink-600; }
.prompt-input:focus,
.prompt-textarea:focus { @apply border-ink-900; }
html.dark .prompt-input:focus,
html.dark .prompt-textarea:focus { border-color: theme('colors.ink.100'); }

.prompt-textarea { @apply resize-y; }

.actions {
  @apply flex items-center justify-end gap-3;
}

.btn {
  @apply inline-flex items-center justify-center h-10 px-5 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.1em];
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}

.btn-ghost {
  @apply text-ink-700 dark:text-ink-200 bg-transparent;
  border: 1px solid theme('colors.ink.200');
}
html.dark .btn-ghost { border-color: theme('colors.ink.800'); }
.btn-ghost:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
  border-color: theme('colors.ink.300');
}
html.dark .btn-ghost:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
  border-color: theme('colors.ink.700');
}

.btn-primary {
  background: theme('colors.ink.900');
  color: white;
}
html.dark .btn-primary {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
.btn-primary:hover { background: theme('colors.accent.600'); color: white; }
html.dark .btn-primary:hover { background: theme('colors.accent.600'); color: theme('colors.ink.50'); }

.btn-danger {
  background: theme('colors.accent.700');
  color: white;
}
html.dark .btn-danger {
  background: theme('colors.accent.700');
  color: theme('colors.ink.50');
}
.btn-danger:hover { background: theme('colors.accent.800'); }
html.dark .btn-danger:hover { background: theme('colors.accent.600'); }

/* Transitions */
.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
.card-enter-from { opacity: 0; transform: translateY(8px) scale(0.98); }
.card-enter-to { opacity: 1; transform: translateY(0) scale(1); }
.card-enter-active { transition: opacity 160ms ease, transform 160ms ease; }
</style>
