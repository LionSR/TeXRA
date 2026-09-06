# Projection and adapter ledger

> **Consolidated into `.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md` on 2026-09-03.** That PRD governs where the two differ; this proposal is kept for its evidence and history.

Status: proposal, 2026-09-03. Companion to
`2026-09-03-one-view-state-three-renderers.md`, which covers the read path
from session facts to pixels. This ledger covers everything else: launch and
settings, the write path, paint and copy, cross-cutting infrastructure, the
desktop's own layers, and the headless and SDK consumers. Owner rule under
audit: no dual systems, no projection or adapter layers between state and
pixels, the TUI, desktop, and extension render one state, and cross-cutting
is minimized.
Archived: 2026-09-06

Method: five read-only audits, one per lens, each classifying every layer it
found with file and line evidence. Classes: **deep module** (hides an
invariant; cite the pin), **transport** (a process or webview boundary
crossed with the state shape), **projector** (re-derives what the layer
above already has), **adapter** (renames or forwards without adding an
invariant), **dual system** (one fact or decision implemented twice).
Verdicts: keep, collapse, delete. Line counts are the auditors' estimates
and are not net figures; prior convergence work in this repo landed
net-positive when the duplicated surface was smaller than the seam that
replaced it, so each collapse is measured before it is called a reduction.

Two corrections to earlier documents that the audits established:
`scripts/check-runtime-boundaries.mjs` no longer exists (the pins live in
`eslint.config.mjs:88-105`, `config/ratchets/*.json`, and
`src/test-kernel/architecture/*.vitest.ts`), and the decoupling PRD's claim
that `desktopAgentExecution.ts` inlines 300 to 400 lines of duplicate launch
logic is stale: its launch tail is 50 lines and delegates. The residue it
does carry is listed in section 6.

## 1. The standard: one mechanism per concern, already true

These are single-owner today and are named here as the standard so nothing
grows a second one.

| Concern                                | The one mechanism                                                                                                                    | Pin                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Host services                          | `platform()` ports, 14 ports, 110 files                                                                                              | CLAUDE.md, `dependencyDirection.vitest.ts`                                      |
| Session identity and runtime access    | `SessionHandle`                                                                                                                      | `host-agent-mock-baseline.json`, `hostAgentDeepImportRatchet.vitest.ts`         |
| Facts                                  | `SessionEventHub`: `AgentEvent` run-scoped, `SessionFact` session-scoped; zero `bus.emit` in VS Code-free zones                      | CLAUDE.md event-channel rule (verified clean)                                   |
| App-lifecycle signals                  | `AppSignals`, 7 signals, 14 files                                                                                                    | scope documented in `src/eventBus`                                              |
| Webview transport                      | `hostBridge.postMessage` on one send channel and one push channel, shared by the VS Code webview and the Electron preload            | `src/shared/hostBridge.ts`, `packages/desktop/src/shared/hostBridgeChannels.ts` |
| Reactive primitive                     | `@lit-labs/signals` with `useSignal` on the CLI                                                                                      | `src/shared/signals.ts`                                                         |
| Launch validation                      | `executionRequests.validateExecutionRequest`, the only `@agent/core` deep import every host may take                                 | `host-agent-import-baseline.json`                                               |
| Catalogs                               | `loadAgents`, `computeModelOptions`, `resolveTeamLaunch`                                                                             | `eslint.config.mjs:88-127`                                                      |
| Settings                               | `stateSettings` catalog, `settingsAccess`, `stateSettingWrite`, one `SettingsSnapshotValues` DTO, one form mounted by both GUI hosts | `stateSettings.vitest.ts`                                                       |
| Onboarding                             | `deriveOnboardingFunnelState`                                                                                                        | single definer                                                                  |
| Approval policy                        | `src/shared/approvalPolicy.ts`                                                                                                       | `approvalPolicyAuthorityRatchet.vitest.ts`                                      |
| Follow-up admission                    | `submitProgressFollowUp` over `ToolUseFollowUpQueue`                                                                                 | `FollowUpQueue.vitest.ts`, ratchet                                              |
| Resume and stop                        | `resumeRun`, `executeAgent`, `runAgent`, `stopAgentStream`                                                                           | `host-agent-mock-baseline.json`                                                 |
| Row facts                              | `projectTranscriptRow`, `toolRowModel`, `toolRowSections`, `workflowRunModel`                                                        | "hosts never regroup, re-sort, or re-count"                                     |
| Formatters                             | `formatDuration`, `formatCompactDuration`, `formatCompactTokenCount`, `formatCostUsd`, `getModelLabel`                               | single definers                                                                 |
| Message handlers                       | `BaseViewMessageHandler`, `BaseWebviewProvider`, `UnsupportedCommandsMixin`                                                          | 2026-09-02 survey                                                               |
| Desktop file, diff, preview, pty hosts | `desktopProgressFileActions`, `desktopDiffHost`, `desktopPreviewHost`, `desktopPtyHost`                                              | port implementations                                                            |
| Exit codes                             | `runOutcomeExitCode` over the shared `RunOutcome`                                                                                    | `exitCodes.ts`                                                                  |

