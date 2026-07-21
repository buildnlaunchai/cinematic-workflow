import { Lock } from 'lucide-react'

export type LockedReason = 'missing' | 'invalid' | 'not-granted'

/**
 * The locked state — embedded mode only.
 *
 * What the app shows instead of its own login when the hub's token is absent,
 * expired, tampered with, or does not grant this tool. The copy tells the user
 * what to DO, never why verification failed — the real reason goes to the server
 * log, not to a potential attacker refining a forgery.
 */
export function Locked({ reason }: { reason: LockedReason }) {
  const message =
    reason === 'not-granted'
      ? "Your account doesn't have access to Cinematic Workflow yet."
      : reason === 'invalid'
        ? 'Your session has expired or is no longer valid.'
        : 'This tool needs to be opened from your dashboard.'

  const action =
    reason === 'not-granted'
      ? 'Ask your administrator to enable it for you.'
      : 'Head back to your dashboard and open Cinematic Workflow from there.'

  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-slate-950">
      <div className="w-full max-w-sm text-center rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800 text-slate-300" aria-hidden="true">
          <Lock size={22} />
        </div>
        <h1 className="font-jakarta text-lg font-extrabold text-slate-100">Locked</h1>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
        <p className="mt-1 text-sm text-slate-500">{action}</p>
      </div>
    </main>
  )
}
