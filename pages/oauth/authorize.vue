<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '~/composables/useLocale'

/**
 * OAuth consent screen — the `authorization_endpoint` advertised in
 * `/.well-known/oauth-authorization-server`.
 *
 * It's a page rather than an API route on purpose: the whole point of the
 * authorization-code flow is that a *human* approves in a browser, and a page
 * gets the session cookie, the app's chrome, and the global auth middleware
 * (which bounces anonymous visitors to `/login?redirect=…` and back here) for
 * free.
 *
 * Error handling follows RFC 6749 §4.1.2.1: problems with *who is asking*
 * (unknown client, unregistered redirect_uri) are rendered here — bouncing
 * them to an unvalidated URL would make this an open redirect. Everything
 * else, including the user pressing Deny, is reported back to the connector.
 */
definePageMeta({ layout: 'auth' })

const { t } = useLocale()
useHead(() => ({ title: t('oauth.consent.head') }))

const route = useRoute()
const { session } = useUserSession()

const submitting = ref(false)
const submitError = ref<string | null>(null)

function q(key: string): string | undefined {
  const v = route.query[key]
  return typeof v === 'string' ? v : undefined
}

interface AuthorizeInfo {
  client: { name: string | null, clientId: string }
  redirectUri: string
  state: string | null
  scope: string
}

/**
 * Server-side validation of the incoming authorization request. `useAsyncData`
 * (not a plain fetch on mount) so an invalid request renders its error on the
 * first paint instead of flashing a consent card that can't be honoured.
 */
const { data: info, error: validationError } = await useAsyncData<AuthorizeInfo>(
  'oauth-authorize',
  () => $fetch<AuthorizeInfo>('/api/oauth/authorize', { query: route.query }),
)

const validationMessage = computed(() => {
  if (!validationError.value) return null
  const data = (validationError.value as { data?: { data?: { error_description?: string } } }).data
  return data?.data?.error_description ?? t('oauth.consent.invalidRequest')
})

const accountLabel = computed(() => {
  const user = session.value?.user as { email?: string, displayName?: string } | undefined
  return user?.displayName || user?.email || ''
})

const connectorLabel = computed(
  () => info.value?.client.name?.trim() || t('oauth.consent.unnamedConnector'),
)

/** Hostname of the callback — the one piece of the redirect worth showing:
 *  it tells the user which service is about to receive the grant. */
const redirectHost = computed(() => {
  const uri = info.value?.redirectUri
  if (!uri) return ''
  try {
    return new URL(uri).host
  }
  catch {
    return uri
  }
})

async function approve() {
  if (submitting.value || !info.value) return
  submitting.value = true
  submitError.value = null
  try {
    const res = await $fetch<{ redirectTo: string }>('/api/oauth/authorize', {
      method: 'POST',
      body: {
        clientId: info.value.client.clientId,
        redirectUri: info.value.redirectUri,
        codeChallenge: q('code_challenge'),
        codeChallengeMethod: q('code_challenge_method'),
        state: q('state'),
        resource: q('resource'),
      },
    })
    // External navigation: the callback lives on claude.ai, not in this app.
    window.location.href = res.redirectTo
  }
  catch (e: unknown) {
    const data = (e as { data?: { data?: { error_description?: string }, message?: string } }).data
    submitError.value = data?.data?.error_description ?? data?.message ?? t('oauth.consent.errorGeneric')
    submitting.value = false
  }
}

function deny() {
  if (!info.value) return
  const target = new URL(info.value.redirectUri)
  target.searchParams.set('error', 'access_denied')
  target.searchParams.set('error_description', 'The user denied the request.')
  if (info.value.state) target.searchParams.set('state', info.value.state)
  window.location.href = target.toString()
}
</script>

