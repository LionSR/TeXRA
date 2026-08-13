# Agent SDK Readiness — Findings & Refactoring Plan

**Status:** Audit (2026-05-30; re-verified 2026-05-31 → 2026-06-20; Step-7 status refreshed 2026-06-10; SDK package status refreshed 2026-07-05). **Steps 1–3 + 5 + 6 landed, then the unused `@texra/core` package was demoted/deleted by #7099** because no host imported it and no build/lint boundary enforced it. Step 4 folded into Step 5; Step 6 landed in PR #4781 / commit `da131dc`; **Step 7a–c landed** (with name drift — tree has `InterruptRegistry` / `ExecutionRegistry` / `RunCoordinatorBridge`); **7d landed** (acceptance criteria below). **F-2 landed** (2026-06-14, commit `84052a4`) — the per-run control handle (`AgentRunHandle` — a `Pick` of the internal `AgentExecutionHandle` with `trace` + `result: Promise<ResultEvent>` + `getProgress`; populated via `onRun`) substantially closes **SDK-002** (no streaming run entry), but it is not currently exposed through a package barrel. **F-1 re-route begun** (#5975, commit `ee4645e`) — `emitRuntimeEvent()` replaces the grandfathered `src/tools` run-scoped `bus.emit` sites (acceptance criterion (a)); producer-side dual-emit de-dup (b) still deferred. **SDK-008 fully closed and deepened** — `core/config.ts` passthrough removed (#5349); `core/stateStore.ts` `getGlobalState`/`getWorkspaceState` inlined to `platform()` (§14, 2026-06-06) and the file **deleted entirely** with `tryWorkspaceState` moved to `@platform` (commit `a982e72`, 2026-06-15). See the re-verification addenda in [`../dev/audits/2026-05-29-agent-sdk-readiness-audit.md`](../dev/audits/2026-05-29-agent-sdk-readiness-audit.md) §9–§21 (latest: §21, 2026-06-20 — sixteenth pass, confirmation; five small net-new core backlog candidates recorded).
**Scope:** `src/agent/` core + runtime, `src/agent/modelHandlers/`, logger (`src/logger/` + `src/agent/trace/`), and the future public/packaging surface (`packages/cli` consumption, `@agent/*` aliases, `src/platform`, and any future SDK package).
**Target:** Alignment with the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) patterns — one curated package surface, a single `query()`-style entry returning a typed async stream, one structured `Options` object, a thin provider layer, tools-as-data, and subagents-as-config.
**Related:** [`2026-05-22-agent-trace-sdk-surface.md`](./2026-05-22-agent-trace-sdk-surface.md), [`2026-05-17-logger-simplification-feasibility.md`](./2026-05-17-logger-simplification-feasibility.md), [`2026-04-30-unified-output-protocol.md`](./2026-04-30-unified-output-protocol.md).

## How this was produced

A 5-phase multi-agent workflow (30 subagents, ~2M tokens): (1) a Claude Agent SDK reference pass, (2) parallel structural maps of each area, (3) per-area abstraction audits against the repo's own `CLAUDE.md` anti-patterns, (4) an **adversarial verification** pass that re-opened the cited code and grep'd every consumer for each removal claim, and (5) synthesis. The verification phase is why this report is trustworthy: **it rejected 6 of the most aggressive findings as wrong or unsafe** (with compile errors / consumer lists as proof). Those rejections are documented below — they are as valuable as the accepted findings, because they mark traps.

## TL;DR — verdict

**The agent core is in good shape and already moving toward SDK alignment.** The PocketFlow flow layer is clean (`Node.exec → createXxxCycleFlow().run`, no wrapper), the coordinator hierarchy is justified shared logic, the `AgentTrace` event channel is already an SDK-idiomatic `emit()/subscribe()` surface, and `platform()` is a genuinely clean DI seam. This is **not** a codebase drowning in needless abstraction.

The real gaps are about **boundary and surface, not internal layering**:

