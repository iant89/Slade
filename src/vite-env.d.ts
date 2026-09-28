/// <reference types="vite/client" />

/**
 * Build-time defaults for the GitHub integration. Both are public values (an
 * OAuth app's client ID is not a secret) and both can be overridden at runtime
 * in Settings → GitHub.
 */
interface ImportMetaEnv {
  /** Relay that performs the two non-CORS GitHub OAuth calls. */
  readonly VITE_GITHUB_RELAY?: string
  /** Default OAuth app client ID so visitors do not have to create one. */
  readonly VITE_GITHUB_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
