<script setup lang="ts">
/**
 * Popover for the `![[` transclusion picker. Same shape as
 * `WikiLinkMenu.vue` minus the daily-note pseudo-entry, since transclusion
 * doesn't have a date-based create path.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TransclusionSuggestItem } from './extensions/transclusion-suggest'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

interface Props {
  items: TransclusionSuggestItem[]
  command: (item: TransclusionSuggestItem) => void
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
    class="transclusion-menu max-h-80 w-72 overflow-y-auto rounded-lg border border-ink-200 bg-white shadow-lg ring-1 ring-ink-900/5 dark:border-ink-800 dark:bg-ink-900 dark:ring-ink-950/60"
    role="listbox"
  >
    <div v-if="!hasItems" class="px-3 py-2 text-sm text-ink-400 dark:text-ink-500">
      {{ t('editor.wiki.noMatches') }}
    </div>
    <button
      v-for="(item, index) in items"
      :key="`${item.docId}-${item.title}`"
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
        class="flex h-6 w-6 items-center justify-center rounded border border-accent-200 bg-accent-50 font-mono text-[11px] text-accent-700 dark:border-accent-800 dark:bg-accent-900/40 dark:text-accent-300"
        aria-hidden="true"
      >
        ↪
      </span>
      <span class="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
        {{ item.title || t('doc.untitled') }}
      </span>
    </button>
  </div>
</template>
