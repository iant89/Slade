import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, preview, loadEnv } from 'vite'
import { shellService, shellServicePort, type ShellServiceOptions } from './shell-plugin'

const root = await mkdtemp(join(tmpdir(), 'slade-startup-'))
const token = 'startup-test-token-not-a-real-credential-1234567890'
async function freePort() {
  const probe = createHttpServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
}
async function startWithStub(options: ShellServiceOptions) {
  const hook = shellService(options).configureServer
  assert(typeof hook === 'function')
  return hook.call({} as never, { httpServer: createHttpServer(), config: { logger: { info() {} } } } as never)
}
try {
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist/index.html'), '<h1>Preview fixture</h1>')
  await writeFile(join(root, '.env.local'), `SLADE_SHELL_TOKEN=${token}\nSLADE_SHELL_ROOT=${root}\n`)
  const env = loadEnv('development', root, 'SLADE_')
  assert.equal(env.SLADE_SHELL_ROOT, root)
  assert.equal(env.SLADE_SHELL_TOKEN, token)
  assert.throws(() => shellServicePort({ port: 'invalid' }), /SLADE_SHELL_PORT/)
  assert.equal(shellServicePort({}), 8788)
  const port = await freePort()
  const target = `http://127.0.0.1:${port}`
  const options = { root: env.SLADE_SHELL_ROOT, token: env.SLADE_SHELL_TOKEN, port: String(port) }
  const dev = await createServer({ configFile: false, root, logLevel: 'silent', plugins: [shellService(options)], server: { watch: null, host: '127.0.0.1', port: 0, proxy: { '/api/shell': { target } } } })
  try {
    await dev.listen()
    const address = dev.httpServer!.address()
    assert(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/api/shell/health`
    assert.equal((await fetch(url)).status, 401)
    const health = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).root, root)
    await dev.restart()
    const restarted = await fetch(`${target}/api/shell/health`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(restarted.status, 200)
    await assert.rejects(startWithStub(options), /already in use/)
  } finally { await dev.close() }
  await assert.rejects(fetch(`${target}/api/shell/health`, { signal: AbortSignal.timeout(1000) }))

  const page = await preview({ configFile: false, root, logLevel: 'silent', plugins: [shellService(options)], preview: { host: '127.0.0.1', port: 0, proxy: { '/api/shell': { target } } } })
  try {
    const address = page.httpServer.address()
    assert(address && typeof address !== 'string')
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/shell/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
  } finally {
    await new Promise<void>((resolve) => { page.httpServer.close(() => resolve()); (page.httpServer as ReturnType<typeof createHttpServer>).closeAllConnections() })
  }
  await assert.rejects(fetch(`${target}/api/shell/health`, { signal: AbortSignal.timeout(1000) }))

  for (const disabled of [{}, { ...options, autostart: 'false' }]) {
    const browserOnly = await createServer({ configFile: false, root, logLevel: 'silent', plugins: [shellService(disabled)], server: { watch: null, host: '127.0.0.1', port: 0 } })
    await browserOnly.listen()
    try { await assert.rejects(fetch(`${target}/api/shell/health`, { signal: AbortSignal.timeout(1000) })) }
    finally { await browserOnly.close() }
  }
  await assert.rejects(startWithStub({ root }), /requires both/)
  await assert.rejects(startWithStub({ root, token: 'short' }), /at least 32/)
  console.log('Shell startup tests passed: env loading, dev/preview auto-start, authenticated proxy, restart, shutdown, occupied port, opt-out, browser-only mode and invalid configuration.')
} finally { await rm(root, { recursive: true, force: true }) }
