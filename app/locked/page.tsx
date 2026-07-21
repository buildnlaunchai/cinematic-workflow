import { redirect } from 'next/navigation'

import { APP_MODE } from '@/lib/mode'
import { Locked } from '@/components/Locked'

/**
 * The route middleware rewrites to when an embedded request has no usable token.
 * A rewrite (not a redirect) keeps the hub's iframe URL in place.
 */
export const dynamic = 'force-dynamic'

export default function LockedPage() {
  // Standalone has a real login and no concept of being locked out by a hub.
  if (APP_MODE === 'standalone') redirect('/login')
  return <Locked reason="missing" />
}
