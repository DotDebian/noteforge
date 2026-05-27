<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ThemeToggle from '~/components/ThemeToggle.vue'
import { useAuth } from '~/composables/useAuth'

const route = useRoute()
const { user } = useAuth()

const navItems = [
  { path: '/admin', label: 'Aperçu', exact: true },
  { path: '/admin/users', label: 'Utilisateurs' },
  { path: '/admin/ai-usage', label: 'Tokens IA' },
  { path: '/admin/mcp', label: 'MCP' },
  { path: '/admin/security', label: 'Sécurité' },
  { path: '/admin/audit', label: 'Audit' },
  { path: '/admin/encryption', label: 'Chiffrement' },
  { path: '/admin/rag-quality', label: 'Qualité RAG' },
  { path: '/admin/jobs', label: 'Jobs' },
  { path: '/admin/logs', label: 'Logs' },
  { path: '/admin/retention', label: 'Rétention' },
  { path: '/admin/health', label: 'Santé' },
]

function isActive(item: { path: string, exact?: boolean }) {
  if (item.exact) return route.path === item.path
  return route.path.startsWith(item.path)
}
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-nav">
      <div class="admin-brand">
        <NuxtLink to="/welcome" class="brand-back" title="Retour à NoteForge">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </NuxtLink>
        <span class="brand-name">Admin</span>
        <ThemeToggle />
      </div>

      <nav class="admin-menu">
        <NuxtLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="admin-menu-item"
          :class="{ 'admin-menu-item--active': isActive(item) }"
        >
          {{ item.label }}
        </NuxtLink>
      </nav>

      <div class="admin-nav-footer">
        <span class="admin-user-email">{{ (user as any)?.email ?? '' }}</span>
      </div>
    </aside>

    <main class="admin-main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.admin-shell {
  @apply flex h-screen overflow-hidden bg-ink-50 dark:bg-ink-950;
}

.admin-nav {
  @apply flex flex-col w-52 shrink-0 h-full border-r border-ink-200/50 dark:border-ink-800/60;
  background: theme('colors.ink.100' / 60%);
}
html.dark .admin-nav {
  background: theme('colors.ink.900' / 60%);
}

.admin-brand {
  @apply flex items-center gap-2 px-4 py-4 border-b border-ink-200/50 dark:border-ink-800/60;
}

.brand-back {
  @apply flex items-center justify-center w-6 h-6 rounded text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-100;
  transition: color 120ms ease;
}

.brand-name {
  @apply flex-1 font-sans text-[11px] uppercase tracking-[0.1em] font-semibold text-ink-500 dark:text-ink-400;
}

.admin-menu {
  @apply flex-1 flex flex-col gap-0.5 px-2 py-3;
}

.admin-menu-item {
  @apply flex items-center px-3 py-2 rounded text-[13px] text-ink-600 dark:text-ink-400 font-sans;
  transition: background 100ms ease, color 100ms ease;
}
.admin-menu-item:hover {
  @apply bg-ink-200/60 dark:bg-ink-800/60 text-ink-900 dark:text-ink-100;
}
.admin-menu-item--active {
  @apply bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 font-medium;
}
html.dark .admin-menu-item--active {
  background: theme('colors.accent.900' / 40%);
}

.admin-nav-footer {
  @apply px-4 pb-4;
}
.admin-user-email {
  @apply block text-[11px] text-ink-400 dark:text-ink-600 truncate font-sans;
}

.admin-main {
  @apply flex-1 overflow-auto;
}
</style>
