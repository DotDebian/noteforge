<script setup lang="ts">
/**
 * Settings — single page that consolidates everything personalisable.
 * Profile, appearance, language, security live here. Per CLAUDE.md the
 * auth user shape is widened in types/auth.d.ts; we type-cast at the edge.
 *
 * Added (this iteration):
 *   - Editor preferences (column width, font size, focus-mode default)
 *   - AI preferences   (chat model, temperature, disable rewriter/reranker)
 *   - Notifications     (analysis done, mentions, weekly digest — last two
 *                        gated as "Bientôt")
 *   - Two-factor auth   (TOTP enroll + disable flow, QR + backup codes)
 *
 * The new section copy is hardcoded French + English via a small `L`
 * dictionary (per CLAUDE.md instruction not to touch `composables/useLocale.ts`).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { useLocale } from '~/composables/useLocale'
import { useTheme } from '~/composables/useTheme'
import { useUserPreferences } from '~/composables/useUserPreferences'
import { useTwoFactor } from '~/composables/useTwoFactor'
import { useDialog } from '~/composables/useDialog'

const { t, locale, setLocale } = useLocale()
const { user } = useAuth()
const theme = useTheme()
const dialog = useDialog()

const u = computed(() => user.value as {
  email?: string
  displayName?: string | null
} | null)

/* -------------------------------------------------------------------- */
/*  Local i18n dictionary for the new sections                           */
/* -------------------------------------------------------------------- */

const L = computed(() => locale.value === 'fr'
  ? {
      editor: {
        title: 'Éditeur',
        columnWidth: 'Largeur de colonne',
        narrow: 'Étroite',
        normal: 'Normale',
        wide: 'Large',
        fontSize: 'Taille du texte',
        small: 'Petit',
        large: 'Grand',
        focusDefault: 'Activer le mode focus par défaut',
        focusHint: 'Ouvre chaque document en mode focus (sera appliqué après rechargement).',
        saved: 'Enregistré',
        saving: 'Enregistrement…',
      },
      ai: {
        title: 'Intelligence artificielle',
        chatModel: 'Modèle de chat',
        chatModelHint: 'Le modèle utilisé pour générer les réponses dans le chat.',
        custom: 'Personnalisé…',
        customLabel: 'Identifiant de modèle personnalisé',
        temperature: 'Créativité (température)',
        temperatureHint: '0 = factuel et répétable, 1 = équilibré, > 1 = libre.',
        disableRewriter: 'Désactiver la réécriture de requêtes',
        disableRewriterHint: 'Économise un appel Mistral par tour. La qualité de récupération peut baisser sur les questions de suivi.',
        disableReranker: 'Désactiver le reclassement',
        disableRerankerHint: 'Économise un appel Mistral. Le tri par cosinus + BM25 sera utilisé seul.',
        warn: 'Ces préférences ne sont pas encore lues côté serveur — elles seront prises en compte dans un prochain déploiement.',
      },
      notif: {
        title: 'Notifications',
        analysisDone: 'Analyse de document terminée',
        analysisDoneHint: 'Recevez une notification quand l’analyse IA d’un document se termine.',
        mention: 'Quand quelqu’un me mentionne',
        mentionHint: 'Disponible quand le multi-utilisateur arrivera.',
        digest: 'Récapitulatif hebdomadaire',
        digestHint: 'E-mail hebdomadaire des notes les plus consultées.',
        soon: 'Bientôt',
      },
      twoFA: {
        title: 'Authentification à deux facteurs',
        disabled: 'Désactivée',
        enabledOn: 'Activée le {date}',
        enabledNoDate: 'Activée',
        lede: 'Ajoute une étape de vérification supplémentaire à la connexion via une application d’authentification (Google Authenticator, 1Password, Authy…).',
        notEnforced: 'Note : l’application 2FA à la connexion n’est pas encore activée — cette enrollment est préparatoire.',
        enable: 'Activer 2FA',
        disable: 'Désactiver',
        configure: 'Configurer',
        step1: 'Étape 1 — Scannez le QR code avec votre application',
        step1Manual: 'Ou entrez ce code manuellement :',
        step2: 'Étape 2 — Entrez le code à 6 chiffres',
        codePlaceholder: '123456',
        confirm: 'Activer',
        confirming: 'Vérification…',
        cancel: 'Annuler',
        codes: 'Codes de secours',
        codesLede: 'Conservez ces codes en lieu sûr. Chacun ne peut être utilisé qu’une seule fois si vous perdez votre téléphone.',
        copy: 'Copier',
        copied: 'Copié',
        ackText: 'J’ai noté mes codes de secours',
        done: 'Terminé',
        disableTitle: 'Désactiver la 2FA',
        disableMessage: 'Confirmez votre mot de passe pour désactiver la 2FA.',
        passwordLabel: 'Mot de passe actuel',
        disableSubmit: 'Désactiver la 2FA',
        disabling: 'Désactivation…',
        errorGeneric: 'Quelque chose s’est mal passé.',
        errorInvalidCode: 'Le code est incorrect ou expiré.',
        errorInvalidPassword: 'Mot de passe incorrect.',
        errorAlreadyEnabled: 'La 2FA est déjà activée.',
        secretLabel: 'Clé secrète',
      },
      debug: {
        title: 'Diagnostic',
        lede: 'Outils de débogage pour analyser la pertinence des notes liées.',
        relatedBtn: 'Copier le diagnostic des notes liées',
        relatedHint: 'Copie dans le presse-papiers un rapport JSON complet : état des embeddings par document (résumé + chunks), matrice de similarité cosinus entre tous les documents, tags, liens, et une simulation du calcul « notes liées » pour chaque document. Rien n’est envoyé à un serveur tiers.',
        busy: 'Génération…',
        copied: 'Copié dans le presse-papiers',
        errorGeneric: 'Impossible de générer le diagnostic.',
      },
    }
  : {
      editor: {
        title: 'Editor',
        columnWidth: 'Column width',
        narrow: 'Narrow',
        normal: 'Normal',
        wide: 'Wide',
        fontSize: 'Text size',
        small: 'Small',
        large: 'Large',
        focusDefault: 'Open documents in focus mode',
        focusHint: 'Every newly opened document will start in focus mode (takes effect on next load).',
        saved: 'Saved',
        saving: 'Saving…',
      },
      ai: {
        title: 'Artificial intelligence',
        chatModel: 'Chat model',
        chatModelHint: 'The model used to generate chat answers.',
        custom: 'Custom…',
        customLabel: 'Custom model ID',
        temperature: 'Creativity (temperature)',
        temperatureHint: '0 = factual and repeatable, 1 = balanced, > 1 = freewheeling.',
        disableRewriter: 'Disable query rewriter',
        disableRewriterHint: 'Saves one Mistral call per turn. Retrieval quality may dip on follow-up questions.',
        disableReranker: 'Disable LLM reranker',
        disableRerankerHint: 'Saves one Mistral call. Cosine + BM25 sorting will be used alone.',
        warn: 'These preferences are not yet read server-side — wiring lands in a follow-up.',
      },
      notif: {
        title: 'Notifications',
        analysisDone: 'Document analysis finished',
        analysisDoneHint: 'Notify when a document’s AI analysis completes.',
        mention: 'When someone mentions me',
        mentionHint: 'Available once multi-user lands.',
        digest: 'Weekly digest',
        digestHint: 'Opt-in weekly summary email.',
        soon: 'Soon',
      },
      twoFA: {
        title: 'Two-factor authentication',
        disabled: 'Disabled',
        enabledOn: 'Enabled on {date}',
        enabledNoDate: 'Enabled',
        lede: 'Adds an extra verification step at sign-in via an authenticator app (Google Authenticator, 1Password, Authy…).',
        notEnforced: 'Note: 2FA enforcement at login is not yet active — enrollment is preparatory.',
        enable: 'Enable 2FA',
        disable: 'Disable',
        configure: 'Configure',
        step1: 'Step 1 — Scan the QR code with your app',
        step1Manual: 'Or enter this key manually:',
        step2: 'Step 2 — Type the 6-digit code',
        codePlaceholder: '123456',
        confirm: 'Enable',
        confirming: 'Verifying…',
        cancel: 'Cancel',
        codes: 'Backup codes',
        codesLede: 'Keep these codes somewhere safe. Each one can be used exactly once if you lose your phone.',
        copy: 'Copy',
        copied: 'Copied',
        ackText: 'I have noted my backup codes',
        done: 'Done',
        disableTitle: 'Disable 2FA',
        disableMessage: 'Confirm your current password to disable 2FA.',
        passwordLabel: 'Current password',
        disableSubmit: 'Disable 2FA',
        disabling: 'Disabling…',
        errorGeneric: 'Something went wrong.',
        errorInvalidCode: 'That code is wrong or expired.',
        errorInvalidPassword: 'Wrong password.',
        errorAlreadyEnabled: '2FA is already enabled.',
        secretLabel: 'Secret key',
      },
      debug: {
        title: 'Diagnostics',
        lede: 'Debug tooling for the related-notes relevance pipeline.',
        relatedBtn: 'Copy related-notes diagnostics',
        relatedHint: 'Copies a full JSON report to the clipboard: per-document embedding state (summary + chunks), the pairwise cosine-similarity matrix across all documents, tags, links, and a simulation of the related-notes scoring for every document. Nothing is sent to any third party.',
        busy: 'Generating…',
        copied: 'Copied to clipboard',
        errorGeneric: 'Could not generate the diagnostics report.',
      },
    },
)

