'use client'

import { useEffect } from 'react'

import { HUB_TOKEN_QUERY_PARAM } from '@/lib/hub/transport'

/**
 * Strips ?hub_token from the URL after the embedded doorway rendered the app.
 *
 * This runs ONLY inside the server-verified, authenticated tree (app/page.tsx
 * renders it next to <CinematicApp>, never on the Locked path), so by the time it
 * mounts the browser is already showing content the server gated on a verified
 * token. It issues no request and re-renders no content — history.replaceState
 * only rewrites the URL bar. It is therefore structurally incapable of exposing
 * anything unverified; it's cosmetic cleanup of the one-request token in the URL.
 */
export function CleanHubTokenUrl() {
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has(HUB_TOKEN_QUERY_PARAM)) {
      url.searchParams.delete(HUB_TOKEN_QUERY_PARAM)
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    }
  }, [])

  return null
}
