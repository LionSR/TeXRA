# Architecture Checkpoints (2026)

> **Status:** Running checkpoint record for the 2026-07 architecture and
> foundation debt program. Checkpoints append sections here; they do not create
> one-off checkpoint files.

Sources of truth for the current program:

- [`tech-debt-audit-2026-07.md`](./tech-debt-audit-2026-07.md)
- [`session-scoped-runtime-architecture.md`](./session-scoped-runtime-architecture.md)
- GitHub trackers #6951, #6953, and #6981.

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
  (`src/shared/progressView/backend/state/ProgressViewState.ts:155`). The
  default getter/setter live at `src/transcript/StreamLogStore.ts:824`.
- **L2 still live:** each desktop backend subscribes to the process bus
  (`packages/desktop/src/main/desktopAgentExecution.ts:299`), and desktop
  runtime events still hit `bus.emit` before the per-window bridge
  (`packages/desktop/src/main/desktopAgentExecution.ts:851`).
- **L3 drifted but still live:** `StreamStatusService` is now the process
  default `StreamStatusMachine`, not the old registry alias
  (`src/agent/runtime/StreamStatusService.ts:303`). Delete-all still clears a
  window's status view through its backend state
  (`src/shared/progressView/backend/state/ProgressViewState.ts:343`).
- **Child-stream activation ordering is no longer active evidence:** #6993
  fixed the ordering. Child streams now attach session trace/projector
  subscribers before activation (`src/tools/childStream.ts:83`) and assert that
  before emitting `setActiveStream` / `setTaskState`
  (`src/tools/childStream.ts:98`).
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
  (`src/shared/progressView/backend/state/ProgressViewState.ts:322`). Goal
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
tracking issue. One turned out to be an outright-dead file, deleted in this
PR; the rest get an explicit horizon here. A maintainer should fold the table
below into the #6981 issue body — this PR's automation does not have write
access to edit or comment on that shared tracking issue.

| Item                                                                                                                                                                                                                     | Removal trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Status                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `LegacyLogMessageSchema` union arm (`src/shared/schemas/log.ts:108-145`, consumed `StreamLogStore.ts:721`)                                                                                                               | Age-based: delete once persisted stream logs written before the one-run-per-tab refactor (#3061, 2026-04-19) are outside the supported persisted-run retention window (same window D3 decides for the tier-3 shims); D3 verifies no supported `seqNo`-less log entries remain                                                                                                                                                                                                                                                    | pending, D3 (#6984)                     |
| `migrateLegacyContextFileFields` (`src/shared/schemas/fileFields.ts:5-84`; call sites `proposalInput.ts`, `mainView/state.ts`)                                                                                           | Age-based: delete once persisted execution configs written before the reference/auxiliary→context rename are outside the supported persisted-config retention window; D3 greps call sites for zero remaining legacy-keyed configs before deleting                                                                                                                                                                                                                                                                                | pending, D3 (#6984)                     |
| `LegacyRunUsageAccumulatorSchema` arm (`src/agent/core/usage/RunUsageAccumulator.ts:52-95`)                                                                                                                              | Age-based, same persisted-run retention window as the other tier-3/D3 run-record shims; delete once persisted flow records predating the `latestUsage` collapse are outside support                                                                                                                                                                                                                                                                                                                                              | pending, D3 (#6984)                     |
| Filename-era output parsers (`legacyWorkflowOutputStem`/`midEraWorkflowOutputStem`/`legacyWorkflowOutputRoundRegex` in `workflowOutputLayout.ts:38-90`) + `.tex`/`.xml` resume fallback (`runReflectionFlow.ts:164-175`) | Two-part: the resume fallback is age-based on the same persisted-run retention window as the tier-3 shims (only fires resuming a pre-#3082 execution, 2026-04-21 runDir-scoped refactor); the housekeeping/pack/latexdiff/compare call sites (`housekeeping/utils.ts`, `housekeeping/pack.ts`, `latex/latexdiff/diffOperations.ts`, `compareCommands.ts`) key off workspace filenames with no managed retention — delete at 2027-04-21 (one year after #3082) unless a checkpoint finds pre-refactor filenames still in the wild | pending, D3 (#6984)                     |
| `StreamTabStore.ts` (145-LoC legacy per-run-instruction reader) + `LegacyInstructions*` schema support in `streamData.ts`                                                                                                | Deleted outright in this PR — no live migration depended on it; the whole file, its `legacyInstructions.json`/`runInstructions.json` schema support, and the `ProgressViewState.ts` call sites were dead weight, not scaffolding in flight                                                                                                                                                                                                                                                                                       | executed (#7100)                        |
| `tool`→`toolName` transform (`src/shared/schemas/progressView/data.ts:48-67`)                                                                                                                                            | Age-based: delete once persisted tool-use logs written before the `toolName` rename are outside the supported persisted-run retention window; D3 verifies no supported `tool`-only tool-use log entries remain                                                                                                                                                                                                                                                                                                                   | pending, D3 (#6984)                     |
| workspaceState→memento read-through (`packages/extension/src/common/state/worktreeMemento.ts:44-47`)                                                                                                                     | Age-based: delete the per-key workspaceState fallback once every shared key has migrated to the namespaced `globalState` bucket across all supported VS Code workspaces (one release window after the last shared key is added); D1 sweep confirms zero remaining workspaceState-only reads                                                                                                                                                                                                                                      | pending, D1 (#6982)                     |
| `terminalStatus`→`outcome` derivation + optional `delegationDepth` (`src/agent/storage/ExecutionKVStore.ts:53-83`)                                                                                                       | Same age-based window as the #6981 tier-3 `terminalStatus` legacy-mapping row: delete once persisted execution meta files written before the `outcome`/`delegationDepth` fields are outside the supported persisted-run retention window. Code untouched by this PR — an in-flight PR owns `ExecutionKVStore.ts`                                                                                                                                                                                                                 | pending, D1 (#6982) (tracks tier-3 row) |

Already covered elsewhere (no new row): `migrateSharedState` arms, `goals:
odysseys:*`, `MODEL_LIST_VERSION` ladder (#6984), `DiffResult` legacy schemas
(#7068), `toolUse.ts:85` `isError` sniff (#7043).
