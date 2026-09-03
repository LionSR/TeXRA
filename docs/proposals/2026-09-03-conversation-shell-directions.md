# Conversation shell directions, grounded in the codebase

> **Consolidated into `docs/prds/2026-09-03-prd-one-fold-three-renderers.md` on 2026-09-03.** That PRD governs where the two differ; this proposal is kept for its evidence and history.

Status: proposal, 2026-09-03. Companion to the design canvas "TeXRA
Conversation Shell" (extension directions A to E, desktop directions 1 to 6,
the recommended path, and the multi-agent run boards W0 to W2).

## Who this is for

TeXRA's users are mathematicians, theoretical physicists, and computer
scientists working on papers. That sets the units the shell should expose:

- The unit of work is a **paper** (a folder or repo with a manuscript), not a
  repository in the software sense. A theorist's mental index is per paper.
- A **task** is a long-running agent run on that paper: polish, review,
  literature search, proof check, formalization. Several run at once and they
  fan out into subagents (`orchestrator` spawning `search@gpt56`,
  `review@gpt56`, `progressCheck@gpt56` in the screenshots).
- The artifacts they look at are the PDF, the LaTeX diff, and the manuscript
  files, not a pull request.

So "many repos" on desktop really means "several papers in flight", and the
right-hand context for a task is PDF, diff, files, terminal.

## What the code does today

Facts the directions have to respect, with the file that establishes each.

**Extension sidebar: two bundles in one slot.** The New and Sessions tabs are
not tabs inside one app. `renderViewHeader` in `src/shared/wa/viewHeader.ts`
renders a `wa-tab-group` with `activation="manual"` because clicking a tab
makes the host swap the whole webview document. `MainViewProvider.switchMode`
(`packages/extension/src/webview/MainViewProvider.ts`) disposes the message
listener, invalidates the ready handshake, and loads either the launcher
bundle (`<main-app>`, `packages/extension/src/webview/frontend/MainApp.ts`) or
the progress bundle (`<progress-app>`,
`packages/extension/src/progressView/frontend/ProgressApp.ts`) into the same
`texra.mainView` view. The editor-tab "TeXRA Progress" is the same progress
bundle in a `texra.progress.panel` webview panel
(`packages/extension/src/progressView/ProgressViewProvider.ts`).

**Desktop already composes both apps in one document.**
`packages/desktop/src/renderer/main.ts` mounts `<main-app>` inside a
`task-conversation-pane[data-pane="launcher"]` and the conversation view inside
`data-pane="conversation"`, and toggles them. `MainApp.render` has a
`desktopHost` branch that draws the hero ("What are you working on?") and a
composer dock instead of the tab strip. The desktop shell is documented in
`docs/prds/2026-05-08-electron-shell-layout.md`: rail on the left, task in the
center, optional workbench on the right, "the task never becomes a tab".

**Two composers, no shared base.** The launch composer is `instruction-panel`
(`packages/extension/src/webview/frontend/components/InstructionPanel.ts`, 784
lines): Interactive/Workflow and Agent/Team as `wa-radio-group`s, agent and
model as `wa-select`s, polish and dictation buttons, files via
`file-select-group`, submit as `MAIN_VIEW_COMMANDS.EXECUTE`. The follow-up
composer is `follow-up-input`
(`packages/extension/src/progressView/frontend/components/FollowUpInput.ts`,
491 lines): textarea bound to a stream id, pasted images ride along, submit as
`PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP`, queued follow-ups underneath. They
share only utilities (`@shared/utils/textarea`, the recording controller,
`@shared/wa/actionButtons`). Neither knows the other's store.

**One session list, already a tree.** `stream-tabs`
(`packages/extension/src/progressView/frontend/components/StreamTabs.ts`) is
the list in the extension's Sessions view and the desktop rail
(`model.sessions` in `packages/desktop/src/renderer/taskShell.ts`). Rows show
the AI one-liner (`stream.description`) as the title with the agent name and
model underneath, a status indicator, a pending-approval badge, and a worktree
chip. Children hang off `parentStreamId` through `childStreamsByParent`,
recursively, with no depth limit. `streamTree.ts` decides expansion: children
start collapsed, viewing a child keeps its ancestors open, a pending approval
bubbles a badge up the path. The list is flat creation order, not grouped by
status.

