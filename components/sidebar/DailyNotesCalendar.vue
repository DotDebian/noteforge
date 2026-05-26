<script setup lang="ts">
/**
 * Mini calendar widget for the sidebar. Renders the current (or browsed)
 * month as a 7×6 grid. Days that already have a journal note show a dot.
 * Clicking a day POSTs to `/api/workspaces/:id/daily-note` (find-or-create)
 * and navigates to the resulting doc.
 *
 * Lives just above the trash link in AppSidebar (slot at the very bottom).
 */
import { computed, ref, watch } from 'vue'
import { useLocale } from '~/composables/useLocale'

const props = defineProps<{ workspaceId: number }>()
const { t, locale } = useLocale()
const router = useRouter()

interface MonthRef { year: number, month: number /* 0-11 */ }

function todayRef(): MonthRef {
  const d = new Date()
  return { year: d.getFullYear(), month: d.getMonth() }
}
function toLocalIso(d: Date): string {
  // Use local Y/M/D — NOT toISOString(), which converts to UTC and shifts
  // by one day for users east of UTC (e.g. CEST: midnight local = 22:00Z
  // of the previous day → the 29th would round-trip as "28").
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function todayIso(): string {
  return toLocalIso(new Date())
}

const cursor = ref<MonthRef>(todayRef())
const datesWithNotes = ref<Set<string>>(new Set())
const loading = ref(false)
const expanded = ref(false)

const monthLabel = computed(() => {
  const d = new Date(cursor.value.year, cursor.value.month, 1)
  return d.toLocaleDateString(locale.value === 'fr' ? 'fr-FR' : 'en-US', {
    year: 'numeric',
    month: 'long',
  })
})

// Build the grid: 6 rows × 7 cols, Mon-first (locale-aware would be nice
// but Mon-first is the typical EU default and matches FR). Cells outside
// the current month are still rendered, just dimmed.
interface DayCell {
  date: string            // YYYY-MM-DD
  day: number             // 1-31
  inMonth: boolean
  isToday: boolean
  hasNote: boolean
}

const grid = computed<DayCell[][]>(() => {
  const { year, month } = cursor.value
  const first = new Date(year, month, 1)
  // Day-of-week with Monday = 0 (JS getDay returns Sun=0 by default).
  const firstDow = (first.getDay() + 6) % 7
  const gridStart = new Date(year, month, 1 - firstDow)
  const today = todayIso()

  const rows: DayCell[][] = []
  for (let r = 0; r < 6; r++) {
    const row: DayCell[] = []
    for (let c = 0; c < 7; c++) {
      const d = new Date(gridStart)
      d.setDate(gridStart.getDate() + r * 7 + c)
      const iso = toLocalIso(d)
      row.push({
        date: iso,
        day: d.getDate(),
        inMonth: d.getMonth() === month,
        isToday: iso === today,
        hasNote: datesWithNotes.value.has(iso),
      })
    }
    rows.push(row)
  }
  return rows
})

const dayHeaders = computed(() => {
  // Mon-Sun, abbreviated, locale-driven.
  const fmt = new Intl.DateTimeFormat(
    locale.value === 'fr' ? 'fr-FR' : 'en-US',
    { weekday: 'short' },
  )
  const out: string[] = []
  const base = new Date(2024, 0, 1) // Jan 1 2024 was a Monday
  for (let i = 0; i < 7; i++) {
    const d = new Date(base)
    d.setDate(base.getDate() + i)
    out.push(fmt.format(d).replace(/\.$/, '').slice(0, 2))
  }
  return out
})

async function refreshMonthDots(): Promise<void> {
  const { year, month } = cursor.value
  const ym = `${year}-${String(month + 1).padStart(2, '0')}`
  loading.value = true
  try {
    const res = await $fetch<{ dates: string[] }>(
      `/api/workspaces/${props.workspaceId}/daily-notes`,
      { query: { month: ym } },
    )
    datesWithNotes.value = new Set(res.dates)
  }
  catch {
    // Silent — the calendar still works, just without presence dots.
    datesWithNotes.value = new Set()
  }
  finally {
    loading.value = false
  }
}

watch(
  [() => cursor.value.year, () => cursor.value.month, () => props.workspaceId],
  () => { void refreshMonthDots() },
  { immediate: true },
)

function prevMonth(): void {
  const m = cursor.value.month - 1
  if (m < 0) cursor.value = { year: cursor.value.year - 1, month: 11 }
  else cursor.value = { ...cursor.value, month: m }
}
function nextMonth(): void {
  const m = cursor.value.month + 1
  if (m > 11) cursor.value = { year: cursor.value.year + 1, month: 0 }
  else cursor.value = { ...cursor.value, month: m }
}
function goToday(): void {
  cursor.value = todayRef()
}

async function openDay(cell: DayCell): Promise<void> {
  try {
    const res = await $fetch<{ document: { id: number }, created: boolean }>(
      `/api/workspaces/${props.workspaceId}/daily-note`,
      { method: 'POST', body: { date: cell.date } },
    )
    if (res.created) {
      // Optimistically reflect the new dot without waiting for refetch.
      datesWithNotes.value = new Set([...datesWithNotes.value, cell.date])
    }
    await router.push(`/w/${props.workspaceId}/d/${res.document.id}`)
  }
  catch (err) {
    console.error('[daily-note] open failed', err)
  }
}
</script>

<template>
  <section class="dn">
    <header class="dn-header">
      <button
        type="button"
        class="dn-title-btn"
        :title="t('journal.expand')"
        @click="expanded = !expanded"
      >
        <span class="dn-label">{{ t('journal.title') }}</span>
        <span class="dn-chev">{{ expanded ? '▾' : '▸' }}</span>
      </button>
      <button
        type="button"
        class="dn-today"
        :title="t('journal.openToday')"
        @click="openDay({ date: todayIso(), day: 0, inMonth: true, isToday: true, hasNote: false })"
      >
        {{ t('journal.today') }}
      </button>
    </header>

    <div v-if="expanded" class="dn-body">
      <div class="dn-nav">
        <button type="button" class="dn-nav-btn" :title="t('journal.prev')" @click="prevMonth">‹</button>
        <button type="button" class="dn-month" @click="goToday">{{ monthLabel }}</button>
        <button type="button" class="dn-nav-btn" :title="t('journal.next')" @click="nextMonth">›</button>
      </div>

      <div class="dn-grid" :class="{ 'dn-grid--loading': loading }">
        <div v-for="(h, i) in dayHeaders" :key="`h-${i}`" class="dn-dow">{{ h }}</div>
        <button
          v-for="(cell, idx) in grid.flat()"
          :key="`d-${idx}`"
          type="button"
          class="dn-day"
          :class="{
            'dn-day--out': !cell.inMonth,
            'dn-day--today': cell.isToday,
            'dn-day--has': cell.hasNote,
          }"
          :title="cell.date"
          @click="openDay(cell)"
        >
          <span class="dn-num">{{ cell.day }}</span>
          <span v-if="cell.hasNote" class="dn-dot" aria-hidden="true" />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dn {
  @apply px-3 py-2;
  border-top: 1px solid theme('colors.ink.200' / 50%);
}
html.dark .dn {
  border-top-color: theme('colors.ink.800' / 60%);
}
.dn-header {
  @apply flex items-center justify-between gap-2;
}
.dn-title-btn {
  @apply inline-flex items-center gap-1.5 flex-1 min-w-0;
}
.dn-label {
  @apply label-mono;
}
.dn-chev {
  @apply text-[10px] text-ink-400 dark:text-ink-500;
}
.dn-today {
  @apply text-[10.5px] uppercase tracking-wider text-ink-500 dark:text-ink-400 rounded px-1.5 py-0.5;
  transition: background 120ms ease, color 120ms ease;
}
.dn-today:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .dn-today:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.50');
}
.dn-body {
  @apply mt-2;
}
.dn-nav {
  @apply flex items-center justify-between mb-1.5;
}
.dn-nav-btn {
  @apply inline-flex items-center justify-center h-5 w-5 rounded text-ink-500 dark:text-ink-400 text-sm;
  transition: background 120ms ease, color 120ms ease;
}
.dn-nav-btn:hover {
  background: theme('colors.ink.100' / 70%);
  color: theme('colors.ink.900');
}
html.dark .dn-nav-btn:hover {
  background: theme('colors.ink.800' / 60%);
  color: theme('colors.ink.50');
}
.dn-month {
  @apply flex-1 text-center text-[11.5px] font-medium text-ink-700 dark:text-ink-200 capitalize;
}
.dn-grid {
  @apply grid grid-cols-7 gap-0.5 text-center;
  font-feature-settings: 'tnum';
}
.dn-grid--loading { opacity: 0.6; }
.dn-dow {
  @apply text-[9.5px] uppercase tracking-[0.06em] text-ink-400 dark:text-ink-500 leading-5;
}
.dn-day {
  @apply relative inline-flex items-center justify-center h-6 w-full rounded text-[11px] text-ink-700 dark:text-ink-300;
  transition: background 100ms ease, color 100ms ease;
}
.dn-day:hover {
  background: theme('colors.ink.100' / 80%);
  color: theme('colors.ink.900');
}
html.dark .dn-day:hover {
  background: theme('colors.ink.800' / 70%);
  color: theme('colors.ink.50');
}
.dn-day--out {
  color: theme('colors.ink.300');
}
html.dark .dn-day--out {
  color: theme('colors.ink.700');
}
.dn-day--today {
  background: theme('colors.accent.100');
  color: theme('colors.accent.800');
  font-weight: 600;
}
html.dark .dn-day--today {
  background: theme('colors.accent.900' / 60%);
  color: theme('colors.accent.100');
}
.dn-num {
  @apply z-[1];
}
.dn-dot {
  @apply absolute h-1 w-1 rounded-full;
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
  background: theme('colors.accent.500');
}
.dn-day--today .dn-dot {
  background: theme('colors.accent.700');
}
html.dark .dn-day--today .dn-dot {
  background: theme('colors.accent.200');
}
</style>
