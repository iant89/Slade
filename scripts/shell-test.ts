import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createShellServer } from './shell-server'

const root = await mkdtemp(join(tmpdir(), 'slade-shell-'))
const token = 'test-token-not-a-real-credential-1234567890'
const { server, stop } = await createShellServer({ root, token, maxTimeoutMs: 2000 })
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const run = async (command: string, extra = {}) => {
  const response = await fetch(`${base}/api/shell/execute`, { method: 'POST', headers, body: JSON.stringify({ command, ...extra }) })
  assert.equal(response.status, 200)
  return (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
}
try {
  assert.equal((await fetch(`${base}/api/shell/health`)).status, 401)
  assert.equal((await fetch(`${base}/api/shell/execute`, { method: 'POST', body: JSON.stringify({ command: 'touch unauthorized' }) })).status, 401)
  assert.equal((await fetch(`${base}/api/shell/health`, { headers })).status, 200)
  assert.equal((await fetch(`${base}/api/shell/execute`, { method: 'POST', headers, body: '{' })).status, 400)
  assert.equal((await fetch(`${base}/api/shell/execute`, { method: 'POST', headers, body: JSON.stringify({ command: 'pwd', cwd: '..' }) })).status, 400)
  await symlink(tmpdir(), join(root, 'escape'))
  assert.equal((await fetch(`${base}/api/shell/execute`, { method: 'POST', headers, body: JSON.stringify({ command: 'pwd', cwd: 'escape' }) })).status, 400)
  await mkdir(join(root, 'sub'))
  const success = await run('pwd; printf "hello"; printf "error stream" >&2', { cwd: 'sub' })
  assert.equal(success[0].type, 'started')
  assert.equal(success.at(-1).status, 'finished')
  assert.equal(success.at(-1).exitCode, 0)
  assert(success.at(-1).finishedAt >= success[0].startedAt)
  const output = success.filter((e) => e.type === 'output').map((e) => e.text).join('')
  assert(output.includes(join(root, 'sub')) && output.includes('hello') && output.includes('error stream'))
  const failure = await run('echo oops >&2; exit 7')
  assert.equal(failure.at(-1).status, 'failed')
  assert.equal(failure.at(-1).exitCode, 7)
  process.env.SLADE_SHELL_TOKEN = 'must-not-reach-child'
  const env = await run('printf "%s" "${SLADE_SHELL_TOKEN:-unset}"')
  assert(env.some((e) => e.text === 'unset'))
  const timeout = await run('sleep 30', { timeoutMs: 50 })
  assert.equal(timeout.at(-1).status, 'failed')
  assert(timeout.at(-1).error.includes('timed out'))
  const limited = await run('yes large-output')
  assert(limited.at(-1).error.includes('Output limit'))
  const controller = new AbortController()
  const response = await fetch(`${base}/api/shell/execute`, {
    method: 'POST', headers, signal: controller.signal,
    body: JSON.stringify({ command: '(sleep 1; touch cancelled) & echo ready; wait' }),
  })
  const reader = response.body!.getReader()
  let streamed = ''
  while (!streamed.includes('ready')) streamed += new TextDecoder().decode((await reader.read()).value)
  controller.abort()
  await reader.cancel().catch(() => {})
  await delay(1300)
  await assert.rejects(access(join(root, 'cancelled')))
  const background = await run('(trap "" TERM; sleep 1; touch orphan) >/dev/null 2>&1 & echo done')
  assert.equal(background.at(-1).status, 'finished')
  await delay(1300)
  await assert.rejects(access(join(root, 'orphan')))
  console.log('Shell integration tests passed: auth, validation, cwd/symlink restrictions, streaming, exit status, env filtering, timeout, output cap, cancellation and descendant cleanup.')
} finally {
  stop()
  server.closeAllConnections()
  await rm(root, { recursive: true, force: true })
}
