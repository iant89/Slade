import { useEffect, useMemo, useRef } from 'react'
import { FilterCombobox, type ComboboxOption } from '../common/FilterCombobox'
import { useGitHub } from '../../store/github'
import { useUI } from '../../store/ui'
import { parseRepoInput, type GitHubBranch, type GitHubRepo } from '../../lib/github'
import { IconBranch, IconGithub, IconRepo } from '../icons'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Split "owner/name" so the owner can be dimmed in labels. */
function repoLabel(fullName: string) {
  const i = fullName.indexOf('/')
  if (i < 0) return fullName
  return (
    <>
      <span className="cb-owner">{fullName.slice(0, i + 1)}</span>
      {fullName.slice(i + 1)}
    </>
  )
}

/** One muted line: description · tags (or sensible fallbacks). */
function repoHint(r: GitHubRepo): string {
  const tags: string[] = []
  if (r.private) tags.push('private')
  if (r.archived) tags.push('archived')
  if (r.language) tags.push(r.language)
  const tail = tags.join(' · ')
  const desc = r.description?.trim() ?? ''
  const text = desc && tail ? `${desc} · ${tail}` : desc || tail || `default branch: ${r.default_branch}`
  return text.length > 110 ? `${text.slice(0, 109)}…` : text
}

function branchHint(b: GitHubBranch, isDefault: boolean): string | undefined {
  const tags: string[] = []
  if (isDefault) tags.push('default')
  if (b.protected) tags.push('protected')
  return tags.length ? tags.join(' · ') : undefined
}

/* ------------------------------------------------------------------ */
/* Repository combobox                                                 */
/* ------------------------------------------------------------------ */

