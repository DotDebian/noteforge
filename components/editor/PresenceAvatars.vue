<script setup lang="ts">
import { computed } from 'vue'
import type { CollabPeer } from '~/composables/useCollab'
import { initialsFor } from '~/utils/collab'
import { useLocale } from '~/composables/useLocale'

/**
 * Who's in the live session — a stack of initials in each user's cursor
 * colour, self first. Rendered in the doc header next to "edited X ago".
 */
const props = defineProps<{ peers: CollabPeer[] }>()
const { t } = useLocale()

const MAX_SHOWN = 4
const shown = computed(() => props.peers.slice(0, MAX_SHOWN))
const overflow = computed(() => props.peers.slice(MAX_SHOWN))

function tooltip(p: CollabPeer): string {
  const tags = [
    p.isSelf ? t('doc.collab.you') : null,
    p.canEdit ? null : t('doc.collab.viewer'),
  ].filter(Boolean)
  return tags.length ? `${p.name} (${tags.join(', ')})` : p.name
}
</script>

<template>
  <div class="presence" role="list">
    <span
      v-for="p in shown"
      :key="p.id"
      role="listitem"
      class="presence-avatar"
      :class="{ 'presence-avatar--viewer': !p.canEdit }"
      :style="{ backgroundColor: p.color }"
      :title="tooltip(p)"
      :aria-label="tooltip(p)"
    >{{ initialsFor(p.name) }}</span>
    <span
      v-if="overflow.length"
      role="listitem"
      class="presence-avatar presence-avatar--more"
      :title="overflow.map(tooltip).join('\n')"
    >+{{ overflow.length }}</span>
  </div>
</template>

<style scoped>
.presence {
  @apply mr-2 flex items-center;
}
.presence-avatar {
  @apply -ml-1.5 flex h-6 w-6 select-none items-center justify-center rounded-full text-[10px] font-semibold normal-case tracking-normal text-white ring-2 ring-ink-50 first:ml-0;
}
html.dark .presence-avatar {
  --tw-ring-color: theme('colors.ink.950');
}
.presence-avatar--viewer {
  opacity: 0.6;
}
.presence-avatar--more {
  @apply bg-ink-300 text-ink-800;
}
html.dark .presence-avatar--more {
  @apply bg-ink-700 text-ink-100;
}
</style>
