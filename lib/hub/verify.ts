import { importSPKI, jwtVerify, type JWTPayload, type KeyLike } from 'jose'

/**
 * Verification of hub-signed tokens.
 *
 * The hub signs with its RS256 private key; this app verifies with the hub's
 * public key. Asymmetric is required rather than a shared secret: with many
 * distributed apps, a shared secret would let any one app — or anyone who
 * extracted it from any one app's env — forge tokens for every other app. A
 * public key can only verify.
 *
 * Reads process.env directly instead of importing lib/env.server.ts, because it
 * runs in middleware (Edge runtime) where the server-only tripwire's Node
 * assumptions do not apply.
 */

/** The claims this app requires a hub token to assert. */
export interface HubClaims {
  /** The hub's stable user id. Keyed into cinematic_workflow.profiles.hub_user_id. */
  sub: string
  /** The user's email, used to populate the local profile row. */
  email: string
  /**
   * Which tools the hub says this user may open. Read per-request, never stored:
   * persisting it would let a stale row outrank the hub's access engine.
   */
  tools: string[]
}

export type HubVerifyResult =
  | { ok: true; claims: HubClaims }
  | { ok: false; reason: string }

/**
 * The tool id this app answers to in the hub's access model, and the audience it
 * requires on every token. The hub's tool row carries this exact slug.
 *
 * One identifier for both on purpose: an app is one tool, so a token naming this
 * app (`aud`) and a token granting this tool (`tools`) are the same statement.
 */
export const CINEMATIC_TOOL_ID = 'cinematic_workflow'

// Importing the PEM parses it; doing that per request would be wasted work.
// Cached against the raw env value so a key rotation without a redeploy still
// takes effect.
let cachedPem: string | null = null
let cachedKey: KeyLike | null = null

async function getVerificationKey(): Promise<KeyLike> {
  const raw = process.env.HUB_PUBLIC_KEY
  if (!raw) {
    throw new Error('HUB_PUBLIC_KEY is not set — embedded mode cannot verify tokens.')
  }
  const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw

  if (cachedKey && cachedPem === pem) return cachedKey

  const key = await importSPKI(pem, 'RS256')
  cachedPem = pem
  cachedKey = key
  return key
}

function claimsFrom(payload: JWTPayload): HubVerifyResult {
  const { sub, email, tools } = payload as JWTPayload & {
    email?: unknown
    tools?: unknown
  }

  if (typeof sub !== 'string' || sub.length === 0) {
    return { ok: false, reason: 'token has no subject (sub) claim' }
  }
  if (typeof email !== 'string' || email.length === 0) {
    return { ok: false, reason: 'token has no email claim' }
  }

  // An absent tools claim means "no tools", not "all tools". Anything else would
  // make a malformed token more powerful than a well-formed one.
  let toolList: string[] = []
  if (Array.isArray(tools)) {
    toolList = tools.filter((t): t is string => typeof t === 'string')
  }

  return { ok: true, claims: { sub, email, tools: toolList } }
}

/**
 * Verify a hub token. Returns a reason instead of throwing so callers can log the
 * cause while showing the user a locked screen that reveals nothing.
 */
export async function verifyHubToken(token: string): Promise<HubVerifyResult> {
  if (!token) return { ok: false, reason: 'no token supplied' }

  let key: KeyLike
  try {
    key = await getVerificationKey()
  } catch (err) {
    // A missing or malformed key is the deployer's bug, not the user's. It must
    // never read as "this user is unauthorised".
    return {
      ok: false,
      reason: `HUB_PUBLIC_KEY is missing or not a valid PEM public key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  try {
    const { payload } = await jwtVerify(token, key, {
      // Pinning the algorithm defeats the alg:none / HS256-confusion attacks.
      algorithms: ['RS256'],
      // The token must have been minted FOR this app. Every distributed app holds
      // the same hub public key, so without this a token minted for one app
      // verifies at every other — and each app server sees the raw token, so one
      // careless app could replay its users' tokens across the estate. Passing
      // the option both requires and enforces the claim: jose rejects a missing
      // aud as well as a mismatched one.
      audience: CINEMATIC_TOOL_ID,
      clockTolerance: '30s',
      maxTokenAge: '1h',
    })

    // exp is not optional here: jose only enforces exp when the claim exists, so a
    // hub token without one would otherwise be valid forever.
    if (typeof payload.exp !== 'number') {
      return { ok: false, reason: 'token has no expiry (exp) claim' }
    }

    return claimsFrom(payload)
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'token verification failed',
    }
  }
}

/** Whether the hub's claims grant this specific app. */
export function claimsAllowCinematic(claims: HubClaims): boolean {
  return claims.tools.includes(CINEMATIC_TOOL_ID)
}
