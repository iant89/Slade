/**
 * Local file system utilities, path normalization, directory tree builder,
 * and agent Markdown directive/file-block extraction.
 */

import type { FsFile, FsOpRecord } from '../types'
import { formatBytes } from './format'
import { extOf, kindLabel } from './mime'

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type FsErrorKind = 'invalid_path' | 'not_found' | 'already_exists' | 'too_large'

export class FsError extends Error {
  kind: FsErrorKind
  path?: string
  constructor(kind: FsErrorKind, message: string, path?: string) {
    super(message)
    this.name = 'FsError'
    this.kind = kind
    this.path = path
  }
}

export function isFsError(err: unknown): err is FsError {
  return err instanceof FsError
}

/* ------------------------------------------------------------------ */
/* Path handling & validation                                          */
/* ------------------------------------------------------------------ */

export const MAX_FS_PATH_LENGTH = 512
export const MAX_FS_FILE_BYTES = 5_000_000

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const DRIVE_RE = /^[a-zA-Z]:[\\/]/
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

/**
 * Normalize a relative file path inside Slade's local file system.
 *
 * - Converts backslashes to forward slashes
 * - Strips leading `/` and `./`
 * - Collapses `.` and resolves `..` within the root
 * - Rejects path traversal outside root (`../`), URLs, drive letters, and
 *   control characters
 */
export function normalizeFsPath(raw: string): string {
  const trimmed = raw.trim().replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!trimmed) {
    throw new FsError('invalid_path', 'File path cannot be empty.', raw)
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new FsError('invalid_path', `File path contains invalid control characters: "${raw}"`, raw)
  }
  if (SCHEME_RE.test(trimmed) || /^(?:data|blob|javascript|mailto):/i.test(trimmed)) {
    throw new FsError('invalid_path', `URLs are not valid local file paths: "${raw}"`, raw)
  }
  if (DRIVE_RE.test(trimmed)) {
    throw new FsError('invalid_path', `Absolute OS drive paths are not allowed: "${raw}"`, raw)
  }

  const unified = trimmed.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = unified.split('/')
  const stack: string[] = []

  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) {
        throw new FsError('invalid_path', `Path escapes the local file system root: "${raw}"`, raw)
      }
      stack.pop()
      continue
    }
    if (seg.length > 255) {
      throw new FsError('invalid_path', `Path segment is too long: "${seg.slice(0, 40)}…"`, raw)
    }
    stack.push(seg)
  }

  if (stack.length === 0) {
    throw new FsError('invalid_path', `Invalid file path: "${raw}"`, raw)
  }

  const normalized = stack.join('/')
  if (normalized.length > MAX_FS_PATH_LENGTH) {
    throw new FsError('invalid_path', `File path exceeds ${MAX_FS_PATH_LENGTH} characters.`, raw)
  }
  return normalized
}

/** Safe version of `normalizeFsPath` that returns `null` instead of throwing. */
export function tryNormalizeFsPath(raw: string): string | null {
  try {
    return normalizeFsPath(raw)
  } catch {
    return null
  }
}

export function fsBaseName(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const i = clean.lastIndexOf('/')
  return i >= 0 ? clean.slice(i + 1) : clean
}

export function fsDirName(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const i = clean.lastIndexOf('/')
  return i >= 0 ? clean.slice(0, i) : ''
}

export function fsExt(path: string): string {
  return extOf(fsBaseName(path))
}

export function joinFsPath(...parts: string[]): string {
  const joined = parts
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
  return normalizeFsPath(joined)
}

const EXTENSIONLESS_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'licence',
  'procfile',
  'gemfile',
  'rakefile',
  'justfile',
  'caddyfile',
  'readme',
  'changelog',
  'authors',
  'contributors',
  '.gitignore',
  '.dockerignore',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.eslintrc',
  '.editorconfig',
  '.env',
  '.env.example',
  '.env.local',
])

/**
 * Heuristic check for whether a candidate string from a code-fence header is
 * meant to be a file path (has an extension, a directory separator, or is a
 * standard extensionless filename).
 */
