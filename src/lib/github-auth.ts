/**
 * GitHub OAuth device flow + token bootstrap.
 *
 * Why a relay? github.com's OAuth endpoints (`/login/device/code`,
 * `/login/oauth/access_token`) are deliberately not CORS-enabled, so a static
 * SPA cannot call them from the browser. The two calls below therefore go to a
 * tiny pass-through relay that only knows those two endpoints and never sees a
 * client secret (the device flow has none — that is the whole point of it).
 *
 *   dev / this repo        →  vite dev-server middleware at /github-oauth
 *   anywhere else          →  bring your own relay URL (Cloudflare Worker
 *                             source ships in workers/github-oauth-relay)
 *
 * Everything else — repos, files, gists, issues — talks to api.github.com
 * directly, because that host *is* CORS-enabled.
 */

import { getUser, lastRateInfo, GitHubError, type GitHubUser } from './github'
import { redactSecrets } from '../providers/base'

/* ------------------------------------------------------------------ */
/* Contract                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SCOPE = 'repo gist read:user'

/** Same-origin relay path used by the bundled dev server / proxy. */
export const DEFAULT_RELAY_PATH = '/github-oauth'

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInSec: number
  /** Server-suggested poll interval, floored at 5s per GitHub's docs. */
  intervalSec: number
}

export type DeviceFlowErrorKind =
  | 'relay_unreachable'
  | 'device_flow_disabled'
  | 'bad_client_id'
  | 'expired'
  | 'denied'
  | 'network'
  | 'unknown'

export class DeviceFlowError extends Error {
  kind: DeviceFlowErrorKind
  constructor(kind: DeviceFlowErrorKind, message: string) {
    super(redactSecrets(message))
    this.name = 'DeviceFlowError'
    this.kind = kind
  }
}

export interface AuthOptions {
  clientId: string
  /** Empty / undefined → same-origin `/github-oauth`. */
  relayUrl?: string
  signal?: AbortSignal
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

function relayEndpoint(relayUrl: string | undefined, path: string): string {
  const base = (relayUrl ?? '').trim()
  if (!base) return `${DEFAULT_RELAY_PATH}${path}`
  return `${base.replace(/\/+$/, '')}${path}`
}

interface GithubOAuthError {
  error?: string
  error_description?: string
  error_uri?: string
}

function explainOAuthError(err: string | undefined, description?: string): DeviceFlowError {
  const suffix = description ? ` (${description})` : ''
  switch (err) {
    case 'device_flow_disabled':
      return new DeviceFlowError(
        'device_flow_disabled',
        'This GitHub OAuth app has "Enable Device Flow" turned off — turn it on in the app\u2019s settings, then try again.',
      )
    case 'incorrect_client_credentials':
      return new DeviceFlowError('bad_client_id', `GitHub does not recognise that Client ID${suffix}.`)
    case 'expired_token':
      return new DeviceFlowError('expired', 'The sign-in code expired. Start the sign-in again to get a fresh code.')
    case 'access_denied':
      return new DeviceFlowError('denied', 'You cancelled the sign-in on GitHub.')
    case 'incorrect_device_code':
      return new DeviceFlowError('unknown', 'GitHub rejected the device code — start the sign-in again.')
    case 'unsupported_grant_type':
      return new DeviceFlowError('unknown', 'The relay sent an unsupported grant type to GitHub.')
    case undefined:
      return new DeviceFlowError('unknown', 'GitHub returned an unexpected response.')
    default:
      return new DeviceFlowError('unknown', `GitHub returned "${err}"${suffix}.`)
  }
}

async function relayPost<T>(url: string, payload: Record<string, string>, o: AuthOptions): Promise<T> {
  const doFetch = o.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: o.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new DeviceFlowError(
      'relay_unreachable',
      'Could not reach the GitHub sign-in relay. Start it with `npm run dev` (bundled), deploy workers/github-oauth-relay, or paste a token instead.',
    )
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    throw new DeviceFlowError(
      'relay_unreachable',
      `The sign-in relay answered with ${res.status} and a non-JSON body — check the relay URL.`,
    )
  }
  if (res.status === 404 && !(json as GithubOAuthError)?.error) {
    throw new DeviceFlowError('relay_unreachable', 'The sign-in relay is not configured at that URL (404).')
  }
  if (!res.ok) {
    const body = (json ?? {}) as GithubOAuthError
    if (body.error) throw explainOAuthError(body.error, body.error_description)
    throw new DeviceFlowError('relay_unreachable', `The sign-in relay failed (${res.status}).`)
  }
  return json as T
}

/* ------------------------------------------------------------------ */
/* Step 1 — ask for a code                                             */
/* ------------------------------------------------------------------ */

