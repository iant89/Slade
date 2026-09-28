/**
 * Turning Slade things into GitHub things.
 *
 * Pure, dependency-light helpers (no DOM APIs beyond what is injected) so the
 * publish dialog stays a thin shell and the headless smoke test can assert the
 * exact payloads Slade would send.
 */

import type { Artifact } from '../types'
import { extOf, guessLanguage } from './github'

/* ------------------------------------------------------------------ */
/* Fences & slugs                                                      */
/* ------------------------------------------------------------------ */

/** Always out-fence the longest backtick run inside `text`. */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

export function fenced(text: string, lang = ''): string {
  const fence = fenceFor(text)
  return `${fence}${lang}\n${text}\n${fence}`
}

/** `Fix the failover bug!` → `fix-the-failover-bug` (safe for paths/branches). */
export function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return slug || fallback
}

export function titleFromText(text: string, max = 72): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0)
  const t = (firstLine ?? '').replace(/[`*_>]/g, '').trim()
  if (!t) return 'Slade artifact'
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/* ------------------------------------------------------------------ */
/* Artifact classification for publishing                              */
/* ------------------------------------------------------------------ */

export function isBinaryArtifact(a: Pick<Artifact, 'kind' | 'mime' | 'text'>): boolean {
  if (a.text != null) return false
  if (a.kind === 'image' || a.kind === 'audio' || a.kind === 'video' || a.kind === 'archive') return true
  return !a.mime.startsWith('text/') && a.kind !== 'code' && a.kind !== 'doc' && a.kind !== 'sheet'
}

/** Gists are text-only; give every artifact a file name GitHub will accept. */
export function gistNameFor(name: string): string {
  const trimmed = name.trim() || 'slade-artifact.txt'
  // A gist file name may contain spaces and subdirectories are not allowed.
  return trimmed.replace(/[/\\]/g, '-').slice(0, 200)
}

export interface GistPayload {
  files: { name: string; content: string }[]
  description?: string
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishError'
  }
}

/** A text artifact → a one-file gist. Throws a PublishError for binaries. */
export function artifactToGist(a: Artifact, description?: string): GistPayload {
  if (isBinaryArtifact(a)) {
    throw new PublishError(
      `${a.name} is binary (${a.mime}) — gists are text only. Publish it as a repository file instead.`,
    )
  }
  return {
    files: [{ name: gistNameFor(a.name), content: a.text ?? '' }],
    description,
  }
}

/** An assistant/user message → a Markdown gist. */
export function messageToGist(text: string, title: string, description?: string): GistPayload {
  const file = `${slugify(title || 'slade-answer')}.md`
  return { files: [{ name: file, content: text }], description }
}

/* ------------------------------------------------------------------ */
/* Byte access (works from a data URL or an object URL)                */
/* ------------------------------------------------------------------ */

export type BlobFetcher = (url: string) => Promise<Blob>

const defaultFetcher: BlobFetcher = async (url) => {
  if (url.startsWith('data:')) {
    const res = await fetch(url)
    return await res.blob()
  }
  const res = await fetch(url)
  if (!res.ok) throw new PublishError('Could not read the artifact contents.')
  return await res.blob()
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip', csv: 'text/csv',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
}

export interface FileWritePayload {
  /** Raw base64 (no data-URL prefix), ready for the contents API. */
  contentBase64: string
  /** Best-effort mime so the file lands with the right type metadata. */
  mime: string
  size: number
}

/**
 * Read an artifact's bytes as base64 for `PUT /contents`.
 * Text artifacts are encoded from their in-memory text; anything else is read
 * back from its data URL / object URL.
 */
export async function artifactToFilePayload(
  a: Artifact,
  fetchBlob: BlobFetcher = defaultFetcher,
): Promise<FileWritePayload> {
  if (a.text != null) {
    const bytes = new TextEncoder().encode(a.text)
    return { contentBase64: bytesToBase64Safe(bytes), mime: a.mime || mimeFromExt(a.name), size: bytes.byteLength }
  }
  const url = a.dataURL ?? a.blobUrl
  if (!url) throw new PublishError(`${a.name} has no contents left in this session — re-attach it and try again.`)
  const blob = await fetchBlob(url)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { contentBase64: bytesToBase64Safe(bytes), mime: blob.type || a.mime || mimeFromExt(a.name), size: bytes.byteLength }
}

function bytesToBase64Safe(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(out)
}

export function mimeFromExt(name: string): string {
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream'
}

/* ------------------------------------------------------------------ */
/* Repo file publishing                                                */
/* ------------------------------------------------------------------ */

export function suggestRepoPath(name: string, prefix = ''): string {
  const base = (name || 'artifact').replace(/^\/+/, '')
  const trimmed = prefix.replace(/^\/+|\/+$/g, '')
  return trimmed ? `${trimmed}/${base}` : base
}

export function commitMessageFor(a: Artifact, action: 'create' | 'update'): string {
  return `${action === 'create' ? 'Add' : 'Update'} ${a.name} (via Slade)`
}

/* ------------------------------------------------------------------ */
/* Issues                                                              */
/* ------------------------------------------------------------------ */

export interface Provenance {
  /** Where the content came from: a model label, or "you". */
  origin: string
  model?: string
  conversationTitle?: string
  failure?: string
}

function provenanceBlock(p: Provenance): string {
  const rows = [`| Source | ${p.origin} |`]
  if (p.model) rows.push(`| Model | ${p.model} |`)
  if (p.conversationTitle) rows.push(`| Conversation | ${p.conversationTitle} |`)
  rows.push(`| Published with | [Slade](https://github.com/iant89/Slade) |`)
  return ['<details><summary>Provenance</summary>', '', '| | |', '| --- | --- |', ...rows, '', '</details>'].join('\n')
}

/** Issue body for a text artifact: context, content, provenance. */
export function artifactIssueBody(a: Artifact, p: Provenance): string {
  const lang = guessLanguage(a.name)
  const remote = a.remote ? `\nSource: [${a.remote.path}](${a.remote.url})\n` : ''
  const body = a.text ?? ''
  return [
    a.mime ? `_${a.name} — ${a.mime}, ${a.size} bytes_` : `_${a.name}_`,
    remote,
    '',
    fenced(body.length > 60_000 ? `${body.slice(0, 60_000)}\n… (truncated by Slade)` : body, lang),
    '',
    provenanceBlock(p),
  ]
    .filter((s) => s !== '')
    .join('\n')
}

export function artifactIssueTitle(a: Artifact): string {
  return `Artifact: ${a.name}`
}

/** Issue body for a chat message. */
export function messageIssueBody(text: string, p: Provenance): string {
  return [text, '', '---', provenanceBlock(p)].join('\n')
}

/** `Artifact: report.csv` → a deterministic branch name for "publish to a new branch". */
export function branchNameFor(prefix = 'slade', label: string): string {
  return `${slugify(prefix)}/${slugify(label, 'publish')}`
}
