---
created: 2026-09-10
status: proposed
---

# Effect-native injection, context, and pipelines: the carrier manifest and its retirement order

**Recommendation:** stop describing the Effect work as "adopting Effect." TeXRA already
runs Effect in 443 files, pins `effect@4.0.0-rc.112`, and operates a real `LayerMap` over a
real `ManagedRuntime`. What it also runs, beside that, is **seven other dependency-carrying
mechanisms**, none of which is Effect's context. The 1.0 work is to route those seven into
the composition points that already exist and delete them — not to introduce a pattern.

This document supplies the two things no existing proposal contains: a **complete carrier
inventory with a per-carrier disposition** (tag, lifetime, composition point, ratchet row),
and a **retirement order** in which every step deletes a competing authority. It also
records the conversion mode — rewrite, edit, or delete — for every file the order touches,
under the owner directive of 2026-09-09 that full-file rewrites are preferred and are to be
done fast where the file is a good candidate.

## 1. What this document adds

Nearly every _rule_ the ask implies is already ratified and this document does not restate
it. [The Effect 4 runtime migration PRD](./2026-08-26-effect-4-runtime-migration.md) owns
R1 (boundary kinds), R2 (service granularity), R3 (four lifetimes), R4 (plain-Effect
loops), R5 (interruption), R6 (`Scope`), R7 (typed errors), R8 (`Schedule`), R9 (traces),
R10 (delete-on-replace), the §8.1 one-carrier-per-lifetime table, the §8.7 collapse ledger,
and §15 decision 8's idiom ruling (`Context.Service` + static layers, `Effect.fn`,
`Data.TaggedError`, Zod not Effect Schema). [The delivery
plan](./2026-09-06-effect-runtime-delivery-plan.md) (the tree's only `accepted-direction`
doc) owns the work order and two binding negatives: **no second runtime/session registry**
and **no tag per existing class**. [The agent runtime
proposal](../../implemented/architecture/2026-09-04-agent-runtime-on-effect.md) §2.4 owns the only concrete tag roster.
[The promise-boundary audit](./2026-09-07-promise-boundary-audit.md) §6 forbids a new lint
rule, a `tryPromise` ratchet row, and any adapter. [The observability
plane](./2026-09-09-observability-plane.md) owns fiber-derived identity and therefore owns
the trace stage carrier. [The 1.0 implementation
plan](./2026-09-09-texra-1-0-implementation-plan.md) §5 forbids funding Effect conversions
inside subsystems that are being retired anyway.

Against that, seven genuine gaps remain, and they are this document's content:

| #   | Gap                                                                                                                                                                                                                          | Where it is resolved here |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | **No service tag manifest exists.** R2 lists five provisional groups "to validate in Phase 0"; the delivery plan names a different five in prose; §15 decision 3 is open. 18 tags exist in tree, none for a `Platform` port. | §4, §5                    |
| 2   | **Two of the five `AsyncLocalStorage` carriers are owned by no document.** A grep of `.agents/docs/` for `ToolFileInteractionContext` returns nothing; `executionLease`'s `maintenanceExecutions` likewise.                  | §5 rows 6, 10             |
| 3   | **`Context.Reference` is never proposed anywhere in the tree.** It is the exact native replacement for "ambient value with a default", and Effect 4 has no `FiberRef` at all.                                                | §3.2                      |
| 4   | **`platform()` retirement has no per-domain order.** PRD Phase 7 says "by domain" and names no domain; the baseline holds 51 files.                                                                                          | §6 steps 3–5, 8–9         |
| 5   | **The `Effect.provide` topology is specified three incompatible ways** across three docs and never reconciled. This is the core ambiguity of the injection half of the ask.                                                  | §3.1, §9 Q2               |
| 6   | **The filesystem direction — RULED 2026-09-11: do not adopt `@effect/platform-node`'s `FileSystem`/`Path` for now.** Steps 9-10 are deferred, so W6 (ALS retirement) stays blocked and carrier 5 stays.                      | §9 Q1                     |
| 7   | **`Stream` composition is unowned.** The pipeline half is specified for retry/scope/concurrency but no doc owns end-to-end streaming.                                                                                        | §3.3                      |

One correction to the record, because it changes what "unmeasured" means: the largest
injector in the repository today is **not** `platform()`. It is `effectRuntime()` — the
process-global `ManagedRuntime` locator at `src/platform/processRuntime.ts:52` — with
**~330 call sites across ~105 files** (binding-scoped count; a plain grep reports 340/111)
against `platform()`'s ratcheted 109/51. The runtime that is supposed to _be_ the context
is itself reached through the exact pattern it replaces, and nothing watches it.

