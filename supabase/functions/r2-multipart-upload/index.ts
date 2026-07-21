// r2-multipart-upload — S3-compatible multipart upload to Cloudflare R2.
//
// Used for files at/above the multipart threshold (see lib/r2/smartUpload.ts).
// Actions: initiate | sign-part | complete | abort. The client PUTs each part
// directly to R2 using the presigned URLs this returns, reads the ETag off each
// part response (R2 bucket CORS MUST expose ETag — see .env.example), and sends
// the ETags back on `complete`.
//
// All config comes from Edge Function secrets (Deno.env) — nothing is hardcoded:
//   R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET  — the bucket + creds
//   R2_PUBLIC_URL_BASE                                    — public URL objects serve from
//   ALLOWED_ORIGIN (optional, defaults to "*")            — CORS origin
//
// Auth: verify_jwt = true is enforced by the platform (see supabase/config.toml).

import { serve } from "https://deno.land/std/http/server.ts";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function getR2() {
  const endpoint = Deno.env.get("R2_ENDPOINT");
  const accessKey = Deno.env.get("R2_ACCESS_KEY");
  const secretKey = Deno.env.get("R2_SECRET_KEY");
  const bucket = Deno.env.get("R2_BUCKET");
  const publicUrlBase = Deno.env.get("R2_PUBLIC_URL_BASE");

  if (!endpoint || !accessKey || !secretKey || !bucket || !publicUrlBase) {
    throw new Error("R2 environment variables missing");
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });

  return { client, bucket, publicUrlBase: publicUrlBase.replace(/\/+$/, "") };
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: missing token" }),
        { status: 401, headers: corsHeaders },
      );
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: corsHeaders,
      });
    }

    const body = await req.json();
    const { action } = body;
    const { client, bucket, publicUrlBase } = getR2();

    if (action === "initiate") {
      const { fileName } = body;
      if (!fileName) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const safeFileName = String(fileName).replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const key = `uploads/${crypto.randomUUID()}-${safeFileName}`;

      const out = await client.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
      );

      return new Response(
        JSON.stringify({
          key,
          uploadId: out.UploadId,
          publicUrl: `${publicUrlBase}/${key}`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "sign-part") {
      const { key, uploadId, partNumber } = body;
      if (!key || !uploadId || !partNumber) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const signedUrl = await getSignedUrl(client, command, { expiresIn: 3600 });

      return new Response(JSON.stringify({ signedUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "complete") {
      const { key, uploadId, parts } = body;
      if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const sortedParts = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag }));

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: sortedParts },
        }),
      );

      return new Response(
        JSON.stringify({ publicUrl: `${publicUrlBase}/${key}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "abort") {
      const { key, uploadId } = body;
      if (!key || !uploadId) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      await client.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      );

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
