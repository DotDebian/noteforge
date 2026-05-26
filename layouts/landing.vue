<script setup lang="ts">
import LangToggle from '~/components/LangToggle.vue'
import ThemeToggle from '~/components/ThemeToggle.vue'
</script>

<template>
  <div class="landing-shell">
    <div class="landing-grain" aria-hidden="true" />

    <header class="landing-header">
      <NuxtLink to="/" class="wordmark" aria-label="NoteForge">
        <span class="wordmark-glyph" aria-hidden="true">N</span>
        <span class="wordmark-name">NoteForge</span>
        <span class="wordmark-dot" aria-hidden="true" />
      </NuxtLink>

      <nav class="landing-nav" aria-label="Section">
        <a href="#editeur">Éditeur</a>
        <a href="#ia">IA</a>
        <a href="#chiffrement">Chiffrement</a>
        <a href="#atelier">Atelier</a>
      </nav>

      <div class="landing-controls">
        <NuxtLink to="/login" class="signin-link">Se connecter</NuxtLink>
        <span class="ctl-sep" aria-hidden="true" />
        <LangToggle />
        <ThemeToggle />
      </div>
    </header>

    <main class="landing-main">
      <slot />
    </main>

    <footer class="landing-footer">
      <div class="footer-row">
        <span class="footer-mark">NoteForge</span>
        <span class="footer-dot" aria-hidden="true">·</span>
        <span class="footer-meta">Pour penser par écrit</span>
      </div>
      <div class="footer-row footer-row-end">
        <NuxtLink to="/login">Se connecter</NuxtLink>
        <NuxtLink to="/register">Créer un compte</NuxtLink>
        <a href="https://github.com" rel="noopener" target="_blank">Code source</a>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.landing-shell {
  @apply relative min-h-full w-full flex flex-col;
  background:
    radial-gradient(ellipse 70% 50% at 50% 0%, theme('colors.ink.100') 0%, transparent 65%),
    radial-gradient(circle at 88% 18%, theme('colors.accent.100') 0%, transparent 28%),
    linear-gradient(180deg, theme('colors.ink.50') 0%, theme('colors.ink.50') 100%);
}
html.dark .landing-shell {
  background:
    radial-gradient(ellipse 70% 50% at 50% 0%, theme('colors.ink.900') 0%, transparent 65%),
    radial-gradient(circle at 88% 18%, theme('colors.accent.900' / 35%) 0%, transparent 32%),
    linear-gradient(180deg, theme('colors.ink.950') 0%, theme('colors.ink.950') 100%);
}

.landing-grain {
  @apply pointer-events-none fixed inset-0;
  background-image:
    radial-gradient(theme('colors.ink.300') 0.6px, transparent 0.6px);
  background-size: 4px 4px;
  opacity: 0.07;
  mix-blend-mode: multiply;
  z-index: 0;
}
html.dark .landing-grain {
  background-image:
    radial-gradient(theme('colors.ink.400') 0.6px, transparent 0.6px);
  opacity: 0.06;
  mix-blend-mode: screen;
}

.landing-header {
  @apply relative z-10 flex items-center justify-between px-6 md:px-10 pt-7 pb-5;
}

.wordmark {
  @apply inline-flex items-baseline gap-2 text-ink-900 dark:text-ink-100;
}
.wordmark-glyph {
  @apply inline-flex items-center justify-center h-7 w-7 rounded-sm font-serif text-[16px] font-semibold;
  background: theme('colors.ink.900');
  color: theme('colors.ink.50');
  transform: translateY(2px);
  letter-spacing: -0.04em;
}
html.dark .wordmark-glyph {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
.wordmark-name {
  @apply font-serif text-[1.1rem] tracking-tight;
}
.wordmark-dot {
  @apply inline-block h-1.5 w-1.5 rounded-full bg-accent-500;
  transform: translateY(-1px);
}

.landing-nav {
  @apply hidden md:flex items-center gap-7;
}
.landing-nav a {
  @apply label-mono;
  letter-spacing: 0.1em;
  transition: color 140ms ease;
}
.landing-nav a:hover {
  color: theme('colors.accent.700');
}
html.dark .landing-nav a:hover {
  color: theme('colors.accent.300');
}

.landing-controls {
  @apply flex items-center gap-3;
}
.signin-link {
  @apply font-sans text-[13px] text-ink-700 dark:text-ink-200 underline underline-offset-[5px] decoration-ink-300 dark:decoration-ink-700;
  transition: color 140ms ease, text-decoration-color 140ms ease;
}
.signin-link:hover {
  color: theme('colors.accent.700');
  text-decoration-color: theme('colors.accent.500');
}
html.dark .signin-link:hover {
  color: theme('colors.accent.300');
}
.ctl-sep {
  @apply inline-block h-4 w-px bg-ink-200 dark:bg-ink-700 mx-1;
}

.landing-main {
  @apply relative z-10 flex-1;
}

.landing-footer {
  @apply relative z-10 mt-12 px-6 md:px-10 py-8 border-t border-ink-200 dark:border-ink-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-3;
}
.footer-row {
  @apply flex items-center gap-3 text-[12.5px] text-ink-500 dark:text-ink-400;
}
.footer-row-end a {
  @apply text-ink-700 dark:text-ink-300 underline underline-offset-4 decoration-ink-300 dark:decoration-ink-700;
  transition: color 140ms ease, text-decoration-color 140ms ease;
}
.footer-row-end a:hover {
  color: theme('colors.accent.700');
  text-decoration-color: theme('colors.accent.500');
}
html.dark .footer-row-end a:hover {
  color: theme('colors.accent.300');
}
.footer-mark {
  @apply font-serif text-[14px] text-ink-900 dark:text-ink-100;
}
.footer-dot {
  @apply text-ink-400;
}
</style>
