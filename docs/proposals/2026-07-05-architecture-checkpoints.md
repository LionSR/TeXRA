# Architecture Checkpoints (2026)

> **Status:** Running checkpoint record for the 2026-07 architecture and
> foundation debt program. Checkpoints append sections here; they do not create
> one-off checkpoint files.

Sources of truth for the current program:

- [`2026-07-03-tech-debt-audit.md`](./2026-07-03-tech-debt-audit.md)
- [`2026-07-03-session-scoped-runtime-architecture.md`](./2026-07-03-session-scoped-runtime-architecture.md)
- GitHub trackers #6951, #6953, and #6981.

## 2026-07-06 - Checkpoint B before Stage 4

**Verdict:** Stage 4 may start, but Stage 5 may not. Stages 3a-3c have enough
session-owned runtime and persistence structure for the interactions port to
land: #7284 made native subagents suspend at WAITING without terminal cleanup,
and #7292 moved completed-run summary todos behind a transcript-sidecar reader
with a ledgered legacy fallback. The next work is therefore not another
persistence slice and not bus deletion; it is the CLI-first `HostInteractions`
port from #6967.

This checkpoint re-read #6979 against `main` at `c9b3b86fa`. The approval and
retry machinery has not collapsed by accident: the three mechanisms named in
the proposal are still live and still point to one missing abstraction.

### Stage 4 And F2 Sequence

F2 must land with the host implementation it simplifies, not as a separate
pre-flight branch and not after Stage 4 has already rewired the same files.
The concrete order is:

1. **Core contract + CLI implementation.** Add session-owned
   `HostInteractions` and the shared request bookkeeping, then implement the
   CLI port first. This PR deletes the TUI `host.emit` monkey-patch in
   `packages/cli/src/chat/tui/state/subscribeApprovals.ts` and routes CLI
   decisions through the session interaction resolver. Extension and desktop may
   keep adapters around their current UI handlers in this first PR, but those
   adapters are migration scaffolding and need #6981 rows if they keep old
   resolver names alive.
2. **Desktop implementation + desktop host factory.** Rewire
   `packages/desktop/src/main/desktopAgentExecution.ts` once: construct the
   desktop `HostInteractions` implementation together with the desktop host
   factory changes. Do not first add a factory that still forwards the old
   show/resolve bus keys and then rewrite it again.
3. **Extension implementation + extension host factory/message-handler pass.**
   Rewire `packages/extension/src/progressView/ProgressViewProvider.ts` and
   `ProgressViewMessageHandler.ts` in the same PR that turns the extension
   progress view handlers into an interaction implementation.
4. **Only after all three host implementations land, start Stage 5.** Stage 5
   deletes the event keys and projector scaffolding. It is not an adapter PR.

This ordering is the least-churn path through the shared files named by #6979:
desktop execution and both progress-view message handlers are each rewritten
once for their host implementation, not once for factories and once again for
interactions.

### Current Interaction Evidence

- `BasePromiseCoordinator` still owns `pDefer`, `pTimeout`, replacement
  cancellation, first-wins resolution, and resolve-event cleanup for plan,
  proposal, and retry requests. These mechanics should move into the
  interactions port's shared pending registry rather than be wrapped by another
  coordinator layer.
- `RunCoordinatorBridge` still holds the process-wide request-id index that lets
  host callbacks resolve plan/proposal/retry requests outside the async
  `RunContext`. Stage 4's resolver is the same idea with the correct owner:
  `session.interactions.resolve(requestId, result)`.
- `ApprovalRequestHandler` still owns a separate `pending`/`delivered` replay
  registry for progress-view prompts. Stage 4 must make this data a view of
  `session.interactions.pending()`, not a second registry beside it.
- The CLI TUI still intercepts approvals by replacing `host.emit` in
  `installTuiApprovals`. It handles bash, plan, proposal, retry, external
  inquiry, and user-question events there, while tool-edit goes through the
  separate platform approval handler. The CLI-first Stage 4 PR should delete
  this monkey-patch rather than preserve it as an adapter.
