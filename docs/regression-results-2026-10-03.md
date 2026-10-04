# Regression run — 2026-10-03 (against `main` @ 848cb46, "Improve UI navigation and failover feedback (#29)")

Checklist: [`docs/ui-regression-checklist.md`](./ui-regression-checklist.md).

Verification legend:
- **AUTO** — enforced by `typecheck` / `build` / `test:smoke` (headless, deterministic).
- **CODE** — behavior verified by auditing the implementing source; no browser available in the run environment.
- **EYES** — inherently visual; verify in the live preview at the three widths (1440×900, 900×700, 390×844) and both themes.

Four real failures were found and **fixed in this run** (details below); new smoke assertions pin all failover-render fixes so they cannot regress silently.

## 1. Before testing

| Item | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` and `npm run build` pass | ✅ AUTO | clean before and after fixes; build emits only pre-existing chunking advisories |
| `npm run test:smoke` passes (incl. failover rendering) | ✅ AUTO | all green; 5 new render assertions added (see fixes) |
| Fresh profile vs profile with saved data; console errors | ⚠️ one issue fixed | Lightbox logged "Unable to preventDefault inside passive event listener" on wheel-over-image (React attaches `onWheel` passively at the root). Fixed with a non-passive native listener. Load-time console stays clean (no SSR, no eager fetches; GitHub verify runs only with a stored token). Fresh-vs-saved: `storage.ts` + zod schema round-trip is smoke-covered; **EYES** for the live look. |
| No horizontal overflow / clipping / overlap; light, dark, reduced-motion | ✅ CODE, **EYES** | `.app { overflow:hidden }` + `grid auto minmax(0,1fr) auto`; popovers are fixed-position portals clamped to the viewport; global `:focus-visible`; `@media (prefers-reduced-motion)` + app-level toggle in `useAppearanceEffects`; mobile drawers are full-screen at ≤640px. Spot-check visually. |

## 2. Workspace and navigation

| Item | Result | Evidence |
| --- | --- | --- |
| Sidebar: create/select/rename/archive; menu in scrolled list; Tab skips closed sidebar/rail; drawer focus return | ✅ CODE | `inert` toggled on both `<aside>`s (closed → skipped by Tab, unclickable); rows are sibling buttons (a11y note in `Sidebar.tsx`); `ConversationMenu` returns focus to the opener with a list fallback; backdrop + close button → `[data-panel-toggle="sidebar"]`/`"rail"` focus. Menu is a portal → never clipped by the scrolled list. |
| Header: tooltips/accessible names; panels open/close; Files & GitHub via button, backdrop, Escape; focus returns to toggle | ✅ CODE | every header button has `aria-label` + `title` + `aria-pressed`; `GitHubPanel`/`FilesPanel` each have `closeAndFocus` (button + mobile backdrop) and the global Escape path closes and refocuses the matching toggle. Note (by design, not a defect): on desktop the drawer is an overlay (`position:fixed`, z-70) and covers the right side of the chat/composer below ~1550px. |
| Ctrl/Cmd + `, J, G, E; J/G/E blocked behind Settings; `, blocked behind nested picker; Esc topmost-only; modal focus trap & return | ✅ CODE | `App.useHotkeys` counts `[role="dialog"][aria-modal="true"]`: any dialog ⇒ J/G/E swallowed; `dialogs.length > 1` ⇒ `, swallowed; Escape delegated to the dialog. `Modal.tsx` keeps a `modalStack`, traps Tab, and restores focus to the opener; `Menu`/`FilterCombobox`/`RenameInput` stopPropagation on Escape so only the topmost popup closes. |
| Mobile: panel/dialog heading, close, body, primary action visible & scrollable | ✅ CODE, **EYES** | drawers: `width:min(470px,94vw)`, 100% at ≤640px, flex column with scrollable body; `Modal` becomes a full-screen sheet on small screens. Verify gestures in preview. |

## 3. Composer and conversation

