---
created: 2026-05-08
updated: 2026-05-08
---

# PRD: Electron desktop layout adaptation

## Status: Draft

## 1. Summary

Layout-only adaptation of the VS Code extension's UX into the Electron window, plus a small refactor to enable component sharing.

Replace the Electron app's tab routing and workspace-explorer sidebar with a three-pane window layout that mounts the existing extension components (`<main-app>`, `<stream-tabs>`, a new `<stream-conversation>`, `<settings-app>`) without changing their content or behavior. Refactor the Progress view's state to a module-level singleton so the rail and the conversation can be mounted independently and stay in sync.

## 2. Problem

The Electron app today:

1. Routes between four full-window views (`Main | Progress | Settings | Logs`), forcing context switches even when the user wants the launcher and the active run visible together.
2. Renders a workspace file-tree sidebar that duplicates `<main-app>`'s built-in file panel and requires re-tagging files every session.
3. Cannot mount the Progress view's session rail independently — its state lives as private fields on the `ProgressApp` class instance, so the rail and conversation must always render inside the same parent.

Result: the desktop feels like four small VS Code webviews stuffed into one window rather than an app native to the window it owns.

## 3. Goals

- G1. Single window: sessions on the left, current session/launcher in the center, settings as overlay.
- G2. Content and behavior identical to the VS Code extension's Launcher, Progress, and Dashboard.
- G3. Both hosts mount the **same** Lit components from `@progressView/frontend`, `@webview/frontend`, `@settingsView/frontend`. No per-host copies.
- G4. Workspace-explorer sidebar removed.

## 4. Non-goals (explicitly excluded)

These were discussed and ruled out for this work. Tracked separately if pursued later.

- New agent types, pre-rejection reviewers, arXiv scouts, "since-you-left" / morning rituals, daily summaries.
- New approval surfaces (single-annotation triage, fork-from-child, edit-then-replay, side-by-side N-take).
- New entry modes (slash dispatch, team panel, per-agent stats aggregations).
- Multi-workspace support — deferred; the rail's structure is forward-compatible (see §12).
- Memory auto-injection at agent session start (runtime change, not UI).
- Math / citations / figures / numerics-table / notation-glossary rendered as native objects.
- The right pane's diff-and-approve experience (slot reserved; built later as its own deliverable).
- The five currently-unavailable commands (`runSetupAssistant`, `showImportOptions`, `openGettingStarted`, `cleanOutput`, `cleanBuild`).

## 5. User stories

- As a researcher I open the desktop app and see my recent sessions on the left and a launcher in the center, so I can pick up where I left off or start something new without switching tabs.
- As a researcher with a running orchestrator I can see the subagent tree (parent-child lineage) in the rail while the current session's conversation, todos, background tasks, and approval gates remain in the center pane.
- As a researcher I open Settings via the gear, the existing Dashboard appears as a window overlay, and Esc returns me to the prior view.
- As a researcher I am no longer asked to interact with a file-tree sidebar; file staging happens inside the Launcher's existing panel.

## 6. UX

```
┌──────────────────────────────────────────────────────────────────────┐
│ TeXRA · workspace-name                       ⌘K   ⚙   ⊟  ⊞         │
├──────────────┬─────────────────────────────────┬───────────────────┤
│ ＋ New run   │                                 │                   │
│ ⌕ Search     │                                 │                   │
│              │                                 │                   │
│ ● leanOrch   │                                 │                   │
│   L lean     │   <main-app>     OR             │  (right pane —    │
│   L leanSimp │   <stream-conversation>         │   reserved for    │
│              │                                 │   future diff/    │
│ ◐ crit       │   Composer pinned at the        │   approve UX,     │
│ ✓ polish     │   bottom of <main-app>;         │   collapsed today)│
│ ✓ enhance    │   follow-up at the bottom       │                   │
│ … older      │   of <stream-conversation>.     │                   │
│              │                                 │                   │
│ Filter:      │                                 │                   │
│  ● All       │                                 │                   │
│  ○ Workflow  │                                 │                   │
│  ○ Inter…    │                                 │                   │
│              │                                 │                   │
│ ⚙ Settings   │                                 │                   │
└──────────────┴─────────────────────────────────┴───────────────────┘
```

