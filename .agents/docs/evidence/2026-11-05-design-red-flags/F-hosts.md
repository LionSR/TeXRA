# F-hosts: the three hosts and the app over the session

Read-only audit of `packages/cli/src/runtime/*`, `packages/cli/src/chat/*`,
`packages/texra/src/controllers/{session,server}/*`,
`packages/desktop/src/main/desktopHostRequests.ts` (+ `packages/desktop/src/main/desktopProjects.ts`),
`packages/extension/src/progressView/extensionHostRequests.ts`,
`packages/extension/src/frontend/statusBar/taskStatusBar.ts`,
`packages/extension/src/extension.ts`. Every line cited was read. Consumer
counts are `grep -rn '\bSYMBOL\b' packages/*/src` (production) and
`src packages/*/test` (tests), 2026-11-05.

Not repeated here: the rows already in
`.agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md`
tables B and C (`isActivePhase`, `isTerminalOutcomePhase`, `isLiveRun`,
`ownedHere && isLiveRun`, `durableOutcome ?? CANCELLED` at `packages/texra/src/controllers/server/handlers.ts:212`,
the per-host service/local fallback decision, the landed exit-code and
signal work). Where this audit touches those facts it adds an angle the note
does not name.

## Answers to the six questions, in brief

1. **Hosts re-deriving view facts (O6).** Fourteen sites remain, listed in
   F1 and the table under F1. The biggest cluster is the CLI chat's "root run
   claim", which is a second run registry on the client.
2. **Three hosts × one session.** The two GUI hosts already share one body
   (`packages/texra/src/controllers/session/openGuiWindow.ts` `answerShared`, 29 request kinds) over a binding
   table; what each GUI host still owns is ~300–580 lines of verb bindings,
   of which the extension's `useCurrentFile` (68 lines of app logic) and
   `admitLaunch` are policy in the wrong layer. The CLI is a third,
   unrelated implementation of the same actions (F3).
3. **Approvals.** The harness has an `approve` port and an answer loop
   (`packages/harness/src/effect/requestAnswerer.ts`) that no host uses; the CLI reimplements that loop
   twice (headless and TUI) and adds a client-side "decided here" set (F2).
4. **CLI process lifecycle (O7).** Signals: one registry, one file (met).
   `process.exit`: four call expressions, one file (met). Exit-code writers:
   four mechanisms over ~20 sites (not met) (F5).
5. **Service/attach model.** The client reimplements the session three times
   at three widths (`packages/texra/src/controllers/server/serviceSession.ts` as `Session`, `packages/cli/src/runtime/runReads.ts` as the
   `LocalSession` reads, `serviceRecords` as three of them), and the local
   path already pretends to be remote through `HostWindows.localLink` (F4).
6. **Generations / reconnect.** The webview generation is settled (§3 of the
   2026-09-20 note). In service mode it is carried but does nothing: the
   `FiberHandle` already supersedes the stream (F7, batched).

---

## F1. The CLI chat keeps its own run registry beside the view

**Red flags:** two (three) representations of one fact; state machine in
optional fields; reinvented Effect primitives (`Deferred.makeUnsafe` ×5,
`uninterruptibleMask`, `doneUnsafe`); comments substituting for design
(`packages/cli/src/chat/tui/state/sessionRunState.ts` 30 %, `packages/cli/src/chat/chatSessionController.ts` 23 %).

**Evidence.**

- `packages/cli/src/chat/tui/state/sessionRunState.ts:31-41`: `RootRunClaim
  { runId?: RunId; runSettled?: Effect; runCompleted: boolean; launched:
  Effect; exitCode }` — the chat's own "which run is mine, is it in flight,
  how did it end" record. Its transitions are five methods
  (`markRunPending`, `tryClaimRootRunSlot`, `settleExitCode`,
  `markRunCompleted`, `holdsClaim`, lines 135-193), with a doc comment
  (173-184) explaining a check-then-claim race the type does not prevent.
- The predicates over it re-derive what the view states:
  `chatTuiRunPending` (271: `runSettled && !runCompleted`),
  `chatTuiCanStartRootRun` (275), `chatTuiCanStopActiveRun` (255-259:
  `runPending && (status === undefined || working)`),
  `chatTuiCanStopVisibleRun` (261), `isResumableIdle` (230-239: `runId &&
  runPending && !canStopVisibleRun && runLive`), `canSelectModel` (207-213:
  `canStart || (status === WAITING && runLive)`), `runLive` (202).
  Consumers: `chatTuiRunPending` 12 refs/4 files, `chatTuiCanStartRootRun`
  14/4, the stop pair 8/3, `isResumableIdle` 4/2.
- The claim is fed by three hand-rolled Deferreds per launch path:
  `packages/cli/src/chat/chatSessionController.ts:469,474` (`claimedRun`, `launched`), `554,558`
  (`claimedRun`, `adopted`), `726` (`adopted`), under
  `Effect.uninterruptibleMask` (462). `settleClaimOnExit` (118-126) exists
  only to copy a fiber's exit into the Deferred the claim holds — the claim
  is a `Fiber` written by hand.
- Three representations of "this chat's conversation": the claim's `runId`,
  the `rootRunId` signal (`packages/cli/src/chat/tui/state/cliState.ts:211`), and the view's `runsHere` /
  `working` / `durableOutcome` (`packages/harness/src/shared/session/sessionView.ts:159-171`). `adoptResumedRoot`
  (722-748) and `observeResumedRoots` (750-764, its own `liveHere` set diff
  of `runsHere`) exist to keep the first two in step with the third.
- `continuedSince` (325-342) detects "the run continued" by diffing
  `forkPoint`/`durableOutcome` between two view levels, although the
  `followUp.send` outcome it just received says it (`status: 'queued'`,
  `wake`, line 934-937).
