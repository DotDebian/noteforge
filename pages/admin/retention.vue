<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useDialog } from '~/composables/useDialog'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const dialog = useDialog()

type RetentionKey =
  | 'trash_ttl_days'
  | 'ai_usage_logs_ttl_days'
  | 'login_attempts_ttl_days'
  | 'mcp_call_logs_ttl_days'
  | 'app_logs_ttl_days'
  | 'rag_quality_logs_ttl_days'

interface PolicyRow {
  key: RetentionKey
  value: number | null
  previewRows: number
  updatedAt: string | null
}
interface RetentionResponse {
  policies: PolicyRow[]
}

const KEY_LABELS: Record<RetentionKey, { title: string, desc: string }> = {
  trash_ttl_days: {
    title: 'Corbeille',
    desc: 'Documents et dossiers supprimés (soft-delete) plus anciens que la TTL.',
  },
  ai_usage_logs_ttl_days: {
    title: 'Logs IA',
    desc: 'Tokens Mistral consommés — table `ai_usage_logs`.',
  },
  login_attempts_ttl_days: {
    title: 'Tentatives de connexion',
    desc: 'Historique des tentatives (réussies et échouées) — table `login_attempts`.',
  },
  mcp_call_logs_ttl_days: {
    title: 'Appels MCP',
    desc: 'Journal des appels passés par les clients MCP — table `mcp_call_logs`.',
  },
  app_logs_ttl_days: {
    title: 'Logs applicatifs',
    desc: 'Évènements serveur (debug, info, warn, error) — table `app_logs`.',
  },
  rag_quality_logs_ttl_days: {
    title: 'Qualité RAG',
    desc: 'Métriques de qualité du RAG par tour de chat — table `rag_quality_logs`.',
  },
}

const data = ref<RetentionResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const editedValues = reactive(new Map<RetentionKey, string>())
const savingKey = ref<RetentionKey | null>(null)
const purgingKey = ref<RetentionKey | null>(null)
const flashMessage = ref<{ kind: 'ok' | 'err', text: string } | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await $fetch<RetentionResponse>('/api/admin/retention')
    editedValues.clear()
    for (const p of data.value.policies) {
      editedValues.set(p.key, p.value == null ? '' : String(p.value))
    }
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}
onMounted(load)

function flash(kind: 'ok' | 'err', text: string) {
  flashMessage.value = { kind, text }
  setTimeout(() => {
    if (flashMessage.value?.text === text) flashMessage.value = null
  }, 4000)
}

async function save(key: RetentionKey) {
  const raw = (editedValues.get(key) ?? '').trim()
  let value: number | null = null
  if (raw !== '') {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) {
      await dialog.alert({
        title: 'Valeur invalide',
        message: 'Entrez un entier positif (en jours) ou laissez vide pour ne jamais purger.',
      })
      return
    }
    value = n
  }

  savingKey.value = key
  try {
    await $fetch('/api/admin/retention', {
      method: 'PATCH',
      body: { key, value },
    })
    flash('ok', `${KEY_LABELS[key].title} : politique enregistrée.`)
    await load()
  }
  catch (e) {
    flash('err', `Erreur : ${(e as Error).message}`)
  }
  finally {
    savingKey.value = null
  }
}

async function purge(policy: PolicyRow) {
  if (policy.value == null) {
    await dialog.alert({
      title: 'Aucune politique',
      message: 'Définissez d\'abord une TTL en jours, puis enregistrez.',
    })
    return
  }
  const ok = await dialog.confirm({
    title: `Purger « ${KEY_LABELS[policy.key].title} » ?`,
    message: `${policy.previewRows.toLocaleString('fr-FR')} ligne(s) plus anciennes que ${policy.value} jour(s) seront supprimées définitivement.`,
    confirmLabel: 'Purger maintenant',
    destructive: true,
  })
  if (!ok) return

  purgingKey.value = policy.key
  try {
    const res = await $fetch<{ rowsDeleted: number }>('/api/admin/retention/purge', {
      method: 'POST',
      body: { key: policy.key },
    })
    flash('ok', `${KEY_LABELS[policy.key].title} : ${res.rowsDeleted.toLocaleString('fr-FR')} ligne(s) supprimée(s).`)
    await load()
  }
  catch (e) {
    flash('err', `Erreur : ${(e as Error).message}`)
  }
  finally {
    purgingKey.value = null
  }
}

