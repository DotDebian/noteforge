<script setup lang="ts">
import { ref } from 'vue'
import { useLocale } from '~/composables/useLocale'

definePageMeta({ layout: 'auth' })

const { t } = useLocale()
useHead(() => ({ title: t('auth.head.register') }))

const { register } = useAuth()

const email = ref('')
const password = ref('')
const displayName = ref('')
const inviteCode = ref('')
const pending = ref(false)
const error = ref<string | null>(null)

const recoveryKey = ref<string | null>(null)
const acknowledged = ref(false)
const copied = ref(false)

async function onSubmit() {
  if (pending.value) return
  error.value = null
  pending.value = true
  try {
    const res = await register({
      email: email.value.trim(),
      password: password.value,
      displayName: displayName.value.trim() || undefined,
      inviteCode: inviteCode.value.trim(),
    })
    // Hold here on the recovery-key screen; navigation happens once the
    // user has explicitly acknowledged they saved it. The key never
    // leaves this page — refreshing destroys it.
    recoveryKey.value = res.recoveryKey
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string, message?: string }, statusMessage?: string, message?: string }
    const code = err.data?.statusMessage ?? err.statusMessage
    if (code === 'invalid_invite_code') {
      error.value = t('auth.register.errorInviteCode')
    } else {
      error.value = err.data?.message ?? err.message ?? t('auth.register.errorGeneric')
    }
  } finally {
    pending.value = false
  }
}

