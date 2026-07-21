// generate-upload-url — presign a single-PUT upload to Cloudflare R2.
//
// Used for files under the multipart threshold (see lib/r2/smartUpload.ts).
// Larger files go through r2-multipart-upload instead.
//
// All config comes from Edge Function secrets (Deno.env) — nothing is hardcoded:
//   R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET  — the bucket + creds
//   R2_PUBLIC_URL_BASE                                    — public URL objects serve from
//   ALLOWED_ORIGIN (optional, defaults to "*")            — CORS origin
//
// Auth: the platform enforces verify_jwt = true (see supabase/config.toml), so a
// valid Supabase JWT is required before this code runs. The bearer check below is
// a light belt-and-braces guard, not the security boundary.

import { serve } from "https://deno.land/std/http/server.ts";
import { S3Client, PutObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

    const { fileName } = await req.json();
    if (!fileName) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const endpoint = Deno.env.get("R2_ENDPOINT");
    const accessKey = Deno.env.get("R2_ACCESS_KEY");
    const secretKey = Deno.env.get("R2_SECRET_KEY");
    const bucket = Deno.env.get("R2_BUCKET");
    const publicUrlBase = Deno.env.get("R2_PUBLIC_URL_BASE");

    if (!endpoint || !accessKey || !secretKey || !bucket || !publicUrlBase) {
      return new Response(
        JSON.stringify({ error: "R2 environment variables missing" }),
        { status: 500, headers: corsHeaders },
      );
    }

    const safeFileName = String(fileName).replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const key = `uploads/${crypto.randomUUID()}-${safeFileName}`;

    const client = new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
    });

    // No ContentType => the client can PUT any file with any content-type.
    const command = new PutObjectCommand({ Bucket: bucket, Key: key });
    const signedUrl = await getSignedUrl(client, command, { expiresIn: 300 });

    const publicUrl = `${publicUrlBase.replace(/\/+$/, "")}/${key}`;

    return new Response(JSON.stringify({ signedUrl, publicUrl, key }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
