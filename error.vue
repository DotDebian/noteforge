<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{
  error: NuxtError
}>()

function handleError() {
  clearError({ redirect: '/' })
}

const statusCode = props.error?.statusCode ?? 500
const statusText = props.error?.statusMessage ?? 'Something went wrong'
const message = props.error?.message ?? 'The page refused to load.'
</script>

<template>
  <div class="err-shell">
    <div class="err-grain" aria-hidden="true" />
    <header class="err-header">
      <NuxtLink to="/" class="wordmark">
        <span class="wordmark-name">NoteForge</span>
        <span class="wordmark-dot" aria-hidden="true" />
      </NuxtLink>
    </header>

    <main class="err-main">
      <div class="err-inner">
        <p class="eyebrow">Error {{ statusCode }}</p>
        <h1 class="title">{{ statusText }}.</h1>
        <p class="message">{{ message }}</p>
        <div class="actions">
          <button type="button" class="primary" @click="handleError">
            Back to safety
          </button>
        </div>
      </div>
    </main>

    <footer class="err-footer">
      <span>An editor for slow thoughts.</span>
    </footer>
  </div>
</template>

<style scoped>
.err-shell {
  @apply relative min-h-full w-full flex flex-col bg-ink-50 dark:bg-ink-950;
}
.err-grain {
  @apply pointer-events-none absolute inset-0;
  background-image: radial-gradient(theme('colors.ink.300') 0.6px, transparent 0.6px);
  background-size: 4px 4px;
  opacity: 0.06;
  mix-blend-mode: multiply;
}
html.dark .err-grain {
  background-image: radial-gradient(theme('colors.ink.500') 0.6px, transparent 0.6px);
  opacity: 0.08;
  mix-blend-mode: screen;
}

.err-header { @apply relative px-10 pt-10; }
.wordmark { @apply inline-flex items-baseline gap-1.5 text-ink-900 dark:text-ink-100; }
.wordmark-name { @apply font-serif text-[1.05rem] tracking-tight; }
.wordmark-dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-accent-500;
  transform: translateY(-1px);
}

.err-main {
  @apply relative flex-1 flex items-center justify-center px-6;
}
.err-inner { @apply max-w-[480px] w-full; }
.eyebrow {
  @apply label-mono mb-4;
}
.title {
  @apply font-serif text-[2.25rem] leading-[1.05] tracking-tight text-ink-900 dark:text-ink-100 mb-3;
}
.message { @apply text-[14px] leading-relaxed text-ink-600 dark:text-ink-300 mb-8; }
.actions { @apply flex items-center gap-3; }
.primary {
  @apply inline-flex items-center justify-center h-10 px-5 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-white;
  background: theme('colors.ink.900');
  transition: background 120ms ease, transform 80ms ease, color 120ms ease;
}
html.dark .primary {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.primary:hover { background: theme('colors.accent.600'); }
html.dark .primary:hover { background: theme('colors.accent.600'); color: theme('colors.ink.50'); }
.primary:active { transform: translateY(1px); }

.err-footer {
  @apply relative px-10 pb-8 label-mono;
}
</style>
