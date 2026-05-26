<script setup lang="ts">
import { useTheme } from '~/composables/useTheme'
import { useLocale } from '~/composables/useLocale'

const { isDark, toggle } = useTheme()
const { t } = useLocale()
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :title="isDark ? t('theme.toLight') : t('theme.toDark')"
    :aria-pressed="isDark"
    @click="toggle()"
  >
    <svg v-if="!isDark" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <!-- crescent moon -->
      <path
        d="M11 2a6 6 0 1 0 3 8 5 5 0 0 1-3-8z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </svg>
    <svg v-else viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <!-- sun -->
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.2" />
      <path
        d="M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.2 3.2l1.4 1.4 M11.4 11.4l1.4 1.4 M3.2 12.8l1.4-1.4 M11.4 4.6l1.4-1.4"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
    </svg>
  </button>
</template>

<style scoped>
.theme-toggle {
  @apply inline-flex items-center justify-center h-6 w-6 rounded text-ink-500;
  transition: background 120ms ease, color 120ms ease;
}
.theme-toggle:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .theme-toggle {
  @apply text-ink-300;
}
html.dark .theme-toggle:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
</style>
