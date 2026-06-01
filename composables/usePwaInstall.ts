import { computed, ref } from 'vue'

/**
 * PWA install invitation state.
 *
 * `beforeinstallprompt` can fire before any component mounts, so the listener
 * is attached once from a client plugin (`setupPwaInstall`) into module-scoped
 * refs; the component just reads them. iOS Safari never fires the event, so
 * there we surface manual "Add to Home Screen" instructions instead.
 *
 * Dismissal is permanent (localStorage) — once the user declines, the invite
 * never reappears, matching the native one-shot install banner behaviour.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'noteforge-pwa-install-dismissed'
// Small delay so the invite appears after the page settles rather than racing
// the first paint — feels less abrupt, closer to a native engagement prompt.
const REVEAL_DELAY_MS = 2500

const deferred = ref<BeforeInstallPromptEvent | null>(null)
const installed = ref(false)
const isIOS = ref(false)
const isStandalone = ref(false)
const dismissed = ref(false)
const ready = ref(false)
let initialized = false

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  }
  catch {
    return false
  }
}

/** Called once, client-side, from plugins/pwa.client.ts. */
export function setupPwaInstall(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  const ua = navigator.userAgent || ''
  // iPadOS 13+ reports as "Macintosh"; the touch check disambiguates.
  isIOS.value = /iphone|ipad|ipod/i.test(ua)
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document)
  isStandalone.value = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true
  dismissed.value = readDismissed()

  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress Chrome's mini-infobar; we drive installation from our own UI.
    e.preventDefault()
    deferred.value = e as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', () => {
    installed.value = true
    deferred.value = null
  })

  window.setTimeout(() => { ready.value = true }, REVEAL_DELAY_MS)
}

export function usePwaInstall() {
  const canPrompt = computed(() => deferred.value != null)

  const visible = computed(() =>
    ready.value
    && !installed.value
    && !isStandalone.value
    && !dismissed.value
    && (canPrompt.value || isIOS.value),
  )

  async function install(): Promise<void> {
    const e = deferred.value
    if (!e) return
    await e.prompt()
    try {
      await e.userChoice
    }
    catch {
      /* user-choice rejection is non-fatal */
    }
    // Chrome only lets a deferred prompt be used once.
    deferred.value = null
  }

  function dismiss(): void {
    dismissed.value = true
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    }
    catch {
      /* private mode / storage disabled — just hide for this session */
    }
  }

  return { visible, canPrompt, isIOS, install, dismiss }
}