**Sessions rail (left).** Chronological list of recent and active sessions, newest first. Lineage rendered with `L` indents (preserved verbatim from the extension's right rail). Status glyphs: `●` running, `◐` waiting on user, `✓` complete, `✕` failed, `◯` queued. Filter at the bottom: All / Workflow / Interactive (existing). No day-grouping headers. Settings entry at the bottom.

**Center pane.** Swaps between two children based on `activeStreamId$`:

- No active stream → `<main-app>` (Launcher unchanged: Interactive/Workflow toggle, instruction textarea, file panel, agent picker, model picker, voice mic, ▶).
- Active stream → `<stream-conversation>` (todos, background tasks, conversation turns, approvals inline, usage panel, follow-up input — all unchanged from the extension's Progress view body).

**Settings overlay.** `<settings-app>` mounts as a full-window overlay over the three-pane layout when the gear is clicked. Esc and the overlay's close button dismiss. Existing 8 tabs (Memory, History, Models, Agents, Multi-Agent, Tools, Git, LaTeX) unchanged.

**Logs.** Reached from the menu; opens as a small drawer (matches today's separate Logs route).

**Workspace name** in the title bar is a static label today. When multi-workspace lands, it becomes the trigger for collapsible workspace groups inside the same rail (no additional column).

## 7. Technical architecture

The Progress view's state currently lives as private signals on the `ProgressApp` class instance. To mount the rail and the conversation independently in different DOM trees while keeping them in sync, state moves to module scope. One architectural change plus mechanical extractions; no algorithmic changes.

**A. Module-level reactive state.**
New `packages/extension/src/progressView/frontend/progressState.ts` exports today's signals at module scope (`streamStates$`, `streamFilter$`, `activeStreamId$`, `childStreamsByParent$`, `tabStreams$`, `pendingApprovalIds$`, `hasAnyStreams$`, …). `messageDispatcher.ts` (already module-level) writes into it. `ProgressApp` reads from it.

**B. `<stream-conversation>` element.**
The body currently rendered by `ProgressApp.renderStreamContent()` (plus the empty-state) moves into a new Lit element that subscribes to `progressState`. Internal children unchanged: `<stream-header>`, `<context-management>`, `<todo-list>`, `<background-tasks-panel>`, `<log-list>` / `<task-group-list>`, request panels, `<usage-panel>`, `<follow-up-input>`.

**C. `<progress-app>` becomes a thin shell.**
For VS Code: renders `view-header` plus `<wa-split-panel>` containing `<stream-conversation>` and `<stream-tabs>` — identical UX to today. For Electron: not mounted at all; the children mount directly in window panes. (The PRD originally referenced `<vscode-split-layout>`; that component was retired during the Web Awesome migration session, so `wa-split-panel` is now the project's canonical split control.)

**D. Electron renderer shell.**
Replaces the four-route tab router. Three panes. Center swaps between `<main-app>` and `<stream-conversation>` driven by `activeStreamId$`. Settings overlay on gear. Workspace explorer deleted.

Both hosts continue importing from the same packages. No component lives in `packages/desktop/`.

## 8. Phasing & PRs

| PR  | Phase                                                   | Touches                                                                                                                                                                                                                              | Visible change                                  |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 1   | State hoist                                             | `progressState.ts` (new), `ProgressApp.ts`, `messageDispatcher.ts`, possibly `slices/*`                                                                                                                                              | None — extension and desktop render identically |
| 2   | Extract `<stream-conversation>` + slim `<progress-app>` | `components/StreamConversation.ts` (new), `ProgressApp.ts`                                                                                                                                                                           | None                                            |
| 3   | Electron shell + workspace-explorer removal             | `packages/desktop/src/renderer/{main.ts,index.html,styles.css}`, `packages/desktop/src/main/desktopWorkspaceExplorer.ts` (deleted) and IPC unwired, `packages/desktop/src/main/desktopMenu.ts`, `packages/desktop/src/main/index.ts` | Desktop layout flips; extension unchanged       |

Each PR independently shippable and revertible. Extension users see no diff until or after all three.

## 9. Success criteria

- VS Code extension: zero visual or behavioral diff after PRs 1 and 2. Verified via existing tests + manual smoke (start an agent, observe approvals, complete a run).
- Electron app: opens to one window with rail + launcher visible. New run kicks off, the rail shows the session and its lineage live, the conversation appears in the center, approval gates render and resolve, follow-up input works. Settings opens via gear. No workspace-explorer sidebar exists.
- Both hosts import `<stream-tabs>` and `<stream-conversation>` from the same source. No copy of either component in `packages/desktop/`.
- The five currently-unavailable commands remain unavailable (separately tracked).

## 10. Risks & mitigations

- **PR 1 is the load-bearing refactor.** `ProgressApp.ts` is hot. Mitigation: keep the diff strictly mechanical (signal moves only, no rendering changes); merge during a quiet window; manual smoke test with a live orchestrator run including approvals; revert as a single commit if issues surface.
- **Singleton scope** precludes mounting two independent progress views in the same page. Acceptable today; flagged here so future "compare two runs side-by-side" features know to revisit it.
- **Settings dismissal pattern** (overlay + Esc + close button) is opinionated. Drawer or modal-card variants are reasonable alternatives if user testing prefers them; the swap is small and architecturally neutral.
- **Workspace-explorer IPC removal** must be cleanly unwired. Mitigation: delete the IPC handlers in the same PR as the renderer change; ensure no remaining consumers in `desktopMenu.ts` or elsewhere.

## 11. Open questions

1. Component naming: `<stream-conversation>` vs `<active-stream-view>` vs `<progress-content>`. PRD assumes `<stream-conversation>` to match the existing `stream-` prefix family.
2. Settings overlay dismissal: Esc + close button only, or also click-outside-to-close? PRD assumes Esc + close button.
3. Logs: menu drawer (proposed) or fold into a Settings tab?
4. Right pane visual treatment today: hidden completely, or visible as a thin collapsed strip with a "future" placeholder? PRD assumes hidden until a deliverable lands.

## 12. Future (not in this PRD)

- Multi-workspace: collapsible group headers per workspace inside the existing rail. No extra column.
- Right pane: side-by-side diff/approve UX for tool edits and merge results.
- The five currently-unavailable commands ported to desktop.
- Memory auto-injection at agent session start.
- Science-native rendering of math, citations, figures, and structured agent outputs (`review`, `numerics`, `notation`).
