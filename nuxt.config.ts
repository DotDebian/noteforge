export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  modules: [
    '@nuxtjs/tailwindcss',
    '@pinia/nuxt',
    '@vueuse/nuxt',
    'nuxt-auth-utils',
  ],
  components: [
    { path: '~/components', pathPrefix: false },
  ],
  typescript: {
    strict: true,
    typeCheck: false,
  },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    mistralApiKey: process.env.MISTRAL_API_KEY ?? '',
    mistralChatModel: process.env.MISTRAL_CHAT_MODEL ?? 'mistral-medium-latest',
    mistralEmbedModel: process.env.MISTRAL_EMBED_MODEL ?? 'mistral-embed',
    tavilyApiKey: process.env.TAVILY_API_KEY ?? '',
    databaseUrl: process.env.DATABASE_URL ?? 'data/noteforge.db',
    inviteCode: process.env.INVITE_CODE ?? 'NLJELA',
    session: {
      maxAge: 60 * 60 * 24 * 30,
    },
    public: {
      appName: 'NoteForge',
    },
  },
  nitro: {
    // sqlite-vec ships its native .so via a platform-suffixed sibling package
    // (sqlite-vec-linux-x64, sqlite-vec-darwin-arm64, ...) and resolves it
    // dynamically via import.meta.resolve. Nitro's NFT trace inlines
    // sqlite-vec/index.mjs into .output/server/node_modules/ but cannot follow
    // that dynamic resolution, so the binary package must already exist where
    // Node's parent-directory walk can find it at runtime. Forcing the wrapper
    // external keeps the runtime resolve path, and .npmrc's
    // `public-hoist-pattern[]=sqlite-vec-*` ensures pnpm puts the platform
    // binary at /app/node_modules/sqlite-vec-<os>-<arch>/ (top level) instead
    // of burying it under .pnpm/, so the walk from .output/server/ reaches it.
    externals: {
      external: ['sqlite-vec'],
    },
    experimental: {
      tasks: true,
      websocket: true,
    },
  },
  app: {
    head: {
      title: 'NoteForge',
      meta: [
        { charset: 'utf-8' },
        // `maximum-scale=1, user-scalable=no` blocks pinch-zoom; `touch-action`
        // (in main.css) blocks double-tap zoom. Gives the installed PWA a fixed,
        // native-app viewport.
        { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' },
        // PWA / installability. `theme-color` tints the OS chrome in standalone
        // mode; the apple-* metas give iOS its standalone behaviour + title
        // (iOS ignores the web manifest's display/name).
        { name: 'theme-color', content: '#0a0a06' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'apple-mobile-web-app-title', content: 'NoteForge' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href:
            'https://fonts.googleapis.com/css2'
            + '?family=Inter:wght@400;500;600;700'
            + '&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700'
            + '&display=swap',
        },
        // KaTeX stylesheet — pinned to the same minor as the npm dependency so
        // the served fonts/metrics line up with what `renderToString` emits.
        {
          rel: 'stylesheet',
          href: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css',
          crossorigin: 'anonymous',
        },
      ],
    },
  },
})