<template>
  <div class="wrap">
    <!-- Request we refuse to act on: render, never redirect. -->
    <section v-if="validationMessage" class="card card--error">
      <p class="eyebrow">{{ t('oauth.consent.eyebrow') }}</p>
      <h1 class="title">{{ t('oauth.consent.invalidTitle') }}</h1>
      <p class="lede">{{ validationMessage }}</p>
      <NuxtLink to="/welcome" class="ghost-btn">{{ t('oauth.consent.backHome') }}</NuxtLink>
    </section>

    <section v-else-if="info" class="card">
      <p class="eyebrow">{{ t('oauth.consent.eyebrow') }}</p>
      <h1 class="title">{{ t('oauth.consent.title', { connector: connectorLabel }) }}</h1>
      <p class="lede">{{ t('oauth.consent.lede', { host: redirectHost }) }}</p>

      <ul class="grants">
        <li>{{ t('oauth.consent.grantRead') }}</li>
        <li>{{ t('oauth.consent.grantWrite') }}</li>
        <li>{{ t('oauth.consent.grantSearch') }}</li>
      </ul>

      <p class="account">
        {{ t('oauth.consent.account', { account: accountLabel }) }}
      </p>
      <p class="revoke-hint">{{ t('oauth.consent.revokeHint') }}</p>

      <p v-if="submitError" class="error">{{ submitError }}</p>

      <div class="actions">
        <button type="button" class="ghost-btn" :disabled="submitting" @click="deny">
          {{ t('oauth.consent.deny') }}
        </button>
        <button type="button" class="primary" :disabled="submitting" @click="approve">
          <span v-if="!submitting">{{ t('oauth.consent.approve') }}</span>
          <span v-else>{{ t('oauth.consent.approving') }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wrap { @apply w-full flex items-center justify-center; }

.card {
  @apply w-full max-w-[480px] rounded-lg bg-ink-50 dark:bg-ink-900 px-8 py-8;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 25%);
}
html.dark .card {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}
.card--error { @apply text-center; }

.eyebrow { @apply label-mono mb-3; }
.title {
  @apply font-serif text-[1.5rem] leading-[1.2] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.lede { @apply text-[13px] leading-relaxed text-ink-600 dark:text-ink-300; }

.grants {
  @apply mt-5 mb-5 flex flex-col gap-2 list-none p-0;
}
.grants li {
  @apply relative pl-5 text-[13px] leading-relaxed text-ink-700 dark:text-ink-200;
}
.grants li::before {
  content: '';
  @apply absolute left-0 top-[0.55em] h-[5px] w-[5px] rounded-full bg-accent-500;
}

.account {
  @apply text-[12.5px] text-ink-700 dark:text-ink-200 rounded px-3 py-2;
  background: theme('colors.ink.100' / 70%);
}
html.dark .account { background: theme('colors.ink.800' / 70%); }

.revoke-hint {
  @apply mt-2 text-[11.5px] leading-snug text-ink-500 dark:text-ink-400;
}

.error {
  @apply mt-4 font-sans text-[12px] text-accent-700 dark:text-accent-300;
}

.actions { @apply mt-6 flex items-center justify-end gap-3; }

.primary {
  @apply inline-flex items-center justify-center h-10 px-5 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-white shrink-0;
  background: theme('colors.ink.900');
  transition: background 120ms ease, color 120ms ease;
}
html.dark .primary { background: theme('colors.ink.800'); color: theme('colors.ink.100'); }
.primary:hover:not(:disabled) { background: theme('colors.accent.600'); }
html.dark .primary:hover:not(:disabled) { background: theme('colors.accent.600'); color: theme('colors.ink.50'); }
.primary:disabled { opacity: 0.55; cursor: not-allowed; }

.ghost-btn {
  @apply inline-flex items-center justify-center h-10 px-4 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-ink-700 dark:text-ink-200 shrink-0;
  border: 1px solid theme('colors.ink.200');
  background: transparent;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
html.dark .ghost-btn { border-color: theme('colors.ink.800'); }
.ghost-btn:hover {
  background: theme('colors.ink.100');
  border-color: theme('colors.ink.300');
  color: theme('colors.ink.900');
}
html.dark .ghost-btn:hover {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.50');
}
.card--error .ghost-btn { @apply mt-6; }
</style>
