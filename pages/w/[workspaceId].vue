<script setup lang="ts">
import { computed, watch } from 'vue'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useTreeStore } from '~/stores/tree'
import { useFavoritesStore } from '~/stores/favorites'

const route = useRoute()
const workspacesStore = useWorkspacesStore()
const treeStore = useTreeStore()
const favoritesStore = useFavoritesStore()

const workspaceId = computed(() => Number(route.params.workspaceId))

if (!workspacesStore.loaded) {
  try { await workspacesStore.fetchAll() } catch { /* shown by layout */ }
}
if (!Number.isNaN(workspaceId.value)) {
  workspacesStore.setCurrent(workspaceId.value)
  try { await treeStore.fetchWorkspaceTree(workspaceId.value) } catch { /* shown by layout */ }
  // Fire-and-forget — pinned section is secondary chrome, no need to block.
  favoritesStore.load(workspaceId.value).catch(() => { /* ignore */ })
}

watch(workspaceId, async (id) => {
  if (Number.isNaN(id)) return
  workspacesStore.setCurrent(id)
  try { await treeStore.fetchWorkspaceTree(id) } catch { /* ignore */ }
  favoritesStore.load(id).catch(() => { /* ignore */ })
})
</script>

<template>
  <NuxtPage />
</template>
