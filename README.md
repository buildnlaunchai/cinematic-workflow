# Cinematic Workflow

A self-hostable, Frame.io-style video review tool. Create a **workflow**, add video
**versions**, and collect **timecoded, range, and spatially-pinned comments** with
threaded replies and attachments. Compare two versions side by side, and share a
**read-only public link** with clients who don't have an account.

It runs entirely on your own infrastructure: your Supabase project (database + auth)
and your own Cloudflare R2 bucket (video + attachment storage). No data touches
anyone else's servers.

This guide is written for someone deploying it for the first time. Follow the steps
in order; where a step needs a value, it says exactly where to get it.

---

## What you'll need

- **Node.js 20+** and **pnpm** (`npm install -g pnpm`).
- A **Supabase** account (free tier is fine) — the database and login system.
- A **Cloudflare** account with **R2** enabled — where videos are stored.
- A **Vercel** account (or any Next.js host) for the app itself.
- The **Supabase CLI**: `brew install supabase/tap/supabase` (or see supabase.com/docs).

---

## 1. Get the code

```bash
pnpm install
```

## 2. Create your Supabase project

In the Supabase dashboard, create a new project. Then open **Settings → API** and copy
three things (you'll paste them in step 5):

- **Project URL** — `https://<something>.supabase.co`
- **anon / public** key — safe to expose in the browser.
- **service_role** key — *secret*, server-only. (Only needed for embedded mode; you
  can grab it now or skip it.)

## 3. Create the database

Link the CLI to your project and push the schema. This creates everything the app
needs, inside its own `cinematic_workflow` schema:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Then do the **one manual dashboard step**: open **Settings → API → Exposed schemas**
and add **`cinematic_workflow`** to the list (alongside `public`). PostgREST only
serves schemas it's told about — without this, the app's tables will 404 even though
the migration applied fine.

## 4. Set up Cloudflare R2 (video storage)

1. In Cloudflare, go to **R2** and **create a bucket**.
2. Enable public access for the bucket (**Settings → Public access → r2.dev**), or
   attach a custom domain. Copy that public base URL — it looks like
   `https://pub-<hash>.r2.dev`.
3. Create an **R2 API token** (**R2 → Manage R2 API Tokens → Create**, "Object Read &
   Write", scoped to your bucket). Copy the **Access Key ID** and **Secret Access Key**.
4. Note your **S3 API endpoint** — `https://<account-id>.r2.cloudflarestorage.com`.
5. **Set the CORS policy on the bucket** (Settings → CORS Policy). This is required —
   large-file uploads fail without it, specifically because the app needs the `ETag`
   header exposed:

   ```json
   [
     {
       "AllowedOrigins": ["https://your-app-url.vercel.app"],
       "AllowedMethods": ["GET", "PUT"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"]
     }
   ]
   ```

## 5. Deploy the upload functions and their secrets

The app uploads to R2 through two Supabase Edge Functions. Deploy them and give them
your R2 credentials (these are **Edge Function secrets**, not app env vars — they never
reach the browser):

```bash
supabase functions deploy generate-upload-url
supabase functions deploy r2-multipart-upload

supabase secrets set \
  R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  R2_ACCESS_KEY="<access-key-id>" \
  R2_SECRET_KEY="<secret-access-key>" \
  R2_BUCKET="<your-bucket-name>" \
  R2_PUBLIC_URL_BASE="https://pub-<hash>.r2.dev" \
  ALLOWED_ORIGIN="https://your-app-url.vercel.app"
```

`ALLOWED_ORIGIN` is optional (defaults to `*`, which is safe here because the functions
authenticate with a bearer token, not cookies) — pin it to your app URL if you like.

## 6. Configure the app

Copy the example env file and fill it in with the values from step 2:

```bash
cp .env.example .env.local
```

- `NEXT_PUBLIC_SUPABASE_URL` — your Project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — your anon key.
- `SUPABASE_SERVICE_ROLE_KEY` — leave blank unless you're running embedded mode.
- Leave `NEXT_PUBLIC_APP_MODE=standalone` and the `HUB_*` values blank.

Every variable is explained inline in `.env.example`.

## 7. Run it locally

```bash
pnpm dev
```

Open http://localhost:3000, sign up, create a workflow, and add a video. Test a big
(>100 MB) file too — that exercises the multipart upload path and confirms your R2 CORS
is correct.

## 8. Deploy to Vercel

1. Import the repo into Vercel.
2. Add the same env vars from your `.env.local` (Settings → Environment Variables).
3. Deploy.
4. Update your R2 bucket's CORS `AllowedOrigins` (and, if you pinned it, the
   `ALLOWED_ORIGIN` secret) to your real deployed URL.

That's it — the app is live and fully yours.

---

## Optional: embedded mode (Build & Launch hub operators only)

If you're embedding this app inside the Build & Launch hub, deploy a **second** Vercel
project from the same repo with:

- `NEXT_PUBLIC_APP_MODE=embedded`
- `HUB_PUBLIC_KEY` — the hub's public key (PEM), provided by the hub operator.
- `HUB_ORIGIN` — the hub's origin(s), space-separated if more than one.
- `SUPABASE_SERVICE_ROLE_KEY` — required in this mode.

Embedded mode must be served from a **subdomain of the hub's own domain**
(`cinematic.buildnlaunchai.com`), never a `*.vercel.app` URL — otherwise the hub token
cookie is treated as third-party and Safari drops it. The standalone project stays
exactly as it is. (See the internal TEMPLATE.md for the full reasoning.)

---

## How it's built

- **Next.js** (App Router) + **Supabase** (Postgres, Auth, Realtime, Edge Functions).
- Everything the app owns lives in the **`cinematic_workflow`** Postgres schema —
  `supabase/migrations/` is the whole backend. A fresh project + `supabase db push`
  is a working database.
- Video + attachments upload straight to **your** Cloudflare R2 bucket.
- Public `/share/<token>` links are served by a single read-only database function
  that hands guests exactly one workflow's contents and nothing else — no account, no
  access to anything unshared.

Run `pnpm run preflight` any time to check the repo is clean (no secrets, no hardcoded
hosts, complete `.env.example`). `pnpm run dist` builds a shippable zip, but only if
preflight passes and the migrations apply cleanly to an empty database.
