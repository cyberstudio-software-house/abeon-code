import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        'bg-elev': 'var(--color-bg-elev)',
        'bg-elev-2': 'var(--color-bg-elev-2)',
        fg: 'var(--color-fg)',
        'fg-secondary': 'var(--color-fg-secondary)',
        muted: 'var(--color-muted)',
        border: 'var(--color-border)',
        accent: 'var(--color-accent)',
        'accent-fg': 'var(--color-accent-fg)',
        danger: 'var(--color-danger)',
        success: 'var(--color-success)',
        warn: 'var(--color-warn)',
      },
      fontFamily: {
        sans: ["'Geist'", 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ["'JetBrains Mono'", 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        display: ["'Instrument Sans'", 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ["'Instrument Serif'", 'ui-serif', 'Georgia', 'serif'],
      },
    },
  },
} satisfies Config;
