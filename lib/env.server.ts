import 'server-only'

/**
 * Server-only configuration.
 *
 * The `server-only` import is a build-time tripwire: if any client component ever
 * imports this file, the build fails with an explicit error rather than quietly
 * shipping the service role key to the browser. preflight.sh checks the same
 * mistake by grep; this catches it in the compiler. Two independent guards,
 * because one leak of this key exposes the whole database.
 *
 * (R2 credentials are NOT here — they are Supabase Edge Function secrets, read via
 * Deno.env inside the functions, never by the Next.js app.)
 */

import { APP_MODE } from './mode'

/** Public Supabase config. Required in both modes. */
export function getSupabaseUrl(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!v) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set. See .env.example.')
  return v
}

export function getSupabaseAnonKey(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!v) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. See .env.example.')
  return v
}

/**
 * The service role key. Bypasses Row Level Security entirely.
 *
 * Only embedded mode needs it, and only to create the local profile row after a
 * hub token has already been verified. Standalone deployments leave it blank and
 * do every write as the logged-in user under RLS.
 */
export function getServiceRoleKey(): string {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!v) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set, but embedded mode needs it to create ' +
        'the local profile row for a hub user. Get it from Supabase: ' +
        'Settings -> API -> service_role. See .env.example.',
    )
  }
  return v
}

/**
 * The hub's PUBLIC key, PEM-encoded, used to verify token signatures. Not a
 * secret — a public key can only verify, never sign. Server-side because
 * verification happens on the server. Both the raw multi-line PEM and the
 * \n-escaped one-liner dashboards produce are accepted.
 */
export function getHubPublicKey(): string {
  const v = process.env.HUB_PUBLIC_KEY
  if (!v) {
    throw new Error(
      'HUB_PUBLIC_KEY is not set, but NEXT_PUBLIC_APP_MODE=embedded requires it ' +
        'to verify tokens from the hub. The hub operator provides this value.',
    )
  }
  return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v
}

/**
 * Fail at boot rather than per-request. Called from instrumentation.ts. Checks
 * that vars are PRESENT; instrumentation.ts additionally parses HUB_PUBLIC_KEY.
 * HUB_ORIGIN is enforced earlier and harder, at BUILD time in next.config.mjs.
 */
export function assertServerConfig(): void {
  getSupabaseUrl()
  getSupabaseAnonKey()
  if (APP_MODE === 'embedded') {
    getHubPublicKey()
    getServiceRoleKey()
  }
}
