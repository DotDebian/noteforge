<script setup lang="ts">
import { computed } from 'vue'
import { useTreeStore } from '~/stores/tree'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useNewDocShortcut } from '~/composables/usePlatform'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()
useHead(() => ({ title: t('doc.head.workspace') }))

const route = useRoute()
const treeStore = useTreeStore()
const workspacesStore = useWorkspacesStore()
const newDocKeys = useNewDocShortcut()

const workspaceId = computed(() => Number(route.params.workspaceId))

async function onNewDocument() {
  if (Number.isNaN(workspaceId.value)) return
  const doc = await treeStore.createDocument({ folderId: null })
  await navigateTo(`/w/${workspaceId.value}/d/${doc.id}`)
}

const wsName = computed(() => workspacesStore.current?.name ?? t('workspace.title'))
</script>

<template>
  <div class="empty">
    <div class="inner">
      <p class="eyebrow">{{ wsName }}</p>
      <h1 class="title">{{ t('workspace.docs.select') }}</h1>
      <p class="lede">
        {{ t('workspace.docs.lede') }}
      </p>
      <div class="actions">
        <button class="primary" type="button" @click="onNewDocument">
          {{ t('sidebar.newDocument') }}
        </button>
      </div>

      <div class="hint">
        <span v-for="k in newDocKeys" :key="k" class="kbd">{{ k }}</span>
        <span class="hint-text">{{ t('workspace.docs.newDocShortcut') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty {
  @apply h-full w-full flex items-center justify-center px-8 py-12;
}
.inner {
  @apply max-w-[520px] w-full;
}
.eyebrow {
  @apply label-mono mb-4;
}
.title {
  @apply font-serif text-[2.1rem] leading-[1.1] tracking-tight text-ink-900 dark:text-ink-100 mb-3;
}
.lede {
  @apply text-[14px] leading-relaxed text-ink-600 dark:text-ink-300 mb-8 max-w-[420px];
}
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

.hint {
  @apply mt-10 flex items-center gap-1.5 text-[11px] text-ink-400 dark:text-ink-500;
}
.kbd {
  @apply inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded font-mono text-[10px] text-ink-600 dark:text-ink-300;
  background: theme('colors.ink.100');
  border: 1px solid theme('colors.ink.200');
}
html.dark .kbd {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
}
.hint-text { @apply ml-1.5 font-sans uppercase font-semibold tracking-[0.08em] text-[10px]; }
</style>
