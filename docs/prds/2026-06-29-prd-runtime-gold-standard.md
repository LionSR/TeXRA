---
created: 2026-06-29
updated: 2026-08-01
---

# PRD: Runtime Gold-Standard - The SDK Core (PocketFlow / Lifecycle / Injection / Retry)

> **Historical status (2026-07-18): retired proposal.** This document is
> preserved from the unmerged `codex/decouple-ui-agent-core` branch and does not
> describe the runtime on `main`. Main instead folded the coordinator layer into
> `session.interactions` in [#7504], deleted the progress/process bus in [#7457]
> and [#7474], reduced the runtime boundary to the small `AgentRuntimeHost` event
> sink and its no-op headless implementation through [#7600], [#7602], [#7623],
> and [#7624], and enforced host-to-agent imports with ratchet tests and
> centralized baselines in [#7914] and [#8322]. The proposed frozen
> `RunDescriptor` injection model, `ModelCell`, `PendingRequests`, `RetryPolicy`,
> `RetryGate`, and `HostUiBus` are retired and must not be implemented from this
> record. The later [narrow ModelCell ownership ruling][modelcell-ownership-ruling]
> supersedes only this prohibition's claim that no `ModelCell` exists on `main`;
> it does not revive this PRD. The `RunDescriptor` name on `main` denotes the
> unrelated persisted stream schema introduced in [#7164].
> The companion `2026-06-28-prd-architecture-patterns.md` and
> `cross-host-consolidation/` records remain only on the source branch and are
> not part of this extraction; references to them below are historical context,
> not documentation present on `main`.

[#7164]: https://github.com/LionSR/TeXRA/pull/7164
[#7457]: https://github.com/LionSR/TeXRA/pull/7457
[#7474]: https://github.com/LionSR/TeXRA/pull/7474
[#7504]: https://github.com/LionSR/TeXRA/pull/7504
[#7600]: https://github.com/LionSR/TeXRA/pull/7600
[#7602]: https://github.com/LionSR/TeXRA/pull/7602
[#7623]: https://github.com/LionSR/TeXRA/pull/7623
[#7624]: https://github.com/LionSR/TeXRA/pull/7624
[#7914]: https://github.com/LionSR/TeXRA/pull/7914
[#8322]: https://github.com/LionSR/TeXRA/pull/8322
[modelcell-ownership-ruling]: ../proposals/2026-08-01-architecture-rulings-ledger.md#modelcell

Decided by an adversarial design pass (4 designs x 3 lenses x 4 phases,
2026-06-29). This is the gold-standard target for TeXRA's agent runtime core: the
flow/lifecycle/injection/retry machinery the three UIs (extension, desktop, CLI)
sit on top of. It is the **SDK core** - the runtime whose minimal, typed boundary
_is_ the agent-SDK surface (Pattern 1). It extends the decoupling program
(`2026-06-27-prd-runtime-host-decoupling.md`) inward, from the host boundary into
the flow engine.

**Honesty rule (the design pass enforced it, this PRD keeps it).** A relocation is
never counted as a reduction. Where logic moves rather than disappears, it is said
so. Two metrics are reported separately and never multiplied together: orchestration
**call depth** (host event -> flow node) and **injection/threading depth**.

**Accounting discipline (PRD gate).** Every claimed deletion must name the
file/symbol that ceases to exist. A rename, or a field that reappears on another
object, is logged in a separate "relocated" column and may **not** be netted
against additions. The acceptance ledger after the overhead ruling is **net -5
named concepts / -4 drift surfaces**; a revision that pushes net concepts back
toward zero is overhead, not progress.

## Thesis

The runtime core today has two structural defects, both named by the maintainer:
**deep injection** (a 14-field ambient `RunContext` god-context plus a parallel
`*Services` bag, with `runtimeHost` threaded ~184x and a 6-8-deep services chain)
and **retry sprawl** (five independent retry mechanisms). The gold standard
removes both by storing run-level dependencies **once** in a frozen `RunDescriptor`
that PocketFlow propagates by reference, and by collapsing retry to **two owners
split by concern**. The resume-id contract (`config.agent` stays raw) and headless
parity (`noopAgentRuntimeHost` reduces with zero subscribers) are invariant
throughout.

## 1. The injection model: one frozen `RunDescriptor`

`RunDescriptor` is built once in the launch composition root and is the literal
value passed to `flow.setServices(descriptor)`. PocketFlow propagates it by
reference to every cloned node (`node/index.ts` `clone()` shares `_services`), so
injection **depth is one handoff** regardless of node nesting.

**Honest field accounting.** The descriptor **relocates run identity to the
descriptor; flow-implementation handles live in `shared`.** It groups today's
`AgentCore`/`RunContext` run-level deps into **~8 grouped slots** (identity / agent /
model / tools / retry / host / session / flags), not 25 flat fields. The run-level
immutables earlier drafts undercounted (`setting`, `prompt`, `logger`,
`streamStatus`, `userVarChannels`, `getActiveChildren`) fold into those slots. The
reflection-specific `outputState`/`xmlManager`/`diffManager`/`promptBuilder`/
`fileService` are **not** descriptor fields - they are flow-implementation handles
that move to the flow-local PocketFlow `shared` store.

The genuine, defensible wins:

1. **Two channels become one.** The ALS `RunContext` and the explicit `*Services`
   bag carried an overlapping field set kept in sync by `agentContextToRunContext`.
   That projection, the rename drift (`config.agent`->`agentName`,
   `config.model`->`model`), and the dual channel are **deleted**. One frozen
   object instead of two drifting bags.
2. **Threading depth 6-8 to 1.** `runtimeHost` stops spreading through
   `AgentCore -> BaseFlowContextInit -> *Services -> CycleNode -> withModelClient
-> round services -> RetryState`. It is `descriptor.host`, set once.
3. **50 type-position sinks to ~2 descriptor fields** (reported honestly: the ~261
   usage refs remain as `descriptor.host.emit(...)` field reads; the _threading_
   collapses, not the _usage_).

**Field list - ~8 grouped slots (kept on the frozen descriptor; immutable except
the one cell):**

```
identity:  { agent (RAW - resume-id contract), agentSource, agentCategory,
             streamId, executionId, workingDirectory, delegationDepth }
agent:     ResolvedAgent      // setting + prompts, parsed once
model:     ModelCell          // { handler, client, modelId } - the ONE mutable seam
tools:     ResolvedToolSet    // resolved once
retry:     RetryPolicy        // budget read once (SSOT only, not the clamp)
host:      AgentRuntimeHost ; streamStatus ; logger ; userVarChannels ;
           getActiveChildren
session:   SessionHandle      // field, not currentSession(); requests == session.requests
flags:     { approvalPromptsUnavailable, runtimeUnavailableTools, stopAfterCycle }
// flow-implementation handles (outputState / xmlManager / diffManager /
// promptBuilder / fileService) are NOT descriptor fields - they live in the
// flow-local PocketFlow `shared` store.
```

**Deleted outright:** `RunContext.model` live getter; the `agentName`/`model`
rename projection; `withModelClient` getters; the `AgentCore`/`RunContext` overlap;
`useRunCoordinators()`; `ExecutionHandle.coordinators`.

**Round-scoped state does NOT go on the descriptor (normative rule).** A frozen
run-level descriptor cannot carry per-round mutable state. Round/cycle-scoped
mutable state (`round`, `run`, `workspace`, and the reflection-flow handles
`outputState`/`xmlManager`/`diffManager`/`promptBuilder`/`fileService`) lives
in the PocketFlow `shared` store (mutable, persisted, `structuredClone`-safe -
never a handler/client/socket). Only immutable run-level deps live on the
descriptor (`Svc`). This is what makes the bridge-node deletion a real subtraction
rather than a relocation.

**Ambient survives in two narrow ALS readers.** The tool-facing context is **~8
tool-facing fields** read only by `src/tools/*` code that is dispatched by name with
model-supplied args and genuinely cannot take a descriptor parameter; `model` is a
reference to the `ModelCell` read as `cell.modelId` - one stable-pointer
indirection, **not** a re-resolve - so a delegation tool spawned after a mid-session
switch still sees the new model. After the shrink exactly **two** ALS readers
survive - `tryUseRunContext` and `currentSession` - with no parallel ambient channel
for run/flow code. Nodes hold the descriptor by reference but are typed
`Pick<RunDescriptor, ...>` per their declared deps, so "a node needs <= its actual
deps" holds at the type level even though the runtime object is shared.

**Target depth achieved:** one hop for flow/node code (`descriptor.X`), one hop for
tools (`ToolRunContext.X`). No parallel ambient channel for run/flow code.

## 2. `ModelCell`: the one mutable seam

`ModelCell` is an atomic holder of `{ handler, client, modelId }`, swapped wholesale
on a mid-session model switch (`cell.swap(newHandler)` produces a _new_ inner object
read by reference; the invocation node captures the cell's current object at `exec`
start, so there is no torn read). It replaces:

- `RunContext.model` live getter (resolved on every read) -> `cell.modelId` field.
- `withModelClient` getters + `getClient()`/`refreshClient()` re-fetch (5 sites) ->
  `cell.client`; a relay-401 rebinds the cell.
- `MODEL_CONFIGS[...]` x2 + `createModelHandler` on switch -> one `cell.swap()`.

This is the single primitive both early designs got wrong: a cross-provider switch
needs the **handler** swapped, not just the client, and a frozen `model` field
leaves a delegation child on the stale model. The cell is the correct resolution.
`shared.modelId` is persisted; `ModelCell.handler` is reconstructed from it on
resume.

## 3. The retry model: two owners, by concern

This is an **ownership recount, not a concept-count reduction**: the named retry
concepts tick **up** by ~1 (a `RetryPolicy` SSOT value object plus a relocated
decision surface join the existing loop), and the win is **correctness + the SDK
clamp (Step 0)**, not a smaller count. Today's mechanisms re-home onto **two
owners**, split machine-transient vs human-decision.

**Owner-1, transient-retry executor (the only loop)** lives inside the PocketFlow
node's `_exec` (the native `pRetry` loop), configured by a `RetryPolicy` value
object read once from `descriptor.retry`. It never prompts a human.

**Owner-2, the human/credential decision gate** is one method on the session:
`requests.wait('retry', streamId)`, with `ProgressApiKeyRetryController` as its
policy _input_ (relay->own-key / subscription->API-key) feeding the same
`resolve('retry', streamId)`.

| #   | Current mechanism                                        | New home                                                                                                                                                                | Disposition                                                                                    |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | PocketFlow `Node._exec` pRetry                           | Owner-1, the engine                                                                                                                                                     | kept                                                                                           |
| 2   | `RetryableInvocationNode` (`RetryState`)                 | loop config + `shouldAutoRetry` + relay-401 `onRetry` -> `RetryPolicy`; value-mapping -> node `post`; human wait stays in-node via the injected `waitForRetry` callback | **relocated** (honest: logic moves, not deleted)                                               |
| 3   | `RetryRequestCoordinatorImpl` + `BasePromiseCoordinator` | Owner-2 = `PendingRequests` 'retry' entry                                                                                                                               | the `loggers` + bridge `retries` maps deleted                                                  |
| 4   | Per-provider SDK retry (default 2)                       | **clamped to `attempts:1` everywhere**, Owner-1 the sole transient retrier                                                                                              | **deleted** (the silent SDK x flow double-retry) - the strongest genuine, verifiable reduction |
| 5   | `ProgressApiKeyRetryController` + `userRetryable`        | policy input to Owner-2; `userRetryable` stays the `errors.ts` SSOT                                                                                                     | survives as a distinct controller (not counted as deleted)                                     |

**The binding correctness decision (all four designs hit the same fracture).**
PocketFlow's only human-retry mechanism is `retryPrompt()` returning `true` to
`continue` and restart the inner `pRetry` loop **in place** inside the same `_exec`
call, preserving the prepped context. Moving the wait out of the node converts an
in-place restart into a graph re-entry that re-runs `prep` - a behavior change. So:
**keep the human-retry wait in-node**; sever the inverted `core/flows` ->
`@runtime`/`@auth` layering by a **type-move, not a behavior-move and not a new
port**. `RetryGate` is therefore not a port: it reduces to a type-move (relocate
`RetryResult`/`RetryRequestOptions` into `core/flows`) plus the already-injected
`waitForRetry` callback, optionally typed `Pick<PendingRequests, 'wait'>`. The
transient/unrecoverable decision is part of `RetryPolicy`'s surface, not a
separately listed `RetryDecision` concept.

**Two guards before the SDK clamp (Step 0) ships (else it is a resilience loss, not
dedup):**
(1) broaden `userRetryable`/`isRetryableStatusCode` to cover status-less transport
errors (ECONNRESET, socket hangup), and have Owner-1 honor server `Retry-After` +
add jitter (the native loop is `factor:1`, no jitter); (2) keep background-resume a
poll-specific retryable marker, not a stripped status code. **Relay-401 one-shot
cap kept explicit:** 401/403 stay excluded from the generic auto-retry set; the
refresh is a distinct `RetryPolicy.onRetry` with a hard one-shot cap that does not
decrement the transient budget. Final-failure classification unifies in `runRun`.
The clamp is **Step 0** - zero structural change, verifiable by attempt count,
shipping against existing code; it is the genuine reduction and is **not** credited
to `RetryPolicy` (which stays the read-once SSOT only).

## 4. The lifecycle model: five nested rings, one owner each

The nesting matches today's reality; the change is _what each ring stores and hands
down_ and _who alone owns teardown_.

```
SESSION
  RUN (runRun)
    EXECUTION-entry (session.executions)
    coordinator-settle (one PendingRequests on the session)
    RoundFlow.run
      PocketFlow node (prep / exec / post)
        transient-retry loop (native pRetry, Owner-1)
```

| Lifecycle | Sole owner                                                                         | Ends                                                                                                                                                       | PocketFlow coupling                                                                                  |
| --------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| SESSION   | `SessionHandle` (one per host context; `defaultSession()` only as host-entry seam) | `dispose()`/`disposeWhenIdle()`                                                                                                                            | holds `interrupts`, `executions`, one `PendingRequests`, the slim `(kind,id)->session` routing index |
| RUN       | `runRun(descriptor, runner)` (today's `runFlowWithLifecycle`)                      | `finally`: emit the one terminal `result`, untrack execution, **per-stream** cleanup of pending requests + interrupts, dispose `ModelCell.handler` + trace | sets `Svc = descriptor` once; never touches nodes                                                    |
| EXECUTION | `session.executions` entry                                                         | `untrack` after `result` (emit-before-untrack kept)                                                                                                        | settles one `result` deferred; **no `coordinators` copy** (fourth ownership deleted)                 |
| Flow run  | one `RoundFlow` instance (`PersistedFlow` + round-looping)                         | `run()` resolves                                                                                                                                           | extends `Flow`; persists `shared` + node-action history                                              |
| Node      | the `RoundFlow` walking the graph                                                  | `post()` returns terminal action                                                                                                                           | IS PocketFlow; only `ModelInvocationNode` retries                                                    |

**Coordinator-settle and retry are methods, not rings you traverse.**
`requests.wait(kind, id)` settled by `resolve(kind, id)`; the slim routing index
exists solely so an off-ALS host UI callback carrying a bare id finds the owning
session (the multi-session catch - do not delete it). Per-stream teardown is owned
once by `runRun`'s `finally` (run-scoped, not `session.dispose`, because a session
outlives many runs). The hand-capture of `runSession = currentSession()` to dodge
the ALS boundary disappears: host-thread interrupt closures close over
`descriptor.session` directly.

## 5. The resolve model: near-zero by SSOT, not rename

Every value computed once at launch is stored on `RunDescriptor`/`ModelCell` and
read as a field. Each is a data-structure change that deletes resolution, not a
rename: the `RunContext.model` getter, `withModelClient`, `MODEL_CONFIGS` re-fetch
on switch, `currentSession()` at 30+ run-scoped sites, `useRunCoordinators()`,
`getNodeRetryConfig()` per-`_exec`, the `agentContextToRunContext` projection, and
the registry-by-stream coordinator route all become field reads.

**Honest survivors (no "->1" inflation), stated not hidden:** (1) `currentSession()`
at host-thread entry points with no descriptor in scope (irreducible); (2)
`getShared()` re-read after `flow.run()` (a genuine `structuredClone` artifact,
isolated to the runner); (3) the tool-side `cell.modelId` stable-pointer read.
**From ~10 recurring re-resolution patterns to ~2 survivors + one cell indirection.
Not "->1".**

This is consistent with the `resolve*` field audit (the cross-host program's 06):
the data model is already SSOT-clean, so these are deletions of _getters and
projections_, not new stores.

## 6. Layer count: two metrics, never conflated

**Orchestration call depth: 5 named hops** (vs today's ~8-link chain
`AgentLaunchInput -> assembleAgentLaunchContext -> AgentCore -> runFlowWithLifecycle
-> flow input -> runToolUseFlow services -> ToolUseCycleNode -> withModelClient ->
RetryableInvocationNode`):

1. **Host capability adapter** (`AgentRuntimeHost`; the one place `vscode`/Ink/
   Electron is allowed; headless parity lives here).
2. **`executeAgent`/launch** - composition root; the single place resolution
   happens; builds the frozen `RunDescriptor`.
3. **`runRun`** - the one outcome owner (every status transition, the single
   terminal `result`, track/untrack, per-stream cleanup, disposal).
4. **`RoundFlow`** (`PersistedFlow` + round-looping) - KV crash-resume + round
   semantics PocketFlow does not provide.
5. **PocketFlow node** (`prep`/`exec`/`post` + the one retry loop) - the framework.

We do **not** adopt the `runAgent` mega-merge of launch + `runRun` (a design
proposal its own feasibility verdict found "aspirational, never sequenced"). Launch
and `runRun` stay two functions with a clean split: launch builds the SSOT, `runRun`
owns the outcome.

**Threading/injection depth: 6-8 hops to 1** (the by-reference descriptor collapse,
reported separately, never multiplied with call depth).

## 7. Net deletions and the honest LOC direction

Per the **accounting discipline** above, deletions and relocations are tallied in
separate columns and never netted together.

**Genuinely deleted (a named file/symbol ceases to exist):** `RunContext` ALS as a
god-context; the `agentName`/`model` rename projection; `agentContextToRunContext`;
the `RunContext.model` live getter + `withModelClient` getters; `useRunCoordinators()`;
`ExecutionHandle.coordinators`; the per-provider SDK retry defaults (the latent
double-retry; the Step-0 clamp); `RunCoordinatorBridge`'s triple-map + registry
fallback + cleanup sprawl (~220 LOC); the `runCoordinatorCommands` /
`executionQueries` / `streamControl` / `modelSwitch` pass-through shims; the
`_hasAttemptedTokenRefresh`/`_persistent401Error` flag machine; `core/flows` imports
of `@agent/runtime`/`@auth` (severed by type-move).

**Relocated, not deleted (logic moves; a field/concept reappears elsewhere - NOT
netted against the deletions):** the `*Services` bag -> the frozen `RunDescriptor`
(one channel survives, the fields survive); the 3 thin coordinator subclasses ->
the existing `BasePromiseCoordinator` made concrete as typed `PendingRequests<T>`
instances; the five/six retry mechanisms -> two owners (`RetryableInvocationNode`'s
classification -> `RetryPolicy` + node `post`; `RetryResult`/`RetryRequestOptions`
-> `core/flows`); `RoundPersistedFlow`'s round loop -> a composition helper /
loop-edge over the single `PersistedFlow`.

**Honest net-LOC: modestly negative, driven by structure not lines.** Genuine
deletions (coordinator Map bookkeeping, shim files, SDK retry defaults, dual config
read, the bridge's triple request maps, rename projection, `withModelClient`) net
against real new code (`ModelCell`, typed `PendingRequests<T>` instances,
`RetryPolicy`, `ToolRunContext`, the `(kind,id)->session` routing index) - with no
`FlowRecord` versioning, replay shim, or `{kind -> config}` table in the ledger
(those were dropped by the overhead ruling). **The decisive reduction is in surfaces
and ownerships, not raw line count:** two injection channels -> one; four
coordinator ownerships -> one; the bridge's triple-map + registry fallback + cleanup
sprawl -> one `(kind,id)->session` routing index; five/six retry mechanisms -> two
owners; ~10 resolve patterns -> ~2 survivors; a 5-layer coordinator stack -> one;
threading depth 6-8 -> 1. **Acceptance ledger after the overhead ruling: net -5
named concepts / -4 drift surfaces.**

## 8. The five new sub-PRDs (the replacement set)

These replace the cross-host slots that targeted runtime pass-through + coordinator
surfaces:

1. **Retry-core** - broaden `errors.ts` retryability (transport errors,
   `Retry-After`, jitter); clamp all SDKs to `attempts:1`; introduce `RetryPolicy`
   - `RetryGate` port; relay-401 one-shot `onRetry`. The SDK clamp is the
     lowest-risk first commit.
2. **ModelCell** - introduce `ModelCell`; route `RunContext.model`/`withModelClient`/
   `switchModel` through it; persist `shared.modelId`; reconstruct on resume.
3. **PendingRequests** - fold the 3 thin coordinator subclasses into the existing
   `BasePromiseCoordinator` (typed `PendingRequests<TResult, TPayload>` instances,
   e.g. `new PendingRequests(RETRY_CONFIG)`, preserving static result typing); the
   **actual reduction** is the bridge's triple-map + registry fallback + cleanup
   sprawl (~220 LOC) -> one `(kind,id)->session` routing index; delete
   `ExecutionHandle.coordinators`.
4. **RoundFlow** - keep `PersistedFlow` as the single persistence engine (freeze the
   persisted format: no `FlowRecord` version field, no replay shim, no resume
   migration); express round-looping as a thin composition helper / graph loop-edge
   over it, or inline `RoundPersistedFlow`'s loop into the one reflection runner;
   re-home round orchestration to loop-boundary nodes; migrate reflection then
   tool-use.
5. **Descriptor + ambient-shrink** - introduce `RunDescriptor` as the `Svc` SSOT;
   type nodes `Pick<RunDescriptor,...>`; introduce the narrow `ToolRunContext`
   (~8 tool-facing fields, two surviving ALS readers);
   restrict `currentSession()` to host-entry; delete `agentContextToRunContext`.

## 9. Relation to the cross-host consolidation (01-07)

- **Absorbs.** The runtimeHost threading-reduction goal: once `runtimeHost` is
  `descriptor.host` propagated by reference, the per-sink threading the cross-host
  PRDs were trimming is gone by construction. Do not do it twice.
- **Supersedes.** The pure pass-through trimming (the `trim runtime pass-throughs`
  commits; sub-PRD 06's `resolveRuntime*` wrapper-collapse): `runCoordinatorCommands`,
  `executionQueries`, `streamControl`, `modelSwitch` are deleted wholesale here, not
  incrementally thinned. **Stop investing in renaming those shims** (the
  `check-runtime-boundaries.mjs` lint + `knip` dead-code checks carry forward as the
  enforcement mechanism).
- **Reorders.** The coordinator/`SessionHandle`/`RunCoordinatorBridge` reshaping
  lands after any in-flight cross-host sub-PRD touching those files (the slot is
  `EXECUTION.md`'s to assign). The behind-the-API coordinator collapse (keep
  `session.coordinators.waitFor*` signatures, swap the implementation) is sequenced
  first so it interleaves without a public-surface break.
- **Sub-PRD 04** (the resolved-name field-carry only) is absorbed into the
  **Descriptor** sub-PRD: the descriptor's `identity.agent` stays raw, the resolved
  display name is a sibling field. 04's two-brand boundary, display-consumer
  repoints, resume-id-contract trap, and quick-wins are **not** absorbed - they stay
  04's (CH-04). Reconcile the re-derivation count there.
- **Sub-PRD 05 (external-inquiry decision policy) is NOT absorbed.** Its host-aware
  empty-answer affordance (webview `keepOpen` vs CLI `drop`) is host presentation,
  outside this PRD's charter; GS-3 PendingRequests collapses only the inquiry
  _coordinator plumbing_. 05 stays a live unit (CH-05).

## 10. Strangler sequencing

Each step is independently shippable and preserves the resume-id contract
(`config.agent` raw) and headless parity (`noopAgentRuntimeHost` launch-injected into
`descriptor.host`, never the ambient).

- **Step 0** (ship first, zero structural change): broaden the flow retry predicate
  for status-less transport errors + `Retry-After`/jitter, then **clamp every SDK to
  `attempts:1`**. Pure deletion of the latent double-retry, verifiable by attempt
  count.
- **Step 1** (additive SSOT seam): build `RunDescriptor` in `assembleAgentLaunchContext`
  alongside today's context; `agentContextToRunContext` reads _from_ it. Phase gate:
  assert `FlowRecord` never references descriptor fields (services stay
  non-serialized).
- **Step 2** (ModelCell): route `RunContext.model` / `withModelClient` (5 sites) /
  `switchModel` through `ModelCell`; swap the two bridge-node `{...this.services}`
  spread sites to the by-reference descriptor **in lockstep** (spreading
  getter-bearing services evaluates the getter and breaks live rebinding).
- **Step 3** (coordinators, behind the API): stand up `PendingRequests<T>` + config
  table inside `SessionHandle` behind the existing `waitFor*` signatures; collapse
  the bridge to the routing index; delete the shims once `knip`-confirmed dead.
  Sequenced after in-flight cross-host work on the same files.
- **Step 4** (retry to two owners): fold `RetryableInvocationNode` policy into
  `RetryPolicy` + Owner-1; `RetryDecision` for the transient path; human wait stays
  in-node via `RetryGate`; sever `core/flows` -> `@runtime`/`@auth` by type-move.
  Touches the shared `ModelInvocationNode`, so both flow families change in one
  commit; gate behind both retry suites.
- **Step 5** (round-looping over the single engine): keep `PersistedFlow` as the
  single persistence engine and **freeze the persisted format** - no `FlowRecord`
  version field, no replay shim, no resume migration, no crash-resume contract
  change. Express round-looping as a thin composition helper / graph loop-edge over
  `PersistedFlow`, or inline `RoundPersistedFlow`'s loop into the one reflection
  runner; re-home stage/interruption/reset to loop-boundary nodes and delete the
  bridge nodes.
- **Step 6** (ambient shrink): convert run/flow reads to `descriptor.X`; introduce
  `ToolRunContext`; restrict `currentSession()` to host-entry; delete
  `agentContextToRunContext`. Last, the widest mechanical change.

## 11. Ranked residual risks

1. **Model-switch / relay-401 atomicity and tool-boundary liveness (Steps 2, 4).**
   `ModelCell.swap` must produce a new object read by reference (no field mutation);
   the node captures the current object at `exec` start; `ToolRunContext.model` reads
   `cell.modelId` through the live pointer. The relay-401 `onRetry` needs a hard
   one-shot cap and must not decrement the transient budget. A torn read or frozen
   tool snapshot is a silent capability regression.
2. **Non-serializable state leaking into `shared`, and the round-state split
   (Steps 2, 5).** `PersistedFlow` `structuredClone`s `shared`; a handler/client/
   socket there crashes the clone. Keep handler/client/descriptor in `Svc` (never
   serialized); only the model **id** and round-scoped _data_ go in `shared`. Getting
   this split wrong turns the bridge-node deletion from a real subtraction into a
   hidden relocation. (The former #1 risk - `FlowRecord` resume-replay versioning -
   is removed: §10 Step 5 freezes the persisted format and expresses round-looping as
   a composition helper / loop-edge over the single `PersistedFlow`, so there is no
   versioning, shim, or migration to regress.)

## Relation to existing documents

- `2026-06-28-prd-architecture-patterns.md` - the lens. This PRD is the deepest
  application of the fewest-layers objective and answers the three named smells
  (retry sprawl, deep injection, spaghetti) for the core.
- `2026-06-27-prd-runtime-host-decoupling.md` - the boundary of record. This extends
  it inward from the host boundary into the flow engine.
- `2026-06-29-prd-agent-sdk-boundary.md` - the published surface of this core. Same
  boundary, opposite sides: this deepens inward from `AgentRuntimeHost`; the SDK PRD
  publishes outward from it as a versioned package. The SDK surface stays stable
  _through_ this PRD's internal migration; only the §1 descriptor phase-gate (the
  serialization fence) and §5 `FlowRecord` versioning interact.
- `cross-host-consolidation/` - the host/UI backlog. Section 9 states what this
  absorbs, supersedes, and reorders there.
