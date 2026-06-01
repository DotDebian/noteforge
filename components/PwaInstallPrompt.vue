<script setup lang="ts">
import { usePwaInstall } from '~/composables/usePwaInstall'
import { useLocale } from '~/composables/useLocale'

/**
 * Bottom-anchored install invitation. On Chrome/Android/desktop it triggers
 * the native install flow via the captured `beforeinstallprompt`; on iOS it
 * shows manual "Add to Home Screen" instructions. Dismissal is permanent
 * (see usePwaInstall). Centered card on mobile, bottom-right on desktop.
 */
const { t } = useLocale()
const { visible, canPrompt, isIOS, install, dismiss } = usePwaInstall()

async function onInstall() {
  await install()
  // After the native flow resolves, the event is spent; hide the card. If the
  // user accepted, `appinstalled` already cleared it; if they cancelled, we
  // dismiss so we don't nag (re-installable from the browser menu).
  dismiss()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="pwa-slide">
      <section
        v-if="visible"
        class="pwa-prompt"
        role="dialog"
        aria-labelledby="pwa-title"
      >
        <img class="pwa-icon" src="/pwa-192.png" alt="" width="44" height="44" />
        <div class="pwa-text">
          <h2 id="pwa-title" class="pwa-title">{{ t('pwa.install.title') }}</h2>
          <!-- iOS can't be triggered programmatically — show the A2HS steps. -->
          <p v-if="isIOS && !canPrompt" class="pwa-body">
            {{ t('pwa.install.iosBody') }}
            <span class="pwa-share" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13">
                <path d="M8 2v8 M5.5 4.5L8 2l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M4 7H3v6h10V7h-1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </p>
          <p v-else class="pwa-body">{{ t('pwa.install.body') }}</p>

          <div class="pwa-actions">
            <button v-if="canPrompt" type="button" class="pwa-btn pwa-btn--primary" @click="onInstall">
              {{ t('pwa.install.action') }}
            </button>
            <button type="button" class="pwa-btn" @click="dismiss">
              {{ isIOS && !canPrompt ? t('pwa.install.iosGot') : t('pwa.install.later') }}
            </button>
          </div>
        </div>
        <button type="button" class="pwa-close" :aria-label="t('pwa.install.dismiss')" @click="dismiss">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M4 4l8 8 M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.pwa-prompt {
  position: fixed;
  z-index: 70;
  left: 1rem;
  right: 1rem;
  bottom: calc(1rem + env(safe-area-inset-bottom, 0));
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
  padding: 1rem 1rem 1rem 0.875rem;
  border-radius: 0.875rem;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 12px 32px -8px theme('colors.ink.900' / 25%);
}
html.dark .pwa-prompt {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.700');
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.6);
}
/* Desktop: a compact card pinned bottom-right rather than full-width. */
@media (min-width: 640px) {
  .pwa-prompt {
    left: auto;
    right: 1.5rem;
    bottom: 1.5rem;
    width: 22rem;
  }
}

.pwa-icon {
  @apply shrink-0 rounded-lg;
  width: 44px;
  height: 44px;
}
.pwa-text {
  @apply flex-1 min-w-0;
}
.pwa-title {
  @apply font-serif text-[15px] font-semibold text-ink-900 dark:text-ink-100;
}
.pwa-body {
  @apply mt-0.5 text-[13px] leading-snug text-ink-600 dark:text-ink-300;
}
.pwa-share {
  @apply inline-flex items-center justify-center align-text-bottom h-[18px] w-[18px] rounded ml-0.5 text-ink-500 dark:text-ink-300;
  border: 1px solid theme('colors.ink.300');
}
html.dark .pwa-share {
  border-color: theme('colors.ink.600');
}

.pwa-actions {
  @apply mt-3 flex items-center gap-2;
}
.pwa-btn {
  @apply inline-flex items-center justify-center px-3 py-1.5 rounded-md font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-600 dark:text-ink-300;
  border: 1px solid transparent;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.pwa-btn:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .pwa-btn:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}
.pwa-btn--primary {
  color: white;
  background: theme('colors.ink.900');
}
html.dark .pwa-btn--primary {
  background: theme('colors.accent.600');
  color: theme('colors.ink.50');
}
.pwa-btn--primary:hover {
  background: theme('colors.accent.600');
  color: white;
}
html.dark .pwa-btn--primary:hover {
  background: theme('colors.accent.500');
}

.pwa-close {
  @apply shrink-0 -mt-1 -mr-0.5 inline-flex items-center justify-center h-7 w-7 rounded-md text-ink-400 dark:text-ink-500;
  transition: background 120ms ease, color 120ms ease;
}
.pwa-close:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.700');
}
html.dark .pwa-close:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.200');
}

.pwa-slide-enter-active,
.pwa-slide-leave-active {
  transition: opacity 220ms ease, transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
.pwa-slide-enter-from,
.pwa-slide-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
