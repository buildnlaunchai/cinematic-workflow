import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { getServiceRoleKey, getSupabaseUrl } from '../env.server'

/**
 * A Supabase client using the service role key. BYPASSES ROW LEVEL SECURITY.
 *
 * Why it must exist: a hub-signed token is not a Supabase JWT, so `auth.uid()` is
 * null for an embedded user and no RLS policy can ever match them. Something has
 * to write their profile row, and that something is this client.
 *
 * Why that is still safe: the gate moved, it did not vanish. verifyHubToken()
 * checks the RS256 signature against the hub's public key BEFORE this client is
 * ever constructed. The database trusts the app; the app trusts the hub's
 * signature; nothing trusts the browser.
 *
 * Rules for touching this file:
 *   - Never import it from a client component (the `server-only` import turns that
 *     into a build error, and preflight.sh greps for it too).
 *   - Never call it before verifying a token.
 *   - Never widen it beyond the single profile row it needs to write.
 */
export function createAdminClient() {
  return createSupabaseClient(getSupabaseUrl(), getServiceRoleKey(), {
    db: { schema: 'cinematic_workflow' },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
