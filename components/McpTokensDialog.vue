<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useNow } from '@vueuse/core'
import { useMcpTokensStore } from '~/stores/mcpTokens'
import { useMcpConnectorsStore } from '~/stores/mcpConnectors'
import { useLocale } from '~/composables/useLocale'
import { useDialog } from '~/composables/useDialog'

const { t } = useLocale()
const dialog = useDialog()
const store = useMcpTokensStore()
const { tokens, loading, freshToken, freshTokenMeta } = storeToRefs(store)

const connectorsStore = useMcpConnectorsStore()
const {
  connectors,
  loading: connectorsLoading,
  freshSecret,
  freshConnector,
} = storeToRefs(connectorsStore)

/**
 * Two ways to plug a client into the MCP endpoint, and the choice is dictated
 * by what the client can do — not by preference:
 *
 *  - `bearer` — a static `nf_…` token in an `Authorization` header. Works for
 *    Claude Desktop (through the `mcp-remote` stdio bridge), scripts, curl.
 *  - `oauth`  — claude.ai's "custom connector", which has no way to send a
 *    custom header and only speaks OAuth. NoteForge acts as the authorization
 *    server; the user pastes the URL + client id + secret into Claude's
 *    advanced connector settings.
 */
type AuthMode = 'bearer' | 'oauth'
const authMode = ref<AuthMode>('bearer')

const connectorName = ref('')
const creatingConnector = ref(false)

const props = defineProps<{
  isOpen: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
}>()

const tokenName = ref('')
const creating = ref(false)
const error = ref<string | null>(null)
const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const origin = computed(() =>
  typeof window === 'undefined' ? '' : window.location.origin,
)
const mcpUrl = computed(() => `${origin.value}/api/mcp`)

/**
 * Detect host OS from the user agent so the generated snippet matches the
 * shell quirks of the user's platform. Conservative on uncertainty: defaults
 * to macOS / Unix (plain `npx`), which is the most permissive.
 */
type OsKind = 'macos' | 'windows' | 'linux'
const detectedOs = ref<OsKind>('macos')

if (typeof navigator !== 'undefined') {
  const ua = navigator.userAgent || ''
  if (/Windows/i.test(ua)) detectedOs.value = 'windows'
  else if (/Linux/i.test(ua) && !/Android/i.test(ua)) detectedOs.value = 'linux'
  else detectedOs.value = 'macos'
}

/** User can override the auto-detected OS — useful when copying the config
 *  for a machine they're not currently on. */
const selectedOs = ref<OsKind>(detectedOs.value)

watch(detectedOs, (v) => { selectedOs.value = v }, { immediate: false })

/**
 * Claude Desktop `claude_desktop_config.json` snippet. We go through
 * `mcp-remote` (a tiny stdio→HTTP bridge) instead of pointing Claude Desktop
 * at the URL directly: the direct HTTP transport triggers Claude Desktop's
 * OAuth discovery flow (it'll prompt for client id / secret), whereas
 * `mcp-remote` passes our bearer header through verbatim.
 *
 * On Windows we wrap with `cmd /c` because Claude Desktop spawns commands
 * without a shell, and `npx` on Windows is actually `npx.cmd` — without the
 * shell wrapper the spawn fails with "no such file". Same trick works for
 * any other `.cmd`/`.bat` executable. macOS / Linux get the plain `npx` form.
 */
const configSnippet = computed(() => {
  const token = freshToken.value ?? 'YOUR_TOKEN_HERE'
  const remoteArgs = [
    '-y',
    'mcp-remote',
    mcpUrl.value,
    '--header',
    `Authorization: Bearer ${token}`,
  ]
  const entry = selectedOs.value === 'windows'
    ? {
      command: 'cmd',
      args: ['/c', 'npx', ...remoteArgs],
    }
    : {
      command: 'npx',
      args: remoteArgs,
    }
  return JSON.stringify(
    {
      mcpServers: {
        noteforge: entry,
      },
    },
    null,
    2,
  )
})