- Bash/tool-edit bypass state still rides the approval queue/progress-event
  machinery. The `updateBashApprovalBypassState` path is effectively CLI-only
  today; Stage 4 should either make that explicit inside the CLI
  implementation or fold it into shared interaction bypass state. It is not an
  early deletion candidate.
- Extension and desktop already have a session in reach at legitimate resolve
  sites. Desktop mostly calls `this.session.coordinators`; extension still holds
  a coordinator dependency in `ProgressViewMessageHandler`. Neither host needs a
  process-global resolver after Stage 4.
- External inquiry remains thread-shaped. It must not be flattened into the
  same yes/no result shape as bash or plan approval. It also has two replay
  sources today, in-memory pending prompts and durable thread hydration, so
  `HostInteractions` should expose a durable thread handle or equivalent
  host-owned thread operation and must avoid duplicate cards on reload.

### Retry Design

`requestRetry` is the host interaction surface for the error-pipeline retry
owner; it is not a second retry owner. The Stage 4 port owns presentation,
pending/replay state, and a single settlement path. The retry policy owner
remains the model/retry layer described in `2026-06-10-error-pipeline-and-ownership.md`
T2:

- SDK-internal retry settings are still a separate T2-1 task. Stage 4 must not
  change model-handler retry counts.
- `RetryState` remains the visible in-run retry loop. `HostInteractions`
  returns `retry` or `cancel` plus host-specific fields such as CLI API-mode
  switching; it does not decide whether provider errors are retryable.
- Desktop's current retry behavior is still intentionally weaker than the
  extension's panel. Stage 4 may first preserve the current desktop
  cancel-on-show behavior, but the desktop host implementation must make that
  policy explicit rather than silently dropping retry requests.

### Stage 5 Go/No-Go

Stage 5 is **no-go** at this checkpoint. The bus still has live consumers in
all three host families:

- **Interaction RPC:** show/resolve keys are registered through
  `UIEvents.ts`, progress-backend UI config, extension/desktop message
  handlers, CLI approval dispatch, tool-edit approval, user question, and
  external inquiry handlers.
- **Legacy run projections:** `SessionRunFactProjector` and
  `LegacyProgressEventProjection` still project session facts to progress-event
  keys for CLI, progress backend, child streams, and tests. These are correct
  migration scaffolds until hosts consume the session plane directly.
- **Desktop fan-out:** desktop still re-emits runtime events onto the process
  bus before feeding the per-window bridge. This is the remaining multi-window
  hazard Stage 4/F2 must route through a per-window implementation before Stage
  5 can delete the process bus path.
- **Display and app lifecycle:** extension and desktop still subscribe to
  status, usage, stream removal, goal changes, GitHub/subscription changes,
  settings refreshes, file-decoration/output events, and requestShow/open-file
  events on the process bus. Those are either Stage 5 run-fact deletion targets
  or later app-signal work; they are not safe early deletions.
- **Typed stage compatibility:** `setTaskState`, `updateRoundStage`, and
  `updateStreamStatus` remain live host inputs in CLI, desktop, progress
  backend, snapshot restoration, and tests. Their compatibility projections
  remain ledgered until the Stage 5 switchover removes their consumers.

No additional Stage 3 cleanup is mandatory before Stage 4. The completed-run
todo fallback introduced by #7292 is already in #6981. The remaining safe
cleanup class is local to Stage 4 PRs themselves: if a PR removes one old
resolve path, it should delete the corresponding adapter and test in the same
branch rather than leaving a pass-through helper behind.

### Stage 4 Test Plan

The first Stage 4 PR needs focused tests before broad suites:

- a host-neutral `HostInteractions` registry test for pending requests,
  first-wins resolution, replacement cancellation, timeout, and
  `cancelForStream`;
