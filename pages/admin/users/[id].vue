<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDialog } from '~/composables/useDialog'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const route = useRoute()
const router = useRouter()
const dialog = useDialog()

interface UserDetail {
  user: {
    id: number
    email: string
    displayName: string | null
    createdAt: string
    lastLoginAt: string | null
    isAdmin: boolean
    disabledAt: string | null
    workspaceCount: number
    docCount: number
    chunkCount: number
    chatSessionCount: number
  }
  workspaces: Array<{ id: number, name: string, emoji: string | null, createdAt: string, docCount: number }>
  aiUsage: Array<{ model: string, operation: string, promptTokens: number, completionTokens: number, totalTokens: number }>
  quotas: { maxDocs: number | null, maxTokensMonth: number | null, maxWorkspaces: number | null } | null
  mcpTokens: { active: number, revoked: number, total: number }
  decryptionFailures: number
  lastActivityAt: string | null
}

interface MeShape { id: number, email: string, isAdmin?: boolean }

const data = ref<UserDetail | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const actionLoading = ref(false)
const me = ref<MeShape | null>(null)

const userId = Number(route.params.id)

// Quotas form (separate so the user can clear a field to mean "unlimited").
const quotaMaxDocs = ref<string>('')
const quotaMaxTokens = ref<string>('')
const quotaMaxWorkspaces = ref<string>('')
const savingQuotas = ref(false)
const quotasMessage = ref<string | null>(null)

// Reset-password modal state.
const resetOpen = ref(false)
const resetPassword = ref('')
const resetConfirmWipe = ref(false)
const resetSubmitting = ref(false)
const resetRecoveryKey = ref<string | null>(null)
const resetError = ref<string | null>(null)
const resetCopied = ref(false)

async function refresh() {
  data.value = await $fetch<UserDetail>(`/api/admin/users/${userId}`)
  const d = data.value
  if (d) {
    quotaMaxDocs.value = d.quotas?.maxDocs != null ? String(d.quotas.maxDocs) : ''
    quotaMaxTokens.value = d.quotas?.maxTokensMonth != null ? String(d.quotas.maxTokensMonth) : ''
    quotaMaxWorkspaces.value = d.quotas?.maxWorkspaces != null ? String(d.quotas.maxWorkspaces) : ''
  }
}

onMounted(async () => {
  try {
    await refresh()
    try {
      const meRes = await $fetch<{ user: MeShape }>('/api/auth/me')
      me.value = meRes.user
    }
    catch { /* non-fatal */ }
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
})

const isSelf = computed(() => me.value?.id === userId)

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function fmtRelative(iso: string | null) {
  if (!iso) return '—'
  const ts = new Date(iso).getTime()
  const diff = Date.now() - ts
  if (diff < 0) return fmtDate(iso)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'à l’instant'
  if (mins < 60) return `il y a ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `il y a ${days} j`
  const months = Math.floor(days / 30)
  if (months < 12) return `il y a ${months} mois`
  const years = Math.floor(days / 365)
  return `il y a ${years} an${years > 1 ? 's' : ''}`
}

async function doAction(action: 'disable' | 'enable' | 'promote' | 'demote') {
  if (!data.value) return
  const labels: Record<string, string> = {
    disable: `Désactiver ${data.value.user.email} ?`,
    enable: `Réactiver ${data.value.user.email} ?`,
    promote: `Promouvoir ${data.value.user.email} admin ?`,
    demote: `Rétrograder ${data.value.user.email} ?`,
  }
  const ok = await dialog.confirm({
    title: labels[action]!,
    message: action === 'disable' ? 'Les données sont conservées, le login est bloqué.' : '',
    confirmLabel: 'Confirmer',
    destructive: action === 'disable',
  })
  if (!ok) return
  actionLoading.value = true
  try {
    await $fetch(`/api/admin/users/${userId}`, { method: 'PATCH', body: { action } })
    await refresh()
  }
  catch (e) {
    await dialog.alert({ title: 'Erreur', message: (e as Error).message })
  }
  finally {
    actionLoading.value = false
  }
}

async function doImpersonate() {
  if (!data.value) return
  const target = data.value.user
  if (isSelf.value || target.isAdmin) return
  const ok = await dialog.confirm({
    title: `Se connecter en tant que ${target.email} ?`,
    message: 'Votre session admin sera remplacée. Le contenu chiffré de cet utilisateur sera illisible (clé non disponible). Vous pourrez revenir à votre compte via la bannière.',
    confirmLabel: 'Se connecter',
    destructive: true,
  })
  if (!ok) return
  actionLoading.value = true
  try {
    await $fetch(`/api/admin/users/${userId}/impersonate`, { method: 'POST' })
    window.location.href = '/'
  }
  catch (e) {
    await dialog.alert({ title: 'Erreur', message: (e as Error).message })
    actionLoading.value = false
  }
}

async function doDelete() {
  if (!data.value) return
  const target = data.value.user
  if (isSelf.value) return
  const typed = await dialog.prompt({
    title: `Supprimer définitivement ${target.email} ?`,
    message: `Cette action est irréversible : workspaces, documents, embeddings, chats et tokens MCP seront supprimés. Tapez l'email pour confirmer.`,
    placeholder: target.email,
    confirmLabel: 'Supprimer',
    cancelLabel: 'Annuler',
  })
  if (typed == null) return
  if (typed.trim().toLowerCase() !== target.email.toLowerCase()) {
    await dialog.alert({ title: 'Email incorrect', message: 'La suppression a été annulée.' })
    return
  }
  actionLoading.value = true
  try {
    await $fetch(`/api/admin/users/${userId}`, { method: 'DELETE' })
    await router.push('/admin/users')
  }
  catch (e) {
    await dialog.alert({ title: 'Erreur', message: (e as Error).message })
  }
  finally {
    actionLoading.value = false
  }
}