async function onCreate() {
  if (creating.value) return
  creating.value = true
  error.value = null
  try {
    await store.create(tokenName.value.trim() || undefined)
    tokenName.value = ''
  }
  catch (e) {
    error.value = (e as Error).message || t('mcp.errorCreate')
  }
  finally {
    creating.value = false
  }
}

/* ---------- OAuth connectors ------------------------------------------- */

/**
 * The connector whose credentials the OAuth steps display. Right after
 * creation that's the fresh one (the only moment its secret exists in the
 * clear); otherwise the most recent, so reopening the dialog still shows the
 * URL and client id needed to finish a half-done setup.
 */
const activeConnector = computed(() => freshConnector.value ?? connectors.value[0] ?? null)

async function onCreateConnector() {
  if (creatingConnector.value) return
  creatingConnector.value = true
  error.value = null
  try {
    await connectorsStore.create(connectorName.value.trim() || undefined)
    connectorName.value = ''
  }
  catch (e) {
    error.value = (e as Error).message || t('mcp.oauth.errorCreate')
  }
  finally {
    creatingConnector.value = false
  }
}

async function onRevokeConnector(row: { id: number, name: string | null, clientId: string }) {
  const label = row.name && row.name.trim().length > 0
    ? `"${row.name}" (${row.clientId})`
    : row.clientId
  const ok = await dialog.confirm({
    title: t('mcp.oauth.revoke.title'),
    message: t('mcp.oauth.revoke.message', { label }),
    confirmLabel: t('mcp.revoke.confirm'),
    destructive: true,
  })
  if (!ok) return
  error.value = null
  try {
    await connectorsStore.revoke(row.id)
  }
  catch (e) {
    await dialog.alert({
      title: t('mcp.revoke.failed'),
      message: (e as Error).message || t('mcp.revoke.failedMsg'),
    })
  }
}

async function onRevoke(row: { id: number, prefix: string, name: string | null }) {
  const label = row.name && row.name.trim().length > 0
    ? `"${row.name}" (${row.prefix}…)`
    : `${row.prefix}…`
  const ok = await dialog.confirm({
    title: t('mcp.revoke.title'),
    message: t('mcp.revoke.message', { label }),
    confirmLabel: t('mcp.revoke.confirm'),
    destructive: true,
  })
  if (!ok) return
  error.value = null
  try {
    await store.revoke(row.id)
  }
  catch (e) {
    await dialog.alert({
      title: t('mcp.revoke.failed'),
      message: (e as Error).message || t('mcp.revoke.failedMsg'),
    })
  }
}

async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedKey.value = null }, 1500)
  }
  catch {
    // Clipboard write can fail in non-secure contexts. Silently ignore —
    // the textarea is selectable too.
  }
}

function dismissFresh() {
  store.clearFresh()
}

function dismissFreshSecret() {
  connectorsStore.clearFresh()
}

function close() {
  // Dismiss the freshly-generated secrets on close so re-opening the dialog
  // doesn't leak them to subsequent viewers of the screen.
  store.clearFresh()
  connectorsStore.clearFresh()
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (freshToken.value) dismissFresh()
    else if (freshSecret.value) dismissFreshSecret()
    else close()
  }
}

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      error.value = null
      store.load().catch((e) => {
        error.value = (e as Error).message || t('mcp.errorLoad')
      })
      connectorsStore.load().catch((e) => {
        error.value = (e as Error).message || t('mcp.errorLoad')
      })
    }
  },
)

/**
 * Localized "X ago" label for the `lastUsedAt` cell. A single shared `useNow`
 * (30s interval) means the labels refresh together — calling a composable
 * inside `v-for` would create a fresh ticker per row and leak effects.
 */
const now = useNow({ interval: 30_000 })

