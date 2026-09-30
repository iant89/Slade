# Git vs. GitHub: where the seam goes

A design note, prompted by a good question: *should the actual Git protocol be split
from the GitHub part, and can we emulate 100% of the git binary?*

Short answer:

1. **Split yes — but along semantics, not wire protocol, and as a refactor first.**
   The thing that is really Git (objects, trees, refs, modes, diffs, commits) is
   currently glued to the thing that is really GitHub (REST verbs, tokens, rate
   limits, gists, issues, search). `commitTree()` is the clearest symptom: 90 lines
   of Git semantics assembled out of GitHub API parts.
2. **"100% of the git binary" — no, and it is the wrong target.** A browser can be
   *100% byte-compatible with the Git object format* (proven below), which is the
   property that buys interoperability, and *100% of the operations Slade actually
   performs*. It cannot host the git binary's process model, its transports, or its
   POSIX worktree, and for GitHub specifically the protocol path is CORS-blocked and
   would put a `repo`-scoped token in front of a stranger's proxy — a straight
   downgrade from today's design.

---

## 1. What the code does today

`src/lib/github.ts` (939 lines) is four modules wearing one coat:

| What's in there | What it really is |
| --- | --- |
| `ghFetch`, `classify`, `publishRate`, token header | transport + error taxonomy |
| `bytesToBase64`, `encodePath`, `mimeForPath`, `extOf` | pure helpers, no forge involved |
| `getTree`, `readFile`, `fileSha`, `commitTree`, `createBranch` | **Git**: objects, refs, parents, trees, commits |
| `getRepo`, `listRepos`, `searchCode`, `createGist`, `createIssue`, `getUser`, `getRateLimit` | **GitHub**: forge-specific product surface |

`github-auth.ts` (device flow + relay) and `github-publish.ts` are correctly separated
already — the split above is the one that hasn't happened. Note `src/lib/mime.ts`
and `src/lib/fs.ts` already duplicate some of what `github.ts` keeps private, which is
the same seam trying to appear twice.

## 2. Where the seam should go

```
src/lib/http.ts          transport: fetch, retries, AbortSignal, error kinds,
                         action-card telemetry hook, rate-limit headers
src/lib/git/             Git: objects, oid/sha1, refs, trees, modes, index, diff,
                         commit building, (later) pkt-line + packfile
src/lib/forge/github.ts  GitHub: user, repos, search, issues, gists, PRs, and the
                         Git-Data-API *implementation* of git/ operations
src/lib/git/transport.ts interface GitTransport { getRefs, fetchObjects, push }
                          ├─ github-rest   (today: blobs/trees/commits/refs API)
                          └─ smart-http    (later: pkt-line over the relay)
```

The load-bearing idea: **`commitTree` becomes a Git operation with a pluggable
transport**, not a GitHub function. Its current body — resolve branch → read base
commit → read base tree → apply entries → create commit with `parents: [base]` → move
the ref — is *exactly* what `git commit-tree` + `git update-ref` do. Only the verbs
change.

## 3. What "100%" can and cannot mean in a browser

Measured on 2026-09-30, not assumed.

### Reachable — and verified byte-exact

A loose object is `"<type> <len>\0" + payload`, zlib-deflated on disk, SHA-1'd
uncompressed. Trees are sorted entries of `"<mode> <name>\0" + 20 raw oid bytes`. That
is the whole format, and it is ~60 lines:

```js
const oid = (type, payload) => sha1(concat([utf8(`${type} ${payload.length}\0`), payload]))
```

I reproduced a real repository's objects with exactly that and compared against the
system `git`:

| Object | `git` | pure JS |
| --- | --- | --- |
| blob `a.txt` (`hello\n`) | `ce013625030ba8dba906f756967f9e9ca394464a` | ✅ match |
| blob `src/x.ts` | `09b76aaa26ac6afc3f6b09805e8ede78e0637954` | ✅ match |
| tree `src/` | `46b3c6dd32a7b0784d556d63006ba2c7db869690` | ✅ match |
| tree `/` | `ab0acbce363d0c46fcf72a3f139c595bc8beb08a` | ✅ match |
| commit `HEAD` | `107ac49f6bb3e0a1247f7a465d1bc9e9a76441ff` | ✅ match |

It failed the first time on one byte-level detail: a subtree's mode is written
**`40000`**, not the `040000` that `git cat-file -p` pretty-prints. Nothing in Slade
would have noticed — the UI would have looked perfect and every commit it wrote would
have been corrupt. That is the argument for conformance tests against real `git`
fixtures, and against "it rendered fine".

### Reachable with real work

- packfiles (v2, delta chains, ofs/ref deltas), pkt-line, `want`/`have` negotiation,
  side-band — i.e. *the actual Git protocol*. This is the multi-thousand-line part,
  and it is what people mean by "emulate git".