Deep modules that are single-owner but **unpinned**, so nothing today stops
a second implementation: `HostInteractions.ts`, `SessionEventHub.ts`,
`streamApprovalQueue.ts`, `workflowControlRegistry.ts`,
`executionInteractionOwnership.ts`. Section 8 adds the pins.

## 2. Launch and settings

| Layer                                                                                    | Class                                              | Verdict                                                   | Evidence                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop tour: own `TourStep` model, own state key, skip does not send the funnel's skip  | dual system, second onboarding machine, ~500 lines | delete or fold as a funnel state                          | `desktopOnboarding.ts:83`, `desktopOnboardingIpc.ts:74,147`                                                                                |
| "Refresh and post three catalogs" written four times; `loadOptions` twice                | dual system, ~150 lines                            | one `loadMainViewOptions` in `src/controllers/mainView`   | `MainViewStartupController.ts:71`, `mainViewCommands.ts:36-58`, `MainViewProvider.ts:266-292`, `desktopAgentSettingsController.ts:248-279` |
| CLI team plan restates the catalog ports and bypasses `resolveTeamLaunch`                | dual system                                        | CLI calls `loadTeamOptions(createTeamCatalogPorts())`     | `multiAgentRunPlan.ts:86,104-113`                                                                                                          |
| Default agent picked twice with different orders (assistant-first vs orchestrator-first) | dual system with a divergent invariant             | one `pickDefaultAgent` in `src/shared`                    | `defaultAgents.ts:39-50` vs `catalogSlice.ts:36-50`                                                                                        |
| Default model: `decideRunModel` on the CLI, first-enabled-wins in the GUI                | dual system                                        | fold into `decideRunModel`                                | `runModel.ts:29`, `mainViewActions.ts:95`                                                                                                  |
| `enabledModels.ts` CLI shim                                                              | adapter, 69 lines                                  | delete                                                    | self-described as an adapter                                                                                                               |
| Extension re-parses the validated request through a VS Code command                      | adapter                                            | call `runAgent` with `launch.request` as the desktop does | `executionHandlers.ts:106` to `executeCommand.ts:44`                                                                                       |
| Working-directory check: extension only; desktop none; CLI its own                       | dual system, three semantics                       | fold into `prepareMainViewExecutionLaunch`                | `executionHandlers.ts:50-62`, `workflowInputs.ts:56`                                                                                       |
| Setup launch: extension direct `runAgent`, desktop through the launch fold               | dual system                                        | both through `setupLaunch.ts` and the fold                | `setupAssistantCommand.ts:245`, `index.ts:1012`                                                                                            |
| Merge launch config built twice, identical literal                                       | dual system, ~10 lines                             | one home in `src/controllers/progressView`                | `mergeCommands.ts:31-35`, `desktopProgressFileActions.ts:85-90`                                                                            |
| CLI chat bypasses validation with a raw schema parse                                     | adapter                                            | route through `executeCliConfig`                          | `chatSessionController.ts:450`                                                                                                             |
| Settings snapshot poster tables, 9 arms each, twice                                      | dual system, mild                                  | one table taking `post` plus two host hooks               | `SettingsViewMessageHandler.ts:588-608`, `desktopSettingsIpc.ts:243-263`                                                                   |
| `gettingStarted` visibility computed by three producers                                  | dual system                                        | `MainViewStartupController` owns it                       | `desktopFileSelection.ts:161`, `FileManager.ts:286`, `MainViewStartupController.ts:62,90`                                                  |
| File-category enumerations, four copies                                                  | dual system                                        | one `MULTI_FILE_LISTS` in `src/shared`                    | `store.ts:79,142`, `MainViewDroppedFilesController.ts:7`, `desktopFileSelection.ts:59,65`                                                  |