function formatLastUsed(raw: string | number | Date | null): string {
  if (raw == null) return ''
  const d = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(d.getTime())) return ''

  const diffMs = now.value.getTime() - d.getTime()
  const abs = Math.abs(diffMs)
  const minutes = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)

  if (abs < 60_000) return t('history.rel.justNow')
  if (minutes < 60) return t('history.rel.minutes', { n: minutes })
  if (hours < 48) return t('history.rel.hours', { n: hours })
  return t('history.rel.days', { n: days })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div
        v-if="isOpen"
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-dialog-title"
        @click.self="close"
        @keydown="onKeydown"
      >
        <Transition name="card" appear>
          <div v-if="isOpen" class="card">
            <header class="head">
              <p class="eyebrow">{{ t('mcp.eyebrow') }}</p>
              <h2 id="mcp-dialog-title" class="title">{{ t('mcp.title') }}</h2>
              <p class="lede">{{ t('mcp.lede') }}</p>
            </header>

            <!-- ============================================================ -->
            <!-- Auth mode — bearer token vs OAuth custom connector           -->
            <!-- ============================================================ -->
            <div class="modes" role="radiogroup" :aria-label="t('mcp.mode.label')">
              <button
                v-for="mode in (['bearer', 'oauth'] as const)"
                :key="mode"
                type="button"
                role="radio"
                :aria-checked="authMode === mode"
                class="mode"
                :class="{ 'mode--active': authMode === mode }"
                @click="authMode = mode"
              >
                <span class="mode-title">{{ t(`mcp.mode.${mode}.title`) }}</span>
                <span class="mode-lede">{{ t(`mcp.mode.${mode}.lede`) }}</span>
              </button>
            </div>

            <template v-if="authMode === 'bearer'">
            <!-- ============================================================ -->
            <!-- Step 1 — Generate a token                                     -->
            <!-- ============================================================ -->
            <section class="step" :class="{ 'step--done': !!freshToken }">
              <div class="step-head">
                <span class="step-num" aria-hidden="true">
                  <svg v-if="freshToken" viewBox="0 0 16 16" width="11" height="11">
                    <path d="M3 8l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <span v-else>1</span>
                </span>
                <h3 class="step-title">{{ t('mcp.step1.title') }}</h3>
              </div>
              <p class="step-lede">{{ t('mcp.step1.lede') }}</p>

              <div v-if="!freshToken" class="create">
                <label class="field">
                  <span class="label">{{ t('mcp.nameLabel') }}</span>
                  <input
                    v-model="tokenName"
                    type="text"
                    :placeholder="t('mcp.namePlaceholder')"
                    class="input"
                    maxlength="120"
                    @keydown.enter.prevent="onCreate"
                  />
                </label>
                <button
                  type="button"
                  class="primary"
                  :disabled="creating"
                  @click="onCreate"
                >
                  <span v-if="!creating">{{ t('mcp.generate') }}</span>
                  <span v-else>{{ t('mcp.generating') }}</span>
                </button>
              </div>

              <p v-if="error" class="error">{{ error }}</p>

              <!-- Token reveal (shown once, in place of the form) -->
              <div v-if="freshToken" class="fresh" :aria-label="t('mcp.fresh.title')">
                <div class="fresh-head">
                  <span class="fresh-eyebrow">{{ t('mcp.fresh.eyebrow') }}</span>
                  <button
                    type="button"
                    class="icon-btn"
                    :title="t('mcp.fresh.dismiss')"
                    @click="dismissFresh"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path
                        d="M4 4l8 8 M12 4l-8 8"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                </div>
                <p class="fresh-warn">{{ t('mcp.fresh.warn') }}</p>
                <div class="endpoint-row">
                  <input
                    :value="freshToken"
                    readonly
                    class="row-input row-input--secret"
                    @focus="($event.target as HTMLInputElement).select()"
                  />
                  <button
                    type="button"
                    class="ghost-btn ghost-btn--sm"
                    @click="copy(freshToken!, 'token')"
                  >
                    {{ copiedKey === 'token' ? t('mcp.copied') : t('mcp.copy') }}
                  </button>
                </div>
              </div>
            </section>

            <!-- ============================================================ -->
            <!-- Step 2 — Paste config (only after token is generated)        -->
            <!-- ============================================================ -->
            <section class="step" :class="{ 'step--muted': !freshToken }">
              <div class="step-head">
                <span class="step-num" aria-hidden="true">2</span>
                <h3 class="step-title">{{ t('mcp.step2.title') }}</h3>
              </div>
              <p class="step-lede">{{ t('mcp.step2.lede') }}</p>

              <!-- Platform paths. Clicking a row also switches the snippet
                   below to match (matters for Windows: needs `cmd /c npx`). -->
              <div class="paths" role="radiogroup" :aria-label="t('mcp.os.label')">
                <button
                  v-for="os in (['macos', 'windows', 'linux'] as const)"
                  :key="os"
                  type="button"
                  role="radio"
                  :aria-checked="selectedOs === os"
                  class="path"
                  :class="{ 'path--active': selectedOs === os }"
                  @click="selectedOs = os"
                >
                  <span class="path-os">
                    <span v-if="selectedOs === os" class="path-dot" aria-hidden="true" />
                    {{ t(`mcp.os.${os}`) }}
                  </span>
                  <code class="path-code">{{
                    os === 'macos'
                      ? '~/Library/Application Support/Claude/claude_desktop_config.json'
                      : os === 'windows'
                        ? '%APPDATA%\\Claude\\claude_desktop_config.json'
                        : '~/.config/Claude/claude_desktop_config.json'
                  }}</code>
                </button>
              </div>

              <div class="snippet-block">
                <div class="snippet-head">
                  <span class="label">{{ t('mcp.snippet.title') }}</span>
                  <button
                    type="button"
                    class="ghost-btn ghost-btn--sm"
                    :disabled="!freshToken"
                    @click="copy(configSnippet, 'snippet')"
                  >
                    {{ copiedKey === 'snippet' ? t('mcp.copied') : t('mcp.copy') }}
                  </button>
                </div>
                <pre class="snippet"><code>{{ configSnippet }}</code></pre>
                <p class="snippet-hint">{{ t('mcp.snippet.bridge') }}</p>
              </div>
            </section>

            <!-- ============================================================ -->
            <!-- Step 3 — Restart                                              -->
            <!-- ============================================================ -->
            <section class="step" :class="{ 'step--muted': !freshToken }">
              <div class="step-head">
                <span class="step-num" aria-hidden="true">3</span>
                <h3 class="step-title">{{ t('mcp.step3.title') }}</h3>
              </div>
              <p class="step-lede">{{ t('mcp.step3.lede') }}</p>
            </section>

            <!-- Existing tokens list -->
            <section class="list" :aria-label="t('mcp.list.title')">
              <div class="list-head">
                <p class="label">{{ t('mcp.list.title') }}</p>
                <span v-if="tokens.length > 0" class="list-count">{{ tokens.length }}</span>
              </div>
              <p v-if="loading && tokens.length === 0" class="muted">{{ t('mcp.list.loading') }}</p>
              <p v-else-if="!loading && tokens.length === 0" class="muted">
                {{ t('mcp.list.empty') }}
              </p>
              <ul v-else class="rows">
                <li v-for="row in tokens" :key="row.id" class="row">
                  <div class="row-main">
                    <div class="row-info">
                      <span class="row-prefix">{{ row.prefix }}…</span>
                      <span v-if="row.name" class="row-name">{{ row.name }}</span>
                    </div>
                    <button
                      type="button"
                      class="ghost-btn ghost-btn--sm ghost-btn--danger"
                      @click="onRevoke(row)"
                    >
                      {{ t('mcp.revoke.button') }}
                    </button>
                  </div>
                  <div class="row-meta">
                    <span v-if="row.lastUsedAt">
                      {{ t('mcp.lastUsed', { when: formatLastUsed(row.lastUsedAt) }) }}
                    </span>
                    <span v-else class="muted-inline">{{ t('mcp.neverUsed') }}</span>
                  </div>
                </li>
              </ul>
            </section>
            </template>

            <template v-else>
            <!-- ============================================================ -->
            <!-- Step 1 — Register an OAuth connector                          -->
            <!-- ============================================================ -->
            <section class="step" :class="{ 'step--done': !!freshSecret }">
              <div class="step-head">
                <span class="step-num" aria-hidden="true">
                  <svg v-if="freshSecret" viewBox="0 0 16 16" width="11" height="11">
                    <path d="M3 8l3.5 3.5L13 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <span v-else>1</span>
                </span>
                <h3 class="step-title">{{ t('mcp.oauth.step1.title') }}</h3>
              </div>
              <p class="step-lede">{{ t('mcp.oauth.step1.lede') }}</p>

              <div v-if="!freshSecret" class="create">
                <label class="field">
                  <span class="label">{{ t('mcp.oauth.nameLabel') }}</span>
                  <input
                    v-model="connectorName"
                    type="text"
                    :placeholder="t('mcp.oauth.namePlaceholder')"
                    class="input"
                    maxlength="120"
                    @keydown.enter.prevent="onCreateConnector"
                  />
                </label>
                <button
                  type="button"
                  class="primary"
                  :disabled="creatingConnector"
                  @click="onCreateConnector"
                >
                  <span v-if="!creatingConnector">{{ t('mcp.oauth.generate') }}</span>
                  <span v-else>{{ t('mcp.generating') }}</span>
                </button>
              </div>

              <p v-if="error" class="error">{{ error }}</p>

              <!-- Secret reveal (shown once, in place of the form) -->
              <div v-if="freshSecret" class="fresh" :aria-label="t('mcp.oauth.fresh.title')">
                <div class="fresh-head">
                  <span class="fresh-eyebrow">{{ t('mcp.oauth.fresh.eyebrow') }}</span>
                  <button
                    type="button"
                    class="icon-btn"
                    :title="t('mcp.fresh.dismiss')"
                    @click="dismissFreshSecret"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path
                        d="M4 4l8 8 M12 4l-8 8"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                </div>
                <p class="fresh-warn">{{ t('mcp.oauth.fresh.warn') }}</p>
              </div>
            </section>

            <!-- ============================================================ -->
            <!-- Step 2 — Paste the three fields into Claude                   -->
            <!-- ============================================================ -->
            <section class="step" :class="{ 'step--muted': !activeConnector }">
              <div class="step-head">
                <span class="step-num" aria-hidden="true">2</span>
                <h3 class="step-title">{{ t('mcp.oauth.step2.title') }}</h3>
              </div>
              <p class="step-lede">{{ t('mcp.oauth.step2.lede') }}</p>

              <div class="creds">
                <div class="cred">
                  <span class="label">{{ t('mcp.oauth.field.url') }}</span>
                  <div class="endpoint-row">
                    <input
                      :value="mcpUrl"
                      readonly
                      class="row-input"
                      @focus="($event.target as HTMLInputElement).select()"
                    />
                    <button
                      type="button"
                      class="ghost-btn ghost-btn--sm"
                      @click="copy(mcpUrl, 'oauth-url')"
                    >
                      {{ copiedKey === 'oauth-url' ? t('mcp.copied') : t('mcp.copy') }}
                    </button>
                  </div>
                </div>

                <div class="cred">
                  <span class="label">{{ t('mcp.oauth.field.clientId') }}</span>
                  <div class="endpoint-row">
                    <input
                      :value="activeConnector?.clientId ?? ''"
                      readonly
                      :placeholder="t('mcp.oauth.field.pending')"
                      class="row-input"
                      @focus="($event.target as HTMLInputElement).select()"
                    />
                    <button
                      type="button"
                      class="ghost-btn ghost-btn--sm"
                      :disabled="!activeConnector"
                      @click="copy(activeConnector?.clientId ?? '', 'oauth-client-id')"
                    >
                      {{ copiedKey === 'oauth-client-id' ? t('mcp.copied') : t('mcp.copy') }}
                    </button>
                  </div>
                </div>

                <div class="cred">
                  <span class="label">{{ t('mcp.oauth.field.clientSecret') }}</span>
                  <div class="endpoint-row">
                    <input
                      :value="freshSecret ?? ''"
                      readonly
                      :placeholder="activeConnector ? t('mcp.oauth.field.secretGone') : t('mcp.oauth.field.pending')"
                      class="row-input"
                      :class="{ 'row-input--secret': !!freshSecret }"
                      @focus="($event.target as HTMLInputElement).select()"
                    />
                    <button
                      type="button"
                      class="ghost-btn ghost-btn--sm"
                      :disabled="!freshSecret"
                      @click="copy(freshSecret ?? '', 'oauth-client-secret')"
                    >
                      {{ copiedKey === 'oauth-client-secret' ? t('mcp.copied') : t('mcp.copy') }}
                    </button>
                  </div>
                  <p v-if="activeConnector && !freshSecret" class="cred-hint">
                    {{ t('mcp.oauth.field.secretGoneHint') }}
                  </p>
                </div>
              </div>
            </section>

            <!-- ============================================================ -->
            <!-- Step 3 — Connect & authorize                                  -->
            <!-- ============================================================ -->
            <section class="step" :class="{ 'step--muted': !activeConnector }">
              <div class="step-head">
                <span class="step-num" aria-hidden="true">3</span>
                <h3 class="step-title">{{ t('mcp.oauth.step3.title') }}</h3>
              </div>
              <p class="step-lede">{{ t('mcp.oauth.step3.lede') }}</p>
            </section>

            <!-- Existing connectors list -->
            <section class="list" :aria-label="t('mcp.oauth.list.title')">
              <div class="list-head">
                <p class="label">{{ t('mcp.oauth.list.title') }}</p>
                <span v-if="connectors.length > 0" class="list-count">{{ connectors.length }}</span>
              </div>
              <p v-if="connectorsLoading && connectors.length === 0" class="muted">
                {{ t('mcp.oauth.list.loading') }}
              </p>
              <p v-else-if="!connectorsLoading && connectors.length === 0" class="muted">
                {{ t('mcp.oauth.list.empty') }}
              </p>
              <ul v-else class="rows">
                <li v-for="row in connectors" :key="row.id" class="row">
                  <div class="row-main">
                    <div class="row-info">
                      <span class="row-prefix">{{ row.clientId }}</span>
                      <span v-if="row.name" class="row-name">{{ row.name }}</span>
                    </div>
                    <button
                      type="button"
                      class="ghost-btn ghost-btn--sm ghost-btn--danger"
                      @click="onRevokeConnector(row)"
                    >
                      {{ t('mcp.revoke.button') }}
                    </button>
                  </div>
                  <div class="row-meta">
                    <span v-if="row.lastUsedAt">
                      {{ t('mcp.lastUsed', { when: formatLastUsed(row.lastUsedAt) }) }}
                    </span>
                    <span v-else class="muted-inline">{{ t('mcp.neverUsed') }}</span>
                  </div>
                </li>
              </ul>
            </section>
            </template>

            <footer class="foot">
              <button type="button" class="ghost-btn" @click="close">{{ t('mcp.close') }}</button>
            </footer>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center px-6 py-10;
  background: theme('colors.ink.900' / 35%);
  backdrop-filter: blur(4px);
  overflow-y: auto;
}
html.dark .overlay {
  background: theme('colors.ink.950' / 70%);
}