**A subagent card already exists.** `background-tasks-panel`
(`packages/extension/src/progressView/frontend/components/BackgroundTasksPanel.ts`,
656 lines) is a collapsible panel in the conversation listing the active
stream's live and finished children, every row navigating to its stream tab.
This is direction E2 in substance; what E2 changes is placement (at the point
of dispatch in the transcript) and the rollup pill.

**One level of breadcrumb exists.** `stream-header`
(`packages/extension/src/progressView/frontend/components/StreamHeader.ts`)
renders a `parent-link` ("Go to parent session") when `parentStreamId` is set.
A full path needs the ancestor walk that `streamTree.ts` already computes.

**Follow-ups go to the stream you are looking at.** `SEND_FOLLOW_UP` carries a
stream id (`src/controllers/progressView/ProgressViewCommandHandlers.ts`).
There is no reply-to-parent concept.

**Desktop is one window, one workspace, relaunch to switch.** `openWorkspaceFolder`
in `packages/desktop/src/main/index.ts` closes the window and relaunches the
app with the new path; core reads a single root through
`platform().workspace.getWorkspacePath()` (file resolution in
`desktopAgentExecution.ts`, settings, storage). Session storage is keyed per
workspace under `~/.texra/workspace-storage/<sanitized basename>` with a
sidecar file (`src/platform/defaults/workspaceStorage.ts`); there is no
cross-workspace session index. `StreamTabInfo` (`src/shared/schemas/stream.ts`)
has no workspace field. The shell PRD deferred multi-workspace and sketched it
as "collapsible group headers per workspace inside the existing rail, no extra
column" (section 12).

## Extension directions

Cost is relative: S is a few files, M is a bundle or provider change, L touches
core or persistence.

### A. One surface, sessions in a drawer. Recommended.

Fit: this is the desktop shell at sidebar width, so the two hosts converge on
one mental model. For a theorist the sidebar becomes "the conversation with my
paper", and New is just the empty state.

What changes:

1. Stop swapping bundles. Build one sidebar bundle that mounts `<main-app>`
   and `<progress-app>` side by side the way `packages/desktop/src/renderer/main.ts`
   does, with pane toggling instead of `switchMode`. `MainViewProvider` keeps
   one message listener and routes both command sets. This is the bulk of the
   work and it deletes the ready-handshake invalidation dance. Cost M.
2. Drawer: wrap `stream-tabs` in an overlay panel with a header (search, new,
   close). The list component is unchanged. Cost S.
3. Header: reuse `stream-header` as is; add a New action. Cost S.
4. Composer: keep `follow-up-input` in sessions and `instruction-panel` in the
   empty state at first. Visual unification (menu chips instead of radios,
   same box) can be a later pass; the desktop launcher branch of `MainApp`
   already draws the composer dock. Cost S now, M if the two composers are
   merged into one component.
5. Empty state: reuse the `desktopHost` hero branch of `MainApp.render` on the
   extension too; add the "Active now" strip from a filtered `stream-tabs`.
   Cost S.

Graceful under load: the drawer holds the existing tree, so hundreds of
sessions and nested subagents behave exactly as today. Nothing about A depends
on hierarchy work.

Risks: the file-selection group, Media, and LaTeXDiffs sections live only in
the launcher app; in A they move behind the "Context and attachments"
disclosure that the desktop branch already renders. The editor-tab progress
panel stays as it is.

### B. Header switcher.

Fit: least chrome, most transcript. Poor fit for theorists running fan-outs:
with twelve workers and nested children a combobox is a bad browser, and the
pending-approval badge that `streamTree.ts` bubbles up the tree has nowhere to
land except a dot in the header.

Cost: S on top of A (a popover around `stream-tabs`). Verdict: keep as the
keyboard path (a command palette entry), not as the only list.

### C. Launcher home, transcript in the editor.

Fit: gives transcripts real width, which reviewers of long proofs will like.
But it keeps two surfaces and diverges from desktop, and it doubles the
progress bundle's mount points (sidebar list plus editor panel). Everything
needed already exists (`showProgressView` with `openInEditor`), so it is cheap.

