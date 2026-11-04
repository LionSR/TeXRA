---
created: 2026-11-03
status: accepted (owner, 2026-11-04)
---

# One fact, one representation: stop, resume, and the four areas beside them

Measured 2026-11-03 at `main` `b411a6d6` (history available: 709 commits,
2026-10-04 to 2026-11-03). Paths are relative to the repo root. Peers checked
at source: pi (`packages/agent/src/agent.ts`, `session-manager.ts`),
pi-durable (its README), Codex (`codex-rs/core/src/tasks/mod.rs`); OpenCode
from the reviewer's knowledge of its code, not a fetch. The citations the
reviews corrected were re-read at `74eb0a85` on 2026-11-04.

## Summary

The stop and resume path is not an over-built version of what pi, pi-durable,
OpenCode and Codex do. It answers a question none of them ask ("may this
process take this run over from another live process?") and it represents one
fact, "this run stopped", four ways: fiber interruption, an `abort` error
kind, an in-memory `stopCause`, and a lost claim read as a stop. About 37 files
classify an exit as stop-or-failure; two of them rewrite cause shapes so the
next classifier reads them right, three throw the shape away.

The same species lives in four neighbouring areas (the table in "Findings").
None of this was undetected: five notes since 2026-09-20 named it, the last
one with pi as the yardstick, and eight PRs consolidated owners. Thirty-three
stop/resume fixes landed in the same month, fourteen of them in the week after
the 2026-10-27 target designs. The method, not the diligence, is what fails:
every pass made each representation have one owner and never asked whether the
representation should exist, and every pass inherited the rulings that keep
the root decisions in place.

This note does three things: states the rule that stops the recurrence, lists
the owner decisions each area needs before any code moves, and gives each
area's deletion list with its consumer surface, so a slice is a deletion whose
callers are known, not a fix.

| Measure (one month)                                | Count      |
| -------------------------------------------------- | ---------- |
| Fix commits, all                                   | 155        |
| Fix commits on stop/resume/ownership               | 33         |
| Fix commits on desktop/windows, view/fold, CLI/TUI | 21, 18, 14 |
| Files classifying interrupt vs failure             | 37         |
| Files reading the parent edge                      | 72         |
| Files reading `ownedHere`/`readOnly`               | 23         |
| Sites of `withPerKeyLane`                          | 52         |
| Design notes naming the stop/resume problem        | 5          |
| Stop/resume fixes after the 2026-10-27 note        | 14         |

## The mistake, and the rule

The mistake has one shape in every area: **a fact gets a second
representation under another name, each representation gets a single owner,
and "one owner per fact" reads as satisfied.** `stopCause` has one assigner
(the fact-owner ratchet checks it); `abort` has one classifier (checklist §15
lists it as an L4 owner); `closed` on the halt row has one writer (ruled
2026-10-30, M8); a lost claim has one refusal type. Four owners, one fact.

The rule, which every slice below follows and every later design pass must
state it followed:

1. **Name the fact by its meaning, then list every representation.** A
   representation is any row field, view field, in-memory field, derived
   predicate, error kind, union arm or settings key that answers the same
   question. The list is the first table of the design, before any owner is
   named.
2. **Delete all but one in the same PR.** No adapter, no "read the old one
   until", no second PR. If the survivor must change shape (a stored field),
   that change is in the same PR with its `rowVersions` bump and fixtures.
3. **Ask a peer before keeping a fact.** For each fact: what does pi-durable,
   Codex or dsh store for it, and in how many places. A fact no peer has needs
   a product reason written in the design, or it goes.
4. **Rulings are reopened by churn, not inherited.** A ruling whose area took
   more than ten fix commits in a month is re-asked in the next design pass,
   with the fixes as the evidence. Its answer may be the same.
5. **Decide the model before consolidating inside it.** The owner decisions
   below come first. A pass that consolidates owners inside a model under
   question is the pass this note is replacing.
6. **Checks count facts, not files.** The three checks under "Checks" land
   with the first slice. A size ratchet never moves a fact away from its
   reader: reducer and fact-reader files are exempt from the 400-line cap by
   name.

## Owner decisions, all before the first slice

| #   | Decision                                                                                                                                                                                                                                                                                                                                   | Reopens                                                                                                                                                                       | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | **Ownership granularity.** Keep per-aggregate claims with liveness proof and dead-owner takeover (several live processes may run different runs of one store), or one process per store at a time, enforced by a kernel lock, with a second opener read-only (pi: "one process owns a storage at a time"; dsh: `flock` / named semaphore). | Ledger D4 ("several processes on one store, each aggregate held by one claim"); the 2026-10-30 note's M3 and its flock row                                                    | **One process per store.** The service is the process that holds the lock where it runs; on Windows, or with no service, the first window holds it and later windows attach to it or open read-only. The capability lost is two processes driving different runs of one project at once, which no host offers as a feature. Deletes the liveness prover, takeover, `ownedElsewhere`, held parks.                                                     |
| O2  | **Stop reason on the end row.** `run.end` carries `reason: 'user' \| 'shutdown'` for a cancelled outcome (`'released'` is only `interrupt`'s default argument; nothing branches on it).                                                                                                                                                    | The "one outcome" ruling the 2026-10-24 audit cites; M8 of 2026-10-30 (`halted { reason: 'closed' }`), which is this fact stored on a different row for one of its two values | **Yes.** `closed` on the halt row, `closedBySession`, `Attempt.closed`, the `closed` case in `failuresBefore`, and `needsWake`'s inference from a cancelled outcome all go. One field, read by `nextAttempt` (a shutdown-cut attempt spends no retry), `needsWake` (only a user's message continues a user-stopped run), and the stop notice.                                                                                                        |
| O3  | **The `abort` error kind.** Delete it: a stop is fiber interruption, nothing else.                                                                                                                                                                                                                                                         | The June error-pipeline note names `isUserAbort` an owner; checklist §15 lists `classifyAgentError` as L4                                                                     | **Yes.** No producer reaches it alone: the harness has no `AbortController`, `packages/llm` maps each SDK's abort back to the fiber, and a tool on `Effect.abortSignal` is interrupted anyway. When it arrives it arrives beside the interrupt, which today logs "A stopped run also failed" on an ordinary Ctrl-C.                                                                                                                                  |
| O4  | **Recovery at open.** List interrupted runs; never resume them automatically, and drop the catalog follower that resumes a blocked run when its plugin becomes trusted.                                                                                                                                                                    | The `resumeOnOpen` setting                                                                                                                                                    | **List only.** No peer auto-resumes; a resume is a click or an SDK call. Model spend on host open is a product risk on top of the code.                                                                                                                                                                                                                                                                                                              |
| O5  | **A child's result is its tool result.** A child stays a run (listing, transcript, resume), but its result reaches the parent only as the `tool.result` of the call that launched it, read by `resumedAttempt` when the parent resumes. No follow-up delivery channel, no held parks.                                                      | The session-messaging note's delivery-through-input design                                                                                                                    | **Decided 2026-11-04: not as written.** The owner wants the parent woken automatically when a background child finishes, the model deciding what to do with the result ("让 model 决定，越自动越好"). An awaited child's result is its `tool.result`, as every peer does; a background child's completion reaches the parent as one delivered message that wakes it. The slice deletes the duplicates among the delivery mechanisms, never the wake. |
| O6  | **Hosts read view fields, never re-derive them.** The fold gains `working` and `runsHere`; `runStartedAt` is nulled whenever the run is not working; `durableOutcome` is the one spelling of "ended, and how".                                                                                                                             | None                                                                                                                                                                          | **Yes.**                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| O7  | **One process-exit owner in the CLI.** One signal registry in `initPlatform`, one `process.exit` call site, one exit-code writer.                                                                                                                                                                                                          | None                                                                                                                                                                          | **Yes.** Ctrl-C interrupts, a second Ctrl-C exits, `/exit` exits; the reason is sent and forgotten.                                                                                                                                                                                                                                                                                                                                                  |
| O8  | **Retryability is llm's verdict, once.** A `ModelError` carries `{ automatic, offered, credential }`; the `failed` row records it; nothing in the harness reads a status code or re-classifies.                                                                                                                                            | None                                                                                                                                                                          | **Yes.**                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| O9  | **The parent edge in a writing job is the rows'.** The view's `parentId` is a projection; a job that stamps, compares or refuses by parentage reads `facts.parent`.                                                                                                                                                                        | None                                                                                                                                                                          | **Yes.**                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| O10 | **Vocabularies derive from their one source.** The provider id list is llm's manifest; the settings rows, the picker sources, the key page and the stored enums derive from it. The command catalog is the one list the invoke tool reads.                                                                                                 | `packages/harness/AGENTS.md` "the places it touches, all but the first compile-enforced"                                                                                      | **Yes.** The guide's seven-place list becomes a one-place list.                                                                                                                                                                                                                                                                                                                                                                                      |

O1 decides the size of everything else: with per-aggregate claims kept, the
stop/resume deletions below shrink by about half and the liveness prover
stays. The rest of this note is written for the recommendation.

### Decided 2026-11-04

The owner accepted O1, O2, O3, O4 and O6 to O10 as recommended, with two
changes, and decided O5 differently:

- **O1:** one process per store, enforced by SQLite's own exclusive lock, not a
  lock file or a lease (the 2026-09-15 ruling against locks stands).
  `storeOpenElsewhere` (`packages/harness/src/controllers/session/Database.ts:1013`)
  already probes it with `PRAGMA locking_mode = EXCLUSIVE`. The holder keeps
  that lock for its connection's life; a second opener gets `BUSY` and
  attaches to the holder's service endpoint; a crashed holder's lock is
  released by the kernel, and the next opener lists the interrupted runs
  (O4). The slice verifies that the service runs on Windows and bounds the
  retry when two windows open at once.
- **O2:** two values, `'user' | 'shutdown'`.
- **O5:** the parent is woken automatically; see its row.
- The 1.0 storage freeze waits for the slices that change stored rows (2, 3,
  4 and D).

### Slice 3 design (2026-11-04, after a read-only survey)

What the code does today, against O1's description:

- Nobody holds a store lock. Every process opens `texra.db` in WAL mode with
  a busy retry (`databaseLayer`, `packages/harness/src/controllers/session/Database.ts`);
  who may run a run is the per-aggregate claim `event_sequence.owner_id`,
  checked on every append. `storeOpenElsewhere` is the probe of
  `texra doctor --prune-storage` alone (`projectDatabase.ts`).
- The desktop and the extension already attach: with a service, a window
  holds `serviceSession` and `serviceProjectState` and opens no store. The
  CLI chat opens the project store even when attached (`runChatTui.tsx`,
  `initPlatform.ts`), and headless `texra run`, `team run` and the document
  resume never attach (`executeCli.ts`).
- The service (`texra serve`) is one per storage root, found through its
  record in the global store (a compare-and-set), one session per project
  opened on the first lease and closed after 600 s idle. An upgrade drains:
  the old and the new service both hold a project while the old one's tasks
  end. Windows has no service (a named pipe takes the default ACL); every
  host falls back to running in process.
- The no-workspace store is shared by the desktop's always-local fallback
  session and every folderless VS Code window.

Six facts about SQLite and the stores bound the mechanism: `locking_mode =
EXCLUSIVE` in WAL mode makes the holder the only process, readers included,
so a second opener cannot read; the global store carries the service record's
compare-and-set and must stay multi-process, so the lock is the project
store's alone; an idle close releases the lock; the lock is per connection,
so it cannot sit on a second connection beside the writer; the prober and
the claims exist only to arbitrate between openers; and a store's schema
change is a version bump, not an upcaster.

The mechanism, then:

1. **One opener per project store**: the process that drives its runs holds
   `locking_mode = EXCLUSIVE` on its connection for the connection's life.
   Where a service runs, that is the service; it opens a project on the first
   lease and closes it idle, and clients open nothing. A second opener gets
   `BUSY` and attaches to the service. There is no read-only opener: a
   process that can neither hold nor attach says "another TeXRA process holds
   this project" and offers nothing else. Prune's probe keeps working (`BUSY`
   is `open`).
2. **Every client goes through the service.** The desktop and the extension
   do. The CLI chat stops opening the store when attached and reads project
   state through the service as the desktop does; headless `texra run`,
   `team run` and a document resume beside a service run through it, as
   `texra tasks start` does; with no service, the first opener holds, as the
   in-process path does today.
3. **Windows gets the service** over a named pipe with an explicit DACL (the
   user's SID alone): the one piece of new host code, and a prerequisite, or
   a Windows window would be shut out of a project another window holds.
4. **The no-workspace store** goes through the service like any project.
5. **An upgrade drain** opens projects lazily in the new service; one the
   draining service still holds answers `BUSY`, and the new service retries
   until the old one's tasks end, within the drain's own deadline.
6. **Deleted with the claims**: `event_sequence.owner_id` and its trigger and
   `NEXT_SEQ`'s owner check; `acquireClaims`, `releaseClaims`, `claimOwner`,
   `claimAll`, `reclaimable`, `provingOwners`, `DatabaseNotOwner`,
   `DatabaseClaimRefused`, `heldElsewhereBy`, `claimStanding`;
   `proveOwnerLiveness`, `proveRecorded`, `deadOwners` and the prober layer;
   `ProcessIdentity.owners`, `LocalRuntimeState.self` and `dead`,
   `RunView.ownerId` and `ownedHere`, the `ownedElsewhere` arms of the three
   unions, the held parks (`heldFor`), `holdProcessRoot`. `RunView.readOnly`
   keeps its one remaining meaning, rows of an earlier build, and is named
   for it (`unreadable`), with its delete action. The fifteen test files
   that pin claims (`sessionEvents`, `sessionViewUpdate`, `resumeRun`,
   `RunAgentOwnership`, `ResumeCommand`, `ApprovalQueue`, `ChildRunLoop`,
   `SessionIsolation`, `sessionPrograms`, `DelegationHeadless`, the crash
   conformance and store-fault supports, `goldenStore`, the fan-out and
   session-view fixtures) lose those cases; `claimHolder` and `untilStored`
   read through the session's connection instead of the raw file.

Order: the Windows pipe first, then the CLI's attach for chat state and
headless runs, then the lock with the deletions in one PR. The lock alone,
before the two, would strand a Windows window and the CLI.

## Findings by area

Each row: the fact, the representation kept, what goes, how many non-test
files use what goes, and the acceptance check. The four audits behind the
non-stop rows were read-only passes whose cited lines were verified.

### A. Stop and resume (the two reviews of 2026-11-03)

| Fact                                | Keep                                                                                                                 | Delete                                                                                                                                                                                                                                                                                                                         | Files |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| This run stopped, and why           | fiber interruption; `run.end.reason` (O2)                                                                            | `abort` kind and its three special cases in `failedEnd`, `isUserAbort`, `AGENT_ERROR_OUTCOME.abort`, the `abort` arm of `agentErrorPresentation`; `closedBySession`, `Attempt.closed`, the `closed` case in `failuresBefore`; `outcomeFromCause`'s `seen` parameter; the lost-claim-as-stop branch in `endChildLoop`           | 23    |
| Who may run this run                | the store lock (O1); in process, the activation map                                                                  | `hold`/`owns`/`acquireClaims`/`releaseClaims`/`claimOwner`/`prepareRunRemoval`'s claim half, `heldElsewhereBy`, `claimStanding`, `DatabaseClaimRefused`, `ownerLiveness`, `proveOwnerLiveness`, `ProcessIdentity.owners`, `LocalRuntimeState.dead`, `RunView.ownerId`/`readOnly`/`ownedHere`, `ownedElsewhere` in three unions | 35    |
| A resume is in flight here          | one `Deferred<activation \| refusal>` per run in the registry                                                        | `RunAttempt`'s `waiters`, `handedOff`, `activation` link, the last-leaver interrupt, `attemptOf`, `restsWith`, `delivered`, the hand-off rule in `RunRegistry.start`                                                                                                                                                           | 6     |
| Why a resume is refused             | the activation transaction's typed failure, four arms                                                                | `runRejection`, `deriveResumability`'s union, `earlierBuildRefusal`, `namesUnusableCheckpoint`, `refusalFor`, `REFUSED`; `notResumable`, `unusableCheckpoint`, `pluginUnavailable`, `earlierBuild` arms                                                                                                                        | 15    |
| A child's result reached its parent | an awaited call's `tool.result`; for a background child, one delivered message that wakes the parent (O5 as decided) | the duplicates among `child.park` `heldFor`, `RESULT_WAITING`, `deliverHeld`, `deliverOne`, `clearHeld`, `onHeldResult`, `sendStopNotice`, `pauseNotice`, `reportInterrupted`, `closeLeftoverRun`, `closeLeftoverChildren`, `sweepLeftoverRuns`: the slice names the one survivor                                              | 12    |
| A stop of a run no process runs     | nothing: it is not stopped, it is not resumed                                                                        | `stopEnd`, `withInactiveRunStep`, `beforeEnd`'s cascade, `RunStop.accepted` (one reader) and the two-phase `settlement`                                                                                                                                                                                                        | 4     |
| Interrupted runs at open            | the view's `interrupted` group (O4)                                                                                  | `followInterruptedTasks`, `resumeBlocked`/`markResumeBlocked`/`resumeBlocks`, `interruptedTasksOnOpen`, the `resumeOnOpen` setting and its surface row                                                                                                                                                                         | 23    |
| A stop that also failed             | `endRun`'s one rule: cancelled, error recorded                                                                       | the dispatcher's fail-to-die rewrite, `runWithLaunchGuard`'s `Cause.combine` and aggregate, the three `hasInterrupts → Effect.interrupt` downgrades (invoker, invocation, compaction), `endChildLoop`'s aggregate, `primaryAgentError`                                                                                         | 7     |
| Defects and failures                | failures typed at the llm and storage boundaries                                                                     | `Effect.die(Cause.squash(…))` for unknown failures in the invoker and the invocation loop; `defectAsFailure`, `defectsAsErrors`                                                                                                                                                                                                | 6     |

Stored-shape changes: `run.end` gains `reason` (O2); `run.position`'s halt
loses `reason: 'closed'`; `run.end.error.kind` loses `abort`; `child.park`
keeps or loses `heldFor` and the `delivery` phase as O5's slice decides. Each is a `rowVersions` bump
and a golden-store regeneration (`src/test-kernel/fixtures/storage/golden-1.0.sql`,
`src/test-kernel/controllers/session/goldenStore.vitest.ts`,
`src/test-kernel/support/crashConformance.ts`).

Acceptance: changing how a run stops touches `RunRegistry.interrupt` and
`endRun` only; `grep -rl 'Cause.hasInterrupts' packages/harness/src` returns
under ten files; every stop/resume test asserts rows, not cause shapes.

### B. Run status as hosts see it

Audit verdict: partial, same disease. Nine host predicates re-derive what the
fold computes.

| Fact                   | Keep                                              | Delete                                                                                                                                                                                                                                                                                                                                            | Files |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| The run is working now | a fold field `working` (`isWorkingRun`'s rule)    | every host `isActivePhase(view.status)` (`packages/cli/src/chat/tui/state/sessionRunState.ts:234,240`, `packages/cli/src/chat/tui/runChatTui.tsx:568`, `packages/cli/src/chat/tui/panes/transcriptEntries.ts:167,267`, two in `statusBarDisplay.ts`) and the two `group === running \|\| waiting` spellings in `RunHeader.ts` and the tasks panel | 5     |
| This process runs it   | a fold field `runsHere`                           | the `ownedHere && isLiveRun` sites (`packages/texra/src/controllers/server/taskList.ts:41`, `packages/cli/src/runtime/executeCli.ts:295`, three in `chatSessionController.ts`)                                                                                                                                                                    | 3     |
| It ended, and how      | `durableOutcome`                                  | host `isTerminalOutcomePhase(view.status)` (`taskAttach.ts`, `runProgressRenderer.ts`); `durableOutcome ?? CANCELLED` in `packages/texra/src/controllers/server/handlers.ts:214`                                                                                                                                                                  | 3     |
| A clock is ticking     | `runStartedAt`, nulled by the fold unless working | the three clock rules (`RunHeader.ts:562`, `BackgroundTasksPanel.ts:464`, `childControls.ts:22,38`)                                                                                                                                                                                                                                               | 3     |
| Stop is offered        | `actions`                                         | the TUI stop predicate over `isActivePhase` (`sessionRunState.ts:229-242`)                                                                                                                                                                                                                                                                        | 1     |

Today's divergences, each a user-visible defect: an interrupted run keeps
`status: running`, so the TUI status bar shows it active, the live-assistant
row renders, `/clear` is refused ("wait for the active response"); the header
clock keeps ticking on an interrupted run while the background panel stops it;
a service handler invents `CANCELLED` for a run with no end row.

Acceptance: no host file imports `isActivePhase`, `isTerminalOutcomePhase` or
`isLiveRun`; `grep -rn 'view.status\|run.status' packages/{cli,texra,extension,desktop}/src`
hits renderers of the status word only.

_Landed 2026-11-04 (every row but `runsHere`): `RunView.working` is the
fold's (`sessionViewUpdate.ts`), `runStartedAt` is null unless the run is busy
on its turn (the fold keeps the rows' `turnStartedAt` beside it, so a wait or
an ownership gap does not erase the start), and `isWorkingRun` and
`isActivePhase` are deleted with the host sites above,
which read `working`, `runStartedAt` and `durableOutcome`; a run listing
entry's `status` became `outcome` (the view's `durableOutcome`), so `texra
history` no longer reads an outcome off the status word. The TUI's Ctrl-C
predicate reads `working`, not `actions`: it asks whether a turn is in
progress, and `actions` offers a stop at a wait too, where the TUI's exit
leaves the run resumable. Still open: `runsHere` and the
`ownedHere && isLiveRun` sites, `handlers.ts`'s `durableOutcome ?? CANCELLED`
and `/clear`'s `isTranscriptSettlementPhase` read, which change meaning under
slice 3 (the service holds the run) and land with it._

### C. Host attachment and the CLI process lifecycle

Audit verdict: a dual by ruling (the service is a client of the claim model),
and a lifecycle with no owner. Under O1 the dual collapses: a window either
holds the store's lock or attaches to the process that does. The fallback rule
written in `packages/desktop/src/main/desktopProjects.ts:292-297`,
`packages/extension/src/extension.ts:461-475` and
`packages/cli/src/runtime/cliService.ts:172` becomes one function in the app.

| Fact                          | Keep                                                              | Delete                                                                                                                                                                                                                                          | Files |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Which process runs this store | the lock holder; a window attaches or is read-only                | the per-host fallback decision (three sites); `serviceProjectState`'s 8-attempt CAS once the store has one writer                                                                                                                               | 4     |
| We are leaving                | `TuiSession.leaving`                                              | `claim.stop` as a reason copy, `stopRequested`, `exitConfirmationExpiresAt` as a second armed flag; the headless `shutdownRequested`/`admitted`/`ended`/`shutdownStatusArmed`/`shutdownLaunchAborted`/`interrupted` set, replaced by one `Exit` | 3     |
| The exit code                 | one `setExitCode`, written through `settleExitCode`               | the seven direct `runExitCode =` writes; the nine `process.exit` sites outside the one owner                                                                                                                                                    | 6     |
| Signal policy                 | one registry in `initPlatform`; TUI and `serve` register policies | the five install sites (`initPlatform.ts:188-210`, `foregroundCommand.ts:37`, `sessionExitController.ts:136-145,254-266`, `commands/service.ts:92-98`)                                                                                          | 4     |

Today's defect: `reportRunFailure` (`packages/cli/src/chat/chatSessionController.ts:417-420`)
writes exit code 0 whenever a stop was requested, `leaving` included, so a run
that fails while the user quits exits 0 and bypasses `settleExitCode`.

Acceptance: `grep -rn 'process.exit(' packages/cli/src` returns one file;
`grep -rn "process.on('SIG" packages/cli/src` returns one file.

_Landed 2026-11-04 (rows two to four; the first waits for slice 3): the
chat's exit is one `Deferred<ChatExit>` on `TuiSession` (`leaving` is its
done-state), completed by the exit controller's `leave` on every path, and
`claim.stop`, `stopRequested`, `askStop` and the teardown memo are gone; a stop
asked during a launch is a program that waits for the claim's `launched`
and then asks the session, so the three re-reads of the flag went with it.
The exit code is the claim's, written only by `settleExitCode` (`TuiSession.
exitCode` reads it, or the dead-view failure), and `process.exit` lives in
`initPlatform.ts` alone (`cliExit`, `leaveAtOnce`): the TUI's three sites,
the self-update's two and the platform's own all go through it. Signals are
held as policies through `holdSignals` (`processSignals.ts`, the one
`process.on('SIG…')` site): the platform, a foreground child, `texra serve`
and the chat TUI each hold theirs, and the newest holder answers, so the
hand-off and the five install sites are gone. Headless, the six shutdown
flags are the launch fiber's `Exit` plus `stopRun` (the launch's
interruption until the session accepts the run, its stop after) and one
`shutdown` boolean the finalization's drain needs. Today's defect is gone by
shape: a failure is the claim's exit code before anything asks whether the
chat is leaving._

### D. Model, route and retry

Audit verdict: partial. The run model and gate cooling have owners; retryable,
the used-up plan and declined routes do not.

| Fact                     | Keep                                             | Delete                                                                                                                                                                                  | Files |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Retryable, and by whom   | llm's verdict, recorded on the `failed` row (O8) | `offersRetry`, `isCredentialRetryFailure`'s status-code read, the forced `userRetryable: true` in `providerErrorFormat.ts:206` and `ModelInvoker.ts:728`, `failureInfo`'s `unsent` mask | 10    |
| Which plan ran out       | `classification.kind`                            | `credentialSwitch`'s re-derivation from `bound.route` (`routeDecision.ts:186-205`), `getExhaustionReason`'s decode                                                                      | 4     |
| Routes this run declined | the row fold `RunState.declinedRoutes`           | the launch snapshot `run.declinedRoutes` (`AgentRun.ts:286`), which `modelSwitch.ts:70,93` reads while `:62` binds with the fold's set                                                  | 9     |
| The attempt's backend    | `decideRoute` takes it in and returns it         | `request.backend ?? decision.backend`, `binding?.backend ?? state.backend`, `servingBackend` ignoring the route                                                                         | 4     |
| The fallback mode        | one table in `decideRunModel`                    | `CLI_MODEL_FALLBACK_MODE_BY_REASON` and the `?? 'reject'` tail                                                                                                                          | 4     |
| A failure's identity     | one `ProviderError` from llm, carried as a value | the side-channel `attachProviderError` on an `Error`, `normalizeProviderError`'s recovery of it, `classifyAgentError`'s re-classification                                               | 10    |

Acceptance: after a quota fallback, `admitSwitch` and the bind decide over
the same set; `grep -rn 'statusCode === 401' packages/harness/src` is empty.

### E. The parent edge

Audit verdict: partial. Rows and view are both read as the attached parent in
one job: `packages/harness/src/agent/followUp/Inbox.ts:314` refuses by the
rows, `:318` stamps `relation` from the view, and
`followUpMessages.ts:219` recomputes `relation` from the view when comparing
a retry with its stored row, so a retry after a detach fails with a spurious
`Conflict`.

| Fact                | Keep                                               | Delete                                                                                                                    | Files |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- |
| The attached parent | `facts.parent` from the rows, in every writing job | `Inbox.parentOf`, `runRelation`'s view lookup, `ChildRuns.parent`, `LiveRun.parent`; `unbornParent` goes with O5's detach | 9     |

Acceptance: `grep -rn 'parentId' packages/harness/src/agent` hits readers of
`facts.parent` and renderers only.

_Landed 2026-11-04: one rows walker, `ancestryRows` (`runRelation.ts`), serves
the inbox's stamp, the activation's grants and the detach's kept grants
(`grantSource` in `approvalBypassKind.ts`, F's one item); `sentBefore`
compares against the stamped relation, `ChildRuns.parent` reads the rows,
`LiveRun.parent` and `Inbox.parentOf` are gone; the registry's
`attachedParent` stays the in-process tree a stop cascades over. `unbornParent`
waits for O5's slice._

### F. Approval grants

Audit verdict: not this disease. One evaluator, one vocabulary. One item goes
with E: `grantsKept` reads the ancestry from the view
(`runRegistry.ts:602-609`) while `activationRows` reads it from the rows
(`runApprovalQueue.ts:128-141`). A claim that the guarding ratchet
(`src/test-kernel/architecture/approvalPolicyAuthorityRatchet.vitest.ts`)
names a missing file was checked on 2026-11-04 and withdrawn: every path it
lists exists.

### G. Vocabularies

The provider id list is spelled in `packages/harness/src/shared/schemas/prompts.ts:114`,
`packages/harness/src/shared/schemas/runFacts.ts:101`,
`packages/harness/src/shared/state/providerSettings.ts:24`,
`packages/texra/src/shared/settingsView/settingsViewMessages.ts:175` and
`packages/llm/src/providers/providerPlugins.ts:62`; the command catalog in
`packages/texra/src/shared/commands/catalog.ts:45` and
`packages/texra/src/tools/setup/InvokeCommandTool.ts:18`. Each becomes
one source and derived types (O10). _The command list landed 2026-11-04: the
catalog's `setupInvokable` column is the one list, and the tool derives its
allowlist from it. The provider list waits on a browser-safe llm entry:
`shared/schemas` and the settings webview cannot import llm's root, which
is not browser-safe, so deriving it is a packaging decision first._ The run actions of
`packages/harness/src/shared/schemas/run.ts:114` were listed here beside
`openGuiWindow.ts:106`, which is the host request kinds, an unrelated set; no
second spelling of the run actions was found, so that pair is dropped.

## Order of work

Each slice is one PR, with the ledger amendment it needs in the same PR, the
fixtures regenerated, `npm run typecheck`, `npm run test:pure`, and the
checks below green. No slice keeps two representations "for now".

1. **Checks** (under "Checks"): the three counting checks with today's
   numbers as their baselines, so every later slice shows its count falling.
2. **A2 + A3: the stop reason and the abort kind** (O2, O3). Smallest stored
   change, largest classifier deletion; amends the one-outcome ruling and M8.
   _Landed 2026-11-04: `run.end.reason`, the halt without `reason`, the fold
   reading the end row; the `abort` kind, `isUserAbort`, `AGENT_ERROR_OUTCOME`,
   `outcomeFromCause`'s `seen` and the lost-claim branch gone. `Attempt.closed`
   stays as the fold's projection of the one field._
3. **A1: ownership** (O1). The lock, the deletions in the "who may run" row,
   the service as lock holder, the fallback rule in one place (C, first row).
   Amends D4 and M3.
4. **A4 + A5: one resume, one refusal, children through tool results** (O5).
   Amends the session-messaging note.
5. **A6 + A7: no ownerless stop, list at open** (O4). Deletes the setting.
6. **B: the fold fields and the host deletions** (O6).
7. **C: the CLI exit owner** (O7).
8. **D: llm's verdict and the row fold** (O8).
9. **E, F, G** (O9, O10): small, independent, last.

Slices 2 and 3 are the ones that change the shape; 4 to 9 follow from them.
Slice 3 is the one with a product cost (two processes may no longer drive one
project's runs at once) and is the one O1 decides.

## Checks

Three counting checks, each shrink-only against the merge base like the
core-quality rules, in `scripts/check-core-quality.mjs`'s style:

- **Predicate spread.** For each predicate in a short list (`Cause.hasInterrupts`,
  `Cause.squash`, `isTerminalOutcomePhase`, `isLiveRun`, `ownedHere`,
  `readOnly`, `parentId`, `withPerKeyLane`, `toErrorMessage`),
  the number of files that contain it. A fact decided in more files than
  before fails.
- **Vocabulary overlap.** Two `Schema.Literals` or `as const` string sets in
  different files sharing three or more members. The 2026-11-03 scan found
  25 pairs; the provider list accounts for 11.
- **Fix churn per area.** A monthly report, not a gate: fix commits by scope
  and by the keyword buckets in this note. An area over ten fixes re-opens
  its rulings in the next design pass (rule 4).

And one exemption: files the ratchets name as reducers or fact readers
(`runRows.ts`, `runState.ts`, `runFacts.ts`, `runRowReads.ts`,
`sessionViewUpdate.ts`) are exempt from the 400-line cap, so a fact never
moves away from its reader to satisfy a size rule.

Landed 2026-11-04: `npm run check:fact-spread` (`scripts/check-fact-spread.mjs`,
in `gate:invariants`) holds the first two against the merge base, the
exemption is `FACT_FILES` in `scripts/core-quality-measure.mjs`, and
`npm run report:fix-churn` prints the third. At that day's `main`:
`Cause.hasInterrupts` 56 files, `Cause.squash` 84, `isTerminalOutcomePhase`
19, `isActivePhase` 9, `isLiveRun` 17, `ownedHere` 8, `readOnly` 19,
`parentId` 51, `withPerKeyLane` 25, `toErrorMessage` 194; 26 overlapping
pairs of files (the provider list 3, the approval vocabularies 3, the status
sets `completed`/`failed`/`cancelled` and `cancelled`/`failed`/`skipped` 10,
the finish reasons and the llm wire enums 4, the rest 6). The month's fix
churn: 171 fixes, 31 in stop/resume/ownership, 18 in model/retry/route, 15 in
desktop/windows, 6 in view/fold, 2 in cli/tui: three areas over ten.
`isActivePhase` left the list with the predicate (area B).

## Surface inventory

What each slice must clear before it opens, counted at `b411a6d6` outside
tests:

| Surface                                         | Slices | Sites                                                                                                                                                                     |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.stop` request callers                      | 2, 5   | 14 (`runHandle.ts`, CLI `App.tsx`, `ScriptStagePopup.tsx`, `chatSessionController.ts`, `tasks.ts`, `serviceSession.ts`, `RunHeader.ts`, `ScriptStage.ts`, three examples) |
| `ResumeRefusal` / `ResumeRefused` readers       | 4      | 15 files; hosts branch on `blocked` only (`handlers.ts:516`, `runActionPolicy.ts:33`)                                                                                     |
| `FollowUpFailureReason` wording                 | 4      | 10 files                                                                                                                                                                  |
| `resumeBlocked` and `interruptedTasks` readers  | 5      | 23 and 22 files (settings row, three composition roots, the banner copy)                                                                                                  |
| `RESULT_WAITING` / `heldFor` readers            | 4      | 7 files                                                                                                                                                                   |
| `detachActiveChildren` / the stop setting       | 4      | 10 files                                                                                                                                                                  |
| `declinedRoutes`                                | 8      | 9 files, 36 sites                                                                                                                                                         |
| `userRetryable` / `credentialSwitch`            | 8      | 10 and 13 files                                                                                                                                                           |
| Service protocol `task.request` / `task.resume` | 3, 4   | `packages/texra/src/controllers/server/protocol.ts:222,236` (a stop travels in `task.request`; there is no `task.stop`)                                                   |
| Fixtures pinning stop shapes                    | 2, 4   | `golden-1.0.sql` (16 lines), `goldenStore.vitest.ts`, `crashConformance.ts`, `sessionEvents.vitest.ts`, `AgentRunLifecycle.vitest.ts`                                     |
| Guidance to rewrite                             | 2, 3   | `packages/harness/AGENTS.md` "Run loop architecture" and "Storage format"; the error-pipeline note's Abort row; the ledger entries named per slice                        |

## Verified

- The four stop representations and their sites: the reviews of 2026-11-03
  over `resumeRun.ts`, `runRegistry.ts`, `executeAgent.ts`,
  `AgentRunLifecycle.ts`, `runLifecycle.ts`, `inFlight.ts`, `runLaunchGuard.ts`,
  `childRunLoop.ts`, `toolUseDispatch.ts`, `ModelInvoker.ts`,
  `run/invocation.ts`, `run/compaction.ts`, `agentErrorClassification.ts`.
- The audits' line citations for B, C, D and E were re-read at the cited
  lines before they entered this note.
- Peers: pi-durable's README ("One process owns a storage at a time; there is
  no cross-process locking"; a replay-safe tool reruns, else the model gets an
  `interrupted` error result; `restartLimit` 5); Codex's `handle_task_abort`
  (cancel token, 100 ms grace, an interrupted-turn marker recorded, no lease);
  pi's `handleRunFailure(error, signal.aborted)` as its one stop-or-failure
  site and a JSONL session tree with no lock and no abort marker.
- History: 709 commits from 2026-10-04 to 2026-11-03; 155 fixes; 33 on
  stop/resume/ownership; 14 since 2026-10-27; the notes of 2026-09-20,
  2026-10-23, 2026-10-24, 2026-10-27 and 2026-10-28 each name the problem.
