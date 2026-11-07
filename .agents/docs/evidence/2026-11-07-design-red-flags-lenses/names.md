# Names (ch. 14): one word for several things, several words for one

Read-only lens audit (`BRIEF.md`, row `names.md`), over the whole repo's
production source (`packages/*/src`). Read on `main` at
`03c2f51d5d480ca199b7192c687595d20aced5d7`. Open pull requests at that commit:
#14797 (CI and three small items), #14796 (package C's 4.3, the document
task's revision record), #14795 (CLI config reads), #14794 (R10, hosts' verbs)
and #14741 (blob links). A finding in a file one of them rewrites names it.

The question for each name: does it say what the thing is, and is it the only
name that thing has? Ousterhout's test (ch. 14) is whether a reader who sees
the name out of context would guess the right thing, and whether a name that
is hard to pick points at something doing two jobs.

Counts are from a scratch scanner (not committed) that lexes each file into
code, comments and string literals, splits identifiers at camelCase and `_`,
and matches whole words. It counts identifier, comment and string occurrences
separately, so a persisted or wire string is never counted as an identifier.

## Numbers

- **Exported declarations:** 4,789 (`export const|function|class|type|interface`
  lines in `packages/*/src`).
- **Names exported from two or more declarations:** 46.
  - 10 are the AGENTS.md `as const` table with its same-named type
    (`WorkspaceStateKey`, `CliExitCode`, …). Fine.
  - 5 are overload sets in one file (`applyRunRow`, `positionRow`, …). Fine.
  - 31 are declared in different files. Of these, 8 are already found:
    `HostFrame`/`HostFrameSchema` (U7(f)), `WorkspaceRoots` (R8's second
    half), `forkRun`/`resumeRun` (G, `G-app-controllers.md:802`),
    `stringField`/`numberField` (U, settled) and llm's `toErrorMessage`
    (storage-errors note). 12 are fine: two different things in different
    domains, or a component named after the data it renders (`PluginCard`,
    `SettingsCatalog`). That leaves **11 new**, all below: `RunPosition`,
    `RunInput`, `Draft`, `EMPTY_DRAFT`, `CallResult`, `PluginRow`,
    `SessionRequests`, `openStore`, and `RunView`, `SessionView` and
    `TranscriptView` twice each.
- **Module basenames that collide (case-insensitive, `index.ts` excluded):**
  49 across the repo. 15 are inside the harness, and 7 of those differ only
  in case (N7).
- **Banned words** (table in N9): `settle` has 398 identifier occurrences,
  58 distinct identifiers and 80 files. `admit` has 89 occurrences (14
  distinct), `arm` 63 (7 distinct, 16 files), and `fold` as a noun or
  "folded" about 40. `tombstone` 9, `park` 9, `seam` 4, `plane` 0
  (20 comments and 3 error messages), `hydration` 0 (6 comments), `ledger`
  0 (1 comment), `spine` 0. `paper` meaning project: 0 identifiers and 12
  comment lines.
- **Vague file names** not in an earlier round: 5 (N10(j)).

## N1. "Settle" names eight different operations across six packages

