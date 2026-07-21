import { notFound } from 'next/navigation'

import { APP_MODE } from '@/lib/mode'
import { LoginForm } from '@/components/LoginForm'

/**
 * Standalone login.
 *
 * This route does not exist in embedded mode — not hidden, not redirected:
 * absent. The hub owns identity there, and an app that keeps a working login
 * behind an iframe is a way to route around the hub's access engine.
 */
export const dynamic = 'force-dynamic'

export default function LoginPage() {
  if (APP_MODE === 'embedded') notFound()
  return <LoginForm />
}