async function copyRecovery() {
  if (!recoveryKey.value) return
  try {
    await navigator.clipboard.writeText(recoveryKey.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // Clipboard API can fail in some browsers / contexts — falling back is
    // acceptable since the key is visible on screen.
  }
}

async function continueAfterRecovery() {
  if (!acknowledged.value) return
  await navigateTo('/')
}
</script>

<template>
  <!-- ----- Recovery key view (post-registration) ----- -->
  <section v-if="recoveryKey" class="auth-form recovery">
    <p class="eyebrow">Confidentialité</p>
    <h1 class="title">Note ta clé de récupération</h1>
    <p class="lede">
      Tes notes sont chiffrées avec ton mot de passe. Si tu l'oublies, cette clé
      est la seule façon de retrouver tes données. Elle ne sera plus jamais
      affichée.
    </p>

    <div class="recovery-key">
      <code>{{ recoveryKey }}</code>
      <button type="button" class="copy" @click="copyRecovery">
        <span v-if="copied">Copié</span>
        <span v-else>Copier</span>
      </button>
    </div>

    <p class="warning">
      Conserve-la dans un gestionnaire de mots de passe ou imprime-la. Sans
      cette clé <strong>et</strong> ton mot de passe, tes notes seront
      irrécupérables.
    </p>

    <label class="ack">
      <input v-model="acknowledged" type="checkbox" />
      <span>J'ai sauvegardé ma clé de récupération.</span>
    </label>

    <div class="actions">
      <button
        type="button"
        class="primary"
        :disabled="!acknowledged"
        @click="continueAfterRecovery"
      >
        Continuer
      </button>
    </div>
  </section>

  <!-- ----- Standard registration form ----- -->
  <form v-else class="auth-form" @submit.prevent="onSubmit" novalidate>
    <p class="eyebrow">{{ t('auth.register.eyebrow') }}</p>
    <h1 class="title">{{ t('auth.register.title') }}</h1>

    <div class="fields">
      <label class="field">
        <span class="label">{{ t('auth.register.inviteCode') }}</span>
        <input
          v-model="inviteCode"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          required
          :placeholder="t('auth.register.inviteCodePlaceholder')"
        />
      </label>

      <label class="field">
        <span class="label">{{ t('auth.register.displayName') }} <span class="opt">{{ t('auth.register.optional') }}</span></span>
        <input
          v-model="displayName"
          type="text"
          autocomplete="name"
          :placeholder="t('auth.register.displayNamePlaceholder')"
        />
      </label>

      <label class="field">
        <span class="label">{{ t('auth.signIn.email') }}</span>
        <input
          v-model="email"
          type="email"
          autocomplete="email"
          required
          :placeholder="t('auth.signIn.emailPlaceholder')"
        />
      </label>

      <label class="field">
        <span class="label">{{ t('auth.signIn.password') }}</span>
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
          :placeholder="t('auth.register.passwordPlaceholder')"
        />
      </label>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="actions">
      <button type="submit" class="primary" :disabled="pending">
        <span v-if="!pending">{{ t('auth.register.create') }}</span>
        <span v-else>{{ t('auth.register.creating') }}</span>
      </button>
    </div>

    <p class="alt">
      <span>{{ t('auth.register.altQuestion') }}</span>
      <NuxtLink to="/login">{{ t('auth.register.altLink') }}</NuxtLink>
    </p>
  </form>
</template>

<style scoped>
.auth-form { @apply w-full max-w-[360px] mx-auto; }
.auth-form.recovery { @apply max-w-[440px]; }

.eyebrow { @apply label-mono mb-4; }
.title {
  @apply font-serif text-[2.25rem] leading-[1.05] tracking-tight text-ink-900 dark:text-ink-100 mb-6;
}
.title::after {
  content: '';
  @apply inline-block ml-1 h-1.5 w-1.5 rounded-full bg-accent-500;
  transform: translateY(-2px);
}

.lede {
  @apply font-sans text-[14px] text-ink-600 dark:text-ink-300 mb-6;
}

.recovery-key {
  @apply relative bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded px-4 py-4 flex items-center justify-between gap-3 mb-3;
}
.recovery-key code {
  @apply font-mono text-[15px] tracking-wider text-ink-900 dark:text-ink-100 select-all;
}
.copy {
  @apply font-sans uppercase text-[10px] font-semibold tracking-[0.14em] px-2 py-1 rounded border border-ink-300 dark:border-ink-600 text-ink-700 dark:text-ink-300;
  transition: background 120ms ease, color 120ms ease;
}
.copy:hover {
  @apply bg-ink-100 dark:bg-ink-800;
}

.warning {
  @apply font-sans text-[12.5px] text-accent-700 dark:text-accent-300 mb-5 leading-relaxed;
}
.warning strong { @apply font-semibold; }

.ack {
  @apply flex items-start gap-2 font-sans text-[13px] text-ink-700 dark:text-ink-300 mb-5 cursor-pointer;
}
.ack input { @apply mt-0.5 accent-accent-600; }

.fields { @apply flex flex-col gap-5 mb-4; }
.field { @apply flex flex-col gap-1.5; }
.label {
  @apply label-mono flex items-center gap-2;
}
.opt {
  @apply font-sans normal-case text-[12px] tracking-normal text-ink-400 dark:text-ink-500 italic font-normal;
}
.field input {
  @apply bg-transparent border-0 border-b border-ink-300 dark:border-ink-700 px-0 py-2 text-[15px] text-ink-900 dark:text-ink-100;
  outline: none;
  transition: border-color 140ms ease;
}
.field input::placeholder { @apply text-ink-300 dark:text-ink-600; }
.field input:focus { @apply border-ink-900; }
html.dark .field input:focus { border-color: theme('colors.ink.100'); }

.error {
  @apply font-sans text-[12px] text-accent-700 dark:text-accent-300 mt-2;
}

.actions { @apply mt-6; }
.primary {
  @apply w-full inline-flex items-center justify-center h-11 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-white;
  background: theme('colors.ink.900');
  transition: background 120ms ease, transform 80ms ease, color 120ms ease;
}
html.dark .primary {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.primary:hover:not(:disabled) {
  background: theme('colors.accent.600');
}
html.dark .primary:hover:not(:disabled) {
  background: theme('colors.accent.600');
  color: theme('colors.ink.50');
}
.primary:active:not(:disabled) { transform: translateY(1px); }
.primary:disabled { opacity: 0.6; cursor: not-allowed; }

.alt {
  @apply mt-6 text-[12.5px] text-ink-500 dark:text-ink-400 flex items-center gap-2;
}
.alt a {
  @apply text-ink-800 dark:text-ink-200 underline underline-offset-4 decoration-ink-300 dark:decoration-ink-600;
  transition: color 120ms ease, text-decoration-color 120ms ease;
}
.alt a:hover {
  color: theme('colors.accent.700');
  text-decoration-color: theme('colors.accent.500');
}
html.dark .alt a:hover {
  color: theme('colors.accent.300');
}
</style>
