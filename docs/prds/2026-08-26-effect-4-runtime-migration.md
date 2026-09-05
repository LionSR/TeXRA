---
created: 2026-08-26
updated: 2026-09-06
---

# PRD: Effect 4 as the TeXRA backend runtime

**Status:** Owner ruling of 2026-09-06: the agent runtime is written in pure
Effect to Effect's best practice, and PocketFlow is not retained. That ruling
amends R4, 8.4, Phase 2, and alternative 13.C below, in the form
`docs/proposals/2026-09-04-agent-runtime-on-effect.md` §6 specifies, and
closes open decisions 6 and 7 of section 15. The remaining items of section
15 stay open; the governing rules R1 to R3 and R5 to R10 are unchanged.

**Decision in one sentence:** TeXRA will adopt Effect 4 RC as the execution
model for host-neutral asynchronous backend work, with the two agent flow
families as plain Effect loops whose only durable act is appending rows to
the session event table (no graph, cursor, or flow record), Zod as the
existing data-contract system, and Promise-based APIs at host and SDK
boundaries.

**Why ratification is required:** this PRD deliberately revisits the earlier
decision that `platform()` plus a frozen `RunContext` was the final dependency
model. That decision improved the repository, but the present tree now pays for
several independent implementations of context propagation, cancellation,
resource lifetime, retry, time, queues, and error transport. This proposal is
valid only if it replaces those mechanisms monotonically. An Effect wrapper
around the existing machinery, with no corresponding deletion, is rejected.

## 1. Summary

TeXRA has built much of an application runtime from small Promise libraries and
local conventions:

- `Platform` is a process-global service locator.
- `RunContext` and trace stages use separate `AsyncLocalStorage` scopes.
- PocketFlow copies an immutable services object into every node.
- `AbortController`, `AbortSignal`, callbacks, and status flags implement
  cancellation.
- `DisposableStore`, `try`/`finally`, and local error aggregation implement
  resource safety.
- `p-queue`, `p-defer`, `p-map`, `async-mutex`, `p-retry`, `p-timeout`, and
  `delay` implement separate parts of concurrency and time.
- Thrown exceptions, result unions, Zod error records, and a small use of
  `neverthrow` provide several distinct error channels.

Each local mechanism is defensible in isolation. Their composition is the
problem. A run that invokes a model, streams output, executes tools in
parallel, waits for a follow-up, persists a checkpoint, and then shuts down
must carry the same lifetime and failure facts through all of them. Today that
composition is expressed by convention and cleanup code rather than by one
runtime.

Effect 4 supplies the common algebra that is missing:
`Effect<A, E, R>` records success, expected failure, and required services;
`Layer` constructs services; fibers provide structured concurrency;
`Scope` owns acquisition and release; `Schedule` describes retry and pacing;
and `Clock`, queues, deferred values, semaphores, logging annotations, and
spans share the same execution context.

The migration is not a rewrite. Pure code stays pure. Product state and durable
formats stay as they are. The work proceeds by one complete vertical slice at
a time, and every phase must delete more custom runtime machinery than it adds.

### Expected product outcomes

The work is architectural, but its acceptance is not merely aesthetic. Users
and SDK consumers should observe:

- cancellation that promptly stops owned model, tool, polling, and subprocess
  work without leaving a run half-alive;
- shutdown that completes only after owned resources are released, with clear
  diagnostics when release fails;
- retry and timeout behavior that is consistent across hosts and does not hide
  nested retry loops;
- safe concurrent SDK runs in one process without platform or session leakage;
- fewer host-specific failures caused by a capability having a silent default;
- more predictable recovery because interruption, expected failure, and defects
  cannot be accidentally collapsed into the same thrown `Error`.

For maintainers, a new backend operation should state its required services,
expected failures, concurrency policy, and lifetime in its type and immediate
construction, rather than requiring a search through composition roots,
cleanup callbacks, and ambient readers.

## 2. Evidence from the current repository

### 2.1 Survey method

The survey was re-run on 2026-08-27 against main commit `af31933740c7`. Counts
below include production TypeScript under `src/` and `packages/`, exclude
`src/test-kernel`, `*.vitest.ts`, package test directories, generated `dist/`,
and dependencies. They are indicators of repeated mechanisms, not targets to
reduce blindly.

The survey also re-read the current implementations of `Platform`,
`RunContext`, `RunScope`, `BaseNode`, `Flow`, `PersistedFlow`,
`runReflectionFlow`, `runToolUseFlow`, `AgentRunLifecycle`, `SessionHandle`,
`FollowUpQueue`, `DisposableStore`, the retry helpers, and the host composition
roots. Earlier DI, lifecycle, error, and session-ownership proposals were used
as historical evidence but not treated as descriptions of the present tree.

### 2.2 Measured surface

| Mechanism                       | Production files | Occurrences | Interpretation                                                                        |
| ------------------------------- | ---------------: | ----------: | ------------------------------------------------------------------------------------- |
| `platform()`                    |              105 |         221 | Process-global dependency reads are widespread.                                       |
| `tryPlatform()`                 |                5 |           6 | Some callers must tolerate missing global initialization.                             |
| `setServices()`                 |                7 |          10 | PocketFlow has a second dependency carrier; tests amplify this surface substantially. |
| `AbortSignal`                   |               88 |         173 | Cancellation is part of many APIs but has no single execution owner.                  |
| `new AbortController()`         |               17 |          20 | Several subsystems construct their own cancellation trees.                            |
| Explicit abort checks/listeners |               46 |         109 | Cooperative cancellation is manually maintained.                                      |
| `Promise.all`                   |              124 |         203 | Parallelism is common but has no uniform supervision policy.                          |
| `Promise.allSettled`            |               14 |          18 | Some call sites manually preserve sibling failures.                                   |
| `Promise.race`                  |                8 |           9 | Timeout and cancellation races are assembled locally.                                 |
| `catch` clauses                 |              368 |         884 | Failure classification and recovery are widely distributed.                           |
| `throw new Error` / `TypeError` |              189 |         405 | Most asynchronous signatures erase expected failure types.                            |
| `finally` blocks                |               98 |         145 | Resource and state cleanup depend heavily on local control flow.                      |

Seven small concurrency packages have 76 production import sites in total:

| Package       | Production importing files | Principal use                                    |
| ------------- | -------------------------: | ------------------------------------------------ |
| `p-queue`     |                         35 | serialization, admission, and concurrency limits |
| `p-map`       |                         12 | bounded parallel traversal                       |
| `p-retry`     |                          9 | retries and abort sentinels                      |
| `p-timeout`   |                          8 | timeouts                                         |
| `p-defer`     |                          7 | one-shot coordination                            |
| `async-mutex` |                          4 | locks and keyed serialization                    |
| `delay`       |                          1 | sleep                                            |

The test suite separately contains 66 `vi.useFakeTimers()` calls in 34 files,
and the production tree contains several injectable `now`/`nowMs` functions
whose sole purpose is deterministic testing. This is evidence that time is a
dependency even where the type system does not presently show it.

The catch-clause count was computed from the TypeScript syntax tree, including
optional catch bindings. Its largest concentrations are:

| Zone                       | Catch clauses |
| -------------------------- | ------------: |
| `src/agent`                |           264 |
| `src/tools`                |           128 |
| `packages/extension`       |           102 |
| `packages/cli`             |           100 |
| `packages/desktop`         |            69 |
| `src/transcript`           |            46 |
| `src/controllers`          |            40 |
| Remaining production zones |           135 |

The independently verified predecessor assessment supplies a second useful
snapshot at commit `d8c6dfc`: 53 module-level mutable bindings in production
`src/`, 33 exported global `set*` / `register*` / `install*` / `init*`
functions, a 642-line fake-platform implementation, and a five-entry
composition-root lint allowlist. These are historical indicators rather than
current exit counts. Phase 0 remeasures them with a checked script and assigns
each item to one of three sets: eliminated by scoped ownership, retained as a
justified process singleton, or outside the migration.

### 2.3 The clearest local examples

1. `runToolUseFlow.ts` manually tracks a primary failure, a list of teardown
   failures, a live attachment flag, persistence-recovery state, startup
   cancellation windows, flow-record disposition, queue disposition, and the
   precedence between run and cleanup errors. This code is careful and
   necessary under Promises. It is also a local implementation of scoped,
   interruptible execution with an `Exit` value.
2. `SessionHandle` owns a custom LIFO `DisposableStore`; the host composition
   roots create additional stores. `DisposableStore` is synchronous, so
   asynchronous teardown requires separate conventions.
3. `FollowUpQueue` combines an array, `p-defer`, an abort listener, a
   single-consumer invariant, queue disposal, and a nullable cancellation
   sentinel. Effect already has queues, deferred values, interruption, and
   scoped finalizers under one runtime.
4. `RunContext` and `TraceEmitter` each use `AsyncLocalStorage`, while
   PocketFlow separately copies services. A single logical run therefore has
   several context-propagation rules.
5. `tools/timeouts.ts` composes `AbortSignal.timeout`, `AbortSignal.any`,
   `p-retry`, `ky` timeout errors, `DOMException` conventions, and
   `is-network-error`. The policy is sound, but its cancellation, clock,
   retry, and failure channels are not one value.

These are not isolated defects. They show that TeXRA needs an execution model,
not another helper function.

### 2.4 Orchestration is larger than PocketFlow

The runtime has several nested interpreters and iteration coordinates:

| Surface                        | Durable meaning                                                                             | Present in-process machinery                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Reflection round               | Numbered product iteration, bounded by configuration and one persisted compile-repair grant | `RoundPersistedFlow`, cursor rewind, mutable round state, stage callbacks, abort polling                                   |
| Response continuation          | Additional provider call within one reflection round                                        | Nested `ResponseCycleFlow`, continuation counter, duplicated round finalization fallback                                   |
| Tool-use cycle                 | One model response, its tool calls, and the decision to continue or wait                    | Outer persisted node around an inner flow, session lifecycle, manual teardown ledger                                       |
| Workflow-script phase and call | Deterministic script position and restart-safe `agent()` result                             | Sandbox, replay journal, execution snapshot, `PQueue`, timeout, commit fence, coalesced writer, per-call abort controllers |
| Stable subagent attempt        | Reservation, launch, durable completion, or retry permission for one logical child call     | `stableSubagentAttempt`, `inBandSubagentExecution`, child-run loop, strategy and delivery wrappers                         |
| Host conversation round        | A user-visible turn that may resume or spawn children                                       | Host queues, execution handles, stream status, follow-up ownership                                                         |