## 2. Verified starting point

Measured on `claude/useeffect-service-injection-context-xsisju` at `cf88d2d`, with
`effect@4.0.0-rc.112` installed. The migration ratchet is **green** at this revision, so
each row total below is simultaneously the committed baseline and the tree's actual state.

| Fact                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18 `Context.Service` tags in 14 production files — the idiom already works   | `src/shared/session/{sessionEvents.ts:32,:41, database.ts:84, sessionFrames.ts:185, sessionInputs.ts:10, inquiryRecords.ts:12, updateCheckRecords.ts:5}`, `src/controllers/session/{sessionLayer.ts:128,:537, sessionSources.ts:31,:61,:76, SessionView.ts:39, WorkspaceRoots.ts:15}`, `src/tools/lean/direct/{leanServer.ts:108, leanServerPool.ts}` |
| A real `LayerMap` over one `ManagedRuntime` already exists                   | `sessionLayer.ts:537` (`class Sessions extends Context.Service<Sessions, LayerMap.LayerMap<SessionKey, Session>>()('@texra/session/Sessions')`), `sessionLayer.ts:791` (`ManagedRuntime.make`)                                                                                                                                                        |
| A finished native composition root already exists, and it is the browser one | `webviewSessionLayer.ts:82-84` — `installWebviewRuntime()` returns its runtime instead of installing a global                                                                                                                                                                                                                                         |
| `platform()` — 13 ports, one frozen module-global                            | `src/platform/platform.ts:40-60` (ports), `:62` `let _platform`, `:76` `platform()`; **51 files / 109 sites** (ratcheted)                                                                                                                                                                                                                             |
| `effectRuntime()` — the unmeasured successor                                 | `src/platform/processRuntime.ts:19` `let processRuntime`, `:52` throwing accessor; **~105 files / ~330 sites** (unmeasured)                                                                                                                                                                                                                           |
| Five `AsyncLocalStorage` carriers, 15 reader exports                         | `workspaceRoots.ts:43`, `TraceEmitter.ts:58`, `RunContext.ts:79`, `ToolFileInteractionContext.ts:49`, `executionLease.ts:131`; **~94 files / ~199 sites** (unmeasured)                                                                                                                                                                                |
| `Context.Reference` used **zero** times; Effect 4 has no `FiberRef` module   | `node_modules/effect/src/Context.ts:485` (`interface Reference<Shape> extends Service<never, Shape>`), `:2002` (constructor); `ls node_modules/effect/src \| grep -i fiberref` → 0                                                                                                                                                                    |
| The run path's spine is **already** Effect and stops at exactly one line     | `runAgent.ts:93` is `Effect.fn`; `executeAgent.ts:401-406` returns `Effect.Effect<…>`; `AgentRunLifecycle.ts:476` is `Effect.fn` — whose `runner` parameter is typed `=> Promise<AgentRuntimeFlowResult>` at `:479-482`                                                                                                                               |
| Crossing that line re-establishes ambient state by hand                      | `executeAgent.ts:439` and `:618`: `const runInScope = AsyncLocalStorage.bind(…)`                                                                                                                                                                                                                                                                      |
| The flow layer is a Promise island                                           | `src/agent/implementations/flows/**` contains **zero** `effect` imports                                                                                                                                                                                                                                                                               |

Ratchet rows at `cf88d2d` (files / sites):

| Row                    | Files / sites | Row                            | Files / sites |
| ---------------------- | ------------- | ------------------------------ | ------------- |
| `platform()`           | 51 / 109      | `Effect.run*` (below boundary) | 7 / 22        |
| `setServices()`        | 6 / 6         | `catch:effect-importer`        | 8 / 11        |
| `new AbortController(` | 11 / 12       | `dep:@agent/node`              | 25 / 27       |
| `import:p-queue`       | 13 / 13       | `dep:@agent/modelHandlers`     | 9 / 28        |
| `import:p-defer`       | 7 / 7         | `import:p-map` / `p-retry`     | 3 / 3 each    |
| `import:p-timeout`     | 1 / 1         | `import:async-mutex`           | 1 / 1         |

## 3. The three natives

### 3.1 Service injection — `Context.Service` + `Layer`, at three composition points

The house form is uncontested and is the converter's template:

```ts
class X extends Context.Service<X, Shape>()('@texra/<area>/<X>') {
  static layer(config): Layer.Layer<X, E, R> { … }
}
```

