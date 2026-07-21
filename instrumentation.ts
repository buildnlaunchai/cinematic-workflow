/**
 * Boot-time configuration check.
 *
 * `register()` runs once when the server starts, before it handles anything —
 * the only place assertServerConfig() can keep the promise in its own docstring:
 * fail at boot, not per-request. A dead guard is worse than no guard: its
 * existence reads as reassurance, so this file exists to actually call it.
 *
 * Node runtime only, via dynamic import: lib/env.server.ts pulls in `server-only`
 * and is written against Node's assumptions; register() also runs in the Edge
 * runtime, and importing it statically would drag that into the Edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { assertServerConfig, getHubPublicKey } = await import('./lib/env.server')
  const { APP_MODE } = await import('./lib/mode')

  // Presence: every var this mode needs is set at all.
  assertServerConfig()

  // Usability: HUB_PUBLIC_KEY is not just present but actually a parseable RS256
  // public key. A PEM mangled by a dashboard passes a presence check and then
  // fails on every single token at runtime — indistinguishable from "this user
  // has no access". Parsing it once here turns that into a boot error that names
  // itself. importSPKI is exactly what lib/hub/verify.ts calls per verification,
  // so if it parses here it parses there.
  if (APP_MODE === 'embedded') {
    const { importSPKI } = await import('jose')
    try {
      await importSPKI(getHubPublicKey(), 'RS256')
    } catch (err) {
      throw new Error(
        'HUB_PUBLIC_KEY is set but is not a valid RS256 public key, so every hub ' +
          'token would be rejected and every member would see locked state. ' +
          'Re-copy it from the hub operator — dashboards mangle multi-line values, ' +
          'so prefer the single-line \\n-escaped form. Parse error: ' +
          (err instanceof Error ? err.message : String(err)),
      )
    }
  }
}
