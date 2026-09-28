import { create } from 'zustand'
import type { Artifact } from '../types'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'
import { githubPersistedSchema } from '../lib/schemas'
import { useArtifacts, artifactFromRemote } from './artifacts'
import { useUI } from './ui'
import {
  DEFAULT_SCOPE,
  DeviceFlowError,
  runDeviceFlow,
  verifyToken,
  type DeviceCode,
} from '../lib/github-auth'
import {
  baseName,
  GitHubError,
  githubErrorMessage,
  getRepo,
  getTree,
  isGitHubError,
  isTextualPath,
  listBranches,
  listRepos,
  mimeForPath,
  onRateInfo,
  parseRepoInput,
  readFile,
  searchCode,
  type GitHubBranch,
  type GitHubRateInfo,
  type GitHubRepo,
  type GitHubSearchHit,
  type GitHubTreeEntry,
  type RemoteFile,
} from '../lib/github'
import { executePublish, publishErrorMessage, type PublishRequest, type PublishResult, type PublishTarget } from '../lib/github-publish'

/* ------------------------------------------------------------------ */
/* Persisted slice                                                     */
/* ------------------------------------------------------------------ */

export interface PublishDefaults {
  target: PublishTarget
  repo?: string
  branch?: string
  /** Path prefix for committed files, e.g. `artifacts`. */
  prefix: string
  /** Gist visibility (public gists are indexed; secret ones are link-only). */
  gistPublic: boolean
  /** Commit onto a new branch instead of the selected one. */
  useNewBranch: boolean
}

export interface PersistedGitHub {
  token: string
  clientId: string
  /** Empty = same-origin `/github-oauth` (the bundled relay). */
  relayUrl: string
  scope: string
  login?: string
  avatarUrl?: string
  scopes: string[]
  recentRepos: string[]
  activeRepo?: string
  activeBranch?: string
  publish: PublishDefaults
}

/**
 * A deployer can bake in the relay (and an OAuth app) at build time, which
 * saves every visitor from configuring anything:
 *
 *   VITE_GITHUB_RELAY=https://slade-github-oauth.you.workers.dev \
 *   VITE_GITHUB_CLIENT_ID=Iv1.xxxx npm run build
 *
 * Anything the user saves in Settings wins over these.
 */
// `import.meta.env` only exists under Vite; the headless smoke test imports
// this module through esbuild, where the optional chaining keeps it undefined.
const ENV_RELAY = ((import.meta.env?.VITE_GITHUB_RELAY as string | undefined) ?? '').trim()
const ENV_CLIENT_ID = ((import.meta.env?.VITE_GITHUB_CLIENT_ID as string | undefined) ?? '').trim()

const DEFAULT_PERSISTED: PersistedGitHub = {
  token: '',
  clientId: ENV_CLIENT_ID,
  relayUrl: ENV_RELAY,
  scope: DEFAULT_SCOPE,
  scopes: [],
  recentRepos: [],
  publish: { target: 'gist', prefix: '', gistPublic: false, useNewBranch: false },
}

/**
 * The token lives in its own key, and — deliberately — is *not* part of the
 * Data → Export bundle, so a backup file never carries a live credential.
 */
function hydrate(): PersistedGitHub {
  const raw = loadRaw<unknown>(KEYS.github, null)
  if (!raw) return { ...DEFAULT_PERSISTED }
  const parsed = githubPersistedSchema.safeParse(raw)
  if (parsed.success) return { ...DEFAULT_PERSISTED, ...(parsed.data as PersistedGitHub) }
  // Legacy/partial: keep only the fields we recognise.
  const p = raw as Partial<PersistedGitHub>
  return {
    ...DEFAULT_PERSISTED,
    ...p,
    scopes: Array.isArray(p.scopes) ? p.scopes : [],
    recentRepos: Array.isArray(p.recentRepos) ? p.recentRepos : [],
    publish: { ...DEFAULT_PERSISTED.publish, ...(p.publish ?? {}) },
  }
}

/* ------------------------------------------------------------------ */
/* Runtime shapes                                                      */
/* ------------------------------------------------------------------ */

