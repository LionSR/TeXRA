# Lifecycle & Status Ownership — Investigation & Cleanup Plan

**Status:** Investigation (2026-06-10). Single-pass map + proposal; not yet adversarially verified. Findings checked against the current tree (`88d7afe`). Line numbers drift — anchor on clause text.
**Scope:** The terminal-outcome path of an agent run — who decides "how did this run end", in which vocabulary, and where flows own lifecycle plumbing that belongs to the runtime. Covers `src/agent/runtime/AgentRunLifecycle.ts`, `executeAgent.ts`, both flow runners (`runToolUseFlow.ts`, `runReflectionFlow.ts`), `RoundPersistedFlow`, and the status schemas (`src/shared/schemas/stream.ts`, `log.ts`, `src/common/constants/streamStatus.ts`).
**Out of scope:** error *classification and presentation* (owned by [`error-pipeline-and-ownership.md`](./error-pipeline-and-ownership.md)), the session/registry composition (owned by [`session-handle-7d-design.md`](./session-handle-7d-design.md)), and the live in-run stream state machine (WAITING/RESUMING writes by `RetryState`/`ToolUseWaitNode` — interaction states, correctly in-run).
**Related:** both docs above; this plan must land *coordinated with* T2-2 and 7d PR 2/PR 6, which churn the same seams.

## TL;DR — verdict

The complaint "too many concepts" is half right. The status vocabularies are **not** redundant enums to merge — each serves a different consumer with a different lifetime (live UI state machine, persisted history, transcript group color, error classification). What is broken is that the **terminal outcome of a run is decided three times, in three layers, in three different vocabularies, with a lossy conversion in the middle** — and that the same outcome travels in **three carriers** (return status, exception-with-result-payload, shared-state flags). Flows own runtime plumbing (interrupt registration, coordinator cleanup, terminal-status computation, flow-record retention policy) duplicated with drift between the two runners.

The fix is **one canonical outcome, decided once at the lifecycle boundary, with the legacy vocabularies as pure projections** — the same `'completed' | 'cancelled' | 'failed'` triad T3-2's `ResultEvent` already ruled. This *deletes* a reachable incoherence: today the same user interrupt persists `terminalStatus: 'interrupted'` or `'error'` depending on whether the abort happened to throw.

---

## Concept inventory (the "too many concepts" map)

Eleven status-like vocabularies exist. Grouped by role, with the verdict per group:

| Role | Vocabulary | Definition | Values | Verdict |
| --- | --- | --- | --- | --- |
| **Live stream state machine** | `STREAM_STATUS` | `stream.ts` | running / error / stopped / ready / waiting / resuming / initializing | **Keep.** Presence/interaction state; WAITING and RESUMING have no outcome equivalent. Plus its predicate family (`isActiveStatus`, `isInFlightStatus`, `isTerminalStatus`, `LIVE_ELAPSED_STREAM_STATUSES`) — fine, one file. |
| | `TaskGroupStatus` | `stream.ts` (subset) | running / error / stopped / ready | Keep (log-group constraint; compile-time-asserted subset). |
| **Terminal outcome** | `EXECUTION_STATUS` | `stream.ts` | completed / interrupted / error | Keep as the **persisted projection** (`terminalStatus` on `ExecutionMeta`); evict it from flow code (see D1). |
| | `END_GROUP_STATUS` | `log.ts` | error / stopped | Keep as the **transcript projection** (`stage.end()`, group color); stop using it as `AgentFlowResult.status` (see D1). |
| | `AgentErrorKind` | `agentErrorClassification.ts` | abort / disk-full / missing-api-key / unexpected | Keep — error-pipeline territory; this plan only consumes `abort`-vs-rest. |
| | T3-2 `ResultEvent.outcome` (planned) | `session-handle-7d-design.md` | completed / cancelled / failed | **This is the canonical triad.** Promote it from "event field" to the type flows and `AgentFlowResult` speak. |
| **Cycle-internal outcomes** | `InvocationResult` (`RetryState.ts`), `ToolUseCycleOutcome` (`ToolUseCycleNode.ts`), reflection `CycleOutcome` (`ResponseCycleNode.ts`), `WaitExecResult` (`ToolUseWaitNode.ts`) | — | success/failed/cancelled/skipped variants | **Keep.** Node-scoped discriminated unions; converting them into one shared type is the extract-across-divergent-call-sites shape the LOC lesson rejects. Not the disease. |
| **Shared-state flags** | `lastError`, `userCancelledRetry`, `deliveredToOrchestrator`, `continueRounds`, `shouldStop`, `endTurn`, `shouldSkipCycle` | flow state schemas | booleans + one struct | Keep as **facts** (they are resume-persisted working state). The disease is that *terminal-status derivation from these facts* happens in flows — move the derivation, not the flags. |

