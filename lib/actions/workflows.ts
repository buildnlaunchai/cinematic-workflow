'use server'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { AppMode } from '@/lib/mode'
import { requireRequestUser } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { CinematicWorkflow } from '@/types'

/**
 * The server-side write path for workflows.
 *
 * WHY THIS EXISTS: the workspace UI is a client component, and the browser
 * Supabase client only carries identity in STANDALONE mode (a real Supabase Auth
 * session). In EMBEDDED mode identity is a hub JWT, not a Supabase JWT, so
 * auth.uid() is null and every direct PostgREST call from the browser is rejected
 * by RLS (the 401 on POST /rest/v1/workflows). So the mutations move to the
 * server, behind requireRequestUser() — the same verified identity the page uses.
 *
 * The client per mode, and how ownership is enforced:
 *   embedded    service role (bypasses RLS) — so this code MUST scope every read
 *               and delete to created_by = the caller's own profile, because the
 *               database will not. Embedded is multi-tenant: many unrelated hub
 *               users share one schema, and created_by is the only thing keeping
 *               one out of another's rows.
 *   standalone  the RLS-bound server client. The schema's model is "any
 *               authenticated user is a manager" (shared workspace), so reads are
 *               NOT narrowed — RLS already says what's allowed, and narrowing here
 *               would silently change the product's behaviour.
 *
 * created_by is ALWAYS the server-resolved profile id, never a value from the
 * client — a caller cannot forge ownership.
 */

async function workflowsDb(mode: AppMode): Promise<SupabaseClient> {
  const client = mode === 'embedded' ? createAdminClient() : await createClient()
  return client as unknown as SupabaseClient
}

export async function listWorkflows(): Promise<CinematicWorkflow[]> {
  const { mode, user } = await requireRequestUser()
  const db = await workflowsDb(mode)

  let query = db.from('workflows').select('*').order('created_at', { ascending: false })
  // Embedded: the service role sees every tenant's rows, so isolate to this hub
  // user's own. Standalone: leave the shared-workspace model untouched.
  if (mode === 'embedded') query = query.eq('created_by', user.id)

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as CinematicWorkflow[]
}

export async function createWorkflow(title: string): Promise<CinematicWorkflow> {
  const clean = title.trim()
  if (!clean) throw new Error('A workflow title is required.')

  const { mode, user } = await requireRequestUser()
  const db = await workflowsDb(mode)

  const { data, error } = await db
    .from('workflows')
    .insert({ title: clean, created_by: user.id })
    .select()
    .single()
  if (error) throw error
  return data as CinematicWorkflow
}

export async function deleteWorkflow(id: string): Promise<void> {
  const { mode, user } = await requireRequestUser()
  const db = await workflowsDb(mode)

  let query = db.from('workflows').delete().eq('id', id)
  // Embedded: never let one hub user delete another's workflow. Standalone keeps
  // its shared-manager model (RLS permits any authenticated user).
  if (mode === 'embedded') query = query.eq('created_by', user.id)

  const { error } = await query
  if (error) throw error
}
