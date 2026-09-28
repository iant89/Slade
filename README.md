# SLADE

**One chat window. Every AI model. Never stalls.**

Slade is a production-grade single-page chat application built with React + TypeScript.
You type one prompt; Slade routes it to the best available model — and when that model
hits a rate limit, runs out of quota, times out, or errors, the built-in failover engine
silently re-issues the request down your priority chain **without losing the conversation,
the context, or your place in the thread**. Partial output survives mid-stream handoffs,
marked with a subtle divider.

The name is a knowing wink at the model everyone's already using: Slade sits in front of
Claude, GPT, Gemini and the rest, so the app you're talking to always keeps talking.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

No keys needed to try it: two built-in **simulator models** (`Simulacron Pro`, `Simulacron
Lite`) stream realistic Markdown answers, emit artifacts, and can *simulate failures* so
you can watch the failover engine work.

**Try this first**

1. Send a message — watch it stream token-by-token with a blinking cursor.
2. Open the right-hand **Model chain** panel and set *Simulacron Pro* to
   `simulate: rate limit`, then send another message. The request fails over to
   *Simulacron Lite*; the reply is labeled `Simulacron Lite ← fell back from Simulacron Pro`,
   and Pro enters a visible cooldown.
3. Set it to `simulate: mid-stream timeout` and send again — the handoff happens
   mid-answer; the text so far is preserved and a divider marks the switch.
4. Ask to *"generate a CSV of Q3 sales"* — an interactive, sortable spreadsheet artifact
   card lands in the thread.
5. Use `/sample` in the composer (or drag & drop any file) to attach a CSV, TypeScript
   file, Markdown doc, image or WAV — each renders as a rich, type-aware artifact card.
6. Add real API keys in **Settings → Providers** (OpenAI, Anthropic, Google Gemini,
   **OpenRouter** — one key in front of hundreds of models — or any OpenAI-compatible
   endpoint such as Groq/Ollama) to route to live models with the same engine.