export function looksLikeFilePath(candidate: string): boolean {
  const norm = tryNormalizeFsPath(candidate)
  if (!norm) return false
  const base = fsBaseName(norm)
  if (EXTENSIONLESS_NAMES.has(base.toLowerCase())) return true
  if (norm.includes('/')) return true
  return /\.[a-zA-Z0-9]{1,12}$/.test(base)
}

/* ------------------------------------------------------------------ */
/* Directory tree builder                                              */
/* ------------------------------------------------------------------ */

export interface FsDirNode {
  name: string
  path: string
  dirs: FsDirNode[]
  files: FsFile[]
}

export function buildFsTree(files: readonly FsFile[]): FsDirNode {
  const root: FsDirNode = { name: '', path: '', dirs: [], files: [] }
  const dirs = new Map<string, FsDirNode>([['', root]])

  const ensureDir = (dirPath: string): FsDirNode => {
    const existing = dirs.get(dirPath)
    if (existing) return existing
    const parts = dirPath.split('/')
    const name = parts[parts.length - 1]!
    const parentPath = parts.slice(0, -1).join('/')
    const parent = ensureDir(parentPath)
    const node: FsDirNode = { name, path: dirPath, dirs: [], files: [] }
    parent.dirs.push(node)
    dirs.set(dirPath, node)
    return node
  }

  for (const file of files) {
    const dirPath = fsDirName(file.path)
    ensureDir(dirPath).files.push(file)
  }

  const sortNode = (node: FsDirNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.name.localeCompare(b.name))
    node.dirs.forEach(sortNode)
  }
  sortNode(root)
  return root
}

/* ------------------------------------------------------------------ */
/* Extracting file system operations from agent/model Markdown         */
/* ------------------------------------------------------------------ */

export type ExtractedFsAction =
  | { op: 'write'; path: string; content: string; lang?: string }
  | { op: 'append'; path: string; content: string; lang?: string }
  | { op: 'delete'; path: string }
  | { op: 'move'; fromPath: string; toPath: string }
  | { op: 'pull'; path: string }

const NON_LANG_SCHEMES = new Set(['http', 'https', 'ftp', 'mailto', 'urn', 'tel', 'ws', 'wss', 'data', 'blob', 'javascript'])

/**
 * Parse a fence info string (everything after the opening backticks/tildes)
 * into a structured file action, or null if the fence is a plain code snippet.
 */