function RepoCombobox() {
  const activeRepo = useGitHub((s) => s.activeRepo)
  const recentRepos = useGitHub((s) => s.recentRepos)
  const repos = useGitHub((s) => s.repos)
  const reposLoading = useGitHub((s) => s.reposLoading)
  const reposError = useGitHub((s) => s.reposError)
  const token = useGitHub((s) => s.token)
  const login = useGitHub((s) => s.login)
  const tree = useGitHub((s) => s.tree)
  const loadRepos = useGitHub((s) => s.loadRepos)
  const openRepo = useGitHub((s) => s.openRepo)
  const toast = useUI((s) => s.toast)

  // Pull the repo list in the background as soon as there is a token, so the
  // composer selector is ready before the user ever opens the GitHub panel.
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current || !token) return
    bootstrapped.current = true
    void loadRepos()
  }, [token, loadRepos])

  const options = useMemo<ComboboxOption[]>(() => {
    const byName = new Map(repos.map((r) => [r.full_name, r] as const))
    const seen = new Set<string>()
    const out: ComboboxOption[] = []
    const add = (fullName: string) => {
      if (!fullName || seen.has(fullName)) return
      seen.add(fullName)
      const r = byName.get(fullName)
      out.push(
        r
          ? {
              value: r.full_name,
              text: `${r.full_name} ${r.description ?? ''} ${r.language ?? ''} ${r.default_branch}`,
              label: repoLabel(r.full_name),
              hint: repoHint(r),
            }
          : { value: fullName, text: fullName, label: repoLabel(fullName) },
      )
    }

    // Active first, then recents, then the rest alphabetically (archived last)
    // — the same ordering the Repos tab uses.
    if (activeRepo) add(activeRepo)
    recentRepos.forEach(add)
    ;[...repos]
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.full_name.localeCompare(b.full_name))
      .forEach((r) => add(r.full_name))
    return out
  }, [repos, recentRepos, activeRepo])

  // Typing "owner/name" (or a github.com URL) offers to open it directly —
  // useful for public repos that are not in the loaded list. A bare word is
  // left alone: it is just a filter, not a repository path.
  const extras = useMemo(() => {
    return (q: string): ComboboxOption[] => {
      if (!q.includes('/')) return []
      const parsed = parseRepoInput(q, login ?? undefined)
      if (!parsed || options.some((o) => o.value === parsed.fullName)) return []
      return [
        {
          value: parsed.fullName,
          text: `${q} ${parsed.fullName}`,
          label: (
            <>
              <IconGithub size={12} /> Open <strong>{parsed.fullName}</strong>
            </>
          ),
          hint: 'Not in the list — open by name (public repos work without signing in)',
        },
      ]
    }
  }, [options, login])

  const select = (fullName: string) => {
    if (fullName === activeRepo && tree?.repo === fullName) return
    void openRepo(fullName).then((ok) => {
      if (!ok) {
        const detail = useGitHub.getState().treeError
        toast({ kind: 'error', title: `Couldn't open ${fullName}`, ...(detail ? { detail } : {}) })
      }
    })
  }

  const empty = (
    <>
      {reposLoading ? (
        'Loading your repositories…'
      ) : reposError ? (
        "Couldn't load your repositories."
      ) : token ? (
        <>No repositories found{login ? ` for @${login}` : ''}.</>
      ) : (
        'No repositories yet.'
      )}{' '}
      {token ? (
        <button className="link-btn" type="button" onClick={() => void loadRepos({ force: true })}>
          Reload
        </button>
      ) : (
        <button
          className="link-btn"
          type="button"
          onClick={() => useUI.getState().openGithub('repos')}
        >
          Connect GitHub
        </button>
      )}
    </>
  )

  return (
    <FilterCombobox
      className="cb-repo"
      value={activeRepo ?? ''}
      options={options}
      extras={extras}
      onSelect={select}
      placeholder="Select repository…"
      ariaLabel="Repository"
      filterPlaceholder="Filter repositories…"
      title="Repository — the open repo's files become workspace context for the agent"
      icon={<IconRepo size={13} />}
      loading={reposLoading}
      loadingText="Loading repositories…"
      notice={reposError ? <span className="cb-repo-error">{reposError}</span> : null}
      empty={empty}
      minWidth={320}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Branch combobox                                                     */
/* ------------------------------------------------------------------ */

function BranchCombobox() {
  const activeRepo = useGitHub((s) => s.activeRepo)
  const activeBranch = useGitHub((s) => s.activeBranch)
  const branches = useGitHub((s) => s.branches)
  const branchesLoading = useGitHub((s) => s.branchesLoading)
  const repos = useGitHub((s) => s.repos)
  const loadBranches = useGitHub((s) => s.loadBranches)
  const setBranch = useGitHub((s) => s.setBranch)

  // Eagerly fetch the branch list when it is missing for the active repo
  // (e.g. a repo restored from a previous session) — one attempt per repo so
  // a failing endpoint can never spin into a retry loop.
  const triedRepo = useRef<string | null>(null)
  useEffect(() => {
    if (!activeRepo || branches.length > 0 || branchesLoading) return
    if (triedRepo.current === activeRepo) return
    triedRepo.current = activeRepo
    void loadBranches()
  }, [activeRepo, branches.length, branchesLoading, loadBranches])

  const defaultBranch = repos.find((r) => r.full_name === activeRepo)?.default_branch

  const options = useMemo<ComboboxOption[]>(() => {
    const seen = new Set<string>()
    const out: ComboboxOption[] = []
    const add = (b: GitHubBranch) => {
      if (!b.name || seen.has(b.name)) return
      seen.add(b.name)
      out.push({
        value: b.name,
        text: b.name,
        label: b.name,
        hint: branchHint(b, b.name === defaultBranch),
      })
    }
    if (activeBranch) add({ name: activeBranch, commit: { sha: '' } })
    ;[...branches]
      .sort((a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch) || a.name.localeCompare(b.name))
      .forEach(add)
    return out
  }, [branches, activeBranch, defaultBranch])

  return (
    <FilterCombobox
      className="cb-branch"
      value={activeBranch ?? ''}
      options={options}
      onSelect={(branch) => {
        if (branch !== activeBranch) void setBranch(branch)
      }}
      placeholder="Select branch…"
      ariaLabel="Branch"
      filterPlaceholder="Filter branches…"
      title={activeRepo ? `Branch of ${activeRepo}` : 'Branch — pick a repository first'}
      icon={<IconBranch size={13} />}
      loading={branchesLoading}
      loadingText="Loading branches…"
      empty={
        <>
          {activeRepo ? 'No branches found for this repository.' : 'Open a repository first.'}{' '}
          <button
            className="link-btn"
            type="button"
            onClick={() => useUI.getState().openGithub('repos')}
          >
            Browse repositories
          </button>
        </>
      }
      minWidth={260}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Composer footer group                                               */
/* ------------------------------------------------------------------ */

/**
 * Repository + branch comboboxes docked at the bottom of the composer.
 * Both switch the shared GitHub workspace (`useGitHub`), so the agent's
 * tree context, file panel and publish targets follow along.
 */
export function RepoBranchPickers() {
  return (
    <div className="composer-context">
      <RepoCombobox />
      <BranchCombobox />
    </div>
  )
}
