<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

interface Props {
  docId: number
}
const props = defineProps<Props>()

interface Backlink { docId: number, title: string }
interface BacklinksResponse { backlinks: Backlink[] }

const backlinks = ref<Backlink[]>([])
const loading = ref(false)
const router = useRouter()
const route = useRoute()

async function load(id: number) {
  if (!Number.isFinite(id) || id <= 0) {
    backlinks.value = []
    return
  }
  loading.value = true
  try {
    const resp = await $fetch<BacklinksResponse>(`/api/documents/${id}/backlinks`)
    backlinks.value = resp.backlinks
  }
  catch {
    backlinks.value = []
  }
  finally {
    loading.value = false
  }
}

watch(() => props.docId, (id) => { void load(id) }, { immediate: true })

function open(b: Backlink) {
  const wsId = Number(route.params.workspaceId)
  if (!Number.isFinite(wsId)) return
  void router.push(`/w/${wsId}/d/${b.docId}`)
}
</script>

<template>
  <section v-if="backlinks.length > 0" class="backlinks-panel" aria-label="Backlinks">
    <h3 class="label-mono backlinks-label">{{ t('editor.backlinks.title') }}</h3>
    <ul class="backlinks-list">
      <li v-for="b in backlinks" :key="b.docId">
        <button
          type="button"
          class="backlinks-row"
          :title="b.title || t('doc.untitled')"
          @click="open(b)"
        >
          <span class="backlinks-text">{{ b.title || t('doc.untitled') }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.backlinks-panel {
  @apply px-4 pt-4 pb-3 border-t border-ink-200/60 font-sans;
}
html.dark .backlinks-panel {
  border-top-color: theme('colors.ink.800' / 60%);
}

.backlinks-label {
  @apply mb-2;
}

.backlinks-list {
  @apply flex flex-col;
}

/* Desktop rail: the rail is overflow-hidden and the Insights panel above is
   flex-1, so this block must bound itself — cap at ~4 rows, scroll inside.
   Mobile (DocInsightsSheet) keeps natural height. */
@media (min-width: 1024px) {
  .backlinks-panel {
    flex-shrink: 0;
  }
  .backlinks-list {
    max-height: 7.5rem;
    overflow-y: auto;
  }
}

.backlinks-row {
  @apply w-full text-left text-sm py-1 px-2 rounded text-ink-600 dark:text-ink-300 transition-colors;
}
.backlinks-row:hover {
  @apply bg-ink-100 dark:bg-ink-800 text-ink-900 dark:text-ink-50;
}

.backlinks-text {
  @apply block truncate;
}
</style>
