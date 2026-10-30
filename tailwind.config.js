/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0a0a0c',
          surface: '#121316',
          elevated: '#18191e',
          border: '#22242a',
          muted: '#272930'
        },
        // Semantic tokens (P1-02). Values live in src/index.css so light/dark is
        // decided in exactly one place instead of by literal hex per component.
        'sh-bg': 'var(--sh-bg)',
        'sh-surface': 'var(--sh-surface)',
        'sh-surface2': 'var(--sh-surface-2)',
        'sh-line': 'var(--sh-line)',
        'sh-line-strong': 'var(--sh-line-strong)',
        'sh-fg': 'var(--sh-fg)',
        'sh-muted': 'var(--sh-fg-muted)',
        'sh-subtle': 'var(--sh-fg-subtle)',
        'sh-accent': 'var(--sh-accent)',
        'sh-accent-fg': 'var(--sh-accent-fg)',
        'sh-ok': 'var(--sh-ok)',
        'sh-warn': 'var(--sh-warn)',
        'sh-danger': 'var(--sh-danger)',
        'sh-info': 'var(--sh-info)',
        'sh-focus': 'var(--sh-focus)'
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      }
    },
  },
  plugins: [],
}