- CLI tests proving approvals no longer depend on mutating `host.emit`, while
  preserving yolo/never policy, API-mode retry switching, modal cancellation,
  and human-input refusal behavior;
- regression tests for session isolation: two sessions can hold same-shaped
  request ids without cross-resolution, and per-session prompt serialization
  does not block another session;
- existing coordinator and progress tests:
  `PromiseCoordinators.vitest.ts`, `runCoordinators.vitest.ts`,
  `TuiApprovalRetry.vitest.mts`, `ApprovalQueue.vitest.mts`,
  `ProgressBackend.vitest.ts`, and the desktop/extension message-handler tests
  touched by the host-specific PR.

Stage 5 needs an additional deletion-gate suite before each bus-family removal:
`SessionRunFactProjectorEquivalence.vitest.ts`,
`LegacyProgressEventProjection.vitest.ts`, `SessionEventHub.vitest.ts`,
`EmitRuntimeEvent.vitest.ts`, `StreamSnapshotStore.vitest.ts`,
`DesktopAgentExecution.vitest.mts`, `DesktopProgressEventBridge.vitest.mts`,
`TuiStateAndFocus.vitest.mts`, and `RunProgressRenderer.vitest.mts`. Add a
multi-window desktop isolation test and a legacy-vs-session backend equivalence
test before removing the corresponding projectors. Do not retire the projector
equivalence test until the projector and its legacy keys are actually gone.

## 2026-07-05 - Checkpoint A after stages 0-2

**Verdict:** Stage 3 remains a correctness track, not pre-payment. The
maintainer pre-flight answer recorded on #6978 is to "do the wisest thing" for
desktop; this checkpoint interprets that as multi-window desktop being
supported/intended unless current code proves it mechanically impossible.
Current code supports the go decision: each desktop progress bridge constructs a
fresh `SessionHandle` for its BrowserWindow
(`packages/desktop/src/main/desktopAgentExecution.ts:232`), while
cross-window active-execution aggregation is explicit
(`src/agent/runtime/SessionHandle.ts:254`).

