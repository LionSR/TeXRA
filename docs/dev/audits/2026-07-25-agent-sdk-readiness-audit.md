---
created: 2026-07-25
---

# Agent SDK Readiness Audit (2026-07-25)

A fresh, evidence-backed snapshot of how ready the host-agnostic agent core is to
be drawn into a stable SDK surface (the eventual `@texra/core`). Scope: the agent
**core** (`src/agent/core/`), the **runtime** (`src/agent/runtime/`), the **model
handler** layer (`src/agent/modelHandlers/`), the **logger** (`src/logger/`), and
the **platform ports / export surface**.

This is the current follow-up to the
[May 2026 Agent SDK readiness audit](2026-05-29-agent-sdk-readiness-audit.md),
which records the earlier package and architecture state. Read that document as
historical context and this one as the post-retirement snapshot.

> **Relation to the retired PRDs.** The three heavyweight runtime-boundary
> proposals — [Runtime/host decoupling](../../prds/2026-06-27-prd-runtime-host-decoupling.md),
> [Agent SDK boundary](../../prds/2026-06-29-prd-agent-sdk-boundary.md),
> [Runtime gold-standard](../../prds/2026-06-29-prd-runtime-gold-standard.md) — were
> **retired 2026-07-18**. `main` deliberately took the lighter path: a small
> `AgentRuntimeHost` event sink with a no-op headless implementation, run/session
> facts split across `AgentEvent` (trace) and `SessionFact`, and host→agent import
> boundaries enforced by ratchet tests rather than a package fence. This audit does
> **not** reopen those proposals. `RunDescriptor` (frozen-injection), `ModelCell`,
> `PendingRequests`, `RetryPolicy`/`RetryGate`, and `HostUiBus` remain retired and
> must not be implemented from this record. The later
> [narrow ModelCell ownership ruling][modelcell-ownership-ruling]
> governs only the current primitive on `main`; it does not revive these proposals
> or make their other retired designs authoritative. The findings below are the
> residue that the lighter path leaves, nothing more.

[modelcell-ownership-ruling]: ../../proposals/2026-08-01-architecture-rulings-ledger.md#modelcell

## Headline

**The area is already unusually well-aligned and is _not_ over-abstracted.** The
repo's anti-abstraction guardrails (no barrels, no re-export shims, single-caller
extractions banned, factories need multiple callers, exports need a consumer) are
visibly holding across all four areas. The remaining work is **boundary declaration
and one internal dependency inversion**, not cleanup of violations.

Verified-clean, with evidence:

- **Host decoupling is airtight.** Zero `vscode` imports and zero `packages/*`
  imports across all of `core` + `runtime` (grep-verified over every VS Code-free
  zone). The only `vscode` hits under `src/` are in `src/test-kernel/` doubles.
- **One coherent logger.** `src/logger/logUtils.ts` (~217 lines) with a
  **host-injected sink** (`setOutputChannelFactory`) and a console fallback — the
  pluggable-sink shape an SDK needs. Deliberately _not_ a `Platform` port
  (documented at `src/platform/platform.ts:31-34`). No competing logger wrappers.
  `console.*` in core is effectively zero (`src/agent/` = 2, both the one
  deliberate leaf-module `console.warn` + its explanatory comment; `src/model/` =
  0; `src/tools/latex/controllers/replacement/eventBus/hosts` = 0 each).
- **Frozen DI platform root.** `Platform` (`src/platform/platform.ts:36-57`) is a
  clean composition root, `vscode`-shape-compatible without importing `vscode`.
- **Near-zero dead-export debt in core.** The knip ratchet baseline
  (`config/ratchets/knip-baseline.json`) carries only 18 findings total; the single
  `src/` entry is a test file. The core surface is honest.
- **`AgentRuntimeHost` is already written as the SDK port** — its docstring names
  the "Headless / SDK contract", and `noopAgentRuntimeHost` is a valid
  drop-everything host (headless parity made structural).

## Concrete findings (actionable, ranked)

### 1. Intra-`agent` dependency web — the #1 SDK-extraction obstacle (structural)

This — not any wrapper layer — is the central obstacle to a clean `@texra/core`
cut. The layering inside the `agent` subsystem is a cycle, not a stack:

- `core/flows` → **`runtime`**: `RunContext.useLaunchRunContext`
  (`ResponseCycleFlow.ts:24`, `RetryState.ts:8`, `CommonCycleTypes.ts:9`,
  `ModelInvocationNode.ts:18`) and `runtime/textConnection`
  (`ResponseCycleFlow.ts:25`).
- `runtime` → **`implementations/flows`**: `executeAgent.ts:9-11`,
  `SessionResumeRetrieval.ts:25-26`.
- `core/flows` → **`@tools`** (a _value_, not a type):
  `CommonCycleTypes.ts:20` imports `formatPostCompactionContext` from
  `@tools/delegation/subagentResults`.
