-- Cinematic Workflow — initial schema.
--
-- A Frame.io-style video-review tool: workflows hold video "nodes" (versions);
-- reviewers leave timecoded / range / spatially-pinned comments with threaded
-- replies and attachments; managers mint public read-only guest-share links.
--
-- Everything this app owns lives in the `cinematic_workflow` schema. Nothing in
-- `public`, nothing shared. A fresh Supabase project + `supabase db push` = a
-- working backend, whether that project already hosts other apps in their own
-- schemas or is a brand-new empty one. Same file, no edits. (TEMPLATE.md law #2.)
--
-- Extraction notes (what changed vs. the Caparison ERP original):
--   * AI-QC is gone — the ERP's qc_status/qc_progress/qc_message/qc_logs columns
--     (and the trigger-ai-qc pipeline) were decorative/mis-wired and are cut.
--   * Access model is "any authenticated user is a manager": no has_cinematic_access
--     ACL, no role subset. The ERP's DB RLS was already `auth.role()='authenticated'`
--     for all ops (the manager gate lived only in the frontend), so this is a clean
--     re-statement, not a loosening.
--   * The public /share path is served ONLY by a SECURITY DEFINER RPC
--     (get_shared_workflow) in the second migration — anon gets ZERO direct table
--     SELECT. This structurally forecloses the two live-ERP guest bugs recovered
--     from the dashboard: a self-referential anon workflow policy, and an
--     enumerable share-links table.
--   * `share_links.type` (cinematic_workflow | video_review) is dropped — this is a
--     single-product app now.

create schema if not exists cinematic_workflow;

grant usage on schema cinematic_workflow to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- updated_at trigger function (app-owned, travels with the schema)
-- ---------------------------------------------------------------------------
create or replace function cinematic_workflow.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===========================================================================
-- cinematic_workflow.profiles — the app's own identity + display table
-- ===========================================================================
-- One row per person, in either run mode (mirrors the animator's users table,
-- plus the display fields the review UI embeds on every comment):
--
--   standalone  auth_user_id set, hub_user_id null. Identity from this project's
--               own Supabase Auth; the row is seeded by handle_new_user() below.
--
--   embedded    hub_user_id set, auth_user_id null. Identity from a hub-signed JWT
--               the app verifies server-side with HUB_PUBLIC_KEY, then creates-or-
--               looks-up this row under the service role. No auth.users row, no hub
--               table ever read.
--
-- Deliberately minimal: full_name + avatar_url are all the comment-author embed
-- needs. No role, no department, no has_*_access — that ERP baggage is gone with
-- the ACL model. email is display/support convenience only, never an identity key.

create table if not exists cinematic_workflow.profiles (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete cascade,
  hub_user_id   text unique,
  email         text,
  full_name     text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_exactly_one_identity
    check (num_nonnulls(auth_user_id, hub_user_id) = 1)
);

drop trigger if exists profiles_set_updated_at on cinematic_workflow.profiles;
create trigger profiles_set_updated_at
  before update on cinematic_workflow.profiles
  for each row execute function cinematic_workflow.set_updated_at();

-- Seed a profile row for every new standalone signup, so the PostgREST embed
-- `comments -> profiles(full_name, avatar_url)` resolves for their comments.
-- Embedded users are seeded server-side (service role) by hub_user_id instead,
-- so this trigger only ever fires for this project's own Auth signups.
create or replace function cinematic_workflow.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into cinematic_workflow.profiles (auth_user_id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(coalesce(new.email, 'user'), '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (auth_user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function cinematic_workflow.handle_new_user();

-- Map the current standalone caller (auth.uid()) to their app profile id.
-- SECURITY DEFINER so RLS policies can call it without granting `authenticated`
-- read access to the identity columns (auth_user_id) — the column grant on
-- profiles stays limited to id/full_name/avatar_url. Returns null in embedded
-- mode (no Supabase session), where writes go through the service role anyway.
create or replace function cinematic_workflow.current_profile_id()
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select p.id
  from cinematic_workflow.profiles p
  where p.auth_user_id = (select auth.uid())
$$;
revoke all on function cinematic_workflow.current_profile_id() from public;
grant execute on function cinematic_workflow.current_profile_id() to authenticated;

-- Resolve the FULL current-user profile for the app (standalone). SECURITY
-- DEFINER so it can read the identity columns + self-heal a missing row without
-- widening the tight authenticated column grant on profiles (which exposes only
-- id/full_name/avatar_url). The handle_new_user trigger normally seeds the row at
-- signup; the insert here covers pre-existing auth users or a project where the
-- trigger wasn't applied. Returns null in embedded mode (no auth.uid()), where
-- identity is resolved server-side under the service role instead.
create or replace function cinematic_workflow.current_user_profile()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_profile jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  insert into cinematic_workflow.profiles (auth_user_id, email, full_name, avatar_url)
  select u.id, u.email,
         coalesce(
           u.raw_user_meta_data ->> 'full_name',
           u.raw_user_meta_data ->> 'name',
           split_part(coalesce(u.email, 'user'), '@', 1)
         ),
         u.raw_user_meta_data ->> 'avatar_url'
  from auth.users u
  where u.id = v_uid
  on conflict (auth_user_id) do nothing;

  select jsonb_build_object(
           'id', p.id,
           'full_name', p.full_name,
           'avatar_url', p.avatar_url,
           'email', p.email
         )
    into v_profile
  from cinematic_workflow.profiles p
  where p.auth_user_id = v_uid;

  return v_profile;
end;
$$;
revoke all on function cinematic_workflow.current_user_profile() from public;
grant execute on function cinematic_workflow.current_user_profile() to authenticated;

-- ===========================================================================
-- cinematic_workflow.workflows
-- ===========================================================================
create table if not exists cinematic_workflow.workflows (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  -- set null (not cascade): deleting a person must not destroy shared review
  -- content. The workflow survives, merely losing creator attribution.
  created_by  uuid references cinematic_workflow.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ===========================================================================
-- cinematic_workflow.nodes — one video version under a workflow
-- ===========================================================================
create table if not exists cinematic_workflow.nodes (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references cinematic_workflow.workflows (id) on delete cascade,
  video_url   text not null,
  created_at  timestamptz not null default now()
);
create index if not exists nodes_workflow_id_idx
  on cinematic_workflow.nodes (workflow_id);

-- ===========================================================================
-- cinematic_workflow.comments — timecoded / range / spatial, with threading
-- ===========================================================================
create table if not exists cinematic_workflow.comments (
  id                uuid primary key default gen_random_uuid(),
  node_id           uuid not null references cinematic_workflow.nodes (id) on delete cascade,
  user_id           uuid references cinematic_workflow.profiles (id) on delete set null,
  parent_id         uuid references cinematic_workflow.comments (id) on delete cascade,
  content           text not null,
  timestamp_seconds double precision not null,       -- point in the video (was `real` in ERP; unified)
  end_seconds       double precision,                -- null = point comment; set = range [ts, end]
  annotation        jsonb,                           -- {x, y, rect?} spatial pin; null = timeline-only
  attachment_url    text,                            -- single R2 URL; null = none
  created_at        timestamptz not null default now()
);
create index if not exists comments_node_id_idx
  on cinematic_workflow.comments (node_id);
create index if not exists comments_parent_id_idx
  on cinematic_workflow.comments (parent_id);

-- ===========================================================================
-- cinematic_workflow.share_links — a public guest-view token per workflow
-- ===========================================================================
-- The row `id` IS the token that appears in /share/<id>. It is never exposed to
-- anyone but its creator: anon cannot SELECT this table at all (no grant, no
-- policy) — the only path that reads it is the SECURITY DEFINER RPC in the next
-- migration. That is what kills the ERP's enumeration leak.
create table if not exists cinematic_workflow.share_links (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references cinematic_workflow.workflows (id) on delete cascade,
  created_by  uuid references cinematic_workflow.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  is_active   boolean not null default true
);
-- At most one active link per workflow per creator (matches the ERP's intent,
-- minus the dropped `type` column).
create unique index if not exists share_links_one_active_per_workflow_per_creator
  on cinematic_workflow.share_links (resource_id, created_by)
  where is_active;

-- ===========================================================================
-- Row Level Security & grants
-- ===========================================================================
-- Standalone traffic arrives as `authenticated`. The model is "any authenticated
-- user is a manager": full read + create across the shared workspace. Embedded
-- traffic (hub JWT, not a Supabase JWT, so auth.uid() is null) runs server-side
-- under the service role — which bypasses RLS — but ONLY after the app has
-- verified the token against HUB_PUBLIC_KEY. The service role key is server-only.
--
-- anon gets NO table grants and NO policies here. Guests reach data exclusively
-- through cinematic_workflow.get_shared_workflow() (next migration).

-- ---- profiles ----
alter table cinematic_workflow.profiles enable row level security;
-- Column-scoped grant: authenticated users can read only id/full_name/avatar_url
-- of any profile (what the comment-author embed needs) — never email, never the
-- identity keys. Writes happen via the seed trigger (definer) or service role.
grant select (id, full_name, avatar_url) on cinematic_workflow.profiles to authenticated;
grant all on cinematic_workflow.profiles to service_role;
drop policy if exists profiles_select_all on cinematic_workflow.profiles;
create policy profiles_select_all
  on cinematic_workflow.profiles for select
  to authenticated
  using (true);

-- ---- workflows ----  any authenticated user: full CRUD
alter table cinematic_workflow.workflows enable row level security;
grant select, insert, update, delete on cinematic_workflow.workflows to authenticated;
grant all on cinematic_workflow.workflows to service_role;
drop policy if exists workflows_all_authenticated on cinematic_workflow.workflows;
create policy workflows_all_authenticated
  on cinematic_workflow.workflows for all
  to authenticated
  using (true) with check (true);

-- ---- nodes ----  any authenticated user: full CRUD
alter table cinematic_workflow.nodes enable row level security;
grant select, insert, update, delete on cinematic_workflow.nodes to authenticated;
grant all on cinematic_workflow.nodes to service_role;
drop policy if exists nodes_all_authenticated on cinematic_workflow.nodes;
create policy nodes_all_authenticated
  on cinematic_workflow.nodes for all
  to authenticated
  using (true) with check (true);

-- ---- comments ----
-- Read/post/delete are open to any authenticated user (the "everyone's a manager"
-- model — the ERP gated the delete button on manager, which is now everyone).
-- The ONE hardening beyond the ERP's DB posture: EDIT is restricted to the
-- comment's author, moving the ERP's UI-only "edit your own" promise into the DB
-- so it can't be bypassed via the API. Flip comments_update_own to using(true) if
-- you want pure ERP parity.
alter table cinematic_workflow.comments enable row level security;
grant select, insert, update, delete on cinematic_workflow.comments to authenticated;
grant all on cinematic_workflow.comments to service_role;
drop policy if exists comments_select_all on cinematic_workflow.comments;
drop policy if exists comments_insert_any on cinematic_workflow.comments;
drop policy if exists comments_delete_any on cinematic_workflow.comments;
drop policy if exists comments_update_own on cinematic_workflow.comments;
create policy comments_select_all
  on cinematic_workflow.comments for select
  to authenticated using (true);
create policy comments_insert_any
  on cinematic_workflow.comments for insert
  to authenticated with check (true);
create policy comments_delete_any
  on cinematic_workflow.comments for delete
  to authenticated using (true);
create policy comments_update_own
  on cinematic_workflow.comments for update
  to authenticated
  using (user_id = cinematic_workflow.current_profile_id())
  with check (user_id = cinematic_workflow.current_profile_id());

-- ---- share_links ----
-- Authenticated users manage their OWN links (create / see own / revoke). No
-- blanket read: this is deliberately tighter than the workflow tables because the
-- id is a bearer token. anon is absent entirely.
alter table cinematic_workflow.share_links enable row level security;
grant select, insert, update on cinematic_workflow.share_links to authenticated;
grant all on cinematic_workflow.share_links to service_role;
drop policy if exists share_links_select_own on cinematic_workflow.share_links;
drop policy if exists share_links_insert_own on cinematic_workflow.share_links;
drop policy if exists share_links_update_own on cinematic_workflow.share_links;
create policy share_links_select_own
  on cinematic_workflow.share_links for select
  to authenticated
  using (created_by = cinematic_workflow.current_profile_id());
create policy share_links_insert_own
  on cinematic_workflow.share_links for insert
  to authenticated
  with check (created_by = cinematic_workflow.current_profile_id());
create policy share_links_update_own
  on cinematic_workflow.share_links for update
  to authenticated
  using (created_by = cinematic_workflow.current_profile_id());

-- ===========================================================================
-- Realtime — comments only
-- ===========================================================================
-- The review workspace subscribes to INSERTs on comments (a new comment lands →
-- re-fetch the active node's thread). The ERP also subscribed to UPDATEs on nodes
-- purely to drive AI-QC progress; with AI-QC cut, nodes need no realtime.
-- Wrapped so the migration is re-runnable and no-ops on a non-Supabase Postgres
-- that has no supabase_realtime publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'cinematic_workflow'
         and tablename = 'comments'
     )
  then
    alter publication supabase_realtime add table cinematic_workflow.comments;
  end if;
end;
$$;