**Red flags:** a vague name (one word for many things); a name the root
`AGENTS.md` table forbids ("settle, settled, settlement → finish, finished,
result (name which result)").

**Evidence.** Round 1 found three meanings inside the row model
(`C-row-model.md` Q6: a call's result committed, a transcript row printable,
the publisher drained). Across the whole repo the word has 398 identifier
occurrences, 286 in comments and 43 in strings. They make 58 distinct
identifiers in 80 files: harness 46, cli 15, texra 9, desktop 4,
extension 4, llm 2. They mean eight things:

| #   | What "settled" means here                     | Identifiers (refs / files)                                                                                                                                                                                                                                                                                              | Plain name                                       |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | a call's `tool.result` is committed           | `CallStatus` `kind: 'settled'` (`shared/session/inFlight.ts:298`), `callSettlementOf` 7/3 (`:394`), `SettledToolResultSchema` 7/4 (`shared/schemas/toolResult.ts:257`), `SettledAttachmentSchema`, `ScriptSettlement` 6/2 (`agent/codeSandbox/codeSandbox.ts:83`), `settleCards` (`controllers/session/rowReader.ts:8`) | `finished`, `ToolResultRecord`, `resultOf`       |
| 2   | a transcript row is final and may be printed  | `settledRows` 36/10 (`cli/.../panes/transcriptEntries.ts:186`), `isSettledRow` 7/2 (`shared/transcript/transcriptRow.ts:276`), `settlementSeqNo` 7/3 (`:56`), `settledThroughSeqNo`, `advanceSettledRows`, `printableSettledRows`                                                                                       | `finalRows`, `isFinalRow`, `finalSeqNo`          |
| 3   | the session's publisher has drained           | `SessionLogShape.settled`, `settleTo` (`controllers/session/sessionStore.ts:68,144`)                                                                                                                                                                                                                                    | `drained` (C: a barrier)                         |
| 4   | a run ended                                   | `runSettled` 25/3 and `RootRunSettled` (`cli/.../state/sessionRunState.ts:22,34`), `settleExitCode` 8/2 (`:155`), `settleClaimOnExit`, `settleDescriptionOnExit`, `taskSettled`, `runRegistry.ts:127-131` `settled: Deferred`                                                                                           | `rootRunEnded`, `RootRunEnd`, `setExitCodeOnEnd` |
| 5   | a pending call or prompt is answered          | `settleRuntimeResponse`/`settleHostResponse` (`texra/src/ui/progress/sessionSurfaces.ts:437`), `sessionTransport.ts:160,195`, desktop `DesktopSettlePromptMessageSchema` (`desktop/src/shared/desktopPromptMessages.ts:25`) and `settle()` (`renderer/promptOverlay.ts:78`)                                             | `answer`, `AnswerPromptMessage`                  |
| 6   | a value has stopped changing                  | `openAndSettle`/`requestSettled` (`texra/src/tools/lean/direct/leanServer.ts:576,593`), `REFRESH_SETTLE_MS` (`extension/src/frontend/ui/diffView.ts:11`, a `Stream.debounce`), `probeUntilSettled` (`harness/src/tools/toolAvailability.ts:199`)                                                                        | `openAndWaitQuiet`, `REFRESH_DEBOUNCE_MS`        |
| 7   | a run stands at a turn boundary               | `isSettled`, `settledAt` (`agent/runtime/forkRun.ts:62,117`) and `parks`, the position rows it forks at (`:110-132`)                                                                                                                                                                                                    | `atTurnBoundary`, `boundaries`                   |
| 8   | a piece of work finished, with its error kept | `settleCompactionActivities` 5/3 (`shared/runs/compactionActivityProjection.ts:178`), `ModelRetryGate.ts:76` `settle`, `sharedSettingsCommands.ts:366` `settle` (runs a settings program and logs its failure), `execUtils.ts:388` `settled`                                                                            | `finishCompactions`, `runLogged`                 |

**The design decision behind it.** "Settle" came from promises (a promise
settles when it resolves or rejects). Every author who needed "this is over"
reached for it, whatever was over. A reader who greps the word gets 80 files
and eight answers.

**The better design.** Name which result. Meanings 1 to 3 are C's renames and
C's barrier (`Latch`). Meanings 4 to 8 are new, and each takes the plain word
from the table's last column. Strings that keep their spelling: none of the
identifiers is persisted. Three strings are wire or trace names, and they
stay: `desktop:settlePrompt` (an IPC channel, `desktopPromptMessages.ts:5`)
and the `Effect.fn` span names `compaction.settle` and `llm.settleTurn`. The
`'settled'` call-status kind (`inFlight.ts:298`) lives in the in-memory view
and no schema decodes it, so it can become `'finished'`.

**What we give up.** Nothing but the rename churn. 80 files is too many for
one PR: one PR per meaning, each in the package that owns it.

**Change amplification.** "Find where a tool call's result is recorded":
today a grep for `settle` returns 80 files in six packages; after, a grep for
`finished` in `shared/session/` returns the one module.

**Depends on:** none. In-flight: #14796 touches `ConversationPane.tsx`
(`settledRows`), #14741 `rowReader.ts` (`settleCards`), #14794 the CLI's
`sessionProgressSubscription.ts`, and #14797 deletes `allSettledVoid`.

## N2. A durable row is a `SessionEvent` to its type and a row to everyone else; its subsets carry five more names

**Red flags:** two names for one thing; one name ("event") for several
things; a comment substituting for design (the schema module explains in
prose which "arm" is which "event").

**Evidence.**

- The type of one durable row of the session log is `SessionEvent`
  (`shared/schemas/sessionEvent.ts:376`). Its draft before append is
  `SessionEventDraft` (`:384`), and the subset a renderer reads is
  `DisplaySessionEvent` (`:370`). Every module that stores, reads or applies
  these values calls them rows: `rowCodec.ts`, `rowReader.ts`,
  `rowVersions.ts`, `runRows.ts`, `runRowReads.ts`, `runRowsShape.ts`,
  `turnRowHandlers.ts`, `transcriptLogRows.ts`. So do the root `AGENTS.md`
  ("appends rows to the run history") and `packages/harness/AGENTS.md` (16
  "row", 1 `SessionEvent`). The schema module's own prose says "row" 38 times
  and "event" 24 times.
- Parameters of these types are named `row`/`rows` 39 times and
  `event`/`events` 22 times, in 25 files. Examples: `recordFacts(rows, row: SessionEvent)`
  (`shared/session/runRowReads.ts:141`) beside `listingKeyOf(event: SessionEvent)`
  (`shared/schemas/sessionEvent.ts:476`).
- One file holds both words: `TRACE_ROW_TYPES` (`sessionEvent.ts:513`) next
  to `DISPLAY_EVENT_TYPES` (`:515`), and `isDisplaySessionEvent(event: SessionEvent)`
  (`:522`).
- The trace subset of the same rows has four more names:
  - `TranscriptEvent` (`shared/schemas/traceEvent.ts:111`, "Durable
    transcript vocabulary; session events extend each arm");
  - `TraceArm<T>` (`shared/session/agentEvent.ts:31`, a draft minus
    `aggregateId`);
  - `AgentEvent` (`:57`, the public SDK union of those arms plus
    `stream.chunk`);
  - `ResultEvent` (`:42`, the `run.end` row named by its run).
- "Event" also names five things that are not rows:
  - `SessionEvents`, the publisher service
    (`shared/session/sessionEvents.ts:111`), which is not a collection of
    `SessionEvent`;
  - `RuntimePresentationEvent` (18 refs, 7 files);
  - `AppSignalEvent`;
  - `HookEvent`;
  - the webview's `SessionUiEvents` (`texra/src/shared/session/uiEvents.ts`).

Consumers: `SessionEvent` 110 refs/31 files (30 harness, 1 cli),
`SessionEventDraft` 55/19, `DisplaySessionEvent` 29/10 (1 in trace-viewer),
`AgentEvent` 31/10, `TranscriptEvent` 10/4, `TraceArm` 4/2, `ResultEvent` 6/3.

**The design decision behind it.** The schema was named when rows were events
on a bus. The store, its docs and its readers moved to "row"; the type kept
the bus word. Each later subset was then named for the layer that first read
it (trace, transcript, agent, result).

**The better design.** The noun is "row", the one the store and the docs
already use.

| Today                                        | After                                    | Refs / files |
| -------------------------------------------- | ---------------------------------------- | ------------ |
| `SessionEvent`, `SessionEventSchema`         | `SessionRow`, `SessionRowSchema`         | 110 / 31     |
| `SessionEventDraft`                          | `SessionRowDraft`                        | 55 / 19      |
| `DisplaySessionEvent`, `DISPLAY_EVENT_TYPES` | `DisplayRow`, `DISPLAY_ROW_TYPES`        | 29 / 10      |
| `TraceArm`                                   | `TraceRow`                               | 4 / 2        |
| `TranscriptEvent`, `TranscriptEventSchema`   | `TraceRowFields`, `TraceRowFieldsSchema` | 15 / 4       |
| `ResultEvent`                                | `RunEndRow`                              | 6 / 3        |

`AgentEvent` stays as the SDK's name, documented as "the trace rows of one
run". `SessionEvents` keeps its name too: the root `AGENTS.md` lists it as a
documented API. With the row type renamed, the publisher is the one thing in
`shared/session/` called an event.

**What we give up.** `SessionEvent`, `SessionEventDraft` and
`DisplaySessionEvent` are exported from `@texra-ai/harness/schemas`, so the
rename is a breaking type change for an embedder. The package is 0.x, and
`npm run docgen` regenerates the API reports. No stored or wire string
changes: the `type` literals stay.

**Change amplification.** "A new display row kind": today the author reads
`DisplaySessionEvent`, `TRACE_ROW_TYPES`, `DISPLAY_EVENT_TYPES` and
`TranscriptEvent` to learn which list it joins; after, `DisplayRow` and the
two `*_ROW_TYPES` lists name one concept.

**Depends on:** none. #14741 touches `rowCodec.ts` and `rowReader.ts`; land
after it.

## N3. Where a run stands: `RunPosition` names two types, "phase" names three things, and the CLI keeps the pre-R6 reading

**Red flags:** one name for two things; two names for one thing; a leftover
of a landed rename (R6, #14789); information leakage (a host restates the
harness's reading).

**Evidence.**

- `RunPosition` is the public three-value literal on the view, `'ready' | 'running' | 'waiting'`
  (`shared/schemas/run.ts:21-31`, read by `RunView.position`,
  `sessionView.ts:99`). `RunPosition` is also a five-field struct of what
  the lifecycle rows say, `{ family, at, outcome, turn, requests }`
  (`shared/session/runRowsShape.ts:29-42`).
  - Two sibling files import the literal: `runRowReads.ts:13-18` and
    `sessionView.ts`.
  - Three import the struct: `runRows.ts:25`, `runState.ts:49` and
    `inFlight.ts:21`.
  - `RunState = RunPosition & …` (`runState.ts:98`) is the struct.
    `PhaseMove.position: RunPosition` (`runRowReads.ts:240-243`) is the
    literal.
- "Phase" names three things:
  1. The loop's five-value phase, `RunLoopPhase` (`shared/runs/runStatus.ts:31-36`,
     `RunState.phase`, `runState.ts:105`).
  2. A position-and-outcome pair: `PhaseMove`, `phaseMoveOf` (13 refs,
     4 files), `movePhase` (`sessionViewUpdate.ts:757`), `moveBoundary`
     (`transcriptUpdate.ts:292`), and the error
     `` `${row.type} moves no run phase` `` (`sessionViewUpdate.ts:751`).
  3. A script's named section (`ScriptCallCard.phase`,
     `agent/runtime/scriptRun.ts:37`).
- R6 (#14789) replaced the view's `status` with `position`, `outcome` and
  `holder`. The CLI kept the old collapsed value as its own type:
  `RunPhase = RunOutcome | 'running' | 'waiting'` and `runPhaseOf`
  (`cli/src/chat/tui/state/sessionView.ts:117-124`; 9 refs in 5 files, 5
  refs in 3 files). It stores that value in a field named `status`
  (`sessionRunState.ts:69,197,252`). The progress renderer restates it
  inline as `paintedPhase: RunPosition | RunOutcome`
  (`cli/src/runtime/runProgressRenderer.ts:97`). The app's copy reads the
  same order a third time, "outcome, else position", in `statusKey`
  (`texra/src/ui/copy/runStatus.ts:125-131`). Two comments build on the
  CLI's word: "a task group's status is a RunPhase"
  (`WorkflowRunDetails.tsx:70`, `transcriptEntryLayout.ts:123`).
- `shared/runs/runStatus.ts` holds `outcomeFromCause` and `RunLoopPhase`
  and declares no `RunStatus`. The `RunStatus` type lives in the app
  (`ui/copy/runStatus.ts:95`).

**The design decision behind it.** R6 decided the facts (position, outcome,
holder) but did not rename the code that writes and reads them, so the old
vocabulary lives on around the new fields.

**The better design.** "Position" means only the view's literal, and "phase"
means only the loop's.

| Today                                                            | After                                                                | Refs / files                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `RunPosition` struct in `runRowsShape.ts`                        | `RunRowState` (`SharedRunRows = RunRowState & PendingFollowUps`, N6) | 4 files                      |
| `PhaseMove`                                                      | `RunStanding = { position, outcome }`                                | 7 / 3                        |
| `phaseMoveOf`                                                    | `standingAfter(row)`                                                 | 13 / 4                       |
| `movePhase`                                                      | `applyStanding`                                                      | 4 / 1                        |
| `moveBoundary`                                                   | `applyStandingToTranscript`                                          | 2 / 1                        |
| CLI `RunPhase`, `runPhaseOf`, `paintedPhase`, the `status` field | read `RunStanding` from `@texra-ai/harness/schemas`                  | 3 CLI files                  |
| `ScriptCallCard.phase`                                           | `section`                                                            | 1 file + the executions tool |
| `shared/runs/runStatus.ts`                                       | `runEnd.ts`, or split beside `run.ts` and `runState.ts`              | 3 importers                  |

`RunStanding` and `standingAfter` are exported from `/schemas` beside
`RunPositionSchema`. The CLI and `statusKey` then read the pair the harness
wrote, not a collapsed copy.

**What we give up.** Nothing a user sees. Renaming `ScriptCallCard.phase`
changes a model-facing key in the executions tool's output, so the prompt
text that names it changes with it.

**Change amplification.** "A fourth position (say `paused`)": today the
schema literal, the CLI's `RunPhase` (it compiles, then is missing from the
CLI's `status`), `paintedPhase` and `statusKey`, 4 files in 3 packages;
after, the literal and `statusKey`, where the exhaustive copy table fails to
compile.

**Depends on:** none (R6 has landed). The CLI's files are package D's.

## N4. The run-kind words cross: "task" and "workflow" each name three things, and a document task, a script and a stage each have a second name

**Red flags:** one name for several things; two names for one thing; a
comment substituting for design (a doc comment that translates its own type
name).

**Evidence.**

- **"Task" names three things:**
  1. A root run, as the user sees it. The service RPCs `task.start`,
     `task.resume`, `task.watch`, `task.request` and `task.result`
     (`texra/src/controllers/server/protocol.ts:186-226`), `TaskSummary`,
     `TaskFailed`, `TaskRecordsFailed`, `TaskAdmitted` (`:130-157`),
     `texra tasks`, and the copy "Approve all … in this task"
     (`ui/copy/delegationApproval.ts:26-28`).
  2. A document task, an agent kind (`DocumentTask*` 70 and
     `documentTask*` 67 occurrences, identifiers and comments, in 37 files; `isTaskConfig`,
     `shared/schemas/runRecords.ts:30`).
  3. A stage inside one run, `TaskGroup` (`shared/schemas/taskGroup.ts:7-17`;
     `TaskGroup*`/`taskGroup*` 77 occurrences in 16 files). A
     `TaskGroupList` (`ui/progress/components/TaskGroupList.ts:160`) is not
     a list of tasks.
- **A stage has two names.** The rows are `stage.start`/`stage.end`
  (`rowVersions.ts:222-223`). The trace handle is `StageHandle`
  (`agent/trace/AgentTrace.ts:29`) and the kind is `StageKindSchema`
  (`taskGroup.ts:5`). The view built from them is a `TaskGroup` in
  `TranscriptView.taskGroups` (`shared/session/sessionView.ts:63`), with
  `parentGroupId` and the `lifecycleToTaskGroups` switch
  (`transcriptState.ts:48`).
- **"Workflow" names two things, and a plugin:**
  1. In the harness, the script engine. Its rows are `workflow.journal`,
     `workflow.call` and `workflow.attempt` (`rowVersions.ts:84-87`, "the
     workflow engine's journal"). Its prose says "workflow delivery" for a
     script's delivery (`shared/subagentFollowup.ts:134,155`,
     `progressView/data.ts:27`, `transcriptRow.ts:95`), and it has
     `formatWorkflowCallFiles` and `TALLY_OUTCOMES`
     (`shared/transcript/workflowCall.ts`). Everything else about it is
     called "script": `scriptRun.ts`, `ScriptTool`, `scriptStage.ts`,
     `ScriptTally`, `scriptDelivery.ts`.
  2. In the app and the CLI, the document task:
     - `WORKFLOW_OUTPUT_BASENAME`, `stripWorkflowRoundDir` (12 refs),
       `workflowOutputRoundDir` (10) in `texra/src/shared/constants/workflowOutput.ts`;
     - `finalWorkflowOutput` inside `shared/plugins/documentOutputs.ts:141`,
       the module of "the documents plugin's output vocabulary";
     - `ProgressWorkflowFileActionsController`;
     - the CLI's `executeCliWorkflowConfig` (`cli/src/commands/workflow.ts:326`,
       the file of `texra run`), `WorkflowRunDetails`,
       `WorkflowInputExpansionOptions`, `resumeWorkflowOutputFile`.

     The CLI's `CliWorkflowRunResultSchema` has the doc comment "A document
     task's result" (`cli/src/schemas/cliOutput.ts:85-90`).

  The harness also uses the word for the document task's inputs
  (`assertWorkflowFilesExist`, `agent/runtime/delegation/inputFields.ts:194-204`),
  and for a third thing, the memory-and-executions plugin `memoryWorkflow`
  (`tools/builtinPlugins.ts:75`; its id `memory-workflow` is a config string
  and stays). In all, "workflow" has 442 occurrences, identifiers and
  comments, in 93 files (cli 23, harness 24, texra 41, extension 3,
  desktop 2).

- **The document task has a third name, "recipe"**, for the program that
  runs it: `recipeBlockOf` (`runRecords.ts:36`), `script.kind === 'recipe'`,
  `documentRecipe.ts`. The recipe is a separate thing (the plugin's
  program), so it keeps its name.

**The design decision behind it.** The document task was once called a
workflow. The script engine took the same word for its rows. "Task" was the
user's word for a run, and it was then reused for the stage view.

**The better design.** Each word gets one meaning:

- **task**: the user's word for a root run, in copy and the service RPCs (a
  wire, so unchanged). Code says "run".