Launch validation is entered nine ways: six through the deep module, three
by raw schema parse (`executeCommand.ts:44`, `setupAssistantCommand.ts:245`,
`chatSessionController.ts:450`).

## 3. The write path

| Layer                                                                                                                                                   | Class                                                                            | Verdict                                                                                                                                                   | Evidence                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CLI follow-up and resume engine: a `PQueue`, a 25 ms stream-id poll, a verbatim copy of the shared submit body, its own interrupted-follow-up admission | dual system, ~700 lines, deferred as #6828                                       | collapse onto `submitProgressFollowUp` and `resumeRun`; move the CLI-only options (model switch, child routing, skill reservation) into the shared submit | `chatSubmitDriver.ts:118,279-321`, `chatSessionController.ts:808-862`, `runChatTui.tsx:330`                                   |
| CLI approval implementations, TUI and headless, with their own decision mappers                                                                         | dual system, the second and third `HostInteractions` implementations, ~400 lines | mappers onto the controller path; keep keystroke handling                                                                                                 | `subscribeApprovals.ts:143`, `approvalQueue.ts:236`, `approvalAdapter.ts:53,96`, `settleApprovals.ts`                         |
| Bash, plan, and user-question decision mapping, byte-identical in the two GUI hosts                                                                     | dual system, ~60 lines                                                           | into `ProgressViewCommandHandlers` beside the tool-edit normalizer                                                                                        | `ProgressViewMessageHandler.ts:677-685,869-876`, `desktopAgentExecution.ts:771-793`                                           |
| Bypass flags mirrored in five places                                                                                                                    | projector, ~150 lines                                                            | read from the approval queue through the view state                                                                                                       | `streamState.ts:194`, `projectionShape.ts:39`, `progressStreamControls.ts:34`, `permissionSlice.ts:93`, `cliState.ts:185,207` |
| `StreamState.ui` (draft, sending, polished, transcribed, recording, focus) inside a shared wire schema                                                  | interaction state mis-homed as a fact                                            | move to the webview's interaction record; extend `sessionPresentationBoundary.vitest.ts` to catch these names                                             | `streamState.ts:175-184`                                                                                                      |
| Resume wrappers with the same latch idiom in both GUI hosts                                                                                             | dual system, ~170 lines to ~90                                                   | one controller in `resumeStreamPresentation.ts`                                                                                                           | `resumeFromResumeData.ts:18-38`, `desktopAgentResume.ts:38-78`                                                                |
| Workflow controls: CLI-only, relayed through `App.tsx`, no ownership gate on the call                                                                   | transport relay; missing standard                                                | every host issues `workflowControls.control` and `executions.kill` directly; add the ownership check                                                      | `WorkflowPopup.tsx:477`, `App.tsx:164,575`, `workflowControlRegistry.ts:9-10`                                                 |
| Desktop inquiry dismiss wiring duplicating the extension's                                                                                              | dual system                                                                      | into `ProgressViewCommandHandlers`                                                                                                                        | `desktopAgentExecution.ts:796-799`                                                                                            |
| CLI builds the same inquiry action argument twice                                                                                                       | dual system                                                                      | one builder                                                                                                                                               | `subscribeApprovals.ts:861-874`, `settleApprovals.ts:159`                                                                     |
| `ProgressFollowUpController` is the compile-fixer planner, not the send path; `progressStreamControls` returns bypass flags and a goal chip             | misnamed                                                                         | rename                                                                                                                                                    | `ProgressFollowUpController.ts:68`, `progressStreamControls.ts:28`                                                            |
| `setActiveStream` fact whose semantics are "attach or ensure"                                                                                           | misnamed; persistence handled separately                                         | rename; keep out of the durable set per the one-state proposal                                                                                            | `SessionEventHub.ts:40-43`, `ProgressPresentationState.ts:13-49`                                                              |

Entry points into `runAgent` or `resumeRun`: extension 4, desktop 2, CLI 5,
two of the CLI's near-duplicates.

