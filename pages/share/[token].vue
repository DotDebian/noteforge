<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderPublicMarkdown } from '~/composables/useMarkdownView'
import { useLocale } from '~/composables/useLocale'

const { t } = useLocale()

definePageMeta({
  // Avoid the app sidebar / chat drawer / auth chrome — this page is
  // unauthenticated and must work for visitors with no session. The
  // global auth middleware whitelists `/share/*`.
  layout: false,
})

interface ShareResponse {
  document: { title: string, markdown: string, updatedAt: string }
  workspaceName: string
}

const route = useRoute()
const token = computed(() => String(route.params.token))

const { data, error, pending } = await useFetch<ShareResponse>(
  () => `/api/public/docs/${token.value}`,
  { watch: [token] },
)

const html = computed(() =>
  data.value?.document.markdown ? renderPublicMarkdown(data.value.document.markdown) : '',
)

useHead(() => ({
  title: data.value?.document.title
    ? `${data.value.document.title} — ${t('doc.head.titleSuffix')}`
    : t('public.head.title'),
}))

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copyMarkdown() {
  const md = data.value?.document.markdown
  if (!md) return
  try {
    await navigator.clipboard.writeText(md)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 1600)
  }
  catch {
    // Clipboard API rejects in non-secure contexts and some browsers.
    // Stay silent — there's nothing useful we can show on a public page.
  }
}
</script>

