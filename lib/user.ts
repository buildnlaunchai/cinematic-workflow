import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { createAdminClient } from './supabase/admin'
import type { HubClaims } from './hub/verify'
import type { User } from '@/types'

export type AppUser = User

/**
 * Create-or-lookup for the app's own profile row.
 *
 * Both modes land in cinematic_workflow.profiles. The difference is only which
 * identity column is filled and which client does the writing:
 *
 *   standalone  auth_user_id, resolved (and self-healed) by the
 *               current_user_profile() SECURITY DEFINER RPC — so the tight
 *               column grant on profiles never has to widen.
 *   embedded    hub_user_id, written by the service role AFTER the hub token's
 *               signature has been verified.
 *
 * An embedded user gets a real row in this app's own database, and this app never
 * reads a hub table.
 */

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505'

function toUser(p: {
  id: string
  full_name: string | null
  avatar_url: string | null
  email: string | null
}): AppUser {
  return {
    id: p.id,
    full_name: p.full_name ?? (p.email ? p.email.split('@')[0] : 'User'),
    avatar_url: p.avatar_url ?? null,
    email: p.email ?? null,
  }
}

/**
 * Standalone: resolve the signed-in user's profile via the definer RPC, which
 * self-heals a missing row. Runs under the caller's RLS-scoped client, so the DB
 * still enforces identity — and standalone deployments can leave the service role
 * key blank.
 */
export async function resolveStandaloneUser(supabase: SupabaseClient): Promise<AppUser> {
  const { data, error } = await supabase.rpc('current_user_profile')
  if (error) throw error
  if (!data) throw new Error('Could not resolve the current user profile.')
  return toUser(data as AppUser)
}

/**
 * Embedded: the hub user's local profile.
 *
 * PRECONDITION: `claims` must come from verifyHubToken(). Never pass unverified
 * claims — this writes under the service role and RLS will not save you.
 *
 * Not stored: claims.tools. Access is read from the token on every request, so
 * revoking a user in the hub takes effect on their next page load.
 */
export async function ensureEmbeddedUser(claims: HubClaims): Promise<AppUser> {
  const admin = createAdminClient()
  const fallbackName = claims.email.split('@')[0]
  const COLS = 'id, full_name, avatar_url, email'

  const existing = await admin
    .from('profiles')
    .select(COLS)
    .eq('hub_user_id', claims.sub)
    .maybeSingle()
  if (existing.error) throw existing.error

  if (existing.data) {
    // Keep the local email in step with the hub if the user changed it there.
    if (existing.data.email !== claims.email) {
      const updated = await admin
        .from('profiles')
        .update({ email: claims.email })
        .eq('hub_user_id', claims.sub)
        .select(COLS)
        .single()
      if (updated.error) throw updated.error
      return toUser(updated.data)
    }
    return toUser(existing.data)
  }

  const inserted = await admin
    .from('profiles')
    .insert({ hub_user_id: claims.sub, email: claims.email, full_name: fallbackName })
    .select(COLS)
    .single()
  if (!inserted.error) return toUser(inserted.data)

  // Two requests from the same brand-new user can race. The unique constraint on
  // hub_user_id makes it harmless: the loser reads the winner's row.
  if (inserted.error.code === UNIQUE_VIOLATION) {
    const raced = await admin
      .from('profiles')
      .select(COLS)
      .eq('hub_user_id', claims.sub)
      .single()
    if (raced.error) throw raced.error
    return toUser(raced.data)
  }

  throw inserted.error
}