Tag class name === type parameter === exported symbol; the shape is an inline
`readonly`-property object type. Id grammar: `@texra/<area>/<Name>` for repo-root code,
`@texra-ai/<pkg>/<Name>` for workspace packages. Two existing ids omit the area segment
(`InquiryRecords`, `UpdateCheckRecords`) and are corrected in the first batch. `static
layer` currently exists in three incompatible shapes and `Layer.effect` is called at two
arities; this document rules **one** form: `static readonly layer` as a value for a
zero-config service, `static layer(config): Layer.Layer<…>` as a method with an explicit
return type when it takes configuration.

**Provide topology (resolving gap 5).** §15 decision 8's "one `provide` at the process
entry" scopes to the _process layer only_. R3's four lifetimes remain legal. There are
exactly three provision points and the plan adds no fourth:

| Lifetime     | Composition point                                                         | Tags provided                                                                                                              |
| ------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Process      | `installProcessRuntime` → the `services` layer, `sessionLayer.ts:784-798` | `Secrets`, `AppState`, `FileSystem`/`Path`, `SetupPlatform`, `ToolInjections`, `LogSink`, `ProcessExecution`, `HttpClient` |
| Session      | the `Sessions` `LayerMap` entry, `sessionLayer.ts:537`                    | `WorkspaceRoots` (widened), `Database`, `SessionEvents`, `ExecutionLeases`                                                 |
| Run          | a new `Layer.effect(AgentRun, …)` inside `executeAgent`                   | `AgentRun`, `Trace`                                                                                                        |
| (call-local) | `Effect.provideService` around each tool call                             | `ToolCall`, `StageStack`                                                                                                   |

The call-local row is not a fourth lifetime — it is `Effect.provideService` on a subtree,
which is how a forked child fiber inherits parent context while keeping its own provision
local. That is precisely the stack semantics `ToolFileInteractionContext` hand-rolls today.

**Granularity (resolving gap 1).** Following the ask _literally_ — a tag per `Platform`
port — would violate R2 and the delivery plan's explicit negative. The evidence says the
same: eight of the thirteen ports have three or fewer call sites, while `secrets` (36) and
`globalState` (25) carry 61 of the 109 between them. The manifest in §5 is therefore
bounded and each tag carries a justification against R2's four-part test.

### 3.2 Context — `Context.Reference`, the mechanism nobody proposed

Effect 4 has **no `FiberRef`**. The request-scoped, default-carrying ambient value is
`Context.Reference<Shape>(key, { defaultValue })` (`Context.ts:2002`), read inside any
Effect without a layer, overridden for a subtree with `Effect.provideService`, and
type-erased from the `R` channel so it does not inflate requirement types. It is used zero
times in TeXRA today, against five `AsyncLocalStorage` carriers.

The distinction that decides which of the five gets a `Reference` and which gets a
`Service`: a **`Reference`** where reading outside any scope must yield a sane default
(`executionLease`'s maintenance set reads as empty; `TraceEmitter`'s stage stack reads as
`[]`), a **`Service`** where reading outside a scope is a defect that should not compile
(`AgentRun`, `WorkspaceRoots`, `ToolCall`).

One carrier resists a naive swap and the plan must say so. `TraceEmitter.stageScope` is a
**per-instance** `AsyncLocalStorage`, deliberately not a module singleton, and the file
documents why (`TraceEmitter.ts:47-58`): cross-trace inheritance is the bug class behind
orphaned subagent transcripts. A module-level `Context.Reference` reintroduces exactly that
bug. The correct form keys the reference by trace, or scopes it inside the run layer that
already owns the trace — not a bare global reference.

Before / after, from `executeAgent.ts:435-441` (real code, abbreviated):

```ts
// today — Effect wrapping a callback that re-binds an ambient store by hand
withExecutionRunContext(ctx, { onApprovalPolicyDenial }, () => {
  const runInScope = AsyncLocalStorage.bind(<A>(operation: () => A) => operation());
  return Effect.gen(function* () { … });
});

// target — the run layer provides the run; no ambient store, no bind
Effect.gen(function* () {
  const run = yield* AgentRun;      // requirement appears in R, checked at compile time
  …
}).pipe(Effect.provide(agentRunLayer(ctx)));
```

### 3.3 Pipelines — combinators, not `async` bodies inside `Effect`

