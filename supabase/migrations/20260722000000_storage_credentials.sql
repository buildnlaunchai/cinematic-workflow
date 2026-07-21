-- ============================================================================
-- Per-user BYOK R2 storage — the credential vault.
--
-- Mirrors the Build & Launch hub's user_api_keys pattern exactly. Two structural
-- guarantees, neither a convention:
--   1. No CLIENT role can ever read ciphertext/iv/auth_tag — column-level GRANTs,
--      not "we remember to select the safe columns". RLS scopes ROWS; only the
--      column grant walls off the secret material.
--   2. Plaintext is never in the database and never on Vercel — encryption happens
--      only inside the storage Edge Functions, with ENCRYPTION_KEY from Supabase
--      secrets (never NEXT_PUBLIC, never .env, never Vercel).
--
-- Honest scope (same as the hub): the service role bypasses these grants, so the
-- Edge Functions can read ciphertext to decrypt. An operator holding BOTH the
-- service-role key AND ENCRYPTION_KEY could therefore decrypt. "Nobody can read it
-- back" means no CLIENT role can — including the row's own owner. That is what the
-- column grant enforces absolutely.
-- ============================================================================

create type cinematic_workflow.storage_status as enum ('unverified', 'valid', 'invalid');

create table if not exists cinematic_workflow.storage_credentials (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references cinematic_workflow.profiles (id) on delete cascade,

  -- Plaintext metadata — safe for the client to read (never a secret).
  r2_endpoint            text not null,   -- https://<accountid>.r2.cloudflarestorage.com
  r2_bucket              text not null,
  r2_public_url_base     text not null,   -- https://pub-<hash>.r2.dev (no trailing slash)
  access_key_hint        text not null,   -- last 4 chars only, e.g. '••••8e3b'

  -- AES-256-GCM. Two secrets (access key id + secret access key), three columns
  -- each, never one blob. Plaintext never touches the DB.
  access_key_ciphertext  text not null,   -- base64
  access_key_iv          text not null,   -- base64, unique per record
  access_key_auth_tag    text not null,   -- base64
  secret_key_ciphertext  text not null,   -- base64
  secret_key_iv          text not null,   -- base64, unique per record
  secret_key_auth_tag    text not null,   -- base64

  status                 cinematic_workflow.storage_status not null default 'unverified',
  last_verified_at       timestamptz,
  last_error             text,            -- the last test's failure reason (client-readable)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- ONE credential set per user (per-user BYOK scoping). Re-connecting replaces.
  unique (user_id)
);

drop trigger if exists storage_credentials_set_updated_at on cinematic_workflow.storage_credentials;
create trigger storage_credentials_set_updated_at
  before update on cinematic_workflow.storage_credentials
  for each row execute function cinematic_workflow.set_updated_at();

-- ---------------------------------------------------------------------------
-- Column privileges — THIS is what protects the ciphertext, not RLS.
--
-- RLS decides which ROWS you see; it says nothing about COLUMNS. A "select own"
-- policy alone would let a member read their own ciphertext/iv/auth_tag straight
-- from the browser with the anon key. So we revoke the table wholesale and grant
-- back ONLY the safe columns. Both doors (direct table + the view below), one lock.
-- ---------------------------------------------------------------------------
revoke all on cinematic_workflow.storage_credentials from anon, authenticated;
grant select (id, user_id, r2_endpoint, r2_bucket, r2_public_url_base,
              access_key_hint, status, last_verified_at, last_error,
              created_at, updated_at)
  on cinematic_workflow.storage_credentials to authenticated;
grant all on cinematic_workflow.storage_credentials to service_role;

-- No insert/update/delete for any client role. Every write goes through the
-- storage Edge Functions (service role) — because every write has to encrypt
-- first anyway, and that only happens where ENCRYPTION_KEY lives.

-- The client's read path. No route to the ciphertext columns from any client
-- role. security_invoker so the caller's "select own" RLS still applies.
create view cinematic_workflow.storage_credentials_public
  with (security_invoker = true) as
  select id, user_id, r2_endpoint, r2_bucket, r2_public_url_base,
         access_key_hint, status, last_verified_at, last_error,
         created_at, updated_at
  from cinematic_workflow.storage_credentials;

grant select on cinematic_workflow.storage_credentials_public to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: a user sees only their own credential row (and, via the grants above,
-- only its safe columns). current_profile_id() maps auth.uid() -> profiles.id,
-- because this app's profile id is decoupled from the auth uid (dual-mode).
-- ---------------------------------------------------------------------------
alter table cinematic_workflow.storage_credentials enable row level security;

drop policy if exists storage_credentials_select_own on cinematic_workflow.storage_credentials;
create policy storage_credentials_select_own
  on cinematic_workflow.storage_credentials for select
  to authenticated
  using (user_id = cinematic_workflow.current_profile_id());

-- No insert/update/delete policies: writes are service-role only (Edge Functions).