So: two state machines (live + terminal), one classification, four node-internal unions, seven working-state flags. The count is defensible; the **ownership and conversion topology** is not.

---

## The three diseases

### D1 — the terminal outcome is decided three times, with a lossy hop in the middle

The decision chain for a workflow run:

1. **Decision 1 — `RoundPersistedFlow.resolveTerminalStatus`** (`roundPersistedFlow.ts`): derives `ExecutionStatus` from facts — `lastError → ERROR`, `checkInterruption() || !continueRounds → INTERRUPTED`, else `COMPLETED`. Correct place to *collect facts*, wrong vocabulary (persistence enum inside flow logic).
2. **Decision 2 — the flow runners convert lossily.** `runReflectionFlow` ("`status = executionToEndStatus(flowStatus)`") and `runToolUseFlow` (the no-throw interrupt exit: `isInterrupted && !interruptedAfterDeliveredSubagentResult → EXECUTION_STATUS.INTERRUPTED`, then `executionToEndStatus`) both squeeze three outcomes into two: **`interrupted → 'error'`** (`streamStatus.ts`, documented as a deliberate red-for-interrupt UX choice — but applied mid-pipeline, destroying the fact it colors).
3. **Decision 3 — `runFlowWithLifecycle` converts back.** Success arm: `result.status === END_GROUP_STATUS.ERROR ? EXECUTION_STATUS.ERROR : EXECUTION_STATUS.COMPLETED` → `writeTerminalStatus`. The lifecycle re-derives the vocabulary Decision 1 started in, **from the already-lossy value**.

**The reachable incoherence this produces** (the "exception status mess" made concrete): a user clicks stop. If the abort propagates as a thrown exception, the catch arm classifies `abort` → persists `terminalStatus: 'interrupted'`, ends the stage `'stopped'` (neutral). If the flow instead notices `checkInterruption()` at a cycle boundary and returns normally — the no-throw interrupt exit, confirmed reachable by the 7d verifier — the run persists `terminalStatus: 'error'` and ends the stage `'error'` (red). **Same user action, race-dependent persisted history, transcript color, CLI label (`runProgressRenderer` maps STOPPED+`interrupted` → "interrupted", STOPPED+`error` → "stopped"), and CLI exit code (`workflow.ts` keys `CliExitCode.Interrupted` on `terminalStatus === INTERRUPTED`).**