302 `Effect.tryPromise`/`Effect.promise` sites exist across 113 files, and only 37 have a
foreign callee by keyword. 266 of 292 `tryPromise` sites map **no domain error at all**
(167 carry `catch: ensureError`, 99 an identity catch) — that catch shape is the wall
fingerprint: the wrapper exists only because the callee is `async`. The sharpest cluster is
40 sites in 22 files of the form
`Effect.tryPromise({ try: () => runInSession(session, () => ourAsyncFn()), catch: ensureError })`
— an Effect → Promise → `AsyncLocalStorage` → Promise → Effect sandwich.

Per-mechanism replacement, all on **stable** `effect` modules (`unstable/workflow` is
excluded: its `Activity.make`/`Workflow.make` require Effect Schema, and §15 decision 8
keeps Zod as the payload contract):

| Hand-rolled                                          | Native                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p-retry` batch on `ModelInvocationNode`             | `Effect.retry` + `Schedule` (`{ while, until, times, schedule }` options object — the v3 predicate combinators are gone)                                              |
| `AbortController` (12 sites)                         | fiber interruption + `Scope`; `Effect.abortSignal` only at the foreign SDK edge (13 sites already)                                                                    |
| `p-queue` per-key ordering (13 files)                | `Semaphore` / `PartitionedSemaphore.makeUnsafe` — note the CLAUDE.md/AGENTS.md `p-queue` contradiction already recorded in observability §5                           |
| `execFallback`                                       | `Effect.catch` / `Effect.catchTag` returning the same domain value (**`Effect.catchAll` does not exist in v4** — it is `Effect.catch`, declared `catch_`)             |
| provider token deltas, transcript delivery           | `Stream`, with `Stream.fromAsyncIterable` only at the provider SDK edge; observability §3.4's single-consumer `Queue` as the transcript hand-off (**resolves gap 7**) |
| `raw try/catch` in effect-importing files (11 sites) | `Data.TaggedError` + `Effect.catchTag`                                                                                                                                |

**Dispatch is the exception that proves the rule.** `ToolUseDispatchNode` carries four
product contracts — barriers, safe partitions, duplicate fan-out, result order — and needs
**three different combinators, not one `Effect.forEach` with concurrency**. A naive port
also silently adopts fail-fast sibling interruption, which the current code does not have.
This is the single place where a mechanical swap loses behavior, and §7 treats it
accordingly.

## 4. Conversion mode: rewrite, edit, or delete

Owner directive, 2026-09-09: prefer full-file rewrites and do them fast where the file is a
good candidate. The structural reason, not merely a speed one: converting `async`/`await` +
`try/catch` + `AbortController` into an `Effect.gen`/`.pipe` program changes the shape of
every function in the file. An incremental edit pass fights that shape and tends to leave a
`Effect.tryPromise` wall in the middle so the file still compiles — which is precisely the
debt being retired.

| Mode        | When                                                                                  | Count in §6 |
| ----------- | ------------------------------------------------------------------------------------- | ----------- |
| **REWRITE** | control flow changes wholesale **and** a named exemplar exists to copy                | 27 files    |
| **EDIT**    | behavior is not recoverable by reading the file, or the change is genuinely localized | ~115 files  |
| **DELETE**  | the file goes with its mechanism                                                      | 14 files    |

**Hard rule.** A REWRITE-mode file's guaranteed behaviors are enumerated _before_ the old
file is deleted, and that enumeration is the step's completion gate. Cheap for the ~24
files where the body is self-evident; load-bearing for the three where it is not:

| File                     | Behavior a rewriter would drop                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolUseDispatchNode.ts` | barrier/safe segmentation, duplicate fan-out (`_duplicateToPrimary`), result order, **absence** of fail-fast sibling interruption                                                              |
| `ModelInvocationNode.ts` | two distinct mechanisms — the automatic `p-retry` batch (a `Schedule`) _and_ the manual retry loop (a durable admission protocol, not a schedule); `execFallback`'s Error-normalization branch |
| `executionLease.ts`      | re-entrancy set semantics, ownership map, per-key queue ordering, and the interaction between all three                                                                                        |

The named exemplars, one per concern — the plan does **not** name `sessionLayer.ts` as a
whole (855 lines, and `:598-744` / `:766-855` carry five Promise escape hatches):

| Concern                  | Exemplar                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| plain capability service | `src/shared/session/sessionEvents.ts:32-38` (`ProcessIdentity`)                                                                                  |
| scoped resource          | `src/tools/lean/direct/leanServer.ts:108`                                                                                                        |
| per-session keyed family | `sessionLayer.ts:481-526` (graph/scoping only)                                                                                                   |
| native composition root  | `webviewSessionLayer.ts:82-84`                                                                                                                   |
| typed error channel      | `packages/llm/src/turn.ts` (**error channel only** — its dependency style is a constructor-argument anti-pattern; it has zero `Context.Service`) |