export interface FilePreview {
  path: string
  ref: string
  sha: string
  size: number
  mime: string
  text?: string
  /** Data URL for binary previews (images). */
  dataURL?: string
  truncated?: boolean
}

export interface TreeState {
  repo: string
  ref: string
  entries: GitHubTreeEntry[]
  truncated: boolean
  at: number
}

export interface SearchState {
  repo: string
  query: string
  hits: GitHubSearchHit[]
  at: number
}

export type AuthStatus = 'anonymous' | 'connecting' | 'authorized'

export interface GitHubState {
  /* connection */
  token: string
  clientId: string
  relayUrl: string
  scope: string
  login?: string
  avatarUrl?: string
  scopes: string[]
  authStatus: AuthStatus
  authError?: string
  device?: DeviceCode & { startedAt: number; status: 'waiting' | 'slow_down' }
  rate?: GitHubRateInfo['rate']

  /* repo workspace */
  repos: GitHubRepo[]
  reposLoading: boolean
  reposError?: string
  repoFilter: string
  recentRepos: string[]
  activeRepo?: string
  activeBranch?: string
  branches: GitHubBranch[]
  branchesLoading: boolean
  tree?: TreeState
  treeLoading: boolean
  treeError?: string
  treeFilter: string
  preview?: FilePreview
  previewLoading: boolean
  previewError?: string
  search: SearchState | null
  searchLoading: boolean
  searchError?: string

  /* publishing */
  publishDefaults: PublishDefaults
  publishing: boolean
  publishStep?: string
  publishError?: string
  lastPublish?: PublishResult

