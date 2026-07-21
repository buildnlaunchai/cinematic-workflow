'use client'

// Single entry point for uploading a file to the CURRENT USER's own R2 bucket.
//
// Per-user BYOK: the presign coordination (single-PUT, and multipart
// initiate/sign-part/complete/abort) goes through SERVER ACTIONS
// (lib/actions/storage.ts), which resolve the caller in both run modes and hand
// the request to the storage Edge Functions — where the user's credentials are
// decrypted and the URL is signed against their bucket. The browser only ever
// PUTs bytes straight to R2 with the presigned URLs it gets back.
//
// If the user hasn't connected storage yet, the presign action throws a named
// "connect your storage" error (surfaced by the UI); it is not retried.

import { uploadToR2 } from './upload';
import {
  presignUpload,
  multipartInitiate,
  multipartSignPart,
  multipartComplete,
  multipartAbort,
} from '@/lib/actions/storage';

// Below this size, single-PUT. Above it, multipart — kept well under R2's 5GiB
// single-PUT ceiling.
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100MB
const PART_SIZE_BYTES = 64 * 1024 * 1024; // 64MB per part (10GB file ≈ 160 parts)
const PART_CONCURRENCY = 3;

// The presign coordination calls (initiate / sign-part / complete) are small but
// numerous — a multi-GB file makes dozens over several minutes. A single transient
// failure surfaces as fetch()'s "Failed to fetch" TypeError; without retries, one
// blip on any one call kills the whole upload.
const FN_MAX_RETRIES = 4;

export interface UploadResult {
  publicUrl: string;
  key: string;
}

export interface UploadOptions {
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
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

// Retry a presign server-action call on transient failures only. A "connect your
// storage first" / bad-credential error is not transient and propagates at once.
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error('Upload canceled.');
    try {
      return await fn();
    } catch (err: any) {
      if (signal?.aborted) throw new Error('Upload canceled.');
      const msg = String(err?.message ?? err);
      const transient =
        err instanceof TypeError || /failed to fetch|network|timeout|\b(429|500|502|503|504)\b/i.test(msg);
      if (!transient || attempt >= FN_MAX_RETRIES) throw err;
      attempt++;
      const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      await delay(backoff, signal);
    }
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
          reject(new Error('Upload succeeded but no ETag was returned by R2 — your bucket CORS policy must expose the ETag header.'));
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
  const { key, uploadId, publicUrl } = await withRetry(() => multipartInitiate(fileName), signal);

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

        const { signedUrl } = await withRetry(() => multipartSignPart(key, uploadId, partNumber), signal);
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

    await withRetry(() => multipartComplete(key, uploadId, partResults), signal);
    onProgress?.(100);
    return { publicUrl, key };
  } catch (err) {
    // Best-effort cleanup of the orphaned multipart upload — the real error from
    // the try block is what gets surfaced to the caller either way.
    multipartAbort(key, uploadId).catch(() => {});
    throw err;
  }
}

async function uploadSingle(file: File, fileName: string, opts: UploadOptions): Promise<UploadResult> {
  const { signedUrl, publicUrl, key } = await withRetry(() => presignUpload(fileName), opts.signal);
  await uploadToR2({ signedUrl, file, onProgress: opts.onProgress, signal: opts.signal });
  return { publicUrl, key };
}

export async function uploadAssetToR2(file: File, fileName: string, opts: UploadOptions = {}): Promise<UploadResult> {
  if (file.size >= MULTIPART_THRESHOLD_BYTES) {
    return uploadMultipart(file, fileName, opts);
  }
  return uploadSingle(file, fileName, opts);
}
