import { createDiskHandler } from './disk-files'
import { createServer, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { resolve, relative, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

/** Trusted single-user service. A cwd is NOT a security sandbox. */
export async function createShellServer(config: { token: string; root: string; maxTimeoutMs?: number }) {
  if (config.token.length < 32) throw new Error('SLADE_SHELL_TOKEN must be at least 32 characters.')
  const root = await realpath(config.root)
  if (!(await stat(root)).isDirectory()) throw new Error('Shell root must be a directory.')
  const diskHandler = createDiskHandler(root)
  const active = new Set<() => void>()
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${config.token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, { error: 'Shell authentication required.' })
    if (req.url?.startsWith('/api/shell/files/')) { await diskHandler(req, res); return }
    if (req.method === 'GET' && req.url === '/api/shell/health') return json(200, { root, automatic: true, filesystem: 'disk-v1' })
    if (req.method !== 'POST' || req.url !== '/api/shell/execute') return json(404, { error: 'Not found.' })
    if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Expected JSON.' })
    try {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk.toString()
        if (Buffer.byteLength(raw) > 16_384) { json(413, { error: 'Command request too large.' }); return }
      }
      const body = JSON.parse(raw)
      if (!body || typeof body.command !== 'string' || !body.command.trim() || body.command.length > 8000 ||
          (body.cwd !== undefined && typeof body.cwd !== 'string') ||
          (body.timeoutMs !== undefined && (!Number.isFinite(body.timeoutMs) || body.timeoutMs < 1))) {
        return json(400, { error: 'Invalid command, cwd, or timeout.' })
      }
      const cwd = await realpath(resolve(root, body.cwd || '.'))
      const rel = relative(root, cwd)
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return json(400, { error: 'cwd must be inside the configured shell root.' })
      if (!(await stat(cwd)).isDirectory()) return json(400, { error: 'cwd is not a directory.' })
      if (active.size >= 4) return json(429, { error: 'Too many commands running (maximum 4).' })
      if (res.destroyed) return
      execute(res, body.command, cwd, Math.min(body.timeoutMs ?? 120_000, config.maxTimeoutMs ?? 300_000), active)
    } catch (error) {
      if (!res.headersSent) json(400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : 'Invalid or unavailable working directory.' })
    }
  })
  // Request-body limits/timeouts do not limit the streamed command response.
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return { server, stop: () => { for (const cancel of active) cancel(); server.close() } }
}

function execute(res: ServerResponse, command: string, cwd: string, timeout: number, active: Set<() => void>) {
  const startedAt = Date.now()
  const started = performance.now()
  const emit = (event: unknown) => {
    if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`)
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
  emit({ type: 'started', startedAt })
  // Do not leak server tokens / provider credentials into child environment.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TERM: 'dumb', CI: '1' }
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let reason = ''
  let bytes = 0
  let stopping = false
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid) { try { process.kill(-child.pid, signal) } catch { /* Already exited. */ } }
  }
  const cancel = () => {
    if (stopping) return
    stopping = true
    killGroup('SIGTERM')
    // Keep escalation even if bash exits first: its descendants may ignore TERM.
    setTimeout(() => killGroup('SIGKILL'), 500).unref()
  }
  active.add(cancel)
  const timer = setTimeout(() => { reason = `Command timed out after ${timeout}ms.`; cancel() }, timeout)
  const disconnect = () => { reason ||= 'Client disconnected.'; cancel() }
  res.on('close', disconnect)
  const output = (text: string) => {
    if (stopping) return
    bytes += Buffer.byteLength(text)
    if (bytes > 256 * 1024) { reason = 'Output limit exceeded (256 KiB).'; cancel(); return }
    emit({ type: 'output', text })
    if (res.writableLength > 512 * 1024) { reason = 'Output consumer too slow.'; cancel() }
  }
  child.stdout.setEncoding('utf8').on('data', output)
  child.stderr.setEncoding('utf8').on('data', output)
  child.on('error', (error) => { reason = `Unable to execute bash: ${error.message}` })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    cancel() // Do not leave background descendants after their parent finishes.
    active.delete(cancel)
    res.off('close', disconnect)
    const durationMs = Math.max(0, Math.round(performance.now() - started))
    emit({ type: 'done', startedAt, finishedAt: startedAt + durationMs, exitCode: code,
      status: !reason && code === 0 ? 'finished' : 'failed', error: reason || (signal ? `Terminated by ${signal}.` : undefined) })
    res.end()
  })
}
