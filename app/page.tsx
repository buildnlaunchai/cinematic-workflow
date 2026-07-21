import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { APP_MODE } from '@/lib/mode'
import { verifyHubToken, claimsAllowCinematic } from '@/lib/hub/verify'
import { HUB_TOKEN_COOKIE } from '@/lib/hub/transport'
import { createClient } from '@/lib/supabase/server'
import { ensureEmbeddedUser, resolveStandaloneUser } from '@/lib/user'
import { CinematicApp } from '@/components/CinematicApp'
import { Locked } from '@/components/Locked'

/**
 * The app surface. Identity is resolved here, per mode, and the local profile row
 * is created or looked up before the tool renders.
 *
 * Middleware has already gated this path. This resolves identity again rather
 * than trusting that: middleware is easy to accidentally narrow with a matcher
 * change, and this page reads/writes the database.
 */
export const dynamic = 'force-dynamic'

export default async function Page() {
  if (APP_MODE === 'embedded') return renderEmbedded()
  return renderStandalone()
}

async function renderEmbedded() {
  const cookieStore = await cookies()
  const token = cookieStore.get(HUB_TOKEN_COOKIE)?.value

  if (!token) return <Locked reason="missing" />

  const result = await verifyHubToken(token)
  if (!result.ok) {
    console.warn(`[hub] page-level rejection: ${result.reason}`)
    return <Locked reason="invalid" />
  }
  if (!claimsAllowCinematic(result.claims)) return <Locked reason="not-granted" />

  // Verified. Only now does anything touch the database.
  const user = await ensureEmbeddedUser(result.claims)
  return <CinematicApp user={user} />
}

async function renderStandalone() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const appUser = await resolveStandaloneUser(supabase)
  return <CinematicApp user={appUser} />
}
