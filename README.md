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

## Privacy & security

API keys stay in your browser's local storage and are sent **only** to the provider you
configured, for the messages you send. There is no telemetry, no backend, no analytics.
Prompts and attachments go nowhere else.

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
npm run preview    # serve the production build
npm run test:smoke # headless engine + provider tests (no browser, no API keys)
```

## Layout

```
src/
  engine/       failover chain walk, routing strategies, turn builder
  providers/    openai · anthropic · google · openrouter · openai-compatible · built-in mock
  store/        zustand stores + persistence + cooldown policy
  components/   chat, artifacts, settings, layout, common
  lib/          mime classification, csv, clipboard, schemas, storage
```
