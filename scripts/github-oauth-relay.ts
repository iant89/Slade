/**
 * GitHub OAuth relay (core).
 *
 * github.com's OAuth endpoints are not CORS-enabled, so a browser cannot call
 * them directly. This module performs exactly two pass-through calls —
 * `/login/device/code` and `/login/oauth/access_token` — and nothing else:
 *
 *  • no client secret is accepted, forwarded or stored (device flow has none)
 *  • only the OAuth parameters the device flow defines are forwarded
 *  • no request or body is logged
 *
 * It is used two ways: as Vite dev/preview middleware (imported by
 * vite.config.ts, so `npm run dev` just works) and as the shape that
 * `workers/github-oauth-relay` implements for production static hosting.
 */

export const RELAY_BASE_PATH = '/github-oauth'
export const DEVICE_CODE_PATH = `${RELAY_BASE_PATH}/device_code`
export const ACCESS_TOKEN_PATH = `${RELAY_BASE_PATH}/access_token`

const UPSTREAM = {
  deviceCode: 'https://github.com/login/device/code',
  accessToken: 'https://github.com/login/oauth/access_token',
} as const

export const RELAY_ALLOWED_PARAMS: Record<string, string[]> = {
  [DEVICE_CODE_PATH]: ['client_id', 'scope'],
  [ACCESS_TOKEN_PATH]: ['client_id', 'device_code', 'grant_type'],
}

export interface RelayResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  // The relay carries no cookies and no secrets — the browser origin is echoed
  // only so credentialed setups keep working.
  return {
    'Access-Control-Allow-Origin': origin && origin !== 'null' ? origin : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  }
}

/** Pick just the params the flow defines; anything else is dropped on the floor. */
export function filterParams(path: string, input: Record<string, unknown>): Record<string, string> {
  const allowed = RELAY_ALLOWED_PARAMS[path] ?? []
  const out: Record<string, string> = {}
  for (const key of allowed) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) out[key] = value
  }
  return out
}

function parseBody(raw: string, contentType: string): Record<string, unknown> {
  if (!raw) return {}
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw).entries())
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    // Last resort: treat it as a form body. Never echo the raw body back.
    return Object.fromEntries(new URLSearchParams(raw).entries())
  }
}

export async function handleRelayRequest(opts: {
  path: string
  method: string
  contentType?: string
  body?: string
  origin?: string
  fetchImpl?: typeof fetch
}): Promise<RelayResponse> {
  const headers = corsHeaders(opts.origin)
  const route = opts.path.split('?')[0] ?? ''
  const upstream = route === DEVICE_CODE_PATH ? UPSTREAM.deviceCode : route === ACCESS_TOKEN_PATH ? UPSTREAM.accessToken : null

  if (!upstream) {
    return { status: 404, headers, body: JSON.stringify({ error: 'not_found', message: `No relay route for ${route}` }) }
  }
  if (opts.method === 'OPTIONS') return { status: 204, headers, body: '' }
  if (opts.method !== 'POST') {
    return { status: 405, headers, body: JSON.stringify({ error: 'method_not_allowed', message: 'POST only.' }) }
  }

  const params = filterParams(route, parseBody(opts.body ?? '', opts.contentType ?? ''))
  if (!params.client_id) {
    return { status: 400, headers, body: JSON.stringify({ error: 'incorrect_client_credentials', message: 'client_id is required.' }) }
  }

  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(upstream, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
    return { status: res.status, headers, body: await res.text() }
  } catch {
    return {
      status: 502,
      headers,
      body: JSON.stringify({ error: 'relay_upstream_failed', message: 'Could not reach github.com from the relay.' }),
    }
  }
}