/* -------------------------------------------------------------------- */
/*  Profile                                                              */
/* -------------------------------------------------------------------- */

const profileName = ref(u.value?.displayName ?? '')
const profileBusy = ref(false)
const profileSaved = ref(false)
const profileError = ref<string | null>(null)

async function saveProfile(): Promise<void> {
  const name = profileName.value.trim()
  if (name.length === 0) {
    profileError.value = t('settings.profile.nameRequired')
    return
  }
  profileBusy.value = true
  profileError.value = null
  profileSaved.value = false
  try {
    await $fetch('/api/auth/me', {
      method: 'PATCH',
      body: { displayName: name },
    })
    profileSaved.value = true
    setTimeout(() => { profileSaved.value = false }, 2500)
  }
  catch (err) {
    profileError.value
      = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
        ?? (err as Error).message
        ?? t('settings.profile.errorGeneric')
  }
  finally {
    profileBusy.value = false
  }
}

/* -------------------------------------------------------------------- */
/*  Password                                                             */
/* -------------------------------------------------------------------- */

const pwCurrent = ref('')
const pwNew = ref('')
const pwConfirm = ref('')
const pwBusy = ref(false)
const pwError = ref<string | null>(null)
const pwSuccess = ref(false)

async function changePassword(): Promise<void> {
  pwError.value = null
  pwSuccess.value = false
  if (pwNew.value.length < 8) {
    pwError.value = t('settings.password.tooShort')
    return
  }
  if (pwNew.value !== pwConfirm.value) {
    pwError.value = t('settings.password.mismatch')
    return
  }
  pwBusy.value = true
  try {
    await $fetch('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: pwCurrent.value, newPassword: pwNew.value },
    })
    pwSuccess.value = true
    pwCurrent.value = ''
    pwNew.value = ''
    pwConfirm.value = ''
    setTimeout(() => { pwSuccess.value = false }, 3000)
  }
  catch (err) {
    pwError.value
      = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
        ?? (err as Error).message
        ?? t('settings.password.errorGeneric')
  }
  finally {
    pwBusy.value = false
  }
}

/* -------------------------------------------------------------------- */
/*  Security (MCP tokens shortcut)                                       */
/* -------------------------------------------------------------------- */