Stages 3a and 3b now have implementation PRs after #6978; Stage 3c remains the
next Stage 3 item. Stage 4 and F2 stay coupled behind Checkpoint B (#6979).
Foundation Checkpoint C (#6980) is absorbed by this pass and should close when
#6978 lands.

### Re-verified Evidence

- **L1 still live:** `createRunTrace` still defaults to the process default
  stream-log store (`src/transcript/runTrace.ts:32`), and every
  `ProgressViewState` constructor still installs its store as that default
  (`src/controllers/progressView/backend/ProgressViewState.ts:155`). The
  default getter/setter live at `src/transcript/StreamLogStore.ts:824`.
- **L2 still live:** each desktop backend subscribes to the process bus
  (`packages/desktop/src/main/desktopAgentExecution.ts:299`), and desktop
  runtime events still hit `bus.emit` before the per-window bridge
  (`packages/desktop/src/main/desktopAgentExecution.ts:851`).
- **L3 drifted but still live:** `StreamStatusService` is now the process
  default `StreamStatusMachine`, not the old registry alias
  (`src/agent/runtime/StreamStatusService.ts:303`). Delete-all still clears a
  window's status view through its backend state
  (`src/controllers/progressView/backend/ProgressViewState.ts:343`).
- **Child-stream activation ordering is no longer active evidence:** #6993
  fixed the ordering. Child streams now attach the session trace and assert that run subscribers
  are present before activation (`src/tools/delegation/childStream.ts:98-115`),
  then track the handle before emitting `setActiveStream`
  (`src/tools/delegation/childStream.ts:143-175`).
- **Stage 3a remains scoped to the remaining registry/process-output bus facts:**
  child parent/status facts are still emitted from
  `src/agent/runtime/executionRegistry.ts:203` and `:678`; process output still
  emits `updateProcessOutput` at `src/agent/runtime/ProcessOutputPoller.ts:88`
  and `:216`.
- **Stage 3b citation drift resolved by #6965:** `handleSetTaskState` no longer
  owns run-start side effects; hint clear, stream-state ensure,
  finished-child reset, interrupt pruning, and the per-stream metadata patch
  moved to the `-> running` transition.
- **Round encoding collapsed by #6965:** `r<N>` remains only the internal stage
  id. Live round status is the typed `stage.start` payload
  (`kind:'round'`, `index`, `total`), while `ExecutionProgress` counters, the
  workflow round subagent-progress producer, and the round/turn half of
  `conversationProgress` were removed.
- **Stage 3c citation drift:** `detectWaitingStreams` moved to
  `src/agent/storage/detectWaitingStreams.ts:59`; desktop restart repair lives
  at `packages/desktop/src/main/desktopAgentExecution.ts:753` with the catch
  fallback at `:803`; `ExecutionKVStore`'s warn-vs-null read policy lives at
  `src/agent/storage/ExecutionKVStore.ts:192`.
- **Tab deletion scope corrected:** `ProgressViewState.clearStream` still
  deletes stream logs and stream data but not `executions/{id}`
  (`src/controllers/progressView/backend/ProgressViewState.ts:322`). Goal
  entries are now explicitly forgotten by the extension and desktop delete
  paths, so Stage 3c should keep that as regression coverage rather than cite it
  as an open leak.

### Simplification And Ledger

- The now test-only `StreamStatusRegistry` compatibility alias was deleted in
  this checkpoint. Tests now import `StreamStatusMachine` directly, and
  `rg StreamStatusRegistry src packages` is empty.
- Stage 2.5 already removed the `clearRunningSubstate` second write path; the
  only production `phases.set` writer in the status machine is the transition
  path (`src/agent/runtime/StreamStatusService.ts:135`).
- The Stage 1 `SessionRunFactProjector` remains live migration scaffolding:
  launch still attaches it (`src/agent/runtime/AgentLaunchContext.ts:343`), and
  Stage 5 owns its deletion with the bus keys.
- #7042's storage-layout alias hop has fired and was executed. The old
  production names `TASK_RUNS_DIR`, `MEMORY_STORAGE_ROOT`, and
  `LEGACY_RUNS_DIR` grep to zero; canonical exports are
  `RUNS_STORAGE_DIR` / `MEMORY_STORAGE_DIR`
  (`src/platform/defaults/workspaceStorage.ts:18`), with the legacy run fallback
  still explicit (`src/platform/defaults/workspaceStorage.ts:85`).
- The #7043 `src/shared/toolUse.ts:85` legacy `isError` sniff is already in
  #6981 with an age-based D3 trigger. It stays until pre-F5 persisted
  tool-use logs are outside support.
- No Stage 0 tier-3/tier-4 shim trigger has fired. Those rows remain active
  until Stage 5 and the age windows named in #6981.

Temporary hop deleted since Stage 0: the F9 storage-layout alias/bypass hop
from #7042, plus the Stage 2 `StreamStatusRegistry` alias in this PR. The answer
is not "none."

### Census

Counts are from current `main` at `509fdbe6c` plus the alias deletion in this
checkpoint where noted.

- Pass-through methods: baseline 33 / 10 files; current 35 / 10 files. Raw
  count is +2. Inspected hits are boundary/adaptor wrappers or scheduled owners
  (`InterruptRegistry`, progress backend, host secrets/storage). No extra
  deletion is safe inside #6978; Stage 3 PRs must be net-negative on this meter.
- Identity wrappers: baseline 9; current 13 by the strict named-function meter.
  Raw count is +4. The excess is mostly named dependency or UI helper
  boundaries; do not churn in this checkpoint.
- Re-export-only barrels: baseline 23; current 49 by a repo-wide `index.ts`
  export-only scan. The wider scan includes host/frontend package barrels absent
  from the original targeted meter. No new barrels in Stage 3; delete touched
  empty or compatibility barrels only.
- `ensureRoundData` refs: baseline 14; current 14 non-test refs.
  Non-increasing. Stage 3b (#6965) moved runtime/UI round progress to typed
  round stages, but output-file round ownership remains in the output pipeline;
  this meter therefore stays at 14 without adding a wrapper layer.
- `syncStream*` refs: baseline ~100; current 50 non-test refs for
  `syncStreamLog`, `syncFullView`, `syncStreamContent`, and `syncStream`.
  Decreased. Stage 3a/3c should keep this non-increasing while transferring
  ownership, not wrapping it.

The raw width meters are warnings, not permission to add more width. For the
next three stage PRs, the acceptance bar is: no new pass-through layers, no new
barrels, and a stated count delta for any touched meter.

### Remaining Order

1. Stage 3a (#6964): completed by the Stage 3a PR. It lands session facts,
   child/process arms, and session-owned transcripts/follow-ups. The corrected
   child-stream and follow-up citations above were the implementation evidence;
   do not re-litigate #6993's ordering fix.
2. Stage 3b (#6965): completed by the Stage 3b PR. It lands `RunDescriptor`,
   config persistence, typed round stages, and the transition-owned run-start
   side effects. Treat the metadata-patch O(N) claim as stale; the side effect
   is now a per-stream patch.
3. Stage 3c (#6966): persistence facade, atomic delete, orphan sweep,
   `deriveResumability`, and shared restart repair. Split by task bullets if the
   PR gets too large.
4. Checkpoint B (#6979): mandatory before Stage 4. It owns the Stage 4 + F2
   combined plan for `desktopAgentExecution.ts` and the two message handlers.
5. Stage 4 (#6967), then Stage 5 (#6968). F6 (#6976) waits until Stages 3a-3c
   have landed. F2 (#6972) waits for Checkpoint B's combined plan.

Next periodic checkpoint trigger: #6979 after Stages 3a-3c land, or
2026-07-12 if Stage 3 is still open and more hardening merges have accumulated.

## 2026-07-05 - Ledger gap-fill (#7100)

**Verdict:** #7100's full-repo sweep (evidence pinned `262078f`) found eight
live, pre-existing legacy read paths with no row in the #6981 ledger and no
tracking issue. All eight get an explicit horizon here. A maintainer should
fold the table below into the #6981 issue body — this PR's automation does
not have write access to edit or comment on that shared tracking issue.

**Correction (2026-07-05, PR #7227 review):** the `StreamTabStore.ts` row
below was originally marked `executed` — deleted outright on the theory that
no live migration depended on it. Review caught that this was inconsistent
with the sibling `LegacyLogMessageSchema` row immediately above it: both read
paths exist purely because of the _same_ one-run-per-tab refactor (#3061,
2026-04-19), and there is no retention policy or GC for `streamData/`
(`docs/proposals/2026-07-03-session-scoped-runtime-architecture.md`), so a tab whose
`legacyInstructions.json`/`runInstructions.json` predates #3061 can still be
reopened today without ever having had its initial user message written into
the log. The read (now on `StreamSnapshotStore.readLegacyInstruction`, called
from `ProgressViewState.load()`) was restored — trimmed of the LRU-cached
`StreamTabStore` class wrapper and the now-unnecessary on-disk
`runInstructions.json` → `legacyInstructions.json` migration step (both keys
share one record shape, so the read just checks both) — and this row now
follows the same age-based horizon as its sibling.

| Item                                                                                                                                                                                                                            | Removal trigger                                                                                                                                                                                                                                                                                                                                                                    | Status                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `LegacyLogMessageSchema` union arm (`src/shared/schemas/log.ts:108-145`, consumed `StreamLogStore.ts:721`)                                                                                                                      | Explicit maintainer sunset decision recorded in #9422, superseding the previously undated D3 age gate for this pre-#3061 format                                                                                                                                                                                                                                                    | executed 2026-08-02                           |
| `migrateLegacyContextFileFields` (`src/shared/schemas/fileFields.ts:5-84`; call sites `proposalInput.ts`, `mainView/state.ts`)                                                                                                  | Age-based: delete once persisted execution configs written before the reference/auxiliary→context rename are outside the supported persisted-config retention window; D3 greps call sites for zero remaining legacy-keyed configs before deleting                                                                                                                                  | pending, D3 (#6984)                           |
| `LegacyRunUsageAccumulatorSchema` arm (`src/agent/core/usage/RunUsageAccumulator.ts:52-95`)                                                                                                                                     | Age-based, same persisted-run retention window as the other tier-3/D3 run-record shims; delete once persisted flow records predating the `latestUsage` collapse are outside support                                                                                                                                                                                                | pending, D3 (#6984)                           |
| Filename-era output grammar (`legacyWorkflowOutputStem`/`midEraWorkflowOutputStem`/`legacyWorkflowOutputRoundRegex` in `src/shared/constants/legacyWorkflowOutput.ts`) + `.tex`/`.xml` resume fallback (`runReflectionFlow.ts`) | The resume fallback follows the persisted-run retention window because it only resumes pre-#3082 executions. Workspace readers may retire no earlier than 2027-04-21 after checking for pre-refactor files. `compareCommands.ts` remains a live filename-era writer, so deleting the grammar also requires a replacement naming decision and a dated post-writer horizon in #6984. | pending, D3 (#6984); ownership moved by #8347 |
| `readLegacyInstruction` (`StreamSnapshotStore.ts`; formerly `StreamTabStore.ts`, 145-LoC legacy per-run-instruction reader) + `LegacyInstructions*` schema support in `streamData.ts`                                           | Explicit maintainer sunset decision recorded in #9422, superseding the previously undated D3 age gate for this pre-#3061 format                                                                                                                                                                                                                                                    | executed 2026-08-02                           |
| `tool`→`toolName` transform (`src/shared/schemas/progressView/data.ts:48-67`)                                                                                                                                                   | Explicit maintainer sunset decision recorded in #9422, superseding the previously undated D3 age gate for this historical payload alias                                                                                                                                                                                                                                            | executed 2026-08-02                           |
| workspaceState→memento read-through (`packages/extension/src/common/state/worktreeMemento.ts:44-47`)                                                                                                                            | Age-based: delete the per-key workspaceState fallback once every shared key has migrated to the namespaced `globalState` bucket across all supported VS Code workspaces (one release window after the last shared key is added); D1 sweep confirms zero remaining workspaceState-only reads                                                                                        | pending, D1 (#6982)                           |
| `terminalStatus`→`outcome` derivation + optional `delegationDepth` (`src/agent/storage/ExecutionKVStore.ts:53-83`)                                                                                                              | Same age-based window as the #6981 tier-3 `terminalStatus` legacy-mapping row: delete once persisted execution meta files written before the `outcome`/`delegationDepth` fields are outside the supported persisted-run retention window. Code untouched by this PR — an in-flight PR owns `ExecutionKVStore.ts`                                                                   | pending, D1 (#6982) (tracks tier-3 row)       |

The pre-#3061 nested round sidecars and archived instruction reader, the
`LegacyLogMessageSchema` arm, and the `tool`→`toolName` transform were retired
on 2026-08-02 under the explicit maintainer sunset decision recorded in #9422;
that decision superseded the earlier D3 age gate and the nested-sidecar date of
2026-08-04. The historical `propose_agent`, `propose_workflow`, and
`resume_agent` delegation names were retired with them. TeXRA now reads the
current stream protocols directly.

Already covered elsewhere (no new row): `migrateSharedState` arms, `goals:
odysseys:*`, `MODEL_LIST_VERSION` ladder (#6984), `DiffResult` legacy schemas
(#7068), `toolUse.ts:85` `isError` sniff (#7043).