function fmtDate(iso: string | null) {
  if (!iso) return 'jamais modifié'
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function isDirty(policy: PolicyRow) {
  const current = policy.value == null ? '' : String(policy.value)
  return (editedValues.get(policy.key) ?? '') !== current
}
</script>

<template>
  <div class="admin-page">
    <h1 class="page-title">Politique de rétention</h1>
    <p class="page-sub">
      TTL en jours pour chaque famille de données. Laisser vide pour « jamais ».
      Le compteur indique les lignes qui seraient supprimées si la purge tournait maintenant.
    </p>

    <transition name="flash">
      <div v-if="flashMessage" class="flash" :class="`flash--${flashMessage.kind}`">
        {{ flashMessage.text }}
      </div>
    </transition>

    <div v-if="loading && !data" class="loading">Chargement…</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">
      <div class="policy-list">
        <div v-for="p in data.policies" :key="p.key" class="policy-card">
          <div class="policy-head">
            <div>
              <h2 class="policy-title">{{ KEY_LABELS[p.key].title }}</h2>
              <p class="policy-desc">{{ KEY_LABELS[p.key].desc }}</p>
            </div>
            <div class="policy-meta">
              <span class="policy-updated">Modifié : {{ fmtDate(p.updatedAt) }}</span>
            </div>
          </div>

          <div class="policy-form">
            <div class="field">
              <label class="field-lbl" :for="`ttl-${p.key}`">TTL (jours)</label>
              <div class="field-input-wrap">
                <input
                  :id="`ttl-${p.key}`"
                  :value="editedValues.get(p.key) ?? ''"
                  type="number"
                  min="1"
                  placeholder="Jamais"
                  class="ttl-input"
                  @input="(e) => editedValues.set(p.key, (e.target as HTMLInputElement).value)"
                >
                <span v-if="(editedValues.get(p.key) ?? '') === ''" class="ttl-hint">Jamais purger</span>
              </div>
            </div>

            <div class="preview">
              <span class="preview-val" :class="{ 'preview-val--zero': p.previewRows === 0 }">
                {{ p.previewRows.toLocaleString('fr-FR') }}
              </span>
              <span class="preview-lbl">ligne(s) seraient supprimées</span>
            </div>

            <div class="actions">
              <button
                class="act-btn"
                :disabled="savingKey === p.key || !isDirty(p)"
                @click="save(p.key)"
              >
                {{ savingKey === p.key ? 'Enregistrement…' : 'Enregistrer' }}
              </button>
              <button
                class="act-btn act-btn--danger"
                :disabled="purgingKey === p.key || p.value == null || p.previewRows === 0"
                @click="purge(p)"
              >
                {{ purgingKey === p.key ? 'Purge…' : 'Purger maintenant' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.admin-page { @apply px-8 py-8 max-w-4xl; }
.page-title { @apply font-serif text-2xl text-ink-900 dark:text-ink-100 mb-1; }
.page-sub { @apply text-sm text-ink-500 dark:text-ink-400 mb-6 max-w-2xl; }
.loading, .error { @apply text-sm text-ink-500 dark:text-ink-400; }
.flash {
  @apply rounded-md px-4 py-2 mb-4 text-sm font-sans border;
}
.flash--ok { @apply bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-300; }
.flash--err { @apply bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/60 text-red-700 dark:text-red-300; }
.flash-enter-active, .flash-leave-active { transition: opacity 200ms; }
.flash-enter-from, .flash-leave-to { opacity: 0; }
.policy-list { @apply flex flex-col gap-3; }
.policy-card {
  @apply rounded-lg border border-ink-200/60 dark:border-ink-800/60 p-5;
  background: theme('colors.ink.50');
}
html.dark .policy-card { background: theme('colors.ink.900'); }
.policy-head { @apply flex items-start justify-between gap-4 mb-4; }
.policy-title { @apply font-serif text-base text-ink-900 dark:text-ink-100; }
.policy-desc { @apply text-xs text-ink-500 dark:text-ink-400 mt-1 max-w-xl; }
.policy-meta { @apply text-right shrink-0; }
.policy-updated { @apply font-mono text-[10px] text-ink-400 dark:text-ink-600 tabular-nums; }
.policy-form { @apply flex items-end gap-4 flex-wrap; }
.field { @apply flex flex-col gap-1; }
.field-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400 font-semibold; }
.field-input-wrap { @apply flex items-center gap-2; }
.ttl-input {
  @apply w-28 px-3 py-1.5 text-sm rounded border border-ink-300 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-ink-900 dark:text-ink-100 outline-none tabular-nums;
}
.ttl-input:focus { @apply border-accent-500; }
.ttl-hint { @apply text-xs italic text-ink-400 dark:text-ink-600; }
.preview { @apply flex flex-col items-start ml-auto mr-auto; }
.preview-val { @apply font-sans text-lg font-semibold text-ink-900 dark:text-ink-100 tabular-nums; }
.preview-val--zero { @apply text-ink-400 dark:text-ink-600; }
.preview-lbl { @apply font-sans text-[11px] uppercase tracking-[0.07em] text-ink-500 dark:text-ink-400; }
.actions { @apply flex gap-2 items-center; }
.act-btn {
  @apply text-sm font-sans px-3 py-1.5 rounded border border-ink-300 dark:border-ink-700 text-ink-800 dark:text-ink-200 disabled:opacity-40;
  background: theme('colors.ink.100');
  transition: background 100ms, color 100ms, border-color 100ms;
}
html.dark .act-btn { background: theme('colors.ink.800'); }
.act-btn:not(:disabled):hover { @apply bg-accent-100 dark:bg-accent-900/30 border-accent-400 text-accent-700 dark:text-accent-300; }
.act-btn--danger:not(:disabled):hover { @apply bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-400; }
</style>
