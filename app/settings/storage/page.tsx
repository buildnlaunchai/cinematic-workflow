import { redirect } from 'next/navigation'

import { getRequestUser } from '@/lib/session'
import { getMyStorageStatus } from '@/lib/actions/storage'
import { StorageWizard } from '@/components/StorageWizard'
import { Locked } from '@/components/Locked'

/**
 * Per-user storage settings. Same identity gate as app/page.tsx — resolved by
 * getRequestUser() so a mutation can never run for a caller the page wouldn't show.
 */
export const dynamic = 'force-dynamic'

export default async function StorageSettingsPage() {
  const auth = await getRequestUser()
  if (!auth.ok) {
    if (auth.reason === 'unauthenticated') redirect('/login')
    return <Locked reason={auth.reason} />
  }

  const status = await getMyStorageStatus()
  return <StorageWizard initialStatus={status} />
}
