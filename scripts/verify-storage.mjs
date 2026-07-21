/**
 * Adversarial verification of the per-user BYOK R2 storage vault, against the LIVE
 * storage-credentials + generate-upload-url Edge Functions and DB. Mirrors the
 * hub's verify-vault.mjs. The asset that matters is a user's R2 secret key, so the
 * checks are adversarial:
 *   - a known canary secret, saved, is nowhere in the DB (only ciphertext)
 *   - the client (authenticated owner) cannot read ciphertext/iv/auth_tag — column
 *     grants, not just a view
 *   - anon cannot invoke; one credential per user; a not-connected upload fails
 *     with a NAMED error (not a generic 500); delete removes the row
 *
 * Env required (from `supabase status`, or a live project's Settings -> API):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * (The real R2 upload round-trip — good/bad credentials against Cloudflare — is
 * exercised by the in-app "Test connection" button, which needs a real bucket.)
 */
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCHEMA = 'cinematic_workflow';
const CRED_FN = `${URL}/functions/v1/storage-credentials`;
const PRESIGN_FN = `${URL}/functions/v1/generate-upload-url`;

if (!URL || !ANON || !SVC) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

const svc = (p, init = {}) =>
  fetch(`${URL}${p}`, {
    ...init,
    headers: {
      apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA, 'Content-Profile': SCHEMA, ...(init.headers ?? {}),
    },
  });
const asUser = (p, tok, init = {}) =>
  fetch(`${URL}${p}`, {
    ...init,
    headers: {
      apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA, ...(init.headers ?? {}),
    },
  });
const login = async (email) =>
  (await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw-not-real-5521' }),
  }).then((r) => r.json())).access_token;
const fn = (endpoint, tok, body) =>
  fetch(endpoint, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let pass = 0, fail = 0;
const check = (ok, l, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };

const email = `storage-${Date.now()}@example.com`;
const SECRET = `r2secret-PLAINTEXT-CANARY-${Date.now()}-abcdEND`;
const ACCESS = `r2accesskey-CANARY-${Date.now()}-1234WXYZ`;
const goodBody = {
  action: 'save',
  r2_endpoint: 'https://example.r2.cloudflarestorage.com',
  r2_bucket: 'canary-bucket',
  r2_public_url_base: 'https://pub-canary.r2.dev',
  access_key_id: ACCESS,
  secret_key: SECRET,
};
let uid, profileId;

try {
  uid = (await svc('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password: 'pw-not-real-5521', email_confirm: true }) }).then((r) => r.json())).id;
  await new Promise((r) => setTimeout(r, 700)); // let the handle_new_user trigger seed the profile
  const tok = await login(email);
  profileId = (await svc(`/rest/v1/profiles?auth_user_id=eq.${uid}&select=id`).then((r) => r.json()))[0]?.id;
  check(!!profileId, 'handle_new_user seeded a profile for the new signup', `profile=${profileId}`);

  console.log('\n1. Anonymous cannot invoke storage-credentials:');
  const anon = await fetch(CRED_FN, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify(goodBody) });
  check(anon.status === 401, 'anon key (no user) → 401', `HTTP ${anon.status}`);

  console.log('\n2. Save (encrypt + store), returns metadata only:');
  const saveRes = await fn(CRED_FN, tok, goodBody);
  const saved = await saveRes.json();
  check(saveRes.ok, 'save returns 200', `HTTP ${saveRes.status}`);
  check(saved.access_key_hint === '••••WXYZ', 'access_key_hint is last-4 only', saved.access_key_hint);
  check(!JSON.stringify(saved).includes('CANARY'), 'the response contains no plaintext');

  console.log('\n3. Plaintext is NOWHERE in the DB (service role sees ALL columns):');
  const rowSvc = await svc(`/rest/v1/storage_credentials?user_id=eq.${profileId}&select=*`).then((r) => r.json());
  const blob = JSON.stringify(rowSvc);
  check(!blob.includes('CANARY'), 'no plaintext canary anywhere in the row');
  const row = rowSvc[0] ?? {};
  check(!!(row.access_key_ciphertext && row.access_key_iv && row.access_key_auth_tag && row.secret_key_ciphertext && row.secret_key_iv && row.secret_key_auth_tag), 'all 6 ciphertext/iv/auth_tag columns present');
  check(row.secret_key_ciphertext !== SECRET && row.access_key_ciphertext !== ACCESS, 'ciphertext is not the plaintext (encrypted at rest)');

  console.log('\n4. The CLIENT (owner) cannot read ciphertext columns:');
  const cipherReq = await asUser(`/rest/v1/storage_credentials?user_id=eq.${profileId}&select=access_key_ciphertext,secret_key_ciphertext,access_key_iv`, tok);
  const cipherBody = await cipherReq.json();
  const denied = !cipherReq.ok || (Array.isArray(cipherBody) && cipherBody.every((r) => r.access_key_ciphertext === undefined && r.secret_key_ciphertext === undefined));
  check(denied, 'select ciphertext as the owner is denied/empty', `HTTP ${cipherReq.status} ${JSON.stringify(cipherBody).slice(0, 70)}`);

  console.log('\n5. The client CAN read safe metadata via the public view:');
  const pub = await asUser(`/rest/v1/storage_credentials_public?select=r2_bucket,access_key_hint,status`, tok).then((r) => r.json());
  check(Array.isArray(pub) && pub[0]?.r2_bucket === 'canary-bucket' && pub[0]?.access_key_hint === '••••WXYZ', 'public view returns bucket + hint + status', JSON.stringify(pub[0] ?? {}).slice(0, 80));
  check(pub[0] && pub[0].access_key_ciphertext === undefined, 'public view has NO ciphertext column');

  console.log('\n6. One credential per user — a second save replaces, not duplicates:');
  await fn(CRED_FN, tok, { ...goodBody, r2_bucket: 'canary-bucket-v2' });
  const count = (await svc(`/rest/v1/storage_credentials?user_id=eq.${profileId}&select=id`).then((r) => r.json())).length;
  check(count === 1, 'still exactly 1 credential row after a second save', `count=${count}`);

  console.log('\n7. A not-connected upload fails with a NAMED error, not a generic 500:');
  await fn(CRED_FN, tok, { action: 'delete' });
  const presign = await fn(PRESIGN_FN, tok, { action: 'presign', fileName: 'clip.mp4' });
  const presignBody = await presign.json();
  check(presign.status === 400 && /connect|storage/i.test(presignBody.error ?? '') && presignBody.code === 'not_connected', 'presign with no storage → 400 + named "connect storage" error (not 500)', `HTTP ${presign.status} ${JSON.stringify(presignBody).slice(0, 80)}`);

  console.log('\n8. Delete removes the row:');
  await fn(CRED_FN, tok, goodBody);
  await fn(CRED_FN, tok, { action: 'delete' });
  const after = (await svc(`/rest/v1/storage_credentials?user_id=eq.${profileId}&select=id`).then((r) => r.json())).length;
  check(after === 0, 'row is gone after delete', `count=${after}`);
} finally {
  if (uid) await svc(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
  console.log('\n  (probe user deleted; credential row cascades away)');
}
console.log(`\n${'='.repeat(56)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(56)}`);
process.exit(fail ? 1 : 0);
