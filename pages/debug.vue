<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * TEMPORARY diagnostics page for the iOS-standalone "black bar" issue.
 * Reads the real device viewport/safe-area numbers AND lets us trial candidate
 * fixes live on-device (no rebuild) so we can nail the right one in a single
 * deploy. Remove once the PWA layout is sorted.
 */
useHead({ title: 'Debug — NoteForge' })

const probe = ref<HTMLElement | null>(null)
const metrics = ref<Record<string, string>>({})
const note = ref('')

function cssPx(el: HTMLElement, prop: string): string {
  return getComputedStyle(el).getPropertyValue(prop)
}

/**
 * Synchronously trial each height strategy on .app-shell and record the
 * resulting gap (innerHeight - shell.bottom). The strategy whose gap is 0 is
 * the one that fills the iOS standalone viewport.
 */
function probeHeightStrategies(): Record<string, string> {
  const shell = document.querySelector('.app-shell') as HTMLElement | null
  if (!shell) return {}
  const orig = shell.style.getPropertyValue('height')
  const origPrio = shell.style.getPropertyPriority('height')
  const strategies = ['100%', '100vh', '100dvh', '100svh', '100lvh', '-webkit-fill-available']
  const res: Record<string, string> = {}
  for (const val of strategies) {
    shell.style.setProperty('height', val, 'important')
    const bottom = shell.getBoundingClientRect().bottom // forces reflow
    res[`gap @ ${val}`] = `${Math.round(window.innerHeight - bottom)}px`
  }
  // restore
  shell.style.setProperty('height', orig, origPrio)
  return res
}

function collect() {
  const de = document.documentElement
  const body = document.body
  const nuxt = document.getElementById('__nuxt')
  const shell = document.querySelector('.app-shell') as HTMLElement | null
  const shellRect = shell?.getBoundingClientRect()
  const vv = window.visualViewport
  const p = probe.value

  const out: Record<string, string> = {
    'display-mode: standalone': String(window.matchMedia('(display-mode: standalone)').matches),
    'display-mode: fullscreen': String(window.matchMedia('(display-mode: fullscreen)').matches),
    'navigator.standalone': String((navigator as unknown as { standalone?: boolean }).standalone ?? 'n/a'),
    'supports 100dvh': String(window.CSS?.supports?.('height', '100dvh') ?? 'n/a'),
    'supports fill-available': String(window.CSS?.supports?.('height', '-webkit-fill-available') ?? 'n/a'),
    'orientation': screen.orientation?.type ?? 'n/a',
    'window.innerHeight': `${window.innerHeight}`,
    'documentElement.clientHeight': `${de.clientHeight}`,
    'visualViewport.height': vv ? `${Math.round(vv.height)}` : 'n/a',
    'visualViewport.offsetTop': vv ? `${Math.round(vv.offsetTop)}` : 'n/a',
    'screen.height': `${window.screen.height}`,
    'screen.availHeight': `${window.screen.availHeight}`,
    'devicePixelRatio': `${window.devicePixelRatio}`,
  }
  if (p) {
    out['inset-top'] = cssPx(p, 'padding-top')
    out['inset-right'] = cssPx(p, 'padding-right')
    out['inset-bottom'] = cssPx(p, 'padding-bottom')
    out['inset-left'] = cssPx(p, 'padding-left')
  }
  out['html bg'] = getComputedStyle(de).backgroundColor
  out['html height'] = getComputedStyle(de).height
  out['body bg'] = getComputedStyle(body).backgroundColor
  out['body rect.height'] = `${Math.round(body.getBoundingClientRect().height)}`
  if (nuxt) out['#__nuxt rect.height'] = `${Math.round(nuxt.getBoundingClientRect().height)}`
  if (shell && shellRect) {
    out['app-shell css height'] = cssPx(shell, 'height')
    out['app-shell rect.height'] = `${Math.round(shellRect.height)}`
    out['app-shell rect.bottom'] = `${Math.round(shellRect.bottom)}`
    out['*** gap below shell ***'] = `${Math.round(window.innerHeight - shellRect.bottom)}px`
    out['app-shell bg'] = getComputedStyle(shell).backgroundColor
  }
  Object.assign(out, probeHeightStrategies())
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
  killInject()
})

const asText = computed(() => {
  const lines = Object.entries(metrics.value).map(([k, v]) => `${k}: ${v}`)
  if (note.value) lines.unshift(`active experiment: ${note.value}`, '')
  return lines.join('\n')
})