const mcpDialogOpen = ref(false)

/* -------------------------------------------------------------------- */
/*  User preferences (editor / ai / notifications)                       */
/* -------------------------------------------------------------------- */

const userPrefs = useUserPreferences()
const { editor: editorPrefs, ai: aiPrefs, notifications: notifPrefs } = userPrefs

const KNOWN_CHAT_MODELS = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest']
const customModelInput = ref('')
const useCustomModel = ref(false)
const prefsBusy = ref<'editor' | 'ai' | 'notifications' | null>(null)
const prefsSavedFor = ref<'editor' | 'ai' | 'notifications' | null>(null)
let prefsSavedTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  await userPrefs.load()
  // Sync custom-model UI state after preferences land.
  const m = aiPrefs.value.chatModel
  if (m && !KNOWN_CHAT_MODELS.includes(m)) {
    useCustomModel.value = true
    customModelInput.value = m
  }
})

async function patchPrefs(
  section: 'editor' | 'ai' | 'notifications',
  body: Parameters<typeof userPrefs.save>[0],
): Promise<void> {
  prefsBusy.value = section
  try {
    await userPrefs.save(body)
    prefsSavedFor.value = section
    if (prefsSavedTimer) clearTimeout(prefsSavedTimer)
    prefsSavedTimer = setTimeout(() => { prefsSavedFor.value = null }, 1800)
  }
  catch (err) {
    await dialog.alert({
      title: 'Error',
      message: (err as Error).message,
    })
  }
  finally {
    prefsBusy.value = null
  }
}

function setEditorPref(key: 'columnWidth' | 'fontSize', value: string) {
  if (key === 'columnWidth' && (value === 'narrow' || value === 'normal' || value === 'wide')) {
    void patchPrefs('editor', { editor: { columnWidth: value } })
  }
  else if (key === 'fontSize' && (value === 'small' || value === 'normal' || value === 'large')) {
    void patchPrefs('editor', { editor: { fontSize: value } })
  }
}

function setFocusDefault(v: boolean) {
  void patchPrefs('editor', { editor: { focusModeDefault: v } })
}

function setChatModel(model: string) {
  if (model === '__custom__') {
    useCustomModel.value = true
    return
  }
  useCustomModel.value = false
  void patchPrefs('ai', { ai: { chatModel: model } })
}

function commitCustomModel() {
  const v = customModelInput.value.trim()
  if (v.length === 0) return
  void patchPrefs('ai', { ai: { chatModel: v } })
}

function setTemperature(v: number) {
  void patchPrefs('ai', { ai: { temperature: Number(v) } })
}

function setDisableRewriter(v: boolean) {
  void patchPrefs('ai', { ai: { disableRewriter: v } })
}
function setDisableReranker(v: boolean) {
  void patchPrefs('ai', { ai: { disableReranker: v } })
}

function setAnalysisDone(v: boolean) {
  void patchPrefs('notifications', { notifications: { analysisDone: v } })
}

const tempDisplay = computed(() => aiPrefs.value.temperature.toFixed(1))

/* -------------------------------------------------------------------- */
/*  Debug — related-notes diagnostics export                             */
/* -------------------------------------------------------------------- */

const debugBusy = ref(false)
const debugCopied = ref(false)
const debugMeta = ref<string | null>(null)
const debugError = ref<string | null>(null)
let debugCopiedTimer: ReturnType<typeof setTimeout> | null = null

interface DebugWorkspaceCounts {
  counts?: { activeDocs?: number, docsWithSummaryEmbedding?: number }
}

async function copyRelatedDebug(): Promise<void> {
  debugBusy.value = true
  debugError.value = null
  debugCopied.value = false
  debugMeta.value = null
  try {
    const res = await $fetch<{ report: { workspaces?: DebugWorkspaceCounts[] } }>('/api/ai/debug/related')
    const json = JSON.stringify(res.report, null, 2)
    await navigator.clipboard.writeText(json)
    const wsList = res.report.workspaces ?? []
    const docCount = wsList.reduce((s, w) => s + (w.counts?.activeDocs ?? 0), 0)
    const sizeKb = Math.max(1, Math.round(json.length / 1024))
    debugMeta.value = `${wsList.length} ws · ${docCount} docs · ${sizeKb} Ko`
    debugCopied.value = true
    if (debugCopiedTimer) clearTimeout(debugCopiedTimer)
    debugCopiedTimer = setTimeout(() => { debugCopied.value = false }, 6000)
  }
  catch (err) {
    debugError.value
      = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
        ?? (err as Error).message
        ?? L.value.debug.errorGeneric
  }
  finally {
    debugBusy.value = false
  }
}

/* -------------------------------------------------------------------- */
/*  2FA — enrollment + disable flow                                      */
/* -------------------------------------------------------------------- */

const twoFA = useTwoFactor()

const enrollOpen = ref(false)
const enrollSecret = ref<string | null>(null)
const enrollQr = ref<string | null>(null)
const enrollCode = ref('')
const enrollError = ref<string | null>(null)
const enrollBackupCodes = ref<string[] | null>(null)
const enrollAck = ref(false)
const enrollCopied = ref(false)

const disableOpen = ref(false)
const disablePassword = ref('')
const disableError = ref<string | null>(null)

onMounted(async () => {
  try { await twoFA.refreshStatus() }
  catch { /* surfaced via twoFA.error */ }
})

const twoFAStatusLabel = computed(() => {
  if (!twoFA.status.value) return ''
  if (twoFA.status.value.enabled) {
    const at = twoFA.status.value.enabledAt
    if (!at) return L.value.twoFA.enabledNoDate
    const d = at instanceof Date ? at : new Date(at)
    if (Number.isNaN(d.getTime())) return L.value.twoFA.enabledNoDate
    const fmt = new Intl.DateTimeFormat(locale.value === 'fr' ? 'fr-FR' : 'en-US', {
      day: 'numeric', month: 'long', year: 'numeric',
    })
    return L.value.twoFA.enabledOn.replace('{date}', fmt.format(d))
  }
  return L.value.twoFA.disabled
})

