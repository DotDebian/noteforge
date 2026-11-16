import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  // The editor extensions import their Vue NodeViews. Tests only exercise
  // the ProseMirror schema (parseHTML / renderHTML), never a mounted view,
  // so `.vue` files resolve to an empty component instead of pulling in
  // the Vue SFC compiler.
  plugins: [
    {
      name: 'stub-vue-sfc',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.vue')) return 'export default {}'
        return null
      },
    },
  ],
  resolve: {
    alias: {
      '~': root,
      '~/': `${root}/`,
      '@': root,
      '@/': `${root}/`,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 5000,
  },
})
