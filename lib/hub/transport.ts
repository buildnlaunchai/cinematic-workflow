/**
 * How a hub token reaches this app.
 *
 * THE CONTRACT (the hub mints these tokens; wiring a live hub is a later step):
 *
 *   0. In embedded mode this app is served from a SUBDOMAIN OF THE HUB —
 *      cinematic.buildnlaunchai.com, alongside the hub's www.buildnlaunchai.com.
 *      That is what makes step 2 possible: it puts the iframe on the hub's own
 *      site, so the cookie below is first-party. See "Embedded apps are served
 *      from a hub subdomain" in TEMPLATE.md before changing where this is hosted.
 *   1. The hub loads this app in an iframe with the token on the URL:
 *        https://<app>/?hub_token=<RS256 JWT>
 *   2. The app verifies the signature, then immediately swaps the token into an
 *      httpOnly cookie and redirects to the clean URL.
 *   3. Every later request re-verifies the cookie. The token stays the source of
 *      truth; nothing about access is cached or written to the database.
 *
 * A URL is a bad long-term home for a token (logs, history, Referer). Step 2
 * exists so the token spends exactly one request there and lives the rest of its
 * life in a cookie the page's JavaScript cannot read.
 */

export const HUB_TOKEN_QUERY_PARAM = 'hub_token'
export const HUB_TOKEN_COOKIE = 'hub_token'

/**
 * Cookie options for the hub token.
 *
 * SameSite=Lax. "Same-site" is decided by the registrable domain (eTLD+1), not
 * the origin: the hub serves this app from cinematic.buildnlaunchai.com and
 * itself from www.buildnlaunchai.com, so both are buildnlaunchai.com and the
 * iframe is FIRST-party. Lax cookies are sent on same-site requests, iframes
 * included — and Lax adds CSRF defence and working local http dev that
 * SameSite=None (which demands Secure) would cost. If an app ever genuinely must
 * be embedded cross-site, the answer is CHIPS (`SameSite=None; Secure;
 * Partitioned`), not quietly flipping this line.
 */
export function hubCookieOptions(isSecureRequest: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest,
    path: '/',
    // NO `domain` attribute, deliberately: host-only for this subdomain. Setting
    // domain to '.buildnlaunchai.com' would send this app's hub token to the hub
    // and to every sibling app — handing each a working token for all the others.
    // The `aud` claim exists to stop exactly that replay; a Domain attribute would
    // reopen it one layer down. No maxAge either: a session cookie, the token's
    // own `exp` is the real deadline and is checked on every request.
  }
}

/** Whether the request arrived over HTTPS, accounting for a proxy like Vercel. */
export function isSecureRequest(url: URL, forwardedProto: string | null): boolean {
  if (forwardedProto) return forwardedProto.split(',')[0].trim() === 'https'
  return url.protocol === 'https:'
}
