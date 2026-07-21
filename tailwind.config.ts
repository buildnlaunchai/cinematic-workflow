import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'

/**
 * Mirrors the config the source app loaded inline via the Tailwind CDN:
 * class-based dark mode, plus the Jakarta / JetBrains-Mono font families the
 * ported components reference as `font-jakarta` / `font-dcmono`. Fonts are wired
 * through next/font (see app/layout.tsx) and exposed as CSS variables, so nothing
 * is fetched from a hardcoded font host at runtime.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        jakarta: ['var(--font-jakarta)', '-apple-system', 'sans-serif'],
        dcmono: ['var(--font-dcmono)', 'monospace'],
      },
    },
  },
  plugins: [tailwindcssAnimate],
}

export default config