These structures should not all be rewritten as PocketFlow graphs, and they
should not all become Effect schedules. They do, however, share three runtime
needs: scoped execution, typed exits, and a durable activity boundary for
external work.

### 2.5 Second survey: repeated mechanism families

A follow-up survey on 2026-08-28 read, file by file, the backend zones the
first pass covered only through counters: `src/tools`, the model handlers,
transcript and storage persistence, the CLI and desktop host backends,
controllers, and auth. Its strongest result is not any single site. It is
that the same small runtime mechanism is re-implemented independently, with
slightly different correctness conditions, in subsystems that share no code.

| Family                                                               | Independent hand implementations (verified examples)                                                                                                                                                                                                                                                          | Replacement                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| One-shot settlement: captured resolver plus a settled/identity guard | Three deferreds in the CLI headless-run skeleton (`runExecution.ts`); the pending-approval registry (`ApprovalRequestHandler.ts`); session-claim reservations (`agentCliSessionRegistry.ts`); lease release (`executionLease.ts`); two `settled` flags in the OpenAI WebSocket transport                      | `Deferred`; once-only settlement is the built-in invariant, so every guard deletes                                     |
| Single-flight memo with a generation counter or identity CAS         | `SupabaseSession.refreshPromise`; `runtimeModelRegistry.ts`; `ModelCell.ts`; `StreamLogStore.ensureLoaded`; `coalesceAsync`                                                                                                                                                                                   | `SynchronizedRef` plus cached effects; the counters exist only because a promise memo cannot be atomically invalidated |
| Per-key queue with an idle-GC epilogue                               | Five slightly different "delete the queue from its map once idle" epilogues: `jsonStore.ts`, `TexraTranscriptRecorder.ts`, `executionLease.ts`, `StreamSnapshotStore.ts`, `executionRegistry.ts` — beside `perKeyQueue.ts`, which factors out only the creation half                                          | Keyed semaphore under `Scope`; lifetime is the scope, not an epilogue                                                  |
| Timers and backoff with injected clock seams                         | `annotationFetchBudget.ts`, a hand-rolled token bucket whose header documents its injectable clock and `resetForTests`; `deviceCodePoll.ts` `now`/`sleep` injection; the `PollingSourceBase.ts` per-subscription failure ledger; `BackgroundPoller.ts` deadline arithmetic; `directLspAdapter.ts` idle timers | `Schedule` and one clock; the injection seams and `resetForTests` delete                                               |
| Cancellation races and normalization                                 | `abandonOnAbort` (`tools/support/rateLimiter.ts`); `waitWithTimeout` (`ExecutionsTool.ts`); hand-minted `DOMException`s in the retry gate and WebSocket transport; `isUserAbort` re-derivation at roughly ten sites; a regex over error messages classifying disposal (`lean/direct/jsonRpc.ts`)              | Interruption as the one cancellation channel; `Cause` distinguishes it by construction                                 |
| Streaming finalize choreography                                      | Six near-identical provider blocks (Anthropic, OpenAI, OpenAI Responses, Google, VS Code LM, OpenRouter), one carrying an explicit `streamsFinalized` flag so `finally` cannot overwrite the success path                                                                                                     | Scoped stream handles with an `Exit` fold; error-path finalization becomes automatic                                   |
| Hand-built pools, breakers, and sagas                                | The ref-counted keyed Lean LSP session pool (`directLspAdapter.ts`, ~330 lines); the per-route circuit breaker (`ModelRetryGate.ts`, 348 lines); staged two-phase stream deletion (`StagedDeletionCoordinator.ts`, 644 lines); the API-key routing rollback saga (`ProgressApiKeyRetryController.ts`)         | `RcMap`, `acquireUseRelease` with an `Exit` fold, rate limiting, LIFO finalizers                                       |
| Polling for an in-process fact                                       | A 25 ms poll loop for the stream id whose own comment states the queue library "doesn't have an 'await predicate' primitive" (`chatSubmitDriver.ts`); the diff-host quiescence detector (`desktopDiffHost.ts`); the session-claim respin (`agentCliShared.ts`)                                                | `Deferred` and fiber joins; waiting for an in-process fact is never polling                                            |

These findings change no decision in this PRD. They widen the Phase 3 and
Phase 5 deletion pool, provide concrete inputs for the Phase 0 catch and
installer censuses, and sharpen phase acceptance: when a phase completes, its
rows here must name deleted code, not surviving parallels. Two of the sites
carry the survey's conclusion in their own comments — a poll loop written for
want of an awaitable predicate, and a token bucket written for want of a
controllable clock. Contributors are already paying for the missing runtime
one workaround at a time.

## 3. Problems to solve

### P1. Dependencies have several carriers and several lifetimes

Process capabilities come from `platform()`. Run facts come from both
`RunContext` and explicit input objects. Flow services are copied through
`setServices()`. Trace grouping has another ambient scope. Some remaining host
services use module-level setters.

The immediate cost is not merely long parameter lists. It is uncertainty about
which carrier is authoritative, whether a value may change during a run, and
how a test can replace one dependency without initializing unrelated global
state.

### P2. Cancellation is a convention, not a structural property

An `AbortSignal` is passed widely, but child work is not automatically owned by
its parent. Callers must remember to combine signals, poll `aborted`, remove
listeners, cancel queues, and await cleanup. Detached subagents are a deliberate
exception; ordinary work should not become detached accidentally.

This makes cancellation correctness difficult to review. The type of a Promise
does not say whether it is interruptible, whether its children are supervised,
or whether cancellation waits for finalizers.

### P3. Resource lifetime is hand-written

TeXRA correctly treats files, subprocesses, model handlers, trace handles,
listeners, queues, leases, and session attachments as owned resources. The
ownership rules are distributed across `DisposableStore`, `finally` blocks,
callbacks, and comments about disposal order. Synchronous and asynchronous
resources use different mechanisms.

The result is code such as the teardown ledger in `runToolUseFlow`: a second
program describing how the first program must unwind. Effect scopes can encode
this lifetime beside acquisition and guarantee finalization on success,
expected failure, defect, and interruption.

### P4. Retry, timeout, delay, and clock are separate systems

Retry attempts use `p-retry`, timeouts use both `p-timeout` and abort-signal
timeouts, sleeps use timers or `delay`, and tests replace either the clock
function or global timers. Error classification is repeated because each
library exposes a different terminal shape.

A retry policy should be a value built from one clock, one interruption model,
and one error predicate. It should be possible to test an hour of backoff
without an hour of wall-clock time.

### P5. Concurrent work lacks a common supervision model

`Promise.all`, `PQueue`, `p-map`, mutexes, deferred promises, and registries
solve different local problems. They do not state, in a uniform way:

- whether one failure interrupts siblings;
- whether all failures are collected;
- whether child work may outlive its parent;
- how shutdown waits for running work;
- which queue owns backpressure and fairness;
- how concurrency limits compose across nested agents.

TeXRA has already had to document these questions carefully for child-run
budgets, execution queues, follow-up admission, and shutdown. Structured fibers
do not answer the product policy, but they make the chosen policy executable.

### P6. Expected failures disappear from signatures

TeXRA's error classification and exactly-once presentation work is largely
sound and must be preserved. The remaining weakness is below that boundary:
many operations return `Promise<A>` while throwing several expected operational
errors. A caller learns the actual error set by reading implementation code and
catch blocks.

Effect's error parameter can make operational failures explicit while keeping
programming defects distinct. This does not require turning every domain
outcome into an exception. Values such as `sent | queued | failed`, run
outcomes, and approval decisions remain ordinary success values where callers
must branch on all cases.

### P7. Observability context is manually transported

`AgentTrace` is a product protocol: its events drive transcripts, progress UI,
and durable facts. It must not be replaced by generic logs or spans. However,
the active run, stage, attempt, and tool call are execution context. Today
those facts are transported through objects and `AsyncLocalStorage`, and every
concurrent branch must preserve them correctly.

Effect fiber-local references, log annotations, and spans can carry this
context. An adapter can continue emitting the existing `AgentEvent` union, so
the product protocol remains unchanged while propagation becomes structural.

### P8. Tests reconstruct runtime behavior indirectly

Tests initialize global platforms, replace module implementations, inject
clock functions, use fake timers, create deferred promises, and manually tear
down registries. These techniques are valid but collectively make tests depend
on import order and shared process state.

Per-test layers, a test clock, scoped resources, and fiber inspection should
make the durable behavior easier to test without introducing more production
test seams.

### P9. The dependency surface obscures architectural boundaries

The root dependency list contains many libraries that collectively approximate
one runtime. Their concepts do not compose at the type level, so architecture
rules must be enforced through comments, file placement, baselines, and
reviewer memory. A common effect type makes required services and failures
visible across package boundaries and gives architectural tests a more precise
surface to inspect.

### P10. Iteration names conceal different semantics

Retry attempts, response continuations, reflection rounds, tool cycles,
workflow phases, and host turns currently use overlapping loop, callback,
cursor-rewind, and error conventions. A transient retry may be safely expressed
by a `Schedule`; a completed model continuation or child-agent call may have
incurred cost and produced externally meaningful state, so replaying it after a
restart is a different operation. Treating both as generic repetition would
make the code shorter while weakening recovery.

### P11. Multi-agent workflow dispatch is a second runtime

The workflow-script engine correctly supplies deterministic script control flow
and durable call journaling. Around that domain core it separately implements
concurrency admission, timeouts, cancellation propagation, abandoned-child
draining, first-failure precedence, snapshot writing, child execution control,
and cleanup. Native delegation implements many of the same child-call phases
through different entry points. The common child activity should have one
execution and persistence protocol; script parsing and journal replay should
remain workflow-script policy.

### P12. Catch clauses encode several incompatible meanings

The survey found 884 production catch clauses. Their count is not itself a
defect: filesystem and SDK boundaries genuinely throw, best-effort projections
must not replace primary outcomes, and sandbox errors cross JavaScript realms.
The problem is that the syntax does not reveal whether a catch is translating a
boundary error, recovering from a typed condition, implementing cleanup,
aggregating secondary failures, converting exceptions into control flow, or
hiding a defect. Cancellation can therefore be caught as an ordinary error,
the same failure can be logged at several levels, and local catch blocks must
manually preserve primary-error precedence.

### P13. Status, settlement, and ownership are arbitrated, not owned

