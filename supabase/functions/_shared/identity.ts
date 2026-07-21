// Dual-mode caller identity for the storage Edge Functions.
//
// These functions are called by the app's SERVER ACTIONS only — never the browser
// directly. The server action (which resolved the caller via requireRequestUser)
// authenticates to the function one of two ways, and this resolves the caller's
// cinematic_workflow.profiles.id accordingly:
//
//   embedded    Authorization: Bearer <service-role key> + body.user_id (a profile
//               id). Only the app server holds the service-role key, so a caller
//               presenting it is the trusted server; the named profile id is used.
//   standalone  Authorization: Bearer <user's Supabase JWT>. Identity is DERIVED
//               from the token (getUser -> auth uid -> profiles.auth_user_id) and
//               a body.user_id is ignored — it can't be spoofed on this path.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/** Service-role client, pinned to the app's schema. Reads ciphertext + writes. */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      db: { schema: "cinematic_workflow" },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export async function resolveProfileId(
  supabase: SupabaseClient,
  authHeader: string,
  body: { user_id?: unknown },
): Promise<string | null> {
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && token === serviceKey) {
    // Trusted app-server call (embedded). Trust the named profile id.
    const uid = body.user_id;
    return typeof uid === "string" && uid.length > 0 ? uid : null;
  }

  // Standalone: a user JWT. Derive identity from it; ignore any body user_id.
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  return (profile as { id: string } | null)?.id ?? null;
}
