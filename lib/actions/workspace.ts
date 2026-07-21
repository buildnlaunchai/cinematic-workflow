'use server'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { AppMode } from '@/lib/mode'
import { requireRequestUser } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { AppUser } from '@/lib/user'
import type { CinematicComment, CinematicNode, CinematicWorkflow } from '@/types'

/**
 * The server-side data path for the workspace (opening a workflow, its video
 * nodes, comments/replies, and share links). Same discipline as
 * lib/actions/workflows.ts: identity is resolved server-side by
 * requireRequestUser(), never trusted from the client, and created_by / user_id
 * are always the server-resolved profile id.
 *
 * WHY: the workspace is a client component that used the browser Supabase client
 * for everything. That client only carries identity in STANDALONE mode. In
 * EMBEDDED mode identity is a hub JWT (auth.uid() is null), so every direct
 * browser call is rejected by RLS. These actions move the reads and writes to the
 * server behind the verified hub identity.
 *
 * OWNERSHIP, per mode:
 *   embedded    service role (bypasses RLS) → this code MUST enforce the tenant
 *               boundary itself: a hub user may only touch nodes/comments/share
 *               links hanging off a workflow THEY created (workflows.created_by).
 *               That is the multi-tenant isolation RLS gives standalone for free.
 *   standalone  the RLS-bound server client. The schema's model is "any
 *               authenticated user is a manager" (shared workspace): reads are not
 *               narrowed, comment edits are own-only and deletes are any (RLS
 *               enforces both). Left exactly as designed.
 */

const COMMENT_COLS = '*, profiles(full_name, avatar_url)'

async function db(mode: AppMode): Promise<SupabaseClient> {
  const client = mode === 'embedded' ? createAdminClient() : await createClient()
  return client as unknown as SupabaseClient
}

// ---- ownership guards (embedded only; standalone leans on RLS) --------------
// Each throws a neutral "not found" rather than "forbidden", so a probing caller
// cannot tell a row they don't own from one that doesn't exist.

async function assertOwnsWorkflow(client: SupabaseClient, user: AppUser, workflowId: string) {
  const { data } = await client
    .from('workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('created_by', user.id)
    .maybeSingle()
  if (!data) throw new Error('Workflow not found.')
}

/** Returns the node's workflow_id after proving the caller owns that workflow. */
async function assertOwnsNode(client: SupabaseClient, user: AppUser, nodeId: string): Promise<string> {
  const { data } = await client
    .from('nodes')
    .select('workflow_id, workflows(created_by)')
    .eq('id', nodeId)
    .maybeSingle()
  const createdBy = (data as { workflows?: { created_by?: string } } | null)?.workflows?.created_by
  if (!data || createdBy !== user.id) throw new Error('Node not found.')
  return (data as { workflow_id: string }).workflow_id
}

/** Returns the comment's author id after proving the caller owns its workflow. */
async function assertOwnsComment(client: SupabaseClient, user: AppUser, commentId: string): Promise<string | null> {
  const { data } = await client
    .from('comments')
    .select('user_id, nodes(workflows(created_by))')
    .eq('id', commentId)
    .maybeSingle()
  const createdBy = (data as { nodes?: { workflows?: { created_by?: string } } } | null)?.nodes?.workflows?.created_by
  if (!data || createdBy !== user.id) throw new Error('Comment not found.')
  return (data as { user_id: string | null }).user_id
}

// ---- workflow ---------------------------------------------------------------

export async function getWorkflow(id: string): Promise<CinematicWorkflow> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  let q = client.from('workflows').select('*').eq('id', id)
  if (mode === 'embedded') q = q.eq('created_by', user.id)
  const { data, error } = await q.maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Workflow not found.')
  return data as CinematicWorkflow
}

// ---- nodes (video versions) -------------------------------------------------

export async function listNodes(workflowId: string): Promise<CinematicNode[]> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsWorkflow(client, user, workflowId)
  const { data, error } = await client
    .from('nodes')
    .select('*')
    .eq('workflow_id', workflowId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as CinematicNode[]
}

export async function createNode(workflowId: string, videoUrl: string): Promise<CinematicNode> {
  const url = videoUrl.trim()
  if (!url) throw new Error('A video URL is required.')
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsWorkflow(client, user, workflowId)
  const { data, error } = await client
    .from('nodes')
    .insert({ workflow_id: workflowId, video_url: url })
    .select('*')
    .single()
  if (error) throw error
  return data as CinematicNode
}