Cost: S. Verdict: not the primary; the "open in editor" secondary action from
`renderViewHeader` should survive inside A's header menu.

### D. Native tree view plus conversation section.

Fit: most VS Code-native, but `stream-tabs` would be reimplemented as a
`TreeDataProvider`, losing the AI one-liner plus agent-name two-line rows, the
worktree chip, and the pending-approval styling, and the desktop cannot share
it. Two renderers for one list is the dual-system pattern the repo forbids.

Cost: M to L. Verdict: no.

### E. Hierarchy

- **E1, tree in the drawer with breadcrumb.** Already 80 percent built:
  nesting, collapse rules, approval bubbling. Missing: the rollup pill on a
  collapsed parent (count children by status from `childStreamsByParent`, S),
  a status grouping of top-level rows (Running, Waiting on you, Recent) which
  the list does not do today (S), and the full breadcrumb in `stream-header`
  from the ancestor walk (S).
- **E2, subagents inline in the transcript.** `background-tasks-panel` already
  lists children with navigation. Change is placement at the dispatch point
  and the rollup. S. This is what lets the drawer show only top-level runs if
  we choose that rule.
- **E3, fan-out board.** New component, but it is a different projection of
  the same `childStreamsByParent` data, with the tile showing the child's last
  tool row. M. Only worth it once workflows with ten-plus lanes are common in
  paper work; today that is the code-survey use, not the theorist use.

Follow-up routing: every board with a breadcrumb needs the rule. Cheapest
honest rule is the current one, "a message goes to the stream you are
viewing", stated in the composer with a "reply to parent instead" link that
calls `setActiveStream` on the parent. No protocol change.

## Desktop directions

The blocker is shared by all of them: one workspace per process. Any rail that
lists tasks from several papers needs, in order:

1. A cross-workspace session index. `workspaceStorage.ts` already lays out
   `~/.texra/workspace-storage/<id>/` with a sidecar per workspace, so an
   index is "enumerate sidecars and read each run store", not a new format.
   Cost M.
2. A workspace field on `StreamTabInfo` or on the row model the rail builds,
   so rows can carry a paper mark. Cost S once the index exists.
3. Running a task in a workspace other than the process root. This is the L
   item: `platform().workspace.getWorkspacePath()` is a single root that file
   resolution, settings, and storage read. Either sessions are read-only
   across workspaces until you switch (relaunch stays), or execution gets a
   per-run root. The single-owner-sessions work already gives each run a
   pid-owned lease, which is the right seam for a per-run root.

Given that, the directions rank:

### 1. Papers as sections. Recommended, and already ruled.