- The exit code: `settleExitCode` is called five times (399, 513, 656, 663,
  739), four of them with `runOutcomeExitCode(outcome)` where `outcome` is
  the run's `RunEnd.outcome` — the same value the view's `durableOutcome`
  carries for that run (`packages/harness/src/shared/session/sessionView.ts:134`).
- The other re-derivations in my area, for the O6 list:

| Site                                                                               | What it re-derives                                                                                                                                                                                               | View field that already says it                                                                                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/chat/tui/state/sessionRunState.ts:255-265`                       | can stop (claim + `status`/`working`)                                                                                                                                                                            | `actions.includes('stop')`, `working`                                                                                                                     |
| `packages/cli/src/chat/tui/state/sessionRunState.ts:230-239`                       | resumable idle                                                                                                                                                                                                   | `actions.includes('resume')` / `working === false && live`                                                                                                |
| `packages/cli/src/chat/tui/state/sessionRunState.ts:207-213`                       | model switch allowed                                                                                                                                                                                             | `working`, `live`                                                                                                                                         |
| `packages/cli/src/chat/tui/runChatTui.tsx:588-589`                                 | `/clear` refused                                                                                                                                                                                                 | `working` (already) **or** claim `runPending && status !== WAITING` (the second branch is the claim)                                                      |
| `packages/cli/src/chat/tui/runChatTui.tsx:790`                                     | agent-finished bell (`isTranscriptSettlementPhase`)                                                                                                                                                              | noted open in the design note                                                                                                                             |
| `packages/cli/src/chat/tui/state/cliState.ts:221`                                  | `ownedHere` for the run set                                                                                                                                                                                      | `runsHere` (slice 3)                                                                                                                                      |
| `packages/cli/src/chat/chatSessionController.ts:1019-1021`                         | root takes a message: `live \|\| status === CANCELLED` beside `acceptsFollowUp`                                                                                                                                  | `acceptsFollowUp(run)` alone (`packages/harness/src/shared/session/sessionView.ts:272`) — two rules for one fact                                          |
| `packages/cli/src/chat/chatSessionController.ts:325-342`                           | "the run continued" by view diff                                                                                                                                                                                 | the `followUp.send` outcome                                                                                                                               |
| `packages/texra/src/controllers/server/handlers.ts:117-128` `runningTasks`         | at work: `held()` + `status !== WAITING`, with a `parked` boolean constant per caller (`packages/texra/src/controllers/server/handlers.ts:361` true, `packages/texra/src/controllers/server/serve.ts:280` false) | `working` / `live`                                                                                                                                        |
| `packages/texra/src/controllers/server/handlers.ts:134-146` `liveRoot`             | the live root of a run: `held()` + parent walk                                                                                                                                                                   | `session.resume` already redirects to the owning parent (`packages/harness/src/effect/sessions.ts:126-129` `redirectedFrom`); the pre-check duplicates it |
| `packages/texra/src/controllers/server/handlers.ts:183-216` `runEnded`             | ended: `run === undefined \|\| !live`, then `durableOutcome ?? CANCELLED`                                                                                                                                        | `durableOutcome` (the `??` is in the note)                                                                                                                |
| `packages/cli/src/runtime/executeCli.ts:420-430`                                   | "can it resume" after a shutdown: `shutdown && accepted && outcome === CANCELLED` then `records.readResumable()`                                                                                                 | `actions.includes('resume')`                                                                                                                              |
| `packages/cli/src/chat/tui/state/sessionView.ts:127-134` (TUI) `runningChildCount` | active children: `status === RUNNING` per child, with a comment disagreeing with the view's `rollup.running`                                                                                                     | the rollup, or `working` per child — two definitions of "active"                                                                                          |
| `packages/extension/src/frontend/statusBar/taskStatusBar.ts:258-265`               | live tree roots via `descendantRuns(...).some(live)`                                                                                                                                                             | `rollup.running > 0 \|\| live` on the root                                                                                                                |

**The design decision behind it.** "Which run is this terminal's
conversation, is a turn in flight, and how did it end?" is answered by the
session view for every host — except the chat, which answers it from a
client-side claim because the claim is taken _before_ `session.start`
returns (a message typed during model selection must know its target, line
481-486). The claim is a hand-written `Fiber<RunEnd>` plus a flag that says
whether the fiber is done.

**The better design.**

- One `rootRun: FiberHandle<Run>` (or `Deferred<Run, Error>` per launch) on
  the controller: `session.start`/`session.resume` forked into it is the
  claim. "Pending" is `FiberHandle` non-empty; "the run exists" is the
  handle's success; "ended" is the run's `durableOutcome` in the view.
- The chat's run id is `rootRunId` alone; `runsHere`, `working`, `live`,
  `actions` and `durableOutcome` are read from `view.runs.get(rootRunId)`.
  Every predicate above becomes a one-line read of a view field; the
  `interrupted`/`idle`/`can stop` branches of `sessionExitController.ts:184-216,
  280-301` read `actions`.
- The exit code is computed once at exit:
  `runOutcomeExitCode(view.runs.get(rootRunId)?.durableOutcome)` (or
  `Usage` for a refused resume, `AgentError` for a dead view), by the exit
  controller. No writer, no `settleExitCode`.
- A message typed before the run exists waits on the handle's `Fiber.join`
  (already how `stop` waits on `claim.launched`, 785-805).

**Deleted** (prod refs/files): `RootRunClaim`, `NO_CLAIM`, `markRunPending`
(3/2), `tryClaimRootRunSlot` (3/2), `holdsClaim` (4/2), `markRunCompleted`
(5/2), `settleExitCode` (6/2), `runSettled`/`runCompleted` getters,
`chatTuiRunPending` (12/4), `chatTuiCanStartRootRun` (14/4),
`chatTuiCanStopActiveRun` (4/2), `chatTuiCanStopVisibleRun` (4/3),
`runStopFacts` (9/3), `isResumableIdle` (4/2), `runLive` (4/2),
`settleClaimOnExit`, `recoverRun`'s second use, `continuedSince`,
`adoptResumedRoot`'s claim half, `observeResumedRoots`'s `liveHere` diff
(read `runsHere` arrivals from `Stream.changes`). Tests touching them: 4
files (`src/test-kernel/cli/chatSessionController.vitest.ts` 501 lines,
`src/test-kernel/cli/SessionExitController.vitest.ts`, two more) lose the claim cases.

**What we give up.** The exact "claim before the model is chosen" ordering
guarantee moves from a synchronous `tryClaimRootRunSlot` to a `FiberHandle`
set synchronously before the fork — the same guarantee, one primitive. A
chat that failed to launch no longer "holds" a claim it then releases; the
handle is simply empty again. Risk: the resume-adoption paths
(`adoptResumedRoot`, served vs local) are the least tested; the rewrite
should land with the slice-3 `runsHere` change the note already schedules.

**Change amplification.** "A run gets a third terminal outcome": today
`runOutcomeExitCode` (1 file) + the five `settleExitCode` sites + `stopped`
in `packages/cli/src/runtime/executeCli.ts:420-423` + `reportRunFailure`'s `status === CANCELLED`
read (399-401) = 4 files. After: `runOutcomeExitCode` alone.

---

## F2. Approvals: the harness's answer loop is reimplemented twice in the CLI, with a client-side "decided" flag

**Red flags:** repetition; two representations of one fact (`decided` set vs
the `request.decided` row); shared mutable state (`hostCapability`,
`presentedOrder`, `nextPresentedOrder`, `QUEUED_FORMS`); a port nobody
implements.

**Evidence.**

- The harness defines the port: `SessionHost.approve?: ApprovalHandler`
  (`packages/harness/src/effect/sessions.ts:105`) and the loop that drives
  it, `answerRequests` (`packages/harness/src/effect/requestAnswerer.ts:135-175`):
  `followPendingRequests` over `attentionOf(view)`, decision timeout
  (10 min, line 46), answer-shape check (`answerMismatch`, 63-66), decide
  retry (`DECIDE_RETRY`, 50/157), hold-until-dropped (`Effect.never`, 162).
  No host in `packages/*/src` passes `approve` (grep `approve:` — only
  `ToolEditApprovalController`'s private method matches).
- The headless CLI rebuilds the same loop: `packages/cli/src/runtime/approvalAdapter.ts:271-294`
  (`followPendingRequests` + per-kind prompt + `decide` + "landed ? never :
  void" re-ask), its own refused-decide logging (150-165), its own
  "nobody to ask" denial (193-197) that `approvalPromptsUnavailable` already
  makes the session decide (`packages/harness/src/effect/sessionPrograms.ts:102,204`).
- The TUI rebuilds it a second time, split over four modules between the
  row and the key press:
  1. `packages/cli/src/chat/tui/state/subscribeApprovals.ts:559-579`: `followPendingRequests` to **stage**
     a tool-edit preview into a signal (`stagePresentation`, 3 refs/2 files)
     and drop it (`dropPresentation`, 3/2);
  2. `packages/cli/src/chat/tui/state/approvalQueue.ts:122-131`: three module-level signals
     (`stagedPresentations`, `decided`, `promoted`) plus a module-level
     `presentedOrder` map and counter (222-223) and a module-level
     `hostCapability` function slot (138-147, `useHostCapability` 3/2) —
     "No shared mutable state", `AGENTS.md` Design guardrails;
  3. `packages/cli/src/chat/tui/state/approvalQueue.ts:228-258` `currentApproval` picks the modal; `issue`
     (314-346) sends `request.decide` with its own refusal → `reopenRequest`
     (5/2) path, which exists only because `decided` (126-127) hides the
     request before the row records the decision ("decided here, not yet
     applied there", header comment line 6);
  4. `packages/cli/src/chat/tui/modals/ConfirmCardState.ts` maps keys to `SurfaceDecision` (pure, fine);
     `packages/cli/src/chat/tui/state/formSlot.ts` queues the modal behind other forms (84 lines, one
     writer, fine).
     The GUI hosts have a fifth copy of step 1: `ToolEditApprovalController.follow`
     (`packages/texra/src/controllers/approval/ToolEditApprovalController.ts:195-209`, same `followPendingRequests` +
     `readToolEditPreview` + hold).
- `readToolEditPreview` is called from 4 files (8 refs): the preview is read
  once per host instead of once per request.

**The design decision behind it.** "Who decides a pending request, and when
does it leave the screen?" The harness answers: the attached host's
`approve` decides, the view's `requests` list says when it leaves. The CLI
answers it again on the client with `decided`, so that the modal can vanish
one frame before the row lands — an optimistic flag over a durable fact.

**The better design.**

- The TUI host attaches with `approve: (pending) => Effect<RequestDecision>`.
  The program reads the preview it needs (`readToolEditPreview`), opens the
  card through `openActiveForm`, and completes with the key the user
  pressed; `Effect.never`-until-dropped, timeout, mismatch, retry and the
  "another surface answered it" interrupt are the harness's. The card is on
  screen exactly while its fiber runs: no `decided`, no `reopenRequest`, no
  `stagedPresentations`, no `presentedOrder` (the `FiberMap` is keyed and
  ordered by arrival already).
- The headless host attaches with `approve` = the per-kind prompt
  (`askApproval` over the existing `approvalSummaries`); its "denied, nobody
  to ask" branch is `approvalPromptsUnavailable: true`, which the session
  already honours.
- `useOwnApiKey` (the one decision that is a host action) becomes a branch
  inside the TUI's `approve` program: run `ProgressApiKeyRetryController`
  then return the retry decision — no `hostCapability` slot.
- "Jump to waiting" stays a presentation choice: the modal renders the
  `attentionOf(view).requests` entry whose fiber is live and whose run is
  focused; no `promoted` signal, a sort key in the component.

**Deleted:** `createHeadlessCliHostInteractions`'s loop (keep the content
builders), `decided`, `markDecided`, `reopenRequest` (5/2), `issue`,
`decideRequest`, `stagePresentation`/`dropPresentation` (6/2),
`presentedPayload`, `presentedOrder`, `promoted`/`promoteApprovalsForRun`,
`useHostCapability`/`hostCapability` (3/2), the `stage` fiber in
`packages/cli/src/chat/tui/state/subscribeApprovals.ts`, `resetApprovalSurface`'s five resets. Kept:
`attentionRequests`/`pendingApprovalKindsByRun` (badge rendering),
`packages/cli/src/chat/tui/modals/ConfirmCardState.ts`, `packages/cli/src/chat/tui/state/formSlot.ts`, `announceForegroundApprovals`.

**What we give up.** The headless prompt lane's "ask again on the next view
if the write was refused" becomes the harness's three retries then re-offer
(same outcome, one implementation). A prompt open for over ten minutes is
denied by the harness timeout (`APPROVAL_HANDLER_TIMEOUT`); the TUI today
has no such bound — the timeout should be the host's to set (a `SessionHost`
field), or `Duration.infinity` for an interactive host.

**Change amplification.** "A new request kind": today `packages/cli/src/runtime/approvalAdapter.ts`
switch (201-257), `packages/cli/src/chat/tui/state/approvalQueue.ts` `presentedPayload` switch (203-215),
the modal dispatcher, `ConfirmCardState`'s `REQUEST_ACTIONS` row, plus the
GUI card = 5 files. After: the `approve` program's switch and the card = 2.

---

## F3. The CLI is a third host-request handler, written against `Session` directly

**Red flags:** repetition across layers; information leakage (refusal
wording, launch-failure presentation, resume redirect rules known by five
modules).

**Evidence.**

- The GUI hosts share one body: `packages/texra/src/controllers/session/openGuiWindow.ts:116-146`
  (`SHARED_HOST_REQUEST_KINDS`, 29 kinds), `answerShared` (497-824), over
  `packages/texra/src/controllers/session/hostRunActions.ts` (`runValidated`, `resume`, `runAgain`, `fork`,
  `sendFollowUp`, `workflowFileOperation`). `createHostRunActions` has one
  caller (`packages/texra/src/controllers/session/openGuiWindow.ts:435`).
- The same actions exist again for the terminal, each with its own refusal
  wording and failure presentation:
  - launch: `packages/cli/src/chat/chatSessionController.ts:455-540` `launchRootRun` ≈
    `packages/texra/src/controllers/session/hostRunActions.ts:235-273` `runValidated` (both: start, present a
    launch failure through the host, open/adopt the run);
  - resume: `packages/cli/src/chat/chatSessionController.ts:546-700` (chat), `packages/cli/src/commands/resumeRun.ts`
    (headless, 238 lines), `packages/cli/src/chat/tui/commands/handlers/sessionCommands.ts:151-180` (`/resume all`),
    `packages/cli/src/runtime/executeCli.ts:139-158` `launchOn` (`texra resume` of a task), and
    `packages/texra/src/controllers/session/hostRunActions.ts:397-418` — five entry points over `session.resume`,
    four refusal texts (`Task not found`, `CliUsageError`, `Could not resume
    …`, `Unavailable`);
  - follow-up: `packages/cli/src/chat/chatSessionController.ts:875-955` `sendMessage` ≈
    `packages/texra/src/controllers/session/hostRunActions.ts:359-387` `sendFollowUp` (both call `followUp.send`
    then `presentFollowUpResult`);
  - launch-failure presentation: `packages/cli/src/chat/chatSessionController.ts:383-406`
    (`showFailure`/`reportRunFailure`: `launchNoticeOf` else message) ≈
    `packages/cli/src/runtime/executeCli.ts:396-408` (same two branches) ≈
    `packages/texra/src/controllers/session/hostRunActions.ts:240-245` (`presentRunFailure`) — three copies of
    "a refused launch shows its notice, any other its message".
- What each GUI host genuinely owns is a verb table
  (`SharedHostRequestBindings`, 10 verbs + 5 onboarding) and the
  `OwnHostRequest` kinds (pickers, current file, pop-out, getting-started,
  workspace-file editor). Two things in the extension's table are not verbs:
  `admitLaunch` (`packages/extension/src/progressView/extensionHostRequests.ts:235-250`, a workspace-folder
  policy) and `useCurrentFile` (278-345: latexdiff file-name parsing, a git
  history lookup, a `surfaceAction` patch and two toasts — app logic). The
  desktop has `admitLaunch: () => Effect.void` (`packages/desktop/src/main/desktopHostRequests.ts:139`),
  a verb that is constant per host, i.e. an option for one caller.

**The design decision behind it.** "What does starting, resuming, forking
and messaging a run do, and how is a refusal worded?" is decided in
`packages/texra/src/controllers/session/hostRunActions.ts` for the GUI and again in the chat controller and the
headless commands, because the terminal has no `HostRequest` wire and so
never saw the shared body as applying to it.

**The better design.** `createHostRunActions` becomes the one owner for all
three hosts: the chat controller and the headless commands call
`runValidated`, `resume`, `fork`, `sendFollowUp` with the terminal's
`present`/`showInfo`/`showWarning` ports (the `HostRunActionPorts` shape
already takes exactly those). `admitLaunch` moves into the body as "a
working directory must be one of `roots.workspaces`" with the extension
passing its folder list through the snapshot it already publishes
(`workspaceRoots`, `packages/extension/src/progressView/extensionHostRequests.ts`/`packages/extension/src/progressView/ProgressViewProvider.ts:293-297`).
`useCurrentFile`'s parsing becomes a shared case over a `currentFile()`
verb.

**Deleted:** `launchRootRun`'s start/present half, `showFailure`,
`reportRunFailure`, the five resume wordings → `runActionPolicy.resumeRun`'s
one `Unavailable`, `packages/cli/src/runtime/executeCli.ts:396-408`, `admitLaunch` from the binding
table (2 impls), `useCurrentFile`'s 68 lines from the extension. Net: one
owner of ~250 lines in `packages/texra/src/controllers/session/hostRunActions.ts`, three copies gone.

**What we give up.** Nothing user-visible; the headless resume keeps its
usage exit code by mapping `Unavailable` once in `defineCliCommand`.

**Change amplification.** "The refusal wording for a resume changes": today
5 files; after: 1 (`packages/texra/src/controllers/session/runActionPolicy.ts`). "A host adds a surface" (say a
web host): today it would copy the chat controller's 1083 lines or bind
`openGuiWindow`; after, it binds the table.

---

## F4. The client reimplements the session three times at three widths; the local path already pretends to be remote

**Red flags:** shallow modules over one interface; special and general
code mixed (`GuiSession` / `DesktopProject` unions, `CliPlatformServices`
with `session` + `runSession` + `reads`); silent degradation
(`serviceRunReads` invents absence).

**Evidence.**

- `packages/texra/src/controllers/server/serviceSession.ts` (632 lines) builds a `Session` over RPC: its own
  `WebviewSessions` graph (fold), `request`, `start`, `resume`, `attach`,
  `watch`, `runOf` (468-560) with `answered`/`endOf` (`task.ended` RPC, a
  cursor wait, `answeredAt` as a mutable `let`, `Effect.cached`,
  `Fiber.join(forkIn(scope))`, `retry({times: 2})`).
- `packages/cli/src/runtime/runReads.ts` builds the `LocalSession` reads a second time as
  `CliRunReads` (8 members, 426-446): `localRunReads` (449-489) forwards
  every member to `LocalSession.records`/`listRuns`/`deleteRuns` — pure
  pass-through, 3 refs/2 files — and `serviceRunReads` (497-562) maps each
  to an RPC **and swallows `unknownRun` into a default value** (514-530:
  `null`, `[]`, `noDetail()`, `{ status: 'config_missing' }` at 552-554):
  "a run the service does not hold reads as absent" is a message turned
  into a fabricated record — silent degradation.
- `serviceRecords` (`packages/texra/src/controllers/server/serviceSession.ts:103-140`) is a third client of the
  same three RPCs (`task.config`, `task.exportInput`, `task.exportTrace`),
  used only so `packages/texra/src/controllers/session/openGuiWindow.ts:374-414` can pick `local.records(runId)
  .readConfig()` vs `remote.readConfig` — the `GuiSession` union's one job.
- The local path is already shaped as remote: `HostWindows.localLink`
  (`packages/texra/src/controllers/server/hostWindows.ts:385-394`) fakes a `ServiceLink<WindowClient>` with
  `away: ''` so `attachWindowHost` runs unchanged; `packages/texra/src/controllers/session/openGuiWindow.ts:371-414`
  branches on `runs.service === undefined` for two other reasons only
  (`present` and `exportRecords`).
- Three hosts carry the union: `GuiSession` (`packages/texra/src/controllers/session/openGuiWindow.ts:100-108`),
  `DesktopProject` (`packages/desktop/src/main/desktopProjects.ts:68-82`), `CliPlatformServices.{session,
  service, runSession, reads}` (`initPlatform.ts:124-134`).
- The service side holds the real thing: `ServiceProjects` (`packages/texra/src/controllers/server/handlers.ts:71-89`,
  lease counts + idle close in `packages/cli/src/runtime/cliService.ts:150-248`), a `FiberSet` of
  admitted runs (`packages/texra/src/controllers/server/handlers.ts:268`), `HostWindows`. So the client holds a
  fold, a Run handle, a records reader, a state store (`serviceProjectState`,
  8-attempt CAS, 149-245 — the note already names it) and, in the chat, a
  run registry (F1). The service holds the session. The "session"
  abstraction is reimplemented client-side in pieces whose union is wider
  than `Session` but narrower than `LocalSession`, so every host keeps both.

**The design decision behind it.** "Is this process the one running the
project's runs?" — answered as a type union at every host, when under O1 /
slice 3 the answer is a deployment fact (service, or no service on this
platform) that should change _which layer provides `Session`_, not the
shape every consumer writes against.

**The better design.**

- One interface, `Session`, with the reads the hosts actually use
  (`records(runId)`, `listRuns`, `deleteRuns`) promoted from `LocalSession`
  into it; `held` stays `LocalSession`-only (the service's own fact). The
  RPC surface mirrors that interface one-to-one (`task.config` ↔
  `records(id).readConfig()`, …), so `serviceSession` returns `Session`
  with records and `serviceRecords`, `CliRunReads`, `localRunReads`,
  `serviceRunReads` disappear; a run the service does not hold fails with
  `TaskRecordsFailed{unknownRun}` and the command prints it.
- `GuiSession` / `DesktopProject`'s branch / `CliPlatformServices.runSession`
  - `reads` collapse to `session: Session` and `link: ServiceLink` (the
    local link is a `ServiceLink` already). `packages/texra/src/controllers/session/openGuiWindow.ts:371-414` becomes
    `attachWindowHost(runs.link, …)` with `present = session` on both paths
    (give the remote `Session` an `emit`, as `LocalSession` has).
- `Run.result` on the client is a projection of the view the client folds:
  `Stream.runHead(view.changes.filter(level => level.runs.get(id)?.durableOutcome
  != null))` then `records(id).readRunEnd()` — no `task.ended` RPC, no
  `answered`/`endOf`/`answeredAt`/cursor wait (`packages/texra/src/controllers/server/serviceSession.ts:420-467`),
  no `runEnded` handler (`packages/texra/src/controllers/server/handlers.ts:183-216`, 2 refs) and its
  `durableOutcome ?? CANCELLED`.

**Deleted:** `CliRunReads`, `localRunReads` (3/2 + 3 test files),
`serviceRunReads` (3/2), `noDetail`, `serviceRecords` (3/2), `GuiSession`
union → one shape, `DesktopProject`'s second branch, `runSession`/`reads`
from `CliPlatformServices`, `HostRunActionPorts.readConfig` (read the
session), `RunConfigUnreadable`'s `TaskRecordsFailed` cause, `runEnded`,
`task.ended`, `answered`/`endOf`.

**What we give up.** A cold read of a run the service holds no session for
(`records` opens the project in the service, `packages/texra/src/controllers/server/handlers.ts:311-351`) still
works through the same RPC. The `task.ended` answer's `at` ordering
guarantee is replaced by the view's own `durableOutcome` level, which is
the same commit.

**Change amplification.** "A run record gains a field" (say
`readSkills`): today `RunRecords` + `CliRunReads` + `localRunReads` +
`serviceRunReads` + `packages/texra/src/controllers/server/handlers.ts` + `packages/texra/src/controllers/server/protocol.ts` = 6 files; after:
`RunRecords`, the RPC pair = 3.

---

## F5. The CLI's exit code has four writers; the headless shutdown step is a documented race

**Red flags:** overexposure (an exit-code setter reachable from eight
sites); state machine in local `let`s with `Deferred.makeUnsafe`,
`isDoneUnsafe`, `Effect.uninterruptible` and a comment that explains the
race ("Read again: acceptance may have landed while the interrupt was being
forked", `packages/cli/src/runtime/executeCli.ts:325-329`); 25 % comment share.

**Evidence (O7 counts, today).**

- Signals: `process.on('SIG…')` — one site, `packages/cli/src/runtime/processSignals.ts:453`; six
  holders (`packages/cli/src/runtime/initPlatform.ts:208,392`, `packages/cli/src/runtime/foregroundCommand.ts:68`,
  `packages/cli/src/chat/tui/sessionExitController.ts:257,337`, `packages/cli/src/commands/service.ts:94`). Met.
- `process.exit(`: four call expressions, all in `packages/cli/src/runtime/initPlatform.ts`
  (189-191 `leaveAtOnce`, 200 `cliExit`), plus `process.kill(process.pid,
  'SIGSTOP')` (`sessionExitController.ts:312`). Met.
- Exit-code writers, four mechanisms: (a) `setExitCode` module global
  (`packages/cli/src/commands/_helpers/exitCode.ts:6-10`), 8 call sites in 7 files
  (`packages/cli/src/commands/_helpers/defineCliCommand.ts:178,186,196,202,206`, `packages/cli/src/commands/help.ts`, `packages/cli/src/commands/root.ts`,
  `packages/cli/src/commands/doctor.ts`, `packages/cli/src/commands/version.ts`, `packages/cli/src/commands/completion.ts`, `packages/cli/src/bin/texraServe.ts`); (b)
  `process.exitCode =` four sites (`packages/cli/src/bin/texra.ts:41,56`,
  `packages/cli/src/bin/texraServe.ts:32,39`); (c) `TuiSession.settleExitCode` five sites +
  the `exitCode` getter (`packages/cli/src/chat/tui/state/sessionRunState.ts:102-106`, `AgentError` on a
  dead view); (d) `CliConfigExecuteResult.exitCode` (`executeCli.ts:89,130,
  461-463`) with `CliExitCode.Interrupted` decided from `shutdown &&
  hasInterruptsOnly` (375-376). Not met: ~20 sites.
- The headless shutdown step (`packages/cli/src/runtime/executeCli.ts:261-358`): `shutdown`,
  `accepted`, `failurePresented` as `let`s; `shutdownFinalizationDone` a
  `Deferred.makeUnsafe` checked with `isDoneUnsafe` (306) and completed
  with `doneUnsafe` (441); `accepted` set inside an `Effect.uninterruptible`
  region (291-300) and read twice around a `forkDetach(Fiber.interrupt)`
  (321-329). The reason is stated at 315-316: a `run.stop` for a run the
  registry has not accepted "is the registry's quiet no-op", so the launch
  must be interrupted instead, and acceptance must be fenced.

**The design decision behind it.** "What does a stop of a run id the
session has not started yet mean?" Today: nothing (the registry ignores
it), so every launcher fences its own acceptance. The exit code: "who turns
an outcome into a number?" — answered per entry kind.

**The better design.**

- In the harness: a `run.stop` (or `interrupt`) for a minted `runId` that
  has not been accepted **records the refusal**, so the later `start` under
  that id fails at once with "stopped before it started". Then the launch
  fiber is just `forkIn(shutdownScope)` and `Fiber.join`ed; the shutdown
  step is one `session.request({kind:'run.stop', runId, reason:'shutdown'})`
  then a wait on the fiber; `accepted`, the uninterruptible region, the
  double read, `Fiber.interrupt(launched)`, `shutdownFinalizationDone` and
  `isDoneUnsafe` all go. This is one decision in `RunRegistry`, which the
  pre-minted id (`packages/cli/src/runtime/executeCli.ts:197-201`) already anticipates.
- The exit code is one function of one fact, computed at the process edge:
  `exitCodeOf(outcome: RunOutcome | 'usage' | 'crash' | 'interrupted')` in
  `packages/cli/src/bin/texra.ts`, fed by the command's result (`CliRunResult.outcome`, the
  root run's `durableOutcome` for the chat). `setExitCode`/`getExitCode`
  become the return value of `defineCliCommand`; `TuiSession.exitCode` and
  `settleExitCode` go with F1; `CliConfigExecuteResult.exitCode` becomes an
  outcome.

**Deleted:** `packages/cli/src/commands/_helpers/exitCode.ts` (`setExitCode` 8 sites, `getExitCode` 2),
`settleExitCode` (6/2), the `exitCode` fields on `CliConfigExecuteResult`
and `ChatExit.signal`, `accepted`, `shutdownFinalizationDone`,
`interrupted` (375), `stopThroughSession`'s guard, ~60 lines of comment in
`packages/cli/src/runtime/executeCli.ts`.

**What we give up.** A stop that arrives after the id was minted but before
the launch's first store write now refuses the launch instead of letting it
start and stopping it; that is the intended behaviour (line 196-198 says
so). Risk: `src/test-kernel/cli/ExecuteCli.vitest.ts` and `src/test-kernel/cli/WorkflowRunCommand.vitest.ts` pin
the current shape.

**Change amplification.** "A fourth exit reason (say, SIGHUP exits 129 with
its own message)": today `leaveAtOnce`, `platformSignalPolicy`,
`handleTermSignal`, `executeCli`'s `interrupted` branch, `defineCliCommand`
= 5 files; after: the signal policy and `exitCodeOf` = 2.

---

## F6. The NDJSON progress projection hand-rolls "drain to a cursor" with four counters and three fibers

**Red flags:** reinvented Effect primitives (`Deferred.makeUnsafe`,
`doneUnsafe`, `delivered`/`stopAt`/`childrenPending` counters, a
`SubscriptionRef` as a side channel); comments substituting for design
(37 %, 66 of 178 lines; the header comment is 50 lines).

**Evidence.** `packages/cli/src/runtime/sessionProgressSubscription.ts:88-178`: `delivered`,
`stopAt`, `drained` (Deferred), `attachedAt`, `writtenChildren`,
`childrenPending`, `emitChildren`, `settleIfDrained`, `passed`, `drainedTo`
(SubscriptionRef), three forked fibers (events tail, cursor changes, view
changes), and a returned "detach" program that sets `stopAt`, awaits the
Deferred and interrupts the fibers. The second record it writes,
`run.children`, is derived (`childIds` × `live`) and deduped by
`JSON.stringify` (`writtenChildren`, 118-120) — a second representation of
the view's child list, ordered against the event tail by hand (103-105,
"a child list never precedes a row it already reports").

**The design decision behind it.** "Write every row from H₀ to the head at
detach, in commit order, then stop" — a bounded stream. The counters exist
because the stop point is chosen _after_ the stream started.

**The better design.** `Stream.takeUntil` on a `Deferred<CommitOrdinal>`:
`view.events(from, drainedTo).pipe(Stream.takeWhile(e => e.commit <=
stopAt))` where `stopAt` is a `Deferred` the detach completes with
`view.head()`; `Stream.runDrain` is the drain, `Fiber.join` is the wait.
`run.children` is computed from the same events (on each row whose type
changes a child's `live`), with `Stream.changes` as the dedupe. One fiber,
no counters, no `SubscriptionRef` side channel. The NDJSON contract
(`contract: 2`) is unchanged.

**Deleted:** `delivered`, `stopAt`, `drained`, `childrenPending`,
`settleIfDrained`, `passed`, `drainedTo`, the three-fiber array; ~40 lines
of header comment. Consumers: `attachCliSessionProgressProjection` 4/2 +
2 test files.

**What we give up / risk.** The "child list waits for the lines that
produced it" ordering becomes "the child list is emitted by the row that
changed it", which is the same order by construction. Risk is in the
`view.events` contract (`drainedTo` is its own parameter,
`packages/harness/src/effect/sessions.ts:253`), which a harness change would have to keep.

---

## F7. Batched: smaller findings in the same species

- **Generation in service mode is vestigial.** `packages/texra/src/controllers/server/serviceSession.ts:329-370`
  increments `generation`, calls `graph.frames.begin(generation)` (a fresh
  `Queue` per generation, `packages/texra/src/shared/session/sessionFrames.ts:300-305`) and sends it on
  `task.watch`, but the previous stream is already superseded by
  `FiberHandle.run(feed, …)` (344); `watch` (507-556) sends `generation: 0`
  for every stream it opens and `packages/cli/src/runtime/taskAttach.ts:100-115` hard-codes
  `generation = 1`. The frame-dropping (`packages/texra/src/shared/session/sessionFrames.ts:308`) protects a
  fire-and-forget `postMessage` port; on an RPC stream the fiber is the
  generation. Leave the webview's (settled, §3 of 2026-09-20) and drop the
  counter from the service client: `begin()` becomes "new queue", the
  `Subscribe` sent to the service carries no generation. Also: `watch`
  opens a second `task.watch` stream for the same aggregates the window's
  own feed already names (the `watches` map, 326-328, exists to make the
  window feed fold them) — two RPC streams per `Run.events` replay.
- **`runningTasks(projects, parked)`** (`packages/texra/src/controllers/server/handlers.ts:117-128`): a boolean
  constant per caller (`packages/texra/src/controllers/server/handlers.ts:361` default, `packages/texra/src/controllers/server/serve.ts:280` false)
  that selects between two view facts the fold already names (`live` vs
  `working`); two one-line readers of the view replace the function.
- **`workflowFileOperation` catches `NotOwner`** and words "running or held
  elsewhere" (`packages/texra/src/controllers/session/hostRunActions.ts:486-492`): claims vocabulary in a host
  action; under O1 the branch has no producer. Same species:
  `TuiSession.runsElsewhere` (`packages/cli/src/chat/tui/state/sessionRunState.ts:81-88`) and
  `ChatSessionControllerInit.served` (`packages/cli/src/chat/chatSessionController.ts:766-772`,
  `788`) — a host flag standing in for `runsHere`.
- **Module-level singletons in the CLI runtime**: `packages/cli/src/runtime/initPlatform.ts:52,58`
  (`shutdownQuiet`, `installed`), `packages/cli/src/runtime/cliProcessRuntime.ts:543` (`installed`),
  `packages/cli/src/commands/_helpers/exitCode.ts:6`, `packages/cli/src/chat/tui/state/approvalQueue.ts:138,222-223`, `packages/cli/src/chat/tui/state/formSlot.ts:315,318`,
  and the ten `registerCliStateResetHook` sites (10/5) that exist to reset
  them between tests. `packages/cli/src/runtime/cliProcessRuntime.ts` is 50 % comment (114/226
  lines), most of it explaining `NO_PLATFORM_INSTALL` (525-530), a
  refusing `AppState`/`GlobalDatabase` for two entries (`clone`,
  `install-github-action`) — special code mixed into the general install.
  The better shape is a `Layer` those two entries build without the global
  stores, not a runtime that dies on first read.
- **`packages/texra/src/controllers/session/hostSnapshotSource.ts` `onError(error: unknown)`** callback
  (`113`): an untyped error sink beside a typed `HostSnapshotReadFailed`;
  each host turns it back into a log line (`packages/extension/src/progressView/ProgressViewProvider.ts:328-334`).
  `Effect.logError` inside `guarded` would do, with no port.

---

## Good modules in this area (copy these)

- `packages/texra/src/controllers/session/openGuiWindow.ts` `answerShared` + `SharedHostRequestBindings`
  (116-192, 497-824): one body, one case order, one wire contract, hosts
  fill a verb table. The right shape for F3.
- `packages/texra/src/controllers/session/hostRunActions.ts` `requireAction` (226-234): a host reading
  `view.actions` and refusing with `runActionRefusal` — O6 as it should be
  done everywhere.
- `packages/texra/src/controllers/session/SessionFramer.ts` `cutFrame`/`frameSubscription`: pure over its sources,
  TestClock-driven, 18 % comments that say what, not why.
- `packages/harness/src/effect/requestAnswerer.ts` `followPendingRequests` (93-124): a deep module (a
  `FiberMap` keyed by request, run-while-listed) that five callers use; the
  fix in F2 is to let its sibling `answerRequests` be used too.
- `packages/cli/src/runtime/processSignals.ts` `holdSignals` (51 lines): one registry, newest holder
  answers, listeners installed only while named.
- `packages/texra/src/controllers/server/hostWindows.ts`: `RcMap`, `Queue`, `Deferred` with timeouts — the
  primitives, no counters.
- `packages/texra/src/controllers/server/client.ts` `linkService`/`ensureService`: reconnect with `Schedule`,
  `Deferred<lost>`, `SubscriptionRef<client|null>`; `linkOutage` as a
  derived stream.
- `packages/extension/src/frontend/statusBar/taskStatusBar.ts`: reads `working` and `sessionActivity`, repaints on
  `Stream.changesWith`.
- `packages/cli/src/chat/tui/modals/ConfirmCardState.ts`, `packages/cli/src/chat/tui/state/formSlot.ts`: pure keymap; one-writer slot.

## Already settled, left alone

- Webview reconnect generations in `SessionFramer`/`SessionBridge`
  (2026-09-20 note §3) — kept; F7 only questions their copy on the RPC path.
- `SessionBridge.answer`'s `Effect.uninterruptible` (408): a decision sent
  just before a tab closes must still land; the header comment states the
  reason and it is a boundary, not the fiber model being fought.
- `packages/desktop/src/main/desktopProjects.ts` `Effect.uninterruptible` around open/close
  (329, 408, 451): acquire + registry install as one step, per the
  `acquireRelease` rule.
- `withPerKeyLane` in `packages/cli/src/runtime/cliService.ts` and `packages/desktop/src/main/desktopProjects.ts`: overlapping
  writes to one key in invocation order (§3).
- `packages/texra/src/controllers/session/hostDraftRequests.ts`'s two Deferreds per take (`result`, `settled`):
  a take has two distinct completions (Start's answer; Stop/Cancel), so two
  Deferreds is the honest shape. The `stopping`/`cancelled` booleans beside
  `settled` could be a `Deferred<'stop'|'cancel'>`, but with one writer and
  one reader this is below the bar.
- The per-host fallback decision (`packages/extension/src/extension.ts:461-475`,
  `packages/desktop/src/main/desktopProjects.ts:283-307`, `packages/cli/src/runtime/initPlatform.ts:303-358`): already in
  table C of the design note; F4 adds only that the _type_ union it
  produces is the part worth deleting.