## 4. Paint and copy

| Layer                                                                                                                                                                                          | Class                                    | Verdict                                                              | Evidence                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status-to-tone mapping in eleven places with contradictory colors (running is success, yellow, or cyan depending on the file; two dead selectors)                                              | dual system                              | add a tone column to `streamStatusDisplay`; hosts style the tone     | `statusIndicatorStyles.ts:26-55`, `StreamTab.styles.ts:29-46`, `groupStyles.ts:23-38`, `BackgroundTasksPanel.ts:576-590`, `SubagentListDisplay.ts:28-39`, six more |
| Three terminal-state vocabularies that never import each other, plus a fourth `Running`                                                                                                        | dual system                              | one vocabulary in `src/shared/copy`                                  | `streamStatusDisplay.ts:73-75`, `workflowCallProgress.ts:182-188`, `historyRunStatus.ts:19-21`, `sessionTitle.ts:30`                                               |
| `TranscriptIndex` incremental group tree                                                                                                                                                       | host-local projector, ~300 lines         | measure plain rebuild under `repeat` and `guard`; delete if it holds | `messageIndex.ts:228-559`                                                                                                                                          |
| `workflowPlainOutput` folds raw events with its own terminal gate, status table, log filter, and model-label swap                                                                              | dual system, ~200 lines, the fourth fold | render `TranscriptView.run` to text                                  | `workflowPlainOutput.ts:32-42,114-184`                                                                                                                             |
| `UserMessage` ignores `row.summary` and re-derives it with its own cache                                                                                                                       | dual system, ~60 lines                   | paint `row.summary` as the CLI does                                  | `UserMessage.ts:204-252`                                                                                                                                           |
| Three tool-row predicates copied byte for byte between hosts; `childRowMetadataText` restating `formatWorkflowCallLiveParts`                                                                   | dual system, ~40 lines                   | into `ToolRowModel` and the shared live parts                        | `toolFormatters.ts:67,106,131-136` vs `toolRenderers.tsx:171,354,361-365`; `SubagentListDisplay.ts:70-89`                                                          |
| Todo labels three times; "Thinking" twice; "No runs yet" three times; "Approve this X (y)" hand-copied five times; "Latexdiff results (N)" twice; "Phase N of M" beside the shared stage label | copy duplication                         | move to `src/shared/copy`                                            | listed in the audit                                                                                                                                                |
| Choice of duration formatter differs per host for the same fact; a third local `formatElapsed`                                                                                                 | inconsistency                            | one formatter per fact, chosen in the shared model                   | `TaskGroupList.ts:602` vs `WorkflowRunDetails.tsx:91`; `runProgressRenderer.ts:524`                                                                                |
| `baseLogFormatter.ts` twelve-line type alias                                                                                                                                                   | adapter                                  | fold into the painter map                                            | whole file                                                                                                                                                         |

Genuinely per host and staying: head and tail line budgets and header width
(terminal rows vs scrollable DOM), icon and language maps, Intl timestamps,
the tool timer, word diff vs hunk diff, the Ink static ring and trim
hysteresis.

## 5. Cross-cutting infrastructure

| Concern                       | Today                                                                                                                                                                                               | Class                                                             | Verdict                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Reactive state in the UI tier | five mechanisms: signals, the `trackedSignal` wrapper, mutative drafts, Lit properties, React state                                                                                                 | dual at the declaration idiom                                     | signals are the standard; CLI adopts `trackedSignal` or it is deleted                 |
| Signal to component           | signals are copied into eleven Lit contexts by two providers in `willUpdate`, then consumed by ten files; the contexts exist only to re-broadcast values the signals hold                           | projector                                                         | delete the contexts; components become `SignalWatcher` and read signals               |
| Event channels                | six: `AppSignals`, `SessionFact`, 46 `MainViewEvents` plus 13 `ProgressEvents` DOM factories bubbling to one listener, `hostBridge`, Electron routes with 44 desktop-only schemas, VS Code commands | sprawl at the DOM-event layer; dual at the Electron schema family | direct action calls (`mainViewActions` exists); one dispatcher over one schema family |
| Wire vocabulary               | 244 commands in seven groups; 35 exist only to move a value a state patch would carry (17 `SET_*` in the main view, 18 `UPDATE_*` and `SET_*` in progress); 420-line inbound dispatch               | sprawl                                                            | one state-patch message per view; the rest are requests                               |
| UI-state persistence          | six stores, three schema families: `PersistedState` front and back, `ToggleStateStore`, `pendingStateManager`, platform state with 50 keys, a misnamed desktop view-state push                      | dual                                                              | one `PersistedState` owner per view                                                   |
| Panel inheritance             | four levels, each adding one abstract member and no invariant                                                                                                                                       | sprawl                                                            | two levels                                                                            |
| Active stream                 | three owners across 59 files: persisted backend presentation state, frontend signal, CLI state; plus a declared-but-dead option                                                                     | dual, triple                                                      | one owner, interaction state per surface as the one-state proposal rules              |
| Pending approval              | separate per host: CLI queue beside CLI state; extension `permissions$`                                                                                                                             | dual                                                              | read `SessionView.approvals`                                                          |