This is exactly what the shell PRD section 12 deferred to: collapsible group
headers per workspace inside the rail, no extra column. `stream-tabs` inside a
group header per paper, the existing `task-project-row` becoming the header.
For a theorist with three papers in flight it reads as their desk. Phase it:
first read-only groups (index only, opening a task in another paper offers
"switch to this paper" which is today's relaunch), then per-run roots.

Cost: M for read-only groups, L for cross-paper execution.

### 2. One paper in focus, switcher on top.

Fit: honest about today's one-workspace runtime. The switcher is
`openWorkspaceFolder` with a recent list instead of a dialog, and the
"Elsewhere" card is the index filtered to running or waiting. This is the
cheapest step that already improves the multi-paper day, and it degrades
gracefully into direction 1 later because the rail structure is the same.

Cost: S for the switcher over a recent list, M with the Elsewhere card.

### 3. Task-first, paper as a tag.

Fit: weakest for theorists. It optimizes for many repos with few tasks each,
which is the software-agent shape, not the paper shape. It also removes the
project files tree from the rail. Cost same as 1. Verdict: no, but keep the
filter chips idea for the drawer search.

### 4. Workspaces plus a context rail.

Fit: the right column is a strong fit once relabeled for papers: PDF, LaTeX
diff, Files, Terminal, Logs, with "compile" and "latexdiff" where Cursor shows
"Open PR". The desktop already has a workbench pane on the right and the four
tools in the rail footer, so this is a re-homing, not new capability. Needs a
wide window; below about 1100 px the column folds into the header's environment
popover.

Cost: M. Verdict: pair with direction 1 as the second phase.

### 5. Top-level rail plus subagent pane.

Fit: keeps the rail from growing with fan-outs and gives approvals a home next
to the tree. Data is all there (`childStreamsByParent`, approval signals). The
pane is the same component as the extension drawer's tree. Cost M.

### 6. Focus mode, rail scopes to the run.

Fit: nice for a twelve-lane run, but it hides sibling tasks while inside a
run, which for a theorist waiting on a review of another paper is the wrong
trade. Cost S over 5. Verdict: optional mode, not default.

## Multi-agent runs (`dispatch_multi_agent`)

A `dispatch_multi_agent` call is a workflow-script run: a script declares
phases and calls, the engine runs them with a concurrency cap, and every call
is a child stream of the parent run (`workflowScriptAgentRunner.ts` sets
`parentStreamId` and reports `childStreamId`). The facts of a run are folded
once for every host in `src/shared/streams/workflowRunModel.ts`: phase order,
attempt scoping, the declared plan from the `workflowPlan` marker, tallies,
per-call status cells (declared, planned, queued, running, completed, cached,
skipped, cancelled, failed), and the attention-first order of a phase. The CLI
popup (`packages/cli/src/chat/tui/panes/WorkflowPopup.tsx`) renders that model
with skip, retry, kill, and next-failed. The extension board
(`packages/extension/src/progressView/frontend/components/TaskGroupList.ts`,
mounted inside the transcript's log list) does not: the 2026-08-29 survey
recorded six divergences that are product decisions, not cleanups. In short,
the board lists calls in transcript order, ignores the declared plan until a
phase opens, keeps superseded-attempt cards, has no settled-run state, and
its call row is a navigation link only. Team launches (`TeamPlan.ts`,
`MainViewExecutionLaunchController.ts`) resolve into the same shape, a parent
run with children, so they need no separate surface.

Three boards on the canvas page "Multi-agent runs":

- **W0, proposal card.** The approval handshake `proposalFlow.ts` already runs,
  drawn as a card in the orchestrator transcript: the declared phases with
  agents, models, and call counts, an estimate, and Approve, Open script,
  Reject, plus the per-session bypass. Data: the plan marker. Cost S.
- **W1, the run's own board (extension).** Inside the workflow child stream: a
  phase strip (filled diamond opened, hollow declared, an amber dot on a phase
  that needs a decision), the selected phase's rows attention-first (needs a
  decision with inline Allow and Deny, failed with Retry and Skip, running
  with elapsed and generated tokens, then counted folds), a run tally line,
  and a controls bar (Next failed, Retry failed, Kill run) where the chat
  composer would be, because this stream has no chat. This is the CLI popup's
  model on the graphical host, and it closes divergences 1 to 5. The
  controls need the engine's per-call `onControl` path exposed through the
  progress view commands, which the CLI already uses. Cost M.
- **W2, desktop.** Same board in the conversation pane. The rail shows the
  parent task with a 31-call rollup and nothing else; the right column is the
  run summary (progress, cost, elapsed, generated tokens), the phases as a
  vertical tab list, and the plan. Cost S on top of W1.

Rule that follows: a workflow call is never a top-level row anywhere. It is
reachable from its phase board and from the drawer tree under its parent.

## Critique pass (2026-09-03, three read-only agents)

Findings that change the plan. Each was verified against the file cited.

**The "mount both apps like the desktop" premise was wrong.** The desktop
renderer does not mount `<progress-app>`. It mounts `<stream-conversation>`
and one `<stream-tabs>` and hand-wires the message pump and events
(`packages/desktop/src/renderer/main.ts:288-294, 1031-1080`). `ProgressApp`
owns the split panel, the resize observer, the view header, and the status
announcer. So direction A's step 1 is not a port of desktop code; it is
"make `ProgressApp` own the empty state" (render the launcher inside it when
no stream is active), and treat the desktop as a second consumer of that.

**The sidebar and the editor tab are an exclusive target.**
`ProgressViewProvider.target` is sidebar XOR editor
(`ProgressViewProvider.ts:50-60, 275-305`); `getActiveWebview()` returns
nothing for the sidebar while the editor tab is open, and `sendMessage`
drops. A merged sidebar that always shows the conversation freezes the moment
the user pops out. Two honest options: fan out to both webviews with two ready
states (backend change), or the sidebar shows the list plus a "Sessions are
open in the editor" placeholder while popped out. Phase 1 takes the second.

**Two persisted-state stores in one document clobber each other.**
`webview/frontend/persistence.ts:63` and
`progressView/frontend/webviewStorage.ts:12` each snapshot `getState()` once
and write their whole cache back (`src/shared/state/PersistedState.ts:23-36`).
One document needs one store. This is a real prerequisite, not polish.

**Handler registries overlap.** Both claim `SWITCH_VIEW` and `WEBVIEW_READY`
(`ProgressViewMessageHandler.ts:300-307`, `MainViewProvider.ts:100-105`), and
six `view/title` menu `when` clauses key on `texra.activeView`
(`packages/extension/package.json:652-677`). The handshake is re-derived,
not deleted: `activeView` becomes `launcher` in the empty state and `progress`
when a stream is active.

**Bundle cost.** Progress bundle 2.5 MB plus KaTeX fonts, launcher 892 KB.
One sidebar document loads both; the editor tab builds from the progress
folder alone. Lazy-load the launcher chunk or accept 3.4 MB.

**Launcher sections cannot just move.** `file-select-group` consumes
`fileStateContext` provided by `<main-app>` (`FileSelectGroup.ts:68`);
LaTeXDiffs binds four signals and seven commands
(`mainViewActions.ts:432-500`). The desktop hero branch already drops
`latexdiffs-section` entirely. Resolution: the empty state stays `<main-app>`
(so the file groups keep their context), and LaTeXDiffs plus the media tools
move to a Tools sheet opened from the header overflow, reachable from any
state; the sheet hosts the real `latexdiffs-section` on props.

**Grouping the tree by status.** Top-level order is insertion order
(`progressState.ts:135-137`); there is no roving tabindex, so regrouping on
status change only moves rows, it does not break a keyboard model that does
not exist. Expansion and the ancestor-open rule are order-independent. But
approval bubbling already force-expands the path (`streamTree.ts:86-99`), so
a collapsed parent never carries a waiting count; the rollup pill shows
running and finished only. `compact` mode is the sub-500px icon rail of the
split panel; with a drawer it becomes dead code and should be deleted.

**Breadcrumb.** One level because the parent can be evicted
(`StreamHeader.ts:671-676`) and the link is capped at 40 percent width. The
full path is the ancestor walk with the same eviction fallback per segment.

**Reply to parent loses the draft.** Follow-up text and pasted images are per
stream (`followUpInputState.ts:20-37`). The link must carry the draft to the
parent, or say that it will not.

**Narrow widths.** Container queries already fire at 440 (composer), 520
(header), 640 (conversation). At 250 px the 320 px drawer covers the view.
Drawer width becomes `min(320px, 100% - 40px)`; the composer chips collapse
into one popover under 440 px, which the existing query already handles for
the follow-up.

**W0 already exists.** `ProposalRequestPanel.ts:224-270` renders phases from
the shared run model. W0 is a restyle of that panel; the estimate and "Open
script" have no data source and are dropped.

**W1 controls are not small.** `WorkflowControlAction` is `skip | retry`
(`workflowExecutionSnapshot.ts:44`); kill is the run's stop. No progress-view
command exists for workflow controls; adding one needs the ownership check in
`executionInteractionOwnership.ts`. Allow / Deny per call is an approval, not a
control, and belongs to the child's `request-panels` (single armed target for
y / n). The board's row links there. Follow-up gating for workflow streams
needs `userFollowUpSupport` surfaced to the frontend
(`ToolUseStreamContent.ts:91`). W1 is M.

