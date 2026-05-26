import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
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
