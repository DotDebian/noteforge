<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, nextTick, ref } from 'vue'
import type { WikiLinkItem } from './extensions/WikiLink'
import { useLocale } from '~/composables/useLocale'

const { t, locale } = useLocale()

const L = computed(() => locale.value === 'fr'
  ? { createDaily: 'Créer la note du jour' }
  : { createDaily: 'Create daily note' })

interface Props {
  items: WikiLinkItem[]
  command: (item: WikiLinkItem) => void
}

const props = defineProps<Props>()

const selectedIndex = ref(0)
const listEl = ref<HTMLElement | null>(null)

const hasItems = computed(() => props.items.length > 0)

function selectItem(index: number) {
  const item = props.items[index]
  if (item) props.command(item)
}

function onArrowUp() {
  if (!hasItems.value) return
  selectedIndex.value
    = (selectedIndex.value + props.items.length - 1) % props.items.length
  scrollSelectedIntoView()
}

function onArrowDown() {
  if (!hasItems.value) return
  selectedIndex.value = (selectedIndex.value + 1) % props.items.length
  scrollSelectedIntoView()
}

function onEnter() {
  if (!hasItems.value) return
  selectItem(selectedIndex.value)
}

function scrollSelectedIntoView() {
  void nextTick(() => {
    const el = listEl.value?.querySelector<HTMLElement>(
      `[data-index="${selectedIndex.value}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  })
}

defineExpose({
  onKeyDown: (event: KeyboardEvent): boolean => {
    if (event.key === 'ArrowUp') {
      onArrowUp()
      return true
    }
    if (event.key === 'ArrowDown') {
      onArrowDown()
      return true
    }
    if (event.key === 'Enter') {
      onEnter()
      return true
    }
    return false
  },
  resetSelection: () => {
    selectedIndex.value = 0
  },
})

onMounted(() => {
  selectedIndex.value = 0
})
onBeforeUnmount(() => {
  selectedIndex.value = 0
})
</script>

<template>
  <div
    ref="listEl"
    class="wiki-menu max-h-80 w-72 overflow-y-auto rounded-lg border border-ink-200 bg-white shadow-lg ring-1 ring-ink-900/5 dark:border-ink-800 dark:bg-ink-900 dark:ring-ink-950/60"
    role="listbox"
  >
    <div v-if="!hasItems" class="px-3 py-2 text-sm text-ink-400 dark:text-ink-500">
      {{ t('editor.wiki.noMatches') }}
    </div>
    <button
      v-for="(item, index) in items"
      :key="`${item.kind ?? 'doc'}-${item.docId}-${item.title}`"
      type="button"
      role="option"
      :data-index="index"
      :aria-selected="index === selectedIndex"
      class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
      :class="
        index === selectedIndex
          ? 'bg-accent-50 text-ink-900 dark:bg-ink-800 dark:text-ink-50'
          : 'text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-800/60'
      "
      @click="selectItem(index)"
      @mouseenter="selectedIndex = index"
    >
      <span
        v-if="item.kind === 'createDaily'"
        class="flex h-6 w-6 items-center justify-center rounded border border-accent-200 bg-accent-50 text-[12px] text-accent-700 dark:border-accent-800 dark:bg-accent-900/40 dark:text-accent-300"
        aria-hidden="true"
      >
        ◯
      </span>
      <span
        v-else
        class="flex h-6 w-6 items-center justify-center rounded border border-ink-200 bg-ink-50 font-mono text-[10px] text-ink-500 dark:border-ink-800 dark:bg-ink-800 dark:text-ink-300"
        aria-hidden="true"
      >
        ¶
      </span>
      <span class="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
        <template v-if="item.kind === 'createDaily'">
          {{ L.createDaily }} <span class="font-mono text-[11px] text-ink-500 dark:text-ink-400">{{ item.title }}</span>
        </template>
        <template v-else>
          {{ item.title || t('doc.untitled') }}
        </template>
      </span>
    </button>
  </div>
</template>