**Desktop: the cross-paper index has no status.** The sidecar holds only
`{path, createdAt}` (`workspaceStorage.ts:123-132`). Run storage is read
through a process-wide `StorageFS` singleton (`storageFS.ts:18-20`, 117 call
sites) with no root parameter. `meta.json` yields description, parent, and
outcome, but status is live-only and pending approvals are in memory. So the
honest read-only phase lists recent descriptions from other papers with no
liveness dots. Liveness would come from the per-execution lease files
(`executionLease.ts`), which is a separate, bounded reader.

**Desktop: per-run root is larger than one seam.** `platform().workspace` has
30 consumers, `platform().config` 14, plus the storage port; file verbs in the
progress view resolve against the current root. Rendering a foreign run is
honest only with file actions disabled.

**Desktop: no PDF workbench kind.** Kinds are editor, terminal, browser,
review, settings, logs (`desktopTaskShell.ts:26-68`); the PDF is a dialog
overlay (`pdfOverlay.ts`). Terminal defaults to the bottom placement. A PDF
tab is new work, phase 3, not a re-homing.

**Desktop: a second `stream-tabs` and a second approval surface.** The rail's
one `stream-tabs` is bound to `activeStreamId$`; a subagent tab that hosts
another instance shows two active rows unless the rail lists top-level only.
An approval card in a side pane is a second Allow / Deny surface that
`request-panels` cannot see; removed. `background-tasks-panel` already exists
as a third subagent list, so direction 5 is demoted: E2 in the transcript and
the drawer tree cover it.