**Anti-exemplar, do not copy:** `src/tools/lean/direct/directLspAdapter.ts:80-97` builds a
service graph outside any runtime layer with `Scope.makeUnsafe()` + `runSync(Layer.build(…))`.

## 5. Carrier manifest and disposition

Every dependency-carrying mechanism in production, and what it becomes. This is the table
gap 1 and gap 2 asked for.

| #   | Current mechanism                                            | Evidence                                                           | Disposition                                                                                                                              | Lifetime |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `platform().secrets` (36 sites)                              | `platform.ts:47`                                                   | `@texra/platform/Secrets`                                                                                                                | process  |
| 2   | `platform().globalState` (25)                                | `platform.ts:41`                                                   | `@texra/platform/AppState`                                                                                                               | process  |
| 3   | `platform().fs` (31)                                         | `interfaces.ts:96-138`, one impl only                              | **Effect's own** `FileSystem` + `Path` via `NodeServices.layer`; four primitives Effect lacks keep a thin `@texra/platform/WorkspaceIo`  | process  |
| 4   | eight remaining ports (≤3 sites each)                        | `interfaces.ts`                                                    | folded into the above or into the roots service; `toolMissingHandler`, `fileLocks`, `storage.getGlobalStoragePath()` do **not** get tags | —        |
| 5   | `workspaceRoots.ts` ALS + process fallback + getter proxy    | `:43`, `:42`, `:71-84`                                             | widen the **existing** `@texra/session/WorkspaceRoots` tag from `{storage}` to the four-field shape                                      | session  |
| 6   | `RunContext` ALS (47 reader sites)                           | `RunContext.ts:79`, `:151-156` (it _nests_ the roots ALS)          | `@texra/agent/AgentRun`; the `bare` variant **deletes**                                                                                  | run      |
| 7   | `TraceEmitter.stageScope` (per-instance ALS)                 | `TraceEmitter.ts:58`, rationale at `:47-58`                        | `Context.Reference` **keyed by trace** — see §3.2 caveat                                                                                 | call     |
| 8   | `ToolFileInteractionContext` ALS (43 sites)                  | `:49`, `:63-71` joins carriers 6+7                                 | `@texra/agent/ToolCall` via `Effect.provideService`                                                                                      | call     |
| 9   | `executionLease` ALS + `ownedLeases` + `PQueue` map          | `:130`, `:131`, `:502`, `:635-639`                                 | `Context.Reference` (re-entrancy set) + `@texra/agent/ExecutionLeases` (`SynchronizedRef` in a scoped layer) + `Semaphore`               | session  |
| 10  | `Flow.setServices()` / `BaseNode._services`                  | `node/index.ts:31,:40-46,:97-100,:141-145`; `persistedFlow.ts:359` | **deleted**; 6 members become services, 9 become plain arguments, 3 are loop state, 8 callbacks delete                                   | —        |
| 11  | `processRuntime` global                                      | `processRuntime.ts:19,:52`                                         | **no tag** — each host entry holds its `ManagedRuntime` in a local                                                                       | —        |
| 12  | `SessionOwner` singleton                                     | `sessionGraph.ts:140,:166-172`                                     | **deleted**; the `Sessions` tag already exists                                                                                           | session  |
| 13  | `setSetupPlatform` override + `__resetSetupPlatformForTests` | `tools/setup/platform.ts:165-181`                                  | `@texra/setup/SetupPlatform`; the test-reset export deletes (tests provide a layer)                                                      | process  |
| 14  | `SharedToolInjectionRegistry` mutable array                  | `toolInjection.ts:35`                                              | `@texra/agent/ToolInjections` (`Layer.succeed` of the resolved list)                                                                     | process  |
| 15  | `logSink`'s `let sink`                                       | `logger/logSink.ts`                                                | `@texra/platform/LogSink` — but see observability, which owns this                                                                       | process  |
| 16  | 18 further process-global installers called from the roots   | per hosts lens                                                     | one tag each, or deleted; five exist only to invert a forbidden module edge                                                              | process  |

**Explicitly NOT services**, and why — this list is as load-bearing as the one above:

