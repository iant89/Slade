/**
 * Slade's GitHub OAuth relay — a Cloudflare Worker.
 *
 * Slade is a static SPA, and github.com's OAuth endpoints send no CORS headers,
 * so the browser cannot call them. This worker performs exactly two
 * pass-through calls and nothing else:
 *
 *   POST /github-oauth/device_code    → https://github.com/login/device/code
 *   POST /github-oauth/access_token   → https://github.com/login/oauth/access_token
 *
 * Security notes, because this thing touches OAuth traffic:
 *   • No client secret is involved. The device flow is designed to work without
 *     one, so there is no secret to leak or rotate.
 *   • Only the parameters the flow defines are forwarded (client_id, scope,
 *     device_code, grant_type). Anything else in the request body is dropped —
 *     including a client_secret someone might paste in by habit.
 *   • Nothing is logged. Responses from GitHub are returned verbatim.
 *   • The access token goes to the browser that asked for it, which is where it
 *     is stored (local storage, same as Slade's provider API keys).
 *
 * Deploy:
 *   cd workers/github-oauth-relay
 *   npx wrangler deploy
 * then paste the printed URL into Slade → Settings → GitHub → Sign-in relay.
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

const ALLOWED: Record<string, string[]> = {
  '/github-oauth/device_code': ['client_id', 'scope'],
  '/github-oauth/access_token': ['client_id', 'device_code', 'grant_type'],
}

function cors(origin: string | null): Record<string, string> {
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

async function readParams(request: Request, allowed: string[]): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? ''
  let input: Record<string, unknown> = {}
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      input = Object.fromEntries((await request.formData()).entries())
    } else {
      const parsed = await request.json()
      if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>
    }
  } catch {
    input = {}
  }
  const out: Record<string, string> = {}
  for (const key of allowed) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) out[key] = value
  }
  return out
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const headers = cors(request.headers.get('origin'))
    const allowed = ALLOWED[url.pathname]

    if (!allowed) {
      return new Response(JSON.stringify({ error: 'not_found', message: `No relay route for ${url.pathname}` }), {
        status: 404,
        headers,
      })
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'POST only.' }), { status: 405, headers })
    }

    const params = await readParams(request, allowed)
    if (!params.client_id) {
      return new Response(JSON.stringify({ error: 'incorrect_client_credentials', message: 'client_id is required.' }), {
        status: 400,
        headers,
      })
    }

    const upstreamUrl = url.pathname.endsWith('device_code') ? DEVICE_CODE_URL : ACCESS_TOKEN_URL
    let upstream: Response
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      })
    } catch {
      return new Response(
        JSON.stringify({ error: 'relay_upstream_failed', message: 'Could not reach github.com from the relay.' }),
        { status: 502, headers },
      )
    }

    return new Response(await upstream.text(), { status: upstream.status, headers })
  },
}