  /* actions */
  setClientId: (v: string) => void
  setRelayUrl: (v: string) => void
  setScope: (v: string) => void
  startSignIn: () => Promise<void>
  cancelSignIn: () => void
  signOut: (opts?: { keepConfig?: boolean }) => void
  connectWithToken: (token: string) => Promise<boolean>
  loadRepos: (opts?: { force?: boolean }) => Promise<void>
  setRepoFilter: (v: string) => void
  openRepo: (input: string, opts?: { branch?: string }) => Promise<boolean>
  setBranch: (branch: string) => Promise<void>
  setTreeFilter: (v: string) => void
  refreshTree: () => Promise<void>
  openFile: (path: string) => Promise<void>
  closeFile: () => void
  attachFile: (path: string, opts?: { silent?: boolean }) => Promise<Artifact | null>
  runSearch: (query: string) => Promise<void>
  clearSearch: () => void
  attachHit: (hit: GitHubSearchHit) => Promise<Artifact | null>
  setPublishDefaults: (patch: Partial<PublishDefaults>) => void
  publish: (req: PublishRequest) => Promise<PublishResult | null>
  dismissPublishError: () => void
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const textOf = (err: unknown): string => (isGitHubError(err) ? err.message : githubErrorMessage(err))

function artifactUrl(repo: string, ref: string, path: string): string {
  return `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

let signInController: AbortController | null = null
let searchController: AbortController | null = null

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export const useGitHub = create<GitHubState>((set, get) => {
  const persisted = hydrate()
  const persist = () => {
    const s = get()
    const next: PersistedGitHub = {
      token: s.token,
      clientId: s.clientId,
      relayUrl: s.relayUrl,
      scope: s.scope,
      login: s.login,
      avatarUrl: s.avatarUrl,
      scopes: s.scopes,
      recentRepos: s.recentRepos,
      activeRepo: s.activeRepo,
      activeBranch: s.activeBranch,
      publish: s.publishDefaults,
    }
    saveJSON(KEYS.github, next)
  }

  /** Adopt a verified token + user identity. */
  const adopt = (token: string, user: { login: string; avatar_url: string }, scopes: string[]) => {
    set({
      token,
      login: user.login,
      avatarUrl: user.avatar_url,
      scopes,
      authStatus: 'authorized',
      authError: undefined,
      device: undefined,
    })
    persist()
  }

  const rememberRepo = (fullName: string) => {
    const recent = [fullName, ...get().recentRepos.filter((r) => r !== fullName)].slice(0, 8)
    set({ recentRepos: recent })
    persist()
  }

  return {
    token: persisted.token,
    clientId: persisted.clientId,
    relayUrl: persisted.relayUrl,
    scope: persisted.scope || DEFAULT_SCOPE,
    login: persisted.login,
    avatarUrl: persisted.avatarUrl,
    scopes: persisted.scopes,
    // A stored token is trusted until a call proves otherwise; the token is
    // re-verified whenever the panel opens on a fresh session.
    authStatus: persisted.token ? 'authorized' : 'anonymous',

    repos: [],
    reposLoading: false,
    repoFilter: '',
    recentRepos: persisted.recentRepos,
    activeRepo: persisted.activeRepo,
    activeBranch: persisted.activeBranch,
    branches: [],
    branchesLoading: false,
    treeLoading: false,
    treeFilter: '',
    previewLoading: false,
    search: null,
    searchLoading: false,

    publishDefaults: persisted.publish,
    publishing: false,

    /* ---------------- config ---------------- */

    setClientId: (v) => {
      set({ clientId: v.trim() })
      persist()
    },
    setRelayUrl: (v) => {
      set({ relayUrl: v.trim() })
      persist()
    },
    setScope: (v) => {
      set({ scope: v.trim() || DEFAULT_SCOPE })
      persist()
    },

    /* ---------------- sign-in ---------------- */

    startSignIn: async () => {
      if (signInController) signInController.abort()
      const controller = new AbortController()
      signInController = controller
      set({ authStatus: 'connecting', authError: undefined, device: undefined })

      const { clientId, relayUrl, scope } = get()
      try {
        const { token } = await runDeviceFlow({
          clientId,
          relayUrl,
          scope,
          signal: controller.signal,
          onCode: (code) =>
            set({ device: { ...code, startedAt: Date.now(), status: 'waiting' }, authStatus: 'connecting' }),
          onStatus: (status) =>
            set((s) => (s.device ? { device: { ...s.device, status: status === 'slow_down' ? 'slow_down' : 'waiting' } } : {})),
        })
        const check = await verifyToken(token, { signal: controller.signal })
        adopt(token, check.user, check.scopes)
        useUI.getState().toast({ kind: 'success', title: `Connected to GitHub as @${check.user.login}` })
        void get().loadRepos({ force: true })
      } catch (err) {
        if (isAbort(err)) {
          set({ authStatus: get().token ? 'authorized' : 'anonymous', device: undefined })
        } else {
          const message = err instanceof DeviceFlowError ? err.message : githubErrorMessage(err)
          set({ authStatus: get().token ? 'authorized' : 'anonymous', authError: message, device: undefined })
        }
      } finally {
        if (signInController === controller) signInController = null
      }
    },

    cancelSignIn: () => {
      signInController?.abort()
      signInController = null
      set({ device: undefined, authStatus: get().token ? 'authorized' : 'anonymous' })
    },

    signOut: (opts) => {
      signInController?.abort()
      signInController = null
      if (!opts?.keepConfig) {
        set({
          token: '',
          login: undefined,
          avatarUrl: undefined,
          scopes: [],
          authStatus: 'anonymous',
          authError: undefined,
          device: undefined,
          repos: [],
          reposError: undefined,
          branches: [],
          tree: undefined,
          preview: undefined,
          search: null,
          lastPublish: undefined,
        })
      }
      persist()
      useUI.getState().toast({ kind: 'info', title: 'Disconnected from GitHub', detail: 'The token was removed from this browser.' })
    },

    connectWithToken: async (token) => {
      const clean = token.trim()
      if (!clean) return false
      set({ authError: undefined, authStatus: 'connecting' })
      try {
        const check = await verifyToken(clean)
        adopt(clean, check.user, check.scopes)
        useUI.getState().toast({ kind: 'success', title: `Connected to GitHub as @${check.user.login}` })
        void get().loadRepos({ force: true })
        return true
      } catch (err) {
        set({
          authStatus: get().token ? 'authorized' : 'anonymous',
          authError: err instanceof GitHubError ? err.message : githubErrorMessage(err),
        })
        return false
      }
    },

    /* ---------------- repos ---------------- */

    loadRepos: async (opts) => {
      const { token, repos, reposLoading } = get()
      if (!token || reposLoading) return
      if (repos.length && !opts?.force) return
      set({ reposLoading: true, reposError: undefined })
      try {
        const all: GitHubRepo[] = []
        for (let page = 1; page <= 3; page++) {
          const batch = await listRepos({ token, page, perPage: 100 })
          all.push(...batch)
          if (batch.length < 100) break
        }
        set({ repos: all, reposLoading: false })
      } catch (err) {
        set({ reposLoading: false, reposError: textOf(err) })
      }
    },

    setRepoFilter: (v) => set({ repoFilter: v }),

    openRepo: async (input, opts) => {
      const owner = get().login
      const parsed = parseRepoInput(input, owner)
      if (!parsed) {
        useUI.getState().toast({
          kind: 'error',
          title: 'That is not a repository',
          detail: 'Use owner/name or paste a github.com URL.',
        })
        return false
      }
      const fullName = parsed.fullName
      set({ treeLoading: true, treeError: undefined, preview: undefined, search: null })
      try {
        const repo = await getRepo(fullName, { token: get().token || undefined })
        const branch = opts?.branch ?? repo.default_branch
        set({ activeRepo: fullName, activeBranch: branch, branchesLoading: true })
        rememberRepo(fullName)
        const tree = await getTree(fullName, branch, { token: get().token || undefined })
        set({
          tree: { repo: fullName, ref: branch, entries: tree.entries, truncated: tree.truncated, at: Date.now() },
          treeLoading: false,
        })
        // Branch list is a nicety; never let it block the browser.
        void listBranches(fullName, { token: get().token || undefined })
          .then((branches) => set({ branches, branchesLoading: false }))
          .catch(() => set({ branches: [], branchesLoading: false }))
        return true
      } catch (err) {
        set({ treeLoading: false, treeError: textOf(err), tree: undefined, branchesLoading: false })
        return false
      }
    },

    setBranch: async (branch) => {
      const repo = get().activeRepo
      if (!repo) return
      set({ activeBranch: branch, treeLoading: true, treeError: undefined, preview: undefined })
      try {
        const tree = await getTree(repo, branch, { token: get().token || undefined })
        set({
          tree: { repo, ref: branch, entries: tree.entries, truncated: tree.truncated, at: Date.now() },
          treeLoading: false,
        })
        persist()
      } catch (err) {
        set({ treeLoading: false, treeError: textOf(err) })
      }
    },

    setTreeFilter: (v) => set({ treeFilter: v }),

    refreshTree: async () => {
      const { activeRepo, activeBranch } = get()
      if (!activeRepo || !activeBranch) return
      await get().setBranch(activeBranch)
    },

    /* ---------------- files ---------------- */

    openFile: async (path) => {
      const { activeRepo, activeBranch } = get()
      if (!activeRepo || !activeBranch) return
      set({ previewLoading: true, previewError: undefined, preview: undefined })
      try {
        const file: RemoteFile = await readFile(activeRepo, path, activeBranch, { token: get().token || undefined })
        const textual = file.text != null && isTextualPath(path, file.mime)
        const preview: FilePreview = {
          path,
          ref: activeBranch,
          sha: file.sha,
          size: file.size,
          mime: file.mime,
          text: textual ? file.text : undefined,
          truncated: textual && (file.text?.length ?? 0) > 120_000,
          dataURL:
            !textual && file.base64 && file.size <= 1_200_000
              ? `data:${file.mime};base64,${file.base64}`
              : undefined,
        }
        if (preview.text && preview.truncated) preview.text = preview.text!.slice(0, 120_000)
        set({ preview, previewLoading: false })
      } catch (err) {
        set({ previewLoading: false, previewError: textOf(err) })
      }
    },

    closeFile: () => set({ preview: undefined, previewError: undefined }),

    attachFile: async (path, opts) => {
      const { activeRepo, activeBranch } = get()
      if (!activeRepo || !activeBranch) return null
      try {
        const file = await readFile(activeRepo, path, activeBranch, { token: get().token || undefined })
        const textual = file.text != null && isTextualPath(path, file.mime)
        const artifact = await artifactFromRemote({
          name: baseName(path),
          mime: file.mime || mimeForPath(path),
          remote: {
            kind: 'github',
            repo: activeRepo,
            ref: activeBranch,
            path,
            url: artifactUrl(activeRepo, activeBranch, path),
            sha: file.sha,
          },
          text: textual ? file.text : undefined,
          base64: textual ? undefined : file.base64,
        })
        useArtifacts.getState().add(artifact)
        if (!opts?.silent) {
          useUI.getState().addPendingAttachment(artifact.id)
          useUI.getState().toast({
            kind: 'success',
            title: `${artifact.name} attached`,
            detail: `${activeRepo} @ ${activeBranch} · it will be sent with your next message.`,
          })
        }
        return artifact
      } catch (err) {
        useUI.getState().toast({ kind: 'error', title: `Couldn't attach ${baseName(path)}`, detail: textOf(err) })
        return null
      }
    },

    /* ---------------- search ---------------- */

    runSearch: async (query) => {
      const repo = get().activeRepo
      const q = query.trim()
      if (!repo || !q) {
        set({ search: null, searchError: undefined })
        return
      }
      searchController?.abort()
      const controller = new AbortController()
      searchController = controller
      set({ searchLoading: true, searchError: undefined })
      try {
        const hits = await searchCode(repo, q, { token: get().token || undefined, signal: controller.signal })
        set({ search: { repo, query: q, hits, at: Date.now() }, searchLoading: false })
      } catch (err) {
        if (isAbort(err)) return
        set({
          searchLoading: false,
          searchError:
            isGitHubError(err) && err.kind === 'forbidden'
              ? 'Code search needs a token with the `repo` scope (and a moment for GitHub to index a fresh push).'
              : textOf(err),
        })
      }
    },

    clearSearch: () => {
      searchController?.abort()
      set({ search: null, searchError: undefined, searchLoading: false })
    },

    attachHit: async (hit) => {
      const repo = hit.repository?.full_name ?? get().activeRepo
      const current = get().activeRepo
      // Search can return files from a different repo than the one being browsed.
      if (repo && repo !== current) {
        set({ activeRepo: repo })
      }
      const artifact = await get().attachFile(hit.path)
      if (repo && repo !== current) set({ activeRepo: current })
      return artifact
    },

    /* ---------------- publishing ---------------- */

    setPublishDefaults: (patch) => {
      set({ publishDefaults: { ...get().publishDefaults, ...patch } })
      persist()
    },

    publish: async (req) => {
      const token = get().token
      set({ publishing: true, publishError: undefined, publishStep: undefined })
      try {
        const result = await executePublish(req, {
          token,
          signal: undefined,
          onStep: (step) => set({ publishStep: step }),
        })
        set({ publishing: false, publishStep: undefined, lastPublish: result })
        return result
      } catch (err) {
        set({ publishing: false, publishStep: undefined, publishError: publishErrorMessage(err) })
        return null
      }
    },

    dismissPublishError: () => set({ publishError: undefined }),
  }
})

/* ------------------------------------------------------------------ */
/* Rate-limit mirror (shown in the panel footer)                       */
/* ------------------------------------------------------------------ */

onRateInfo((info) => {
  if (info.rate) useGitHub.setState({ rate: info.rate })
})

/* ------------------------------------------------------------------ */
/* Small derived helpers used by the UI                                */
/* ------------------------------------------------------------------ */

/** True when the token can create commits/issues (private repos included). */
export function canWriteRepos(scopes: string[]): boolean {
  return scopes.includes('repo') || scopes.includes('public_repo')
}

export function canGist(scopes: string[]): boolean {
  return scopes.includes('gist')
}

export function repoShortName(fullName?: string): string {
  if (!fullName) return ''
  return fullName.split('/')[1] ?? fullName
}
