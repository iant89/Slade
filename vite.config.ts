import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project sites serve the app under /<repo>/ — the CI workflow
// sets VITE_PUBLIC_BASE accordingly. Local dev and `vite preview` stay at '/'.
const base = process.env.VITE_PUBLIC_BASE ?? '/'

// Slade — single-page app. The dev server binds 0.0.0.0 so it is reachable
// through the sandbox preview proxy, and allows proxy Host headers.
export default defineConfig({
  base,
  plugins: [react()],
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