function openResetModal() {
  resetOpen.value = true
  resetPassword.value = ''
  resetConfirmWipe.value = false
  resetRecoveryKey.value = null
  resetError.value = null
  resetCopied.value = false
}

function closeResetModal() {
  if (resetSubmitting.value) return
  resetOpen.value = false
}

async function submitReset() {
  resetError.value = null
  if (resetPassword.value.length < 8) {
    resetError.value = 'Mot de passe : 8 caractères minimum.'
    return
  }
  if (!resetConfirmWipe.value) {
    resetError.value = 'Vous devez confirmer l’effacement du DEK.'
    return
  }
  resetSubmitting.value = true
  try {
    const res = await $fetch<{ recoveryKey: string }>(
      `/api/admin/users/${userId}/reset-password`,
      {
        method: 'POST',
        body: { newPassword: resetPassword.value, confirmWipeDek: true },
      },
    )
    resetRecoveryKey.value = res.recoveryKey
    resetPassword.value = ''
  }
  catch (e) {
    resetError.value = (e as Error).message
  }
  finally {
    resetSubmitting.value = false
  }
}

async function copyRecoveryKey() {
  if (!resetRecoveryKey.value) return
  try {
    await navigator.clipboard.writeText(resetRecoveryKey.value)
    resetCopied.value = true
    setTimeout(() => { resetCopied.value = false }, 2000)
  }
  catch { /* user can copy manually */ }
}

async function saveQuotas() {
  quotasMessage.value = null
  savingQuotas.value = true
  try {
    const parseOpt = (s: string): number | null => {
      const t = s.trim()
      if (t === '') return null
      const n = Number(t)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new Error('Les quotas doivent être des entiers positifs (ou vides pour illimité).')
      }
      return n
    }
    const body = {
      maxDocs: parseOpt(quotaMaxDocs.value),
      maxTokensMonth: parseOpt(quotaMaxTokens.value),
      maxWorkspaces: parseOpt(quotaMaxWorkspaces.value),
    }
    await $fetch(`/api/admin/users/${userId}/quotas`, { method: 'PATCH', body })
    quotasMessage.value = 'Quotas enregistrés.'
    await refresh()
  }
  catch (e) {
    quotasMessage.value = (e as Error).message
  }
  finally {
    savingQuotas.value = false
    setTimeout(() => { quotasMessage.value = null }, 4000)
  }
}
</script>