**Desktop: header collisions.** `task-header`, `stream-header`, and
`usage-panel` already render title, status, elapsed, tokens, and cost. The
run tally moves to a summary line above the phase strip.

**Team launches are one root run with a roster** (`TeamPlan.ts:369`,
`MainViewExecutionController.ts:40-63`), not a parent with children. Children
appear only if the root dispatches. Nothing to render for a team beyond the
ordinary tree.

## Surface mapping: every current surface and its home

From the inventory of the New view, the Sessions view, the editor tab, and
the host commands. "Same" means the component is unchanged.

| Surface today                                                                                                                               | Home in the one-surface design                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New / Sessions tabs                                                                                                                         | Removed. New is the "+" action and the empty state; Sessions is the drawer (sidebar) or the docked list (editor tab).                                                                                                          |
| Open dashboard (gear), Open sessions in editor, Back to sidebar                                                                             | Header: gear stays; the other two in the header overflow and the drawer footer.                                                                                                                                                |
| Loading skeleton, onboarding welcome and setup cards                                                                                        | The empty state body, replacing the hero while the funnel is pending. Same components.                                                                                                                                         |
| API key, agent config, dependency, getting started, login banners                                                                           | App-level, not session-level: above the composer in the empty state; a thin strip above the follow-up in a session. Same components.                                                                                           |
| Interactive / Workflow radio, Agent / Team radio                                                                                            | Composer chips with menus (the desktop already collapses these into a "Run mode" select). Team appears as a section of the agent menu with "Manage teams…".                                                                    |
| Session hint callout                                                                                                                        | Under the composer when a mode is chosen. Same.                                                                                                                                                                                |
| Polish, dictation, image paste, file drop                                                                                                   | Composer, both states. Same controllers.                                                                                                                                                                                       |
| Working directory select (two or more roots)                                                                                                | Composer chip, shown only then.                                                                                                                                                                                                |
| Agent, team, model selects with settings gears; "Browse all agents…"                                                                        | Chips; the gear becomes a "…settings" item in each menu.                                                                                                                                                                       |
| Run agent (Cmd+Alt+E)                                                                                                                       | Send button; the accelerator stays.                                                                                                                                                                                            |
| Debug-only Pack output, Delete output files                                                                                                 | Header overflow, debug section.                                                                                                                                                                                                |
| Input, Context, Media groups; add opened, add, clear, reorder, remove; wrench "Attach TeX Count"; wand "Figures / TikZ / Compile Input PDF" | "Context and attachments" disclosure in the empty state, which the desktop hero already renders; the wand and wrench items also in the Tools menu. Same `file-select-group`, still inside `<main-app>`.                        |
| LaTeXDiffs: base, edited, commit selects; Diff, Compare, Merge, Accept; Diff against commit; Pack, Delete output                            | Tools sheet from the header overflow, any state, hosting the real `latexdiffs-section`. The desktop dock chips ("latexdiff vs last commit") are shortcuts into the same sheet. The desktop gains this back; it drops it today. |
| Empty states ("No runs yet" and getting-started buttons)                                                                                    | Collapse into the one empty state.                                                                                                                                                                                             |
| Rail rows, tree, expand, delete                                                                                                             | Drawer or docked list. Same `stream-tabs`, plus status groups and rollup pills.                                                                                                                                                |
| Stream header: title, parent link, status, elapsed, goal and progress badges                                                                | Same, with the full ancestor path.                                                                                                                                                                                             |
| Toolbar: stop, fresh run, resume, setup in main view, task storage, export, copy context, latexdiff, clean, pack; bypass toggles; compact   | Same toolbar. "Setup in main view" becomes "Edit as new task", which opens the empty state prefilled.                                                                                                                          |
| Tasks, Plan, Background tasks, Command panels                                                                                               | Same. Background tasks becomes the E2 dispatch card at the dispatch point.                                                                                                                                                     |
| Transcript rows, inline copy actions, compaction banners, terminal output, chime                                                            | Same.                                                                                                                                                                                                                          |
| Request panels (tool edit, bash, retry, proposal, plan, external inquiry, question), approve split button                                   | Same. The run board's rows link here.                                                                                                                                                                                          |
| Latexdiff results, generated files with per-file verbs                                                                                      | Same.                                                                                                                                                                                                                          |
| Follow-up composer, queued messages                                                                                                         | Same, plus the "goes to" line with reply-to-parent carrying the draft.                                                                                                                                                         |
| Usage footer                                                                                                                                | Same.                                                                                                                                                                                                                          |
| view/title menus (indent, clean output, clean build, dashboard, new session)                                                                | Keyed on the re-derived `activeView`; "New Session" becomes the "+" command.                                                                                                                                                   |
| Show Launcher, Show Progress, Toggle (Cmd+Alt+M / P / T), Open in editor tab                                                                | Show Launcher = new task; Show Progress = focus conversation; Toggle = toggle the drawer; open in tab unchanged.                                                                                                               |
| Status bar item                                                                                                                             | Unchanged.                                                                                                                                                                                                                     |
| Desktop-only: hero, context disclosure, composer dock, Run mode select, always-open follow-up                                               | Become the shared empty state and composer on both hosts.                                                                                                                                                                      |

