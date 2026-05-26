<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useWorkspacesStore } from '~/stores/workspaces'
import { useLocale } from '~/composables/useLocale'

// We pick the layout dynamically based on session: logged-out visitors get
// the marketing landing, logged-in users get the app shell for the
// workspace bootstrap. We do this with `setPageLayout` instead of an
// inline `<NuxtLayout :name>` wrapper inside this page's template —
// nesting a `<NuxtLayout>` in a page with `layout: false` desynchronises
// the outer `<NuxtLayout>` in app.vue, so navigating away (e.g. clicking
// "Se connecter" → /login which declares its own `auth` layout) updates
// the URL but never re-renders the page tree until a manual reload.
definePageMeta({ layout: 'landing' })

const { loggedIn } = useUserSession()
const { t } = useLocale()

// Match the layout to the initial session state, then keep them in sync
// if the user signs in / out without a hard reload.
setPageLayout(loggedIn.value ? 'default' : 'landing')
watch(() => loggedIn.value, (v) => {
  setPageLayout(v ? 'default' : 'landing')
})

useHead(() => ({
  title: loggedIn.value
    ? 'NoteForge'
    : 'NoteForge — penser, sur du papier qui se souvient',
}))

const workspacesStore = useWorkspacesStore()
const checking = ref(loggedIn.value)
const creating = ref(false)
const error = ref<string | null>(null)
const newName = ref('')

onMounted(async () => {
  if (!loggedIn.value) return
  try {
    const list = await workspacesStore.fetchAll()
    if (list[0]) {
      await navigateTo(`/w/${list[0].id}`, { replace: true })
      return
    }
  } catch (e: unknown) {
    error.value = (e as Error).message ?? t('workspace.empty.errorLoad')
  } finally {
    checking.value = false
  }
})

async function onCreate() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  error.value = null
  try {
    const ws = await workspacesStore.create(name)
    await navigateTo(`/w/${ws.id}`, { replace: true })
  } catch (e: unknown) {
    error.value = (e as Error).message ?? t('workspace.empty.errorCreate')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <!-- Logged-out: marketing landing -->
  <LandingPage v-if="!loggedIn" />

  <!-- Logged-in: workspace bootstrap (redirects when one exists,
       otherwise shows the create-first-workspace form). -->
  <div v-else class="welcome">
    <div v-if="checking" class="loading">
      <span class="dot" /> <span class="dot" /> <span class="dot" />
    </div>

    <div v-else class="cta">
      <p class="eyebrow">{{ t('workspace.empty.eyebrow') }}</p>
      <h1 class="title">{{ t('workspace.empty.title') }}</h1>
      <p class="lede">
        {{ t('workspace.empty.lede') }}
      </p>

      <form class="form" @submit.prevent="onCreate">
        <label class="field">
          <span class="label">{{ t('workspace.empty.label') }}</span>
          <input v-model="newName" type="text" required autofocus :placeholder="t('workspace.empty.placeholder')" />
        </label>
        <button type="submit" class="primary" :disabled="creating || !newName.trim()">
          <span v-if="!creating">{{ t('workspace.new.create') }}</span>
          <span v-else>{{ t('workspace.new.creating') }}</span>
        </button>
      </form>

      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  @apply h-full w-full flex items-center justify-center px-8;
}
.loading {
  @apply flex items-center gap-1.5;
}
.dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-ink-300 dark:bg-ink-600;
  animation: pulse 1.2s ease-in-out infinite;
}
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes pulse {
  0%, 100% { opacity: 0.35; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

.cta {
  @apply max-w-[440px] w-full;
}
.eyebrow {
  @apply label-mono mb-4;
}
.title {
  @apply font-serif text-[2rem] leading-[1.1] tracking-tight text-ink-900 dark:text-ink-100 mb-3;
}
.lede {
  @apply text-[14px] leading-relaxed text-ink-600 dark:text-ink-300 mb-8;
}

.form { @apply flex flex-col gap-4; }
.field { @apply flex flex-col gap-1.5; }
.label {
  @apply label-mono;
}
.field input {
  @apply bg-transparent border-0 border-b border-ink-300 dark:border-ink-700 px-0 py-2 text-[15px] text-ink-900 dark:text-ink-100;
  outline: none;
  transition: border-color 140ms ease;
}
.field input::placeholder { @apply text-ink-300 dark:text-ink-600; }
.field input:focus { @apply border-ink-900; }
html.dark .field input:focus { border-color: theme('colors.ink.100'); }

.primary {
  @apply inline-flex items-center justify-center h-11 px-6 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-white self-start;
  background: theme('colors.ink.900');
  transition: background 120ms ease, transform 80ms ease, color 120ms ease;
}
html.dark .primary {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.primary:hover:not(:disabled) { background: theme('colors.accent.600'); }
html.dark .primary:hover:not(:disabled) {
  background: theme('colors.accent.600');
  color: theme('colors.ink.50');
}
.primary:disabled { opacity: 0.55; cursor: not-allowed; }

.error {
  @apply mt-4 font-sans text-[12px] text-accent-700 dark:text-accent-300;
}
</style>
