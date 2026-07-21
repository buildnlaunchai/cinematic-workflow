// Load a user's own R2 config: read their encrypted credential row (service role),
// decrypt both keys (ENCRYPTION_KEY, in-function only), and build an S3 client.
//
// Throws a NAMED StorageError (never a bare 500) when the user hasn't connected
// storage or the stored credential can't be decrypted, so the UI can say exactly
// what's wrong instead of "something went wrong".

import { S3Client } from "npm:@aws-sdk/client-s3";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { decrypt } from "./crypto.ts";

export class StorageError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface UserR2 {
  client: S3Client;
  bucket: string;
  publicBase: string;
}

export async function loadUserR2(supabase: SupabaseClient, userId: string): Promise<UserR2> {
  const { data, error } = await supabase
    .from("storage_credentials")
    .select(
      "r2_endpoint, r2_bucket, r2_public_url_base, " +
        "access_key_ciphertext, access_key_iv, access_key_auth_tag, " +
        "secret_key_ciphertext, secret_key_iv, secret_key_auth_tag",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new StorageError("Could not load your storage settings.", "load_failed");
  if (!data) {
    throw new StorageError(
      "No storage connected. Connect your Cloudflare R2 bucket in Settings before uploading.",
      "not_connected",
    );
  }

  let accessKeyId: string;
  let secretAccessKey: string;
  try {
    accessKeyId = await decrypt({
      ciphertext: data.access_key_ciphertext,
      iv: data.access_key_iv,
      authTag: data.access_key_auth_tag,
    });
    secretAccessKey = await decrypt({
      ciphertext: data.secret_key_ciphertext,
      iv: data.secret_key_iv,
      authTag: data.secret_key_auth_tag,
    });
  } catch {
    throw new StorageError(
      "Your saved storage credentials could not be decrypted. Re-connect your storage in Settings.",
      "decrypt_failed",
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint: data.r2_endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    client,
    bucket: data.r2_bucket,
    publicBase: String(data.r2_public_url_base).replace(/\/+$/, ""),
  };
}
