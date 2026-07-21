import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

type CookiesToSet = { name: string; value: string; options: CookieOptions }[]

import { APP_MODE } from './lib/mode'
import { verifyHubToken, claimsAllowCinematic } from './lib/hub/verify'
import {
  HUB_TOKEN_COOKIE,
  HUB_TOKEN_QUERY_PARAM,
  hubCookieOptions,
  isSecureRequest,
} from './lib/hub/transport'

/**
 * The gate, for both modes.
 *
 * Only the app root `/` is protected. The public guest-share viewer
 * (`/share/<token>`) is deliberately NOT protected in either mode — guests have
 * no account and no hub token, and the RPC behind it returns only a fixed public
 * projection. `/login` and `/locked` are their own concern.
 */
function isProtectedPath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/settings')
}

// ---------------------------------------------------------------------------
// Embedded mode
// ---------------------------------------------------------------------------

async function embeddedMiddleware(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl
  const secure = isSecureRequest(new URL(req.url), req.headers.get('x-forwarded-proto'))

  // --- Doorway: a token on the URL is exchanged for a cookie, once. ---
  const queryToken = url.searchParams.get(HUB_TOKEN_QUERY_PARAM)
  if (queryToken) {
    const result = await verifyHubToken(queryToken)

    const clean = url.clone()
    clean.searchParams.delete(HUB_TOKEN_QUERY_PARAM)

    if (!result.ok) {
      console.warn(`[hub] rejected token from query: ${result.reason}`)
      return NextResponse.redirect(clean)
    }

    const res = NextResponse.redirect(clean)
    res.cookies.set(HUB_TOKEN_COOKIE, queryToken, hubCookieOptions(secure))
    return res
  }

  if (!isProtectedPath(url.pathname)) return NextResponse.next()

  // --- Every request to a protected path: re-verify the cookie. ---
  const cookieToken = req.cookies.get(HUB_TOKEN_COOKIE)?.value
  if (!cookieToken) {
    return denyEmbedded(req, 'no hub token')
  }

  const result = await verifyHubToken(cookieToken)
  if (!result.ok) {
    const res = denyEmbedded(req, result.reason)
    res.cookies.delete(HUB_TOKEN_COOKIE)
    return res
  }

  if (!claimsAllowCinematic(result.claims)) {
    // A valid hub user not granted this tool. The hub's access engine decides
    // that; this app just honours it — which is why the check reads the token
    // every time instead of a row in our database.
    return denyEmbedded(req, 'token does not grant this tool')
  }

  return NextResponse.next()
}

/**
 * Deny in embedded mode. Never a redirect to this app's own login: in embedded
 * mode the app has no login. The page shows a locked state.
 */
function denyEmbedded(req: NextRequest, reason: string): NextResponse {
  console.warn(`[hub] denied ${req.nextUrl.pathname}: ${reason}`)

  const locked = req.nextUrl.clone()
  locked.pathname = '/locked'
  locked.search = ''
  return NextResponse.rewrite(locked)
}

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

async function standaloneMiddleware(req: NextRequest): Promise<NextResponse> {
  let res = NextResponse.next({ request: req })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    return new NextResponse(
      'Supabase is not configured. Copy .env.example to .env.local and fill it in.',
      { status: 500 },
    ) as NextResponse
  }

  const supabase = createServerClient(url, anonKey, {
    db: { schema: 'cinematic_workflow' },
    cookies: {
      getAll() {
        return req.cookies.getAll()
      },
      setAll(cookiesToSet: CookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value))
        res = NextResponse.next({ request: req })
        cookiesToSet.forEach(({ name, value, options }) =>
          res.cookies.set(name, value, options),
        )
      },
    },
  })

  // getUser(), not getSession(): getSession reads the cookie without checking it
  // with the auth server, so a forged cookie would pass. This call also refreshes
  // an expiring token, which is why it runs on every request.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user && isProtectedPath(req.nextUrl.pathname)) {
    const login = req.nextUrl.clone()
    login.pathname = '/login'
    login.search = ''
    return NextResponse.redirect(login)
  }

  // Already signed in and staring at the login page — send them to the app.
  if (user && req.nextUrl.pathname === '/login') {
    const home = req.nextUrl.clone()
    home.pathname = '/'
    return NextResponse.redirect(home)
  }

  return res
}

// ---------------------------------------------------------------------------

export async function middleware(req: NextRequest): Promise<NextResponse> {
  return APP_MODE === 'embedded' ? embeddedMiddleware(req) : standaloneMiddleware(req)
}

export const config = {
  // Everything except Next's own build output and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
