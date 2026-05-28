<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspaceSharesStore, type ShareMember } from '~/stores/workspaceShares'
import { useDialog } from '~/composables/useDialog'

const props = defineProps<{
  isOpen: boolean
  workspaceId: number | null
  workspaceName: string
  isOwner: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const sharesStore = useWorkspaceSharesStore()
const dialog = useDialog()

const email = ref('')
const role = ref<'editor' | 'viewer'>('editor')
const busy = ref(false)
const localError = ref<string | null>(null)

// Hard-coded French copy — sharing is a brand-new feature so it lives
// outside the i18n bundle for now (same pattern as the new sidebar bits).
const L = {
  title: 'Partager le workspace',
  subtitle: (name: string) => `« ${name} » sera accessible aux personnes invitées.`,
  encryptionNote:
    'Au premier partage, le contenu sera ré-chiffré sous une clé de workspace dédiée. Le propriétaire et chaque invité possèdent leur propre enveloppe de cette clé — le serveur ne peut jamais la lire.',
  emailLabel: 'Adresse e-mail',
  emailPlaceholder: 'collegue@exemple.com',
  roleLabel: 'Rôle',
  roleEditor: 'Éditeur',
  roleEditorHint: 'Lecture + écriture',
  roleViewer: 'Lecteur',
  roleViewerHint: 'Lecture seule',
  inviteBtn: 'Inviter',
  members: 'Membres',
  noMembers: 'Aucun membre invité pour le moment.',
  roleOwner: 'Propriétaire',
  revoke: 'Retirer',
  revokeConfirmTitle: (email: string) => `Retirer ${email} ?`,
  revokeConfirmBody:
    'L\'utilisateur perdra l\'accès au workspace. Note : il aura pu copier le contenu auquel il avait accès jusqu\'à présent.',
  revokeConfirmYes: 'Retirer',
  close: 'Fermer',
  errors: {
    missing_target_user: 'Aucun compte n\'utilise cette adresse e-mail.',
    missing_target_keypair: 'Cet utilisateur doit se reconnecter une fois pour que ses clés soient générées.',
    missing_owner_keypair: 'Vos clés de partage ne sont pas encore prêtes — reconnectez-vous.',
    target_is_owner: 'Vous êtes déjà propriétaire de ce workspace.',
    already_shared: 'Cet utilisateur a déjà accès au workspace.',
    session_missing_dek: 'Reconnectez-vous pour partager (session sans clé).',
    owner_only: 'Seul le propriétaire peut partager ce workspace.',
    share_failed: 'Le partage a échoué.',
    role_change_failed: 'Le changement de rôle a échoué.',
    revoke_failed: 'Le retrait a échoué.',
    default: 'Erreur inconnue.',
  } as Record<string, string>,
}

const members = computed<ShareMember[]>(() =>
  props.workspaceId != null ? sharesStore.members(props.workspaceId) : [],
)

watch(
  () => [props.isOpen, props.workspaceId] as const,
  async ([open, id]) => {
    if (open && id != null) {
      localError.value = null
      try {
        await sharesStore.fetch(id)
      }
      catch (err) {
        localError.value = errorLabel((err as Error).message)
      }
    }
  },
  { immediate: true },
)

function errorLabel(code: string | null | undefined): string {
  if (!code) return L.errors.default!
  return L.errors[code] ?? L.errors.default!
}

async function onInvite() {
  if (!props.workspaceId || !props.isOwner) return
  const e = email.value.trim().toLowerCase()
  if (e.length === 0) return
  busy.value = true
  localError.value = null
  try {
    await sharesStore.share(props.workspaceId, e, role.value)
    email.value = ''
  }
  catch (err) {
    const code = (err as { data?: { statusMessage?: string }, statusMessage?: string }).data?.statusMessage
      ?? (err as { statusMessage?: string }).statusMessage
      ?? (err as Error).message
    localError.value = errorLabel(code)
  }
  finally {
    busy.value = false
  }
}

async function onRevoke(member: ShareMember) {
  if (!props.workspaceId || !props.isOwner || member.role === 'owner') return
  const ok = await dialog.confirm({
    title: L.revokeConfirmTitle(member.email),
    message: L.revokeConfirmBody,
    confirmLabel: L.revokeConfirmYes,
    destructive: true,
  })
  if (!ok) return
  try {
    await sharesStore.revoke(props.workspaceId, member.userId)
  }
  catch (err) {
    localError.value = errorLabel((err as { data?: { statusMessage?: string } }).data?.statusMessage ?? (err as Error).message)
  }
}

async function onRoleChange(member: ShareMember, newRole: 'editor' | 'viewer') {
  if (!props.workspaceId || !props.isOwner || member.role === 'owner') return
  if (newRole === member.role) return
  try {
    await sharesStore.setRole(props.workspaceId, member.userId, newRole)
  }
  catch (err) {
    localError.value = errorLabel((err as { data?: { statusMessage?: string } }).data?.statusMessage ?? (err as Error).message)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="share-overlay" role="dialog" aria-modal="true" @click.self="emit('close')">
      <div class="share-card">
        <header class="share-header">
          <h2 class="share-title">{{ L.title }}</h2>
          <p class="share-subtitle">{{ L.subtitle(workspaceName) }}</p>
          <p class="share-note">{{ L.encryptionNote }}</p>
        </header>

        <section v-if="isOwner" class="share-invite">
          <label class="field">
            <span class="field-label">{{ L.emailLabel }}</span>
            <input
              v-model="email"
              type="email"
              :placeholder="L.emailPlaceholder"
              class="field-input"
              :disabled="busy"
              @keydown.enter.prevent="onInvite"
            >
          </label>

          <label class="field field--inline">
            <span class="field-label">{{ L.roleLabel }}</span>
            <select v-model="role" class="field-input field-select" :disabled="busy">
              <option value="editor">{{ L.roleEditor }} — {{ L.roleEditorHint }}</option>
              <option value="viewer">{{ L.roleViewer }} — {{ L.roleViewerHint }}</option>
            </select>
          </label>

          <button
            class="invite-btn"
            type="button"
            :disabled="busy || email.trim().length === 0"
            @click="onInvite"
          >
            {{ L.inviteBtn }}
          </button>
        </section>

        <p v-if="localError" class="share-error">{{ localError }}</p>

        <section class="share-members">
          <h3 class="members-title">{{ L.members }}</h3>
          <p v-if="members.length === 0" class="members-empty">{{ L.noMembers }}</p>
          <ul v-else class="members-list">
            <li v-for="m in members" :key="m.id" class="member-row">
              <div class="member-info">
                <span class="member-name">{{ m.displayName || m.email }}</span>
                <span v-if="m.displayName" class="member-email">{{ m.email }}</span>
              </div>
              <div class="member-actions">
                <span v-if="m.role === 'owner'" class="role-badge role-badge--owner">{{ L.roleOwner }}</span>
                <select
                  v-else-if="isOwner"
                  class="role-select"
                  :value="m.role"
                  @change="onRoleChange(m, ($event.target as HTMLSelectElement).value as 'editor' | 'viewer')"
                >
                  <option value="editor">{{ L.roleEditor }}</option>
                  <option value="viewer">{{ L.roleViewer }}</option>
                </select>
                <span v-else class="role-badge">{{ m.role === 'editor' ? L.roleEditor : L.roleViewer }}</span>
                <button
                  v-if="isOwner && m.role !== 'owner'"
                  type="button"
                  class="revoke-btn"
                  :title="L.revoke"
                  @click="onRevoke(m)"
                >
                  ×
                </button>
              </div>
            </li>
          </ul>
        </section>

        <footer class="share-footer">
          <button type="button" class="close-btn" @click="emit('close')">{{ L.close }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.share-overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center px-4;
  background: theme('colors.ink.900' / 50%);
  backdrop-filter: blur(4px);
}
html.dark .share-overlay {
  background: theme('colors.ink.950' / 65%);
}

.share-card {
  @apply flex flex-col w-full max-w-lg max-h-[90vh] overflow-auto rounded-lg;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  box-shadow: 0 20px 60px theme('colors.ink.900' / 30%);
}
html.dark .share-card {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
}

.share-header {
  @apply px-6 pt-6 pb-4 border-b;
  border-color: theme('colors.ink.200' / 50%);
}
html.dark .share-header {
  border-color: theme('colors.ink.800' / 60%);
}
.share-title {
  @apply font-serif text-[20px] text-ink-900 dark:text-ink-50 mb-1;
}
.share-subtitle {
  @apply text-[13px] text-ink-600 dark:text-ink-300;
}
.share-note {
  @apply mt-3 text-[12px] leading-relaxed text-ink-500 dark:text-ink-400;
  border-left: 2px solid theme('colors.accent.400');
  padding-left: 0.6rem;
}

.share-invite {
  @apply flex flex-col gap-2 px-6 py-4;
}
.field {
  @apply flex flex-col gap-1;
}
.field--inline {
  @apply flex-row items-center gap-3;
}
.field--inline .field-label {
  @apply min-w-[60px];
}
.field-label {
  @apply label-mono text-ink-500 dark:text-ink-400;
}
.field-input {
  @apply px-3 py-2 rounded text-[13px] text-ink-900 dark:text-ink-100;
  background: theme('colors.ink.100' / 50%);
  border: 1px solid theme('colors.ink.200');
}
html.dark .field-input {
  background: theme('colors.ink.800' / 50%);
  border-color: theme('colors.ink.700');
}
.field-input:focus {
  outline: 2px solid theme('colors.accent.400');
  outline-offset: 1px;
}
.field-select {
  @apply flex-1;
}

.invite-btn {
  @apply mt-2 self-end px-4 py-2 rounded text-[12.5px] font-semibold uppercase tracking-[0.06em];
  background: theme('colors.accent.500');
  color: white;
  transition: background 120ms ease;
}
.invite-btn:hover:not(:disabled) {
  background: theme('colors.accent.600');
}
.invite-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.share-error {
  @apply mx-6 mb-2 px-3 py-2 rounded text-[12.5px];
  background: theme('colors.accent.50');
  color: theme('colors.accent.800');
  border: 1px solid theme('colors.accent.200');
}
html.dark .share-error {
  background: theme('colors.accent.900' / 30%);
  color: theme('colors.accent.100');
  border-color: theme('colors.accent.700');
}

.share-members {
  @apply px-6 pt-3 pb-2;
}
.members-title {
  @apply label-mono mb-3 text-ink-500 dark:text-ink-400;
}
.members-empty {
  @apply text-[12.5px] text-ink-500 dark:text-ink-400;
}
.members-list {
  @apply flex flex-col gap-1;
}
.member-row {
  @apply flex items-center justify-between gap-3 px-2 py-2 rounded;
}
.member-row:hover {
  background: theme('colors.ink.100' / 70%);
}
html.dark .member-row:hover {
  background: theme('colors.ink.800' / 60%);
}
.member-info {
  @apply flex flex-col min-w-0;
}
.member-name {
  @apply text-[13px] text-ink-900 dark:text-ink-100 truncate;
}
.member-email {
  @apply text-[11px] text-ink-500 dark:text-ink-400 truncate;
}
.member-actions {
  @apply flex items-center gap-2 shrink-0;
}
.role-badge {
  @apply font-sans text-[10.5px] uppercase tracking-[0.06em] font-semibold px-2 py-0.5 rounded;
  background: theme('colors.ink.200' / 70%);
  color: theme('colors.ink.700');
}
html.dark .role-badge {
  background: theme('colors.ink.800');
  color: theme('colors.ink.200');
}
.role-badge--owner {
  background: theme('colors.accent.500');
  color: white;
}
.role-select {
  @apply text-[12px] px-2 py-1 rounded;
  background: theme('colors.ink.100' / 70%);
  border: 1px solid theme('colors.ink.200');
}
html.dark .role-select {
  background: theme('colors.ink.800');
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.100');
}
.revoke-btn {
  @apply inline-flex items-center justify-center w-6 h-6 rounded text-ink-500 dark:text-ink-400;
  font-size: 18px;
  line-height: 1;
}
.revoke-btn:hover {
  background: theme('colors.accent.500');
  color: white;
}

.share-footer {
  @apply px-6 py-4 mt-2 border-t flex justify-end;
  border-color: theme('colors.ink.200' / 50%);
}
html.dark .share-footer {
  border-color: theme('colors.ink.800' / 60%);
}
.close-btn {
  @apply px-4 py-2 rounded text-[12.5px] font-semibold uppercase tracking-[0.06em] text-ink-700 dark:text-ink-200;
  border: 1px solid theme('colors.ink.200');
}
html.dark .close-btn {
  border-color: theme('colors.ink.700');
}
.close-btn:hover {
  background: theme('colors.ink.100');
}
html.dark .close-btn:hover {
  background: theme('colors.ink.800');
}
</style>