- Agent definition, prompt, setting, initial state — plain function inputs (PRD §8.1).
- `config`/`setting`/`prompt` from the flow service bags — plain arguments.
- `getRejectOnCompileFailure` — a deliberately late config read, not a dependency.
- The six reflection output-pipeline managers — **one** `OutputPipeline` service, not six
  tags (R2, and the delivery plan's no-tag-per-class negative).
- Node private instance fields — `Effect.fn` generator locals; per-visit state has no
  lifetime question at all.
- Anything crossing `postMessage`. No Effect context crosses the transport; the frontend
  keeps zero `effect` imports.

## 6. Sequence

Every step names what it retires. Steps marked _seals_ add measurement only and are the one
justified exception to "no preparation-only step" — without them a 100-file migration can
grow its two largest injectors unnoticed while it is in flight.

| #   | Step                                                                                                                                                                                                                                                              | Retires                                                                                                     | Rows                                                            | Alone?         | Cohort |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------- | ------ |
| 1   | _Seals._ Seed two ratchet rows: `ambient:asyncLocalStorage` (~94 files / ~199 sites, counting **consumer** call sites per the script's own `DIRECTORY_ROWS` rationale) and `effectRuntime()` (~105 / ~330, `platformBindings()` re-pointed at a different module) | the ability to grow either injector                                                                         | seeds 2 rows                                                    | yes            | —      |
| 2   | Host root layers: each of the five composition roots builds one `Layer` and holds its `ManagedRuntime` in a local; CLI gets a single root, replacing the first-arrival latch                                                                                      | `installProcessRuntime`'s three positional callbacks; CLI `let pending`                                     | —                                                               | yes            | —      |
| 3   | **Credentials** → `Secrets` tag                                                                                                                                                                                                                                   | `Platform.secrets` + 36 sites                                                                               | `platform()` −39 sites, ~11 file rows vanish                    | yes            | A      |
| 4   | **Host capability singletons** → `SetupPlatform`, `ToolInjections`, `LogSink`                                                                                                                                                                                     | 3 module globals + the test-reset export                                                                    | `platform()` −10                                                | yes            | A      |
| 5   | **AppState** → `GlobalState` tag; `StateStore` becomes Effect-typed                                                                                                                                                                                               | `Platform.globalState`, `tryGlobalState()`                                                                  | `platform()` −24, `Effect.run*` −1                              | yes            | —      |
| 6   | **Run lifetime**: `Layer.effect(AgentRun, …)` in `executeAgent`; flip the `runner` seam at `AgentRunLifecycle.ts:479-482` from `Promise` to `Effect`                                                                                                              | `RunContext` ALS as the run's authority; both `AsyncLocalStorage.bind` sites; the launch-cancellation graph | `ambient` −(15–20), `AbortController` −3                        | yes            | B      |
| 7   | **Call lifetime**: `ToolCall` service; trace stage `Reference`                                                                                                                                                                                                    | `ToolFileInteractionContext` ALS (carrier 8), `TraceEmitter.stageScope` (carrier 7)                         | `ambient` −(43+14+3); carriers 5 → 3                            | no (needs 6)   | B      |
| 8   | **Delete the flow engine**: both flow families become `Effect.fn` programs; `BaseNode`/`Flow`/`PersistedFlow` deleted                                                                                                                                             | `setServices()`, `_services`, `clone()`, the successor table, the graph-path cursor                         | `setServices()` → 0 (**row deleted**), `dep:@agent/node` −large | no (atomic)    | C      |
| 9   | ~~**Rooted filesystem I**: `BaseFS`/`AbsoluteFS`/`RelativeFS` become Effect functions over `FileSystem`+`Path`~~ **DEFERRED (Q1 ruled 2026-09-11)**                                                                                                               | `FileSystemProvider`, `nodeFilesystem.ts`                                                                   | ~~`platform()` −30~~ (−14 real)                                 | not proceeding | D      |
| 10  | ~~**Rooted filesystem II**: `StorageFS`/`WorkspaceFS` take their root from context~~ **DEFERRED (gated on 9)**                                                                                                                                                    | `workspaceRoots.ts` **in full** (carrier 5)                                                                 | ~~`ambient` −~79~~                                              | not proceeding | D      |
| 11  | **Leases and per-key concurrency**                                                                                                                                                                                                                                | carrier 9 — the last ALS; `ownedLeases`; `unleasedWriteQueues`                                              | `ambient` → **not 0** while 10 is deferred, `p-queue` 13 → ~5   | no             | —      |
| 12  | **Close-out**: delete `platform()`, `processRuntime.ts`, `SessionOwner`, and every emptied row                                                                                                                                                                    | the last three globals                                                                                      | `platform()` → 0, `effectRuntime()` → 0 (**rows deleted**)      | yes            | —      |

Sequencing constraints that are not negotiable:

- **Step 8 is atomic.** `setServices()` is a 6-file row that only reaches zero when both
  flow families _and_ the engine go in one PR. Removing the engine incrementally would
  widen a baseline.
- **A row that reaches zero is deleted, not emptied** — an empty row fails the script
  itself (`check-effect-migration-ratchet.mjs:1384-1410`).
- **Step 9 gates step 10**, which is the audit's W1-before-W6 ordering, preserved.
- **Introducing a row is a four-part edit in one PR** (`ROW_*` constant + `ROWS` entry with
  a `rule` string; a `bump()` site in `surveySource`; a `selfTestSurvey` case; the baseline
  entry). Skipping any part fails the script by name, not the tree.

**Resolving the recorded contradiction.** PRD Phase 2 deletes the `RunContext` ALS with the
loops; the promise-boundary audit rules the same ALS layer LAST and blocked on W1. Both
cannot execute as written. This plan **splits the carrier**: `RunContext`'s run-scoped
readers convert at step 6 with the loops (their callers become Effect programs anyway),
while `workspaceRoots` waits for the filesystem ruling at step 10. The two were only ever
one item because `RunContext.ts:151-156` nests them.

## 7. Measurement

Existing instruments cover three of the five targets. Two new **rows** (not lint rules, not
`tryPromise` counters — the audit §6 fence is respected) cover the rest; both fit the
existing counting code almost verbatim and are binding-scoped, so false positives are near
zero for the same reason `platform()` already excludes `import { platform } from 'node:os'`.

A **`tryPromise` row is explicitly not proposed**: the interesting distinction — wrapping
our own `async` function versus adapting a foreign SDK — is unclassifiable for 46% of sites
(140/302). Nor can adoption metrics (tag count, `Layer` importers) live in this baseline at
all: `diffRows` fails on any rise, so a metric meant to _increase_ cannot be ratcheted here.

Reviewer's commands, per step:

```
npm run check:effect-migration-ratchet   # green only when nothing grew AND no stale headroom
npm run typecheck                        # builds do NOT type check
npm test && npm run lint
npm run check:dead-code-ratchet          # exports need consumers in the same PR
```

## 8. Rejected alternatives

- **A tag per `Platform` port.** Violates R2 and the delivery plan's explicit negative; the
  distribution (61 of 109 sites in two ports) says the same thing empirically.
- **A bridging module that reads `platform()` and exposes it as a `Layer`.** Any
  `@adapter-until` marker is a hard build failure with no baseline.
- **`effect/unstable/workflow` for durable phases.** `Activity.make`/`Workflow.make`
  require Effect Schema; §15 decision 8 keeps Zod. The repo's own `RunLedger` rows plus
  `Effect.retry` supply durability instead.
- **A new eslint rule as the deliverable.** Forbidden by audit §6; the ratchet is the fence.
- **Converting `platform()` readers inside retiring subsystems.** 1.0 plan §5 forbids it —
  a retiring file's count goes to zero when the file goes, which the shrink-only ratchet
  accepts.
- **A module-level `Context.Reference` for the trace stage.** Reintroduces the orphaned-
  subagent-transcript bug class the current per-instance ALS exists to fix.
- **One widened `WorkspaceRoots` tag shared with the webview.** The webview's tag is
  deliberately narrowed to a bare string so the browser layer cannot reach Node; widening
  it breaks that. Two tags, not one.

## 9. Open questions requiring an owner ruling

**Q1 — SUPERSEDED 2026-09-13.** The owner ruled for #12073 R-1 candidate B: adopt Effect's own
`FileSystem`/`Path` "as much as possible". `Platform` is shrinking onto the Effect-native and TeXRA
Context services (#12364, #12372, #12373, #12374 landed; slices 4b onward convert the filesystem
consumers, the fs port last), so steps 9–10 below are **redirected onto that program**, not deferred.
The 2026-09-11 evidence recorded here still binds the mechanics (keep `lstat` type bits and typed
directory walks through thin TeXRA helpers over the service). The rulings ledger
(`../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md`) is the one authority.

~~**Q1 — RULED 2026-09-11 (owner): do not adopt `@effect/platform-node`'s `FileSystem`/`Path`
for now.**~~ The question was whether to adopt Effect's own (already a root production
dependency, already used at `src/platform/defaults/jsonStore.ts:5`) or to Effect-type
TeXRA's `BaseFS`/`RelativeFS`/`WorkspaceFS`. This document recommended adopting Effect's;
the owner ruled against it, provisionally ("so far" — revisitable, not settled forever).

The measured evidence supports the ruling, and it postdates the recommendation above. A
executed-then-reverted conversion of `listWorkspaceFiles` lives on
`origin/claude/effect-ts-tracking-issues-usoj7h` as
`2026-09-08-r1-filesystem-surface-experiment.md` (never merged to main). It was green on
typecheck, lint, both ratchets and 8,884 tests, and still measured:

- **7.1–9.7× slower (median 8.7×)** on a 3,096-file / 302-directory workspace — 3,913 extra
  `stat` syscalls, because `FileSystem.readDirectory` returns `Array<string>` where TeXRA's
  port returns `[name, typeBits][]` off `withFileTypes`.
- **No `lstat`**, so the port's `isSymlink` is inexpressible, and `copy` cannot dereference —
  which breaks `runPackRunDir`'s self-contained History snapshot.
- Core `effect` ships **no working `FileSystem` layer**: `layerNoop`'s `exists()` returns
  `succeed(false)` and seven methods fail `NotFound` for paths that exist — a
  silent-degradation defect generator under CLAUDE.md's loud-failure rule.

**Consequences, which are the point of recording this here.** Steps 9 and 10 are
**deferred, not redirected** — the ruling does not select the "own" alternative as the way
forward, it declines the adoption. So:

- Step 9 (`BaseFS`/`AbsoluteFS`/`RelativeFS` → Effect functions) does not proceed.
- Step 10 is gated on 9 and therefore also does not proceed, so **carrier 5
  (`workspaceRoots.ts`: the ALS + process fallback + getter proxy) stays**, and the
  promise-boundary audit's W6 (ALS retirement) remains blocked, as it has been.
- The §6 arithmetic attributed to these steps does not land: `platform() −30` (really −14
  guaranteed; see below) and `ambient −~79` are both off the table for now.
- **The `ambient:asyncLocalStorage` row therefore cannot reach zero**, since step 10 was
  the step that retired its largest contributor.

Two corrections to this section's own framing, from re-derivation at HEAD: W1 is not "~25
non-Effect files" — at `444439be76` it was **57 non-Effect direct callers (114 in the
closure)** across **240 files / 81k LOC**, with 30 of 92 already using `Effect.fn`/`Effect.gen`.
And step 9's promised `platform() −30` is only **−14 guaranteed** (`baseFS.ts` 13 +
`storageFS.ts` 1); reaching −30 needs six files the step never names.

