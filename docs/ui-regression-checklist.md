# UI regression checklist

Run this after changes to layout, controls, message rendering, or the model chain. Test at desktop (~1440×900), narrow desktop (~900×700), and mobile (~390×844). Repeat keyboard-only checks without a mouse. Use the mock models for failover; no paid provider key is required.

## Before testing
- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] `npm run test:smoke` passes (includes basic failover rendering assertions).
- [ ] Open the app in a fresh browser profile and in a profile with saved conversations/settings. Check browser console for errors.
- [ ] At each width, check for horizontal page overflow, clipped text or popovers, overlapping panels, missing icons, and controls smaller than their labels. Check light and dark themes and reduced-motion mode.

## Workspace and navigation
- [ ] Sidebar: open/close, create/select/rename/archive a conversation; active row and menu remain visible in a scrolled list. When the sidebar or model rail is closed, Tab must skip its off-screen controls; closing either mobile drawer with its close button or backdrop returns focus to its header toggle.
- [ ] Header: each icon has a readable tooltip/accessible name; Files, GitHub, model rail, and Settings open the intended panel and close without hiding the chat/composer unexpectedly. Close Files and GitHub via button, mobile backdrop, and Escape; keyboard focus should return to the matching header toggle.
- [ ] Keyboard: Ctrl/Cmd+, J, G, E trigger their labelled actions. With Settings open, J/G/E must not open drawers behind it; with a nested model/provider picker open, Ctrl/Cmd+, must not close the parent underneath it. Escape dismisses only the topmost popup/dialog. Tab and Shift+Tab keep focus in a modal and return focus to the opener on close.
- [ ] On mobile, open each panel and dialog; verify heading, close control, body, and primary action are visible and reachable by scrolling.

## Composer and conversation
- [ ] Enter sends and Shift+Enter adds a line break; disabled send button cannot submit an empty draft; stop button halts a streaming reply.
- [ ] Attach via file picker, drop, and paste. Each attachment appears, can be removed, and is present after sending.
- [ ] Open model picker and filter options with keyboard and pointer; its popover stays on screen near viewport edges and shows the selected model.
- [ ] Send a long prompt and a long answer. Check wrapping, markdown/code/table overflow, copy/edit/retry actions, timestamps, and readable spacing in both themes.
- [ ] Open artifact previews (including a sheet and code file); close with Escape and the close button, then verify focus returns.
- [ ] Artifact card footer: every action is an icon, each with a tooltip on hover/focus — *Copy reference*, *Revise*, *Push to GitHub*, *Save* (reads *Open in Files* once the file is in Local Files), *Open on GitHub* on a card that came from a repo, *Download* when there are bytes. No printed labels; nothing wraps or overflows at narrow width, in both themes.

## Failover feedback
- [ ] Configure a mock chain with a failing primary and working secondary. Send a prompt: the completed reply names the serving model and shows “Switched to …” beneath its header.
- [ ] Expand “Why?”: the failed model and its recorded reason are readable without hovering; collapse it again. Check at mobile width and with keyboard (Tab, Enter/Space).
- [ ] Trigger a mid-stream mock failure: partial answer is preserved, handoff divider appears at the switch, and the explanation names the destination and failure.
- [ ] With no failure, no failover note appears. With every model failing, the error state shows attempts/reasons rather than claiming an answer was served.
- [ ] Refresh the conversation and verify the same attribution, reasons, and handoff positions remain visible.

## Settings, GitHub, and files
- [ ] Change theme, density, and font size; controls update immediately and persist after reload. Clicking both switch and its label toggles exactly once; disabled switches do nothing.
- [ ] Open nested model/provider dialogs. Check focus trap and Escape closes only the upper dialog; inputs and save/cancel remain reachable.
- [ ] Browse/search a connected repository, open a file, and close the preview. Check empty/loading/error states when disconnected or offline.
- [ ] GitHub action cards: a call with a response (reading a tree, committing a file) shows an expand toggle that reveals the output; a routine call with nothing to show has no toggle at all; a failed call's toggle reveals the error. While signed out, run through one read and one write to check both.
- [ ] Reading files is one card: pull two or more files from a repo (Files tab → pull, or an agent run that pulls what a prompt mentioned). Exactly one “GitHub Action: Get File Contents” card appears, sub-titled with the file count (**2 Files**), whose block lists the repository and one path per line. A read that failed is a `— failed: …` line on that same card, not a card of its own.
- [ ] Housekeeping reads stay out of the chat: start a new conversation with a repo already selected and check that no repository-list, branch-list or tree card is inserted; open a repo, switch branch and hit Reload yourself, and check those calls *are* logged.
- [ ] A file pulled from GitHub adds no artifact card to the message: an agent (or worker) that emits a ` ```fs:pull:path ` directive leaves the transcript with the read card and the file in Local Files — no artifact card, and no empty code block where the directive was.
- [ ] Open pull request (Files tab, by the branch picker): on the default branch the form says to switch branches first; on another branch it picks the default as the base, and submitting opens a PR whose card appears in the chat. With a token that cannot push, the button is disabled and says why; signed out, it is not there at all.
- [ ] Pull request card: opening a PR renders the card open — number, title, state, `head → base`, author, commits, files, `+/−` lines, whether it can be merged, and the description — with no expand toggle. *Open on GitHub* opens the PR in a new tab; *Merge pull request* merges it, the card then reads **Merged** (and keeps that after a reload); a PR that is already closed offers no merge button.
- [ ] Open Files panel; navigate folders and preview/download a file. Check long filenames wrap or truncate without covering actions.

Record any failure with viewport size, theme, steps to reproduce, expected/actual result, and a screenshot. Do not mark a flow passed solely because a button is visible—exercise its action and verify the resulting state.