async function startEnroll() {
  enrollError.value = null
  enrollCode.value = ''
  enrollBackupCodes.value = null
  enrollAck.value = false
  enrollOpen.value = true
  try {
    const res = await twoFA.setup()
    enrollSecret.value = res.secret
    enrollQr.value = res.qrDataUrl
  }
  catch (e) {
    const sm = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
    if (sm === '2fa_already_enabled') {
      enrollError.value = L.value.twoFA.errorAlreadyEnabled
    }
    else {
      enrollError.value = (e as Error).message || L.value.twoFA.errorGeneric
    }
  }
}

async function submitEnroll() {
  enrollError.value = null
  if (!/^\d{6}$/.test(enrollCode.value.trim())) {
    enrollError.value = L.value.twoFA.errorInvalidCode
    return
  }
  try {
    const res = await twoFA.enable(enrollCode.value.trim())
    enrollBackupCodes.value = res.backupCodes
  }
  catch (e) {
    const sm = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
    if (sm === 'invalid_totp_code') {
      enrollError.value = L.value.twoFA.errorInvalidCode
    }
    else if (sm === '2fa_already_enabled') {
      enrollError.value = L.value.twoFA.errorAlreadyEnabled
    }
    else {
      enrollError.value = (e as Error).message || L.value.twoFA.errorGeneric
    }
  }
}

async function copyBackupCodes() {
  if (!enrollBackupCodes.value) return
  try {
    await navigator.clipboard.writeText(enrollBackupCodes.value.join('\n'))
    enrollCopied.value = true
    setTimeout(() => { enrollCopied.value = false }, 1500)
  }
  catch { /* ignore — codes are still visible */ }
}

function closeEnroll() {
  enrollOpen.value = false
  enrollSecret.value = null
  enrollQr.value = null
  enrollCode.value = ''
  enrollBackupCodes.value = null
  enrollAck.value = false
  enrollError.value = null
}

function openDisable() {
  disableError.value = null
  disablePassword.value = ''
  disableOpen.value = true
}
function closeDisable() {
  disableOpen.value = false
  disablePassword.value = ''
  disableError.value = null
}

async function submitDisable() {
  disableError.value = null
  if (disablePassword.value.length === 0) {
    disableError.value = L.value.twoFA.errorInvalidPassword
    return
  }
  try {
    await twoFA.disable(disablePassword.value)
    closeDisable()
  }
  catch (e) {
    const sm = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
    if (sm === 'invalid_password') {
      disableError.value = L.value.twoFA.errorInvalidPassword
    }
    else {
      disableError.value = (e as Error).message || L.value.twoFA.errorGeneric
    }
  }
}

watch(enrollOpen, (open) => {
  // Close on outside escape — handled by overlay click; this is a no-op safety.
  if (!open) {
    enrollSecret.value = null
    enrollQr.value = null
  }
})
</script>

