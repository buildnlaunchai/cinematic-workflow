import { ShareViewer } from '@/components/ShareViewer'

/**
 * Public guest-share viewer — no auth, in either run mode (see middleware:
 * `/share/*` is not a protected path). All reads go through the SECURITY DEFINER
 * RPC `get_shared_workflow`, which returns only a fixed, read-only projection for
 * the one workflow behind the token.
 */
export const dynamic = 'force-dynamic'

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <ShareViewer token={token} />
}
