import type { FsFileEncoding } from '../types'
import { mimeFromName } from './mime'
import { MAX_FS_FILE_BYTES, normalizeFsPath } from './fs'

export interface FsArchiveEntry {
  path: string
  content: string
  encoding: FsFileEncoding
  mime: string
}

export interface FsArchiveImport {
  entries: FsArchiveEntry[]
  skippedUnsafe: number
  skippedLarge: number
}

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_FILES = 2_000
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'sh', 'sql',
  'yml', 'yaml', 'toml', 'md', 'txt', 'csv', 'tsv', 'html', 'css', 'svg', 'xml', 'scss',
  'log', 'rst', 'ini', 'conf', 'env', 'gitignore', 'dockerfile',
])

function isTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot < 0 ? ['readme', 'license', 'dockerfile', 'makefile', 'procfile'].includes(name) : TEXT_EXTENSIONS.has(name.slice(dot + 1))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

/** Package the current workspace as a conventional zip, preserving file bytes and relative paths. */
export async function createFsArchive(
  files: readonly { path: string; content: string; encoding?: FsFileEncoding }[],
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  if (!files.length) throw new Error('There are no files to export yet.')
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  for (const file of files) {
    if (file.encoding === 'base64') {
      zip.file(file.path, file.content, { base64: true, binary: true })
    } else {
      zip.file(file.path, file.content)
    }
  }
  return zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' },
    (metadata) => onProgress?.(metadata.percent),
  )
}

/**
 * Read a zip into safe, relative workspace entries. Zip-slip paths, symlinks,
 * oversized entries, and archives with excessive expanded size are never imported.
 */
export async function readFsArchive(file: File): Promise<FsArchiveImport> {
  if (file.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`This archive is larger than the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB import limit.`)
  }

  const { default: JSZip } = await import('jszip')
  // Leave JSZip's eager CRC scan off: the per-entry size guards below must run
  // before any decompression, including for deliberately over-expanded entries.
  const zip = await JSZip.loadAsync(file)
  const items = Object.values(zip.files).filter((entry) => !entry.dir)
  if (items.length > MAX_ARCHIVE_FILES) {
    throw new Error(`This archive contains more than ${MAX_ARCHIVE_FILES.toLocaleString()} files.`)
  }

  const result: FsArchiveImport = { entries: [], skippedUnsafe: 0, skippedLarge: 0 }
  let expandedBytes = 0
  const importedPaths = new Set<string>()

  for (const item of items) {
    const rawPath = item.unsafeOriginalName ?? item.name
    const permissions = typeof item.unixPermissions === 'number' ? item.unixPermissions : 0
    if ((permissions & 0o170000) === 0o120000) {
      result.skippedUnsafe++
      continue
    }

    let path: string
    try {
      path = normalizeFsPath(rawPath)
    } catch {
      result.skippedUnsafe++
      continue
    }
    if (importedPaths.has(path)) {
      result.skippedUnsafe++
      continue
    }

    // JSZip exposes the parsed uncompressed size internally. Check it before
    // decompression to avoid allocating unexpectedly large zip-bomb entries.
    const expectedSize = (item as typeof item & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (typeof expectedSize === 'number' && expectedSize > MAX_FS_FILE_BYTES) {
      result.skippedLarge++
      continue
    }
    if (typeof expectedSize === 'number' && expandedBytes + expectedSize > MAX_EXPANDED_BYTES) {
      result.skippedLarge++
      continue
    }

    const bytes = await item.async('uint8array')
    if (bytes.byteLength > MAX_FS_FILE_BYTES || expandedBytes + bytes.byteLength > MAX_EXPANDED_BYTES) {
      result.skippedLarge++
      continue
    }
    expandedBytes += bytes.byteLength
    importedPaths.add(path)

    const textFile = isTextPath(path)
    const mime = mimeFromName(path, textFile ? 'text/plain' : 'application/octet-stream')
    if (textFile) {
      result.entries.push({ path, content: new TextDecoder().decode(bytes), encoding: 'utf8', mime })
    } else {
      result.entries.push({ path, content: bytesToBase64(bytes), encoding: 'base64', mime })
    }
  }

  return result
}
