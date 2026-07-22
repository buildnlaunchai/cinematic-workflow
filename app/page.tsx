import { redirect } from 'next/navigation'

import { getRequestUser } from '@/lib/session'
import { CinematicApp } from '@/components/CinematicApp'
import { Locked } from '@/components/Locked'

/**
 * The app surface. Identity is resolved by getRequestUser() — the single resolver
 * the server actions also use — so the page that renders and the mutations it
 * triggers can never disagree about who the caller is.
 *
 * Middleware has already gated this path. This resolves identity again rather than
 * trusting that: middleware is easy to accidentally narrow with a matcher change,
 * and this page (and everything it renders) reads and writes the database.
 */
export const dynamic = 'force-dynamic'
// Edge runtime: this entry path is Edge-clean (jose, supabase-js/ssr, the
// service-role admin client, next/headers cookies — all Web-API based). Edge
// cold-starts in tens of ms vs ~2s for Node, which is fix #2 of the embedded
// load profiling.
export const runtime = 'edge'

export default async function Page() {
  const auth = await getRequestUser()

  if (!auth.ok) {
    // Standalone with no session → the app's own login. Embedded → a locked
    // screen that reveals nothing about why (missing / invalid / not-granted).
    if (auth.reason === 'unauthenticated') redirect('/login')
    return <Locked reason={auth.reason} />
  }

  return <CinematicApp user={auth.user} />
}
