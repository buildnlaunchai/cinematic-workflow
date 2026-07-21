// generate-upload-url — presign a single-PUT upload (and delete a test object)
// against the CALLING USER's own Cloudflare R2 bucket (per-user BYOK).
//
// Rewired from the old shared-env-secret version: R2 config is no longer read from
// R2_* env vars. The caller is identified (_shared/identity.ts), their encrypted
// credentials are loaded + decrypted in-function (_shared/user-r2.ts), and the
// presign is signed against THEIR bucket. Called by the app's server actions only.

import { PutObjectCommand, DeleteObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

import { resolveProfileId, serviceClient } from "../_shared/identity.ts";
import { loadUserR2, StorageError } from "../_shared/user-r2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabase = serviceClient();

  let body: { action?: string; user_id?: unknown; fileName?: unknown; key?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }

  const userId = await resolveProfileId(supabase, req.headers.get("Authorization") ?? "", body);
  if (!userId) return json({ error: "not authenticated" }, 401);

  try {
    const r2 = await loadUserR2(supabase, userId); // throws StorageError (named) if not connected

    if (body.action === "presign") {
      const fileName = String(body.fileName ?? "");
      if (!fileName) return json({ error: "fileName is required" }, 400);
      const safe = fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const key = `uploads/${crypto.randomUUID()}-${safe}`;
      // No ContentType => the client can PUT any file with any content-type.
      const signedUrl = await getSignedUrl(
        r2.client,
        new PutObjectCommand({ Bucket: r2.bucket, Key: key }),
        { expiresIn: 300 },
      );
      return json({ signedUrl, publicUrl: `${r2.publicBase}/${key}`, key });
    }

    if (body.action === "delete-object") {
      const key = String(body.key ?? "");
      if (!key) return json({ error: "key is required" }, 400);
      await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    if (err instanceof StorageError) return json({ error: err.message, code: err.code }, 400);
    console.error("generate-upload-url error:", (err as Error).message);
    return json({ error: "Something went wrong presigning the upload." }, 500);
  }
});