**If this is revisited**, the experiment's own recommendation is the shape to start from,
and it is neither of the two options as posed: split by capability. Keep `isSymlink`, a
typed `readDirectory`, `writeFileAtomic`, `publishFile` and a dereferencing `copy` as
TeXRA's, and move only plain read/write/copy/remove. That doc also records a hazard worth
carrying regardless: **Promise → Effect conversions can pass typecheck at spread sites** —
`...(await listWorkspaceFilesOfType(...))` compiled unchanged because `Effect` implements
`Symbol.iterator`.

**Q2.** Does §15 decision 8's "one `provide` at the process entry" permit the per-session
`LayerMap` and the per-run `Layer.effect` this plan uses? §3.1 assumes yes and treats the
sentence as scoping to the process layer. This needs an explicit amendment sentence in the
PRD, not an implicit assumption here.

**Q3 (§15 decision 3, still open).** Does any run-owned capability have sufficiently
independent acquisition, lifetime, or substitution to sit outside `AgentRun`? Until this
closes, R2's five provisional groups and the delivery plan's different five cannot be
reconciled, and §5's manifest is a proposal rather than a ruling.

**Q4.** R1 boundary kind (b) keeps tool `execute()` Promise-typed until the Tools _runner_
is Effect-typed, and the ratchet encodes that. Step 7 approaches this boundary. Confirm
that converting the dispatcher (not individual tools) is the intended way to retire kind
(b) and the `src/tools/**/*Tool.ts` allowance.

---

## Provenance

Produced by an eight-lens parallel survey of the repository at `cf88d2d` (ambient carriers,
Effect 4 rc.112 API ground truth from `node_modules/effect`, house exemplars, promise
boundaries, flow engine, host composition, enforcement, prior-doc reconciliation) and two
independent sequencing designs (carriers-first, vertical-slice), synthesized here.

**This document has not been adversarially verified.** The planned judge panel and the
three verification passes (API truth, repo facts, rewrite safety) did not run — the
orchestration hit a usage limit after the survey and two of three designs completed. The
file:line evidence in §2 was spot-checked by hand; the per-step ratchet arithmetic in §6
is the designs' estimate and has **not** been independently recomputed. Treat §6's numbers
as planning estimates and re-derive each before the PR that claims it.