Several run-lifecycle concepts exist to arbitrate plural authority over one
fact rather than to model the domain: the stream status machine's `reserved`
entries with `rollbackTo` state, the escalation ladders that fabricate
intermediate RUNNING transitions to satisfy the transition table (visibly —
hosts reset per-run display state one tick before the terminal event),
`transitionStopBeforeRunStart`, the `TerminalState` claim gate whose own
comment explains that two finalizers "racing across await points" must not
both win, the `terminating` suspension state, the interaction-ownership
generation index that reconstructs a reference count by observing registry
events and reserves `pendingActivations` so a sync-start/async-handle gap
does not read as idle, and the status-generation and hold staleness fences.

The plural authorities are concrete: two writers of terminal status (the
registry stop path and the lifecycle arms), two persistence authorities
after a crash (stream phase versus the flow-resume record), and runs whose
identity spans await points with no structural owner. The repository has
already diagnosed this pattern itself: the 2026-08-16 census
(`docs/proposals/2026-08-16-define-out-of-existence.md`) ruled eighteen of
nineteen race guards deletable and named the remaining two structural. The
domain kernels are real — one run per stream tab, one terminal outcome per
run, interaction surfaces outliving a root turn, per-execution lanes,
cross-process holds — but each is currently wrapped in async-gap
bookkeeping that structured ownership renders unnecessary: an owner fiber
per run produces one `Exit`, so exactly-once settlement is a construction
fact; a WAITING run is a parked fiber rather than a returned function that
left a teardown closure behind; stream phase becomes a single-writer
projection of local fiber state, durable run records, and cross-process
leases; and interaction-surface lifetime becomes a host scope kept alive by
the fibers forked under it, deleting the observer-reconstructed index.

## 4. Problems this migration does not solve

Effect is not an answer to every difficult part of the runtime.

- It does not decide who owns a session, stream, checkpoint, or transcript.
- It does not make an incorrect persistence transition correct.
- It does not replace PocketFlow's persisted cursor or graph semantics.
- It does not determine approval policy or which tool operations are safe to
  retry.
- It does not replace `AgentEvent`, session facts, Zod wire schemas, or host
  presentation rules.
- It does not remove the need for explicit execution identifiers and durable
  fencing across processes.
- It does not justify converting pure functions, browser rendering, or simple
  synchronous data structures into effects.

The migration must preserve every current single-owner product ruling. Effect
is the execution substrate beneath those rulings.

## 5. Goals

1. Establish one typed execution model for dependencies, expected failures,
   cancellation, concurrency, time, and resource lifetime.
2. Eliminate `setServices()` and service-object spreading from PocketFlow
   nodes while preserving PocketFlow's durable state-machine role.
3. Retire the global `platform()` reader from host-neutral production code.
4. Make every ordinary child task structurally owned; require an explicit API
   and name for the few detached tasks.
5. Replace local retry, timeout, deferred, queue, semaphore, and disposal
   machinery where Effect provides a clearer equivalent.
6. Preserve Promise-based public APIs for extension, desktop, CLI, and
   `@texra-ai/agent` consumers.
7. Preserve the existing error-classification and exactly-once presentation
   architecture.
8. Improve deterministic testing without adding production-only test hooks.
9. Remove dependencies and code as each replacement becomes authoritative.
10. Collapse duplicate carriers and lifecycle protocols rather than translating
    each existing abstraction into an Effect-shaped counterpart.

## 6. Non-goals

1. No all-at-once rewrite.
2. No conversion of Lit, Ink, Electron renderer, or VS Code UI state merely to
   use Effect.
3. No migration from Zod to Effect Schema in this program.
4. No adoption of `effect/unstable/*` modules in the foundation phases.
5. No replacement of PocketFlow with Effect's experimental workflow module.
6. No change to wire protocols, agent YAML, or public result schemas. Durable
   flow formats remain unchanged through Phase 2 and Stage 3a; Stage 3b may
   introduce one explicit versioned representation for finer checkpoints
   under the rollout section's reader-outlives-writer rule.
7. No public `Effect` return types from `@texra-ai/agent` in the first release.
8. No automatic retry expansion. Existing idempotency and retry ownership
   decisions remain binding.
9. No generic repository-wide conversion of every `Promise` or `Error`.
10. No duplicate "Effect service" wrapper around a global singleton as the
    final state.
11. No migration of `appSignals` without a concrete deletion case. It already
    has one documented synchronous signal protocol and abort-aware
    unsubscription; changing its notation alone has no runtime benefit.

## 7. Governing design rules

### R1. Effect exists inside, Promises at the boundary

Host callbacks, IPC handlers, VS Code commands, Electron entry points, CLI
commands, and the published SDK continue to speak Promises. They enter Effect
through a host-owned runtime. Calls to `Effect.runPromise`, `runSync`, or
`runFork` are forbidden below named boundary modules.

### R2. Services follow semantic boundaries

The migration does not mechanically turn each `Platform` field or
`AgentCore` field into a `Context.Service`. That would preserve the same object
graph while adding tags and layer constructors. A service earns a place when it
is independently implemented, acquired, scoped, or substituted in meaningful
tests. Plain immutable inputs remain function arguments, and local coordination
objects remain local values.

The process-level grouping is determined by ownership and co-usage. The
provisional groups to validate in Phase 0 are:

- workspace I/O: workspace identity, filesystem, storage, and file locking;
- application state: validated configuration plus global and workspace state;
- credentials: secrets alone, because their security and test treatment differ;
- process execution: child processes and host shutdown registration; and
- agent-host integration: resume, agent directories, tool availability,
  language-model access, and optional host presentation.

These are not five mandatory new wrapper interfaces. If consumers require only
one existing port and it already has the right lifetime, that port may be the
service value directly. Conversely, fields that always share construction,
lifetime, failure policy, and test replacement should not be split merely to
make Effect requirement types appear precise.

The current Effect 4 RC API uses `Context.Service`. Examples written against
older v4 betas with `ServiceMap.Service` must not be copied.

```ts
import { Context } from 'effect';

export class Workspace extends Context.Service<Workspace, WorkspaceProvider>()(
  '@texra/platform/Workspace',
) {}
```

### R3. Layers follow actual lifetimes

The dependency graph has four principal lifetimes:

```text
Host process        config, filesystem, storage, secrets, processes
  └─ Session        interactions, execution registry, follow-up ownership
      └─ Agent run  run identity, model cell, trace, policy, cancellation
          └─ Call   tool input, approval request, temporary resources
```

Longer-lived layers may construct shorter-lived layers, never the reverse.
Mutable state may be contained inside a service, but the service binding itself
is immutable. A run-specific layer is supplied once around the run; it is not
rebuilt in every node. A `Layer` is a construction recipe, not another domain
layer in the repository: no `FooLayer` wrapper survives when it only calls
`Layer.succeed(Foo, value)` once.

### R4. The agent runtime is plain Effect; no state-machine framework

**Amended 2026-09-06 by owner ruling.** This rule originally read "PocketFlow
retains state-machine authority" and prescribed a typed `FlowNode.run`
transition over a graph kernel. That is reversed. There is no PocketFlow, no
node, no graph, no action string, no cursor, and no flow record. Each flow
family (document-based reflection, tool use) is one plain Effect loop, written
with `Effect.fn` and `Effect.gen`, whose only durable act is appending rows to
the session event table on the execution's own aggregate; run state is a pure
fold of those rows (`foldRunState`, in `src/shared`), computed the same way on
resume and in the trace viewer, and never persisted. The shape, the six row
types, the services (`RunLedger`, `RunContext`, `ModelInvoker`, `Tools`,
`FollowUps`, `OutputPipeline`), and the elimination ledger are specified in
`docs/proposals/2026-09-04-agent-runtime-on-effect.md` §2 and §4.

What does not change: an Effect fiber, scope, `Ref`, `Exit`, or `Cause` is
still not a durable object and is never serialized. Effect governs one
in-process attempt; the rows govern what survives process death.

The subsections R4.1 to R4.6 that follow are retained as the **durability
requirements** the row model must satisfy, not as a description of the
mechanism. Their mapping (explicit membrane = the append under
`Effect.uninterruptibleMask`; declared replay classes = `tool.intent` rows for
barrier tools and re-run for parallel-safe ones; finer tool-use checkpoints =
per-call rows; stable identity = logical keys `round`, `turn`, `callId`, never
a traversal path; rounds as durable coordinates = `flow.step`; one child
protocol = the script journal folded into the event table) is the proposal's
§6, first bullet. Where a subsection below speaks of a cursor, a node, a record,
or an interpreter, read the corresponding row-model term.

Preparation, external execution, recovery, and state mutation may remain as
small private functions where they clarify a particular node, but the graph
kernel does not prescribe or dynamically dispatch those phases. Typed recovery
uses the node's Effect program; the kernel handles only graph transition and
durable commit.

The requirements type is inferred from the Effect. `BaseNode<S, Svc>`, `Svc`,
`_services`, `services`, `setServices()`, and the generic fallback dispatcher
disappear. Mutable shared state continues to be explicit and schema-validated.
Each attempt receives a private working copy of the last committed shared
state. The interpreter publishes that copy only after the authoritative record
has been written successfully; failed and interrupted attempts cannot leak
uncommitted mutations through the in-memory record cache.

There are only sixteen production `BaseNode` subclasses at the survey date.
The graph kernel and all subclasses therefore migrate in one bounded phase;
the repository must not carry Promise-nodes and Effect-nodes as two permanent
frameworks.

#### R4.1. The durability membrane is explicit

A persisted step has the following abstract transition:

```text
validated committed record
  -> resolve durable cursor
  -> clone committed shared state
  -> run one scoped, interruptible node attempt
  -> derive action and successor
  -> atomically commit { shared, cursor }
  -> publish cache
  -> update rebuildable projections
```

Only the atomic record commit crosses the durability membrane. Node execution
is interruptible. The filesystem write and subsequent cache publication form a
short uninterruptible critical region, so fiber interruption cannot return to a
caller while the underlying Promise-based atomic write continues unnoticed.
Model calls, tool calls, waits, and other external operations never run inside
that region.

The outcome rules are:

| Attempt outcome                                | Durable result                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success with an ordinary action                | Commit the working state and successor cursor.                                                                                                       |
| Success with `WAITING`                         | Commit the working state and retain the current cursor.                                                                                              |
| Typed failure not converted to a domain action | Commit nothing and surface the failure.                                                                                                              |
| Interruption                                   | Commit nothing, except through an earlier explicit checkpoint operation.                                                                             |
| Defect                                         | Commit nothing and surface the defect through the existing terminal path.                                                                            |
| Record-write failure                           | Publish no cache state; reread to determine whether the old or new complete record is authoritative, and do not automatically repeat the whole step. |