- index (v2/v3/v4), merge with diff3, checkout with sparse paths, partial clone filters
  (`blob:none`, `tree:0` — GitHub's advertisement does offer `filter`).
- commit signing: not `gpg`, but WebCrypto + the standard `gpgsig` header is
  byte-for-byte what a verifier expects.

### Never, in a browser

- **Transports:** `ssh://`, `git://`. `file://` only as a same-origin fetch.
- **Process model:** hooks, `credential.helper`, `fsmonitor`, external diff/merge
  drivers, `git-remote-*` helpers. No `fork(2)` on the web, and no amount of WASM adds
  one. This is the "100% of the *binary*" line, and it is uncrossable.
- **POSIX worktree:** the executable bit, symlinks, hardlinks, xattrs, case
  sensitivity, mtimes. IndexedDB and OPFS are a filesystem-shaped API, not a filesystem.
- **Scale:** a monorepo in IndexedDB dies; memory-bound pack indexing dies sooner.
  Partial clone is the only mitigation, and it only goes so far.
- **Git LFS:** a separate batch API and object store — its own integration, not a
  protocol flag.
- And even the "we ship the whole engine" option isn't the git binary: `wasm-git` is
  **libgit2** compiled to WASM, which is a different implementation with its own
  porcelain gaps, and it still needs a CORS proxy for github.com.

### Bundle cost, for the record

| Option | Unpacked |
| --- | --- |
| hand-rolled object layer (§3) | **~2.5 KB** |
| `isomorphic-git` 1.42.4 | 4,940,351 B |
| `wasm-git` 0.0.17 | 6,555,324 B |

Unpacked ≠ shipped, and isomorphic-git tree-shakes — but the WASM path is
unavoidably megabytes, in an app whose pitch is that it never stalls.

## 4. Why GitHub specifically should stay on the REST API

Measured today:

| Endpoint | CORS |
| --- | --- |
| `https://api.github.com/repos/octocat/Hello-World` | `access-control-allow-origin: *` ✅ |
| `https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack` | 200, valid pkt-line ad, **no ACAO** ❌ |
| `OPTIONS` on that same URL (what an `Authorization` header triggers) | **405**, `allow: GET` ❌ |

So the smart-HTTP path is doubly blocked: public reads fail on the missing header,
private reads fail the preflight outright. It needs a proxy. Slade already has a relay
for OAuth, but that relay is safe *because it is narrow* — two endpoints, allowlisted
parameters, no secret, nothing logged, and above all **no user credential ever passes
through it**. A git-protocol proxy cannot be narrow: it must forward arbitrary bodies
to arbitrary `<host>/<path>.git/git-upload-pack|receive-pack`, and a private repo
requires the `repo`-scoped token to ride through it. On the maintainer-hosted relay
that means every user's push-capable token transits someone else's infrastructure.
Today it does not, and that property is worth more than the protocol.

The Git Data API is also already a Git-shaped API: it *is* blobs, trees, commits and
refs, just addressed over REST. Slade loses less than it looks by staying there.

## 5. What to actually do

**P0 — pure refactor, no behavior change.** Extract `http.ts` / `git/` / `forge/github.ts`
as in §2. Move `commitTree` behind `git/commit.ts` with a forge-agnostic signature.
While in there, fix a real bug: `commitTree` hardcodes `mode: '100644'` for every entry,
so a committed shell script loses its `+x` bit and a committed symlink becomes a
regular file containing the target path. Modes belong to the Git layer, and they are
the kind of thing the split makes visible. The existing fake `api.github.com` in
`scripts/smoke.ts` is a ready-made harness for the REST transport.

**P1 — the object layer, which pays off without any protocol.** Compute oids locally.
Then Local Files can be diffed against a real remote ref, a commit can be *built*
offline from an agent run's file blocks, and published as one atomic change instead of
one blob POST per file. It also opens the honest version of a feature Slade currently
declines: local commits without a network. Conformance gate: hash fixtures with the
system `git` in `npm run test:smoke` and assert equality (`git` is already the
reference; no browser needed).

**P2 — transport interface, only when a feature demands it.** Add `smart-http` behind
`GitTransport` for forges without a CORS-enabled API (Codeberg, self-hosted Gitea) and
for partial-clone reads. Gate it by setting, keep the proxy pinned to a host allowlist,
and make read-only (`upload-pack`) the default so push-capable credentials can't transit
it until someone opts in.

**P3 — the agent's "git binary" is a tool vocabulary, not a shell.** The README is
explicit that Slade does not run shell commands, checkouts or test runners; that stance
is right, and P1 buys most of what a shell would: `git.status`, `git.diff`, `git.log`,
`git.commit`, `git.show` over Local Files, backed by the real object model, deterministic
and offline. Executing the *binary* is neither necessary nor the point. Emulating the
*binary's semantics for the operations Slade offers* is.

## 6. One-line summary

Split it — into transport, Git objects, and forge — and aim for **100% object-format
compatibility and 100% coverage of the operations Slade performs**, not 100% of a
program whose defining feature is being able to spawn a subprocess.
