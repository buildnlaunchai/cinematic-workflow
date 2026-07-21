// AES-256-GCM, in Deno, using Web Crypto. THE ONLY FILE THAT READS
// ENCRYPTION_KEY, and it only ever runs inside a Supabase Edge Function.
// There is no lib/crypto.ts in the Next app, because the Next app has nothing to
// encrypt and no key to do it with — ENCRYPTION_KEY lives in Supabase secrets and
// nowhere else (not Vercel, not .env.local, not .env.example).
//
// Copied verbatim from the Build & Launch hub's vault. Do not change the shape:
// three separate base64 outputs (ciphertext / iv / authTag), never one blob.

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loadKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("ENCRYPTION_KEY");
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const keyBytes = fromB64(raw);
  if (keyBytes.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (got ${keyBytes.length})`);
  }
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export type Encrypted = { ciphertext: string; iv: string; authTag: string };

/**
 * Encrypt a plaintext secret. Three separate base64 outputs — never one blob —
 * with a fresh random 12-byte IV per call. Web Crypto appends the 16-byte GCM
 * tag to the ciphertext; we split it back out so the tag lands in its own column.
 */
export async function encrypt(plaintext: string): Promise<Encrypted> {
  const key = await loadKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const tag = combined.slice(combined.length - 16);
  const ct = combined.slice(0, combined.length - 16);
  return { ciphertext: toB64(ct), iv: toB64(iv), authTag: toB64(tag) };
}

/** Decrypt back to plaintext. Held in memory only, never persisted or logged. */
export async function decrypt(e: Encrypted): Promise<string> {
  const key = await loadKey();
  const ct = fromB64(e.ciphertext);
  const tag = fromB64(e.authTag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(e.iv), tagLength: 128 },
    key,
    combined,
  );
  return new TextDecoder().decode(plain);
}

/** The last-4-chars hint shown in the UI. Never more than 4. */
export function keyHint(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `••••${tail}`;
}
