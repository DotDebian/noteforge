import { computed, ref, watch, onScopeDispose } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/**
 * Sprint 3 / I7 — auto-reanalyze on substantive change.
 *
 * Watches a document's markdown vs the length stored at the last analysis.
 * When the doc is "substantive" (> 300 words) and the char-delta since the
 * last analysis exceeds 30%, schedules an auto-reanalysis after 30s of
 * editing inactivity.
 *
 * Coalesces concurrent runs (one in-flight at a time per composable
 * instance). Swallows 429s silently — the next inactivity tick will retry.
 *
 * The caller passes the `analyze()` callback (the same one a user clicks).
 * That callback should re-fetch the analysis on success — this composable
 * doesn't touch the document or analysis itself.
 */

const STALE_RATIO = 0.30
const MIN_WORDS = 300
const INACTIVITY_MS = 30_000

export interface AutoAnalysisDoc {
  id: number
  markdown: string
}

export interface AutoAnalysisAnalysis {
  markdownLengthAtAnalysis?: number | null
  generatedAt?: Date | number | null
}

export interface UseAutoAnalysisReturn {
  isStale: ComputedRef<boolean>
  staleHint: ComputedRef<string | null>
  isRunning: Ref<boolean>
}

function countWords(md: string): number {
  if (!md) return 0
  return md.split(/\s+/).filter(Boolean).length
}

export function useAutoAnalysis(
  docRef: Ref<AutoAnalysisDoc | null>,
  analysisRef: Ref<AutoAnalysisAnalysis | null>,
  analyze: () => Promise<void>,
): UseAutoAnalysisReturn {
  const isRunning = ref(false)
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Track which doc id the user has actually edited in this session. We
  // refuse to auto-fire until they've made at least one change — otherwise
  // just opening a stale doc would trigger a re-analysis the user never
  // asked for.
  const editedDocIds = new Set<number>()
  let lastSeenMarkdown: string | null = null
  let lastSeenDocId: number | null = null

  function clearTimer(): void {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const currentLen = computed(() => docRef.value?.markdown.length ?? 0)
  const currentWords = computed(() => countWords(docRef.value?.markdown ?? ''))

  const isStale = computed<boolean>(() => {
    const analysis = analysisRef.value
    if (!analysis) return false
    const lastLen = analysis.markdownLengthAtAnalysis ?? 0
    if (lastLen <= 0) return false
    const delta = Math.abs(currentLen.value - lastLen) / Math.max(lastLen, 1)
    return delta > STALE_RATIO && currentWords.value > MIN_WORDS
  })

  const staleHint = computed<string | null>(() => {
    if (!isStale.value) return null
    const analysis = analysisRef.value
    if (!analysis) return null
    const lastLen = analysis.markdownLengthAtAnalysis ?? 0
    // Estimate word-delta from char-delta (rough avg 6 chars/word incl.
    // spaces). Good enough for a hint string; we only show "behind" when
    // the doc grew, "ahead" otherwise (rare — user shrank the doc).
    const charDelta = currentLen.value - lastLen
    const wordDelta = Math.max(1, Math.round(Math.abs(charDelta) / 6))
    const formatted = wordDelta.toLocaleString()
    if (charDelta >= 0) {
      return `Insights are ${formatted} word${wordDelta === 1 ? '' : 's'} behind`
    }
    return `Insights are ${formatted} word${wordDelta === 1 ? '' : 's'} ahead`
  })

  async function runAuto(): Promise<void> {
    if (running) return
    if (!isStale.value) return
    running = true
    isRunning.value = true
    try {
      await analyze()
    }
    catch (err) {
      // Rate-limit: swallow silently — the next inactivity tick will retry,
      // and the user didn't explicitly request this run.
      const e = err as {
        statusCode?: number
        status?: number
        response?: { status?: number }
      }
      const status = e.statusCode ?? e.status ?? e.response?.status
      if (status !== 429) {
        // Any other error: log to console for dev visibility but stay
        // silent in the UI — auto-runs should never surface toasts.
        console.warn('[useAutoAnalysis] auto-run failed', err)
      }
    }
    finally {
      running = false
      isRunning.value = false
    }
  }

  // Watch markdown. The very first observation per docId only seeds the
  // baseline — we don't schedule until the user has actually edited.
  watch(
    () => ({ id: docRef.value?.id ?? null, md: docRef.value?.markdown ?? null }),
    ({ id, md }) => {
      if (id == null || md == null) {
        clearTimer()
        lastSeenDocId = null
        lastSeenMarkdown = null
        return
      }
      // Doc switched — reset baseline, don't fire on load.
      if (lastSeenDocId !== id) {
        lastSeenDocId = id
        lastSeenMarkdown = md
        clearTimer()
        return
      }
      // Same doc, same content — nothing happened.
      if (lastSeenMarkdown === md) return
      lastSeenMarkdown = md
      editedDocIds.add(id)
      // Reset the inactivity timer on every edit.
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        // Re-check at fire time — the doc might have already been
        // re-analyzed (e.g. user clicked the manual button) or no longer
        // pass the threshold.
        if (docRef.value?.id !== id) return
        if (!editedDocIds.has(id)) return
        if (!isStale.value) return
        void runAuto()
      }, INACTIVITY_MS)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    clearTimer()
  })

  return { isStale, staleHint, isRunning }
}