| Item | Result | Evidence |
| --- | --- | --- |
| Enter sends / Shift+Enter newline; disabled send; stop halts stream | ⚠️ one issue fixed | Enter behavior honors the `enterToSend` setting… but with the setting **off**, the promised `Ctrl/⌘+Enter` send did not exist — keyboard sending was impossible. **Fixed**: the chord now sends when `enterToSend` is off, footer + Settings hint updated to match. `canSend` requires non-empty draft (button disabled + guard in `send()`); stop button calls `stopGeneration`. |
| Attach via picker / drop / paste; removable; present after send | ✅ CODE | hidden `<input multiple>`, window-level dragenter/over/drop with counter, `onPaste`; pending chips with remove; ids passed to `sendUserMessage` and rendered under the user bubble (`Attachments`). |
| Model picker: keyboard + pointer, popover stays on screen, shows selection | ⚠️ one issue fixed | The composer chip's popover had pointer support only: no arrows/Home/End/Enter, no Escape, no Tab handling, focus left behind. **Fixed**: focus moves to the `role=listbox` popover on open, `aria-activedescendant` navigation, Enter/Space pick, Esc/Tab close and restore focus to the chip, `max-width:min(420px, 100vw−24px)` clamp; selected row keeps `aria-selected` + ✓ mark. (Settings-side pickers already use `FilterCombobox`: type-to-filter + ↑↓/Enter/Esc + portal with viewport clamping — all ✅ CODE.) |
| Long prompt/answer: wrapping, markdown/code/table overflow, actions, timestamps, spacing, both themes | ✅ CODE | `overflow-wrap:anywhere` on bubbles/failover lists; `.md-table-wrap{overflow-x:auto}`; code `pre{overflow:auto}`; message actions (copy / edit+resend / regenerate / branch / publish / delete) all labelled; `msg-time` + edited marker. Density/font applied through dataset + CSS var — **EYES** per theme. |
| Artifact previews (sheet, code); close with Esc & button; focus returns | ⚠️ one issue fixed | Sheet/code preview in place with an `aria-expanded` toggle (focus stays on it — fine). Image zoom lightbox closed to Escape/backdrop/X but **dumped focus on `<body>`** — fixed with opener capture + restore. |

## 4. Failover feedback

| Item | Result | Evidence |
| --- | --- | --- |
| Completed reply names serving model; "Switched to …" beneath the header | ✅ AUTO | smoke renders `MessageBubble` and asserts both the header attribution and "Switched to Simulacron Lite". |
| "Why?" expands to model + recorded reason without hover; collapse; keyboard; mobile | ✅ AUTO/CODE | native `<details>`/`<summary>` (Enter/Space/keyboard for free), reason `<ul>` rendered from `attempts`, focus-visible ring + wrap-friendly flex CSS for narrow widths. |
| Mid-stream failure: partial preserved, divider at switch point, names destination + failure | ✅ AUTO | `handoffs[].atChar` drives segment splitting; new smoke assertions render the divider and check it names both sides. |
| No failure → no note; every model fails → error state shows attempts/reasons, **not** claiming an answer was served | ⚠️ one issue fixed | **Found failure** — see Fix #1. A fully-failed turn rendered "Switched to Simulacron Lite after Simulacron Pro, Simulacron Lite failed" — naming the model that *failed last* as if it had answered. Fixed + pinned by three new smoke assertions. |
| Survives refresh (attribution, reasons, divider positions) | ✅ AUTO | New end-to-end smoke test runs the real failover scenarios, drains the debounced persist, re-reads raw `localStorage`, validates against `conversationSchema`, re-hydrates through `hydrateConversations`, and re-renders — asserting the attribution, the per-model reasons, the handoff's exact `atChar` offset, and the still-visible "Switched to …" note. |

## 5. Settings, GitHub, and files