- `runtime` → **`@tools`**: 14 imports across `agentToolResolution.ts`,
  `childRunLoop.ts`, `agentLoad.ts`, `toolInjection.ts`, `agentShutdown.ts`.

The `subsystemEdgeRatchet` (`config/ratchets/architecture-edges-baseline.json`)
freezes the **coarse** `agent → tools` / `tools → agent` value edges as accepted,
but it collapses the whole `agent` subsystem to one node, so the finer
`core/flows ↔ runtime ↔ tools` cycle is **untracked**. Everything here is
host-agnostic (no `vscode`), so it doesn't violate the platform rules — but
_host-agnostic ≠ cleanly extractable_: you cannot lift `core` into a package
without also lifting `runtime/RunContext`, `runtime/textConnection`, and the
`@tools` formatting helpers, or inverting those edges behind injected ports.

**Recommendation (only if/when a real package cut is pursued):** push the
ambient-ALS `RunContext` down into `core` (or a shared `core/context`), inject
`textConnection` and the `@tools/delegation/subagentResults` formatting helper as ports
rather than importing them from `core/flows`, and add an **intra-`agent` edge
ratchet** so the cycle can't regrow. Absent a package cut, this is documentation,
not urgent work.

### 2. Dead `ModelHandlerOpenAIReasoning` route — RESOLVED (deleted)

> **Status: fixed.** Both the enum member and the switch case were deleted after
> the verification below. `ReasoningModelHandlerOpenAI` itself stays — it remains
> the base class of the four OpenAI-compatible reasoning handlers, so the dead
> code was only the _direct instantiation route_, never the class.

`'ModelHandlerOpenAIReasoning'` was declared in the persisted compatibility-key
enum (`modelHandlerCompatibilityKey.ts:10`) and had a live `switch` case
constructing `new ReasoningModelHandlerOpenAI(config)`
(`ModelFactory.ts:615-623`). **Nothing ever produced this key:**
`modelHandlerCompatibilityKey()` never returned it (DeepSeek/GLM/Kimi/MiniMax map
to their own concrete keys), `inferPersistedModelHandlerCompatibilityKey()` never
returned it, and there were zero references outside the enum declaration and
switch case (grep across `src/` and `packages/`, tests included: three textual
occurrences across those two source locations).

**Verification performed before deleting** (the enum is load-bearing for resume
routing, so this was checked on every axis):

- `git log --all -S "ModelHandlerOpenAIReasoning"` shows the string was introduced
  by #9095 and was **producer-less from the moment it was added** — no shipped
  version could have persisted it.
- The persisted-key read path degrades gracefully anyway:
  `modelHandlerCompatibilityInference.ts:140` uses `.nullish().safeParse(...)` and
  falls back to message-shape inference when the key doesn't parse.
- Zero test references; zero references anywhere outside the two deleted sites.

## Surface simplification / SDK boundary formalization

The de-facto public surface is already coherent — the missing piece is an
**enforced public-surface manifest**, not new abstractions.

**Already de-facto public (formalize as the Tier-1 surface):**

- Launch / resume: `runAgent`, `executeAgent`, `resumeToolUseFromResumeData`,
  `resumeQueuedToolUseFromResumeData`. `runAgent` vs `executeAgent` is correct
  layering (executionId ownership), not indirection — `runAgent`'s options are
  `Pick`ed from `ExecuteAgentOptions` so they can't drift.
- Host port: `AgentRuntimeHost` + `noopAgentRuntimeHost`.
- Session: `SessionHandle` + `defaultSession`/`initializeDefaultSession` (consumed
  from ~20 host directories).
- Per-run handle: the `AgentRunHandle` `Pick` (`ExecutionHandle.ts:320`), delivered
  via `onRun`, exposing `.result`/`.trace`/`interrupt`.
- Result contracts: `AgentFlowResult`, `AgentFinalResult`, `WorkflowFlowResult`.
- DI / discovery: `initPlatform`/`platform`/`Platform`, agent-load functions.

**Keep internal — do not publish** (currently exported, but machinery):
`finalizeRunTerminal`/`runFlowWithLifecycle` (lifecycle choreography),
`buildAgentLaunchContext`/`withExecutionRunContext` (launch assembly), the concrete
`ExecutionRegistry` / `AgentExecutionHandle` classes (publish the `AgentRunHandle`
_interface_, not the class), and the emit-name registries
(`runtimeInteractionEvents`/`runtimePresentationEvents`/`runFactEvents` — wire
vocabularies).

**Straddling seams to resolve for a _hard_ boundary** (not violations today):

- The `@common/state` and `@common/webview` aliases resolve into
  `packages/extension` while `@common/*` resolves into `src/common` — the one alias
  family straddling the core/host line; split it if a package fence is drawn.
