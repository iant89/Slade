import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { handleRelayRequest } from './scripts/github-oauth-relay'

// GitHub Pages project sites serve the app under /<repo>/ — the CI workflow
// sets VITE_PUBLIC_BASE accordingly. Local dev and `vite preview` stay at '/'.
const base = process.env.VITE_PUBLIC_BASE ?? '/'

/**
 * Serves the two GitHub OAuth endpoints the device flow needs.
 *
 * They cannot be called from the browser directly (github.com is not
 * CORS-enabled for them), so dev + preview proxy them here, server-side. The
 * same contract is implemented by workers/github-oauth-relay for production.
 */
function githubOAuthRelay(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? ''
    if (!url.startsWith('/github-oauth/')) {
      next()
      return
    }

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      // Guard the relay against oversized bodies — these payloads are tiny.
      if (raw.length > 16_384) req.destroy()
    })
    req.on('end', () => {
      void handleRelayRequest({
        path: url,
        method: req.method ?? 'GET',
        contentType: String(req.headers['content-type'] ?? ''),
        body: raw,
        origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      }).then((out) => {
        res.writeHead(out.status, out.headers)
        res.end(out.body)
      })
    })
  }

  return {
    name: 'slade:github-oauth-relay',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

// Slade — single-page app. The dev server binds 0.0.0.0 so it is reachable
// through the sandbox preview proxy, and allows proxy Host headers.
export default defineConfig({
  base,
  plugins: [react(), githubOAuthRelay()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
})