| Item | Result | Evidence |
| --- | --- | --- |
| Theme/density/font immediate + persist; switch toggles exactly once; disabled switch inert | ✅ CODE | one `onClick` on the row (switch click bubbles once; no label double-fire; no `htmlFor`), `disabled` short-circuits both; `setAppearance` → `persist()` → merged on load; `useAppearanceEffects` applies immediately. |
| Nested model/provider dialogs: focus trap, Esc closes only the upper, inputs reachable | ✅ CODE | `ModelPickerModal`/`AddProviderModal` are shared `Modal`s inside Settings with the `nested-modal` class → stack-aware Escape/trap/focus-return; App-level hotkey guard verified above. |
| Repo browse/search, open & close file preview, empty/loading/error offline | ✅ CODE | `RepoBrowser` spinner/empty/error branches (works anonymously, rate-limit aware); preview close returns focus to the header toggle; offline: `online/offline` listeners + `role=alert` chip; fetch failures surface as panel errors. Live-API leg: **EYES** (needs a GitHub session). |
| Files: navigate, preview/download, long names wrap/truncate without covering actions | ✅ CODE | rows/paths `min-width:0` + `text-overflow:ellipsis` with full value in `title`; toolbar actions in a fixed sibling segment. |

## Defects found & fixed in this run

### Fix 1 — Failed turns falsely claimed an answer was served (checklist §4)
- **Viewport/theme:** all (data-driven text).
- **Repro:** Settings → Models: Simulacron Pro `simulate: quota exhausted`, Lite `simulate: rate limit`; send any message.
- **Expected:** error state listing each model + its reason; no claim that anything was served.
- **Actual:** header attributed the turn to "Simulacron Lite" and the note read "Switched to Simulacron Lite after Simulacron Pro, Simulacron Lite failed · Why?".
- **Cause:** `MessageBubble` rendered `FailoverNote` whenever `failedChain` was non-empty; `finalize` on `ChainExhausted` sets `modelId = last attempted` even with zero content.
- **Fix:** attribution renders "No model responded" for `status==='error'` with no served text; failover note only when the turn actually served content. Mid-stream partial failures keep their divider + note (content *was* partially served — truthful).
- **Files:** `src/components/chat/MessageBubble.tsx`; pinned by `scripts/smoke.ts` (3 new assertions).

### Fix 2 — Keyboard send was impossible when "Enter sends" was off (checklist §3)
- **Repro:** Settings → Appearance: toggle "Enter sends message" off → focus the composer → Enter and Ctrl+Enter both only insert newlines; the send button needs the mouse.
- **Expected (own hint):** "Off: Enter makes a newline, Ctrl/⌘+Enter sends."
- **Fix:** `Ctrl/⌘+Enter` sends when the setting is off; composer footer and Settings hint wording made accurate ("Ctrl/⌘").
- **Files:** `src/components/chat/Composer.tsx`, `src/components/settings/SettingsModal.tsx`.

### Fix 3 — Composer model picker was mouse-only and Esc-ignoring (checklist §3, §2 topmost-Escape)
- **Repro:** Tab to the model chip → Enter/Arrows do nothing; with the popover open, Escape is ignored (or, with a drawer open, Esc closes the drawer instead of the popover); Tab escapes into the page leaving the popover open.
- **Expected:** open/filter/select with keyboard; Esc closes only the popover; selected model marked; popover clamped on screen.
- **Fix:** listbox pattern with focus management + `aria-activedescendant` (↑↓/Home/End/Enter/Space/Esc/Tab), hover-sync, viewport-clamped width.
- **Files:** `src/components/chat/Composer.tsx`, `src/styles/global.css`.

### Fix 4 — Lightbox focus loss + passive-wheel console error (checklist "Before testing", §3)
- **Repro:** click an image artifact → Esc or ✕ closes it, focus lands on `<body>` (Tab restarts from the top); scrolling over the image logs an "Unable to preventDefault inside passive event listener" console error.
- **Fix:** opener element captured on open and refocused on close; wheel zoom moved to a non-passive native listener.
- **Files:** `src/components/artifacts/Lightbox.tsx`.

## Left for human eyes (the preview is up at port 5173)

- §0/§2: overflow, clipping, popover edges, drawer overlap at 1440/900/390, both themes, reduced-motion, plus a clean console at first load.
- §5: live GitHub legs (device-flow sign-in, browse/attach/publish) — need a real session; the code paths and states were audited.
- Judgment call worth confirming: the desktop GitHub/Files drawer *overlays* (and on ≤1550px-wide screens partially covers) the composer. It's deliberate per `GitHubPanel`'s comment — but "close … without hiding the chat/composer unexpectedly" reads better with the composer reflowed; flag for design if the preview feels cramped.