- 10 `console.*` sites in `src/shared/` (webview-shared code where the log factory
  isn't wired) bypass the injected sink — the one logger cluster to reconcile.

**Node-locked by design:** documented `node:fs`/`child_process` couplings in a few
tool integrations (`tempFileManager.ts`, `leanSession.ts`, `internalValidationOverride.ts`)
mean any extracted SDK is **Node-only** by construction, not browser/edge-portable.
Not a defect — worth stating in the surface docs.

## Subagent split points

**This is the strongest area — already independent-agent-shaped.** The clean
subagent boundaries already exist as strategy seams:

- `childRunLoop`'s `ChildRunStrategy<TTurn>` (`childRunLoop.ts:91`) unifies **all
  four** child-run types behind one driver (`startChildRunLoop`, `childRunLoop.ts:497`):
  agent-CLI codex, agent-CLI claude, native subagents (both categories), and
  workflow-script. The strategy seams — `launch` / `runTurn` /
  `resolveDeliveryTarget` / `buildResultMeta` — **are** the logical
  independent-agent units.
- Lineage lives on the handle, not side maps: `AgentExecutionHandle` carries
  `parentStreamId`/`childStreamId`/`deliveryTargetStreamId` +
  `isChildExecution`/`detach()` (`ExecutionHandle.ts:107-164`); `ExecutionRegistry`
  owns `getActiveChildren`/`interruptActiveChildren`/`detachActiveChildren`.
- Detach policy is single-sourced (`detachSubagentsOnStop.ts:17`, read live via
  `tryPlatform()`, shared by every host).
- Terminal choreography is exactly-once, single-owner (`finalizeRunTerminal`,
  atomic `claimTerminalFinalize`).

**The one tangle** is the same as finding #1: subagent _delivery formatting_
(`@tools/delegation/subagentResults`, `@tools/delegation/childRunDelivery`, `@tools/delegation/subagentDeliveryFormat`)
lives in `@tools` but is driven from `runtime/childRunLoop` and even `core/flows`. In
an SDK cut, "how a subagent's result is formatted and delivered to its parent" wants
to sit next to the runtime that drives it, or behind an injected port — not in the
`tools` layer that depends back on `runtime`.

## Model handler layer

Clean and well-factored; the only defect is finding #2 above.

- The 44-member `IModelHandler` port is **`Pick`-derived** from `ModelHandler`
  (`IModelHandler.ts:41-42`), so it can't drift from the class. No provider
  stubs/throws at the port level. Not a fat interface.
- The abstract base (`ModelHandler.ts`, ~2061 lines) does **real** shared work:
  credential/proxy resolution, input-token compaction, token-limit enforcement,
  stop-condition evaluation, and the SDK-error-tagging + retry wrapper around every
  response. 9 `abstract` members force providers to supply only genuinely
  provider-specific pieces.
- The OpenAI-compatible subclasses (DeepSeek/Kimi/GLM/MiniMax/XAI) each carry
  **real provider quirks** with cited rationale — not base-URL stubs (base URLs live
  in `llm-zoo` config). `ReasoningModelHandlerOpenAI` intermediate base is justified
  (4 concrete subclasses, 3 shared overrides). `ModelHandlerDashScope` (14 lines) is
  the only near-empty one — a single legitimate config flag.
- Per-provider `*Usage.ts`/`*SdkError.ts` are thin delegators to shared
  `support/UsageNormalizer` and `support/sdkErrorMetadata` — no duplicated logic.
- `ModelFactory` is a justified factory (exhaustive `Record<ModelProvider,…>` +
  one pure key predicate the live path switches on), not over-engineering.

## What is explicitly _not_ worth doing

- Don't resurrect the retired package-fence / `RunDescriptor` / `ModelCell` /
  `RetryGate` proposals — `main` chose the lighter path on purpose. The current
  `ModelCell` primitive is governed only by the
  [narrow ownership ruling][modelcell-ownership-ruling],
  which does not revive those proposals.
- Don't invent new abstractions or split the runtime directory — the flat
  `runtime/` layout is a documented, deliberate choice (~180 call sites import
  specific files; a directory split is mechanical churn, not a refactor).
- Don't demote the base-default `IModelHandler` members to an optional
  sub-interface — it would add feature-detection branching for no payoff.

## Recommended next steps (small, ordered)

1. ~~Delete the dead `ModelHandlerOpenAIReasoning` route~~ — **done** (finding #2).
2. ~~Align `AgentFinalResult` field names~~ — **withdrawn**, the rename is required
   by the persisted contract (finding #3). No action.
3. **Only if a real `@texra/core` cut is pursued:** invert the intra-`agent`
   dependency web (finding #1) — relocate/inject `RunContext`, `textConnection`, and
   the `@tools/delegation/subagentResults` formatting helper behind ports — and add an
   intra-`agent` edge ratchet. This is the gating item for extraction; nothing else
   here blocks it.

---

_Method: three parallel evidence-gathering passes (core+runtime, model handlers,
logger+surface), each required to back every claim with `file:line` and grep'd
caller counts, and to state areas found clean explicitly rather than invent
problems. Findings cross-checked against the retired PRDs and the current ratchet
baselines._