## One state, three renderers

The owner ruled after the critique pass that the hosts must render one state
with no projection or adapter layers. That ruling and its evidence are in
`2026-09-03-one-view-state-three-renderers.md`, which now governs this
proposal: every board element reads a named field of `SessionView`, the
extension's phase 1 prerequisites are subsumed by the one-subscriber design,
the sidebar-versus-editor exclusivity becomes two subscribers to one state,
and the workflow controls become one runtime request on every host.

## Recommended sequence

1. Extension A with E1. Prerequisites first: one persisted-state store per
   document, one message listener with a merged registry, `activeView`
   re-derived. Then `ProgressApp` owns the empty state (the launcher inside
   it), the drawer wraps the existing tree with status groups and rollup
   pills, the header shows the ancestor path, the Tools sheet takes LaTeXDiffs
   and the media tools, and the sidebar shows a placeholder while the editor
   tab owns the conversation. No core changes; the launcher chunk lazy-loads.
   1a. W1 on the extension: the run board adopts the shared run model; a new
   progress-view command carries skip and retry with the ownership check;
   approvals stay in the child's request panel; `userFollowUpSupport` reaches
   the frontend so the controls bar can replace the composer. Independent of
   A. Cost M.
2. Desktop 2 as the quick win: recent-papers switcher over the relaunch, and
   a "Recent in other papers" list read by a bounded second reader over the
   workspace-storage layout. No liveness dots until the lease reader exists.
3. Desktop 1: paper sections in the rail, one `stream-tabs` per section, the
   rail bound to one active stream. PDF as a workbench tab kind replaces the
   overlay. No context column; the workbench is that surface.
4. Per-run workspace root, which unlocks running tasks across papers without
   relaunch. This is the only step that touches core.

## Decisions to take first

- Are subagents ever rows in the top-level list? Recommendation: no. They live
  under their parent (E1) and in the transcript (E2); the rollup pill is the
  only trace at top level.
- Where does a follow-up go from inside a child? Recommendation: to the child,
  with the reply-to-parent link, until there is a protocol for parent-directed
  messages.
- Does the desktop keep relaunch-to-switch for one more release? Recommendation:
  yes, behind a switcher, while the index lands.