<template>
  <div class="public-shell">
    <header class="banner" role="banner">
      <span class="banner-eyebrow">{{ t('public.banner.eyebrow') }}</span>
      <span v-if="data?.workspaceName" class="banner-text">
        {{ t('public.banner.from') }} <strong>{{ data.workspaceName }}</strong>
      </span>
    </header>

    <main class="main">
      <div v-if="pending" class="state">
        <div class="sk-title" />
        <div class="sk-line" />
        <div class="sk-line sk-line--short" />
        <div class="sk-line" />
      </div>

      <div v-else-if="error" class="state state--center">
        <p class="state-eyebrow">{{ t('public.notFoundEyebrow') }}</p>
        <h1 class="state-title">{{ t('public.notFoundTitle') }}</h1>
        <p class="state-msg">
          {{ t('public.notFoundMsg') }}
        </p>
      </div>

      <article v-else-if="data" class="doc">
        <div class="doc-toolbar">
          <button type="button" class="ghost-btn" @click="copyMarkdown">
            {{ copied ? t('public.copied') : t('public.copy') }}
          </button>
        </div>
        <h1 class="doc-title">{{ data.document.title || t('doc.untitled') }}</h1>
        <!-- The sanitizer depends on the browser's DOMParser, so the markdown
             body is rendered client-side only. SSR shows a skeleton; the real
             content paints after hydration. -->
        <ClientOnly>
          <div class="doc-body" v-html="html" />
          <template #fallback>
            <div class="doc-body doc-body--skel">
              <div class="sk-line" />
              <div class="sk-line" />
              <div class="sk-line sk-line--short" />
              <div class="sk-line" />
              <div class="sk-line sk-line--short" />
            </div>
          </template>
        </ClientOnly>
      </article>
    </main>

    <footer class="foot">
      <span>{{ t('public.foot') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.public-shell {
  @apply min-h-full w-full flex flex-col bg-ink-50 dark:bg-ink-950 text-ink-900 dark:text-ink-100;
}

.banner {
  @apply flex items-center gap-3 px-8 py-3 border-b border-ink-200/60 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-500 dark:text-ink-400;
}
html.dark .banner { border-bottom-color: theme('colors.ink.800' / 60%); }
.banner-eyebrow {
  @apply px-2 py-0.5 rounded-sm bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200;
}
.banner-text { @apply normal-case tracking-normal font-normal text-[12px] text-ink-600 dark:text-ink-300; }
.banner-text strong { @apply font-semibold text-ink-800 dark:text-ink-100; }

.main { @apply flex-1 px-6 py-10; }

.doc { @apply max-w-3xl xl:max-w-4xl mx-auto; }
.doc-toolbar { @apply flex justify-end mb-6; }
.doc-title {
  @apply font-serif text-[2.2rem] leading-[1.15] tracking-tight mb-8;
}
.doc-body {
  @apply text-[15px] leading-[1.7] text-ink-800 dark:text-ink-200;
}

.doc-body :deep(h1) { @apply font-serif text-[1.6rem] mt-10 mb-4 tracking-tight; }
.doc-body :deep(h2) { @apply font-serif text-[1.35rem] mt-9 mb-3 tracking-tight; }
.doc-body :deep(h3) { @apply font-serif text-[1.15rem] mt-7 mb-2 tracking-tight; }
.doc-body :deep(p) { @apply my-4; }
.doc-body :deep(ul), .doc-body :deep(ol) { @apply my-4 pl-6; }
.doc-body :deep(ul) { @apply list-disc; }
.doc-body :deep(ol) { @apply list-decimal; }
.doc-body :deep(li) { @apply my-1; }
.doc-body :deep(blockquote) {
  @apply pl-4 my-5 italic text-ink-600 dark:text-ink-300;
  border-left: 3px solid theme('colors.ink.300');
}
html.dark .doc-body :deep(blockquote) { border-left-color: theme('colors.ink.700'); }
.doc-body :deep(code) {
  @apply font-mono text-[0.85em] px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800;
}
.doc-body :deep(pre) {
  @apply font-mono text-[0.85em] my-5 p-4 rounded bg-ink-100 dark:bg-ink-900 overflow-x-auto;
  border: 1px solid theme('colors.ink.200');
}
html.dark .doc-body :deep(pre) { border-color: theme('colors.ink.800'); }
.doc-body :deep(pre code) { @apply p-0 bg-transparent; }
.doc-body :deep(a) {
  @apply text-accent-700 dark:text-accent-300 underline decoration-1 underline-offset-2;
}
.doc-body :deep(hr) {
  @apply my-8 border-0;
  border-top: 1px solid theme('colors.ink.200');
}
html.dark .doc-body :deep(hr) { border-top-color: theme('colors.ink.800'); }
.doc-body :deep(table) {
  @apply w-full my-5 text-[14px] border-collapse;
}
.doc-body :deep(th), .doc-body :deep(td) {
  @apply px-3 py-2 text-left;
  border-bottom: 1px solid theme('colors.ink.200');
}
html.dark .doc-body :deep(th), html.dark .doc-body :deep(td) {
  border-bottom-color: theme('colors.ink.800');
}
.doc-body :deep(th) { @apply font-semibold; }
.doc-body :deep(input[type="checkbox"]) { @apply mr-2 align-middle; }

.state { @apply max-w-3xl mx-auto pt-10; }
.state--center { @apply text-center max-w-md; }
.state-eyebrow { @apply label-mono mb-3; }
.state-title { @apply font-serif text-[1.7rem] tracking-tight mb-2; }
.state-msg { @apply text-[13px] text-ink-600 dark:text-ink-300; }

.sk-title {
  @apply h-8 w-2/3 rounded mb-8 bg-ink-100 dark:bg-ink-800;
  animation: shimmer 1.4s ease-in-out infinite;
}
.sk-line {
  @apply h-3 w-full rounded mb-3 bg-ink-100 dark:bg-ink-800;
  animation: shimmer 1.4s ease-in-out infinite;
}
.sk-line--short { @apply w-1/2; }
@keyframes shimmer {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

/* Skeleton placeholder for the markdown body while client-side hydration
   takes over (the sanitizer needs DOMParser, which doesn't exist on the
   server). Uses the same shimmer animation as the page-level state.sk-* rules. */
.doc-body--skel {
  @apply flex flex-col gap-3;
}
.doc-body--skel .sk-line {
  @apply h-3 w-full rounded bg-ink-100 dark:bg-ink-800;
  animation: shimmer 1.4s ease-in-out infinite;
}

.foot {
  @apply px-8 py-5 border-t border-ink-200/60 font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-400 dark:text-ink-500;
}
html.dark .foot { border-top-color: theme('colors.ink.800' / 60%); }

.ghost-btn {
  @apply inline-flex items-center justify-center h-9 px-4 rounded font-sans uppercase text-[11px] font-semibold tracking-[0.08em] text-ink-700 dark:text-ink-200;
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
</style>