export async function requestDeviceCode(o: AuthOptions & { scope?: string }): Promise<DeviceCode> {
  if (!o.clientId.trim()) {
    throw new DeviceFlowError(
      'bad_client_id',
      'Add the Client ID of a GitHub OAuth app (with device flow enabled) in Settings → GitHub.',
    )
  }
  const res = await relayPost<{
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
    error?: string
    error_description?: string
  }>(relayEndpoint(o.relayUrl, '/device_code'), { client_id: o.clientId.trim(), scope: o.scope ?? DEFAULT_SCOPE }, o)

  if (res.error || !res.device_code || !res.user_code) {
    throw explainOAuthError(res.error ?? 'unknown_response', res.error_description)
  }
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri ?? 'https://github.com/login/device',
    verificationUriComplete: res.verification_uri_complete,
    expiresInSec: res.expires_in ?? 900,
    intervalSec: Math.max(5, res.interval ?? 5),
  }
}

/* ------------------------------------------------------------------ */
/* Step 2 — poll for the token                                         */
/* ------------------------------------------------------------------ */

export type PollOutcome =
  | { status: 'authorized'; token: string; scope: string }
  | { status: 'pending' }
  | { status: 'slow_down'; intervalSec: number }
  | { status: 'expired' }
  | { status: 'denied' }

export async function pollOnce(o: AuthOptions & { deviceCode: string }): Promise<PollOutcome> {
  const res = await relayPost<{
    access_token?: string
    token_type?: string
    scope?: string
    error?: string
    error_description?: string
  }>(relayEndpoint(o.relayUrl, '/access_token'), {
    client_id: o.clientId.trim(),
    device_code: o.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }, o)

  if (res.access_token) return { status: 'authorized', token: res.access_token, scope: res.scope ?? '' }
  switch (res.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      // GitHub asks for at least +5s; the relay may forward a new interval.
      return { status: 'slow_down', intervalSec: 5 }
    case 'expired_token':
    case 'incorrect_device_code':
      return { status: 'expired' }
    case 'access_denied':
      return { status: 'denied' }
    default:
      throw explainOAuthError(res.error, res.error_description)
  }
}

export interface RunDeviceFlowOptions extends AuthOptions {
  scope?: string
  /** Called once with the code the user must type on github.com. */
  onCode: (code: DeviceCode) => void
  /** Progress pings so the UI can say "waiting for you on github.com…". */
  onStatus?: (status: 'polling' | 'slow_down') => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * Runs the whole flow: request a code, hand it to the UI, poll until the user
 * authorizes (or the code expires). Cancellation is an `AbortError`.
 */
export async function runDeviceFlow(o: RunDeviceFlowOptions): Promise<{ token: string; scope: string }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const code = await requestDeviceCode(o)
  o.onCode(code)

  let intervalSec = code.intervalSec
  const deadline = Date.now() + code.expiresInSec * 1000

  for (;;) {
    if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    if (Date.now() > deadline) {
      throw new DeviceFlowError('expired', 'The sign-in code expired. Start again to get a fresh code.')
    }
    await sleep(intervalSec * 1000)
    if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError')

    const outcome = await pollOnce({ ...o, deviceCode: code.deviceCode })
    if (outcome.status === 'authorized') return { token: outcome.token, scope: outcome.scope }
    if (outcome.status === 'expired') {
      throw new DeviceFlowError('expired', 'The sign-in code expired. Start again to get a fresh code.')
    }
    if (outcome.status === 'denied') {
      throw new DeviceFlowError('denied', 'You cancelled the sign-in on GitHub.')
    }
    if (outcome.status === 'slow_down') {
      intervalSec += outcome.intervalSec
      o.onStatus?.('slow_down')
      continue
    }
    o.onStatus?.('polling')
  }
}

/* ------------------------------------------------------------------ */
/* Manual token path                                                   */
/* ------------------------------------------------------------------ */

export interface TokenCheck {
  user: GitHubUser
  scopes: string[]
}

/**
 * Validate a token by using it for real. Verifying with `GET /user` is the only
 * honest check: a token can exist and still be revoked, expired or scoped so
 * narrowly that nothing works.
 */
export async function verifyToken(
  token: string,
  o: { baseUrl?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TokenCheck> {
  const clean = token.trim()
  if (!clean) throw new GitHubError('auth', 'No token provided.')
  // Scoped to this call: this module's `fetchImpl` injection is test-only.
  const previous = globalThis.fetch
  if (o.fetchImpl) globalThis.fetch = o.fetchImpl
  try {
    const user = await getUser({ token: clean, baseUrl: o.baseUrl, signal: o.signal })
    return { user, scopes: lastRateInfo().scopes ?? [] }
  } finally {
    if (o.fetchImpl) globalThis.fetch = previous
  }
}

/** `ghp_…` / `github_pat_…` lookalikes are offered as a hint by the UI. */
export function looksLikeToken(value: string): boolean {
  return /^(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})$/.test(value.trim())
}

export const SCOPES_HELP: { scope: string; why: string }[] = [
  { scope: 'repo', why: 'Read repos, browse files, commit published artifacts and open issues (private repos included).' },
  { scope: 'public_repo', why: 'Same as repo, but public repositories only.' },
  { scope: 'gist', why: 'Create gists when you publish an artifact as a gist.' },
  { scope: 'read:user', why: 'Show which account is connected.' },
]
