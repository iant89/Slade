import { useState } from 'react'
import { useGitHub } from '../../store/github'
import { GhEmpty, GhError, Spinner } from './bits'
import { IconExternal, IconPaperclip, IconSearch } from '../icons'

/**
 * Search tab: GitHub code search scoped to the open repository.
 *
 * Code search is the fastest way to find "the file that does X" in a repo too
 * big to browse, and the snippet it returns is often enough on its own.
 */
export function CodeSearch() {
  const { activeRepo, search, searchLoading, searchError, token } = useGitHub()
  const runSearch = useGitHub((s) => s.runSearch)
  const clearSearch = useGitHub((s) => s.clearSearch)
  const attachHit = useGitHub((s) => s.attachHit)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  if (!activeRepo) {
    return (
      <div className="gh-tab-body">
        <GhEmpty title="No repository open" detail="Open a repository in the Repos tab, then search inside it." />
      </div>
    )
  }

  const submit = () => {
    const q = query.trim()
    if (q) void runSearch(q)
  }

  return (
    <div className="gh-tab-body">
      <div className="gh-search-inline">
        <IconSearch size={13} />
        <input
          className="gh-input"
          value={query}
          placeholder={`Search code in ${activeRepo}…`}
          aria-label="Search code in this repository"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') clearSearch()
          }}
        />
        <button className="btn primary small" onClick={submit} disabled={!query.trim() || searchLoading} type="button">
          Search
        </button>
      </div>
      <p className="gh-muted">
        GitHub&rsquo;s own index — supports qualifiers like <code>language:ts</code>, <code>path:src</code>, <code>filename:test</code>.
        {!token ? (
          <>
            {' '}
            <strong>Sign in first:</strong> GitHub answers anonymous code searches with an empty result set, so this tab
            only works with a token.
          </>
        ) : null}
      </p>

      {searchLoading ? <Spinner label="Searching…" /> : null}
      {searchError ? <GhError onRetry={submit}>{searchError}</GhError> : null}
      {!searchLoading && !searchError && !search ? (
        <GhEmpty title="Search this repository" detail="Results attach to the composer the same way browsed files do." icon={<IconSearch size={18} />} />
      ) : null}
      {search && search.hits.length === 0 ? <GhEmpty title="No matches" detail={`Nothing indexed for “${search.query}”.`} /> : null}

      <ul className="gh-hits">
        {(search?.hits ?? []).map((hit) => (
          <li key={hit.sha + hit.path} className="gh-hit">
            <div className="gh-hit-head">
              <button className="gh-hit-path" onClick={() => void attachHit(hit)} title={hit.path} type="button">
                {hit.path}
              </button>
              <a className="icon-btn small" href={hit.html_url} target="_blank" rel="noreferrer" aria-label="Open on GitHub" title="Open on GitHub">
                <IconExternal size={13} />
              </a>
              <button
                className="icon-btn small"
                disabled={busy === hit.path}
                onClick={async () => {
                  setBusy(hit.path)
                  await attachHit(hit)
                  setBusy(null)
                }}
                aria-label={`Attach ${hit.path}`}
                title="Attach to the next message"
                type="button"
              >
                <IconPaperclip size={12} />
              </button>
            </div>
            {hit.text_matches?.[0]?.fragment ? (
              <pre className="gh-hit-fragment">{hit.text_matches[0].fragment.trim().slice(0, 500)}</pre>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
