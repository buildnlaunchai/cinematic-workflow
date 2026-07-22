import { redirect } from 'next/navigation'

import { APP_MODE } from '@/lib/mode'
import { Locked } from '@/components/Locked'

/**
 * The route middleware rewrites to when an embedded request has no usable token.
 * A rewrite (not a redirect) keeps the hub's iframe URL in place.
 */
export const dynamic = 'force-dynamic'
// Edge runtime (see app/page.tsx): the locked screen the embedded doorway lands
// on when there's no token — it must be as fast as possible to cold-start.
export const runtime = 'edge'

export default function LockedPage() {
  // Standalone has a real login and no concept of being locked out by a hub.
  if (APP_MODE === 'standalone') redirect('/login')
  return <Locked reason="missing" />
}
