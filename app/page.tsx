import { redirect } from 'next/navigation'

import { getRequestUser } from '@/lib/session'
import { CinematicApp } from '@/components/CinematicApp'
import { CleanHubTokenUrl } from '@/components/CleanHubTokenUrl'
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
// Node runtime (default). Edge was tried and MEASURED WORSE for cold start here
// (~4s cold vs ~1.8s on Node): supabase-js + jose + the SSR'd component tree make
// the Edge isolate's cold compile heavy, and Edge also runs near the user rather
// than pinned to sin1 (losing the DB co-location from vercel.json). Kept on Node.

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ hub_token?: string | string[] }>
}) {
  // Embedded doorway: on the entry request (/?hub_token=…) middleware verified the
  // token and set the cookie, but that cookie is NOT readable within this same
  // request — so resolve identity from the query token instead. getRequestUser
  // re-verifies it (signature + aud + exp + claims) before any protected content
  // renders. Every later request has no query token and reads the cookie.
  const sp = await searchParams
  const doorwayToken = typeof sp.hub_token === 'string' ? sp.hub_token : undefined

  const auth = await getRequestUser(doorwayToken)

  if (!auth.ok) {
    // Standalone with no session → the app's own login. Embedded → a locked
    // screen that reveals nothing about why (missing / invalid / not-granted).
    if (auth.reason === 'unauthenticated') redirect('/login')
    return <Locked reason={auth.reason} />
  }

  // CleanHubTokenUrl strips ?hub_token from the URL client-side, AFTER this
  // server-verified content is rendered — cosmetic only, never a content gate.
  return (
    <>
      <CleanHubTokenUrl />
      <CinematicApp user={auth.user} />
    </>
  )
}
