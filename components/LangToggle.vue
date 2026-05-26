<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '~/composables/useLocale'

const { isFr, t, toggle } = useLocale()

// The flag shown is the language we'd switch TO when clicked.
const nextLabel = computed(() => (isFr.value ? t('lang.en') : t('lang.fr')))
const title = computed(() => `${t('lang.switch')} — ${nextLabel.value}`)
</script>

<template>
  <button
    type="button"
    class="lang-toggle"
    :title="title"
    :aria-label="title"
    @click="toggle()"
  >
    <!-- Show the flag for the OTHER locale: clicking it switches to that one. -->
    <svg
      v-if="!isFr"
      viewBox="0 0 18 12"
      width="18"
      height="12"
      aria-hidden="true"
      class="flag"
    >
      <!-- Drapeau français : bleu / blanc / rouge -->
      <rect x="0" y="0" width="6" height="12" fill="#0055A4" />
      <rect x="6" y="0" width="6" height="12" fill="#FFFFFF" />
      <rect x="12" y="0" width="6" height="12" fill="#EF4135" />
      <rect
        x="0.4"
        y="0.4"
        width="17.2"
        height="11.2"
        fill="none"
        stroke="currentColor"
        stroke-opacity="0.18"
        stroke-width="0.8"
      />
    </svg>
    <svg
      v-else
      viewBox="0 0 18 12"
      width="18"
      height="12"
      aria-hidden="true"
      class="flag"
    >
      <!-- Union Jack simplified -->
      <rect x="0" y="0" width="18" height="12" fill="#012169" />
      <!-- Diagonal white saltire -->
      <path d="M0 0 L18 12 M18 0 L0 12" stroke="#FFFFFF" stroke-width="2.4" />
      <!-- Diagonal red saltire (offset for proper UK look) -->
      <path d="M0 0 L18 12" stroke="#C8102E" stroke-width="1" />
      <path d="M18 0 L0 12" stroke="#C8102E" stroke-width="1" />
      <!-- White cross -->
      <path d="M9 0 V12 M0 6 H18" stroke="#FFFFFF" stroke-width="3" />
      <!-- Red cross -->
      <path d="M9 0 V12 M0 6 H18" stroke="#C8102E" stroke-width="1.6" />
      <rect
        x="0.4"
        y="0.4"
        width="17.2"
        height="11.2"
        fill="none"
        stroke="currentColor"
        stroke-opacity="0.18"
        stroke-width="0.8"
      />
    </svg>
  </button>
</template>

<style scoped>
.lang-toggle {
  @apply inline-flex items-center justify-center h-6 w-6 rounded text-ink-500;
  transition: background 120ms ease, color 120ms ease;
}
.lang-toggle:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .lang-toggle {
  @apply text-ink-300;
}
html.dark .lang-toggle:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
.flag {
  border-radius: 1.5px;
  display: block;
}
</style>