- **document task**: the agent kind. The app's and CLI's `workflow*`
  identifiers that mean it become `documentTask*` or `documentOutput*`:
  `stripWorkflowRoundDir` → `stripRoundDir`, `executeCliWorkflowConfig` →
  `executeCliRun`, `commands/workflow.ts` → `commands/run.ts`.
- **script**: the harness's `workflow*` identifiers and prose, for example
  `workflowCall.ts` → `scriptCall.ts` and `formatWorkflowCallFiles` →
  `formatScriptCallFiles`. The persisted row types `workflow.*` keep their
  spelling.
- **stage**: `TaskGroup` → `Stage`, `TaskGroupStatus` → `StageStatus`,
  `taskGroups` → `stages`, `TaskGroupList` → `StageList`,
  `lifecycleToTaskGroups` → `lifecycleStages`.

Renamed: about 77 `TaskGroup` occurrences, the app's and CLI's ~390
`workflow` occurrences that mean the document task, and the harness's ~40
that mean the script. `memoryWorkflow` (5 refs, an SDK export from
`./plugins`) is named for what it offers, memory and past runs; its id
`memory-workflow` stays.

**What we give up.** `TranscriptView.taskGroups` is on the view the service
protocol and the webviews carry, so `stages` is a view-shape change: both
ends ship together and nothing stores it. The `task-group-list` custom
element is renamed. "Stage" already has a second sense in "staged" (a staged
write, `StagedPreview`, `stagedPresentations`); the noun and the participle
read apart.