Secondary evidence that the split decision already taxes design work: 7d PR 6 needed a verifier correction ("interrupt-aware success-arm mapping", risk #7) purely to *reconstruct* at the boundary the fact Decision 2 destroyed.

### D2 — one outcome, three carriers

The same terminal fact travels as:

- **A return value:** `AgentFlowResult.status: EndGroupStatus` / `RunToolUseFlowResult.status` / `RunReflectionFlowResult.status`.
- **An exception with a result payload — twice-wrapped:** `runToolUseFlow` throws `ToolUseFlowError(message, result)`; `executeAgent` catches it, unwraps via `getToolUseFlowErrorResult`, and **re-wraps the same payload** as `AgentFlowError(message, fullResult)`; `runFlowWithLifecycle` unwraps *that* via `getAgentFlowErrorResult`. Two parallel error-with-result classes plus a wrap–unwrap–rewrap–unwrap chain whose only job is tunneling a result through a throw. The reflection flow does the opposite and worse: `throw new Error(shared.lastError.message)` — structure destroyed (already T2-2's target).
- **Shared-state flags** read back after the flow: `shared.lastError`, `shared.userCancelledRetry`, `shared.deliveredToOrchestrator` — consulted by the runner exit paths *and* by the lifecycle indirectly through which carrier fired.

### D3 — flows own runtime plumbing, duplicated with drift ("mixed with flows; not clear ownership")

Both flow runners hand-roll the same lifecycle choreography, each slightly differently:

| Concern | `runToolUseFlow` | `runReflectionFlow` | Drift |
| --- | --- | --- | --- |
| Interrupt registration | `interruptRegistry.register(streamId, flowContext)` in `try`, `unregister` in `finally` | same, with a locally-built `IInterruptible` | duplicated; the registered object differs in shape |
| Coordinator cleanup | `runCoordinatorBridge.cleanupRequestsForStream` (in interrupt **and** finally) | `clearRetryRequest` + `clearPlanApprovalForStream` (in interrupt **and** finally) | two cleanup vocabularies for the same intent |
| Flow-record retention | keep if `shared.userCancelledRetry`, else delete | delete only if `status === STOPPED` (i.e. keep on error **and** on interrupt) | two retention policies for the same "resumable?" question |
| Terminal-status computation | D1/D2 above | D1/D2 above | duplicated, lossy |
| Status writes | none (correct — lifecycle comment: "Runners must not set stream status themselves") | none | — but `ToolUseWaitNode` and `RetryState` legitimately write WAITING/RUNNING/STOPPED (interaction states, out of scope) |

Meanwhile `runFlowWithLifecycle`'s docstring claims ownership of "execution registry tracking, stream-status transitions, error classification, … resource disposal" — true for stream status since T1-6, **not yet true for interrupt registration, coordinator cleanup, or outcome derivation.** The ownership statement is right; the code hasn't caught up.

---

## What is NOT broken (do not "fix")

- **Multiple vocabularies per se.** Merging `STREAM_STATUS`/`EXECUTION_STATUS`/`END_GROUP_STATUS` into one enum forces live UI states into persisted history and a 2-value color space into a 7-value state machine. The fix is one *source* with projections, not one enum.
- **The red-for-interrupt UX.** Keep the mapping (`cancelled` may render red) — but apply it **at the projection edge**, after the fact is recorded, not mid-pipeline. Whether `cancelled` projects to `END_GROUP_STATUS.ERROR` (today's no-throw path) or `STOPPED` (today's thrown-abort path) is a decision this plan forces into the open — recommend `STOPPED`, matching the catch arm and `STREAM_STATUS.STOPPED`; the run-level group color change for the no-throw race path is the (desirable) behavior change.
- **Cycle-internal outcome unions.** Node-scoped, divergent semantics, no shared consumer.
- **`RetryState`/`ToolUseWaitNode` WAITING writes and the recovery writes in `ProgressEventHandler`.** Interaction and recovery states, already mapped and accepted in the error-pipeline audit.
- **`AgentFlowResult` itself** (the flattened summaries, memoryMisses, cost roll-up) — only its `status` field changes vocabulary.

---

## The plan — one outcome, decided once, projected at the edges

### Step 1 — canonical `RunOutcome`; flows return facts; lifecycle projects (the core fix)

1. Define `RunOutcome = 'completed' | 'cancelled' | 'failed'` in `@shared/schemas` — **the same triad and spelling as T3-2's `ResultEvent.outcome`**, so PR 6 consumes it verbatim.
2. **Flows stop converting.** `RoundPersistedFlow.resolveTerminalStatus` and the tool-use exit compute `RunOutcome` directly from facts (`lastError → 'failed'`; interrupted minus the delivered-subagent carve-out → `'cancelled'`; else `'completed'`). Delete both `executionToEndStatus` call sites and the function; delete the `EXECUTION_STATUS` import from all flow code. `RunToolUseFlowResult.status` / `RunReflectionFlowResult.status` / `AgentFlowResult.status` become `RunOutcome`.
3. **One projection module** (extend `src/common/constants/streamStatus.ts`): `outcomeToExecutionStatus` (completed→completed, cancelled→interrupted, failed→error), `outcomeToEndGroupStatus` (completed→stopped, failed→error, cancelled→ *decide once*, recommend stopped), `outcomeToStreamStatus` (completed/cancelled→stopped, failed→error). `runFlowWithLifecycle` becomes the **only** caller for terminal transitions: success arm projects `result.outcome` three ways; catch arm collapses its hand-rolled three-variable mapping to `classifyAgentError(err) === 'abort' ? 'cancelled' : 'failed'` → same projections. The `shouldPreserveOnCompletion` guard is unchanged.
4. **Bug fix falls out:** the no-throw interrupt now persists `terminalStatus: 'interrupted'`, ends the stage like every other cancel, and yields `CliExitCode.Interrupted` — race-independent. Changelog entry; vitest matrix: thrown abort vs no-throw interrupt vs error vs completed × {terminalStatus, stage end, stream status, CLI label}.

**Deletes:** `executionToEndStatus` + both call sites; the lifecycle's success-arm `END_GROUP→EXECUTION` re-derivation; the catch arm's triple mapping; 7d PR 6's "interrupt-aware success-arm" special case (its mapping becomes `result.outcome`, retiring risk #7). **LOC:** roughly net-zero in src (vocabulary swap), minus the special cases; tests added.

### Step 2 — one error-with-result carrier

Delete `ToolUseFlowError`/`getToolUseFlowErrorResult` and the `executeAgent` catch-and-rewrap: `runToolUseFlow` **returns** `{ outcome: 'failed', lastResponse, touchedFiles, totalCostUsd }` (the structured error already lives in `shared.lastError`, which T2-2 widens and re-attaches); `executeAgent` builds the full `AgentFlowResult` on the one success path; `runFlowWithLifecycle` treats `result.outcome === 'failed'` as the failure case in the **success arm** (notification policy moves there from the catch arm, keyed by the T2-2 structured error's kind), leaving the catch arm for genuinely-unthrown-by-us exceptions and aborts. The reflection flow's bare `new Error(lastError.message)` rethrow is replaced the same way.

**Reconciliation note (binding):** T2-2's current scope keeps the flow-exit *rethrow* and attaches metadata to it; this step changes that contract to errors-as-data one layer earlier. Land T2-2 first as written (it's a prerequisite for the structured shape either way), then this step converts the rethrow sites it touched — or fold this into the T2-2 PR if both are unlanded when work starts. Do not land two conflicting contracts in separate PRs. `AgentFlowError` survives only if some caller still needs throw semantics from `executeAgent` (audit: the delegation/subagent path uses `onError` + result, so likely nothing does — verify before deleting).

### Step 3 — lifecycle owns interrupt registration, coordinator cleanup, and record retention

- **Interrupt registration:** the runner hands its `IInterruptible` to the lifecycle (via the existing `AgentExecutionHandle` attach precedent or a runner-arg callback); `runFlowWithLifecycle` does `register` after RUNNING and `unregister` in its `finally`. Both flow-local register/unregister pairs are deleted.
- **Coordinator cleanup:** one `cleanupRequestsForStream(streamId)` in the lifecycle `finally` replaces both flows' divergent cleanup pairs (it is a superset of `clearRetryRequest` + `clearPlanApprovalForStream`; verify proposal-cleanup semantics before swapping the reflection side).
- **Flow-record retention:** one policy function — keep the record iff the run is resumable (`outcome !== 'completed'` per the reflection rule, plus the tool-use `userCancelledRetry` case) — owned next to `executionLifecycle.ts`, called from the lifecycle `finally`, replacing both flow-local deletion blocks. Pin current behavior per-flow in tests first; reconciling the two retention policies into one is a deliberate, release-noted decision, not a silent merge.

**Coordination (binding):** 7d PR 2 migrates these exact lines (`interruptRegistry.register/unregister`, the reflection cleanup calls, `RetryState.waitForRetry`) from module singletons to `ctx.session.*`. Sequence Step 3 **after** 7d PR 2 (then the transfer moves `session.interrupts.register` into the lifecycle — same instance, no isolation impact), or land it inside PR 2 if both are open. Touching these lines twice in two uncoordinated PRs is the churn the 7d doc's risk #1 warns about.

### Sequencing against the standing roadmap

| When | Item |
| --- | --- |
| Now (independent) | Step 1 — `RunOutcome` + projections + the interrupted-persistence fix. Touches `AgentFlowResult.status` consumers (grep: orchestrator delivery, progress board, CLI run paths) but is a mechanical vocabulary swap. Lands **before** 7d PR 6 and simplifies it. |
| With/after T2-2 | Step 2 — single carrier (contract reconciliation above). |
| With/after 7d PR 2 | Step 3 — ownership transfer of register/cleanup/retention. |
| 7d PR 6 (T3-2) | `ResultEvent.outcome = result.outcome` — the special-case mapping this plan deletes. |

---

## Rejected alternatives (traps)

| Idea | Why rejected |
| --- | --- |
| Merge the three status enums into one | Different consumers, lifetimes, and cardinalities; forces UI states into persistence. The disease is decision topology, not enum count. |
| Unify the four cycle-outcome unions into one shared type | Node-scoped, divergent semantics — the measured net-ADD extraction shape. |
| Flows emit stream status / terminal status directly | Re-opens the pre-T1-6 three-writers smear; the lifecycle ownership comment is the settled direction. |
| Move WAITING writes (`RetryState`, `ToolUseWaitNode`) into the lifecycle | Interaction states are in-run by nature; the lifecycle is not in the loop when a retry prompt blocks. Already accepted in the error-pipeline map. |
| Make `RunOutcome` carry the error payload (sum type `failed(error)`) | The structured error already has an owner (T2-2's widened `lastError` / `ResultEvent.error`); duplicating it into the status type creates two sources. |
| Do this as one big PR | Three seams, three different coordination partners (T2-2, 7d PR 2, PR 6). Stage it. |

## Open questions (decide in review, before Step 1 lands)

1. `cancelled → END_GROUP_STATUS`: `STOPPED` (recommended; matches thrown-abort today) or `ERROR` (matches the no-throw path and the red-for-interrupt comment)? Either way it becomes **one** answer.
2. Does anything depend on the current `terminalStatus: 'error'` for no-throw interrupts (history filtering, restart recovery's WAITING restore)? Grep `EXECUTION_STATUS.ERROR` consumers before flipping.
3. Step 2: does any caller still require `executeAgent` to throw on flow failure (vs reading `result.outcome`)? If yes, `AgentFlowError` stays as the single wrapper; if no, delete both classes.

## Verified (files opened first-hand)

`src/agent/runtime/AgentRunLifecycle.ts`, `executeAgent.ts`, `executionRegistry.ts`, `StreamStatusService.ts`, `AgentFlowResult.ts`, `agentShutdown.ts`; `src/agent/implementations/flows/tooluse/runToolUseFlow.ts`, `ToolUseSessionLifecycle.ts`; `src/agent/implementations/flows/reflection/runReflectionFlow.ts`; `src/agent/node/persistedFlow.ts` (run return type), `roundPersistedFlow.ts` (`resolveTerminalStatus`); `src/agent/storage/executionLifecycle.ts`; `src/common/constants/streamStatus.ts`, `src/common/errors/agentErrorClassification.ts`; `src/shared/schemas/stream.ts`, `log.ts`; `docs/proposals/error-pipeline-and-ownership.md`, `session-handle-7d-design.md`. Sub-audit (delegated map, spot-checked): `RetryState.ts`, `ToolUseCycleNode.ts`, `ResponseCycleNode.ts`, `ToolUseWaitNode.ts`, `ProgressEventHandler.ts` (recovery writes), `packages/cli/src/runtime/runProgressRenderer.ts`, `packages/cli/src/commands/workflow.ts`, `src/agent/trace/AgentTrace.ts` (`StageHandle.end`), `src/tools/agentCliShared.ts`, `detectWaitingStreams.ts`.
