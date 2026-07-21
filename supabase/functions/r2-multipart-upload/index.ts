// r2-multipart-upload — multipart upload against the CALLING USER's own R2 bucket
// (per-user BYOK). Actions: initiate | sign-part | complete | abort.
//
// Rewired from the shared-env-secret version: R2 config comes from the caller's
// decrypted credentials (_shared/user-r2.ts), not R2_* env. The client PUTs each
// part directly to R2 with the presigned URLs this returns, reads the ETag off
// each part (bucket CORS MUST expose ETag), and sends the ETags back on complete.
// Called by the app's server actions only.

import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "npm:@aws-sdk/client-s3";
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

  let body: {
    action?: string;
    user_id?: unknown;
    fileName?: unknown;
    key?: unknown;
    uploadId?: unknown;
    partNumber?: unknown;
    parts?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }

  const userId = await resolveProfileId(supabase, req.headers.get("Authorization") ?? "", body);
  if (!userId) return json({ error: "not authenticated" }, 401);

  try {
    const r2 = await loadUserR2(supabase, userId); // throws StorageError (named) if not connected
    const { action } = body;

    if (action === "initiate") {
      const fileName = String(body.fileName ?? "");
      if (!fileName) return json({ error: "fileName is required" }, 400);
      const safe = fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const key = `uploads/${crypto.randomUUID()}-${safe}`;
      const out = await r2.client.send(
        new CreateMultipartUploadCommand({ Bucket: r2.bucket, Key: key }),
      );
      return json({ key, uploadId: out.UploadId, publicUrl: `${r2.publicBase}/${key}` });
    }

    if (action === "sign-part") {
      const key = String(body.key ?? "");
      const uploadId = String(body.uploadId ?? "");
      const partNumber = Number(body.partNumber);
      if (!key || !uploadId || !partNumber) return json({ error: "Invalid request body" }, 400);
      const signedUrl = await getSignedUrl(
        r2.client,
        new UploadPartCommand({ Bucket: r2.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 3600 },
      );
      return json({ signedUrl });
    }

    if (action === "complete") {
      const key = String(body.key ?? "");
      const uploadId = String(body.uploadId ?? "");
      const parts = body.parts;
      if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
        return json({ error: "Invalid request body" }, 400);
      }
      const sortedParts = [...(parts as { partNumber: number; eTag: string }[])]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag }));
      await r2.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: r2.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: sortedParts },
        }),
      );
      return json({ publicUrl: `${r2.publicBase}/${key}` });
    }

    if (action === "abort") {
      const key = String(body.key ?? "");
      const uploadId = String(body.uploadId ?? "");
      if (!key || !uploadId) return json({ error: "Invalid request body" }, 400);
      await r2.client.send(
        new AbortMultipartUploadCommand({ Bucket: r2.bucket, Key: key, UploadId: uploadId }),
      );
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    if (err instanceof StorageError) return json({ error: err.message, code: err.code }, 400);
    console.error("r2-multipart-upload error:", (err as Error).message);
    return json({ error: "Something went wrong with the multipart upload." }, 500);
  }
});
