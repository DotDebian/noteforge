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
    mistralChatModel: process.env.MISTRAL_CHAT_MODEL ?? 'mistral-large-latest',
    mistralEmbedModel: process.env.MISTRAL_EMBED_MODEL ?? 'mistral-embed',
    databaseUrl: process.env.DATABASE_URL ?? 'data/noteforge.db',
    session: {
      maxAge: 60 * 60 * 24 * 30,
    },
    public: {
      appName: 'NoteForge',
    },
  },
  nitro: {
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
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      ],
      link: [
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
