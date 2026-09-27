import type { ArtifactKind } from '../types'

const IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif']
const CODE = [
  'text/javascript',
  'text/typescript',
  'application/javascript',
  'application/typescript',
  'application/json',
  'text/html',
  'text/css',
  'application/x-yaml',
  'application/toml',
  'text/xml',
  'application/xml',
  'text/x-python',
  'text/x-rust',
  'text/x-go',
  'text/x-java',
  'text/x-c',
  'text/x-cpp',
  'text/x-sh',
  'application/x-sh',
  'text/x-sql',
]
const DOC = ['text/plain', 'text/markdown', 'text/richtext', 'application/pdf', 'application/msword']
const SHEET = ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
const AUDIO = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm']
const VIDEO = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']
const ARCHIVE = [
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
]

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function mimeFromName(name: string, fallback = 'application/octet-stream'): string {
  const ext = extOf(name)
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript',
    json: 'application/json', html: 'text/html', css: 'text/css', scss: 'text/css',
    py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java',
    c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-cpp', sh: 'text/x-sh', bash: 'text/x-sh',
    sql: 'text/x-sql', yml: 'application/x-yaml', yaml: 'application/x-yaml',
    toml: 'application/toml', xml: 'text/xml', md: 'text/markdown', txt: 'text/plain',
    csv: 'text/csv', tsv: 'text/csv',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed', rar: 'application/x-rar-compressed',
  }
  return table[ext] ?? fallback
}

/** Human-facing language tag for a code artifact. */
export function langLabel(mime: string, name: string): string {
  const ext = extOf(name)
  if (ext) return ext.toUpperCase()
  const short = mime.split('/')[1] ?? mime
  return short.replace('x-', '').toUpperCase()
}

export function classifyArtifact(name: string, mime: string): ArtifactKind {
  const m = (mime || mimeFromName(name)).toLowerCase()
  const ext = extOf(name)
  if (IMAGE.includes(m) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image'
  if (m === 'text/csv' || ext === 'csv' || ext === 'tsv') return 'sheet'
  if (SHEET.includes(m) || ext === 'xlsx' || ext === 'xls') return 'sheet'
  if (CODE.includes(m)) return 'code'
  if (['md', 'txt', 'log', 'rst'].includes(ext) || m.startsWith('text/')) return 'doc'
  if (DOC.includes(m)) return 'doc'
  if (AUDIO.includes(m)) return 'audio'
  if (VIDEO.includes(m)) return 'video'
  if (ARCHIVE.includes(m)) return 'archive'
  // Common code extensions whose MIME may be octet-stream.
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'sql', 'yml', 'yaml', 'toml', 'html', 'css'].includes(ext)) return 'code'
  return 'unknown'
}

export function kindLabel(kind: ArtifactKind): string {
  switch (kind) {
    case 'image': return 'Image'
    case 'code': return 'Code'
    case 'doc': return 'Document'
    case 'sheet': return 'Spreadsheet'
    case 'audio': return 'Audio'
    case 'video': return 'Video'
    case 'archive': return 'Archive'
    default: return 'File'
  }
}

/** Artifacts below this size are persisted to localStorage as data URLs. */
export const PERSIST_LIMIT_BYTES = 1_200_000
