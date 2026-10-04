import type { Plugin } from 'vite'
import type { EventEmitter } from 'node:events'
import { createShellServer } from './shell-server'

export interface ShellServiceOptions {
  token?: string
  root?: string
  port?: string
  autostart?: string
}

export function shellServicePort(options: ShellServiceOptions): number {
  const port = Number(options.port ?? 8788)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SLADE_SHELL_PORT must be an integer between 1 and 65535.')
  return port
}

/** Start the private service with dev/preview, never during a static build. */
export function shellService(options: ShellServiceOptions): Plugin {
  const start = async (httpServer: EventEmitter | null, log: (message: string) => void) => {
    if (options.autostart === 'false') {
      log('[shell] Automatic startup disabled; using the configured external shell port.')
      return
    }
    if (!options.root && !options.token) {
      log('[shell] Browser-only mode. Set SLADE_SHELL_ROOT and SLADE_SHELL_TOKEN in .env.local to auto-start disk and bash services.')
      return
    }
    if (!options.root || !options.token) throw new Error('Shell auto-start requires both SLADE_SHELL_ROOT and SLADE_SHELL_TOKEN. Set them in .env.local or the server environment.')
    if (!httpServer) throw new Error('Shell auto-start requires a Vite HTTP server (not middleware mode).')
    const port = shellServicePort(options)
    const { server, stop } = await createShellServer({ root: options.root, token: options.token })
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error)
        server.once('error', failed)
        server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve() })
      })
    } catch (error) {
      stop()
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(`Shell port ${port} is already in use. Stop the other service, choose SLADE_SHELL_PORT, or set SLADE_SHELL_AUTOSTART=false to use a manually managed backend.`)
      }
      throw error
    }
    const cleanup = () => {
      process.off('SIGINT', cleanup)
      process.off('SIGTERM', cleanup)
      httpServer.off('close', cleanup)
      httpServer.off('error', cleanup)
      stop()
      server.closeAllConnections()
    }
    httpServer.once('close', cleanup)
    httpServer.once('error', cleanup)
    process.once('SIGINT', cleanup)
    process.once('SIGTERM', cleanup)
    log(`[shell] Disk and bash service started on loopback port ${port}. Host-user permissions; token authentication remains required.`)
  }
  return {
    name: 'slade:shell-service',
    async configureServer(server) {
      await start(server.httpServer, (message) => server.config.logger.info(message))
    },
    async configurePreviewServer(server) {
      await start(server.httpServer, (message) => server.config.logger.info(message))
    },
  }
}