Hop count for one fact, "stream description changed": nine on the
extension (fact, applier, renderer port, renderer, command, bridge, slice,
signal, `willUpdate`, context, consume), three on the TUI. The one-state
proposal takes the extension to four (fact, fold, patch, component).

## 6. Desktop and the other renderers

| Layer                                                                                                                                                                                                    | Class                                                                               | Verdict                                                     | Evidence                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `desktopAgentExecution.ts` residue: pack and clean result switch, latexdiff context, recording, spill artifact, decision mappers, restore run config; each with an extension twin never extracted either | dual system, ~300 desktop plus ~300 extension lines                                 | into `src/controllers`, the home the dual-systems PRD named | `:130-137,570-642,1070-1139,509-524,733-761,771-794,1148-1166`   |
| `desktopSettingsIpc` GitHub token and memory handlers mirroring the extension's                                                                                                                          | dual system, ~200 lines                                                             | into `SettingsViewHost`                                     | `:174-182,319-416`                                               |
| `renderer/messageRoutes.ts` ordered `safeParse` scan beside the shared dispatcher; `createCommandHandler` weakly redoing `createDispatcher`                                                              | dual system, ~200 lines                                                             | one `createDispatcher` over the desktop outbound schema     | `messageRoutes.ts:92-102`, `desktopIpcTypes.ts:119-139`          |
| Desktop onboarding refresh body re-implementing the provider's                                                                                                                                           | adapter, ~35 lines                                                                  | into `onboardingFunnel`                                     | `desktopOnboardingIpc.ts:80-114`                                 |
| Getting-started rule duplicated inside the desktop                                                                                                                                                       | dual                                                                                | one home                                                    | `desktopShellIpc.ts:227-235`, `desktopAgentExecution.ts:881-889` |
| `desktopProgressIpc` parses twice                                                                                                                                                                        | transport with a redundant parse                                                    | drop the outer parse                                        | `:81,97`                                                         |
| Preload: settings pushes skip validation; validation dev-only                                                                                                                                            | transport hole                                                                      | validate in production                                      | `main/hostBridge.ts:50-62`                                       |
| Open file on desktop drops the line number and bypasses the Monaco pane                                                                                                                                  | defect found in passing                                                             | fix with the collapse                                       | `desktopPreviewHost.ts:61`                                       |
| SDK `packages/agent`: raw event iterable only; no state, applier, or renderer port exported; every consumer re-folds                                                                                     | projector, the fourth renderer path                                                 | export `SessionState` and the renderer seam                 | `src/index.ts:78-150`                                            |
| NDJSON progress subscription: own switch over facts and events to the frozen wire vocabulary                                                                                                             | projector over a frozen public contract                                             | keep the vocabulary; implement it as a renderer-port reader | `sessionProgressSubscription.ts:67-180`                          |
| Trace viewer                                                                                                                                                                                             | reader of the shared renderer; re-derives lifecycle status for archived traces only | adapter, keep                                               | `replayTrace.ts:107-132`                                         |

Genuine transport, named as the standard shape: preload plus main host
bridge (one send channel, one push channel, Zod unions both ways),
`desktopExecutionIpc`, `desktopProgressIpc`, `desktopViewStateIpc`,
`desktopLogIpc`, `desktopPromptController`, `desktopShellIpc`.

