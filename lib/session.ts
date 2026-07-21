import 'server-only'

import { cookies } from 'next/headers'

import { APP_MODE, type AppMode } from './mode'
import { HUB_TOKEN_COOKIE } from './hub/transport'
import { verifyHubToken, claimsAllowCinematic } from './hub/verify'
import { createClient } from './supabase/server'
import { ensureEmbeddedUser, resolveStandaloneUser, type AppUser } from './user'

/**
 * The one place identity is resolved for a request, for both modes. `app/page.tsx`
 * (the render) and the server actions (the mutations) both go through here, so a
 * write can never resolve identity differently from the page that showed it — and
 * an action can never run for a caller the page would have shown a locked screen.
 *
 *   embedded    the hub JWT (httpOnly cookie) is verified against HUB_PUBLIC_KEY,
 *               then ensureEmbeddedUser() upserts the local profile by hub_user_id.
 *               Identity is the token's signed `sub`, never the browser's word.
 *   standalone  the Supabase Auth session, resolved via the definer RPC.
 *
 * Never trust a client-supplied user id: callers get the resolved AppUser from
 * here and nothing else.
 */
export type RequestAuth =
  | { ok: true; mode: AppMode; user: AppUser }
  | { ok: false; mode: AppMode; reason: 'missing' | 'invalid' | 'not-granted' | 'unauthenticated' }

export async function getRequestUser(): Promise<RequestAuth> {
  if (APP_MODE === 'embedded') {
    const token = (await cookies()).get(HUB_TOKEN_COOKIE)?.value
    if (!token) return { ok: false, mode: 'embedded', reason: 'missing' }

    const result = await verifyHubToken(token)
    if (!result.ok) {
      console.warn(`[hub] rejection: ${result.reason}`)
      return { ok: false, mode: 'embedded', reason: 'invalid' }
    }
    if (!claimsAllowCinematic(result.claims)) {
      return { ok: false, mode: 'embedded', reason: 'not-granted' }
    }

    // Verified. Only now does anything touch the database.
    const user = await ensureEmbeddedUser(result.claims)
    return { ok: true, mode: 'embedded', user }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, mode: 'standalone', reason: 'unauthenticated' }

  const appUser = await resolveStandaloneUser(supabase)
  return { ok: true, mode: 'standalone', user: appUser }
}

/**
 * The server-action gate: resolve the caller or throw. A mutation must never run
 * for a caller we could not identify — RLS covers standalone, but embedded writes
 * go through the service role, where the only thing standing between one hub user
 * and another's data is this resolution being trustworthy.
 */
export async function requireRequestUser(): Promise<{ mode: AppMode; user: AppUser }> {
  const auth = await getRequestUser()
  if (!auth.ok) throw new Error(`Not authorized (${auth.reason}).`)
  return { mode: auth.mode, user: auth.user }
}
