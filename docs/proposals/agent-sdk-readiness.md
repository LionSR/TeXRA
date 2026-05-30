# Agent SDK Readiness — Findings & Refactoring Plan

**Status:** Audit (2026-05-30). **Steps 1–2 landed**; Steps 3–7 pending.
**Scope:** `src/agent/` core + runtime, `src/agent/modelHandlers/`, logger (`src/logger/` + `src/agent/trace/`), and the public/packaging surface (`packages/core`, `packages/cli` consumption, `@agent/*` aliases, `src/platform`).
**Target:** Alignment with the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) patterns — one curated package surface, a single `query()`-style entry returning a typed async stream, one structured `Options` object, a thin provider layer, tools-as-data, and subagents-as-config.
**Related:** [`agent-trace-sdk-surface.md`](./agent-trace-sdk-surface.md), [`logger-simplification-feasibility.md`](./logger-simplification-feasibility.md), [`unified-output-protocol.md`](./unified-output-protocol.md).

## How this was produced

A 5-phase multi-agent workflow (30 subagents, ~2M tokens): (1) a Claude Agent SDK reference pass, (2) parallel structural maps of each area, (3) per-area abstraction audits against the repo's own `CLAUDE.md` anti-patterns, (4) an **adversarial verification** pass that re-opened the cited code and grep'd every consumer for each removal claim, and (5) synthesis. The verification phase is why this report is trustworthy: **it rejected 6 of the most aggressive findings as wrong or unsafe** (with compile errors / consumer lists as proof). Those rejections are documented below — they are as valuable as the accepted findings, because they mark traps.

## TL;DR — verdict

**The agent core is in good shape and already moving toward SDK alignment.** The PocketFlow flow layer is clean (`Node.exec → createXxxCycleFlow().run`, no wrapper), the coordinator hierarchy is justified shared logic, the `AgentTrace` event channel is already an SDK-idiomatic `emit()/subscribe()` surface, and `platform()` is a genuinely clean DI seam. This is **not** a codebase drowning in needless abstraction.

The real gaps are about **boundary and surface, not internal layering**:

1. **There is no SDK boundary at all.** `@texra/core` is a one-line stub imported by nobody; hosts compile directly against ~178 un-curated `src/agent` files via path aliases.
2. **There is no streaming run entry.** Two divergent run entries exist at different capability depths; neither is an async-iterable — progress is a side channel.
3. **Host↔core coordination is process-global**, which blocks multiple concurrent in-process sessions (the SDK's per-`query()` isolation).

Only **4 abstractions are verified safe to remove**, and 3 of those are trivial. The high-value work is **packaging and surface unification**, sequenced so nothing breaks.

---

## What is already SDK-aligned — do NOT refactor

| Area                                          | Why it's already right                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PocketFlow flow layer**                     | `executeAgent` dispatches straight into `createToolUseCycleFlow()/createResponseCycleFlow().run()` — exactly the "Flattening Abstraction Layers" preferred shape. No wrapper to inline.                                                                                      |
| **`BasePromiseCoordinator` + subclasses**     | A real promise/timeout/cancellation state machine shared by Retry/PlanApproval/Proposal coordinators. Justified: multiple subclasses, real logic, captured closures.                                                                                                         |
| **`AgentTrace` channel** (`src/agent/trace/`) | `emit()/subscribe()` over a discriminated `AgentEvent` union, single stage-stamp at the emit boundary, `noopTrace` opt-out. This _is_ the SDK streaming-message pattern. The logger consolidation (`AgentLogger` deleted) already landed — see `agent-trace-sdk-surface.md`. |
| **`platform()` composition root**             | 8 small vscode-free port interfaces (8–53 LOC), 10 node defaults (~953 LOC), frozen single-call init. The strongest SDK-aligned piece — promote it wholesale, don't flatten.                                                                                                 |
| **`createModelHandler` factory**              | `PROVIDER_HANDLERS` Record + dynamic-import loaders + routing. Exhaustive over `ModelProvider`. Correctly factored.                                                                                                                                                          |

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
| **Inline `AgentTrace`'s structured arms / dedupe its option types (TRACE-01/06/08)**                | The "no callers" premise is false (11+ live call sites via helpers + `UsageMonitor`). This was an explicitly documented trade-off (`agent-trace-sdk-surface.md` §9). Inlining would make the surface asymmetric, drop typed call-site signatures, and churn ~8 test mocks for zero runtime change.                                                                                                                                                                                                                         |

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

- **Recommendation: delete it** and repoint the 3 consumers to deep imports, then re-establish a _single_ canonical path later via `@texra/core` (Surface §). Do **not** try to "enforce" it (125-site migration, risks TS init-order cycles on the `AgentCategory`/`AgentConfigSchema` value exports, and there's no lint rule to back it).

### Also worth doing (low, but clean)

- **`@logger → @transcript` layering inversion (TRACE-03):** `src/logger/runTrace.ts:13–17` statically imports the TeXRA transcript recorder, welding the "host-neutral" run-trace factory to `StreamLogStore`. **Re-scope to `createRunTrace`/`flushPendingRunTraces` only** (2–3 consumers) — parameterize the subscriber list or move just those two into a product-wiring module, preserving the `activeFlushers` shutdown contract. **Leave `createChannelTrace`** in `@logger` (~23 host-neutral consumers — moving it is pointless blast radius).
- **Host-command leak (AC-01, downgraded to low):** `executeAgent.ts:228–253` / `AgentLaunchContext.ts:127–146` bake literal `texra.setApiKey`/`texra.openDoc` command IDs + English button titles into error→UI emits inside the vscode-free zone. The error is _already_ classified (`AgentErrorKind` in `agentErrorClassification.ts`) and the `ProgressEventBus` already decouples hosts. **Minimal fix:** replace the inline action literals with a typed action token hosts map themselves. Do **not** rewrite the throw/return contract (that was rejected).
- **`core/config.ts`/`core/stateStore.ts` passthroughs (SDK-008):** `getGlobalState()`/`getWorkspaceState()` are pure passthroughs over `platform().globalState` (which already exposes `tryGlobalState()`). Inline or drop. **Keep `tryGetWorkspaceState`** (real pre-init null-tolerance).

---

## Surface-area simplification — the missing SDK boundary

This is the highest-leverage work. Today "what the SDK exports" = "anything in `src/agent` reachable by a deep path." Target the SDK's single curated package.

**Proposed `@texra/core` surface** (replace the `corePackageReady` stub; re-export from one entry):

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
| **`delegate-subagent-launcher`**                                                     | `src/tools/DelegationTools.ts`, `delegationPolicy.ts`                                  | The existing equivalent of SDK Agent-tool delegation; `delegate_*` Zod tools are already tools-as-data; depth gate = SDK subagent recursion control; `parentStreamId` = `parent_tool_use_id`.                                                      |
| **`helper-model-task`** (session-desc / polish / connection-method / agent-creation) | `helperModel.ts`, `polishModel.ts`, `sessionDescription.ts`, `latex/textConnection.ts` | **Tools-as-data, not subagents** — pure typed-in→typed-out handlers, no coordinators. **Lowest-risk extraction** (shared-state risks don't apply).                                                                                                 |
| **`remote-agent-provider`**                                                          | `src/agent/remote/RemoteAgentLoader.ts`                                                | A `settingSources`-style `AgentDefinitionSource.resolve(name)` provider; already returns an `AgentDefinition`-shaped `{settings, prompts}` after schema parse.                                                                                     |
| **`latex-output-postprocessor`**                                                     | `src/agent/output/*`, `src/latex/latexdiff.ts`                                         | Deterministic transform tool (closest to a PostToolUse hook). Stays host-side — matches CLAUDE.md "defer non-text content to the host."                                                                                                            |

**The cleanest internal seam** is the `agentCategory` dispatch at `executeAgent.ts:444/497`: both flows already take typed inputs (`RunReflectionFlowInput`/`RunToolUseFlowInput`) and return typed results. The improvement is to stop threading the 14-field `AgentLaunchContext` by spread (`{...ctx, ...interrupts, …}`) and pass explicit per-flow inputs, so adding an agent type = adding a flow keyed by category, not editing `executeAgent`.

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
3. **Minimal host-command de-leak (1 PR):** swap the inline `texra.*` action literals for a typed action token keyed off the existing `AgentErrorKind`. No contract change.
4. **Barrels as packaging prep:** add curated `runtime/index.ts` and `toolUse/index.ts` re-exporting the host-facing surface; delete the half-used `core/index.ts`. Do **not** mass-migrate the 125+ deep imports (churn without a lint gate). These feed Step 5.
5. **Populate `@texra/core`:** replace the stub with re-exports of the Step-4 barrels + `@platform` + registry + storage + config/validation + trace + result. Purely additive (aliases stay); add a _warn-only_ `no-restricted-imports` rule steering new host code to `@texra/core`.
6. **Unify the run entry:** widen `RunExecutionRequestOptions` to the full option set so `runValidatedExecutionRequest` becomes the single entry; migrate the CLI chat path (`runChatTui.tsx:819`) and `DelegationTools.ts:365` onto it. Behavior-preserving per call site.
7. **(Long-horizon) Relocate global state onto a per-run handle:** move `executionRegistry` / `runCoordinators.bridgeState` / `ToolUseAgentRegistry` off module globals onto the `AgentRun` handle, preserving the resolve-side lookup-by-`approvalId`/`proposalId`/`streamId` and the `activeFlushers` flush contract. Precondition for concurrent in-process SDK sessions. Gate behind the Step-4 facade so it doesn't ripple to the 69 deep-import sites.

---

## Verified (files opened first-hand)

- `src/agent/modelHandlers/ModelHandler.ts` (abstract base, ctor + `implements IModelHandler`), `types/IModelHandler.ts` (the parallel interface), `runtime/ModelFactory.ts` (`PROVIDER_HANDLERS`)
- `src/agent/index/index.ts`, `src/agent/core/index.ts`, `packages/core/src/index.ts` (the stub)
- `src/agent/runtime/BasePromiseCoordinator.ts` (confirmed genuine shared logic), `src/agent/runtime/AgentRuntimeHost.ts` / `InterruptManager.ts` (cleanups re-confirmed by grep)
- `src/logger/index.ts`, `src/logger/logUtils.ts` (exports), `src/agent/trace/index.ts`, and `docs/proposals/agent-trace-sdk-surface.md` §1/§8/§9 (logger consolidation already landed)
- Workflow corpus: 32 findings across 4 areas, each with an adversarial verification (6 rejected); full structured output retained from the audit run.