1. **There is no SDK boundary at all.** The earlier `@texra/core` barrel was imported by nobody and was deleted by #7099 rather than left as an unenforced package. Hosts compile directly against un-curated `src/agent` files via path aliases.
2. **There is no streaming run entry.** Two divergent run entries exist at different capability depths; neither is an async-iterable — progress is a side channel.
3. **Host↔core coordination is process-global**, which blocks multiple concurrent in-process sessions (the SDK's per-`query()` isolation).

Only **4 abstractions are verified safe to remove**, and 3 of those are trivial. The high-value work is **packaging and surface unification**, sequenced so nothing breaks.

---

## What is already SDK-aligned — do NOT refactor

| Area                                          | Why it's already right                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PocketFlow flow layer**                     | `executeAgent` dispatches straight into `createToolUseCycleFlow()/createResponseCycleFlow().run()` — exactly the "Flattening Abstraction Layers" preferred shape. No wrapper to inline.                                                                                                 |
| **`BasePromiseCoordinator` + subclasses**     | A real promise/timeout/cancellation state machine shared by Retry/PlanApproval/Proposal coordinators. Justified: multiple subclasses, real logic, captured closures.                                                                                                                    |
| **`AgentTrace` channel** (`src/agent/trace/`) | `emit()/subscribe()` over a discriminated `AgentEvent` union, single stage-stamp at the emit boundary, `noopTrace` opt-out. This _is_ the SDK streaming-message pattern. The logger consolidation (`AgentLogger` deleted) already landed — see `2026-05-22-agent-trace-sdk-surface.md`. |
| **`platform()` composition root**             | 8 small vscode-free port interfaces (8–53 LOC), 10 node defaults (~953 LOC), frozen single-call init. The strongest SDK-aligned piece — promote it wholesale, don't flatten.                                                                                                            |
| **`createModelHandler` factory**              | `PROVIDER_HANDLERS` Record + dynamic-import loaders + routing. Exhaustive over `ModelProvider`. Correctly factored.                                                                                                                                                                     |

---

## Rejected findings (traps — do not pursue)

The verifier opened the code and, in several cases, applied the change and ran `tsc`. These plausible-sounding refactors are **wrong**:

| Claim                                                                                               | Why it was rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove `IModelHandler` as a redundant duplicate of `ModelHandler`**                               | **Not a duplicate.** `IModelHandler` declares an _optional_ `createBatchedToolUseFollowUpMessages?` that the abstract class omits and `ToolUseCycleFlow` feature-detects. Typing `AgentCore.modelHandler` against the class produces `TS2551`; removing the `runToolUseFlow.ts:231` cast produces `TS2322/TS2345` (the cast is a generic-`C` bridge, not an interface artifact). _Only_ the safe sliver survives: extract the load-bearing type aliases (`SdkToolCall`, the option/result types) into a pure types module. |
| **Split `modelHandlerOpenAIResponse.ts` (3328 LOC) into Transport/Compaction/Upload collaborators** | The smell is **real** (god-file), but the concerns share mutable conversation state, background polling spans all three transports, and the test suite subclasses the handler. This is a multi-day design migration, not a mechanical extraction. Keep as a tracked refactor, _not_ a quick win.                                                                                                                                                                                                                           |
| **Extract auth/tiers/relay-quota out of base `ModelHandler`**                                       | `ModelHandler` and `@auth/*` are **already vscode-free**; the relay/tier logic is shared core consumed identically by CLI and extension (not host-specific); `getServerSideKeyService()` is already a swappable, test-mocked singleton. The "extract a port" proposal would add indirection over a working, injectable seam.                                                                                                                                                                                               |
| **Merge `ModelHandlerOpenRouterNative` into the OpenAI base**                                       | The genuinely shared piece (`ToolCallAccumulator`) is **already** shared. The rest reflects two real SDK type families (snake*case OpenAI vs camelCase `@openrouter/sdk`) + OpenRouter-only `reasoningDetails` + different tool-call materialization. The exact subclassing proposed was \_deliberately deleted* in PR #2962.                                                                                                                                                                                              |
| **Merge the two run entries / route CLI through `validateExecutionRequest`**                        | `runValidatedExecutionRequest` is a load-bearing host-shared seam (3 consumers across 3 hosts) encoding the fresh-vs-resume registration policy + workflow-output gating. `validateExecutionRequest` is the deliberate **non-throwing** `{valid,message}` variant for UI hosts; the CLI's throwing `AgentConfigSchema.parse` is the correct headless idiom. Both serve different consumer classes. (The _real_ fix is to **widen** the wrapper, not merge — see Surface §.)                                                |
| **Inline `AgentTrace`'s structured arms / dedupe its option types (TRACE-01/06/08)**                | The "no callers" premise is false (11+ live call sites via helpers + `UsageMonitor`). This was an explicitly documented trade-off (`2026-05-22-agent-trace-sdk-surface.md` §9). Inlining would make the surface asymmetric, drop typed call-site signatures, and churn ~8 test mocks for zero runtime change.                                                                                                                                                                                                              |

---

## Abstractions to remove — verified safe (ranked)

These survived adversarial verification. The first three I also independently re-confirmed (grep'd zero production readers).

### 1. Dead ambient runtime-host singleton — `AgentRuntimeHost.ts:14–22` _(small)_

`getDefaultAgentRuntimeHost()` has **zero** production readers (`executeAgent` and `createRunContext` hard-throw on a null host; `extension.ts:219` only _writes_ via the setter). It's a write-only ambient global that also blocks concurrent sessions.

- **Remove:** `getDefaultAgentRuntimeHost`, the mutable `defaultAgentRuntimeHost`, `setDefaultAgentRuntimeHost`.
- **Keep:** `noopAgentRuntimeHost` (exported, for tests to inject), and the `CoordinatorRuntimeHost`/`toRuntimeHostProvider` provider-callback form (load-bearing for late binding).
- **Not zero-touch:** ~9 test suites do a save/restore dance and `PromiseCoordinators.test.ts:90` passes the getter _as_ a `RuntimeHostProvider` callback. The PR must migrate those to a locally-constructed noop host.

### 2. Redundant `InterruptCallbacks` interface — `InterruptManager.ts:5–12` _(trivial)_

A verbatim duplicate of the three interrupt fields already on `BaseFlowContextInit` (`BaseFlowServices.ts:47–50`). Confirmed never imported by name — only the `createInterruptCallbacks` factory is.

- **Change** the factory's return type to `Pick<BaseFlowContextInit, 'checkInterruption' | 'setAbortController' | 'onInterrupt'>` and delete the standalone interface. (Only widens `onInterrupt` to optional — harmless; the factory always returns it.) Keep the closure factory; optionally rename the file to `interruptCallbacks.ts`.

### 3. Unreachable switch arms — `TexraTranscriptRecorder.ts:360–363` _(trivial)_

`domainMessageType()` has `'progressStatus'` and `'userMessage'` cases, but those concepts flow through the **log** path (`logProgressStatus`/`logUserMessage` call `trace.info()`), never `trace.domain()`. Confirmed no `trace.domain({key:'progressStatus'|'userMessage'})` emitters exist.

- **Delete** the two case arms. Cannot change runtime behavior today.

### 4. `core/index.ts` barrel — `src/agent/core/index.ts` _(small if deleting)_

Used by 3 sites while `@agent/core/AgentDataclass` is deep-imported 77× and `@agent/core/AgentConfig` 48×. `AgentCategory` has **4** import paths. Provides zero encapsulation.

- **Recommendation: delete it** and repoint the 3 consumers to deep imports, then re-establish a _single_ canonical path later via a future SDK package (Surface §). Do **not** try to "enforce" it (125-site migration, risks TS init-order cycles on the `AgentCategory`/`AgentConfigSchema` value exports, and there's no lint rule to back it).

### Also worth doing (low, but clean)

- **`@logger → @transcript` layering inversion (TRACE-03):** `src/logger/runTrace.ts:13–17` statically imports the TeXRA transcript recorder, welding the "host-neutral" run-trace factory to `StreamLogStore`. **Re-scope to `createRunTrace`/`flushPendingRunTraces` only** (2–3 consumers) — parameterize the subscriber list or move just those two into a product-wiring module, preserving the `activeFlushers` shutdown contract. **Leave `createChannelTrace`** in `@logger` (~23 host-neutral consumers — moving it is pointless blast radius).
- **Host-command leak (AC-01, downgraded to low):** `executeAgent.ts:228–253` / `AgentLaunchContext.ts:127–146` bake literal `texra.setApiKey`/`texra.openDoc` command IDs + English button titles into error→UI emits inside the vscode-free zone. The error is _already_ classified (`AgentErrorKind` in `agentErrorClassification.ts`) and the `ProgressEventBus` already decouples hosts. **Minimal fix:** replace the inline action literals with a typed action token hosts map themselves. Do **not** rewrite the throw/return contract (that was rejected).
- **`core/config.ts`/`core/stateStore.ts` passthroughs (SDK-008):** `getGlobalState()`/`getWorkspaceState()` are pure passthroughs over `platform().globalState` (which already exposes `tryGlobalState()`). Inline or drop. **Keep `tryGetWorkspaceState`** (real pre-init null-tolerance).

---

## Surface-area simplification — the missing SDK boundary

This is the highest-leverage work. Today "what the SDK exports" = "anything in `src/agent` reachable by a deep path." A future SDK must be a real package with a build and import-boundary enforcement; there is no current `@texra/core` package.

**Future `@texra/core` surface** (reintroduce only with a real build and import-boundary lint gate):

| Module                | Exports                                                                                                                         | Maps to SDK                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **run entry**         | unified `runAgent(config, options)` + `RunOptions` type + `AgentRun` handle                                                     | `query({prompt, options}) → Query`      |
| **result/events**     | `AgentFlowResult` (+ schema), `AgentTrace`, `AgentEvent`, `noopTrace`, transcript-free `createRunTrace`                         | `SDKMessage` / streaming-message stream |
| **host port**         | `AgentRuntimeHost`, `noopAgentRuntimeHost` (minus the dead default singleton)                                                   | `Options.runtimeHost` injection         |
| **config/validation** | `AgentConfig`, `AgentConfigSchema`, `AgentCategory` (one path), `validateExecutionRequest` (UI path) + `.parse` (headless path) | `Options` validated once in `query()`   |
| **registry/storage**  | `@agent/index` (agent registry), `@agent/storage` (KV/history)                                                                  | `Options.agents` / session store        |
| **platform**          | the 8 vscode-free ports + 10 node defaults + `initPlatform`/`platform`                                                          | provider/credential injection           |

**The one entry-point fix (resolves SDK-002 _without_ the rejected merge):** widen `RunExecutionRequestOptions` to the full `ExecuteAgentOptions` field set (the streaming callbacks `onStreamResolved`/`onProgress`/`onCompleted`/…), so `runValidatedExecutionRequest` can serve the interactive chat path that currently bypasses it — while keeping the register + `openWorkflowOutput` policy the wrapper legitimately owns. `executeAgent` becomes the internal dispatcher.

**Known gaps left honest:**

- **Tools-as-data:** TeXRA tools are class instances; there is no `tool()`/`createSdkMcpServer()` equivalent. (`defineTool()` _does_ already produce `{name, description, inputSchema, handler}` — a good starting point.) This is a separate, larger refactor.
- **Multi-tenant sessions:** three module-global registries (`executionRegistry`, `runCoordinators.bridgeState`, `ToolUseAgentRegistry`) make the runtime a per-process singleton. The `runCoordinators` bridge is **load-bearing** (resolve-side UI callers run outside the run's `AsyncLocalStorage` and key by `approvalId`/`proposalId`/`streamId`) — it must be **relocated** onto a per-run handle, **not deleted**. This is the gating blocker for concurrent in-process `query()` sessions.

---

## Subagent split points

TeXRA is unusually well-positioned: YAML agent profiles are near-isomorphic to the SDK's `AgentDefinition`, and `DelegationTools.executeSubagent` is already a real isolated-context async delegation path. Candidates, ranked by proximity-to-contract × independence-from-shared-state:

| Subagent                                                                             | Backed by                                                                              | SDK mapping                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`tooluse-conversational-agent`**                                                   | `runToolUseFlow.ts` (+ nodes), dispatched at `executeAgent.ts:444`                     | `AgentDefinition{agentCategory:'toolUse'}`; `isSubagent` mode = SDK isolated-context subagent; `onProgress` → `SDKTaskProgressMessage`; `lastResponse`/`touchedFiles` → `SDKResultMessage`. **Closest existing analog to per-subagent `query()`.** |
| **`workflow-reflection-agent`**                                                      | `runReflectionFlow.ts` (+ nodes), dispatched at `executeAgent.ts:497`                  | `AgentDefinition{agentCategory:'workflow'}`; YAML profile _is_ the definition; round outputs → result messages.                                                                                                                                    |
| **`delegate-subagent-launcher`**                                                     | `src/tools/delegation/DelegationTools.ts`, `delegationPolicy.ts`                       | The existing equivalent of SDK Agent-tool delegation; `delegate_*` Zod tools are already tools-as-data; depth gate = SDK subagent recursion control; `parentStreamId` = `parent_tool_use_id`.                                                      |
| **`helper-model-task`** (session-desc / polish / connection-method / agent-creation) | `helperModel.ts`, `polishModel.ts`, `sessionDescription.ts`, `latex/textConnection.ts` | **Tools-as-data, not subagents** — pure typed-in→typed-out handlers, no coordinators. **Lowest-risk extraction** (shared-state risks don't apply).                                                                                                 |
| **`remote-agent-provider`**                                                          | `src/agent/remote/RemoteAgentLoader.ts`                                                | A `settingSources`-style `AgentDefinitionSource.resolve(name)` provider; already returns an `AgentDefinition`-shaped `{settings, prompts}` after schema parse.                                                                                     |
| **`latex-output-postprocessor`**                                                     | `src/agent/output/*`, `src/latex/latexdiff.ts`                                         | Deterministic transform tool (closest to a PostToolUse hook). Stays host-side — matches CLAUDE.md "defer non-text content to the host."                                                                                                            |

**The cleanest internal seam** is the `agentCategory` dispatch at `executeAgent.ts:444/497`: both flows already take typed inputs (`RunReflectionFlowInput`/`RunToolUseFlowInput`) and return typed results. The improvement is to stop threading the 14-field `AgentLaunchContext` by spread (`{...ctx, ...interrupts, …}`) and pass explicit per-flow inputs, so adding an agent type = adding a flow keyed by category, not editing `executeAgent`.

`AgentCategory` is permanently binary: `workflow` and `toolUse` are the two
execution families. New agent profiles and execution modes belong within one
of these families; they do not add a third category.

**Risks that bound this work** (must be respected before promoting flows to config-selected delegates):

1. **Shared coordinator state** — concurrent delegates keyed by `streamId` would cross-clear each other's retry/plan-approval requests. Move registries onto the per-run handle _first_.
2. **`ctx.config` is mutated in place** during a run (`executeAgent.ts:474`); delegates must deep-isolate config (the delegation path already re-parses via `AgentConfigSchema.parse` — the correct isolation point).
3. **Handler ownership/disposal** — `OpenAIResponse` holds a live WebSocket per instance; each subagent/tool must own its handler via `createModelHandler`/`createHelperModelKit`, never share an instance (disposal would tear down another's socket).
4. **Async delivery latency** — preserve `onBeforeWaiting` early-delivery; a synchronous "query returns result" model would reintroduce the blocking wait the current design avoids.
5. The `runToolUseFlow.ts:231` generic-`C` cast must be preserved across any flow-boundary re-typing (breaks compilation otherwise — confirmed).

---

## Phased migration plan

Each step is independently shippable; later steps are additive so nothing breaks.

1. ✅ **Zero-risk cleanups (LANDED):** removed the dead `getDefaultAgentRuntimeHost` singleton (migrated ~9 tests to local hosts); collapsed `InterruptCallbacks` into `Pick<BaseFlowContextInit,…>`; deleted the unreachable `domainMessageType` arms; deleted the bypassed `core/index.ts` barrel (Item 4). Typecheck + vitest + eslint clean.
2. ✅ **Break `@logger → @transcript` (LANDED):** relocated `createRunTrace`/`flushPendingRunTraces`/`RunTrace` into `@transcript` (the verifier's "move the two symbols" option — lower risk than parameterizing, since ~10 test callers depend on the default transcript behavior); `@logger` now imports nothing from `@transcript`, leaving `createChannelTrace` as its only run-trace factory. Pure relocation + import-path swaps, no behavior change. Typecheck (×4) + vitest (63 tests) + eslint clean.
3. ✅ **Minimal host-command de-leak (LANDED):** the agent core no longer bakes `texra.*` command IDs / English button titles into `requestShowInstruction`. It emits host-agnostic `INSTRUCTION_ACTION` tokens (`@eventBus`); the VS Code extension maps each token → command + label in `agentEventListeners.ts`. Desktop/CLI already ignore these events (unchanged). Typecheck (×4) + vitest + eslint clean; no test changes needed (the `texra.*` IDs stay registered in the extension).
4. ✅ **Folded into Step 5.** Standalone `runtime/`/`toolUse/` barrels were skipped — the audit verifier flagged them as "pure churn" without a lint gate. The `core/index.ts` barrel was already deleted in Step 1.
5. ⚠️ **Populate `@texra/core` (LANDED, then DEMOTED):** this briefly replaced the one-line `corePackageReady` stub with a curated surface — `@platform` composition root, `AgentConfig`/`AgentCategory`, execution-request validation, the run entry (`executeAgent`/`runValidatedExecutionRequest`/`AgentFlowResult`), `AgentRuntimeHost`, the `AgentTrace` channel, the agent registry, and execution storage. Because no host imported it and the deferred `no-restricted-imports` lint gate never existed, #7099 deleted the package rather than preserving SDK claims without SDK guarantees. Treat this row as design inventory for a future enforced package, not as a current artifact.

### Steps 6–7 — refined 2026-05-30 (workflow re-analysis against current main)

A design-panel + adversarial-verify pass re-examined the original Steps 6–7 when the experimental `@texra/core` barrel existed. **Both structural designs were rejected as scoped** and the cleanest path is naming/curation, not restructuring:

- ❌ **Run-entry _facade_** (one `runAgent(config, options)` superset) hits a real type wall — `registerExecution` requires `AgentConfig` (parsed) but the direct callers (`DelegationTools.ts:365`, `runChatTui.tsx:865`) hold the looser `AgentConfigPayload`; `DelegationTools` uses a 6-arg register (parent/depth lineage) inexpressible via a boolean flag. And the self-explanatory "single entry" win is hypothetical without a real SDK package and import gate; the "two siblings" confusion would just move from `index.ts` to `@agent/runtime`.
- ❌ **`query()` → async-iterable handle** is **infeasible as scoped** — the per-run `TraceEmitter` is created lazily _inside_ the run (`AgentLaunchContext.ts`, via `createRunTrace(streamId)`), reachable only through `AsyncLocalStorage`; there is **no `executionId → trace` registry** and no host consumes `AgentEvent` that way (they read `StreamLogStore` by `streamId`). Building it needs new infra = Step 7.

**Step 6 (refined) — ✅ LANDED (PR #4781, commit `da131dc`; re-verified in tree 2026-05-31).** Made the surface _say_ which entry is which (behavior-neutral). Renamed `runValidatedExecutionRequest` → **`runAgent`** (+ file `runExecutionRequest.ts` → `runAgent.ts`, `RunExecutionRequestOptions` → `RunAgentOptions`), body byte-identical. The then-current package barrel aliased `executeAgent` as **`runAgentStream`** (source untouched), added "START HERE" doc comments, dropped `getAgentPath` from the surface, exported `ExecutionId` / `ExecuteAgentOptions` / `WorkflowFlowResult`, numbered the export sections, and added a top-of-file usage example + a `package.json` `exports` map. #7099 later deleted that unused package; the naming lesson remains for a future enforced SDK surface. Updated the 4 referencing files **including the desktop dynamic-import string literal**, which was renamed from the old `@agent/runtime/runExecutionRequest` path to `@agent/runtime/runAgent` (not caught by `tsc`; no longer present in the tree post-rename). _Flag, don't fix:_ `setupAssistantCommand.ts:333`'s 3-arg `registerExecution` drops `agentCategory` — a real divergence, but fixing it is a behavior change, so leave it a documented follow-up.

**Step 7 (refined) — relocate module-global state incrementally (each PR behavior-neutral; the landed pattern is one ownership concern per commit with same-commit call-site migration + a cross-instance isolation test — the planned "delegators" layer was never built):**

7a. ✅ **LANDED** (`9d7b9c434`; as **`InterruptRegistry`**, not the planned `SessionInterruptRegistry`) — `ToolUseAgentRegistry` Map → class + module-default instance; free functions deleted and call sites migrated in the same commit; cross-instance isolation test.
7b. ✅ **LANDED** (`94ead2298` + `14a2bd635`) — `executionRegistry` 3 Maps → `ExecutionRegistry` class; the module-level `StreamStatusService.onDidChange` became a constructor-wired instance subscription with `dispose()`; call sites migrated to instance methods in the same commit.
7c. ✅ **LANDED** (`0a927c689`; as **`RunCoordinatorBridge`**, not the planned `CoordinatorBridge`) — `runCoordinators.bridgeState` → class; free functions deleted, call sites migrated same-commit. The originally-cited `retryCoordinatorRefs` ref-counting + three-way fallback were **later collapsed on main** (`0b210affe`, `5d9b81f32`); the now-load-bearing resolve-side mechanics to preserve verbatim are recorded in [`2026-06-10-session-handle-7d-design.md`](./2026-06-10-session-handle-7d-design.md) § Ground truth. **Load-bearing — relocate, never delete.**
7d. ✅ **PRs 1–7 LANDED (consolidated 2026-06-13)** — the full train (originally stacked as #5948 → #5959) merged as one PR against main: `SessionHandle` composition root + identity-wrapped `defaultSession`, threaded through the run via the frozen `RunContext`, per-session sweeps/flushers, desktop per-window session, and the terminal `result` `AgentEvent` consumed by hosts via `session.onResult`. The audit fixes are folded in (delegation/host-path session resolution, flusher-set unregister-on-dispose, exactly-once `result`, shared toast presentation). Residue closed: the `clearAll*` path is per-session and `SessionHandle.dispose()` is the first production `ExecutionRegistry.dispose()` caller (audit §15); `executionSubscriptionBinder` joined the composed set. **Remaining for F-1** (named, deferred): the host-path `bus.emit` re-routes through `session.hostChannel` (odyssey forget, both `resolveExternalInquiry` arms, `inquiryThreadUpdated`, GitHub stream follow-ups) and the `UsageMonitor`/conversation-progress dual-emit consolidation — until then those host-path callers resolve `currentSession()` outside any run ALS (= the process default), the documented multi-window residue. **Implementation design: [`2026-06-10-session-handle-7d-design.md`](./2026-06-10-session-handle-7d-design.md)** (PR-by-PR; PRs 1–5 behavior-neutral, 6–7 the two cutovers).

**Step 7d acceptance criteria** (recorded 2026-06-10 by [`2026-06-10-error-pipeline-and-ownership.md`](./2026-06-10-error-pipeline-and-ownership.md) T3-1 — cited by event name + file basename, not line numbers, because line cites drifted twice during verification):

- **(a) One emission path for run-scoped events.** Core VS-Code-free zones emit run-scoped events only via the run's `runtimeHost`. The 7 direct `bus.emit` sites in `src/tools` (`odysseyStateChanged` in `odysseyStore.ts` — a rename to `goalStateChanged`/`goalStore.ts` is in flight on an unmerged branch — and the inquiry events) re-route **only when the per-session handle exists**; re-routing earlier changes headless NDJSON output and risks in-process inquiry RPC resolution.
- **(b) Single-emission producers.** Producer-side multi-emits (the `UsageMonitor` dual emit; the two `updateConversationProgress` emitters) become single emissions derived by one hub subscriber — **agentCategory-aware**, preserving the intentional workflow-only transcript stats copy. Do not pre-consolidate the producers (divergent semantics; measured net-ADD shape).
- **(c) Terminal result as data.** The `result` variant on `AgentEvent` (one discriminated arm emitted at the `runFlowWithLifecycle` boundary; `cancelled` a sibling of `failed`) is an acceptance criterion of the handle design — the handle is what hosts consume it from. See `2026-06-10-error-pipeline-and-ownership.md` T3-2.
- **(d) Flusher lifetime.** `flushPendingRunTraces`' module-global `activeFlushers` set hangs off the handle, preserving the shutdown contract.

Deferred: regrouping `ExecuteAgentOptions`'s flat 12-field bag (churn until a handle consumes it); the full structured-Options + control-handle + session-resume convergence (requires 7d first).

---

## Verified (files opened first-hand)

- `src/agent/modelHandlers/ModelHandler.ts` (abstract base, ctor + `implements IModelHandler`), `types/IModelHandler.ts` (the parallel interface), `runtime/ModelFactory.ts` (`PROVIDER_HANDLERS`)
- `src/agent/index/index.ts`, `src/agent/core/index.ts`, historical `packages/core/src/index.ts` states (stub → curated barrel → deleted by #7099)
- `src/agent/runtime/BasePromiseCoordinator.ts` (confirmed genuine shared logic), `src/agent/runtime/AgentRuntimeHost.ts` / `InterruptManager.ts` (cleanups re-confirmed by grep)
- `src/logger/index.ts`, `src/logger/logUtils.ts` (exports), `src/agent/trace/index.ts`, and `docs/proposals/2026-05-22-agent-trace-sdk-surface.md` §1/§8/§9 (logger consolidation already landed)
- Workflow corpus: 32 findings across 4 areas, each with an adversarial verification (6 rejected); full structured output retained from the audit run.
