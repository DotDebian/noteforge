import { setupPwaInstall } from '~/composables/usePwaInstall'

/**
 * Client-only: register the service worker (installability + offline shell)
 * and wire the install-invite listeners as early as possible so a
 * `beforeinstallprompt` fired before component mount is still captured.
 */
export default defineNuxtPlugin(() => {
  setupPwaInstall()

  if (import.meta.dev) return // skip SW in dev to avoid HMR/caching interference
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('[pwa] service worker registration failed', err)
    })
  })
})
