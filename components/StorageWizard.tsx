'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  HardDrive, ExternalLink, Copy, Check, Loader2, CircleCheck, CircleX,
  CircleAlert, ArrowLeft, Trash2,
} from 'lucide-react'

import {
  saveStorageCredentials, deleteStorageCredentials, setStorageVerified,
  presignUpload, deleteStorageObject,
} from '@/lib/actions/storage'
import type { StorageCredentialsInput, StorageStatus } from '@/types'

/**
 * Guided setup for connecting your own Cloudflare R2 bucket. Written for someone
 * who has never touched an S3 bucket: every step says exactly where to click.
 * The two keys are only ever sent to the server, encrypted there, and never shown
 * again — the form clears them on save.
 */
export function StorageWizard({ initialStatus }: { initialStatus: StorageStatus }) {
  const [status, setStatus] = useState<StorageStatus>(initialStatus)
  const [origin, setOrigin] = useState<string>(process.env.NEXT_PUBLIC_SITE_URL ?? '')

  useEffect(() => {
    if (!origin && typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [origin])

  const corsJson = useMemo(
    () =>
      JSON.stringify(
        [
          {
            AllowedOrigins: [origin || '<your app URL>'],
            AllowedMethods: ['GET', 'PUT'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
          },
        ],
        null,
        2,
      ),
    [origin],
  )

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-2xl px-5 py-10">
        <a href="/" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 mb-6">
          <ArrowLeft size={15} /> Back to workspace
        </a>

        <header className="mb-8">
          <div className="flex items-center gap-2.5 text-sky-400">
            <HardDrive size={22} />
            <h1 className="font-jakarta text-xl font-extrabold text-slate-100">Connect your storage</h1>
          </div>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            Your videos and attachments upload straight to <strong>your own</strong> Cloudflare R2
            bucket — nobody else's, and no shared bill. It's a one-time setup, a few minutes. Follow
            the steps in order; you can copy anything you need to paste.
          </p>
          <StatusBanner status={status} />
        </header>

        <ol className="space-y-8">
          <Step n={1} title="Create a storage bucket">
            <p>
              Open the Cloudflare dashboard, go to <b>R2</b> in the left sidebar, and click{' '}
              <b>Create bucket</b>. Give it any name (for example <code className="chip">cinematic-footage</code>)
              and create it. If you don't have R2 enabled yet, Cloudflare will walk you through enabling it —
              it's free to start.
            </p>
            <a
              href="https://dash.cloudflare.com/?to=/:account/r2/new"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-link"
            >
              Open Cloudflare R2 <ExternalLink size={13} />
            </a>
          </Step>

          <Step n={2} title="Allow this app to upload (CORS)">
            <p>
              Open your new bucket → <b>Settings</b> → <b>CORS Policy</b> → <b>Edit</b>, and paste exactly this,
              then <b>Save</b>. This lets your browser upload to the bucket from this app, and — the part
              everyone forgets — exposes the <code className="chip">ETag</code> header that large uploads
              need. Without it, big files fail near the end.
            </p>
            <CodeBlock text={corsJson} />
            <p className="text-xs text-slate-500">
              The <code className="chip">AllowedOrigins</code> value is this app's address
              {origin ? '' : ' (it will fill in once the page loads)'} — leave it as shown.
            </p>
          </Step>

          <Step n={3} title="Create an access token">
            <p>
              In <b>R2</b>, click <b>Manage R2 API Tokens</b> (top-right) → <b>Create API token</b>. Choose{' '}
              <b>Object Read &amp; Write</b>, and under <b>Specify bucket(s)</b> pick the bucket you just made
              (scoping it to one bucket is safest). Create the token, then copy the{' '}
              <b>Access Key ID</b> and <b>Secret Access Key</b> it shows you — you'll paste them below.
            </p>
            <p className="text-xs text-amber-400/90">
              Cloudflare shows the Secret Access Key only once. Copy it before leaving that page.
            </p>
            <a
              href="https://dash.cloudflare.com/?to=/:account/r2/api-tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-link"
            >
              Manage R2 API Tokens <ExternalLink size={13} />
            </a>
          </Step>

          <Step n={4} title="Paste your bucket details">
            <CredentialsForm
              status={status}
              onSaved={(s) => setStatus(s)}
            />
          </Step>

          <Step n={5} title="Test the connection">
            <p>
              Before you upload real footage, run a quick check. This uploads a tiny test file to your bucket
              and deletes it — proving your keys, your bucket, and the CORS policy all actually work end to end.
            </p>
            <TestConnection
              disabled={!status.connected}
              onResult={(ok, msg) =>
                setStatus((s) => ({ ...s, status: ok ? 'valid' : 'invalid', last_error: ok ? null : (msg ?? null) }))
              }
            />
            {!status.connected && (
              <p className="text-xs text-slate-500">Save your bucket details in Step 4 first.</p>
            )}
          </Step>
        </ol>
      </div>

      <style>{`
        .chip { background:#1e293b; color:#e2e8f0; padding:1px 6px; border-radius:6px; font-size:0.85em; }
        .btn-link { display:inline-flex; align-items:center; gap:6px; margin-top:10px; font-size:13px;
          font-weight:700; color:#38bdf8; }
        .btn-link:hover { color:#7dd3fc; }
      `}</style>
    </main>
  )
}

function StatusBanner({ status }: { status: StorageStatus }) {
  if (!status.connected) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3.5 py-2.5 text-sm text-slate-400">
        <CircleAlert size={16} className="text-slate-500" />
        No storage connected yet — you'll be able to upload once this is done.
      </div>
    )
  }
  if (status.status === 'valid') {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-sm text-emerald-300">
        <CircleCheck size={16} /> Connected to <b>{status.r2_bucket}</b> · key {status.access_key_hint} · verified and ready.
      </div>
    )
  }
  if (status.status === 'invalid') {
    return (
      <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-300">
        <div className="flex items-center gap-2 font-semibold"><CircleX size={16} /> Last test failed</div>
        {status.last_error && <p className="mt-1 text-rose-200/80 text-xs">{status.last_error}</p>}
      </div>
    )
  }
  return (
    <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-300">
      <CircleAlert size={16} /> Saved to <b>{status.r2_bucket}</b> but not tested yet — run the test in Step 5.
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="relative pl-11">
      <span className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-400 font-bold text-sm">
        {n}
      </span>
      <h2 className="font-jakarta text-base font-bold text-slate-100 pt-1">{title}</h2>
      <div className="mt-2 space-y-2 text-sm text-slate-400 leading-relaxed [&_b]:text-slate-200 [&_strong]:text-slate-200">
        {children}
      </div>
    </li>
  )
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative mt-2">
      <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300 font-dcmono">
        {text}
      </pre>
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const EMPTY: StorageCredentialsInput = {
  r2_endpoint: '', r2_bucket: '', r2_public_url_base: '', access_key_id: '', secret_key: '',
}