const copied = ref(false)
async function copy() {
  try {
    await navigator.clipboard.writeText(asText.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  }
  catch {
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

/* ---------- live experiments (no rebuild) ---------- */
function injectStyle(css: string, label: string) {
  let s = document.getElementById('debug-inject') as HTMLStyleElement | null
  if (!s) {
    s = document.createElement('style')
    s.id = 'debug-inject'
    document.head.appendChild(s)
  }
  s.textContent = css
  note.value = label
  scheduleCollect()
}
function killInject() {
  document.getElementById('debug-inject')?.remove()
  document.querySelectorAll('[data-debug-cover]').forEach(el => el.remove())
  note.value = ''
  scheduleCollect()
}

function paintLayers() {
  injectStyle(
    'html{background:#ff00ff !important}'
    + 'body{background:#00ffff !important}'
    + '#__nuxt{background:#ffff00 !important}'
    + '.app-shell{background:#00ff00 !important}',
    'paint-layers (html=magenta, body=cyan, #__nuxt=yellow, shell=green)',
  )
}
function setShellHeight(val: string) {
  injectStyle(`.app-shell{height:${val} !important}`, `app-shell height:${val}`)
}
function fixedCover() {
  killInject()
  const d = document.createElement('div')
  d.setAttribute('data-debug-cover', '')
  d.style.cssText = 'position:fixed;inset:0;background:rgba(255,0,0,.45);z-index:99999;pointer-events:none;'
  document.body.appendChild(d)
  note.value = 'fixed inset:0 red overlay (does fixed cover the bar?)'
  scheduleCollect()
}
</script>

<template>
  <div class="debug-page">
    <div ref="probe" class="sa-probe" aria-hidden="true" />
    <div class="sa-overlay sa-overlay--top" aria-hidden="true"><span>inset-top</span></div>
    <div class="sa-overlay sa-overlay--bottom" aria-hidden="true"><span>inset-bottom</span></div>

    <div class="debug-body">
      <h1 class="debug-title">Debug · viewport & safe-area</h1>

      <div class="btns">
        <button type="button" class="b b--primary" @click="copy">{{ copied ? 'Copié ✓' : 'Copier' }}</button>
        <button type="button" class="b" @click="collect">Rafraîchir</button>
        <button type="button" class="b" @click="killInject">Reset</button>
      </div>

      <p class="hint">Essais live (regarde la bande noire après chaque appui) :</p>
      <div class="btns">
        <button type="button" class="b" @click="paintLayers">Peindre les couches</button>
        <button type="button" class="b" @click="fixedCover">Fixed inset:0</button>
      </div>
      <div class="btns">
        <button type="button" class="b" @click="setShellHeight('100dvh')">shell 100dvh</button>
        <button type="button" class="b" @click="setShellHeight('100vh')">100vh</button>
        <button type="button" class="b" @click="setShellHeight('-webkit-fill-available')">fill-avail</button>
        <button type="button" class="b" @click="setShellHeight('100%')">100%</button>
      </div>

      <p v-if="note" class="active">▶ {{ note }}</p>

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
.sa-overlay--top { top: 0; height: env(safe-area-inset-top, 0); background: rgba(56, 189, 248, 0.55); }
.sa-overlay--bottom { bottom: 0; height: env(safe-area-inset-bottom, 0); background: rgba(244, 114, 22, 0.6); }

.debug-body {
  @apply p-4;
  padding-bottom: calc(2rem + env(safe-area-inset-bottom, 0));
}
.debug-title { @apply font-serif text-lg font-semibold mb-3; }
.hint { @apply text-[12px] text-ink-500 dark:text-ink-400 mt-3 mb-1.5; }
.active { @apply text-[12px] font-mono text-accent-600 dark:text-accent-300 my-2; }

.btns { @apply flex flex-wrap gap-2 mb-1.5; }
.b {
  @apply inline-flex items-center px-3 py-2 rounded-md font-sans text-[12px] font-semibold;
  border: 1px solid theme('colors.ink.300');
  color: theme('colors.ink.700');
}
html.dark .b { border-color: theme('colors.ink.700'); color: theme('colors.ink.200'); }
.b--primary { background: theme('colors.accent.600'); color: #fff; border-color: theme('colors.accent.600'); }

.metrics { @apply w-full text-[13px] border-collapse mt-3; }
.metrics td { @apply py-1.5 align-top border-b border-ink-200/50; }
html.dark .metrics td { border-bottom-color: theme('colors.ink.800'); }
.metrics .k { @apply pr-3 text-ink-500 dark:text-ink-400 whitespace-nowrap; }
.metrics .v { @apply font-mono break-all; }

.dump {
  @apply mt-4 p-3 rounded-md font-mono text-[11px] whitespace-pre-wrap break-all;
  background: theme('colors.ink.100');
}
html.dark .dump { background: theme('colors.ink.900'); }
</style>
