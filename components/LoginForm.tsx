'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Clapperboard } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'

/**
 * Email + password sign in / sign up, standalone mode only.
 *
 * Client component — must never import anything that touches
 * SUPABASE_SERVICE_ROLE_KEY or HUB_PUBLIC_KEY. lib/env.server.ts imports
 * `server-only`, so that mistake fails the build.
 */
export function LoginForm() {
  const router = useRouter()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const supabase = createClient()

      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        // With email confirmation on, signUp succeeds but there is no session yet.
        if (!data.session) {
          setNotice('Check your email to confirm your account, then sign in.')
          setMode('signin')
          return
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      }

      // The server decides what happens next: the gate and profile row live there.
      router.replace('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-slate-950">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl"
      >
        <div className="flex items-center gap-2.5 mb-1 text-sky-400">
          <Clapperboard size={22} />
          <span className="font-jakarta text-lg font-extrabold tracking-tight text-slate-100">Cinematic Workflow</span>
        </div>
        <p className="text-sm text-slate-400 mb-6">Frame-accurate video review.</p>

        <label htmlFor="email" className="block text-xs font-bold uppercase tracking-widest text-slate-400 mb-1.5">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          className="w-full mb-4 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
        />

        <label htmlFor="password" className="block text-xs font-bold uppercase tracking-widest text-slate-400 mb-1.5">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
        />

        <div className="min-h-[1.5rem] my-3 text-sm" aria-live="polite">
          {error && <span className="text-rose-400">{error}</span>}
          {notice && <span className="text-emerald-400">{notice}</span>}
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white text-sm font-bold py-2.5 transition-colors"
        >
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin')
            setError(null)
            setNotice(null)
          }}
          disabled={busy}
          className="w-full mt-3 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
        </button>
      </form>
    </main>
  )
}