function CredentialsForm({ status, onSaved }: { status: StorageStatus; onSaved: (s: StorageStatus) => void }) {
  const [form, setForm] = useState<StorageCredentialsInput>({
    ...EMPTY,
    r2_endpoint: status.r2_endpoint ?? '',
    r2_bucket: status.r2_bucket ?? '',
    r2_public_url_base: status.r2_public_url_base ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const set = (k: keyof StorageCredentialsInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null); setSaved(false)
    try {
      const res = await saveStorageCredentials(form)
      onSaved({
        connected: true, status: 'unverified',
        r2_endpoint: form.r2_endpoint.trim(), r2_bucket: form.r2_bucket.trim(),
        r2_public_url_base: form.r2_public_url_base.trim().replace(/\/+$/, ''),
        access_key_hint: res.access_key_hint, last_error: null, last_verified_at: null,
      })
      // Never keep the secrets in the form after they've been stored.
      setForm((f) => ({ ...f, access_key_id: '', secret_key: '' }))
      setSaved(true)
    } catch (err: any) {
      setError(err?.message ?? 'Could not save. Check the values and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 space-y-3">
      <Field label="S3 API endpoint" hint="R2 → your bucket → Settings → S3 API. Looks like https://<account-id>.r2.cloudflarestorage.com">
        <input className="inp" value={form.r2_endpoint} onChange={set('r2_endpoint')} placeholder="https://<account-id>.r2.cloudflarestorage.com" disabled={busy} required />
      </Field>
      <Field label="Bucket name" hint="The exact name from Step 1.">
        <input className="inp" value={form.r2_bucket} onChange={set('r2_bucket')} placeholder="cinematic-footage" disabled={busy} required />
      </Field>
      <Field label="Public URL base" hint="R2 → your bucket → Settings → Public access → enable the r2.dev URL (or a custom domain), then paste it here.">
        <input className="inp" value={form.r2_public_url_base} onChange={set('r2_public_url_base')} placeholder="https://<pub-hash>.r2.dev" disabled={busy} required />
      </Field>
      <Field label="Access Key ID" hint="From the API token you created in Step 3.">
        <input className="inp" value={form.access_key_id} onChange={set('access_key_id')} placeholder={status.access_key_hint ? `Saved (${status.access_key_hint}) — paste again to replace` : ''} autoComplete="off" disabled={busy} required={!status.connected} />
      </Field>
      <Field label="Secret Access Key" hint="Cloudflare shows this only once. It is encrypted on save and never shown again.">
        <input className="inp" type="password" value={form.secret_key} onChange={set('secret_key')} placeholder={status.connected ? 'Saved — paste again to replace' : ''} autoComplete="off" disabled={busy} required={!status.connected} />
      </Field>

      <div className="min-h-[1.25rem] text-sm" aria-live="polite">
        {error && <span className="text-rose-400">{error}</span>}
        {saved && <span className="text-emerald-400">Saved and encrypted. Now run the test in Step 5.</span>}
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white text-sm font-bold px-4 py-2 transition-colors">
          {busy ? 'Saving…' : status.connected ? 'Update storage' : 'Save storage'}
        </button>
        {status.connected && (
          <DisconnectButton onDone={() => onSaved({ connected: false, status: null, r2_endpoint: null, r2_bucket: null, r2_public_url_base: null, access_key_hint: null, last_error: null, last_verified_at: null })} />
        )}
      </div>

      <style>{`
        .inp { width:100%; border-radius:8px; background:#1e293b; border:1px solid #334155; padding:9px 11px;
          font-size:13px; color:#e2e8f0; outline:none; }
        .inp:focus { border-color:#0ea5e9; box-shadow:0 0 0 1px #0ea5e9; }
      `}</style>
    </form>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold uppercase tracking-wide text-slate-400 mb-1">{label}</span>
      {children}
      <span className="block mt-1 text-xs text-slate-500">{hint}</span>
    </label>
  )
}

function DisconnectButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!confirm('Disconnect this storage? Videos already uploaded stay in your bucket, but new uploads will be blocked until you reconnect.')) return
        setBusy(true)
        try { await deleteStorageCredentials(); onDone() } catch { /* ignore */ } finally { setBusy(false) }
      }}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-rose-400"
    >
      <Trash2 size={13} /> Disconnect
    </button>
  )
}

