<script setup lang="ts">
import { useLocale } from '~/composables/useLocale'
import LangToggle from '~/components/LangToggle.vue'
import ThemeToggle from '~/components/ThemeToggle.vue'

const { t } = useLocale()
</script>

<template>
  <div class="auth-shell">
    <div class="auth-grain" aria-hidden="true" />
    <header class="auth-header">
      <NuxtLink to="/" class="wordmark">
        <span class="wordmark-name">NoteForge</span>
        <span class="wordmark-dot" aria-hidden="true" />
      </NuxtLink>
      <div class="auth-controls">
        <LangToggle />
        <ThemeToggle />
      </div>
    </header>

    <main class="auth-main">
      <slot />
    </main>

    <footer class="auth-footer">
      <span>{{ t('auth.layout.footer') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.auth-shell {
  @apply relative min-h-full w-full flex flex-col;
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, theme('colors.ink.100') 0%, transparent 70%),
    linear-gradient(180deg, theme('colors.ink.50') 0%, theme('colors.ink.50') 100%);
}
html.dark .auth-shell {
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, theme('colors.ink.900') 0%, transparent 70%),
    linear-gradient(180deg, theme('colors.ink.950') 0%, theme('colors.ink.950') 100%);
}

.auth-grain {
  @apply pointer-events-none absolute inset-0;
  background-image:
    radial-gradient(theme('colors.ink.300') 0.6px, transparent 0.6px);
  background-size: 4px 4px;
  opacity: 0.06;
  mix-blend-mode: multiply;
}
html.dark .auth-grain {
  background-image:
    radial-gradient(theme('colors.ink.500') 0.6px, transparent 0.6px);
  opacity: 0.08;
  mix-blend-mode: screen;
}

.auth-header {
  @apply relative px-10 pt-10 pb-2 flex items-center justify-between;
}
.auth-controls {
  @apply flex items-center gap-1;
}

.wordmark {
  @apply inline-flex items-baseline gap-1.5 text-ink-900 dark:text-ink-100;
}
.wordmark-name {
  @apply font-serif text-[1.05rem] tracking-tight;
}
.wordmark-dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-accent-500;
  transform: translateY(-1px);
}

.auth-main {
  @apply relative flex-1 flex items-center justify-center px-6 pb-10;
}

.auth-footer {
  @apply relative px-10 pb-8 label-mono;
}
</style>