<template>
  <div class="settings-shell">
    <header class="settings-header">
      <h1 class="settings-title">{{ t('settings.title') }}</h1>
      <p class="settings-lede">{{ t('settings.lede') }}</p>
    </header>

    <div class="settings-grid">
      <!-- Profile -->
      <section class="settings-card">
        <h2 class="settings-section-title">{{ t('settings.profile.title') }}</h2>
        <div class="settings-row">
          <label class="settings-label" for="set-name">{{ t('settings.profile.name') }}</label>
          <input
            id="set-name"
            v-model="profileName"
            type="text"
            class="settings-input"
            :placeholder="t('settings.profile.namePlaceholder')"
          >
        </div>
        <div class="settings-row">
          <label class="settings-label">{{ t('settings.profile.email') }}</label>
          <input
            class="settings-input settings-input--ro"
            type="email"
            :value="u?.email ?? ''"
            readonly
          >
          <span class="settings-hint">{{ t('settings.profile.emailReadonly') }}</span>
        </div>
        <div class="settings-actions">
          <button
            type="button"
            class="settings-btn"
            :disabled="profileBusy"
            @click="saveProfile"
          >
            {{ profileBusy ? t('settings.profile.saving') : t('settings.profile.save') }}
          </button>
          <span v-if="profileSaved" class="settings-ok">{{ t('settings.profile.saved') }}</span>
          <span v-if="profileError" class="settings-err">{{ profileError }}</span>
        </div>
      </section>

      <!-- Password -->
      <section class="settings-card">
        <h2 class="settings-section-title">{{ t('settings.password.title') }}</h2>
        <div class="settings-row">
          <label class="settings-label" for="set-pwc">{{ t('settings.password.current') }}</label>
          <input
            id="set-pwc"
            v-model="pwCurrent"
            type="password"
            class="settings-input"
            autocomplete="current-password"
          >
        </div>
        <div class="settings-row">
          <label class="settings-label" for="set-pwn">{{ t('settings.password.new') }}</label>
          <input
            id="set-pwn"
            v-model="pwNew"
            type="password"
            class="settings-input"
            autocomplete="new-password"
          >
        </div>
        <div class="settings-row">
          <label class="settings-label" for="set-pwc2">{{ t('settings.password.confirm') }}</label>
          <input
            id="set-pwc2"
            v-model="pwConfirm"
            type="password"
            class="settings-input"
            autocomplete="new-password"
          >
        </div>
        <div class="settings-actions">
          <button
            type="button"
            class="settings-btn"
            :disabled="pwBusy"
            @click="changePassword"
          >
            {{ pwBusy ? t('settings.password.saving') : t('settings.password.save') }}
          </button>
          <span v-if="pwSuccess" class="settings-ok">{{ t('settings.password.saved') }}</span>
          <span v-if="pwError" class="settings-err">{{ pwError }}</span>
        </div>
      </section>

      <!-- Appearance -->
      <section class="settings-card">
        <h2 class="settings-section-title">{{ t('settings.theme.title') }}</h2>
        <div class="settings-segment">
          <button
            type="button"
            class="settings-segment-btn"
            :class="{ 'settings-segment-btn--active': !theme.isDark.value }"
            @click="theme.isDark.value && theme.toggle()"
          >
            {{ t('settings.theme.light') }}
          </button>
          <button
            type="button"
            class="settings-segment-btn"
            :class="{ 'settings-segment-btn--active': theme.isDark.value }"
            @click="!theme.isDark.value && theme.toggle()"
          >
            {{ t('settings.theme.dark') }}
          </button>
        </div>
      </section>

      <!-- Language -->
      <section class="settings-card">
        <h2 class="settings-section-title">{{ t('settings.language.title') }}</h2>
        <div class="settings-segment">
          <button
            type="button"
            class="settings-segment-btn"
            :class="{ 'settings-segment-btn--active': locale === 'en' }"
            @click="setLocale('en')"
          >
            English
          </button>
          <button
            type="button"
            class="settings-segment-btn"
            :class="{ 'settings-segment-btn--active': locale === 'fr' }"
            @click="setLocale('fr')"
          >
            Français
          </button>
        </div>
      </section>

      <!-- Editor preferences -->
      <section class="settings-card">
        <div class="settings-card-head">
          <h2 class="settings-section-title">{{ L.editor.title }}</h2>
          <span v-if="prefsSavedFor === 'editor'" class="settings-ok">{{ L.editor.saved }}</span>
          <span v-else-if="prefsBusy === 'editor'" class="settings-hint">{{ L.editor.saving }}</span>
        </div>

        <div class="settings-row">
          <label class="settings-label">{{ L.editor.columnWidth }}</label>
          <div class="settings-segment">
            <button
              v-for="opt in (['narrow', 'normal', 'wide'] as const)"
              :key="opt"
              type="button"
              class="settings-segment-btn"
              :class="{ 'settings-segment-btn--active': editorPrefs.columnWidth === opt }"
              :disabled="prefsBusy === 'editor'"
              @click="setEditorPref('columnWidth', opt)"
            >
              {{ opt === 'narrow' ? L.editor.narrow : opt === 'wide' ? L.editor.wide : L.editor.normal }}
            </button>
          </div>
        </div>

        <div class="settings-row">
          <label class="settings-label">{{ L.editor.fontSize }}</label>
          <div class="settings-segment">
            <button
              v-for="opt in (['small', 'normal', 'large'] as const)"
              :key="opt"
              type="button"
              class="settings-segment-btn"
              :class="{ 'settings-segment-btn--active': editorPrefs.fontSize === opt }"
              :disabled="prefsBusy === 'editor'"
              @click="setEditorPref('fontSize', opt)"
            >
              {{ opt === 'small' ? L.editor.small : opt === 'large' ? L.editor.large : L.editor.normal }}
            </button>
          </div>
        </div>

        <label class="settings-checkrow">
          <input
            type="checkbox"
            class="settings-checkbox"
            :checked="editorPrefs.focusModeDefault"
            :disabled="prefsBusy === 'editor'"
            @change="setFocusDefault(($event.target as HTMLInputElement).checked)"
          >
          <span>
            <span class="settings-checkrow-title">{{ L.editor.focusDefault }}</span>
            <span class="settings-hint settings-hint--block">{{ L.editor.focusHint }}</span>
          </span>
        </label>
      </section>

      <!-- AI preferences -->
      <section class="settings-card">
        <div class="settings-card-head">
          <h2 class="settings-section-title">{{ L.ai.title }}</h2>
          <span v-if="prefsSavedFor === 'ai'" class="settings-ok">{{ L.editor.saved }}</span>
          <span v-else-if="prefsBusy === 'ai'" class="settings-hint">{{ L.editor.saving }}</span>
        </div>

        <div class="settings-row">
          <label class="settings-label" for="set-chat-model">{{ L.ai.chatModel }}</label>
          <select
            id="set-chat-model"
            class="settings-input"
            :value="useCustomModel ? '__custom__' : aiPrefs.chatModel"
            :disabled="prefsBusy === 'ai'"
            @change="setChatModel(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="m in KNOWN_CHAT_MODELS" :key="m" :value="m">{{ m }}</option>
            <option value="__custom__">{{ L.ai.custom }}</option>
          </select>
          <span class="settings-hint">{{ L.ai.chatModelHint }}</span>
          <div v-if="useCustomModel" class="settings-inline-form">
            <input
              v-model="customModelInput"
              type="text"
              class="settings-input"
              :placeholder="L.ai.customLabel"
              :disabled="prefsBusy === 'ai'"
              @keydown.enter.prevent="commitCustomModel"
            >
            <button
              type="button"
              class="settings-btn settings-btn--small"
              :disabled="prefsBusy === 'ai' || customModelInput.trim().length === 0"
              @click="commitCustomModel"
            >
              OK
            </button>
          </div>
        </div>

        <div class="settings-row">
          <label class="settings-label" for="set-temp">
            {{ L.ai.temperature }} · <span class="settings-mono">{{ tempDisplay }}</span>
          </label>
          <input
            id="set-temp"
            type="range"
            class="settings-slider"
            min="0"
            max="1.5"
            step="0.1"
            :value="aiPrefs.temperature"
            :disabled="prefsBusy === 'ai'"
            @change="setTemperature(Number(($event.target as HTMLInputElement).value))"
          >
          <span class="settings-hint">{{ L.ai.temperatureHint }}</span>
        </div>

        <label class="settings-checkrow">
          <input
            type="checkbox"
            class="settings-checkbox"
            :checked="aiPrefs.disableRewriter"
            :disabled="prefsBusy === 'ai'"
            @change="setDisableRewriter(($event.target as HTMLInputElement).checked)"
          >
          <span>
            <span class="settings-checkrow-title">{{ L.ai.disableRewriter }}</span>
            <span class="settings-hint settings-hint--block">{{ L.ai.disableRewriterHint }}</span>
          </span>
        </label>

        <label class="settings-checkrow">
          <input
            type="checkbox"
            class="settings-checkbox"
            :checked="aiPrefs.disableReranker"
            :disabled="prefsBusy === 'ai'"
            @change="setDisableReranker(($event.target as HTMLInputElement).checked)"
          >
          <span>
            <span class="settings-checkrow-title">{{ L.ai.disableReranker }}</span>
            <span class="settings-hint settings-hint--block">{{ L.ai.disableRerankerHint }}</span>
          </span>
        </label>

        <p class="settings-warn">{{ L.ai.warn }}</p>
      </section>

      <!-- Notifications -->
      <section class="settings-card">
        <div class="settings-card-head">
          <h2 class="settings-section-title">{{ L.notif.title }}</h2>
          <span v-if="prefsSavedFor === 'notifications'" class="settings-ok">{{ L.editor.saved }}</span>
          <span v-else-if="prefsBusy === 'notifications'" class="settings-hint">{{ L.editor.saving }}</span>
        </div>

        <label class="settings-checkrow">
          <input
            type="checkbox"
            class="settings-checkbox"
            :checked="notifPrefs.analysisDone"
            :disabled="prefsBusy === 'notifications'"
            @change="setAnalysisDone(($event.target as HTMLInputElement).checked)"
          >
          <span>
            <span class="settings-checkrow-title">{{ L.notif.analysisDone }}</span>
            <span class="settings-hint settings-hint--block">{{ L.notif.analysisDoneHint }}</span>
          </span>
        </label>

        <label class="settings-checkrow settings-checkrow--disabled">
          <input
            type="checkbox"
            class="settings-checkbox"
            :checked="false"
            disabled
          >
          <span>
            <span class="settings-checkrow-title">
              {{ L.notif.mention }} <span class="settings-soon">{{ L.notif.soon }}</span>
            </span>
            <span class="settings-hint settings-hint--block">{{ L.notif.mentionHint }}</span>
          </span>
        </label>

        <label class="settings-checkrow settings-checkrow--disabled">
          <input
            type="checkbox"
            class="settings-checkbox"
            :checked="false"
            disabled
          >
          <span>
            <span class="settings-checkrow-title">
              {{ L.notif.digest }} <span class="settings-soon">{{ L.notif.soon }}</span>
            </span>
            <span class="settings-hint settings-hint--block">{{ L.notif.digestHint }}</span>
          </span>
        </label>
      </section>

      <!-- Two-factor authentication -->
      <section class="settings-card">
        <h2 class="settings-section-title">{{ L.twoFA.title }}</h2>
        <p class="settings-text">{{ L.twoFA.lede }}</p>
        <p class="settings-hint settings-hint--block">{{ L.twoFA.notEnforced }}</p>

        <div class="settings-status-row">
          <span
            class="settings-status-pill"
            :class="twoFA.status.value?.enabled ? 'settings-status-pill--on' : 'settings-status-pill--off'"
          >
            {{ twoFAStatusLabel }}
          </span>
        </div>

        <div class="settings-actions">
          <button
            v-if="!twoFA.status.value?.enabled"
            type="button"
            class="settings-btn"
            :disabled="twoFA.busy.value"
            @click="startEnroll"
          >
            {{ L.twoFA.enable }}
          </button>
          <button
            v-else
            type="button"
            class="settings-btn settings-btn--danger"
            :disabled="twoFA.busy.value"
            @click="openDisable"
          >
            {{ L.twoFA.disable }}
          </button>
        </div>
      </section>

      <!-- Security / MCP -->
      <section class="settings-card settings-card--wide">
        <h2 class="settings-section-title">{{ t('settings.security.title') }}</h2>
        <p class="settings-text">{{ t('settings.security.mcpLede') }}</p>
        <div class="settings-actions">
          <button type="button" class="settings-btn" @click="mcpDialogOpen = true">
            {{ t('settings.security.manageMcp') }}
          </button>
        </div>
      </section>

      <!-- Debug / diagnostics -->
      <section class="settings-card settings-card--wide">
        <h2 class="settings-section-title">{{ L.debug.title }}</h2>
        <p class="settings-text">{{ L.debug.lede }}</p>
        <p class="settings-hint settings-hint--block">{{ L.debug.relatedHint }}</p>
        <div class="settings-actions">
          <button
            type="button"
            class="settings-btn"
            :disabled="debugBusy"
            @click="copyRelatedDebug"
          >
            {{ debugBusy ? L.debug.busy : L.debug.relatedBtn }}
          </button>
          <span v-if="debugCopied" class="settings-ok">
            {{ L.debug.copied }}<template v-if="debugMeta"> · {{ debugMeta }}</template>
          </span>
          <span v-if="debugError" class="settings-err">{{ debugError }}</span>
        </div>
      </section>
    </div>

    <McpTokensDialog :is-open="mcpDialogOpen" @close="mcpDialogOpen = false" />

    <!-- ============================================================ -->
    <!-- 2FA enrollment dialog                                          -->
    <!-- ============================================================ -->
    <Teleport to="body">
      <Transition name="overlay">
        <div
          v-if="enrollOpen"
          class="tfa-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tfa-enroll-title"
          @click.self="closeEnroll"
        >
          <div class="tfa-card">
            <header class="tfa-head">
              <h2 id="tfa-enroll-title" class="tfa-title">{{ L.twoFA.title }}</h2>
            </header>

            <!-- Pre-verify: show QR + secret + code input -->
            <div v-if="!enrollBackupCodes" class="tfa-body">
              <p class="tfa-step-title">{{ L.twoFA.step1 }}</p>
              <div class="tfa-qr-wrap">
                <img
                  v-if="enrollQr"
                  :src="enrollQr"
                  alt="TOTP QR code"
                  class="tfa-qr"
                >
                <div v-else class="tfa-qr-placeholder">
                  …
                </div>
              </div>

              <p class="tfa-step-sub">{{ L.twoFA.step1Manual }}</p>
              <div class="tfa-secret-row">
                <code class="tfa-secret">{{ enrollSecret ?? '' }}</code>
              </div>

              <p class="tfa-step-title">{{ L.twoFA.step2 }}</p>
              <input
                v-model="enrollCode"
                type="text"
                class="settings-input tfa-code-input"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                :placeholder="L.twoFA.codePlaceholder"
                @keydown.enter.prevent="submitEnroll"
              >

              <p v-if="enrollError" class="settings-err">{{ enrollError }}</p>

              <div class="tfa-actions">
                <button
                  type="button"
                  class="settings-btn settings-btn--ghost"
                  :disabled="twoFA.busy.value"
                  @click="closeEnroll"
                >
                  {{ L.twoFA.cancel }}
                </button>
                <button
                  type="button"
                  class="settings-btn"
                  :disabled="twoFA.busy.value || enrollCode.length !== 6"
                  @click="submitEnroll"
                >
                  {{ twoFA.busy.value ? L.twoFA.confirming : L.twoFA.confirm }}
                </button>
              </div>
            </div>

            <!-- Post-verify: show backup codes -->
            <div v-else class="tfa-body">
              <p class="tfa-step-title">{{ L.twoFA.codes }}</p>
              <p class="settings-text">{{ L.twoFA.codesLede }}</p>

              <ul class="tfa-codes">
                <li v-for="(code, i) in enrollBackupCodes" :key="i" class="tfa-code">
                  <code>{{ code }}</code>
                </li>
              </ul>

              <div class="tfa-actions tfa-actions--between">
                <button
                  type="button"
                  class="settings-btn settings-btn--ghost"
                  @click="copyBackupCodes"
                >
                  {{ enrollCopied ? L.twoFA.copied : L.twoFA.copy }}
                </button>

                <label class="tfa-ack">
                  <input v-model="enrollAck" type="checkbox" class="settings-checkbox">
                  <span>{{ L.twoFA.ackText }}</span>
                </label>
              </div>

              <div class="tfa-actions tfa-actions--right">
                <button
                  type="button"
                  class="settings-btn"
                  :disabled="!enrollAck"
                  @click="closeEnroll"
                >
                  {{ L.twoFA.done }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- ============================================================ -->
    <!-- 2FA disable dialog                                             -->
    <!-- ============================================================ -->
    <Teleport to="body">
      <Transition name="overlay">
        <div
          v-if="disableOpen"
          class="tfa-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tfa-disable-title"
          @click.self="closeDisable"
        >
          <div class="tfa-card tfa-card--narrow">
            <header class="tfa-head">
              <h2 id="tfa-disable-title" class="tfa-title">{{ L.twoFA.disableTitle }}</h2>
              <p class="settings-text">{{ L.twoFA.disableMessage }}</p>
            </header>

            <div class="tfa-body">
              <label class="settings-label" for="tfa-disable-pw">{{ L.twoFA.passwordLabel }}</label>
              <input
                id="tfa-disable-pw"
                v-model="disablePassword"
                type="password"
                class="settings-input"
                autocomplete="current-password"
                @keydown.enter.prevent="submitDisable"
              >
              <p v-if="disableError" class="settings-err">{{ disableError }}</p>

              <div class="tfa-actions">
                <button
                  type="button"
                  class="settings-btn settings-btn--ghost"
                  :disabled="twoFA.busy.value"
                  @click="closeDisable"
                >
                  {{ L.twoFA.cancel }}
                </button>
                <button
                  type="button"
                  class="settings-btn settings-btn--danger"
                  :disabled="twoFA.busy.value"
                  @click="submitDisable"
                >
                  {{ twoFA.busy.value ? L.twoFA.disabling : L.twoFA.disableSubmit }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.settings-shell {
  @apply mx-auto w-full max-w-3xl px-6 py-10;
}
.settings-header {
  @apply mb-8;
}
.settings-title {
  @apply font-serif text-3xl font-semibold leading-tight text-ink-900 dark:text-ink-50;
}
.settings-lede {
  @apply mt-2 text-sm text-ink-500 dark:text-ink-400;
}
.settings-grid {
  @apply flex flex-col gap-5;
}
.settings-card {
  @apply rounded-xl border border-ink-200 bg-white p-5;
}
html.dark .settings-card {
  border-color: theme('colors.ink.800');
  background: theme('colors.ink.900' / 50%);
}
.settings-card-head {
  @apply mb-4 flex items-baseline gap-3;
}
.settings-card-head .settings-section-title {
  @apply mb-0;
}
.settings-section-title {
  @apply mb-4 font-serif text-lg font-semibold text-ink-900 dark:text-ink-100;
}
.settings-row {
  @apply mb-3 flex flex-col gap-1;
}
.settings-label {
  @apply text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400;
}
.settings-input {
  @apply rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none transition-colors focus:border-accent-500;
}
html.dark .settings-input {
  background: theme('colors.ink.950');
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.50');
}
.settings-input--ro {
  @apply text-ink-500 dark:text-ink-400;
}
.settings-hint {
  @apply text-[11px] text-ink-400 dark:text-ink-500;
}
.settings-hint--block {
  @apply block mt-1;
}
.settings-warn {
  @apply mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800;
}
html.dark .settings-warn {
  border-color: theme('colors.amber.700' / 60%);
  background: theme('colors.amber.900' / 30%);
  color: theme('colors.amber.200');
}
.settings-actions {
  @apply mt-3 flex items-center gap-3;
}
.settings-btn {
  @apply inline-flex items-center rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-ink-50 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-ink-100 dark:text-ink-900 dark:hover:bg-ink-200;
}
.settings-btn--small {
  @apply px-2 py-1 text-xs;
}
.settings-btn--ghost {
  @apply bg-transparent text-ink-700 hover:bg-ink-100 dark:bg-transparent dark:text-ink-200 dark:hover:bg-ink-800;
  border: 1px solid theme('colors.ink.200');
}
html.dark .settings-btn--ghost { border-color: theme('colors.ink.700'); }
.settings-btn--danger {
  @apply bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:text-white dark:hover:bg-red-500;
}
.settings-ok {
  @apply text-xs text-emerald-600 dark:text-emerald-400;
}
.settings-err {
  @apply text-xs text-red-600 dark:text-red-400 mt-2;
}
.settings-segment {
  @apply inline-flex rounded-md border border-ink-200 p-0.5 dark:border-ink-800;
}
.settings-segment-btn {
  @apply rounded px-3 py-1.5 text-sm text-ink-600 transition-colors hover:text-ink-900 dark:text-ink-400 dark:hover:text-ink-100;
}
.settings-segment-btn:disabled { @apply cursor-not-allowed opacity-50; }
.settings-segment-btn--active {
  @apply bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900;
}
.settings-text {
  @apply text-sm text-ink-600 dark:text-ink-400;
}
.settings-checkrow {
  @apply mt-3 flex items-start gap-3 cursor-pointer;
}
.settings-checkrow--disabled {
  @apply cursor-not-allowed opacity-60;
}
.settings-checkrow-title {
  @apply block text-sm text-ink-800 dark:text-ink-200;
}
.settings-checkbox {
  @apply mt-0.5 h-4 w-4 rounded border-ink-300 text-accent-600 focus:ring-accent-500;
  accent-color: theme('colors.accent.600');
}
.settings-soon {
  @apply ml-2 inline-flex items-center rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500;
}
html.dark .settings-soon {
  background: theme('colors.ink.800');
  color: theme('colors.ink.400');
}
.settings-inline-form {
  @apply mt-2 flex items-center gap-2;
}
.settings-slider {
  @apply w-full;
  accent-color: theme('colors.accent.600');
}
.settings-mono {
  @apply font-mono text-[12px] text-ink-700 dark:text-ink-300;
}
.settings-status-row {
  @apply my-3;
}
.settings-status-pill {
  @apply inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium;
}
.settings-status-pill--on {
  @apply bg-emerald-100 text-emerald-700;
}
html.dark .settings-status-pill--on {
  background: theme('colors.emerald.900' / 40%);
  color: theme('colors.emerald.300');
}
.settings-status-pill--off {
  @apply bg-ink-100 text-ink-600;
}
html.dark .settings-status-pill--off {
  background: theme('colors.ink.800');
  color: theme('colors.ink.300');
}

/* ----------- 2FA dialogs ---------------------------------------- */
.tfa-overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center px-6 py-10;
  background: theme('colors.ink.900' / 35%);
  backdrop-filter: blur(4px);
  overflow-y: auto;
}
html.dark .tfa-overlay {
  background: theme('colors.ink.950' / 70%);
}
.tfa-card {
  @apply relative w-full max-w-[520px] rounded-lg bg-white dark:bg-ink-900 px-7 py-6;
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 24px 60px -20px theme('colors.ink.900' / 35%);
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
html.dark .tfa-card {
  border-color: theme('colors.ink.800');
}
.tfa-card--narrow {
  @apply max-w-[440px];
}
.tfa-head {
  @apply mb-4;
}
.tfa-title {
  @apply font-serif text-[1.4rem] leading-tight text-ink-900 dark:text-ink-50 mb-2;
}
.tfa-body {
  @apply flex flex-col gap-3;
}
.tfa-step-title {
  @apply text-[12px] font-semibold uppercase tracking-wider text-ink-700 dark:text-ink-300 mt-2;
}
.tfa-step-sub {
  @apply text-[12px] text-ink-500 dark:text-ink-400 mt-1;
}
.tfa-qr-wrap {
  @apply flex justify-center;
}
.tfa-qr {
  @apply rounded-md bg-white p-3;
  border: 1px solid theme('colors.ink.200');
}
html.dark .tfa-qr {
  border-color: theme('colors.ink.700');
}
.tfa-qr-placeholder {
  @apply h-[220px] w-[220px] grid place-items-center text-ink-300 dark:text-ink-700;
}
.tfa-secret-row {
  @apply flex items-center justify-center;
}
.tfa-secret {
  @apply select-all rounded border border-ink-200 bg-ink-50 px-2 py-1 font-mono text-[12px] text-ink-800;
}
html.dark .tfa-secret {
  border-color: theme('colors.ink.700');
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.tfa-code-input {
  @apply text-center font-mono tracking-[0.4em] text-lg;
}
.tfa-actions {
  @apply mt-2 flex items-center justify-end gap-3;
}
.tfa-actions--between {
  @apply justify-between;
}
.tfa-actions--right {
  @apply justify-end;
}
.tfa-codes {
  @apply my-3 grid grid-cols-2 gap-2 list-none p-0;
}
.tfa-code {
  @apply rounded border border-ink-200 bg-ink-50 px-3 py-2 text-center font-mono text-[13px] text-ink-800;
}
html.dark .tfa-code {
  border-color: theme('colors.ink.700');
  background: theme('colors.ink.800');
  color: theme('colors.ink.100');
}
.tfa-ack {
  @apply flex items-center gap-2 text-[12px] text-ink-600 dark:text-ink-300 cursor-pointer;
}

/* Transitions */
.overlay-enter-from, .overlay-leave-to { opacity: 0; }
.overlay-enter-active, .overlay-leave-active { transition: opacity 140ms ease; }
</style>