**Change amplification.** "A user asks what a 'task group' is": today the
answer spans `stage.*` rows, `StageHandle`, `TaskGroupSchema` and
`TaskGroupList`, four words for one structure; after, one word.

**Depends on:** #14796 (package C) rewrites `workflowOutput.ts`,
`documentOutputs.ts`, `ProgressWorkflowFileActionsController.ts`,
`WorkflowRunDetails.tsx` and `WorkflowRunContent.ts`, and #14794
`ProgressWorkflowFileActionsController.ts` too. The document-task half goes
after both. The stage and script halves can go now.

## N5. A pending request a person answers has four names: request, permission, prompt, approval

**Red flags:** two (four) names for one thing; a vague name (`permission`
for a request that is a question or a retry).

**Evidence.**

- **Request.** The rows are `request.opened`/`request.decided`, persisted.
  The view has `PendingRequest` (24 refs/10 files), `RequestDecision`
  (52/18) and `RequestState`. The web cards are `BashRequestPanel`,
  `ToolEditRequestPanel`, `RetryRequestPanel`, `ProposalRequestPanel` and
  `PlanApprovalRequestPanel` (`texra/src/ui/progress/components/`).
- **Permission.** The payload of `request.opened` is `PermissionPayload`
  (`shared/schemas/request.ts:131-134`; 52 refs/14 files). Its six cases are
  `*PermissionSchema`, under "Common permission request fields"
  (`shared/schemas/prompts.ts:14-19`): `BashPermission`,
  `ToolEditPermission`, `RetryPermission`, `AgentProposalPermission` (26),
  `PlanApprovalPermission` and `UserQuestionPermission` (13). A retry or a
  question asks no permission. Variables are named `permission` 108 times,
  and the kind type is `ProgressPermissionKind`.
- **Prompt.** The cases live in `prompts.ts`, beside `UserQuestionPrompt`.
- **Approval.** The CLI re-types the payload as `ApprovalPayload`
  (`cli/src/chat/tui/state/approvalQueue.ts:62`) and its kinds as
  `PendingApprovalKind` (`:53`, 16 refs). Its modals are `BashApproval.tsx`,
  `EditApproval.tsx` and `PlanApproval.tsx`, next to `RetryRequest.tsx`,
  `UserQuestion.tsx` and `AgentProposal.tsx` in the same directory. One
  request kind has three names across the hosts: `toolEdit` (wire),
  `ToolEditRequestPanel` (web) and `EditApproval` (CLI). "Approval" also
  names the policy (`ApprovalPolicy`, 46) and the run grants, which are a
  different thing.
- **"Request" also means a host's command into the runtime:**
  `RuntimeRequest` (62 refs/24 files, `shared/session/runtimeRequest.ts:166`)
  and `HostRequest` (57/21). So "a `request.decide` request" exists
  (`runtimeRequest.ts:127`). The harness's own prose already calls it "a
  `request.decide` command a surface sends"
  (`agent/runtime/HostInteractions.ts:38`).

**The design decision behind it.** Each layer named the record for the case
it was written for. The first request was a bash permission, the CLI's first
modal an approval, and the web's a request panel. Retries and questions were
then added under the first word.

**The better design.** The person's request keeps "request", which its rows
already use. "Approval" keeps one meaning, the policy and grants.

| Today                                                     | After                                                                | Refs / files  |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ------------- |
| `PermissionPayload(Schema)`                               | `RequestPayload(Schema)`                                             | 61 / 14       |
| `*Permission`, `*PermissionSchema` (6 cases + base)       | `BashRequest`, `ToolEditRequest`, `RetryRequest`, …                  | ~80 / ~20     |
| `prompts.ts`                                              | `requestPayloads.ts`                                                 | its importers |
| `ProgressPermissionKind`, CLI `PendingApprovalKind`       | `RequestKind`, `PendingRequestKind`                                  | 20 / ~8       |
| CLI `ApprovalPayload`                                     | `TuiRequest`                                                         | 13 / 3        |
| CLI modals `BashApproval`, `EditApproval`, `PlanApproval` | `BashRequest`, `ToolEditRequest`, `PlanRequest`, like the web panels | 3 files       |

Optionally, `RuntimeRequest` and `HostRequest` become `RuntimeCommand` and
`HostCommand`, the word the docs already use. The documented method
`session.request` keeps its name.

Persisted and wire strings that keep their spelling: the `request.*` row
types, the payload `kind` values and the `data` and `allowBypass` keys.

**What we give up.** Type churn across 3 packages. The SDK exports
`PermissionPayload` from `/schemas` (0.x).

**Change amplification.** "A seventh request kind (a web-fetch approval)":
today its author names a `*PermissionSchema` in `prompts.ts`, a
`*RequestPanel` on the web and a `*Approval` modal in the CLI, three words to
choose from. After, one: `WebFetchRequest` everywhere.

**Depends on:** U1 (package R3-A) rewrites `allowBypass` and
`surfaceDecision.ts`, and owns the CLI modals. Rename in R3-A's PR, or after
it.

## N6. `RunInput` is a recorded struct and a follow-up reader; "input" means two facts in one directory; `runInput.ts` holds six things

**Red flags:** a name that is hard to pick because the thing does two jobs
(the file); one name for two things (the type); a conjoined file.

**Evidence.**

- `RunInput` (`shared/schemas/runInput.ts:135-154`) is what a run's turns
  answer besides their messages: the address of its system text, its
  instruction, its activated skills and its memory misses. It is recorded on
  the row field `input` (`runHistoryEvent.ts:228,309`, persisted) and kept
  as `RunState.input` (`runState.ts:401`). Consumers: `runFacts.ts`,
  `loop/rows.ts` and `runHistoryEvent.ts`.
