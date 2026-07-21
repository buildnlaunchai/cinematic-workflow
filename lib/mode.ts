/**
 * Which of the two run modes this deployment is in.
 *
 * Safe to import from client code: it reads only the NEXT_PUBLIC_ mode flag,
 * never a secret.
 */

export type AppMode = 'standalone' | 'embedded'

function resolveMode(): AppMode {
  const raw = process.env.NEXT_PUBLIC_APP_MODE

  // Unset means standalone. That is the documented default and the safe one: a
  // deployer who never heard of the hub gets a normal app with its own login.
  if (raw === undefined || raw === '') return 'standalone'

  if (raw === 'standalone' || raw === 'embedded') return raw

  // Anything else is a typo, and quietly treating it as standalone would be the
  // worst outcome: `embeded` inside the hub would make the app show its own login
  // instead of honouring the hub's access control. Fail loudly at boot.
  throw new Error(
    `NEXT_PUBLIC_APP_MODE must be "standalone" or "embedded" (got "${raw}").`,
  )
}

export const APP_MODE: AppMode = resolveMode()

export const IS_EMBEDDED = APP_MODE === 'embedded'
export const IS_STANDALONE = APP_MODE === 'standalone'
