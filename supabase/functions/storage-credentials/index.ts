// storage-credentials — save / delete / set-status for a user's BYOK R2 config.
//
// Mirrors the hub's key-vault function: plaintext is encrypted HERE (the only
// place ENCRYPTION_KEY lives) and the ciphertext columns are never returned. The
// app's server actions are the only caller; identity is resolved by
// _shared/identity.ts (service-role bearer + user_id for embedded, or a user JWT
// for standalone). No plaintext is ever logged or returned.

import { encrypt, keyHint } from "../_shared/crypto.ts";
import { resolveProfileId, serviceClient } from "../_shared/identity.ts";

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
    r2_endpoint?: unknown;
    r2_bucket?: unknown;
    r2_public_url_base?: unknown;
    access_key_id?: unknown;
    secret_key?: unknown;
    status?: unknown;
    last_error?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }

  const userId = await resolveProfileId(supabase, req.headers.get("Authorization") ?? "", body);
  if (!userId) return json({ error: "not authenticated" }, 401);

  try {
    // ---- save: encrypt both keys, store as 'unverified' ---------------------
    if (body.action === "save") {
      const endpoint = String(body.r2_endpoint ?? "").trim();
      const bucket = String(body.r2_bucket ?? "").trim();
      const publicBase = String(body.r2_public_url_base ?? "").trim().replace(/\/+$/, "");
      const accessKeyId = String(body.access_key_id ?? "").trim();
      const secretKey = String(body.secret_key ?? "").trim();
      if (!endpoint || !bucket || !publicBase || !accessKeyId || !secretKey) {
        return json({ error: "All storage fields are required." }, 400);
      }

      const encAccess = await encrypt(accessKeyId);
      const encSecret = await encrypt(secretKey);

      const { error } = await supabase
        .from("storage_credentials")
        .upsert(
          {
            user_id: userId,
            r2_endpoint: endpoint,
            r2_bucket: bucket,
            r2_public_url_base: publicBase,
            access_key_hint: keyHint(accessKeyId),
            access_key_ciphertext: encAccess.ciphertext,
            access_key_iv: encAccess.iv,
            access_key_auth_tag: encAccess.authTag,
            secret_key_ciphertext: encSecret.ciphertext,
            secret_key_iv: encSecret.iv,
            secret_key_auth_tag: encSecret.authTag,
            status: "unverified",
            last_verified_at: null,
            last_error: null,
          },
          { onConflict: "user_id" },
        );
      if (error) {
        console.error("storage save upsert failed"); // never log the key or error body
        return json({ error: "Could not save your storage settings." }, 500);
      }

      // Return metadata only — never the plaintext or the ciphertext.
      return json({ status: "unverified", access_key_hint: keyHint(accessKeyId) });
    }

    // ---- set-status: record the browser test result -------------------------
    if (body.action === "set-status") {
      const ok = body.status === "valid";
      const status = ok ? "valid" : "invalid";
      const lastError = ok
        ? null
        : (typeof body.last_error === "string" ? body.last_error.slice(0, 300) : "Connection test failed.");
      const { error } = await supabase
        .from("storage_credentials")
        .update({
          status,
          last_error: lastError,
          last_verified_at: ok ? new Date().toISOString() : null,
        })
        .eq("user_id", userId);
      if (error) return json({ error: "Could not update status." }, 500);
      return json({ status });
    }

    // ---- delete -------------------------------------------------------------
    if (body.action === "delete") {
      const { error } = await supabase.from("storage_credentials").delete().eq("user_id", userId);
      if (error) return json({ error: "Could not disconnect storage." }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    // Never leak details — an error here could otherwise carry key material.
    console.error("storage-credentials error:", (err as Error).message);
    return json({ error: "Something went wrong." }, 500);
  }
});
