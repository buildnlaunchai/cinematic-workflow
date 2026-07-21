import type { Metadata, Viewport } from 'next'
import { Inter, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

// Self-hosted by next/font at build time — no font host is fetched at runtime and
// no font URL is hardcoded in code (which the preflight host check would reject).
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-dcmono', display: 'swap' })

export const metadata: Metadata = {
  title: 'Cinematic Workflow',
  description: 'Frame-accurate video review — versioned cuts, timecoded notes, and read-only share links.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0f14',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `dark` is pinned: this is a dark, Frame.io-style review tool. Components still
  // carry their light base classes, so removing it would render a valid light UI.
  return (
    <html lang="en" className={`dark ${inter.variable} ${jakarta.variable} ${mono.variable}`}>
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  )
}