function TestConnection({ disabled, onResult }: { disabled: boolean; onResult: (ok: boolean, msg?: string) => void }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg?: string } | null>(null)

  async function run() {
    setTesting(true); setResult(null)
    try {
      const name = `__cinematic_connection_test__-${Math.random().toString(36).slice(2)}.txt`
      const { signedUrl, key } = await presignUpload(name)

      let put: Response
      try {
        put = await fetch(signedUrl, { method: 'PUT', body: new Blob(['cinematic connection test']) })
      } catch {
        // fetch throws before any response = the browser blocked it (CORS).
        throw new Error(
          "Your browser couldn't reach the bucket. This almost always means the CORS rule from Step 2 hasn't been saved, or doesn't include this app's address. Go back to Step 2, paste the policy exactly as shown, click Save, and test again.",
        )
      }
      if (!put.ok) {
        if (put.status === 403) throw new Error(
          "Your bucket refused the upload — the access keys don't have permission. Re-copy the Access Key ID and Secret Access Key from Step 3 and paste them again in Step 4; one wrong character is enough to cause this, and check the token was set to “Object Read & Write” for this bucket.",
        )
        if (put.status === 404) throw new Error(
          "Your bucket couldn't be found. Double-check the bucket name and the endpoint address in Step 4 — a small typo is the usual cause.",
        )
        throw new Error(
          "Your bucket refused the test upload. Double-check the details you entered in Step 4, and that the CORS policy from Step 2 has been saved.",
        )
      }
      const etag = put.headers.get('ETag') || put.headers.get('etag')
      if (!etag) {
        throw new Error(
          "Almost there — the test file uploaded, but one setting is missing. Your bucket's CORS policy needs to “expose” the ETag header. Go back to Step 2 and make sure the policy includes the ExposeHeaders line with ETag, then Save. (Large videos fail near the end without it.)",
        )
      }

      await deleteStorageObject(key).catch(() => {}) // best-effort cleanup
      await setStorageVerified(true)
      setResult({ ok: true })
      onResult(true)
    } catch (err: any) {
      const msg = err?.message ?? 'Connection test failed.'
      await setStorageVerified(false, msg).catch(() => {})
      setResult({ ok: false, msg })
      onResult(false, msg)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={disabled || testing}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-sm font-bold px-4 py-2 transition-colors"
      >
        {testing ? <Loader2 size={15} className="animate-spin" /> : <CircleCheck size={15} />}
        {testing ? 'Testing…' : 'Test connection'}
      </button>

      {result?.ok && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-sm text-emerald-300">
          <CircleCheck size={16} /> All good — upload, CORS and ETag are working. You're ready to add footage.
        </div>
      )}
      {result && !result.ok && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-300">
          <div className="flex items-center gap-2 font-semibold"><CircleX size={16} /> Test failed</div>
          <p className="mt-1 text-rose-200/90 text-xs leading-relaxed">{result.msg}</p>
        </div>
      )}
    </div>
  )
}
