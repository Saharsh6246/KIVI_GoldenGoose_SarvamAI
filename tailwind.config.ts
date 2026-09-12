import type { Config } from 'tailwindcss';
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#17160F',
        paper: '#FAF7F0',
        sand: '#F0EADD',
        edge: '#DED5C4',
        muted: '#6F6A5C',
        accent: '#B4542B',
        good: '#3F6B45',
        warn: '#8A6A1F',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