export async function deleteNode(nodeId: string): Promise<void> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsNode(client, user, nodeId)
  const { error } = await client.from('nodes').delete().eq('id', nodeId)
  if (error) throw error
}

// ---- comments (+ replies, edit, delete) -------------------------------------

export type CommentInput = {
  node_id: string
  content: string
  timestamp_seconds: number
  end_seconds?: number | null
  annotation?: CinematicComment['annotation']
  attachment_url?: string | null
  parent_id?: string | null
}

export async function listComments(nodeId: string): Promise<CinematicComment[]> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsNode(client, user, nodeId)
  const { data, error } = await client
    .from('comments')
    .select(COMMENT_COLS)
    .eq('node_id', nodeId)
    .order('timestamp_seconds', { ascending: true })
  if (error) throw error
  return (data ?? []) as CinematicComment[]
}

export async function createComment(input: CommentInput): Promise<CinematicComment> {
  const content = (input.content ?? '').trim()
  if (!content && !input.attachment_url) throw new Error('A comment needs text or an attachment.')
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsNode(client, user, input.node_id)

  // user_id is the server-resolved profile — never the client's word.
  const { data, error } = await client
    .from('comments')
    .insert({
      node_id: input.node_id,
      user_id: user.id,
      parent_id: input.parent_id ?? null,
      content,
      timestamp_seconds: input.timestamp_seconds,
      end_seconds: input.end_seconds ?? null,
      annotation: input.annotation ?? null,
      attachment_url: input.attachment_url ?? null,
    })
    .select(COMMENT_COLS)
    .single()
  if (error) throw error
  return data as CinematicComment
}

/** Edit is own-only in both modes (the DB's one hardening beyond "manager"). */
export async function updateComment(
  id: string,
  patch: { content?: string; attachment_url?: string | null; annotation?: CinematicComment['annotation'] },
): Promise<CinematicComment> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)

  const clean: Record<string, unknown> = {}
  if (patch.content !== undefined) clean.content = patch.content
  if (patch.attachment_url !== undefined) clean.attachment_url = patch.attachment_url
  if (patch.annotation !== undefined) clean.annotation = patch.annotation

  if (mode === 'embedded') {
    const authorId = await assertOwnsComment(client, user, id)
    if (authorId !== user.id) throw new Error('You can only edit your own comment.')
  }

  // Standalone: RLS (comments_update_own) enforces author-only; the extra
  // user_id filter makes the intent explicit and harmless under RLS.
  const { data, error } = await client
    .from('comments')
    .update(clean)
    .eq('id', id)
    .eq('user_id', user.id)
    .select(COMMENT_COLS)
    .single()
  if (error) throw error
  return data as CinematicComment
}

/** Delete is any (within the tenant): a manager can remove any comment. */
export async function deleteComment(id: string): Promise<void> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsComment(client, user, id)
  const { error } = await client.from('comments').delete().eq('id', id)
  if (error) throw error
}

// ---- share links ------------------------------------------------------------

export async function getActiveShareLink(workflowId: string): Promise<{ id: string } | null> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsWorkflow(client, user, workflowId)
  let q = client
    .from('share_links')
    .select('id')
    .eq('resource_id', workflowId)
    .eq('is_active', true)
  if (mode === 'embedded') q = q.eq('created_by', user.id)
  const { data, error } = await q.maybeSingle()
  if (error) throw error
  return (data as { id: string } | null) ?? null
}

export async function createShareLink(workflowId: string): Promise<{ id: string }> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  if (mode === 'embedded') await assertOwnsWorkflow(client, user, workflowId)
  const { data, error } = await client
    .from('share_links')
    .insert({ resource_id: workflowId, created_by: user.id })
    .select('id')
    .single()
  if (error) throw error
  return data as { id: string }
}

export async function revokeShareLink(id: string): Promise<void> {
  const { mode, user } = await requireRequestUser()
  const client = await db(mode)
  // created_by scoping in both modes: a share link is a bearer token, so even the
  // shared-manager model keeps revoke to the link's owner (RLS: share_links_*_own).
  const { error } = await client
    .from('share_links')
    .update({ is_active: false })
    .eq('id', id)
    .eq('created_by', user.id)
  if (error) throw error
}