Node-scoped finalizers finish before cursor advancement. A failing finalizer
therefore prevents the step commit. Run-scoped resources may span several
steps, but all child fibers that can affect a step must finish or be interrupted
before that step commits. No child may continue mutating shared state after the
cursor has advanced.

The flow record remains the sole authority. Derived session projections run
after its commit and remain best-effort and rebuildable. "Rebuildable" is a
protocol, not a hope: a projection consumer that must not lose facts records
a durable watermark naming the last committed coordinate it has projected,
and resume re-derives any committed-but-unprojected facts from the record
before new work starts. Re-derivation is idempotent because projections are
keyed by round, activity, or cursor identity, never by emission time.
Interruption between commit and projection therefore delays the projection
until the next attach or resume; it can neither roll back the authoritative
record nor lose the projection permanently. A purely cosmetic projection that
tolerates loss may skip the watermark, but must say so where it is emitted.

#### R4.2. Replay semantics are declared, not assumed

The current protocol gives a failed process an old-or-new flow record, but it
does not make the node body exactly once. A failure after an external action
and before the record commit re-enters the old cursor and may repeat that
action. Effect does not alter this fact. In particular, `Effect.retry` must not
wrap an entire persisted step unless that step is explicitly replay-safe.

Every external operation performed between durable commits belongs to one of
three classes:

1. **Replay-safe:** pure computation or a read that may be repeated.
2. **Idempotent by stable key:** a write whose provider accepts a durable
   operation identifier and returns the same logical result on repetition.
3. **Non-idempotent:** an operation for which repetition can create a second
   effect and no provider idempotency mechanism exists.

The first class may be rerun. The second is retried only with the same stable
key. The third requires a durable activity record with at least intent,
started, and completed states. If recovery finds `started` without
`completed`, the outcome is unknown: the runtime must reconcile it through a
provider-specific read or ask for an explicit decision. It must not retry
blindly. Recording intent before an action and completion afterward narrows the
ambiguity but cannot by itself provide exactly-once execution across a local
file and an external system.

Existing stable subagent-attempt phases are the local precedent for this
protocol. They should be generalized only after tool and model operations have
concrete activity requirements; the migration must not introduce an abstract
activity framework without a first use.

#### R4.3. Tool use receives finer durable checkpoints

The current tool-use cycle is nested inside an outer persisted node. Results
from model invocation and tool dispatch can therefore remain only in memory
until the whole outer cycle returns. Batch-local duplicate suppression does not
survive a restart. This is the principal persistence weakness that the runtime
migration must not preserve accidentally.

The target interpreter makes durable progress addressable inside a nested
cycle. A completed model response is checkpointed before its tool calls are
processed. A side-effecting tool call is given a stable activity identity and
its completion is checkpointed before the next side-effecting call begins.
The existing side-effect barriers become durability barriers:

- a contiguous parallel batch containing only replay-safe reads may commit as
  one unit, because recovery may safely repeat the batch;
- a side-effecting call runs alone and commits its durable result immediately;
- an externally idempotent call reuses its stable key after recovery; and
- an unresolved non-idempotent call stops in an explicit `outcome unknown`
  state rather than being executed again.

This requires either a hierarchical cursor into the nested graph or an
activity ledger referenced by the outer cursor. The choice, record schema, and
recovery interface must be settled in a small persistence design amendment
before the tool-use lifecycle moves to Effect; the recommended default and
its rollback rationale are recorded in §15 and the rollout section. It is not
acceptable to hide the nested flow in one larger Effect and call the
migration complete.

#### R4.4. Cursor identity is stable across refactoring

Version 2 cursor identifiers are derived from graph paths and action labels.
Changing graph composition during an Effect rewrite can therefore invalidate a
resume record without changing product behavior. Phase 2 first preserves the
current graph construction and identifier algorithm exactly. Characterization
tests pin every production cursor path used by resumable flows before node
classes move.

Explicit logical node identifiers and a hierarchical cursor are preferable for
future formats because their identity does not depend on traversal layout.
They require a versioned record decision and are introduced only with the
tool-use checkpoint design. Current sessions either retain version 2 semantics
or are retired according to the repository's compatibility policy; the reader
must not guess a new cursor from an old topology.

#### R4.5. Rounds are durable coordinates, not retry schedules

The target names each kind of repetition explicitly:

| Coordinate             | Runtime representation                                                | Persistence rule                                                                                         |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Provider retry attempt | `Schedule` around one replay-safe adapter                             | Not a new product checkpoint; bounded by the existing retry policy                                       |
| Response continuation  | Effect loop within a round, with addressable model-call activities    | Checkpoint every completed provider response that must not be purchased or generated again after restart |
| Reflection round       | Durable loop state `{ currentRound, totalRounds, repairGranted }`     | Commit round completion and the next-round transition before opening the next scoped round stage         |
| Tool-use cycle         | Durable conversation coordinate                                       | Checkpoint response and side-effect barriers; `WAITING` retains its resumable coordinate                 |
| Workflow-script call   | Durable activity keyed by script checkpoint and logical call identity | Reuse a committed journal result; launch unresolved work according to its recorded attempt phase         |
| Host turn              | Session-owned input/output boundary                                   | Preserve the existing transcript and follow-up authority                                                 |

`RoundPersistedFlow` does not survive as a third interpreter subclass. Its
domain decision—whether another configured or compile-repair round exists—is a
typed transition used by the common durable kernel. The round stage is a scoped
resource around that transition. Workspace reset, round increment, repair-grant
consumption, and cursor movement form one durable next-round operation; process
interruption cannot expose half of it.

The duplicated `onRoundFinalized` fallback disappears — but only after the
R4.1 watermark path exists. Today the duplicate call is the only mechanism
that recovers a usage event when the process dies between the round commit
and its projection; deleting it first would convert a temporary lag into a
permanently missing usage fact. In the target, canonical round facts and
usage are committed once as domain state, and host progress, usage logging,
and other derived notifications occur afterward as watermark-tracked
projections that cannot cause the round to be recorded twice.

#### R4.6. Child-agent dispatch has one durable activity protocol

Native delegation and workflow-script `agent()` calls share one lower-level
operation with these phases:

```text
logical identity
  -> reserve attempt
  -> launch scoped child fiber/run
  -> observe terminal child result
  -> commit reusable result
  -> project progress or deliver follow-up
```

The operation owns stable logical and physical attempt identities,
reservation/launch/commit markers, interruption, progress correlation, terminal
result normalization, and the ambiguous-outcome rule. Delivery mode,
presentation, agent selection, workflow-script labels, and file-dependency
fingerprints remain caller policy.

The workflow-script engine remains a deterministic sandbox and journal
interpreter; it does not become a PocketFlow. Its generic runtime machinery is
absorbed as follows:

- `PQueue` admission becomes structured Effect concurrency with the same
  bound;
- per-call `AbortController` records become owned child fibers plus a map from
  visible execution id to the current control handle;
- `p-timeout` becomes an Effect timeout at the workflow-run scope;
- abandoned `agent()` promises are ordinary scoped children and are drained or
  interrupted before the run exits;
- the journal commit fence and coalesced snapshot writer become one workflow
  persistence coordinator with explicit authoritative and projection writes;
  and
- `WorkflowRunAbortError` becomes a typed workflow failure internally, with
  one serialized error adapter at the sandbox-realm boundary.

Script journal keys, cached-result replay, phase monotonicity, call caps,
dependency fingerprints, and sandbox security remain domain behavior and are
not generalized into the Effect foundation.

### R5. Interruption replaces internal abort choreography

Within migrated code, fiber interruption is the canonical cancellation
mechanism. `AbortSignal` is adapted only where an external SDK or host API
requires it. Existing host signals may enter through `ManagedRuntime.runPromise`
options. An internal operation does not create an `AbortController` merely to
cancel another Effect operation.

Detached work uses one deliberately named primitive and records ownership.
Ordinary `fork` operations remain scoped to their parent.

### R6. Scope owns resources

Resources acquired inside migrated code use `Effect.acquireRelease`, scoped
layers, or scope finalizers. Finalizers state whether they run sequentially or
in parallel and preserve the existing domain-specific cleanup order.

The current `LifecycleHost` contract has three properties, not two. It runs
the `BEFORE` phase to completion before `ON`; handlers within each phase run
sequentially in registration order; and each phase is bounded by a
five-second abort-then-advance deadline — at the deadline every handler's
abort signal fires, the laggard is reported, and the drain advances without
waiting further. Effect scopes normally finalize in reverse registration
order and can wait indefinitely on an uninterruptible finalizer, so a direct
transfer of callbacks into one scope is incorrect twice over: it inverts the
order and it deletes the deadline.

`LifecycleHost` therefore remains the single shutdown authority. The managed
runtime's disposal registers as an ordinary `ON`-phase handler: on the phase
deadline the disposal's root fiber is interrupted, and if disposal still does
not settle, the host reports and abandons it exactly as it abandons any other
laggard. The migration does not build a second, unbounded shutdown path out
of scope finalization. Characterization tests pin the two phase boundaries,
the FIFO order, and the deadline behavior before this code changes.

`DisposableStore` remains for host APIs that synchronously return disposable
objects until those edges migrate. It must not be used inside completed Effect
zones.

### R7. Typed errors complement, rather than replace, domain values

Expected operational failures occupy the Effect error channel. Programming
errors remain defects. Cancellation remains interruption. Domain decisions
that callers must inspect remain success values.

At the existing agent boundary, typed failures are normalized through the
current `classifyAgentError` and terminal-result pipeline. The migration must
not create a second user-facing error taxonomy or a second presentation path.

Every catch site touched by migration is assigned one of the following
meanings before it is rewritten:

| Meaning                                       | Effect form                                                            | Local `try/catch` target                           |
| --------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Promise, SDK, filesystem, or sandbox boundary | `Effect.tryPromise` / `Effect.try` with one error mapper               | Remains only inside the adapter                    |
| Recovery from an expected domain failure      | Tagged error plus `catchTag` or a narrow predicate                     | Replaced by typed recovery                         |
| Cleanup                                       | Scope finalizer, `ensuring`, or `onExit`                               | Deleted                                            |
| Best-effort projection                        | Narrow error handler that records diagnostics after authoritative work | Centralized at the projection boundary             |
| Parallel secondary-failure aggregation        | `Cause` or one domain-specific reducer over child `Exit` values        | Manual failure arrays deleted when semantics match |
| Exception used as a branch or sentinel        | Discriminated success or typed failure                                 | Deleted                                            |
| Programming defect                            | Defect channel                                                         | Not caught locally                                 |