## 6a. Superseded by version 2 of the governing proposal

The adversarial pass on 2026-09-03 replaced several verdicts above with
cleaner ones; where this ledger and version 2 disagree, version 2 governs:

- Section 3 "into `ProgressViewCommandHandlers`" rows: the handler itself
  is deleted; the write path is `runtime.request` and `host.request` with
  identity translation.
- Section 5 "one state-patch message per view": no patches; events cross
  the bridge and the one fold runs in the webview.
- Section 6 "desktop settings handlers into `SettingsViewHost`" stands; the
  desktop execution residue rows stand; the cross-paper index is not built.
- Section 8 pins: seven of nine become types or lint.

## 7. Ranked collapse program

Ordered by deleted surface, grouped so each lane is disjoint in files.
Items marked (S) depend on the one-state proposal landing first.

1. **Session read path (S).** `LitSessionRenderer` and its 21 commands, the
   9 slices and `streamStateMerge`, `progressState` re-derivations,
   `streamTree`, `TranscriptIndex`; the TUI's `transcriptFold` driving,
   `streamViews`, `approvalQueue` row mapping, retained-phase filter.
   Several thousand lines across both hosts.
2. **CLI follow-up and resume engine** onto `submitProgressFollowUp` and
   `resumeRun`. About 700 lines. The deferred #6828.
3. **Desktop execution residue and its extension twins** into
   `src/controllers`. About 600 lines.
4. **Desktop tour** deleted or folded as a funnel state. About 500 lines.
5. **CLI approval mappers** onto the controller path. About 400 lines and
   the end of the third `HostInteractions` implementation.
6. **Signal-to-context projection** deleted: eleven contexts, two
   providers, ten consumers, two packers.
7. **Wire vocabulary (S):** 35 value-mover commands replaced by one state
   patch per view; Electron routes and the desktop schema family onto the
   one dispatcher. About 200 lines plus the second dispatcher.
8. **Desktop settings handlers** into `SettingsViewHost`. About 200 lines.
9. **`workflowPlainOutput` (S)** renders `TranscriptView.run`. About 200
   lines and the fourth fold.
10. **UI-state stores** to one `PersistedState` owner per view.
11. **Catalog refresh quadruple, `loadOptions` twice, CLI team plan,
    default agent and model duals.** About 270 lines and one divergent
    invariant.
12. **Bypass mirrors and `StreamState.ui`** out of the shared schema. About
    150 lines and one schema boundary.
13. **Status tone column and one terminal-state vocabulary**, replacing
    eleven mapping sites and three tables.
14. **Resume wrappers, decision mappers, inquiry dismiss, merge config,
    launch parses** into their controllers. About 200 lines total.
15. **Paint residue:** `UserMessage` summary, tool-row predicates,
    `childRowMetadataText`, copy moves, the type-alias file.
16. **SDK exports `SessionState` and the renderer seam** so external
    consumers stop re-folding.

## 8. Pins to add

An invariant that is not enforced is a dual system waiting to happen. Add,
as architecture tests in `src/test-kernel/architecture/` with hardcoded
allowlists like the existing ones:

- Exactly one implementation of `HostInteractions` per host package, and
  none outside `src/controllers` and the CLI's keystroke layer.
- Exactly one `SessionRendererPort` implementation per host, replaced by the
  one-state subscriber when that lands.
- `sessionPresentationBoundary` extended to fail on `followUpText`,
  `recording`, `polishedText`, `transcribedText`, `shouldFocusFollowUp` in
  any shared schema.
- `workflowControlRegistry` and `executions.kill` called only through the
  ownership check.
- No `@lit/context` provider in the webviews once item 6 lands.
- `streamStatusDisplay` is the only file mapping a status key to a tone or
  color word.
- One `MULTI_FILE_LISTS`, one `pickDefaultAgent`, one `decideRunModel`
  caller set.
- Every `runAgent` and `resumeRun` call site passes through
  `validateExecutionRequest`; no raw `AgentConfigSchema.parse` in hosts.

## 9. Verified and not verified

Every file and line above was reported by a read-only audit in this session
and spot-checked against the tree. Not verified: net line counts after each
collapse, and whether `TranscriptIndex` can be deleted without a measurable
render regression. Both are measured, not assumed, when a lane starts.
