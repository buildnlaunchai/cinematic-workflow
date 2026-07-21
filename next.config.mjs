/**
 * NOTE ON CSP — deliberately minimal. Please read before adding a resource CSP.
 *
 * This app was extracted from an ERP that ran with NO Content-Security-Policy at
 * all (Tailwind via CDN, plain SPA). TEMPLATE.md's browser-runtime rule is that
 * "packaging must not add restrictions the product never had to satisfy." Two
 * things this app does would break under a naive resource CSP, and both would
 * fail in ways that look like anything except a CSP:
 *
 *   1. Video playback + downloads stream from Cloudflare R2, whose public domain
 *      is BYOK and therefore unknown at build time (R2_PUBLIC_URL_BASE is a
 *      per-deployer env value). A pinned media-src/connect-src allowlist can't
 *      name a host we don't know, so it would block every video.
 *   2. The workspace builds video thumbnails and handles uploads via
 *      URL.createObjectURL → blob: URLs. A connect-src that omits blob: turns
 *      thumbnail/upload fetches into a bare "Failed to fetch".
 *
 * So we set NO resource CSP. The only CSP directive emitted is frame-ancestors,
 * and only in embedded mode, because that one is a security control we DO know
 * the answer to at deploy time (the hub origins). If you later add a resource
 * CSP, it must include `blob:` in connect-src and the R2 public origin in
 * media-src/img-src — and be tested against a real deployed video before shipping.
 */

const APP_MODE = process.env.NEXT_PUBLIC_APP_MODE ?? 'standalone'
const HUB_ORIGIN = process.env.HUB_ORIGIN

/**
 * Who is allowed to put this app in an iframe.
 *
 * Embedded mode has a known set of legitimate embedders — the hub — known at
 * deploy time, so we pin it. Without this, any site could frame the app and ride
 * a signed-in member's session.
 *
 * HUB_ORIGIN may name MORE THAN ONE origin, space-separated: the hub answers at
 * both the apex and the www subdomain, and client-side navigation can leave the
 * parent on either. Both are the hub's own domains, so listing both is not a
 * widening of trust — it is naming one trusted party by both its addresses.
 *
 * Standalone deployments emit nothing, deliberately: which origins may embed a
 * distributor's own deployment is their call, not ours.
 *
 * frame-ancestors, not X-Frame-Options: XFO cannot express a specific origin or a
 * list, and frame-ancestors is what browsers actually enforce.
 *
 * Missing HUB_ORIGIN in embedded mode fails the BUILD rather than shipping an app
 * any site can frame — a misconfigured embedded deployment should be loud
 * immediately, not a quiet weakness discovered later.
 */
function frameAncestorsValue() {
  if (APP_MODE !== 'embedded') return null
  if (!HUB_ORIGIN || !HUB_ORIGIN.trim()) {
    // No example URL here on purpose: preflight fails the build on a hardcoded
    // host in code. .env.example is where the example value lives.
    throw new Error(
      'HUB_ORIGIN is not set, but NEXT_PUBLIC_APP_MODE=embedded needs it to pin ' +
        'frame-ancestors to the hub. Set it to the hub origin(s) — scheme and ' +
        'host, no trailing slash; space-separate more than one. See .env.example.',
    )
  }
  // Collapse stray whitespace (a dashboard paste can carry newlines) so the
  // directive is always a clean single-spaced origin list. 'self' is included
  // because the app may frame its own routes (e.g. the workspace opens the
  // fullscreen player); frame-ancestors requires every ancestor to match.
  const origins = HUB_ORIGIN.trim().split(/\s+/).join(' ')
  return `'self' ${origins}`
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async headers() {
    const frameAncestors = frameAncestorsValue()
    return [
      {
        // Site-wide security floor. frame-ancestors is added only in embedded
        // mode (see frameAncestorsValue); standalone emits none, because a
        // blanket X-Frame-Options: DENY would break a distributor embedding
        // their own deployment, which is their choice to make.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          ...(frameAncestors
            ? [{ key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors}` }]
            : []),
        ],
      },
    ]
  },
}

export default nextConfig
