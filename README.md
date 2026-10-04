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
   endpoint such as Groq/Ollama) to route to live models with the same engine. Providers
   are managed like models: **Add a provider** opens a dialog with every supported one,
   and each connection has its own key, endpoint and models — so Groq and Ollama can
   live side by side as two OpenAI-compatible connections.
7. Hit the **GitHub** button in the header (or `Ctrl/Cmd + G`), sign in with the device
   flow, open a repo and attach a file — then ask about it. Or take any answer and
   **Publish to GitHub** as a gist, a commit or an issue. See
   [GitHub (repo context & publishing)](#github-repo-context--publishing).
8. Flip the **Agent** chip in the composer and describe a whole *task* — the orchestrator
   model plans it, delegates the steps to your other models, and assembles the answer.
   See [The orchestrator (agent mode)](#the-orchestrator-agent-mode). Put a `ROADMAP.md`
   in Local Files first and the finished run ends with a
   [roadmap timeline](#completion-report--roadmap-tracking).
9. Still in agent mode, send *"ask me a multiple-choice question about the Q3 sales
   report"* — the run stops, hands you clickable options (plus a field to type your own
   answer), and continues by itself once you've answered.
   See [Clarification questions](#clarification-questions-the-agent-asks-you-choose).

## The orchestrator (agent mode)

Flip the **Agent** chip next to the model picker (or type `/agent`) and the conversation
changes shape: you stop picking models entirely. Every message goes to an
**orchestrator model** — by default the top of your chain, configurable in
**Settings → Agent** — and *it* does the rest:

1. **Plans** — the orchestrator decides whether your message even needs delegation.
   Greetings and quick questions get a direct answer. Real tasks become a short plan of
   self-contained subtasks.
2. **Delegates** — each subtask is dispatched straight to a worker model from your
   roster (the orchestrator picks them by label; unresolvable hints fall back down the
   chain). Subtasks run in parallel (configurable) and **each carries its own failover
   walk** — a worker that rate-limits is silently replaced mid-step, and the step
   records who it fell back from and why.
3. **Synthesizes** — the orchestrator receives every worker's output, reconciles
   conflicts, and streams one final answer. Files workers produced (CSV, code…) land as
   artifact cards inside their step, and again in the final answer.

You watch all of it live on a **plan card** in the thread. It carries the actual
plan, not just the outcome: the **task** the run is working on, the orchestrator's
one-line strategy, and each step with its **brief** — the self-contained
instruction the worker was given, verbatim — alongside which model ran it, a
spinner/check/cross, elapsed time, and its output. If a run touched GitHub, its
[calls are listed right there](#every-github-call-as-a-card) too. Stop works
mid-run (partial plans are kept), retry re-runs the whole orchestration, and
everything is persisted with the message.

- You only ever talk to the orchestrator; it talks to the models.
- Workers are real chain members: cooldowns, health tracking and usage counters apply.
- A step that fails on every candidate doesn't sink the run — the orchestrator is told
  and works around it (if *every* step dies, the run fails loudly, with reasons).
- If the orchestrator's plan comes back malformed, it gets one repair pass; failing
  that, Slade falls back to a single execution step and says so on the card. Replies that
  are only *nearly* JSON — a worker prompt typed as a real multi-line string, a trailing
  comma, a regex or path that lost its backslash — are repaired in place instead, so the
  reformat pass is reserved for a reply that genuinely isn't a usable plan.
- Simulators play along: with no API keys, agent mode is fully demoable — the
  built-in models produce plans, worker deliverables, and synthesis.

For software-repository tasks, the orchestrator and worker models can use conversation
history, files attached from GitHub, and the current conversation's isolated **Local File System**
workspace (`slade.fs.v2`) as context, and any path-tagged file blocks they emit are
automatically stored in that conversation's Local Files. New conversations start with an empty workspace; branching a chat copies
its current workspace into a separate, independently editable one. The runtime does not execute OS shell
commands, Git checkouts, or test runners, so it cannot independently execute tests or builds against a
local checkout.

### Clarification questions (the agent asks, you choose)

Sometimes the right plan depends on a decision only you can make — *prototype or
production?*, *which period do the numbers cover?*, *is a breaking change allowed?* The
orchestrator can stop **before it delegates** and ask, and Slade renders the ask as
choices rather than as prose you have to parse and type back:

1. **The run parks.** Its plan card reads **Waiting for you**; nothing is in flight, so
   Stop, reloads and closing the tab are all safe. The questions are persisted with the
   message, exactly like the plan and the steps.
2. **One question at a time.** The first question renders as a block of clickable
   options, each with an optional one-line hint, plus an **Or type your own answer**
   option that opens a text field (Enter submits, Shift + Enter adds a line). Arrow keys
   move through the options; **Skip** declines a question and tells the orchestrator to
   use the safest interpretation and record the assumption.
3. **Submit collapses it.** The options you didn't choose are gone for good and the
   selected answer stays behind as an **artifact card** — the question, the answer, and
   a *typed by you* marker when you wrote it yourself — with **Copy answer** in its
   footer.
4. **The next question renders underneath.** Answering reveals the following question
   block below the card you just closed, so a multi-question ask reads top to bottom as
   a list of settled answers.
5. **The run resumes in place.** The last answer re-issues planning on the *same*
   message with your choices appended as explicit requirements (and marked so the
   orchestrator knows not to ask again). The plan card picks up where it left off —
   Planning → steps → the final answer, with your decisions still visible above it and
   restated in the report.

Details worth knowing:

- **Questions are bounded.** At most 4 per round with 2–6 options each, and at most 3
  ask-rounds per run; past that Slade tells the orchestrator to proceed with the safest
  interpretation and says so on the card. A "question" with one option, or none, is
  dropped rather than rendered as a dead end.
- **Multi-select is supported** (`"multiple": true`) — the marks turn square, every
  option that applies can be ticked, and a typed answer can be added alongside them.
- **Your answers outrank the model's preference.** They are handed to planning as
  explicit user requirements and repeated to the synthesis pass, so the final report
  reflects what you chose rather than what the orchestrator guessed.
- **Replying in the composer instead supersedes the questions.** They close as skipped
  with a note, so no card is left offering a choice that would resurrect an old run —
  and the answers you *had* given still travel with the conversation as context.
- **Simulators play along**: with no API keys, ask for *"a multiple-choice question"* and
  the built-in orchestrator asks, waits, plans around your answers and quotes them back.

### Completion report & roadmap tracking

When the orchestrator finishes a software task it reports back in a fixed shape:

| Section | What it is |
| --- | --- |
| **SUMMARY** | Two to four plain sentences: what was done and the outcome. Always first. |
| **ISSUES** | Everything you should be made aware of — failed, skipped or unrunnable tests and builds, criteria it could not verify, worker steps that failed or were cut off, assumptions it made, risky changes, manual actions needed, problems it noticed but did not fix. **Only present when there is something real to report**; never padding. |
| IMPLEMENTED · FILES CHANGED · TESTING · ARCHITECTURE · DOCUMENTATION | The detail. |
| **ROADMAP** | Only when a roadmap was used: which steps changed status and why. |
| REMAINING · STATUS | Limits and follow-ups, then an honest `VERIFIED / COMPLETE`-style status. |

If the workspace holds a roadmap or milestone file, that is the source of truth for
planned work and the run also ends with a **timeline card** under the report:

- **Previous → current → next step**, plus **overall completion** (a progress bar,
  `done / total`, and how far this run moved it — e.g. `+1 step this run · was 43%`).
  Steps the run changed are flagged, and the card lists what changed.
- **The numbers come from the file, not from a model.** Slade snapshots the roadmap
  after preparing the workspace and before anything is written, then diffs it against the
  file after the run. The card therefore can't claim more than the roadmap says.
- **Current** is the step the run just completed (else the one it started, else the one
  it otherwise touched). If the run didn't change the roadmap it is simply where the
  roadmap stands — the step in progress, else the first not started — and the card says
  *"No step changed status in this run"*, which is your cue if a task should have
  ticked something off. **Next** skips steps that are already done.
- **The orchestrator owns the roadmap.** Its instructions say to update the file as part
  of finishing the task; to mark a step done only when its acceptance criteria are
  verified (partly finished work is marked in progress); to keep the file's structure,
  wording and order; to add newly discovered work as new steps; and not to invent a
  roadmap you didn't ask for. Workers are told not to touch it. The update is a normal
  path-tagged file block, so it appears as an artifact and, if the file came from GitHub,
  as a pending change you can commit from the plan card.
- **No card when it isn't relevant:** a greeting or quick answer that leaves the roadmap
  alone produces none, and neither does a workspace without a roadmap.

**Which files count.** `ROADMAP.md`, `MILESTONES.md`, `docs/roadmap.md`,
`product-roadmap.txt`… — any `.md` / `.markdown` / `.mdx` / `.txt` (or extensionless)
file whose name contains *roadmap* or *milestone* as a word. If several exist, the one
the run changed wins, then the shallowest, then `ROADMAP` before `MILESTONES`. Roadmap
files go into the agent's workspace context first — ahead of recently touched files, and
with a larger per-file allowance (30,000 characters instead of 12,000), because the
orchestrator updates a roadmap by rewriting the whole file. If one is bigger than that it
is flagged as truncated and the orchestrator is told never to rewrite it (it lists the
steps that need updating instead), so a partial view can't delete the tail. When a GitHub
repository is open, Slade pulls its roadmap in automatically — you don't have to name it
in the prompt.

**Formats Slade reads** (`src/lib/roadmap.ts`; a step is one leaf line with a status):

```md
## Milestone 2 — Providers          <- headings become each step's milestone
- [x] Supported-providers dialog    <- done
- [~] Delete-provider flow          <- in progress
- [ ] Per-provider key testing      <- not started
```

Also understood: status markers on bullets, headings and table rows (`✅ 🚧 ⏳`,
`(done)`, `— in progress`, `**Status:** Done`, a *Status* column), and status-named
sections whose plain bullets inherit the status (`## Done` / `## In progress` /
`## Planned`, or `## Now` / `## Next` / `## Later`). Fenced code, ~~struck-through~~
items and prose are ignored; a file with no status markers yields no steps, so no card.
When the orchestrator creates a roadmap it uses the checkbox notation above.

**Try it with no keys:** open Local Files (`Ctrl/Cmd + E`), create `ROADMAP.md` with a
few `- [ ]` lines, turn on **Agent** and give it a task. The built-in simulators tick the
first open step and emit the updated file, exactly as a real orchestrator is instructed
to, and the card appears under the answer.

### Configuring it (Settings → Agent)

- **Orchestrator model** — chain top by default, or pin any enabled model.
- **Max subtasks per run** (1–8) and **parallel workers** (1–4, 1 = sequential).
- **Max tokens per step** (default 16 384) — the output ceiling for the plan call, every
  worker step and the synthesis. It sits well above the chat **Max output tokens** default
  on purpose: a step is a whole deliverable ("build the app"), and reasoning models bill
  their thinking against the same cap. A ceiling costs nothing unless the tokens are used.
- **Expand worker output** — completed steps show their full result by default.
- **Store and read files in the local file system** — enabled by default; gives the
  orchestrator and every worker model a persistent, conversation-isolated local file system
  (`slade.fs.v2`) where they can create, update, append, move, and delete files across steps and turns.

## Memory (`/memory`)

Slade keeps user-curated notes in persistent **Memory** (`slade.memory.v1`) and adds them to
relevant model context across conversations, even when Local Files is turned off. Open the
Memory dialog from the header or `/memory`; add a note directly, or use **Remember** on a chat
message to prefill it. Entries can be edited or deleted, and the Data backup includes them.
Every new note also creates a **Memory Added** card in the active conversation: one line, no
subtitle and no actions, with the exact text that was saved behind its expand toggle.

## Local file system (`Ctrl/Cmd + E` or `/files`)

Slade includes a persistent **Local File System** (`src/lib/fs.ts`, `src/store/fs.ts`,
`src/components/fs/FilesPanel.tsx`) stored in `localStorage` under `slade.fs.v2` and
included in JSON backups (**Settings → Data**). Each conversation has its own workspace;
files with the same path in different conversations do not overwrite or appear in each
other's agent context. Existing `slade.fs.v1` files are migrated once: files with conversation
metadata stay associated with that chat, while older unscoped files go to the chat that is
open during migration (or to the first chat created if none is open):

- **Automatic agent workspace** — when **Store and read files in the local file system**
  is enabled in **Settings → Agent**, the planner, every delegated worker step, the
  synthesizer, and direct chat models receive a manifest and contents of stored files in
  their workspace context.
- **Structured file emission** — models and agents write to the local file system by
  emitting fenced blocks tagged with a relative path:
  - ```` ```ts:src/app.ts ```` or ```` ```fs:write:src/app.ts ```` — create or overwrite a file (incrementing its version)
  - ```` ```fs:append:notes/changelog.md ```` — append to an existing file
  - ```` ```fs:move:src/old.ts -> src/new.ts ```` — move or rename a file
  - ```` ```fs:delete:tmp/scratch.txt ```` — delete a file
  - ```` ```fs:pull:src/lib/util.ts ```` or `[FS:PULL src/lib/util.ts]` — pull a file from the connected GitHub repository into the local file system
- **Two-way GitHub ↔ Local FS sync** — when a GitHub repository is open (`Ctrl/Cmd + G`),
  agents see the repository tree alongside the local file system, automatically pull
  mentioned repo files into `useFs` before planning/execution, track local modifications
  and deletions (`dirty` / `synced` badges), and let you commit & push single or multiple
  files (additions, modifications, and deletions) back to a GitHub branch in one atomic
  Git Data API commit (`commitTree`). Commits carry each path's existing **file mode**
  over from the branch, so editing a script never clears its executable bit.
- **Cross-step visibility** — files written by earlier worker steps are immediately stored
  and exposed to subsequent worker steps and the final synthesizer, and each step's file
  operations (`create`, `update`, `append`, `move`, `delete`) appear as interactive chips
  on the orchestrator plan card.
- **Local Files drawer** — click the folder icon in the header (`Ctrl/Cmd + E` or `/files`)
  to browse the directory tree, search paths and file contents with line numbers, create
  or upload files, edit or rename files inline, attach files to the next prompt, download
  them, or publish them to GitHub. These actions, including ZIP archive import/export and
  GitHub pulls, apply to the open conversation only; **Clear chat files** clears only that
  conversation's workspace.
- **Intentional cross-chat actions** — **Settings → Data → Export everything** includes every
  conversation's files and their ownership metadata. Import preserves those owners; unscoped
  files go into the currently open chat (or the first chat created if none is open).
  **Settings → Data → Clear all chat workspaces**
  is the explicit action that clears files across every conversation.


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
- **Reasoning-aware** — thinking tokens (`delta.reasoning`, Gemini `thought` parts, Anthropic
  `thinking_delta`) are read as liveness, never rendered as the answer, and a model that spends
  its whole `max_tokens` budget reasoning is retried **once at a larger cap** before the chain
  walks on. Walking on would be pointless: the next model gets the same too-small budget.
- **Truncation is visible** — an answer cut off by the token cap completes (the partial text is
  kept) and says so, instead of looking like the model chose to stop mid-file.
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

Cards arrive **collapsed** — the name and an expand toggle, nothing else — so a
transcript full of them stays scannable; **Settings → Artifacts → Collapse
artifact cards by default** opens them on arrival instead.

## GitHub (repo context & publishing)

Open the workspace with the GitHub button in the header or `Ctrl/Cmd + G`. Two
halves, both wired into the thread:

- **Repo context** — browse your repositories (or open any public one by URL),
  read files, search code with GitHub's own index, and attach whatever you find
  straight into the composer. Attached repo files become artifact cards and fold
  into the prompt exactly like an upload, with the source recorded.
- **Publishing** — every artifact card (bar the one-line Memory Added card) and
  every message has *Publish to GitHub*: create a **gist** (secret by default),
  **commit a file** into a repo
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

### Every GitHub call, as a card

Every request Slade sends to `api.github.com` — plus the GitHub actions that go
somewhere else (the OAuth device flow, signing out, cloning a repo's files into
Local Files) — shows up as a **GitHub Action card**, built like the Memory Added
card: the GitHub mark, the action ("`GitHub Action: Get File Contents`"), and
the thing it touched (`/src/lib/util.ts`) underneath.

- **A call is inserted like a saved memory.** Each card becomes an entry of its
  own in the conversation and takes the same slot in it a Memory Added card
  does, so the two line up exactly; it scrolls with the chat and is saved with
  it: reload the page and the log is still there, in the order the calls
  happened.
- **A run's calls go inline with the run.** When the orchestrator makes GitHub
  calls — pulling mentioned files into Local Files, reading a repo's tree — its
  cards render in that run's activity timeline, in the order things happened,
  between the thoughts that led to them, and are saved with the run's answer.
- **A card carries its result, and only its result.** The REST client captures a
  compact, redacted extract of every successful response — the file a read
  returned, a listing, the sha and URL a write produced — and the card grows an
  expand toggle only when there is output to read. No output, no toggle: routine
  calls stay one line. A failed call gets the same toggle for its error, and the
  repo, branch, timing and call count stay in the card's tooltip.
- **A call that needs an answer asks on its card.** A GitHub action can carry a
  question and up to a handful of choices; the card renders them as buttons at
  the bottom, records the chosen answer on the card (so it survives a reload)
  and fires `slade:github-response` for whatever asked. Cards that finish on
  their own never grow a button they do not need.
- The vocabulary lives in `src/lib/github-actions.ts`, one entry per call shape —
  reading/creating/updating/deleting files, branches and refs, commits and trees,
  pull requests (create, merge, fetch), code search, repository and branch lists,
  gists, issues, token checks, rate-limit checks, sign-in, sign-out, cloning.
  Anything unmapped still gets a card with its path, so no call can slip past
  unlogged.
- A repeat of the newest identical call (the same file pulled twice in a few
  seconds) folds into that card rather than adding a second one; the count and
  everything else about it sit in the tooltip. A call cancelled mid-flight keeps
  its card, cancelled, instead of vanishing.

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
- **Thoughts** — a model's internal reasoning arrives in an expandable *Thoughts* card
  (brain icon, word count, `thinking…` while it streams), inline in the reply and inside every
  agent step. It is labelled as reasoning, never blended into the answer, and can be turned off
  globally (Settings → Defaults) or per model (Settings → Models)
- Message actions: copy, regenerate, **edit-and-resend**, delete, **branch-from-here**
- **Answerable questions** — an agent run can park and ask you to choose between options
  (or type your own); each submitted answer collapses into an artifact card and the next
  question appears underneath it. See
  [Clarification questions](#clarification-questions-the-agent-asks-you-choose)
- Composer: auto-grow input, Enter/Shift-Enter (configurable), char/token counter,
  drag-and-drop & paste-to-attach, slash shortcuts (`/system`, `/model`, `/agent`,
  `/sample`, `/new`)
- Stop generation at any time — partial answers are kept
- **Rename or archive a conversation**: click its name in the header (or hover a sidebar
  row and press **⋯**, or right-click the row) for a menu with *Rename* and *Archive*.
  Archived chats collapse into an **Archived** group at the bottom of the sidebar — search
  still finds them — and come back with *Unarchive*, the **Undo** on the "archived" toast,
  or simply by sending a message in them. Renaming and archiving don't count as activity,
  so they never change a chat's time or its place in the list. Double-click the header
  name to rename it directly.

## Resizing panels

The sidebar, model chain rail, and the GitHub/Files drawers each carry a small
grip in their bottom corner (bottom-right on the sidebar, bottom-left on the
right-docked panels). Drag it to resize; the chat keeps a usable column (grid
panels) or slides out of the way entirely (drawers). Bring a dragged edge close
to the far side of the viewport and hold — a ghost panel appears showing the
snap, and releasing there docks the panel flush to that edge. Drag away and the
ghost vanishes; an Esc mid-drag cancels without committing. Keyboard: focus the
grip and use ←/→ (Shift for bigger steps), `End` or `Enter` to snap, `Home` for
the minimum, `Backspace` to return to the default width. Widths persist with
your settings. On narrow layouts (≤900px) panels are overlay drawers and the
grips hide themselves.

## Settings (Ctrl/Cmd + ,)

- **Models** — enable/disable, drag-reorder priority, per-model temperature / max-tokens /
  system-prompt overrides, usage counters, failure simulation for demo models
- **Defaults** — temperature, top-p, max tokens, system prompt, streaming, typing
  indicator, auto-scroll, failover strategy, first-token timeout, stream timeout,
  artifact preferences
- **Agent** — orchestrator model, max subtasks per run, parallel workers, plan-card
  expansion (see [The orchestrator (agent mode)](#the-orchestrator-agent-mode))
- **GitHub** — device-flow sign-in, OAuth app client ID, sign-in relay URL, requested
  scopes, and publishing defaults (target, repository, branch, path prefix, secret
  gists, new-branch commits)
- **Providers** — user-managed like models: **Add a provider** opens a modal with every
  supported kind (OpenAI, Anthropic, Google Gemini, OpenRouter, OpenAI-compatible, the
  built-in simulator), each connection carries its own masked key, optional base URL and
  display name, and deleting one removes the models attached to it (with a confirm).
  Multiple connections to the same kind are welcome — a personal and a work OpenAI
  account, or Groq *and* DeepSeek *and* Ollama as separate OpenAI-compatible endpoints.
  Connection tests use real generation, and first-class OpenRouter support ships in the
  box (`openrouter/auto` in the default registry; any `vendor/model` id works, with
  Slade's attribution headers and streamed token usage). Settings saved by older builds
  upgrade in place: the old key record becomes one provider instance per kind.
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
| `The model spent its whole N-token output budget thinking and never reached an answer` | A reasoning model (routers like `openrouter/auto` pick them often) billed its thinking against `max_tokens` and hit the cap before writing any answer text. Slade retries once at 4× the cap; if that still fails, raise **Max output tokens** (chat) or **Max tokens per step** (agent). Retrying unchanged cannot help — the tokens are already billed. |
| `Cut off at the output token cap` | The answer arrived but stopped at the cap. Raise **Max output tokens** and retry for the rest. |
| `The provider accepted the request but returned no text at all` | A 200 with nothing in it and no stop reason to explain it — cold start, or an upstream that returned an empty choice. Retry; if it persists, pin a concrete model instead of a router. |

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
its contents appear in the next prompt*. It also drives the orchestrator
headlessly, including the clarification-question loop: *ask → park → answer one
question → the card collapses and the next renders → answer the last → the same
message resumes and finishes*, plus skipping, superseding by a composer reply,
and the persistence round trip.

## Layout

```
src/
  engine/       failover chain walk, routing strategies, turn builder
  providers/    openai · anthropic · google · openrouter · openai-compatible · built-in mock
  store/        zustand stores + persistence + cooldown policy
  components/   chat (incl. the orchestrator plan card, its clarification questions,
                and the roadmap timeline), artifacts, settings, layout, github, common
  lib/          mime classification, csv, clipboard, schemas, storage,
                roadmap (parse · diff · timeline), questions (normalize · answer · prompt),
                popup-menu placement,
                local file system, github (REST client, device flow, publish payloads)
scripts/
  smoke.ts                  headless test suite
  github-oauth-relay.ts     the two OAuth calls, proxied for dev/preview
workers/
  github-oauth-relay/       the same relay as a deployable Cloudflare Worker
```