7. Hit the **GitHub** button in the header (or `Ctrl/Cmd + G`), sign in with the device
   flow, open a repo and attach a file — then ask about it. Or take any answer and
   **Publish to GitHub** as a gist, a commit or an issue. See
   [GitHub (repo context & publishing)](#github-repo-context--publishing).

## The failover engine

- **Ordered model registry** — your priority queue; drag to reorder anywhere models appear.
- **Limit detection** — every failure is classified: `soft_rate_limit`, `hard_quota`,
  `auth`, `timeout`, `network`, `overloaded`, `aborted`, `unknown` — each with its own
  handling policy.
- **Automatic switching** — re-issue with full conversation context and attachments intact.
- **Cooldowns & backoff** — exhausted models get timed cooldowns with exponential backoff
  (soft limits ~30 s doubling; hard quota and auth ~5 min doubling), never permanent bans.
- **Health tracking** — per-model state (available / cooling down / disabled / erroring),
  latency EMA, request and token counters, last error.
- **Strategies** — strict priority, fastest-first (measured latency), or cheapest-first.
- **Manual control** — pin a primary model, per-conversation model override, per-message
  retry with cooldowns cleared.
- **Idempotent** — a failover never duplicates the prompt or double-charges the turn.

## Artifact cards

Every file — attached by you or emitted by a model (` ```csv:name.csv ` fenced blocks
become cards automatically) — renders as a consistent card with filename, size,
provenance, and actions (expand/collapse, download, copy reference, **send back to model
as context**):

| Type | Preview |
| --- | --- |
| Images | inline thumbnail → lightbox with zoom (wheel/double-click), pan, download |
| Code | syntax-highlighted, scrollable, copy button |
| Documents | Markdown rendered, text/monospace, PDF via embedded viewer + "open full document" |
| Spreadsheets | interactive sortable table (click headers), sticky headers, row counts |
| Audio | inline player with decoded waveform scrubber, duration, playback speed |
| Video | inline player with full-screen |
| Archives / unknown | neutral card with MIME, size, download |

Files pulled in from a GitHub repository are the same cards, with their origin
kept on the card (`repo @ ref`, path, "open on GitHub") and a **Publish to
GitHub** action in the footer.

## GitHub (repo context & publishing)

Open the workspace with the GitHub button in the header or `Ctrl/Cmd + G`. Two
halves, both wired into the thread:

- **Repo context** — browse your repositories (or open any public one by URL),
  read files, search code with GitHub's own index, and attach whatever you find
  straight into the composer. Attached repo files become artifact cards and fold
  into the prompt exactly like an upload, with the source recorded.
- **Publishing** — every artifact card and every message has *Publish to
  GitHub*: create a **gist** (secret by default), **commit a file** into a repo
  (binary files too; existing paths update in place, or commit onto a fresh
  branch with one toggle), or open an **issue** with the content in the body and
  a provenance block underneath.

### Signing in: device flow, no secrets

Slade never asks for your password and holds no client secret. Sign-in uses
GitHub's **device flow**: Slade shows a short code, you approve it on
github.com, and the token comes back to the browser.

One honesty note about the plumbing: **github.com's OAuth endpoints are not
CORS-enabled** (deliberately — see
[community discussion #40077](https://github.com/orgs/community/discussions/40077)),
so a static page cannot call them itself. Slade sends exactly two calls —
`/login/device/code` and `/login/oauth/access_token` — through a relay that does
nothing else: it accepts only the parameters the device flow defines, forwards no
client secret (the flow has none) and logs nothing. Everything afterwards goes
straight to `api.github.com`, which *is* CORS-enabled.

| Setup | What to do |
| --- | --- |
| Local dev / preview | Nothing — `npm run dev` serves those two endpoints from Vite middleware (`scripts/github-oauth-relay.ts`) |
| Static hosting (e.g. Pages) | Deploy `workers/github-oauth-relay` (`cd workers/github-oauth-relay && npx wrangler deploy`) and paste its URL into **Settings → GitHub → Sign-in relay**, or build with `VITE_GITHUB_RELAY=…` |
| Rather not run a relay | The same connect card accepts a personal access token with `repo` + `gist` + `read:user` |

Create the OAuth app once — GitHub → Settings → Developer settings → OAuth apps
→ **New OAuth App** (the callback URL is unused) → tick **Enable Device Flow** →
copy the **Client ID** into **Settings → GitHub**. A deployment can ship that ID
as `VITE_GITHUB_CLIENT_ID` so visitors have nothing to configure.

### What the token is used for

| Scope | Used for |
| --- | --- |
| `repo` | listing repositories, reading trees/blobs, committing published artifacts, opening issues |
| `gist` | publishing an artifact or an answer as a gist |
| `read:user` | showing which account is connected |

- The token lives in **local storage under its own key** (`slade.github.v1`),
  is masked in the UI, never logged, and is **excluded from Data → Export** so a
  backup file can never carry a live credential.
- Slade shows the live API budget in the workspace footer (`x-ratelimit-*`), and
  a `403` with no budget left is reported as *rate limited — resets at HH:MM*
  rather than as a generic failure.
- Every GitHub failure is classified (`auth`, `forbidden`, `not_found`,
  `rate_limit`, `conflict`, `validation`, `network`, `server`) and keeps GitHub's
  own sentence, the same way model failures do.

## Chat experience

- Token-by-token streaming with typing indicator, progressive Markdown, and blinking cursor
- Full history persisted across sessions (localStorage, zod-validated on load)
- Virtualized message list with smart auto-scroll that yields the moment you scroll up
  (with a "jump to latest" affordance)
- Message actions: copy, regenerate, **edit-and-resend**, delete, **branch-from-here**
- Composer: auto-grow input, Enter/Shift-Enter (configurable), char/token counter,
  drag-and-drop & paste-to-attach, slash shortcuts (`/system`, `/model`, `/sample`, `/new`)
- Stop generation at any time — partial answers are kept

## Settings (Ctrl/Cmd + ,)

- **Models** — enable/disable, drag-reorder priority, per-model temperature / max-tokens /
  system-prompt overrides, usage counters, failure simulation for demo models
- **Defaults** — temperature, top-p, max tokens, system prompt, streaming, typing
  indicator, auto-scroll, failover strategy, first-token timeout, stream timeout,
  artifact preferences
- **GitHub** — device-flow sign-in, OAuth app client ID, sign-in relay URL, requested
  scopes, and publishing defaults (target, repository, branch, path prefix, secret
  gists, new-branch commits)
- **Providers** — masked API keys (stored locally, never logged), connection tests with
  instant pass/fail and real generation, and first-class OpenRouter support
  (`openrouter/auto` ships in the default registry; any `vendor/model` id works, with
  Slade's attribution headers and streamed token usage)
- **Appearance** — light/dark/system theme, font size, message density, code theme,
  reduced motion, Enter-to-send
- **Data** — export/import everything as JSON, clear history, reset to defaults

## When a turn fails

A failed turn is only useful if it says *why*. Slade keeps the provider's own
explanation end to end:

- Every attempt is classified (`auth`, `hard_quota`, `soft_rate_limit`, `bad_request`,
  `timeout`, `network`, `overloaded`, `aborted`) **and** carries the provider's message,
  the HTTP status and how long the attempt took.
- The error banner under the turn lists each model that was tried, with its reason, and
  offers **Copy** for a full diagnostics dump.
- "Test" in **Settings → Providers** sends a real request to the model you have actually
  configured, not a cheap `GET /models`. A key that can list models but cannot generate
  with them — blocked key, depleted credit, no access to that model — fails the test
  with the reason attached instead of showing a green light.
- `bad_request` (HTTP 400 and friends) and `auth` failures never put a model into
  cooldown: waiting cannot fix a payload the provider already refused, and benching the
  model would only hide the message on the next turn.
- First-token and stream timeouts are separate budgets. Reasoning models (Gemini 2.5,
  o-series, extended thinking) get a generous first-token window instead of being cut
  off mid-thought and benched for it.

### Common provider messages

| The message says | What it means |
| --- | --- |
| `max_output_tokens must be greater than the thinking budget` | Gemini 2.5 thinking models need a **Max tokens** value above the thinking budget — raise it, or cap thinking per model. |
| `Your prepayment credits are depleted` | The Google key's billing account is out of credit. |
| `Requests to this API method … are blocked` | Google blocked the key (it was found publicly exposed). Rotate it in AI Studio. |
| `Network error — the browser could not reach the provider` | CORS, an ad blocker, or no route. Slade is a static SPA and calls providers straight from the browser; a corporate proxy or restrictive extension will block it. |
| `No response after Ns — the request never produced a first token` | The request was accepted but nothing came back. Check the route, then raise **First-token timeout** if the model is simply slow to think. |

## Deploy to GitHub Pages

Deployment is fully automated via GitHub Actions (`.github/workflows/deploy-pages.yml`):

- **Triggers** — every push to `main`, plus a manual *Run workflow* button
  (Actions → Deploy to GitHub Pages → Run workflow).
- **Build** — `npm ci && npm run build` with `VITE_PUBLIC_BASE=/<repo>/` so asset
  URLs match the project-page path `https://<user>.github.io/<repo>/` (the base
  is read in `vite.config.ts`; local dev stays at `/`).
- **Deploy** — the official `actions/upload-pages-artifact` + `actions/deploy-pages`
  flow (no orphan `gh-pages` branch). A `.nojekyll` is shipped so GitHub serves
  `dist/` as-is, and `actions/configure-pages` with `enablement: true` flips
  Settings → Pages → Source to *GitHub Actions* automatically on the first run.

To deploy manually without CI:

```bash
VITE_PUBLIC_BASE=/Slade/ npm run build   # adjust if the repo is renamed
npx vite preview                         # serves the production build
```

The Pages build is static, so the OAuth relay is **not** part of it: the deployed
app needs either a relay URL or a pasted token (see the GitHub section above).
Bake in both values when building so users configure nothing:

```bash
VITE_GITHUB_RELAY=https://slade-github-oauth.<you>.workers.dev \
VITE_GITHUB_CLIENT_ID=Iv1.xxxxxxxx \
VITE_PUBLIC_BASE=/Slade/ npm run build
```

## Privacy & security

API keys and the GitHub token stay in your browser's local storage and are sent **only**
to the provider (or GitHub) you configured, for the actions you take. There is no
telemetry, no backend, no analytics. Prompts and attachments go nowhere else.

GitHub specifics: the sign-in relay sees exactly two OAuth calls — a device code and the
token GitHub returns for it — and nothing else, and it holds no secret of its own. Repo
files are only fetched when you open or attach them, publishing only happens when you
press the button, and the token is left out of exported backups.

## Stack & quality bar

- React 18 + strict TypeScript, discriminated unions for provider events / failure
  classes / artifact kinds, zod-validated persisted config
- Zustand stores (settings, chat, health, artifacts, UI) with debounced persistence
- react-virtuoso (virtualized thread), react-markdown + remark-gfm + rehype-highlight,
  lowlight, framer-motion spring transitions
- WCAG-minded: keyboard operability, focus-trapped modal, ARIA live regions announcing
  streamed responses, visible focus, reduced-motion support, AA-contrast themes
- Graceful degradation: missing previews fall back to neutral cards; when every model in
  the chain fails you get a per-model breakdown with the provider's own reason and a
  one-click retry

```bash
npm run build      # type-checks then produces dist/
npm run preview    # serve the production build (relay included)
npm run test:smoke # headless engine, provider and GitHub tests (no browser, no keys)
```

`test:smoke` covers the GitHub integration end to end against a fake
`api.github.com` and a fake relay: repo/tree/blob reads, the >1 MB blob
fallback, base64 for binaries, every error classification (including
rate-limit reset times and token redaction), the device-flow state machine
(pending, slow-down, expired, denied, aborted), the new-branch commit path,
gist/issue payloads, and the loop that matters most — *attach a repo file →
its contents appear in the next prompt*.

## Layout

```
src/
  engine/       failover chain walk, routing strategies, turn builder
  providers/    openai · anthropic · google · openrouter · openai-compatible · built-in mock
  store/        zustand stores + persistence + cooldown policy
  components/   chat, artifacts, settings, layout, github, common
  lib/          mime classification, csv, clipboard, schemas, storage,
                github (REST client, device flow, publish payloads)
scripts/
  smoke.ts                  headless test suite
  github-oauth-relay.ts     the two OAuth calls, proxied for dev/preview
workers/
  github-oauth-relay/       the same relay as a deployable Cloudflare Worker
```
