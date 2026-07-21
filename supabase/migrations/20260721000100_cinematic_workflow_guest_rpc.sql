-- Cinematic Workflow — the guest-read RPC (public /share/<token> path).
--
-- This function is the ONE and ONLY way an anonymous visitor reads any data in
-- this app. anon has no SELECT grant and no RLS policy on a single table, so
-- every REST call anon could make against workflows / nodes / comments /
-- share_links / profiles returns permission-denied. The only anon surface is
-- `rpc/get_shared_workflow`.
--
-- Why an RPC instead of anon RLS policies (the ERP's approach):
--   The two guest bugs recovered from the live ERP were both failure modes that
--   direct-table anon RLS invites — a self-referential workflow policy (guests
--   could read nothing) and an enumerable share_links table (guests could list
--   every active token system-wide, then read every shared workflow). A
--   SECURITY DEFINER function removes the entire attack surface: there are no
--   anon-facing table policies to get subtly wrong, and nothing to enumerate.
--   The function takes an unguessable token, validates it, and hands back a
--   fixed, minimal projection — nothing more.
--
-- Exactly what it RETURNS (jsonb), given a valid + active token:
--   workflow : { id, title, description, created_at }
--   nodes[]  : { id, video_url, created_at }
--   comments[]: { id, node_id, parent_id, content, timestamp_seconds,
--                 end_seconds, annotation, attachment_url, created_at,
--                 author_name, author_avatar }
--
-- What it deliberately WITHHOLDS:
--   * The share_links table itself — no token is ever returned, so nothing is
--     enumerable. Guessing a token means guessing a 122-bit random uuid.
--   * workflow.created_by and comment.user_id — these are internal profiles ids;
--     guests get a display name + avatar for comment authors and nothing that
--     identifies the underlying account.
--   * The profiles table at large — no email, no auth_user_id/hub_user_id, no
--     other users. Only the name + avatar of authors who commented on THIS
--     workflow are surfaced, via the join, and only those two columns.
--   * Every other workflow's data — the projection is scoped to the single
--     workflow behind the validated token.
--   * Write access of any kind — the guest view is strictly read-only (there is
--     no companion mutation RPC; anon has no insert/update/delete anywhere).
--
-- A revoked (is_active=false) or unknown token returns NULL — the viewer renders
-- an "invalid / expired link" state. Revocation is therefore immediate: flip
-- is_active and the next call returns nothing.

create or replace function cinematic_workflow.get_shared_workflow(share_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_resource uuid;
  v_result   jsonb;
begin
  -- Validate the token. This is the only read of share_links on the anon path,
  -- and it is a primary-key lookup filtered to active links — no listing.
  select sl.resource_id
    into v_resource
  from cinematic_workflow.share_links sl
  where sl.id = share_token
    and sl.is_active
  limit 1;

  if v_resource is null then
    return null;  -- unknown or revoked token
  end if;

  select jsonb_build_object(
    'workflow', (
      select jsonb_build_object(
               'id', w.id,
               'title', w.title,
               'description', w.description,
               'created_at', w.created_at
             )
      from cinematic_workflow.workflows w
      where w.id = v_resource
    ),
    'nodes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', n.id,
                 'video_url', n.video_url,
                 'created_at', n.created_at
               ) order by n.created_at
             )
      from cinematic_workflow.nodes n
      where n.workflow_id = v_resource
    ), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', c.id,
                 'node_id', c.node_id,
                 'parent_id', c.parent_id,
                 'content', c.content,
                 'timestamp_seconds', c.timestamp_seconds,
                 'end_seconds', c.end_seconds,
                 'annotation', c.annotation,
                 'attachment_url', c.attachment_url,
                 'created_at', c.created_at,
                 'author_name', p.full_name,
                 'author_avatar', p.avatar_url
               ) order by c.timestamp_seconds
             )
      from cinematic_workflow.nodes n
      join cinematic_workflow.comments c on c.node_id = n.id
      left join cinematic_workflow.profiles p on p.id = c.user_id
      where n.workflow_id = v_resource
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

-- Lock execution down to the two API roles only; nothing runs it implicitly.
revoke all on function cinematic_workflow.get_shared_workflow(uuid) from public;
grant execute on function cinematic_workflow.get_shared_workflow(uuid) to anon, authenticated;
