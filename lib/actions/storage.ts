'use server'

/**
 * Server actions for per-user BYOK R2 storage. This is the identity boundary the
 * whole feature hangs on: every call resolves the caller via requireRequestUser()
 * (both modes) and then talks to the storage Edge Functions — which is where
 * ENCRYPTION_KEY lives and where decrypt/presign happen. The Next server never
 * sees a decrypted key, and the browser never talks to the functions directly.
 *
 * Auth to the Edge Function, per mode (see supabase/functions/_shared/identity.ts):
 *   embedded    Bearer <service-role key> + user_id (the resolved profile id).
 *               Only this server holds that key, so the function trusts the id.
 *   standalone  Bearer <the user's Supabase JWT>. The function derives identity
 *               from the token; standalone never needs the service-role key.
 */

import { requireRequestUser } from '@/lib/session'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getServiceRoleKey, getSupabaseAnonKey, getSupabaseUrl } from '@/lib/env.server'
import type { StorageCredentialsInput, StorageStatus } from '@/types'

function functionsBase(): string {
  return `${getSupabaseUrl().replace(/\/+$/, '')}/functions/v1`
}

async function callStorageFn(fn: string, payload: Record<string, unknown>): Promise<any> {
  const { mode, user } = await requireRequestUser()
  const anon = getSupabaseAnonKey()

  let bearer: string
  let body: Record<string, unknown>
  if (mode === 'embedded') {
    bearer = getServiceRoleKey()
    body = { ...payload, user_id: user.id }
  } else {
    const supabase = await createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error('Not authorized.')
    bearer = session.access_token
    body = { ...payload }
  }

  const res = await fetch(`${functionsBase()}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error || `Storage service error (${res.status}).`)
  return json
}

// ---- credential management (settings wizard) --------------------------------

export async function getMyStorageStatus(): Promise<StorageStatus> {
  const { mode, user } = await requireRequestUser()
  const client: any = mode === 'embedded' ? createAdminClient() : await createClient()
  const { data } = await client
    .from('storage_credentials_public')
    .select('status, r2_endpoint, r2_bucket, r2_public_url_base, access_key_hint, last_error, last_verified_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!data) {
    return {
      connected: false, status: null, r2_endpoint: null, r2_bucket: null,
      r2_public_url_base: null, access_key_hint: null, last_error: null, last_verified_at: null,
    }
  }
  return {
    connected: true,
    status: data.status,
    r2_endpoint: data.r2_endpoint,
    r2_bucket: data.r2_bucket,
    r2_public_url_base: data.r2_public_url_base,
    access_key_hint: data.access_key_hint,
    last_error: data.last_error,
    last_verified_at: data.last_verified_at,
  }
}

export async function saveStorageCredentials(
  input: StorageCredentialsInput,
): Promise<{ status: string; access_key_hint: string }> {
  return callStorageFn('storage-credentials', {
    action: 'save',
    r2_endpoint: input.r2_endpoint,
    r2_bucket: input.r2_bucket,
    r2_public_url_base: input.r2_public_url_base,
    access_key_id: input.access_key_id,
    secret_key: input.secret_key,
  })
}

/** Record the browser connection-test result (drives the "storage ready" gate). */
export async function setStorageVerified(ok: boolean, lastError?: string): Promise<{ status: string }> {
  return callStorageFn('storage-credentials', {
    action: 'set-status',
    status: ok ? 'valid' : 'invalid',
    last_error: lastError ?? null,
  })
}

export async function deleteStorageCredentials(): Promise<{ ok: true }> {
  return callStorageFn('storage-credentials', { action: 'delete' })
}

// ---- upload presigning (per-user creds; consumed by lib/r2/smartUpload.ts) ----

export async function presignUpload(
  fileName: string,
): Promise<{ signedUrl: string; publicUrl: string; key: string }> {
  return callStorageFn('generate-upload-url', { action: 'presign', fileName })
}

export async function deleteStorageObject(key: string): Promise<{ ok: true }> {
  return callStorageFn('generate-upload-url', { action: 'delete-object', key })
}

export async function multipartInitiate(
  fileName: string,
): Promise<{ key: string; uploadId: string; publicUrl: string }> {
  return callStorageFn('r2-multipart-upload', { action: 'initiate', fileName })
}

export async function multipartSignPart(
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<{ signedUrl: string }> {
  return callStorageFn('r2-multipart-upload', { action: 'sign-part', key, uploadId, partNumber })
}

export async function multipartComplete(
  key: string,
  uploadId: string,
  parts: { partNumber: number; eTag: string }[],
): Promise<{ publicUrl: string }> {
  return callStorageFn('r2-multipart-upload', { action: 'complete', key, uploadId, parts })
}

export async function multipartAbort(key: string, uploadId: string): Promise<{ ok: true }> {
  return callStorageFn('r2-multipart-upload', { action: 'abort', key, uploadId })
}
