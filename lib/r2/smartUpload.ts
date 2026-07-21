'use client'

// Single entry point for uploading a file to R2.
//
// R2 (S3-compatible) hard-caps a single PUT object upload at 5GiB. This picks
// single-PUT for small files (cheap, battle-tested) and switches to multipart
// for large files, splitting them into parts uploaded in parallel and stitched
// back together server-side via the r2-multipart-upload edge function.
//
// NOTHING is hardcoded: the Edge Functions base is derived from
// NEXT_PUBLIC_SUPABASE_URL, and the R2 bucket/domain live only in the functions'
// own secrets. The public URL is always returned BY the function, never built
// here.
//
// NOTE (embedded mode): this uses the standalone browser session's access token.
// The embedded-mode upload path (hub token, no Supabase session) is wired in
// Step 4 — it routes the presign request through the app server, which verifies
// the hub token first.

import { createClient } from '@/lib/supabase/client';
import { uploadToR2 } from './upload';

// Below this size, use the single-PUT flow. Above it, multipart — kept well under
// R2's 5GiB single-PUT ceiling.
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100MB
const PART_SIZE_BYTES = 64 * 1024 * 1024; // 64MB per part (10GB file ≈ 160 parts)
const PART_CONCURRENCY = 3;

// The edge-function coordination calls (initiate / sign-part / complete) are
// small but numerous — a multi-GB file makes dozens over several minutes. A
// single transient failure surfaces as fetch()'s "Failed to fetch" TypeError;
// without retries, one blip on any one call kills the whole upload.
const FN_MAX_RETRIES = 4;
const FN_TIMEOUT_MS = 60 * 1000;

export interface UploadResult {
  publicUrl: string;
  key: string;
}

export interface UploadOptions {
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

// Lazy singleton browser client — instantiated on first use, in the browser only.
let _sb: ReturnType<typeof createClient> | null = null;
function sb() {
  if (!_sb) _sb = createClient();
  return _sb;
}

// Supabase Edge Functions base, derived from the project URL. No hardcoded host.
function functionsBase(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set. See .env.example.');
  return `${url.replace(/\/+$/, '')}/functions/v1`;
}

async function getAuthToken(): Promise<string | undefined> {
  const { data: { session } } = await sb().auth.getSession();
  return session?.access_token;
}

// Abort-aware sleep — rejects cleanly if the caller cancels mid-backoff.
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Upload canceled.')); return; }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Upload canceled.')); }, { once: true });
    }
  });
}

async function callFunction(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const base = functionsBase();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error('Upload canceled.');

    // Per-attempt timeout so a hung connection doesn't stall the whole upload
    // forever. Chained to the caller's signal so a user cancel aborts it too.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FN_TIMEOUT_MS);
    const onParentAbort = () => controller.abort();
    signal?.addEventListener('abort', onParentAbort);

    try {
      const token = await getAuthToken();
      const response = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(anonKey ? { apikey: anonKey } : {}),
          Authorization: `Bearer ${token ?? anonKey ?? ''}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) return await response.json();

      // Server answered, but with an error. 429/5xx are transient (rate limit,
      // cold start, gateway) — retry. Everything else (4xx) is a real problem
      // retrying won't fix, so surface it immediately.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= FN_MAX_RETRIES) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Upload service error (${response.status} ${response.statusText}).`);
      }
      // else: fall through to backoff + retry
    } catch (err: any) {
      if (signal?.aborted) throw new Error('Upload canceled.');
      // fetch() throws TypeError ("Failed to fetch") on transport failures; our
      // timeout fires an AbortError. Both are transient → retry. Anything else
      // (e.g. the non-retryable server error thrown above) propagates.
      const isTransport = err instanceof TypeError;
      const isTimeout = err?.name === 'AbortError';
      if (!isTransport && !isTimeout) throw err;
      if (attempt >= FN_MAX_RETRIES) {
        throw new Error(`Could not reach the upload service after ${FN_MAX_RETRIES + 1} tries. Check your connection and try again — keep this tab active while uploading.`);
      }
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onParentAbort);
    }

    attempt++;
    // Exponential backoff with jitter so 3 concurrent workers don't all retry in
    // lockstep and hammer a recovering edge function.
    const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
    await delay(backoff, signal);
  }
}