- `RunInput` is also a class (`agent/followUp/RunInput.ts:100`), "one
  generation's reader over the run's pending rows": its follow-ups, a
  `Latch`, an `ended` flag. Consumers: `Inbox.ts:27,98,128-150`, and
  `FollowUps.input: Pick<RunInput, …>` (`agent/runtime/FollowUps.ts:81`).
- In `shared/session/`, "input" means the pending follow-ups too:
  `PendingInput` (`runRowsShape.ts:51`, "the input these rows say a run has
  not taken": `followUps` and `taken`). `runState.ts` has both senses 230
  lines apart: "A run's input is not among them: the inbox reads it" (`:168`)
  and `withInput(state.input, p.input)` (`:401`).
- `shared/schemas/runInput.ts` holds:
  - usage normalization (`NormalizedUsageSchema`, `addTurnUsage`,
    `:28-46`; P6's false comment);
  - `AttachedMemoryMiss` (`:80`);
  - `SkillCatalogEntry` (`:87`);
  - the provider list `MODEL_PROVIDERS` (`:101`, O's §6);
  - `ModelBackendSchema` (`:120`);
  - `RunInputSchema` and `RunBindingSchema` (`:135-168`).

  Its header names three of these.

**The design decision behind it.** "Input" was the word for whatever enters
a run: what the person sends next, and what the launch configured. The two
were never told apart.

**The better design.**

- The persisted field keeps "input", so the schema keeps `RunInput`.
- The class becomes `FollowUpReader` (`agent/followUp/followUpReader.ts`;
  2 consumers).
- `FollowUps.input` becomes `FollowUps.reader`.
- `PendingInput` becomes `PendingFollowUps` (2 refs).
- `runInput.ts` keeps `RunInput`, `RunBinding` and `AttachedMemoryMiss`.
  The usage half moves to `usage.ts`, which already exists beside it, and
  `MODEL_PROVIDERS`/`ModelBackendSchema` move to the model module O §6
  names.

**What we give up.** Nothing; no stored string changes.

**Change amplification.** "Add a field the launch records (say the agent's
working directory)": today the author reads two `RunInput`s and a
`PendingInput` to learn which one it is; after, one.

**Depends on:** `addTurnUsage`'s comment is P6 (package R3-E); move the
usage half in that PR.

## N7. Contract and implementation share a basename: twelve module pairs, seven differing only in case

**Red flags:** one name for two things (the module); a shallow module (a
7-line file that names one type).

**Evidence.** Inside the harness, the browser-safe contract and its Node
implementation take the same file name:

| Contract (exports)                                                        | Implementation (exports)                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `shared/session/database.ts` (`Database` tag, errors, `ProjectDatabases`) | `controllers/session/Database.ts` (`databaseLayer`, `globalDatabaseLayer`)                                  |
| `shared/session/sessionEvents.ts` (`SessionEvents` tag)                   | `agent/runtime/SessionEvents.ts` (`sessionEventsLayer`)                                                     |
| `shared/session/sessionView.ts` (schema, readers)                         | `controllers/session/SessionView.ts` (`SessionViewService`, `RemoteSessionView`)                            |
| `shared/session/runHistory.ts` (`RunHistoryRefused`, `runRefusal`)        | `agent/runtime/RunHistory.ts` (`makeRunHistory`)                                                            |
| `shared/session/sessionInputs.ts` (a 21-line tag)                         | `controllers/session/sessionInputs.ts` (`sessionInputsLayer`), same case                                    |
| `shared/schemas/runInput.ts`                                              | `agent/followUp/RunInput.ts`: a different thing (N6)                                                        |
| `shared/schemas/agentConfig.ts` (`AgentConfigSchema`)                     | `agent/core/definition/AgentConfig.ts`: 7 lines naming `AgentConfig` and `AgentConfigPayload`, 17 importers |
| `platform/workspaceRoots.ts`                                              | `controllers/session/WorkspaceRoots.ts`: a different thing (R8's second half)                               |

Same-case pairs:

- `shared/schemas/runRecords.ts` / `agent/storage/runRecords.ts`;
- `shared/schemas/storedTurn.ts` / `agent/runtime/storedTurn.ts`;
- `shared/toolUse.ts` (tool-use log normalization) /
  `agent/runtime/loop/toolUse.ts` (the run loop);
- across packages, `shared/model/subscriptionAuth.ts` in both the harness
  and texra.

An import `from './sessionEvents'` and one `from '@agent/runtime/SessionEvents'`
name different modules. On a case-insensitive file system, an editor's
quick-open shows two `Database.ts`.

**The design decision behind it.** The tag-and-layer split (the contract
browser-safe, the layer Node) was made per module, and the second file was
named after the first.

**The better design.** Name each implementation file for what it exports:
`databaseLayer.ts`, `sessionEventsLayer.ts`, `sessionViewService.ts`,
`makeRunHistory.ts`, `sessionInputsLayer.ts`, `storedTurnDraft.ts` (or
whatever the runtime half does), and `loop/runLoop.ts`. `AgentConfig.ts`
goes: `shared/schemas/agentConfig.ts` exports `AgentConfig` and
`AgentConfigPayload` (17 importers change one path). The texra
`shared/model/subscriptionAuth.ts` becomes `subscriptionAuthStatus.ts`,
which is what it holds.

**What we give up.** Import-path churn (each file has 1 to 17 importers).
The harness's `dist/` paths are not a public surface (the entries are).

**Change amplification.** "Open the module that writes rows": today two
`SessionEvents.ts` and two `Database.ts`; after, one of each.

**Depends on:** #14741 rewrites `controllers/session/Database.ts`; rename it
after. `loop/toolUse.ts` is named in the root `AGENTS.md` ("A run is one
Effect program (`runtime/loop/toolUse.ts`)"), which changes in the same PR
(`npm run check:guidance-refs`).

## N8. The project folder is spelled five ways, and `projectFolder` names a folder inside it

**Red flags:** two (five) names for one thing; a misleading name; the
**project**/**paper** terminology rule.

**Evidence.**

- One string, the project's absolute folder, has five spellings:
  - `roots.workspace` (95 refs/57 files; `WorkspaceRoots.workspace`,
    `platform/workspaceRoots.ts:17-19`);
  - `workspaceRoot` (162 refs/42 files: texra 24, harness 10, extension 5,
    cli 2, desktop 1);
  - `workspacePath` (137 refs/31 files: texra 9, harness 8, desktop 6,
    extension 5, cli 3);
  - `workspaceDir` (the SDK option, `platform/defaults/sdkPlatform.ts:28`,
    `node.ts:12`);
  - the desktop's `project.root` (16), passed on as
    `workspacePath: project.root` (`desktop/src/main/desktopProjectBindings.ts:223`).
- `projectFolder` is not the project's folder. It is the name of the folder
  TeXRA keeps inside each project, `.texra`
  (`harness/src/skills/skillSources.ts:28-33`, set from
  `TEXRA_STORAGE_DIR_NAME` at `texra/src/controllers/texraProcessLayer.ts:109`).
- "Paper" for the project: 12 comment lines, no identifiers:
  - desktop: `desktopFileSelection.ts:19,27,40` ("The paper's folder"),
    `desktopPreviewHost.ts:66,68`, `desktopWorkspaceMessages.ts:10` and
    `desktopWindowLifecycle.ts:56`;
  - harness: `agent/runtime/SessionHandle.ts:31` and
    `agent/index/agentCatalog.ts:67`;
  - texra: `ui/progress/sessionSurfaces.ts:7` and
    `progressAppStyles.ts:198`;
  - trace-viewer: `traceFrames.ts:52`.

  Every `paper` identifier (arXiv, Zotero, `paperDirFull` in
  `arxivProcessor.ts`) means a real paper and is right.

**The design decision behind it.** VS Code says "workspace folder", the
desktop says "project", the SDK says "directory". Each host's word came in
with that host's code.

**The better design.**

- One parameter spelling for the string, `workspaceRoot`, the most common
  and the one `WorkspaceRoots` already implies. `workspacePath` and the
  internal `workspaceDir` uses go. The SDK option keeps `workspaceDir`, a
  public option beside `storageDir` and `agentsDir`.
- `projectFolder` → `projectDataDirName`.
- The 12 comments say "project".
- Whether "workspace" itself becomes "project" in identifiers is the 1.0
  terminology rule's call, at the next revision of `WorkspaceRoots`
  (218 refs).

**What we give up.** Churn in 31 files for `workspacePath`.

**Change amplification.** "Grep where the project folder reaches a tool":
today four greps; after, two (`workspaceRoot`, `roots.workspace`).

**Depends on:** R8's second half reshapes `WorkspaceRoots` (the tag). Spell
the parameters after it.

## N9. Banned words, counted

**Red flags:** names the root `AGENTS.md` "Plain names and comments" table
forbids.

Identifier, comment and string occurrences per package. Strings are counted
apart, and the persisted and wire ones among them keep their spelling. "ext"
is extension, "dsk" desktop.

| Word (forms)                               | Ctx     | Total | cli | dsk | ext | harness | llm | texra | Distinct identifiers / notes                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------- | ----- | --- | --- | --- | ------- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| settle (settled, settlement, unsettled, …) | ident   | 398   | 87  | 22  | 11  | 237     | 4   | 37    | 58 distinct, 80 files: N1                                                                                                                                                                                                                                                                                                                                                                                                |
|                                            | comment | 286   | 40  | 22  | 23  | 187     | 1   | 13    |                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                                            | string  | 43    | 3   | 1   | 1   | 33      | 2   | 3     | keep: `desktop:settlePrompt` (IPC), span names                                                                                                                                                                                                                                                                                                                                                                           |
| admit (admitted, admission, …)             | ident   | 89    | 0   | 1   | 2   | 56      | 5   | 25    | 14 distinct, 20 files. Meanings: validate (`admitLaunch`, `desktopHostRequests.ts:139`; `admitInput`, `admitTools`, `effect/sessionPrograms.ts:76,97`), a schema accepts null (`admitsNull`, `agent/core/tools/toolSchema.ts:55`), a route accepted (`admitSwitch`, `modelAccess/ModelAccess.ts:213`), started (`TaskAdmitted`, `protocol.ts:138`), the current lifetime (`deleteAdmittedRun`, `deletionCleanup.ts:231`) |
|                                            | comment | 125   | 4   | 0   | 1   | 81      | 6   | 33    |                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                                            | string  | 12    | 0   | 0   | 1   | 8       | 2   | 1     | keep: `RunAdmissionClosed` (`_tag`, `runRegistry.ts:60`)                                                                                                                                                                                                                                                                                                                                                                 |
| arm (arms)                                 | ident   | 63    | 16  | 2   | 2   | 9       | 0   | 34    | 7 distinct, 16 files: see below                                                                                                                                                                                                                                                                                                                                                                                          |
|                                            | comment | 116   | 11  | 11  | 10  | 55      | 0   | 29    |                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                                            | string  | 20    | 2   | 0   | 0   | 3       | 0   | 15    | 13 are `arm64` (legitimate)                                                                                                                                                                                                                                                                                                                                                                                              |
| fold (as a noun), folded                   | ident   | 58    | 1   | 1   | 0   | 42      | 11  | 3     | 12 legitimate: case folding (`foldCase`, `envFlags.ts:82`, `nodeWorkspace.ts:77`), editor folding, Effect's `Stream.runFold`. 6 verbs (`foldRunRows`, `foldSkillSources`). About 40 banned: llm `type Folded` (`api/assembleTurn.ts:53`, 10), `folded` (`agent/storage/runRecords.ts:199`, 9), `foldedRead`/`foldedEnded`/`foldedLevel` (`sessionStore.ts`), `FoldedToolRow` (`scriptStage.ts:35`)                       |
|                                            | comment | 201   | 8   | 1   | 0   | 175     | 0   | 17    | "folded" 48; noun phrases ("the fold", "a fold", "the transcript fold", "fold's") about 120                                                                                                                                                                                                                                                                                                                              |
| tombstone (tombstones, tombstoned)         | ident   | 9     | 0   | 0   | 0   | 9       | 0   | 0     | `collect(tombstone, …)` over the `run.removed` row (`shared/session/database.ts:281`, `controllers/session/Database.ts:730-858`) → `removal`                                                                                                                                                                                                                                                                             |
|                                            | comment | 3     |     |     |     | 3       |     |       |                                                                                                                                                                                                                                                                                                                                                                                                                          |
| park (parks, parked)                       | ident   | 9     | 0   | 0   | 0   | 9       | 0   | 0     | all in `agent/runtime/forkRun.ts:110-132` (the turn boundaries a fork may cut at) → `boundaries`                                                                                                                                                                                                                                                                                                                         |
|                                            | comment | 22    | 5   | 0   | 0   | 16      | 0   | 1     |                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                                            | string  | 4     | 3   |     |     | 1       |     |       | keep: `child.park` (a persisted row type, `rowVersions.ts:80`); 3 in `cli/runtime/validationModel.ts`, test-fixture scripts                                                                                                                                                                                                                                                                                              |
| seam (seams)                               | ident   | 4     | 4   |     |     |         |     |       | `seamRows` (`cli/.../staticTranscriptRing.ts:212,292-294`) → `boundaryRows`; 7 comments in the same file                                                                                                                                                                                                                                                                                                                 |
| plane (planes)                             | comment | 21    | 1   | 1   | 1   | 15      | 0   | 1     | 1 legitimate ("astral-plane", `replacement/advanced.ts:299`). 2 in trace-viewer                                                                                                                                                                                                                                                                                                                                          |
|                                            | string  | 3     |     |     |     | 3       |     |       | user-visible error messages "the plane has closed" (`agent/runtime/SessionEvents.ts:71,250,282`) → "the session's event channel has closed"                                                                                                                                                                                                                                                                              |
| hydration (rehydrate, hydrated, …)         | comment | 6     | 6   |     |     |         |     |       | `chatSessionController.ts:170,662`, `runChatTui.tsx:710`, `sessionExitController.ts:181`, `state/transcript.ts:35`, `scriptPlainOutput.ts:99` → "initial load"                                                                                                                                                                                                                                                           |
| ledger                                     | comment | 1     | 1   |     |     |         |     |       | `cli/src/runtime/cliProcessRuntime.ts:22`                                                                                                                                                                                                                                                                                                                                                                                |
| spine                                      | —       | 0     |     |     |     |         |     |       |                                                                                                                                                                                                                                                                                                                                                                                                                          |
| move (noun)                                | ident   | 26    |     |     |     | 26      |     |       | `PhaseMove`, `phaseMoveOf`, `movePhase`, `moveBoundary`: N3. (The scanner's 96 `move` identifiers are mostly the verb: cursor and file moves.)                                                                                                                                                                                                                                                                           |
| refusal (our own rejection)                | ident   | 576   | 78  | 15  | 10  | 360     | 21  | 92    | Not counted as a finding. 9 are `TaggedError` `_tag`s, which keep their spelling (`ResumeRefused`, `ToolsRefused`, `PluginsRefused`, `RunHistoryRefused`, `HistoryQueryRefused`, …). llm's are a model refusing, which is right. The rest need a read per site to tell "rejection" from a person's or a model's refusal                                                                                                  |
| paper (meaning project)                    | comment | 12    |     | 7   |     | 2       |     | 2     | N8, plus 1 in trace-viewer. 0 identifiers                                                                                                                                                                                                                                                                                                                                                                                |

**New since round 1: `arm` is now in identifiers.** `C-row-model.md` Q6
counted fold, arm, plane and tombstone in comments only, "none in an
identifier", for the row model. Across the repo, 63 identifier occurrences
in 16 files and 5 packages name an `arm`. Each one is a request to send or a
table of handlers:

| Identifier                                  | Where                                                                                                                             | Refs | Plain name                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------ |
| `RunMenuAction.arm`                         | `texra/src/ui/progress/constants.ts:19-122` (9 rows), read at `RunHeader.ts:255-262`                                              | ~13  | `sends`                              |
| `approvalDecisionArm`, `ApprovalArm`        | `texra/src/shared/session/surfaceDecision.ts:112,131`; `BaseRequestPanel.ts:190`; CLI `approvalQueue.ts:360`, `TasksForm.tsx:253` | 10   | `decisionRequest`, `DecisionRequest` |
| `OwnHostArms`                               | `texra/src/controllers/session/openGuiWindow.ts:141,230`; `extensionHostRequests.ts:91,447`; `desktopHostRequests.ts:35,192`      | 6    | `OwnHostHandlers`                    |
| `emitRuntimeArm`                            | `BaseRequestPanel.ts:192,200`; `ToolEditRequestPanel.ts:56,71`                                                                    | 4    | `emitRuntimeRequest`                 |
| `TraceArm`                                  | `harness/src/shared/session/agentEvent.ts:31-57`; `host.ts:126`                                                                   | 4    | `TraceRow` (N2)                      |
| `SettingsArms`                              | `texra/src/controllers/settingsView/sharedSettingsCommands.ts:81,362,406`                                                         | 3    | `SettingsHandlers`                   |
| `fact(runId, arm)`, `displayUnion(…, arm?)` | `agent/runtime/ToolServices.ts:103,192-197`; `controllers/session/Database.ts:168-173`                                            | ~10  | `fact(runId, kind)`, `extraSelect`   |

**What we give up.** Nothing. **Depends on:** #14794 rewrites
`openGuiWindow.ts`, `extensionHostRequests.ts` and `desktopHostRequests.ts`
(`OwnHostArms`, `admitLaunch`). `surfaceDecision.ts` is R3-A's (U1). Rename
in those PRs. The comment words are a wording pass in whichever PR touches
each file.

## N10. Smaller items, batched

- **(a) `ScriptCallStatus` is declared twice, with two vocabularies for one
  fact.** The fact is what became of a call a script issued.
  - `agent/runtime/scriptRun.ts:27-32` has four values (`completed`,
    `failed`, `skipped`, `unsettled`), read by the executions tool's
    `scriptCallsView` (`tools/executions/scriptCallsView.ts:24-28`), which
    maps `unsettled` to `running` or `interrupted`.
  - `shared/transcript/scriptStage.ts:47-56` has nine values, read by
    `ui/copy/scriptStage.ts:31` and exported from `transcriptEntry.ts:137`.

  The model is told a call "completed" where the user sees "finished", and
  a cut agent call is "cancelled" or "not run" only in the UI. One reading
  in `shared/transcript/` should serve both, with the model view mapping
  from it. Consumers: 3 and 4 files.

- **(b) `CallResult` names a tool call's result and a model call's.**
  `shared/session/inFlight.ts:287` is the `tool.result` row's fields;
  `agent/runtime/run/modelCall.ts:32` is a model turn and its priced usage.
  → `ToolCallResult` and `ModelCallResult`.
- **(c) `PluginRow` names a stored row and a settings-page row.**
  `harness/src/tools/plugins.ts:54` is one stored row of a plugin's fact
  kind; `texra/src/shared/settingsView/settingsViewMessages.ts:336` is a row
  of the Plugins page. → `PluginFactRow` and `PluginsPageRow`.
- **(d) `openStore` opens a SQLite store and spawns a process.**
  `controllers/session/storeSchema.ts:349` opens the store;
  `agent/runtime/historyQuery/childSource.ts:187` starts the history-query
  child process. → `spawnQueryStore` for the second.
- **(e) `SessionRequests` names the session's request handler and an answer
  target.** The harness class (`agent/runtime/requests.ts`, 34 refs/16
  files) handles requests; the CLI's `Pick<Session, 'request'>`
  (`approvalQueue.ts:77`) is where an answer is sent. → the CLI's becomes
  `DecisionTarget`.
- **(f) `RunLabels` is a map and a boolean.**
  - `shared/tools/executionsDisplay.ts:13` is a map from run id to label.
  - `agent/runtime/sessionDescription.ts:87` is a
    `Context.Reference<boolean>`: whether the session asks the helper model
    to label its root runs (read at `executeAgent.ts:343`, provided at
    `effect/processLayer.ts:186`).

  A boolean named like a collection: → `LabelsRootRuns`.

- **(g) `Draft` has four senses, and three exported types use the name:**
  1. A composer's unsent message. The CLI and the GUI give it two shapes:
     `cli/src/chat/tui/input/draftAttachments.ts:94` is
     `{ text, attachments, nextId, skills }`, and
     `texra/src/shared/session/surface.ts:136` is `{ text, images }`. Each
     has its own `EMPTY_DRAFT`.
  2. One transcript update's working copy (`shared/session/transcriptState.ts:278`,
     `interface Draft extends TranscriptWork`, used as `d: Draft` in
     `transcriptUpdate.ts`; also `TranscriptDraft` (`:164`) and
     `ViewDraft` (`sessionViewUpdate.ts:247`)).
  3. A row before append (`SessionEventDraft`, plus round 1's three
     subsets).
  4. A host's draft operations (`HostDraftRequests`).

  → the transcript's `Draft` becomes `EventUpdate` (it already extends
  `TranscriptWork`). The two composer drafts share one type in
  `texra/src/shared/session/` once J's `RunSurface` lands (lane 3.4).

- **(h) `RunView`, `SessionView` and `TranscriptView` are each declared
  twice.** `shared/session/sessionView.ts:68,184,324` holds the decoded,
  mutable types; `shared/session/readonlyViews.ts:11-22` holds the
  `ReadonlyDeep` ones that `./schemas` exports. Six harness files import the
  mutable `RunView` by the same name that 36 app and host files use for the
  read-only one. → export only the read-only names; harness internals that
  write use `Types.Mutable<…>` where they build one
  (`sessionViewUpdate.ts:247` already does).
- **(i) Two file names say what the file once held.**
  - `shared/runs/runStatus.ts` holds `outcomeFromCause` and `RunLoopPhase`
    (N3).
  - `shared/schemas/output.ts` holds `FileLocation`, the schema of where a
    file is (197 refs). → `fileLocation.ts`.
- **(j) Vague file names not in earlier rounds:**
  - `harness/src/agent/trace/helpers.ts`: five trace log writers,
    `logSdkError`, `logProviderError`, `startCompactionActivity`,
    `logUserMessage` and `logContextManagementEvent`; 6 importers.
    → `traceLogs.ts`.
  - `texra/src/ui/progress/utils.ts`: two unrelated DOM helpers; 7
    importers. → beside their callers.
  - `texra/src/housekeeping/utils.ts`: glob collection and a timestamp; 3
    importers; G read its contents. → `fileGlob.ts`.
  - `texra/src/ui/progress/formatters/logFormatters/toolFormatters/helpers.ts`:
    the tool section builders; 3 importers. → `toolSections.ts`.
  - `harness/src/shared/schemas/progressView/data.ts`: the tool card and
    tool-use log schemas every host reads, the only file in a directory
    named for one host's view; 4 importers. →
    `shared/schemas/toolCard.ts`.
- **(k) `absentReason` is a predicate named like a noun.**
  `harness/src/utils/files/fsEntryExists.ts:18` returns a `boolean`
  ("whether a failure means nothing is at the path"); 120 refs/51 files in
  4 packages. The module is good (round 2's M listed it), but the name
  promises a reason. → `meansAbsent(error)`. The root `AGENTS.md` cites it
  by name ("`absentReason` … the one reading of 'nothing is there'"), so the
  rename edits that line too.
- **(l) `copyOrRemoveRunDir` (`controllers/session/deletionCleanup.ts:191`)
  is two operations chosen by `op`.** They share only the existence check
  (1 caller, `:284`). The name is honest about the two jobs: →
  `copyRunDir` and `removeRunDir`, with the caller choosing.

## Good names in the repo

- `RUN_OUTCOME`/`RunOutcome` (`shared/schemas/run.ts:3-19`): its doc names
  the one fact ("how did this run end"), and `outcomeFromCause`
  (`shared/runs/runStatus.ts:20`) says what it reads and what it returns.
- The view's predicates read as questions: `isInterrupted`, `needsUser`,
  `acceptsFollowUp`, `requestAnswerability`, `rollupOf`, `descendantRuns`
  (`shared/session/sessionView.ts:194-408`).
- `takesFollowUps` (`sessionEvent.ts:194`), a persisted boolean named for
  what it allows.
- `StoreMode = 'persistent' | 'existing' | 'ephemeral' | 'global'`
  (`controllers/session/Database.ts:179`), `RunStopReason`, `PositionAt`
  (the row's own `at` vocabulary): literal sets whose members are plain
  words.
- `WORKBENCH_KIND_META` (`desktop/src/shared/desktopShellState.ts`, U's
  good modules): one table, and its keys name the tab kinds.
- `@ui/copy/*`: one home per user-visible word, shared by the webview and
  the CLI (`RUN_GRANT_NOUN`, `APPROVAL_POLICY_COPY`).

## Already settled, left alone

- Persisted and wire strings keep their spelling (root `AGENTS.md`, "Plain
  names and comments"):
  - row types `child.park`, `workflow.*`, `request.*`, `stage.*`;
  - the service RPCs `task.*`;
  - the IPC channel `desktop:settlePrompt`;
  - `_tag`s (`RunAdmissionClosed`, the nine `*Refused`);
  - payload keys `data` and `allowBypass`;
  - the persisted `input` field.
- `SessionEvents` keeps its name: the root `AGENTS.md` lists it among
  documented API names. N2 renames the row type around it.
- Round 1's row-model Q6 (`C-row-model.md`): park, settled (three
  meanings), held, verdict, admission, and fold/arm/plane/tombstone in
  comments. N1 and N9 add only the other meanings and packages.
- `RunHistoryDraft`/`RunInputDraft`/`UnfoldedDraft` (C): three names for
  one append rule. N10(g) adds the other senses of `Draft`.
- `WorkspaceStateKey` (P4), `HostFrameSchema` ×2 (U7(f)),
  `ApiKeyStatus`/`CredentialOrigin` (O8, U3), `stringField`/`numberField`
  (U), llm's `toErrorMessage` (storage-errors note), the texra
  `forkRun`/`resumeRun` wrappers (G:802), and the `WorkspaceRoots` tag
  (R8's second half; root note §R8).
- Vague files already reported:
  - `replacement/helpers.ts` (I);
  - `utils/core/index.ts`, `toolUtils.ts` (M10);
  - llm `providers/providers.ts`, `protocol.ts` (O);
  - the CLI's `runtime/` directory (K);
  - `FakeHosts.ts`, `ProgressControllerHarnesses.ts` (R);
  - `gate:typecheck`, `extension-package-utils.mjs` (S);
  - the extension's `commands/` host-request modules (T);
  - `./schemas` as an entry name (Q6).
- "Host" as the suffix of a port (`DiffViewHost`, `EditorHost`,
  `PromptHost`, `WindowHost`, `PtyHost`, …; 82 exported names) means one
  thing throughout: what the embedding application provides. It is general
  but consistent. Left.
- `foldCase`, the env-flag case fold, the editor's code folding, Effect's
  `Stream.runFold`, "astral plane", `SystemPackageManager`, and every
  arXiv/Zotero `paper`: established terms used in their established sense.
- `CliRunStatus` (`completed`/`interrupted`/`error`): the CLI's frozen
  public NDJSON vocabulary, mapped once from `RunOutcome`.
- The run grant's copy "in this task": "task" is the user's word for a root
  run (N4 keeps it in copy).

## Effect-native mapping

Checked against `node_modules/effect` 4.1.2 (`package.json` `"version":
"4.1.2"`). Only findings whose fix is structural get an API; renames get
none.

| Finding    | What answers it                                                                                                                                    | Declaration checked                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| N1         | none for the renames. Meaning 3 (the publisher drained) is C's barrier, a `Latch`; meaning 6's `REFRESH_SETTLE_MS` already feeds `Stream.debounce` | `Latch.d.ts:52` (`interface Latch`), `:189` (`make`)                                                         |
| N2         | none: type renames; the literal sets stay `Schema.Literals`/`Schema.Union` members                                                                 | `Schema.d.ts:4147` (`Union`), `:4188` (`Literals`)                                                           |
| N3         | `RunStanding` as a plain type over the view's two schema fields; `standingAfter` a pure function exported from `/schemas`                          | `Schema.d.ts:4188` (`RunPositionSchema` is `Schema.Literals`); `RunOutcomeSchema` is `Schema.Enum` (`:2462`) |
| N4         | none: renames; `stages` is a `Schema.Struct` field rename on the view                                                                              | —                                                                                                            |
| N5         | none: type and file renames                                                                                                                        | —                                                                                                            |
| N6         | none: the class keeps its `Latch` (`Latch.makeUnsafe`, `agent/followUp/RunInput.ts:101`) under its new name                                        | `Latch.d.ts:154` (`makeUnsafe`)                                                                              |
| N7, N8, N9 | none: file and identifier renames                                                                                                                  | —                                                                                                            |
| N10(a)     | one `Schema.Literals` vocabulary in `shared/transcript/`, the model view mapped from it                                                            | `Schema.d.ts:4188`                                                                                           |
| N10(f)     | `LabelsRootRuns` stays a `Context.Reference<boolean>` with its default                                                                             | `Context.d.ts:1741` (`Reference`), `:395` (`interface Reference`)                                            |
| N10(h)     | `Types.Mutable<SessionView>` at the one site that builds a view                                                                                    | `Types.d.ts:489` (`Mutable`)                                                                                 |