export function parseFenceHeader(
  infoRaw: string,
  bodyContent: string,
): ExtractedFsAction | null {
  const info = infoRaw.trim()
  if (!info) return null

  // 1. Explicit `fs:<command>:<target>` directives
  const fsDirective = /^fs:(write|create|save|update|append|delete|rm|remove|move|rename|pull|fetch|checkout)(?::(.*))?$/i.exec(info)
  if (fsDirective) {
    const verb = fsDirective[1]!.toLowerCase()
    const rest = (fsDirective[2] ?? '').trim()

    if (verb === 'pull' || verb === 'fetch' || verb === 'checkout') {
      const target = rest || bodyContent.trim().split(/\r?\n/)[0]?.trim() || ''
      const path = tryNormalizeFsPath(target)
      return path ? { op: 'pull', path } : null
    }

    if (verb === 'delete' || verb === 'rm' || verb === 'remove') {
      const target = rest || bodyContent.trim().split(/\r?\n/)[0]?.trim() || ''
      const path = tryNormalizeFsPath(target)
      return path ? { op: 'delete', path } : null
    }

    if (verb === 'move' || verb === 'rename') {
      const spec = rest || bodyContent.trim().split(/\r?\n/)[0]?.trim() || ''
      const arrow = /^(.+?)\s*(?:->|=>|to)\s*(.+)$/i.exec(spec)
      if (!arrow) return null
      const fromPath = tryNormalizeFsPath(arrow[1]!)
      const toPath = tryNormalizeFsPath(arrow[2]!)
      return fromPath && toPath ? { op: 'move', fromPath, toPath } : null
    }

    if (verb === 'append') {
      const path = tryNormalizeFsPath(rest)
      return path ? { op: 'append', path, content: bodyContent } : null
    }

    // write / create / save / update
    const path = tryNormalizeFsPath(rest)
    return path ? { op: 'write', path, content: bodyContent } : null
  }

  // 2. Attribute syntax: ```ts path="src/app.ts" or file="..." or filename="..." or title="..."
  const attrMatch = /^(?:([a-zA-Z0-9+#_-]+)\s+)?.*?\b(?:path|file|filename|title)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(info)
  if (attrMatch) {
    const lang = attrMatch[1]
    const rawPath = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? ''
    if (looksLikeFilePath(rawPath)) {
      const path = tryNormalizeFsPath(rawPath)
      if (path) return { op: 'write', path, content: bodyContent, lang }
    }
  }

  // 3. Standard Slade colon-tagged fence: ```lang:path/to/file.ext or ```:path/to/file.ext or ```file:path/to/file.ext
  const firstToken = info.split(/\s+/)[0] ?? ''
  const colonIdx = firstToken.indexOf(':')
  if (colonIdx >= 0) {
    const prefix = firstToken.slice(0, colonIdx)
    const rawPath = firstToken.slice(colonIdx + 1)
    if (NON_LANG_SCHEMES.has(prefix.toLowerCase())) return null
    if (!/^[a-zA-Z0-9+#_-]*$/.test(prefix)) return null
    if (!looksLikeFilePath(rawPath)) return null
    const path = tryNormalizeFsPath(rawPath)
    if (!path) return null
    const lang = prefix.toLowerCase() === 'file' ? undefined : prefix || undefined
    return { op: 'write', path, content: bodyContent, lang }
  }

  // 4. First-line file header comment inside a plain language fence:
  //    // file: src/app.ts   |   # filepath: scripts/run.py   |   <!-- file: index.html -->
  if (/^[a-zA-Z0-9+#_-]+$/.test(firstToken) && bodyContent) {
    const bodyLines = bodyContent.split(/\r?\n/)
    const firstLine = bodyLines[0]?.trim() ?? ''
    const commentMatch =
      /^(?:\/\/|#|--|\/\*+|<!--)\s*(?:file(?:name|path)?|path)\s*:\s*([^\s*>-]+?)(?:\s*(?:\*+\/|-->))?\s*$/i.exec(
        firstLine,
      )
    if (commentMatch && looksLikeFilePath(commentMatch[1]!)) {
      const path = tryNormalizeFsPath(commentMatch[1]!)
      if (path) {
        return {
          op: 'write',
          path,
          content: bodyLines.slice(1).join('\n'),
          lang: firstToken,
        }
      }
    }
  }

  return null
}

/**
 * Scan a Markdown response for file blocks and file-system directives.
 *
 * Uses a fence-length-aware scanner so an outer 4-backtick file block (e.g.
 * ````markdown:README.md) can safely contain inner 3-backtick code blocks
 * without closing early or spawning phantom files from the inner examples.
 */
export function extractFsActions(markdown: string): ExtractedFsAction[] {
  if (!markdown) return []
  const lines = markdown.split(/\r?\n/)
  const actions: ExtractedFsAction[] = []

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  let fenceInfo = ''
  let fenceLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (!inFence) {
      const openMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
      if (openMatch) {
        const marker = openMatch[1]!
        const rest = openMatch[2] ?? ''
        // In CommonMark, backtick info strings cannot contain backticks.
        if (marker[0] === '`' && rest.includes('`')) {
          // Single-line inline code with triple backticks; not a block fence.
        } else {
          inFence = true
          fenceChar = marker[0]!
          fenceLen = marker.length
          fenceInfo = rest
          fenceLines = []
          continue
        }
      }

      // Check standalone inline FS directives outside fences:
      // [FS:DELETE path/to/file] or [FS:MOVE old/path -> new/path]
      const inlineDel = /^[ \t]*\[FS:(?:DELETE|RM|REMOVE)\s+([^\]]+)\][ \t]*$/i.exec(line)
      if (inlineDel) {
        const path = tryNormalizeFsPath(inlineDel[1]!)
        if (path) actions.push({ op: 'delete', path })
        continue
      }
      const inlineMove = /^[ \t]*\[FS:(?:MOVE|RENAME)\s+(.+?)\s*(?:->|=>|to)\s*([^\]]+)\][ \t]*$/i.exec(line)
      if (inlineMove) {
        const fromPath = tryNormalizeFsPath(inlineMove[1]!)
        const toPath = tryNormalizeFsPath(inlineMove[2]!)
        if (fromPath && toPath) actions.push({ op: 'move', fromPath, toPath })
        continue
      }
      const inlinePull = /^[ \t]*\[FS:(?:PULL|FETCH|CHECKOUT)\s+([^\]]+)\][ \t]*$/i.exec(line)
      if (inlinePull) {
        const path = tryNormalizeFsPath(inlinePull[1]!)
        if (path) actions.push({ op: 'pull', path })
        continue
      }
    } else {
      const closeMatch = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (closeMatch && closeMatch[1]![0] === fenceChar && closeMatch[1]!.length >= fenceLen) {
        const body = fenceLines.join('\n')
        const parsed = parseFenceHeader(fenceInfo, body)
        if (parsed) actions.push(parsed)
        inFence = false
        fenceChar = ''
        fenceLen = 0
        fenceInfo = ''
        fenceLines = []
        continue
      }
      fenceLines.push(line)
    }
  }

  return actions
}

/* ------------------------------------------------------------------ */
/* Agent prompt formatting                                             */
/* ------------------------------------------------------------------ */

/** Compact manifest of all files currently stored in the local file system. */
export function formatFsManifest(files: readonly FsFile[]): string {
  if (files.length === 0) return '(empty — no files stored yet)'
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  return sorted
    .map((f) => {
      const author = f.updatedBy.origin === 'user' ? 'user' : f.updatedBy.modelLabel
      const gitTag = f.remote
        ? `, git:${f.remote.repo}@${f.remote.ref}${f.dirty ? ' [modified]' : ' [synced]'}`
        : ''
      return `- ${f.path} (${kindLabel(f.kind).toLowerCase()}, ${formatBytes(f.size)}, v${f.version}, by ${author}${gitTag})`
    })
    .join('\n')
}

/**
 * Find repository blob paths from a GitHub tree that are referenced in a
 * prompt or task description (either by exact relative path or by unique
 * filename).
 */
export function findMentionedRepoPaths(
  entries: readonly { path: string; type: string; size?: number }[],
  textHint: string,
  maxMatches = 6,
): string[] {
  const hint = textHint.toLowerCase()
  if (!hint.trim()) return []
  const blobs = entries.filter((e) => e.type === 'blob')
  const matched: string[] = []
  const seen = new Set<string>()

  // 1. Exact relative path mentions (longest paths first so `src/lib/fs.ts` beats `fs.ts`).
  const byLength = [...blobs].sort((a, b) => b.path.length - a.path.length)
  for (const b of byLength) {
    if (matched.length >= maxMatches) break
    const pLower = b.path.toLowerCase()
    if (hint.includes(pLower) && !seen.has(b.path)) {
      seen.add(b.path)
      matched.push(b.path)
    }
  }

  // 2. Unique basename mentions (e.g. `counter.ts` when only one `counter.ts` exists in the tree).
  if (matched.length < maxMatches) {
    const byBase = new Map<string, string[]>()
    for (const b of blobs) {
      const base = fsBaseName(b.path).toLowerCase()
      if (!base.includes('.') || base.length < 4) continue
      const list = byBase.get(base) ?? []
      list.push(b.path)
      byBase.set(base, list)
    }
    for (const [base, paths] of byBase.entries()) {
      if (matched.length >= maxMatches) break
      if (paths.length === 1 && !seen.has(paths[0]!)) {
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(?:^|[\\s\`'"(])${escaped}(?:$|[\\s\`'"),.:;!?])`, 'i').test(textHint)) {
          seen.add(paths[0]!)
          matched.push(paths[0]!)
        }
      }
    }
  }

  return matched
}

/**
 * Format an open GitHub repository tree for agent workspace context so the
 * orchestrator and workers can see all files in the connected Git repository
 * alongside the local file system.
 */
export function formatGitHubTreeForAgent(
  repo: string,
  ref: string,
  entries: readonly { path: string; type: string; size?: number }[],
  opts?: { maxEntries?: number },
): string {
  const blobs = entries.filter((e) => e.type === 'blob')
  if (blobs.length === 0) return ''
  const maxEntries = opts?.maxEntries ?? 120
  const shown = blobs.slice(0, maxEntries)
  const lines = shown.map((e) => `- ${e.path}${e.size != null ? ` (${formatBytes(e.size)})` : ''}`)
  if (blobs.length > maxEntries) {
    lines.push(`- … (${blobs.length - maxEntries} more files in ${repo}@${ref})`)
  }
  return [
    `CONNECTED GITHUB REPOSITORY (${repo}@${ref}, ${blobs.length} files)`,
    'Files in the Git repository can be read into the local file system with ```fs:pull:path/to/file.ext or modified directly by emitting ```lang:path/to/file.ext:',
    lines.join('\n'),
  ].join('\n')
}

/**
 * Build the Local File System context block injected into system prompts so
 * agents can inspect the file tree and read existing file contents.
 */
export function formatFsContextForAgent(
  files: readonly FsFile[],
  opts?: {
    maxTotalChars?: number
    maxFileChars?: number
    queryHint?: string
  },
): string {
  if (files.length === 0) return ''
  const maxTotal = opts?.maxTotalChars ?? 32_000
  const maxFile = opts?.maxFileChars ?? 12_000
  const hint = (opts?.queryHint ?? '').toLowerCase()

  const manifest = formatFsManifest(files)

  // Prioritize files mentioned in queryHint (by path or basename), then most
  // recently updated first.
  const prioritized = [...files].sort((a, b) => {
    const aMentioned = hint && (hint.includes(a.path.toLowerCase()) || hint.includes(a.name.toLowerCase())) ? 1 : 0
    const bMentioned = hint && (hint.includes(b.path.toLowerCase()) || hint.includes(b.name.toLowerCase())) ? 1 : 0
    if (aMentioned !== bMentioned) return bMentioned - aMentioned
    return b.updatedAt - a.updatedAt
  })

  let budget = maxTotal
  const fileBlocks: string[] = []

  for (const f of prioritized) {
    if (budget <= 0) break
    if (f.encoding === 'base64') {
      const note = `--- local file: ${f.path} [binary: ${f.mime}, ${formatBytes(f.size)}, v${f.version}] ---`
      fileBlocks.push(note)
      budget -= note.length
      continue
    }
    const slice = f.content.slice(0, Math.min(maxFile, budget))
    const truncated = slice.length < f.content.length
    budget -= slice.length
    fileBlocks.push(
      `--- local file: ${f.path} (v${f.version}, ${formatBytes(f.size)}${truncated ? ', truncated' : ''}) ---\n\`\`\`\n${slice}\n\`\`\``,
    )
  }

  return [
    'LOCAL FILE SYSTEM WORKSPACE',
    '',
    `Files currently stored (${files.length}):`,
    manifest,
    '',
    'File contents:',
    fileBlocks.join('\n\n'),
  ].join('\n')
}

/** Human-readable summary of file system operations performed in a step/run. */
export function formatFsOpSummary(ops: readonly FsOpRecord[]): string {
  if (ops.length === 0) return ''
  return ops
    .map((o) => {
      if (o.op === 'create') return `created ${o.path}${o.size != null ? ` (${formatBytes(o.size)})` : ''}`
      if (o.op === 'update') return `updated ${o.path} (v${o.version ?? 2}${o.size != null ? `, ${formatBytes(o.size)}` : ''})`
      if (o.op === 'move') return `moved ${o.fromPath ?? ''} → ${o.path}`
      if (o.op === 'pull') return `pulled ${o.path}`
      return `deleted ${o.path}`
    })
    .join(', ')
}
