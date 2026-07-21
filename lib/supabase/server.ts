import 'server-only'

import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

type CookiesToSet = { name: string; value: string; options: CookieOptions }[]

import { getSupabaseAnonKey, getSupabaseUrl } from '../env.server'

/**
 * A Supabase client bound to the signed-in user's cookies. Standalone mode.
 *
 * Everything it does is constrained by Row Level Security. `schema:
 * 'cinematic_workflow'` on every client: the app owns exactly one schema and
 * never touches `public`. Requests 404 unless `cinematic_workflow` is listed
 * under Settings -> API -> Exposed schemas (README step 3).
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    db: { schema: 'cinematic_workflow' },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: CookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          )
        } catch {
          // Server Components cannot set cookies. The middleware refreshes the
          // session on every request, so this is safe to swallow — the documented
          // Supabase SSR pattern, not an ignored error.
        }
      },
    },
  })
}