function uploadPart(
  signedUrl: string,
  chunk: Blob,
  onChunkProgress: ((loadedBytes: number) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);
    xhr.timeout = 30 * 60 * 1000;

    const abortHandler = () => xhr.abort();
    if (signal) {
      if (signal.aborted) { reject(new Error('Upload canceled.')); return; }
      signal.addEventListener('abort', abortHandler);
    }
    const cleanup = () => { if (signal) signal.removeEventListener('abort', abortHandler); };

    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onChunkProgress?.(e.loaded); };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        const eTag = xhr.getResponseHeader('ETag');
        if (!eTag) {
          reject(new Error('Upload succeeded but no ETag was returned by R2 — the bucket CORS policy must expose the ETag header.'));
          return;
        }
        resolve(eTag);
      } else {
        reject(new Error(`Part upload rejected (${xhr.status} ${xhr.statusText}).`));
      }
    };
    xhr.onerror = () => { cleanup(); reject(new Error('Network error while uploading part.')); };
    xhr.onabort = () => { cleanup(); reject(new Error('Upload canceled.')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('Part upload timed out.')); };

    xhr.send(chunk);
  });
}

async function uploadPartWithRetry(
  signedUrl: string,
  chunk: Blob,
  onChunkProgress: ((loadedBytes: number) => void) | undefined,
  signal: AbortSignal | undefined,
  maxRetries = 2
): Promise<string> {
  let attempt = 0;
  while (true) {
    try {
      return await uploadPart(signedUrl, chunk, onChunkProgress, signal);
    } catch (err) {
      if (signal?.aborted || attempt >= maxRetries) throw err;
      attempt++;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

async function uploadMultipart(file: File, fileName: string, opts: UploadOptions): Promise<UploadResult> {
  const { onProgress, signal } = opts;
  const { key, uploadId, publicUrl } = await callFunction('r2-multipart-upload', { action: 'initiate', fileName }, signal);

  const totalParts = Math.ceil(file.size / PART_SIZE_BYTES);
  const partLoaded = new Array(totalParts).fill(0);
  // XHR fires progress far more often than the UI needs — only re-render when the
  // displayed percentage actually changes, otherwise React gets flooded.
  let lastReportedPct = -1;
  const reportProgress = () => {
    if (!onProgress) return;
    const loaded = partLoaded.reduce((a, b) => a + b, 0);
    const pct = Math.min(99, Math.round((loaded / file.size) * 100));
    if (pct === lastReportedPct) return;
    lastReportedPct = pct;
    onProgress(pct);
  };

  const partResults: { partNumber: number; eTag: string }[] = [];

  try {
    let nextPartIndex = 0;
    const worker = async () => {
      while (true) {
        if (signal?.aborted) throw new Error('Upload canceled.');
        const partIndex = nextPartIndex++;
        if (partIndex >= totalParts) return;

        const partNumber = partIndex + 1;
        const start = partIndex * PART_SIZE_BYTES;
        const end = Math.min(start + PART_SIZE_BYTES, file.size);
        const chunk = file.slice(start, end);

        const { signedUrl } = await callFunction('r2-multipart-upload', { action: 'sign-part', key, uploadId, partNumber }, signal);
        const eTag = await uploadPartWithRetry(signedUrl, chunk, (loadedBytes) => {
          partLoaded[partIndex] = loadedBytes;
          reportProgress();
        }, signal);

        partLoaded[partIndex] = chunk.size;
        reportProgress();
        partResults.push({ partNumber, eTag });
      }
    };

    const workerCount = Math.min(PART_CONCURRENCY, totalParts);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    await callFunction('r2-multipart-upload', { action: 'complete', key, uploadId, parts: partResults }, signal);
    onProgress?.(100);
    return { publicUrl, key };
  } catch (err) {
    // Best-effort cleanup of the orphaned multipart upload — the real error from
    // the try block is what gets surfaced to the caller either way.
    callFunction('r2-multipart-upload', { action: 'abort', key, uploadId }).catch(() => {});
    throw err;
  }
}

async function uploadSingle(file: File, fileName: string, opts: UploadOptions): Promise<UploadResult> {
  const { signedUrl, publicUrl, key } = await callFunction('generate-upload-url', { fileName }, opts.signal);
  await uploadToR2({ signedUrl, file, onProgress: opts.onProgress, signal: opts.signal });
  return { publicUrl, key };
}

export async function uploadAssetToR2(file: File, fileName: string, opts: UploadOptions = {}): Promise<UploadResult> {
  if (file.size >= MULTIPART_THRESHOLD_BYTES) {
    return uploadMultipart(file, fileName, opts);
  }
  return uploadSingle(file, fileName, opts);
}