<template>
  <div class="admin-page">
    <button class="back-btn" @click="router.push('/admin/users')">
      ← Utilisateurs
    </button>

    <div v-if="loading" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <template v-else-if="data">
      <div class="user-header">
        <div class="user-avatar">{{ (data.user.displayName || data.user.email).slice(0, 1).toUpperCase() }}</div>
        <div class="user-meta">
          <h1 class="user-title">{{ data.user.displayName || data.user.email }}</h1>
          <p class="user-sub">{{ data.user.email }}</p>
        </div>
        <div class="header-badges">
          <span v-if="data.user.isAdmin" class="badge badge--admin">Admin</span>
          <span v-if="data.user.disabledAt" class="badge badge--disabled">Désactivé</span>
        </div>
      </div>

      <div class="header-actions">
        <button v-if="!data.user.disabledAt" class="act-btn act-btn--danger" :disabled="actionLoading" @click="doAction('disable')">Désactiver</button>
        <button v-else class="act-btn" :disabled="actionLoading" @click="doAction('enable')">Réactiver</button>
        <button v-if="!data.user.isAdmin" class="act-btn" :disabled="actionLoading" @click="doAction('promote')">↑ Admin</button>
        <button v-else class="act-btn act-btn--danger" :disabled="actionLoading" @click="doAction('demote')">↓ Retirer admin</button>
        <button
          class="act-btn"
          :disabled="actionLoading || isSelf || data.user.isAdmin"
          :title="isSelf ? 'Impossible sur votre propre compte' : data.user.isAdmin ? 'Impossible sur un autre admin' : 'Se connecter en tant que cet utilisateur'"
          @click="doImpersonate"
        >
          Se connecter en tant que
        </button>
        <button
          class="act-btn"
          :disabled="actionLoading || isSelf"
          :title="isSelf ? 'Impossible sur votre propre compte' : 'Réinitialiser le mot de passe + DEK'"
          @click="openResetModal"
        >
          Réinitialiser mot de passe
        </button>
        <button
          class="act-btn act-btn--danger"
          :disabled="actionLoading || isSelf"
          :title="isSelf ? 'Impossible sur votre propre compte' : 'Suppression définitive'"
          @click="doDelete"
        >
          Supprimer ce compte
        </button>
      </div>

      <!-- Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-val">{{ fmtDate(data.user.createdAt) }}</div>
          <div class="stat-lbl">Inscrit le</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ fmtDate(data.user.lastLoginAt) }}</div>
          <div class="stat-lbl">Dernière connexion</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ fmtRelative(data.lastActivityAt) }}</div>
          <div class="stat-lbl">Dernière activité</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.workspaceCount }}</div>
          <div class="stat-lbl">Espaces de travail</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.docCount }}</div>
          <div class="stat-lbl">Documents</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.chunkCount.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Chunks indexés</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.user.chatSessionCount }}</div>
          <div class="stat-lbl">Sessions chat</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">{{ data.mcpTokens.active }} <span class="stat-sub">/ {{ data.mcpTokens.total }}</span></div>
          <div class="stat-lbl">Tokens MCP (actifs / total)</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" :class="{ 'stat-val--warn': data.decryptionFailures > 0 }">{{ data.decryptionFailures.toLocaleString('fr-FR') }}</div>
          <div class="stat-lbl">Échecs de déchiffrement</div>
        </div>
      </div>

      <!-- Quotas -->
      <section class="section">
        <h2 class="section-title">Quotas</h2>
        <p class="section-hint">Laissez vide pour « illimité ».</p>
        <div class="quotas-form">
          <label class="quota-field">
            <span class="quota-lbl">Documents max.</span>
            <input
              v-model="quotaMaxDocs"
              type="number"
              min="0"
              step="1"
              class="quota-input"
              placeholder="∞"
            >
          </label>
          <label class="quota-field">
            <span class="quota-lbl">Tokens / mois</span>
            <input
              v-model="quotaMaxTokens"
              type="number"
              min="0"
              step="1"
              class="quota-input"
              placeholder="∞"
            >
          </label>
          <label class="quota-field">
            <span class="quota-lbl">Workspaces max.</span>
            <input
              v-model="quotaMaxWorkspaces"
              type="number"
              min="0"
              step="1"
              class="quota-input"
              placeholder="∞"
            >
          </label>
          <button class="act-btn act-btn--primary" :disabled="savingQuotas" @click="saveQuotas">
            {{ savingQuotas ? 'Enregistrement…' : 'Enregistrer' }}
          </button>
          <span v-if="quotasMessage" class="quotas-msg">{{ quotasMessage }}</span>
        </div>
      </section>

      <!-- Workspaces -->
      <section class="section">
        <h2 class="section-title">Espaces de travail</h2>
        <div v-if="data.workspaces.length === 0" class="empty">Aucun espace</div>
        <div v-else class="ws-list">
          <div v-for="ws in data.workspaces" :key="ws.id" class="ws-row">
            <span class="ws-emoji">{{ ws.emoji || '📁' }}</span>
            <span class="ws-name">{{ ws.name }}</span>
            <span class="ws-docs">{{ ws.docCount }} docs</span>
            <span class="ws-date">{{ fmtDate(ws.createdAt) }}</span>
          </div>
        </div>
      </section>

      <!-- AI Usage -->
      <section v-if="data.aiUsage.length > 0" class="section">
        <h2 class="section-title">Consommation Mistral</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Modèle</th>
              <th>Opération</th>
              <th>Tokens prompt</th>
              <th>Tokens completion</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.aiUsage" :key="`${r.model}-${r.operation}`">
              <td class="mono">{{ r.model }}</td>
              <td class="mono">{{ r.operation }}</td>
              <td class="mono">{{ r.promptTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono">{{ r.completionTokens.toLocaleString('fr-FR') }}</td>
              <td class="mono font-semibold">{{ r.totalTokens.toLocaleString('fr-FR') }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- Reset password modal -->
    <Teleport to="body">
      <div
        v-if="resetOpen"
        class="modal-backdrop"
        role="dialog"
        aria-modal="true"
        :aria-label="`Réinitialiser le mot de passe`"
        @click.self="closeResetModal"
      >
        <div class="modal-card">
          <h3 class="modal-title">Réinitialiser le mot de passe</h3>

          <template v-if="!resetRecoveryKey">
            <p class="modal-msg">
              Définissez un mot de passe temporaire. Le DEK actuel sera <strong>effacé</strong> :
              les notes, chunks, analyses, historique de chat et snapshots chiffrés de cet
              utilisateur deviendront illisibles. Une nouvelle clé de récupération sera générée.
            </p>
            <label class="modal-field">
              <span class="modal-lbl">Nouveau mot de passe</span>
              <input
                v-model="resetPassword"
                type="password"
                autocomplete="new-password"
                class="modal-input"
                placeholder="8 caractères minimum"
                :disabled="resetSubmitting"
              >
            </label>
            <label class="modal-check">
              <input
                v-model="resetConfirmWipe"
                type="checkbox"
                :disabled="resetSubmitting"
              >
              <span>Je confirme l'effacement du DEK (irréversible).</span>
            </label>
            <p v-if="resetError" class="modal-error">{{ resetError }}</p>
            <div class="modal-actions">
              <button class="act-btn" :disabled="resetSubmitting" @click="closeResetModal">Annuler</button>
              <button
                class="act-btn act-btn--danger"
                :disabled="resetSubmitting"
                @click="submitReset"
              >
                {{ resetSubmitting ? 'Réinitialisation…' : 'Réinitialiser' }}
              </button>
            </div>
          </template>

          <template v-else>
            <p class="modal-msg">
              Mot de passe réinitialisé. Conservez la clé de récupération ci-dessous :
              elle ne sera plus affichée.
            </p>
            <div class="recovery-box">
              <code class="recovery-key">{{ resetRecoveryKey }}</code>
              <button class="act-btn" @click="copyRecoveryKey">
                {{ resetCopied ? 'Copié' : 'Copier' }}
              </button>
            </div>
            <div class="modal-actions">
              <button class="act-btn act-btn--primary" @click="closeResetModal">Fermer</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-4xl; }
.back-btn { @apply text-sm text-ink-500 dark:text-ink-400 hover:text-ink-900 dark:hover:text-ink-100 mb-6 block; transition: color 120ms; }
.loading, .error, .empty { @apply text-sm text-ink-500 dark:text-ink-400; }
.user-header { @apply flex items-center gap-4 mb-3; }
.user-avatar { @apply w-12 h-12 rounded-full bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-xl font-semibold text-accent-700 dark:text-accent-300 shrink-0; }
.user-meta { @apply flex-1 min-w-0; }
.user-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100; }
.user-sub { @apply text-sm text-ink-500 dark:text-ink-400 truncate; }
.header-badges { @apply flex gap-2; }
.header-actions { @apply flex gap-2 flex-wrap mb-6; }
.badge { @apply inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide; }
.badge--admin { @apply bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300; }
.badge--disabled { @apply bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400; }
.act-btn {
  @apply text-[11px] font-sans px-2.5 py-1 rounded border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 disabled:opacity-40 disabled:cursor-not-allowed;
  background: theme('colors.ink.50');
  transition: background 100ms;
}
html.dark .act-btn { background: theme('colors.ink.900'); }
.act-btn:hover:not(:disabled) { @apply bg-ink-200 dark:bg-ink-800; }
.act-btn--danger:hover:not(:disabled) { @apply bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-400; }
.act-btn--primary {
  @apply bg-accent-600 text-ink-50 border-accent-600;
}
.act-btn--primary:hover:not(:disabled) { @apply bg-accent-700 border-accent-700 text-ink-50; }
.stats-grid { @apply grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6; }
.stat-card { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-3; background: theme('colors.ink.50'); }
html.dark .stat-card { background: theme('colors.ink.900'); }
.stat-val { @apply font-sans text-lg font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.stat-val--warn { @apply text-red-600 dark:text-red-400; }
.stat-sub { @apply font-normal text-sm text-ink-500 dark:text-ink-400; }
.stat-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400; }
.section { @apply mb-6; }
.section-title { @apply font-sans text-[11px] uppercase tracking-[0.09em] font-semibold text-ink-500 dark:text-ink-400 mb-3; }
.section-hint { @apply text-xs text-ink-500 dark:text-ink-400 mb-3 font-sans; }
.quotas-form {
  @apply flex flex-wrap items-end gap-3 rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-4;
  background: theme('colors.ink.50');
}
html.dark .quotas-form { background: theme('colors.ink.900'); }
.quota-field { @apply flex flex-col gap-1; }
.quota-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400; }
.quota-input {
  @apply w-32 px-2 py-1 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-900 dark:text-ink-100 tabular-nums font-mono outline-none;
}
.quota-input:focus { @apply border-accent-500; }
.quotas-msg { @apply text-xs text-ink-500 dark:text-ink-400 self-center font-sans; }
.ws-list { @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.ws-row { @apply flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0 border-ink-200/50 dark:border-ink-800/50 text-sm; background: theme('colors.ink.50'); }
html.dark .ws-row { background: theme('colors.ink.900'); }
.ws-emoji { @apply shrink-0; }
.ws-name { @apply flex-1 font-medium text-ink-800 dark:text-ink-200; }
.ws-docs { @apply text-xs text-ink-500 dark:text-ink-400 tabular-nums; }
.ws-date { @apply text-xs text-ink-400 dark:text-ink-600 tabular-nums ml-2; }
.data-table { @apply w-full text-sm text-left rounded-lg border border-ink-200/60 dark:border-ink-800/60 overflow-hidden; }
.data-table thead { @apply bg-ink-100 dark:bg-ink-900/60; }
.data-table th { @apply px-4 py-2.5 font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.data-table td { @apply px-4 py-2.5 border-t border-ink-200/50 dark:border-ink-800/50 text-ink-700 dark:text-ink-300; background: theme('colors.ink.50'); }
html.dark .data-table td { background: theme('colors.ink.900'); }
.mono { @apply font-mono text-xs tabular-nums; }

/* Reset-password modal — local to keep the recovery-key flow self-contained
   (the global dialog only does confirm/prompt/alert).                       */
.modal-backdrop {
  @apply fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 backdrop-blur-[2px] px-4;
}
.modal-card {
  @apply w-full max-w-md rounded-xl border border-ink-200/60 dark:border-ink-800/60 p-6 shadow-xl;
  background: theme('colors.ink.50');
}
html.dark .modal-card { background: theme('colors.ink.950'); }
.modal-title { @apply font-serif text-xl text-ink-900 dark:text-ink-100 mb-3; }
.modal-msg { @apply text-sm text-ink-600 dark:text-ink-400 mb-4 leading-relaxed; }
.modal-msg strong { @apply text-red-600 dark:text-red-400 font-semibold; }
.modal-field { @apply flex flex-col gap-1 mb-3; }
.modal-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] font-semibold text-ink-500 dark:text-ink-400; }
.modal-input {
  @apply w-full px-3 py-2 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-900 dark:text-ink-100 outline-none;
}
.modal-input:focus { @apply border-accent-500; }
.modal-check {
  @apply flex items-start gap-2 text-sm text-ink-700 dark:text-ink-300 mb-3 cursor-pointer;
}
.modal-check input { @apply mt-0.5; }
.modal-error { @apply text-sm text-red-600 dark:text-red-400 mb-3; }
.modal-actions { @apply flex justify-end gap-2 mt-4; }
.recovery-box {
  @apply flex items-center gap-2 mb-3 p-3 rounded border border-ink-300 dark:border-ink-700;
  background: theme('colors.ink.100');
}
html.dark .recovery-box { background: theme('colors.ink.900'); }
.recovery-key {
  @apply flex-1 font-mono text-sm text-ink-900 dark:text-ink-100 break-all select-all;
}
</style>
