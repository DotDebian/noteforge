// Tailwind types are provided by `@nuxtjs/tailwindcss` at module load; we
// keep the config typed as a plain object to avoid importing from
// `tailwindcss` (whose types are not exposed by the v3 entry).

// Tiny inline plugin that exposes `.label-mono` / `.label-mono-strong` as
// real Tailwind components — required so `@apply label-mono` works inside
// Vue `<style scoped>` blocks (each scoped block is processed in isolation
// and doesn't see classes defined in main.css's @layer).
const labelComponents = ({ addComponents }: { addComponents: (defs: Record<string, unknown>) => void }) => {
  // Class names kept as `.label-mono(-strong)` for backwards-compat — the
  // visual is now Inter sans-serif uppercase, which reads much better at
  // 11px than any monospace font. Tracking dropped to fit Inter's natural
  // letter rhythm.
  addComponents({
    '.label-mono': {
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontWeight: '600',
      fontSize: '11px',
      lineHeight: '1.1',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: '#6c6c62', // ink-500
    },
    '.dark .label-mono': {
      color: '#b8b8b0', // ink-300
    },
    '.label-mono-strong': {
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontWeight: '700',
      fontSize: '11px',
      lineHeight: '1.1',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: '#3d3d37', // ink-700
    },
    '.dark .label-mono-strong': {
      color: '#d9d9d4', // ink-200
    },
  })
}

export default {
  darkMode: 'class',
  content: [
    './components/**/*.{vue,js,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './app.vue',
    './error.vue',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['"Source Serif 4"', 'Georgia', 'serif'],
        mono: ['ui-monospace', '"Cascadia Code"', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        ink: {
          50: '#f7f7f5',
          100: '#ededea',
          200: '#d9d9d4',
          300: '#b8b8b0',
          400: '#8e8e84',
          500: '#6c6c62',
          600: '#52524a',
          700: '#3d3d37',
          800: '#26261f',
          900: '#15150f',
          950: '#0a0a06',
        },
        accent: {
          50:  '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
        },
      },
    },
  },
  plugins: [labelComponents],
} as const
