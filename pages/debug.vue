<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * TEMPORARY diagnostics page for the iOS-standalone "black bar" issue.
 * Surfaces the real device viewport / safe-area numbers so they can be read
 * (and copied) directly from the installed PWA — no devtools/Mac needed.
 * Remove once the PWA layout is sorted.
 */
useHead({ title: 'Debug — NoteForge' })

const probe = ref<HTMLElement | null>(null)
const metrics = ref<Record<string, string>>({})

function px(el: HTMLElement, prop: string): string {
  return getComputedStyle(el).getPropertyValue(prop)
}

function collect() {
  const de = document.documentElement
  const shell = document.querySelector('.app-shell') as HTMLElement | null
  const shellRect = shell?.getBoundingClientRect()
  const vv = window.visualViewport
  const p = probe.value

  const out: Record<string, string> = {
    'display-mode: standalone': String(window.matchMedia('(display-mode: standalone)').matches),
    'navigator.standalone': String((navigator as unknown as { standalone?: boolean }).standalone ?? 'n/a'),
    'supports 100dvh': String(window.CSS?.supports?.('height', '100dvh') ?? 'n/a'),
    'window.innerHeight': `${window.innerHeight}`,
    'documentElement.clientHeight': `${de.clientHeight}`,
    'visualViewport.height': vv ? `${Math.round(vv.height)}` : 'n/a',
    'visualViewport.offsetTop': vv ? `${Math.round(vv.offsetTop)}` : 'n/a',
    'screen.height': `${window.screen.height}`,
    'screen.availHeight': `${window.screen.availHeight}`,
    'devicePixelRatio': `${window.devicePixelRatio}`,
  }
  if (p) {
    out['safe-area-inset-top'] = px(p, 'padding-top')
    out['safe-area-inset-right'] = px(p, 'padding-right')
    out['safe-area-inset-bottom'] = px(p, 'padding-bottom')
    out['safe-area-inset-left'] = px(p, 'padding-left')
  }
  if (shell && shellRect) {
    out['app-shell height'] = px(shell, 'height')
    out['app-shell rect.height'] = `${Math.round(shellRect.height)}`
    out['app-shell rect.bottom'] = `${Math.round(shellRect.bottom)}`
    out['gap below shell (innerH - bottom)'] = `${Math.round(window.innerHeight - shellRect.bottom)}`
    out['app-shell bg'] = getComputedStyle(shell).backgroundColor
  }
  out['html bg'] = getComputedStyle(de).backgroundColor
  out['html.dark'] = String(de.classList.contains('dark'))
  out['userAgent'] = navigator.userAgent
  metrics.value = out
}

let raf = 0
function scheduleCollect() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(collect)
}

onMounted(() => {
  collect()
  window.addEventListener('resize', scheduleCollect)
  window.addEventListener('orientationchange', scheduleCollect)
  window.visualViewport?.addEventListener('resize', scheduleCollect)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleCollect)
  window.removeEventListener('orientationchange', scheduleCollect)
  window.visualViewport?.removeEventListener('resize', scheduleCollect)
})

const asText = computed(() =>
  Object.entries(metrics.value).map(([k, v]) => `${k}: ${v}`).join('\n'),
)

const copied = ref(false)
async function copy() {
  try {
    await navigator.clipboard.writeText(asText.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  }
  catch {
    // Fallback: select the <pre> so the user can copy manually.
    const pre = document.getElementById('debug-dump')
    if (pre) {
      const range = document.createRange()
      range.selectNodeContents(pre)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }
}
</script>

<template>
  <div class="debug-page">
    <!-- Hidden probe whose paddings resolve the env() safe-area insets so we
         can read their real px values via getComputedStyle. -->
    <div ref="probe" class="sa-probe" aria-hidden="true" />

    <!-- Visual overlays: bars sized to the actual insets so the black bar can
         be matched against them by eye. -->
    <div class="sa-overlay sa-overlay--top" aria-hidden="true">
      <span>inset-top</span>
    </div>
    <div class="sa-overlay sa-overlay--bottom" aria-hidden="true">
      <span>inset-bottom</span>
    </div>

    <div class="debug-body">
      <h1 class="debug-title">Debug · viewport & safe-area</h1>
      <button type="button" class="copy-btn" @click="copy">
        {{ copied ? 'Copié ✓' : 'Copier les valeurs' }}
      </button>
      <button type="button" class="copy-btn copy-btn--ghost" @click="collect">
        Rafraîchir
      </button>

      <table class="metrics">
        <tbody>
          <tr v-for="(v, k) in metrics" :key="k">
            <td class="k">{{ k }}</td>
            <td class="v">{{ v }}</td>
          </tr>
        </tbody>
      </table>

      <pre id="debug-dump" class="dump">{{ asText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.debug-page {
  @apply min-h-full w-full;
  background: theme('colors.ink.50');
  color: theme('colors.ink.900');
}
html.dark .debug-page {
  background: theme('colors.ink.950');
  color: theme('colors.ink.100');
}

/* Probe: paddings carry the env() insets; off-screen + invisible. */
.sa-probe {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  visibility: hidden;
  pointer-events: none;
  padding-top: env(safe-area-inset-top, 0);
  padding-right: env(safe-area-inset-right, 0);
  padding-bottom: env(safe-area-inset-bottom, 0);
  padding-left: env(safe-area-inset-left, 0);
}

/* Coloured bars exactly the height of the insets, pinned to the edges. */
.sa-overlay {
  position: fixed;
  left: 0;
  right: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #000;
  pointer-events: none;
}
.sa-overlay--top {
  top: 0;
  height: env(safe-area-inset-top, 0);
  background: rgba(56, 189, 248, 0.55); /* sky */
}
.sa-overlay--bottom {
  bottom: 0;
  height: env(safe-area-inset-bottom, 0);
  background: rgba(244, 114, 22, 0.6); /* accent */
}

.debug-body {
  @apply p-4;
  padding-bottom: calc(2rem + env(safe-area-inset-bottom, 0));
}
.debug-title {
  @apply font-serif text-lg font-semibold mb-3;
}
.copy-btn {
  @apply inline-flex items-center px-3 py-2 mr-2 mb-4 rounded-md font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-white;
  background: theme('colors.accent.600');
}
.copy-btn--ghost {
  background: transparent;
  border: 1px solid theme('colors.ink.300');
  color: theme('colors.ink.700');
}
html.dark .copy-btn--ghost {
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.200');
}

.metrics {
  @apply w-full text-[13px] border-collapse;
}
.metrics td {
  @apply py-1.5 align-top border-b border-ink-200/50;
}
html.dark .metrics td {
  border-bottom-color: theme('colors.ink.800');
}
.metrics .k {
  @apply pr-3 text-ink-500 dark:text-ink-400 whitespace-nowrap;
}
.metrics .v {
  @apply font-mono break-all;
}

.dump {
  @apply mt-4 p-3 rounded-md font-mono text-[11px] whitespace-pre-wrap break-all;
  background: theme('colors.ink.100');
}
html.dark .dump {
  background: theme('colors.ink.900');
}
</style>
