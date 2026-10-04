import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MAX_BYTES = 5_000_000
const OMIT = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.next', '.venv', '.ssh', '.aws'])
const protectedName = (name: string) => OMIT.has(name) || name === '.env' || (name.startsWith('.env.') && !/\.(example|sample)$/.test(name)) || /\.(pem|key)$/.test(name)
class FileError extends Error { constructor(public status: number, message: string) { super(message) } }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const revision = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Auth is enforced by the parent shell server. No filesystem route is public. */
export function createDiskHandler(root: string) {
  // Serialize API mutations and reads so two API writers cannot pass the same CAS.
  // External bash/editor writes still require optimistic conflict detection.
  let queue = Promise.resolve()
  async function safePath(value: unknown, createParents = false): Promise<string> {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\\\x00-\x1f\x7f:]/.test(value)) throw new FileError(400, 'Invalid relative path.')
    const parts = value.split('/')
    if (parts.some((p) => !p || p === '.' || p === '..' || protectedName(p))) throw new FileError(400, 'Path is outside the allowed file workspace or is protected.')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!)
      let info
      try { info = await lstat(current) } catch (error) {
        if (!missing(error)) throw error
        if (i < parts.length - 1 && createParents) { await mkdir(current); info = await lstat(current) }
        else if (i < parts.length - 1) throw new FileError(404, 'File not found.')
      }
      if (info?.isSymbolicLink()) throw new FileError(400, 'Symbolic links are not available through the Files API.')
      if (i < parts.length - 1 && info && !info.isDirectory()) throw new FileError(400, 'Parent path is not a directory.')
      if (i === parts.length - 1 && info && (!info.isFile() || info.nlink > 1)) throw new FileError(400, 'Only regular, non-hardlinked files are supported.')
    }
    return current
  }
  async function read(path: string) {
    const full = await safePath(path)
    const info = await lstat(full)
    if (info.size > MAX_BYTES) throw new FileError(413, 'File exceeds the 5 MB editor limit.')
    const data = await readFile(full)
    if (data.length > MAX_BYTES) throw new FileError(413, 'File exceeds the 5 MB editor limit.')
    let encoding: 'utf8' | 'base64' = 'utf8'
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); if (content.includes('\0')) throw new Error('binary') }
    catch { encoding = 'base64'; content = data.toString('base64') }
    return { path, content, encoding, size: data.length, updatedAt: info.mtimeMs, revision: revision(data) }
  }
  async function check(path: string, expected: unknown) {
    if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) throw new FileError(400, 'An expected revision (or null for a new file) is required.')
    let current: string | null = null
    try { current = (await read(path)).revision } catch (error) { if (!missing(error) && !(error instanceof FileError && error.status === 404)) throw error }
    if (current !== expected) throw new FileError(409, 'File changed on disk. Refresh and review it before trying again.')
  }
  async function operation(req: IncomingMessage) {
    const url = new URL(req.url!, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/api/shell/files/tree') {
      const files: { path: string; size: number; updatedAt: number }[] = []
      let visited = 0
      let truncated = false
      async function walk(dir: string, depth = 0): Promise<void> {
        if (dir && !(await lstat(join(root, dir))).isDirectory()) return
        if (depth > 24) { truncated = true; return }
        for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
          if (++visited > 15000 || files.length >= 5000) { truncated = true; return }
          if (protectedName(entry.name) || entry.isSymbolicLink()) continue
          const path = dir ? `${dir}/${entry.name}` : entry.name
          if (entry.isDirectory()) await walk(path, depth + 1)
          else if (entry.isFile()) {
            const info = await lstat(join(root, path))
            if (info.isFile() && info.nlink === 1) files.push({ path, size: info.size, updatedAt: info.mtimeMs })
          }
        }
      }
      await walk('')
      files.sort((a, b) => a.path.localeCompare(b.path))
      return { files, truncated, root }
    }
    if (req.method === 'GET' && url.pathname === '/api/shell/files/read') return read(url.searchParams.get('path') ?? '')
    if (req.method !== 'POST' || url.pathname !== '/api/shell/files/change') throw new FileError(404, 'Not found.')
    if (!req.headers['content-type']?.startsWith('application/json')) throw new FileError(415, 'Expected JSON.')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BYTES * 2 + 4096) throw new FileError(413, 'Request too large.')
      chunks.push(chunk)
    }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new FileError(400, 'Invalid JSON.') }
    if (!body || !['write', 'delete', 'move'].includes(body.op)) throw new FileError(400, 'Invalid operation.')
    const path = body.path as string
    await safePath(path, false).catch((error) => { if (!(error instanceof FileError && error.status === 404)) throw error })
    await check(path, body.expectedRevision)
    if (body.op === 'delete') {
      if (body.expectedRevision === null) throw new FileError(404, 'File not found.')
      await unlink(await safePath(path))
      return { ok: true }
    }
    if (body.op === 'move') {
      if (body.expectedRevision === null) throw new FileError(404, 'File not found.')
      await check(body.toPath, null) // Never overwrite a destination on rename.
      const to = await safePath(body.toPath, true)
      await rename(await safePath(path), to)
      return read(body.toPath)
    }
    if (typeof body.content !== 'string' || !['utf8', 'base64'].includes(body.encoding)) throw new FileError(400, 'Invalid file content/encoding.')
    if (body.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)) throw new FileError(400, 'Invalid base64.')
    const data = Buffer.from(body.content, body.encoding)
    if (data.length > MAX_BYTES) throw new FileError(413, 'File exceeds the 5 MB editor limit.')
    const full = await safePath(path, true)
    const temp = join(dirname(full), `.slade-write-${randomUUID()}`)
    let mode = 0o644
    try { mode = (await lstat(full)).mode & 0o777 } catch (error) { if (!missing(error)) throw error }
    try {
      await writeFile(temp, data, { flag: 'wx', mode })
      await check(path, body.expectedRevision)
      await safePath(path)
      await rename(temp, full)
    } finally { await unlink(temp).catch(() => {}) }
    return read(path)
  }
  return async (req: IncomingMessage, res: ServerResponse) => {
    const task = queue.then(async () => {
      try {
        const result = await operation(req)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(result))
      } catch (error) {
        const status = error instanceof FileError ? error.status : missing(error) ? 404 : 500
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: error instanceof FileError ? error.message : status === 404 ? 'File not found.' : 'Disk operation failed.' }))
      }
    })
    queue = task.catch(() => {})
    await task
  }
}
