'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * The browser-side Supabase client. Standalone mode only — it is what the login
 * form and the review workspace talk to.
 *
 * Only NEXT_PUBLIC_ values appear here, and that is deliberate: the anon key is
 * designed to be public and is powerless on its own, because Row Level Security
 * decides what it may read. The service role key must never appear in this file
 * or anything it imports.
 *
 * db.schema is pinned to `cinematic_workflow` so every `.from('workflows')`,
 * `.from('comments')`, `.rpc('get_shared_workflow', ...)` etc. resolves against
 * the app's own schema. The schema must ALSO be listed in the project's
 * Settings -> API -> Exposed schemas (see supabase/config.toml).
 *
 * Embedded mode has no browser client. Its identity comes from a token the hub
 * sends, verified on the server, so there is nothing for the browser to hold.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Copy .env.example to .env.local and fill in ' +
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    )
  }

  return createBrowserClient(url, anonKey, {
    db: { schema: 'cinematic_workflow' },
  })
}
