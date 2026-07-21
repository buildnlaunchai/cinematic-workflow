'use client'

// Resilient R2 (Cloudflare presigned PUT) upload helper.
//
// Wraps XMLHttpRequest with:
//   - Explicit onabort / ontimeout handlers (browsers throttle/abort XHRs in
//     backgrounded tabs; without these the failure looks like a generic
//     "network error" to the user)
//   - Auto-retry when the failure happens while the tab is hidden; we wait for
//     visibilitychange and try again instead of immediately failing
//   - Long timeout (30 min) so large uploads on slow connections aren't killed
//     by browser-default timeouts
//   - AbortController integration so callers can cancel cleanly on unmount
//
// No hardcoded config: the presigned URL is supplied by the caller (minted by
// the generate-upload-url / r2-multipart-upload edge functions).

export interface R2UploadOptions {
  signedUrl: string;
  file: File | Blob;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
  maxRetries?: number;
  // When the presigned URL was signed with a specific Content-Type, the PUT must
  // send exactly that value or R2 rejects the signature (403). Callers that
  // signed without a Content-Type should leave this unset.
  contentType?: string;
}

const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

const attemptUpload = (opts: R2UploadOptions): Promise<{ ok: true } | { ok: false; reason: 'abort' | 'timeout' | 'network' | 'http'; status?: number; statusText?: string }> => {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', opts.signedUrl);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType);

    let aborted = false;
    const userAbortHandler = () => {
      aborted = true;
      try { xhr.abort(); } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        resolve({ ok: false, reason: 'abort' });
        return;
      }
      opts.signal.addEventListener('abort', userAbortHandler);
    }

    const cleanup = () => {
      if (opts.signal) opts.signal.removeEventListener('abort', userAbortHandler);
    };

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) {
        const percent = Math.round((e.loaded / e.total) * 100);
        opts.onProgress(percent);
      }
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: 'http', status: xhr.status, statusText: xhr.statusText });
      }
    };

    xhr.onerror = () => {
      cleanup();
      resolve({ ok: false, reason: aborted ? 'abort' : 'network' });
    };

    xhr.onabort = () => {
      cleanup();
      resolve({ ok: false, reason: 'abort' });
    };

    xhr.ontimeout = () => {
      cleanup();
      resolve({ ok: false, reason: 'timeout' });
    };

    xhr.send(opts.file);
  });
};

const waitForVisible = (): Promise<void> => {
  return new Promise((resolve) => {
    if (document.visibilityState === 'visible') {
      resolve();
      return;
    }
    const handler = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', handler);
        resolve();
      }
    };
    document.addEventListener('visibilitychange', handler);
  });
};

export async function uploadToR2(opts: R2UploadOptions): Promise<void> {
  const maxRetries = opts.maxRetries ?? 2;
  let attempt = 0;
  let lastReason = '';
  let lastStatus: number | undefined;
  let lastStatusText: string | undefined;

  while (attempt <= maxRetries) {
    if (opts.signal?.aborted) throw new Error('Upload canceled.');

    const result = await attemptUpload(opts);
    if (result.ok) return;

    // User-initiated cancel — surface immediately, no retry.
    if (result.reason === 'abort' && opts.signal?.aborted) {
      throw new Error('Upload canceled.');
    }

    // HTTP error from R2 (e.g. 4xx) — retrying won't help; the URL is bad or the
    // signature has rotated.
    if (result.reason === 'http') {
      throw new Error(`Upload rejected (${result.status} ${result.statusText || ''}).`);
    }

    lastReason = result.reason;
    lastStatus = result.status;
    lastStatusText = result.statusText;
    attempt++;

    if (attempt > maxRetries) break;

    // If the failure happened while the tab was hidden, wait for it to come back
    // before retrying — that's the common case (Chrome throttled the request to
    // death). Otherwise retry after a short delay.
    if (document.visibilityState !== 'visible') {
      await waitForVisible();
    } else {
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  const reasonText =
    lastReason === 'timeout' ? 'Upload timed out.' :
    lastReason === 'abort' ? 'Upload was interrupted (likely because the tab was inactive too long).' :
    lastReason === 'http' ? `Upload rejected (${lastStatus} ${lastStatusText || ''}).` :
    'Network error during upload. Please try again — keep this tab visible.';
  throw new Error(reasonText);
}