.card {
  @apply relative w-full max-w-[640px] rounded-lg bg-ink-50 dark:bg-ink-900 px-8 py-7;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
html.dark .card {
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -20px theme('colors.ink.950' / 70%);
}

.head { @apply mb-6; }
.eyebrow { @apply label-mono mb-3; }
.title {
  @apply font-serif text-[1.55rem] leading-[1.15] tracking-tight text-ink-900 dark:text-ink-100 mb-2;
}
.lede { @apply text-[13px] leading-relaxed text-ink-600 dark:text-ink-300; }

.endpoint-row { @apply flex items-center gap-2; }

/* ----- Auth mode selector -------------------------------------------- */
.modes { @apply grid grid-cols-2 gap-2 mb-6; }
.mode {
  @apply flex flex-col gap-1 text-left px-3 py-2.5 rounded;
  border: 1px solid theme('colors.ink.200');
  background: transparent;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
html.dark .mode { border-color: theme('colors.ink.800'); }
.mode:hover { background: theme('colors.ink.100' / 50%); }
html.dark .mode:hover { background: theme('colors.ink.800' / 50%); }
.mode--active {
  background: theme('colors.accent.50' / 60%);
  border-color: theme('colors.accent.400');
}
html.dark .mode--active {
  background: theme('colors.accent.900' / 25%);
  border-color: theme('colors.accent.600');
}
.mode-title {
  @apply font-sans uppercase text-[10px] font-semibold tracking-[0.1em] text-ink-600 dark:text-ink-300;
}
.mode--active .mode-title { @apply text-accent-700 dark:text-accent-300; }
.mode-lede {
  @apply text-[11.5px] leading-snug text-ink-500 dark:text-ink-400;
}

/* ----- OAuth credential rows ----------------------------------------- */
.creds { @apply flex flex-col gap-3 pl-[34px]; }
.cred { @apply flex flex-col gap-1.5; }
.cred-hint {
  @apply text-[11.5px] leading-snug text-ink-500 dark:text-ink-400;
}

/* ----- Step blocks --------------------------------------------------- */
.step {
  @apply mb-5 pb-5;
  border-bottom: 1px solid theme('colors.ink.200' / 60%);
  transition: opacity 160ms ease;
}
html.dark .step { border-bottom-color: theme('colors.ink.800' / 60%); }
.step:last-of-type { border-bottom: none; }
.step--muted { opacity: 0.55; }
.step--done .step-num {
  background: theme('colors.accent.500');
  color: theme('colors.ink.50');
  border-color: theme('colors.accent.500');
}
html.dark .step--done .step-num {
  background: theme('colors.accent.500');
  color: theme('colors.ink.950');
}
.step-head { @apply flex items-center gap-2.5 mb-1.5; }
.step-num {
  @apply inline-flex items-center justify-center h-6 w-6 rounded-full font-sans text-[11px] font-semibold text-ink-700 dark:text-ink-200 shrink-0;
  border: 1px solid theme('colors.ink.300');
  background: transparent;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
html.dark .step-num { border-color: theme('colors.ink.700'); }
.step-title {
  @apply font-serif text-[15px] leading-tight tracking-tight text-ink-900 dark:text-ink-100 m-0;
}
.step-lede {
  @apply text-[12.5px] leading-relaxed text-ink-600 dark:text-ink-300 mb-3 pl-[34px];
}

/* ----- Step 1 / form ------------------------------------------------- */
.create {
  @apply flex items-end gap-3 pl-[34px];
}
.field { @apply flex flex-col gap-1.5 flex-1; }

/* ----- Step 2 / platform paths (clickable, switches snippet) -------- */
.paths { @apply flex flex-col gap-1 mb-3 pl-[34px]; }
.path {
  @apply flex items-baseline gap-3 flex-wrap text-left px-2 py-1.5 rounded -mx-2;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.path:hover {
  background: theme('colors.ink.100' / 50%);
}
html.dark .path:hover { background: theme('colors.ink.800' / 50%); }
.path--active {
  background: theme('colors.accent.50' / 60%);
  border-color: theme('colors.accent.300');
}
html.dark .path--active {
  background: theme('colors.accent.900' / 25%);
  border-color: theme('colors.accent.700');
}
.path-os {
  @apply font-sans uppercase text-[10px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400 shrink-0 inline-flex items-center gap-1.5;
  min-width: 64px;
}
.path--active .path-os {
  @apply text-accent-700 dark:text-accent-300;
}
.path-dot {
  @apply inline-block h-[5px] w-[5px] rounded-full bg-accent-500 dark:bg-accent-400;
}
.path-code {
  @apply font-mono text-[11.5px] text-ink-800 dark:text-ink-200 px-1.5 py-0.5 rounded;
  background: theme('colors.ink.100' / 70%);
}
html.dark .path-code { background: theme('colors.ink.800' / 70%); }
.path--active .path-code {
  background: theme('colors.ink.50');
  color: theme('colors.ink.900');
}
html.dark .path--active .path-code {
  background: theme('colors.ink.900');
  color: theme('colors.ink.50');
}

.label { @apply label-mono; }
.input {
  @apply h-10 px-3 rounded bg-transparent text-[14px] text-ink-900 dark:text-ink-100;
  border: 1px solid theme('colors.ink.200');
  outline: none;
  transition: border-color 140ms ease;
}
html.dark .input { border-color: theme('colors.ink.800'); }
.input:focus { border-color: theme('colors.ink.900'); }
html.dark .input:focus { border-color: theme('colors.ink.100'); }

.row-input {
  @apply flex-1 min-w-0 h-9 px-2 rounded font-mono text-[12px] bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-100;
  border: 1px solid transparent;
  outline: none;
}
.row-input:focus { border-color: theme('colors.ink.300'); }
html.dark .row-input:focus { border-color: theme('colors.ink.700'); }
.row-input--secret {
  @apply bg-accent-50 dark:bg-accent-900/40 text-accent-900 dark:text-accent-200;
}

.error {
  @apply font-sans text-[12px] text-accent-700 dark:text-accent-300 mt-3 pl-[34px];
}

.fresh {
  @apply rounded-md p-4 ml-[34px];
  border: 1px dashed theme('colors.accent.400');
  background: theme('colors.accent.50' / 50%);
}
html.dark .fresh {
  border-color: theme('colors.accent.500');
  background: theme('colors.accent.900' / 25%);
}
.fresh-head { @apply flex items-center justify-between mb-2; }
.fresh-eyebrow {
  @apply font-sans uppercase text-[10px] font-semibold tracking-[0.12em] text-accent-700 dark:text-accent-300;
}
.fresh-warn {
  @apply text-[12px] text-ink-700 dark:text-ink-200 mb-2;
}
.icon-btn {
  @apply inline-flex items-center justify-center h-6 w-6 rounded text-ink-500 dark:text-ink-400;
  transition: background 120ms ease, color 120ms ease;
}
.icon-btn:hover {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .icon-btn:hover {
  background: theme('colors.ink.800');
  color: theme('colors.ink.50');
}

.snippet-block { @apply mt-3 pl-[34px]; }
.snippet-head { @apply flex items-center justify-between mb-1.5; }
.snippet {
  @apply rounded p-3 font-mono text-[11.5px] leading-snug bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-100 overflow-auto m-0;
  border: 1px solid theme('colors.ink.200');
  max-height: 240px;
  white-space: pre;
}
html.dark .snippet { border-color: theme('colors.ink.800'); }
.snippet-hint {
  @apply mt-2 text-[11.5px] text-ink-500 dark:text-ink-400 leading-snug;
}

.list { @apply mt-2 mb-5; }
.list-head { @apply flex items-center gap-2 mb-2; }
.list-count {
  @apply inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full font-sans text-[10px] font-semibold text-ink-600 dark:text-ink-300;
  background: theme('colors.ink.100');
}
html.dark .list-count { background: theme('colors.ink.800'); }
.muted { @apply text-[13px] text-ink-500 dark:text-ink-400 py-3; }
.muted-inline { @apply text-ink-500 dark:text-ink-400; }
.rows { @apply flex flex-col gap-3 list-none p-0 mt-2; }
.row {
  @apply rounded p-3;
  border: 1px solid theme('colors.ink.200');
}
html.dark .row { border-color: theme('colors.ink.800'); }
.row-main { @apply flex items-center justify-between gap-3; }
.row-info { @apply flex items-center gap-2 min-w-0; }
.row-prefix {
  @apply font-mono text-[12.5px] text-ink-800 dark:text-ink-100 truncate;
}
.row-name {
  @apply text-[12.5px] text-ink-600 dark:text-ink-300 truncate;
}
.row-meta {
  @apply mt-2 font-sans uppercase text-[10px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}

.foot { @apply flex items-center justify-end gap-3 pt-2; }

.primary {
  @apply inline-flex items-center justify-center h-10 px-5 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.12em] text-white shrink-0;
  background: theme('colors.ink.900');
  transition: background 120ms ease, color 120ms ease;
}
html.dark .primary {
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
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
.ghost-btn--sm { @apply h-8 px-3 text-[10px]; }
.ghost-btn--danger:hover {
  color: theme('colors.accent.700');
  border-color: theme('colors.accent.300');
}
html.dark .ghost-btn--danger:hover {
  color: theme('colors.accent.300');
  border-color: theme('colors.accent.600');
}

.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
.card-enter-from { opacity: 0; transform: translateY(8px) scale(0.98); }
.card-enter-to { opacity: 1; transform: translateY(0) scale(1); }
.card-enter-active { transition: opacity 160ms ease, transform 160ms ease; }
</style>