`catchAll` is not the default replacement for `catch`. Recovery should be
tag-specific, and interruption must remain interruption unless a product
boundary deliberately represents cancellation as data. A completed Effect zone
contains no raw catch clause except a synchronous callback or foreign-runtime
adapter that cannot return an Effect. Errors are logged at the owner that
decides their disposition, not again at each propagation layer.

### R8. One clock and one schedule model

Migrated delays, timeouts, retries, polling, and cache expiry use Effect's
clock and schedule facilities. Retry predicates preserve existing transient
error and idempotency rules. Tests advance the test clock rather than waiting
or passing production clock callbacks.

### R9. Product traces remain product traces

`AgentTrace` and `AgentEvent` remain authoritative. Effect spans and
annotations may enrich them or export OpenTelemetry data, but no host UI reads
generic Effect logs directly. A trace adapter maps fiber context to the
existing stream, stage, attempt, and execution fields.

### R10. Replacement must delete

Every migration PR states:

- which custom mechanism becomes unreachable;
- which existing carriers or lifecycle stages collapse, if any;
- which imports or dependencies are removed;
- whether lines and architectural elements decrease;
- the temporary adapter's deletion phase and deadline, if one is unavoidable.

An adapter may live for at most sixty days or until the next named migration
phase completes, whichever comes first. It carries its introduction date and
retirement condition beside the code.

## 8. Target architecture

### 8.1 One carrier at each lifetime

The present runtime repeats the same information through `Platform`,
`AgentLaunchContext`, `RunScope`, ambient `RunContext`, `AgentCore`,
`BaseFlowContextInit`, and each PocketFlow service field. The target has one
carrier at each actual lifetime:

| Lifetime | Target carrier                 | Existing structures absorbed or deleted                                                                                     |
| -------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Process  | Host-managed Effect runtime    | Global `platform()` lookup and per-subsystem runtime construction                                                           |
| Session  | Session service/value          | Separate interaction, execution-registry, and follow-up carriers when they have the same owner                              |
| Run      | `AgentRun` service             | `AgentLaunchContext` as a dependency bag, ambient `RunContext`, `AgentCore`, `BaseFlowContextInit`, and PocketFlow services |
| Call     | Lexically scoped Effect values | Ad hoc abort controllers, disposable stores, and callback cleanup ledgers                                                   |

`RunScope` may survive as the immutable identity value inside `AgentRun`; it
does not also travel through several public context shapes. Agent definition,
prompt, setting, and initial state are ordinary program inputs unless a caller
must dynamically replace them. The live model cell, session interactions,
trace, tool policy, and run identity belong to the run service because they are
ambient capabilities or mutable run-owned state.

The `bare` ambient run-context variant disappears. Tests and one-shot tools
provide a small `AgentRun` test service or pass explicit values to a pure
function. Production code no longer contains optional getters whose principal
purpose is to tolerate execution outside the runtime.

Service identifiers use a stable `@texra/<domain>/<name>` namespace. They are
unique repository-wide and are not derived from filenames. The number of
service declarations is a reviewed architectural quantity, not a count of
fields in existing interfaces.

### 8.2 Host layers and runtime

Each host constructs one complete process layer from its existing adapters:

```ts
export function makeApplicationLayer(adapters: HostAdapters) {
  return Layer.mergeAll(
    makeWorkspaceIo(adapters),
    makeApplicationState(adapters),
    Layer.succeed(Credentials, adapters.secrets),
    makeProcessExecution(adapters),
    makeAgentHost(adapters),
  );
}
```

The helper names illustrate ownership groups, not required wrapper modules.
Straight `Layer.succeed` bindings stay in the composition root. A helper exists
only for acquisition, finalization, configuration, or reuse substantial enough
to test independently.

Each host process owns one `ManagedRuntime` and disposes it during its existing
shutdown path. The runtime is not reconstructed per command or per agent run.
Effect documents `ManagedRuntime` specifically for repeated execution against
services built once from a layer, with managed disposal.

### 8.3 Run layer

Launch preparation resolves ordinary immutable inputs, acquires run-owned
resources, and constructs one `AgentRun` service. It does not return another
general dependency bag:

```ts
const runLayer = Layer.scoped(AgentRun, acquireAgentRun(launchInput));

const program = executeAgentProgram(agentDefinition, initialState).pipe(
  Effect.provide(runLayer),
);
```

Run interruption is fiber interruption. SDK `AbortSignal` values are derived at
SDK adapters rather than stored as a second cancellation authority on
`RunScope`. A control handle may expose interruption to Promise callers, but it
interrupts the owned root fiber.

### 8.4 Two loops over one ledger, no kernel

**Amended 2026-09-06 by owner ruling** (this section originally specified
"one graph transition kernel"). There is no graph and no transition kernel.
`Flow`, `PersistedFlow`, `RoundPersistedFlow`, `ResponseCycleFlow`,
`ToolUseRoundFlow`, and every node class are deleted. In their place:

- `runToolUse` and `runReflection`, two `Effect.fn` loops in
  `src/agent/runtime/loop/`, re-yielding the services they need from
  `Context` rather than closures. The reflection loop carries one extra
  coordinate (the round) and opens each round under `Effect.scoped` with an
  `acquireRelease` stage.
- `RunLedger`, a per-session-root `Context.Service` over `SessionEvents`:
  `append(row) -> Effect<RunState>` and `load(executionId)`. The append is
  the single uninterruptible region and runs under the publisher's permit.
- `foldRunState(rows) -> RunState`, pure and data-only in `src/shared`: latest
  `flow.snapshot`, then later `model.compaction`, `model.message`,
  `tool.result`, and `flow.step` rows in order. It runs in `RunLedger.load`
  and in the trace viewer's stepper and nowhere else; "state at step k" and
  "resume would continue after step k" are the same fact.

Persistence validation and atomic writing remain the substrate's boundaries
(contract C1 to C10 in the persistence substrate decision); nothing in the
runtime walks a graph around them.

### 8.5 External async adapters

Promise APIs enter through `Effect.tryPromise` when they have an expected
failure mapping, or an appropriate Effect integration when available.
Abortable SDK calls derive an `AbortSignal` from the current fiber only at that
adapter. Node callbacks and event emitters use scoped async constructors so
listeners are removed on interruption.

### 8.6 Testing layers

Tests provide only the services they exercise. Reusable fake implementations
remain ordinary objects, supplied with `Layer.succeed`. Tests of time use the
Effect testing clock. Tests of resource ownership assert finalizers and fiber
termination rather than inspecting private abort-controller state.

The repository's existing rule still applies: the migration does not add tests
for trivial plumbing. One regression test is added only where a migrated
boundary protects a consequential cancellation, cleanup, retry, or typed-error
contract not already covered.

### 8.7 Required collapse ledger

The following is the intended net architecture, not merely a list of possible
library substitutions:

| Present mechanisms                                                                                                          | Target                                                         | Required deletion or absorption                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Platform` global reader plus copied flow services                                                                          | Process services and one run service                           | `platform()` access in migrated zones, `setServices()`, and service spreading                                   |
| `AgentLaunchContext`, `RunScope`, `RunContext`, `AgentCore`, `BaseFlowContextInit`                                          | Plain launch inputs plus `AgentRun`                            | Mirrored fields, ALS projection helpers, and the `bare` production fallback path                                |
| `prep`, `exec`, `execFallback`, `post`                                                                                      | One `FlowNode.run` Effect                                      | Generic phase dispatcher and untyped intermediate transport                                                     |
| `Flow` and `PersistedFlow` orchestration loops                                                                              | One transition kernel with a commit policy                     | Duplicate graph walking and specialized subclasses with no domain semantics                                     |
| `RoundPersistedFlow`, response finalization callbacks, and cursor rewind                                                    | Durable round transition plus scoped stage                     | Third interpreter subclass and duplicate round-finalization fallback                                            |
| Stable-subagent, in-band, child-loop, and workflow `agent()` launch paths                                                   | One durable child-call operation                               | Parallel reservation, launch, interruption, result, and commit choreography                                     |
| Workflow queue, timeout, abort map, pending-call drain, and first-fault ledger                                              | One scoped workflow-run Effect                                 | Generic Promise runtime inside the deterministic script engine                                                  |
| Abort-controller trees, timeout wrappers, and sticky cancellation flags                                                     | Root fiber interruption with SDK-edge signals                  | Internal abort choreography and cancellation normalization layers                                               |
| `DisposableStore`, manual `finally` blocks, teardown ledgers                                                                | Effect scopes and one terminal `Exit` fold                     | Duplicate resource ownership and cleanup aggregation code                                                       |
| `p-retry`, `p-timeout`, delay callbacks, fake-time seams                                                                    | `Schedule`, timeout combinators, and one clock                 | Package-specific error wrappers and injected clock plumbing                                                     |
| Deferred promises, listener cleanup, and wait abort controllers                                                             | Scoped `Deferred`/`Queue` programs                             | Hand-built settlement and unsubscribe protocols                                                                 |
| ALS run context plus separately propagated trace fields                                                                     | `AgentRun` and fiber-local trace annotations                   | Duplicate context projection and accessor families                                                              |
| Boundary translation, cleanup, sentinel, aggregation, and logging catch clauses                                             | Typed adapters, recovery, scopes, and `Exit`                   | Raw catch sites whose meaning is supplied only by local control flow                                            |
| Status reservations with rollback, escalation ladders, terminal claim gates, and the interaction-ownership generation index | One owner fiber per run plus a single-writer status projection | Phase-arbitration guards, synthetic transitions, claim flags, and observer-reconstructed reference counts (P13) |

Queues and mutexes are not collapsed merely because Effect supplies similarly
named primitives. A queue representing a real domain protocol remains a domain
object. Only its generic scheduling, cancellation, and disposal mechanism is
absorbed by the runtime. `LifecycleHost` is the same kind of survivor: it
keeps its two-phase, FIFO, deadline-bounded shutdown authority (R6), and
runtime disposal registers into it rather than beside it.

## 9. Functional requirements

### F1. Host integration

- Extension, CLI, Electron, and the embeddable agent package each have one
  named Effect boundary.
- Host shutdown disposes the runtime and awaits asynchronous finalizers.
- A runtime cannot be silently reconstructed after disposal.
- Public APIs preserve their current Promise/result shapes unless separately
  approved as a public breaking change.

### F2. Dependency requirements

- Migrated functions declare the minimum services they require.
- No migrated host-neutral module calls `platform()` or `tryPlatform()`.
- No migrated node receives a service bag or reads `RunContext` through
  `AsyncLocalStorage`.
- Missing required services fail at type checking or layer construction, not
  through a silent default.

### F3. Cancellation and child work

- Interrupting a root run interrupts ordinary model, tool, polling, and queue
  work beneath it.
- Run completion waits for child cleanup.
- Deliberately detached child runs remain detached according to the existing
  product policy and are visibly marked in code.
- External `AbortSignal` cancellation and internal fiber interruption are
  behaviorally equivalent at the boundary.

### F4. Resources

- Model handlers, subprocesses, listeners, leases, temporary resources,
  trace stages, and session attachments acquired in Effect zones register
  finalizers at acquisition.
- Finalizers run after success, expected failure, defect, and interruption.
- The precedence between a primary failure and finalizer failures is specified
  once and covered at the runtime boundary.

### F5. Retry and timeout

- A retry policy names its maximum attempts, delay schedule, jitter, error
  predicate, and idempotency assumption.
- Cancellation stops both the active attempt and inter-attempt sleep.
- Timeout is distinguishable from user interruption.
- Provider SDK retries remain disabled where the current single-retry-owner
  ruling requires it.

### F6. Concurrency and queues

- Parallel traversal names its concurrency bound and failure policy.
- Per-key serialization does not leak unused keys.
- Queue shutdown distinguishes normal completion, interruption, and disposal.
- A caller cannot accidentally create two consumers for a single-consumer
  queue.
- Child-run concurrency budgets compose rather than being bypassed by nested
  local queues.

### F7. Errors

- Expected error types are visible in migrated function signatures.
- Unknown exceptions from third-party SDKs are normalized once at their
  adapter.
- Existing `AgentErrorKind`, provider metadata, result events, and exactly-once
  presentation remain the outer contract.
- No catch block converts interruption into an ordinary failure unless the
  product explicitly represents cancellation as data at that boundary.

### F8. Observability

- Every migrated run retains its execution id, stream id, agent name, stage,
  attempt, and tool-call association across parallel fibers.
- Existing transcript and progress rendering remains byte-for-byte compatible
  unless a separate product change is approved.
- Finalizer defects and interrupted children are observable in diagnostics;
  they are not silently discarded.

### F9. Deterministic tests

- Retry and timeout tests do not wait for wall-clock backoff.
- Service tests do not require process-global `initPlatform()`.
- Tests can run two differently configured application programs concurrently
  in one process without service leakage.
- Migrated tests leave no live fibers, timers, listeners, or handles after
  completion.

### F10. Durable execution

- The record write remains atomic and authoritative; cache publication cannot
  precede it.
- A failed or interrupted attempt cannot expose uncommitted shared-state
  mutations to a later attempt in the same process.
- Cursor advancement occurs only after node-scoped finalizers succeed.
- Every external operation between checkpoints has a documented replay class.
- Recovery never blindly repeats a non-idempotent activity whose outcome is
  unknown.
- A completed model response is durable before its requested tools begin, and
  a completed side-effecting tool result is durable before the next
  side-effecting tool begins.
- Ordinary child fibers cannot outlive the checkpoint whose state they may
  affect.

### F11. Rounds, workflow scripts, and child dispatch

- Provider retries, response continuations, reflection rounds, tool cycles,
  workflow calls, and host turns have distinct types and policies.
- Round completion, next-round state reset, repair-grant consumption, and
  cursor transition cannot partially commit.
- Exactly one owner records round statistics and usage.
- Native delegation and workflow-script `agent()` calls use the same durable
  child-call protocol.
- Workflow-script cached-result replay, call identity, dependency
  fingerprinting, phase order, and sandbox restrictions remain unchanged.
- A workflow run owns every live child; timeout, interruption, and completion
  leave no abandoned call executing.

## 10. Migration plan

### Execution strategy

The phase list is a dependency order for authority switches, not a calendar.
Three rules keep the intermediate state short and make leftovers structurally
impossible rather than a matter of reviewer memory:

1. **Boundary inversion, once.** From Phase 1, each host enters Effect at its
   process entry, and unmigrated Promise code runs inside the runtime through
   adapters. Adaptation is therefore one-directional. No chain may take the
   shape Promise → Effect → Promise: a function converts together with its
   whole call chain, leaf to root, or its subsystem waits. Sandwich layers
   are where adapters accumulate and stay.
2. **One pass per file.** When a phase converts a file, every §2.5 mechanism
   in that file converts in the same PR — its deferreds, timers, queues, and
   cancellation races together. A file is not revisited once per family;
   Phase 5 exists for subsystems no earlier phase touched, not as a second
   visit to converted code.
3. **Leftovers fail CI, not review.** Phase 1 lands counting ratchets beside
   the existing ratchet machinery: `platform()`, `setServices()`,
   `new AbortController(`, superseded package imports, and raw catch clauses
   in migrated zones, as baselines that may only shrink. Every temporary
   adapter carries an `@adapter-until <date>` marker enforced by a check.
   The PR that zeroes a ratchet deletes the ratchet.

Phases land complete on `main` as short, dense PR trains; the migration has
no long-lived integration branch to rot against the tree's churn. The
conversion recipe — the idiom table from §2.5, the boundary rules, the
validation commands — is recorded as a repository skill so conversions stay
uniform and parallelizable across contributors and agents. Only Stage 3b
deliberately trades speed for care: it is the one step whose failure can
cost user sessions.

### Phase 0 — feasibility and cost gate

Pin the current RC exactly with
`corepack pnpm add -w --save-exact effect@rc`. On the survey date the tag
resolves to `4.0.0-rc.112`; implementation must record the version actually
resolved on its day.

A first worked exemplar landed with this PRD on 2026-08-28: `effect` pinned
at `4.0.0-rc.112` resolves and type-checks under the repository's TypeScript
settings, and `src/auth/oauth/loopbackLogin.ts` now runs on a scoped server,
a `Deferred` callback wait, an Effect timeout, and interruption at one
`runPromiseExit` boundary — with its Promise API, its error identities, and
all 143 auth-kernel tests unchanged. Its measured cost is itself Phase 0
evidence: code-only lines rose from 164 to 204, because a leaf module pays
the run boundary itself and reproduces one launcher-ordering quirk
explicitly. The deleted machinery — the callback timer and its five clear
sites, the abort-listener pairing, the hand-built cancellation promise, and
the `finally` ledger — confirms the complexity claim, while the line count
confirms R10's premise: net deletion comes from the shared host boundary
(Phase 1) and from choreography-heavy files, not from leaf conversions, and
a wrapper-only migration would grow the tree.

Build a throwaway, non-product spike that proves:

1. TypeScript workspace, test-kernel, agent, CLI, trace-viewer, and desktop
   type checks accept the RC.
2. esbuild, Vite, Electron, the VSIX build, and the agent package preserve
   tree shaking and module format.
3. One service, one scoped resource, one interrupted child, one retry schedule,
   and one test-clock test work under repository settings. `fileLocks` is the
   preferred service spike because `runExclusive` already has a scoped-resource
   shape and a small consumer surface.
4. `ManagedRuntime` shuts down correctly in all three hosts and the SDK test
   harness.
5. Bundle sizes, startup time, and idle memory are measured before and after.
6. A checked-in migration census classifies backend catch clauses by boundary
   translation, typed recovery, cleanup, best-effort projection, failure
   aggregation, control flow, or defect suppression.
7. The spike models one reflection-round transition and one workflow-script
   child call, including interruption and durable completion, without using an
   unstable Effect module.
8. Three warm runs of the full `npm run typecheck` establish the before/after
   median. A regression above 10% closes the feasibility gate unless separately
   ratified with compiler-profile evidence.

No migration code lands if the spike needs an unstable Effect module or an
unreleased compiler patch.

### Phase 1 — runtime foundation

- Record a service census showing which current fields become explicit inputs,
  local values, grouped capabilities, or deleted carriers.
- Add only the stable `Context.Service` declarations justified by that census.
- Add one host process-layer constructor; keep trivial `Layer.succeed`
  bindings in the composition root rather than creating wrapper modules.
- Add one managed runtime boundary per host and package.
- Keep `initPlatform()` temporarily for unmigrated code; both paths receive
  the same underlying port objects.
- Add a lint/architecture allowlist for the few legal `Effect.run*` boundary
  modules.
- Forbid Effect imports from `src/shared/`, webview frontend entry trees, and
  the browser-reachable `src/utils` modules pinned by
  `scripts/check-browser-safe-utils.mjs`; wire contracts and browser-safe
  utilities remain runtime-independent.
- Migrate one small authoritative seam — `fileLocks.runExclusive` and its
  consumers — onto scoped Effect ownership, deleting its bespoke
  acquisition-and-release machinery in the same PR. The Phase 0 spike is
  throwaway; this seam is the production proof that the foundation deletes
  more than it adds.
- Document exact RC upgrade procedure and rollback.

The phase changes no product behavior and introduces no Effect use in browser
bundles. It is not exempt from R10: a repository paused after a Phase 1 that
only added service declarations, process layers, and boundary allowlists
beside an untouched `initPlatform()` would be exactly the wrapper-only dual
runtime this PRD rejects. Either the Phase 1 seam has made some old machinery
unreachable, or the foundation is reverted under the rollback rule.

### Phase 2 — the agent runtime on the ledger (lane D of the cutover)

**Amended 2026-09-06 by owner ruling.** The original Phase 2 ("PocketFlow
execution kernel": one typed node Effect, one transition kernel, sixteen
subclasses converted, cursor semantics preserved) is struck. The engine is not
converted; it is deleted with its replacement in the same change. This phase is
lane D of the persistence cutover branch, sequenced and sized by
`docs/proposals/2026-09-04-agent-runtime-on-effect.md` §3 and §5:

1. **Foundation.** `RunLedger` over `SessionEvents`, the six `AgentEvent` arms
   (`flow.step`, `model.message`, `model.compaction`, `tool.intent`,
   `tool.result`, `flow.snapshot`) with Zod schemas, `foldRunState` in
   `src/shared`, the in-memory ledger layer, one ledger test and one fold
   test under `it.effect`. A load-time warning on rows-since-snapshot lands
   here (proposal §8). Nothing deleted yet; nothing in production calls it.
2. **Both families on the ledger, one PR.** `ModelInvoker`, `Tools`,
   `FollowUps`, `RunContext`, `OutputPipeline`, `runToolUse`, `runReflection`;
   `executeAgent` and every resume arm call `runtime.runPromiseExit` with the
   fiber's signal; the importer's `flow_<id>.json` to `flow.snapshot` arm.
   Deletes `src/agent/node/`, `ModelInvocationNode`, `RoundPersistedFlow`,
   `ResponseCycleFlow`, `ToolUseRoundFlow`, all sixteen node classes, the
   disposition ladder, `linkAbortSignals`, `onAbort`, the startup window,
   `p-retry` in the runtime, `resumability.ts`'s parse, the checkpoint arm of
   `SessionResumeRetrieval`, the engine tests, and the PocketFlow sections of
   CLAUDE.md, AGENTS.md, and
   `docs/architecture/2026-06-20-pocketflow-state.md`. Reviewed as one
   because splitting it is what creates a shim.
3. **Replay along the flow.** `TraceDocument.steps` with `commit`, the
   viewer scrubber over `foldRunState`, the `flow.transition` arm in the
   session fold.
4. **One child protocol.** Workflow-script journal rows into the event table
   under the script run's aggregate; `workflowScript/persistence.ts`,
   `ChildTurnState`, and the turn-state writes in `childRunLoop.ts` deleted.
   In scope, not optional: two ledgers would be the intermediate this program
   refuses.

Rules that bind every step: no interim column, no Promise shim so one family
can run on the old engine while the other runs on the new service, no window
in which two runtimes or two checkpoint formats exist on the branch. Rollback
is the cutover branch's rollback. The phase is complete when no production
file imports `src/agent/node`, no `setServices()` call remains, and
`config/ratchets/` carries no PocketFlow row. It also absorbs the original
Phase 3's "convert `runReflectionFlow` and `runToolUseFlow` interiors" item
and Phase 4's "one durable child-call operation" item, since both are the
loops and PR 4 above.

Three of the proposal's §7 decisions remain with the owner and do not block
step 1: the C9 retention window for byte-exact conversation rows; whether the
`approval.requested` / `approval.resolved` rows for outcome-unknown barrier
tools and the manual-retry prompt land in step 2 (the arms already exist in the
session vocabulary since lane 1 of the one-fold PRD, so step 2 is the
default); and confirmation that step 4 is in scope (it is, by the
no-intermediates rule, unless the owner says otherwise).

### Phase 3 — run lifecycle and cancellation

Phase 3 lands as two separately revertible stages. Stage 3a changes no
durable format: it converts the run interiors, collapses the dependency
carriers onto `AgentRun`, moves lifecycle under scopes, and replaces internal
abort choreography. Stage 3b carries the persistence amendment, the round
commit, and the finer checkpoints — every item that writes a new durable
shape. The split isolates the only rollback-constrained work of the program
in one small stage; the rollout section defines what revertibility means for
it.

Stage 3a — lifecycle and carriers, no durable format change:

- Convert `runReflectionFlow`, `runToolUseFlow`, `executeAgent`, and
  `AgentRunLifecycle` interiors.
- Replace the mirrored `AgentLaunchContext` / ambient `RunContext` /
  `AgentCore` / flow-service dependency path with plain launch inputs and one
  scoped `AgentRun` service.
- Move attachments, stages, model handlers, follow-up waits, and flow-record
  disposition under scopes without changing their domain decisions.
- Replace ordinary internal abort-controller trees with fiber interruption.
- Collapse terminal-outcome arbitration onto the run fiber's single `Exit`
  fold and make stream phase a single-writer projection; delete the status
  reservation's rollback entry, the escalation ladders,
  `transitionStopBeforeRunStart`, and the interaction-ownership generation
  index once the per-stream owner fiber makes the races they guard
  unconstructible. The domain kernels P13 names survive as facts, not
  guards; the dual persistence authority (phase versus flow record) is
  Stage 3b's to unify.
- Preserve the explicit detached-subagent policy.
- Delete the manual teardown-failure ledger once the common finalizer policy
  covers it.

Stage 3b — durable rounds and finer checkpoints:

- Ratify the nested-flow persistence amendment: stable activity identities,
  hierarchical cursor or activity-ledger representation, recovery behavior for
  an unknown external outcome, and version-retirement policy.
- Checkpoint completed model responses before tool dispatch and completed
  side-effecting tool calls before the next side-effecting call.
- Replace `RoundPersistedFlow` with the common durable transition kernel plus a
  reflection-round transition; preserve the configured bound and the single
  persisted compile-repair grant.
- Collapse response-cycle finalization to one canonical round-state commit and
  watermark-tracked derived projections.

The Promise-returning `runAgent` and SDK entry points remain adapters around the
Effect program. Phase 3 cannot complete while the inner tool-use cycle remains
one opaque durability interval inside an outer persisted node.

### Phase 4 — durable child calls and workflow scripts

- Extract one durable child-call operation from stable subagent attempts,
  in-band execution, the child-run loop, native delegation, and workflow-script
  `agent()` dispatch.
- Preserve separate foreground, detached-delivery, and workflow-script
  presentation policies above that operation.
- Convert the workflow-script runner's bounded fan-out, timeout, child
  ownership, control handles, and terminal failure reduction to Effect.
- Replace its journal fence and snapshot writer with one persistence
  coordinator that distinguishes authoritative call results from coalescible
  progress projections.
- Retain the sandbox and adapt its Promise/error bridge once at the boundary.
- Delete parallel child-lifecycle and cancellation machinery after both native
  delegation and workflow scripts use the common operation.

This phase cannot complete if workflow dispatch merely wraps
`runWorkflowScript()` in `Effect.tryPromise`; the internal queue, timeout,
abort-controller tree, pending-call drain, and duplicated child-call lifecycle
must have become unreachable.

### Phase 5 — coordination, time, and resilience

The §2.5 family table names the verified sites behind each subphase; those
rows are this phase's deletion checklist. Migrate one subsystem at a time,
in this order:

1. deferred follow-up and interaction waits;
2. retry and timeout helpers;
3. bounded parallel traversal;
4. per-execution and per-key queues;
5. session/resource disposal;
6. polling and background-run lifecycles.

Each subphase removes its superseded package imports immediately. A package is
removed from `package.json` when its last justified production use disappears;
UI-only uses may keep a package until their own code has a simpler native or
Effect-independent replacement. Browser-reachable utility modules — for
example `@utils/core/keyedMutex` — remain Effect-free whatever their backend
callers do; the per-key serialization subphase collapses backend call sites
only.

### Phase 6 — observability context

- Carry run and stage context through Effect fiber-local state.
- Adapt that context to the existing `AgentTrace` API.
- Remove redundant `AsyncLocalStorage` scopes only after event ordering and
  parent-stage behavior are verified.
- Evaluate OpenTelemetry export separately; it is not required to finish the
  migration.

### Phase 7 — global platform retirement

- Migrate remaining host-neutral `platform()` readers by domain.
- Remove `tryPlatform()` fallbacks whose only purpose was import-before-init
  tolerance.
- Delete `initPlatform`, the module-global `_platform`, and global platform
  test setup after all production readers are gone.
- Convert the existing fake platform implementation into reusable service
  values/layers supplied by affected suites; do not rewrite unrelated tests
  merely to demonstrate Effect.
- Remove host `vi.mock` sites only when a service substitution covers the same
  behavior, then shrink and finally delete the `host-agent-mock` ratchet and
  obsolete composition-root lint rule.
- Retain a plain `Platform` construction type only if hosts benefit from it as
  an input to `makeApplicationLayer`.

UI code may remain Promise-based indefinitely. It accesses backend effects
through typed host controllers rather than directly importing Effect.

### Rollout and rollback

No feature flag is required because the migration does not introduce two
user-selectable behaviors. Each phase is independently revertible and changes
no durable format through Phase 2 and Stage 3a. From the first durable-format
writer onward, revertibility carries a qualification: reverting code must
never orphan records that code has already written. Stage 3b therefore obeys
a reader-outlives-writer rule — the code that reads the new checkpoint
representation lands with or before the writer and is retained on rollback,
so a reverted writer leaves every written session readable. The recommended
sidecar-ledger representation (§15, decision 6) satisfies this cheaply: the
version 2 record stays authoritative and readable by pre-amendment code, and
rollback degrades fine-grained resume to today's coarse outer-cursor resume
instead of producing unreadable sessions. If ratification instead selects a
new record version, its reader ships ahead of its writer under the same rule,
or the PRD's revertibility claim is explicitly withdrawn for that stage. A
Stage 3b format change additionally follows the repository's explicit
compatibility and retirement policy and lands only with its recovery
behavior. A phase lands only after all affected hosts have crossed
the same internal boundary; the repository does not ship one host on the Effect
implementation and another on a separately maintained Promise implementation.

Before Phase 2, rollback consists of removing the runtime foundation and the
pinned dependency. From Phase 2 onward, rollback is by reverting the complete
phase, not by adding a compatibility branch inside the flow. If an RC upgrade
breaks a completed phase, the project returns to the previously pinned RC while
the dedicated upgrade PR is corrected. It does not restore the superseded
custom runtime machinery.

## 11. Acceptance criteria and success measures

### Architectural completion

- Zero production `setServices()` calls after Phase 2.
- Zero generic `prep` / `execFallback` / `post` dispatch in the graph kernel
  after Phase 2; nodes expose one typed transition.
- One graph-transition loop serves ephemeral and persisted flows after Phase 2.
- One run dependency carrier serves migrated execution code after Phase 3;
  launch inputs are not copied into an ambient context and then into flow
  services.
- Zero `RoundPersistedFlow` subclass after Phase 3; reflection rounds use the
  common durable transition kernel.
- One durable child-call operation serves native delegation and workflow-script
  dispatch after Phase 4.
- Zero `PQueue`, `p-timeout`, or internal `AbortController` use in the
  workflow-script runner after Phase 4.
- Zero `platform()` or `tryPlatform()` calls in migrated host-neutral zones;
  zero repository-wide after Phase 7.
- Every production global installer found by the Phase 0 census is deleted,
  replaced by scoped construction, or retained with a written process-lifetime
  justification.
- The `host-agent-mock` ratchet and composition-root lint allowlist shrink as
  their underlying global seams disappear; empty enforcement machinery is
  deleted rather than retained as historical structure.
- Zero internal `Effect.run*` calls outside the named boundary allowlist.
- Zero new module-global dependency setters in host-neutral code.
- Zero new `AbortController` constructions inside completed Effect zones.
- Zero raw catch clauses inside completed Effect zones except named Promise,
  synchronous-callback, filesystem, SDK, or sandbox-realm adapters.
- Every temporary Promise/Effect adapter has a checked retirement date and
  condition.

### Runtime correctness

- Existing flow-resume, cancellation, approval, checkpoint, and terminal-result
  tests pass unchanged except where their setup becomes simpler.
- Failure injection at every side of the record commit observes either the old
  complete record or the new complete record, never published uncommitted
  shared state.
- Recovery after a completed side-effecting tool call does not repeat the call;
  recovery from an unresolved non-idempotent call reports an unknown outcome.
- Restart at every reflection-round boundary preserves the round index,
  configured bound, compile-repair grant, usage totals, and cursor.
- Restart at every workflow child-call phase either reuses a committed result,
  launches a permitted attempt, or reports an unknown outcome; it never creates
  an unrecorded duplicate child.
- Interrupting a run leaves no ordinary child fiber alive.
- Killing the process between a record commit and its derived projections
  loses no round or usage fact: resume re-derives the missing projection from
  the committed record through its watermark.
- Host shutdown awaits owned finalizers up to the existing per-phase
  deadline; a finalizer that exceeds it is interrupted, reported, and
  abandoned, and shutdown itself never hangs.
- Primary failures, finalizer failures, and interruption retain the precedence
  specified by the existing lifecycle contract.
- Concurrent in-process SDK runs can receive different service layers without
  cross-run leakage.

### Simplification

- By the end of Phase 5, host-neutral backend code no longer imports
  `p-defer`, `p-retry`, `p-timeout`, or `async-mutex`.
- `p-queue`, `p-map`, and `delay` remain only at explicitly justified
  non-Effect boundaries or are removed.
- The combined migration is net-negative in hand-written runtime code,
  excluding generated files, lockfiles, and documentation.
- No new abstraction survives solely to make the migration appear gradual.

### Cost and performance

- Full-workspace type checking regresses by no more than 10% at the median of
  three warm runs without a separately ratified exception supported by a
  compiler profile.
- No distributable grows by more than 5% compressed without a separately
  ratified exception supported by the Phase 0 measurements.
- CLI startup time and host activation time regress by no more than 10% at the
  median of the repository's chosen repeatable benchmark.
- Idle memory regresses by no more than 10% after runtime construction.
- Agent-run latency benchmarks distinguish Effect overhead from provider and
  filesystem time; no statistically clear regression over 5% is accepted in
  a local no-network benchmark.

### Version stability

- The exact Effect RC version is pinned in `package.json` and the lockfile.
- All Effect ecosystem packages, if later introduced, use the same RC version.
- RC upgrades occur in dedicated PRs with full typecheck, test, packaging, and
  smoke gates.
- No `effect/unstable/*` import enters without a separate decision naming its
  replacement or exit plan.

## 12. Risks and mitigations

| Risk                          | Consequence                                                                                 | Mitigation                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| RC API churn                  | Repeated mechanical changes distract from product work.                                     | Exact pinning; dedicated upgrade PRs; stable modules only; no automatic dependency updates.                                                |
| Wrapper-only adoption         | The repository gains Effect without deleting complexity.                                    | Replacement-must-delete rule and phase acceptance gates.                                                                                   |
| Layer multiplication          | Existing fields acquire tags, constructors, and test wrappers without changing ownership.   | Service census, semantic grouping, one carrier per lifetime, and rejection of trivial layer modules.                                       |
| Two runtimes per host         | Stateful layers duplicate queues, caches, or resources.                                     | One managed runtime owned by each host process; architecture test for constructors.                                                        |
| Effect leaks into public APIs | SDK consumers acquire a new programming model involuntarily.                                | Promise adapters remain the published surface.                                                                                             |
| Error semantics change        | Cancellation or defects become user-facing failures, or vice versa.                         | Preserve the current outer classifier; test `Exit` mapping at one boundary.                                                                |
| Catch-all migration           | Broad recovery handlers swallow interruption or defects under a new API.                    | Classify every touched catch; prefer tagged recovery; permit raw catch only in named foreign adapters.                                     |
| Iteration conflation          | A durable round or paid model continuation is treated as an ephemeral retry.                | Distinct coordinate types and failure-injection tests at every durable iteration boundary.                                                 |
| Workflow rewrite drift        | Script replay identity, sandbox behavior, or child delivery changes during runtime cleanup. | Keep the script/journal interpreter authoritative; extract only the common child activity and runtime mechanics.                           |
| Durable flow behavior changes | Resume records or node identifiers become incompatible.                                     | Preserve version 2 exactly through Stage 3a; Stage 3b needs an explicit version, reader-outlives-writer rollback, and retirement decision. |
| External action is repeated   | Recovery duplicates a tool write, charge, or subagent launch.                               | Replay classification, stable idempotency keys, immediate checkpoints, and an explicit unknown-outcome state.                              |
| Interruption races a commit   | The caller retries while the previous atomic write is still running.                        | Keep node work interruptible but mask the short write-and-cache-publication critical region.                                               |
| Excess abstraction            | Fine-grained service classes make simple code harder to read.                               | Service boundaries follow existing ports and co-usage; pure arguments stay arguments.                                                      |
| Bundle growth                 | Extension, CLI, or SDK distribution becomes materially larger.                              | Phase 0 size gate; tree-shaken imports; no Effect in browser code.                                                                         |
| Finalizer-order drift         | Shutdown behavior changes subtly.                                                           | Record current order before conversion; use sequential scopes where ordering is semantic.                                                  |
| Training cost                 | Contributors write unsafe or non-idiomatic Effect code.                                     | Small repository guide, boundary lint rules, and examples from migrated TeXRA code.                                                        |
| False promise of correctness  | Teams expect Effect to repair domain ownership automatically.                               | Explicit non-solution list and unchanged single-authority rulings.                                                                         |

## 13. Alternatives considered

### A. Continue improving the current Promise runtime

This avoids a dependency and preserves familiar code. It does not remove the
need to maintain the interactions among global services, ALS, abort signals,
disposable stores, queues, deferred promises, retries, clocks, and error
normalization. TeXRA has already implemented the easy local improvements; the
remaining cost is composition.

### B. Adopt only Effect dependency injection

This would relieve some service threading but leave cancellation, resource
lifetime, time, and errors split across the old mechanisms. It has the worst
risk-to-deletion ratio and is rejected.

### C. Replace PocketFlow with Effect Workflow

Effect 4's workflow facilities are under an unstable module, and TeXRA has
product-specific durable cursor and resume semantics. Replacing them would mix
a runtime migration with a persistence redesign. Rejected.

_Amended 2026-09-06:_ upheld on the module, moot on the reason. The unstable
`effect/unstable/workflow` module stays out. But PocketFlow is not kept either
(R4 as amended): the persistence redesign this alternative feared mixing with
the runtime migration is now its prerequisite, and the two land together as
the cutover branch. The replacement is plain Effect loops over the event
table, not a workflow engine of any kind.

### D. Publish Effect as the SDK API immediately

This would give advanced consumers full service and error types but break the
current low-friction embedding contract. Deferred until the internal runtime is
stable; a future optional Effect-native entry point can be proposed separately.

### E. Wait for Effect 4 final

This minimizes prerelease churn but leaves current runtime work to continue on
the old substrate. The recommended compromise is Phase 0 now, followed by
foundation work only if the pinned RC passes all gates. A failed feasibility
spike closes this PRD until the final release without leaving product adapters
behind.

## 14. Relationship to earlier records

Upon ratification, this PRD supersedes the **migration mechanism**, but not the
verified domain findings, of:

- `2026-05-06-prd-runcontext-refactor.md`;
- `2026-06-07-dependency-injection-cleanup.md`;
- `2026-08-16-services-injection-audit.md`.

In particular, the earlier prohibition on "another DI layer" remains correct
for an additive wrapper. Ratification replaces it with a stronger rule: Effect
may become the runtime only through measured deletion of the carriers and
helpers it supersedes.

The error-ownership, lifecycle-ownership, single-owner-session, persistence,
and session-event-journal rulings remain authoritative. When this PRD and one
of those records appear to disagree, the domain-specific ownership record wins
unless the repository owner explicitly amends it.

## 15. Open decisions for ratification

1. Whether Phase 0 may land as a documented branch/spike only or as a disabled
   foundation commit on main.
2. Whether the host managed runtime belongs directly in each composition root
   or behind one host-neutral `ApplicationRuntime` adapter.
3. Whether any run-owned capability has sufficiently independent acquisition,
   lifetime, or substitution to sit outside the otherwise cohesive `AgentRun`
   service. The burden of evidence lies with the split.
4. Whether Effect's language-service or TSGo plugin is admitted. It is useful
   but not required for runtime adoption and must be evaluated against the
   repository's TypeScript 6/7 toolchain.
5. Whether a future optional Effect-native SDK entry point is desirable after
   Phase 7.
6. ~~Whether nested durable progress uses a hierarchical cursor, an activity
   ledger, or both.~~ **Decided 2026-09-06 by the owner's ruling:** there is
   no cursor of either kind. Progress is the row ledger on the execution
   aggregate (R4 as amended); `flow.snapshot` is the only derived row.
7. ~~Whether PocketFlow activities and workflow-script child calls share one
   physical activity record or only one protocol over their existing stores.~~
   **Decided 2026-09-06:** one physical record, the session event table, with
   the script journal moved into it in Phase 2 step 4.
8. **Recorded 2026-09-06.** The owner ruled that the agent runtime uses no
   PocketFlow and is pure Effect written to Effect's best practice (the
   `effect-solutions` guides AGENTS.md mandates: `Context.Service` classes
   with static layers, `Effect.fn` for every named operation, one `provide`
   at the process entry, `Data.TaggedError` for expected failures with
   defects left to die, per-test layers under `it.effect` with `TestClock`).
   Effect Schema stays out: Zod remains the one data-contract system, so the
   guides' `Schema.TaggedError` reads as `Data.TaggedError` here. This closes
   the R4 question; decisions 1 to 5 above are untouched by it.

None of these decisions blocks the read-only feasibility measurements.

## 16. Primary external references

- [Effect 4 RC installation and overview](https://www.effect.website/)
- [Effect core model and `Effect<A, E, R>`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts)
- [`Context.Service` in the current Effect 4 source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Context.ts)
- [Layers and their provided/error/required types](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Layer.ts)
- [Managed runtime lifecycle](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/ManagedRuntime.ts)
- [Scopes and finalization](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Scope.ts)
- [Structured fibers and interruption](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Fiber.ts)
- [Effect's current workflow implementation, under `unstable/workflow`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/workflow/Workflow.ts)
- [Effect 4 migration and ecosystem versioning](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
