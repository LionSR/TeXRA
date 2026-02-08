# Top 5 Abstraction Overheads in Agent Execution Lifecycle

Analysis of the largest sources of indirection, mixed concerns, dual logic, and
unnecessary re-packing in the agent execute → flow → PocketFlow call chain.

---

## 1. `resolveAndAcquireStream` + `resolveAgentBase` — Mixed Concerns & Dual Stream ID

**Files:** `src/agent/runtime/executeAgent.ts:81-258, 380-428`

The path from "user wants to run an agent" to "flow starts" passes through
5 nested resolution functions with entangled concerns and a dual stream-ID
computation that requires acquire → release → reacquire:

```
executeAgent()                             L492
 └─ resolveAndAcquireStream()              L380  ← Mixed: stream + resolution + error recovery
     ├─ computePreliminaryStreamId()       L81   ← FIRST stream ID (from registry category)
     │   └─ getAgent()                     L89   ← Registry lookup #1
     ├─ acquireStreamOrThrow()             L399  ← FIRST acquire
     ├─ resolveAgentBase()                 L142  ← 7+ concerns in 116 lines
     │   ├─ AgentConfigSchema.parse()      L150  ← Redundant with L496 guard
     │   ├─ getAgentPath()→resolveAgent()  L151  ← Registry lookup #2
     │   ├─ loadAgentSettingAndPrompts()   L154  ← YAML load + inheritance
     │   ├─ ensureAgentCategoryForSource() L160
     │   ├─ validateAndGetModelConfig()    L165  ← Late (after expensive work)
     │   ├─ getStreamTabId()               L179  ← SECOND stream ID (from YAML)
     │   ├─ bus.emit('setActiveStream')    L196  ← UI event in resolution fn
     │   ├─ buildUserVars()                L209
     │   └─ new UsageMonitor()             L233
     ├─ releaseIfInitializing()            L418  ← Release FIRST if IDs differ
     └─ acquireStreamOrThrow()             L420  ← SECOND acquire
```

### Problems

**(a) Dual stream ID computation.** `computePreliminaryStreamId` (L81-102) uses
`getAgent().category` from the registry. `resolveAgentBase` (L179-185) recomputes
using `setting.agentCategory` from loaded YAML, which can differ when YAML overrides
the category. When they differ, the code must release the first stream and acquire
a second — a fragile acquire→resolve→maybe-reacquire state machine.

**(b) `resolveAgentBase` has 7+ mixed concerns:** schema validation, agent resolution,
YAML loading, inheritance resolution, model validation with UI warning, stream ID
computation, event bus emission, logging setup, user variable building, and usage
monitor creation. These are separate responsibilities.

**(c) Redundant validation.** The `!model || !agent` guard fires at L496, L85-86,
and implicitly via `AgentConfigSchema.parse()` at L150. Model validation at L165
runs after expensive operations when it could fail fast.

### Refactoring

- Compute the stream ID **once** after full resolution. Eliminate
  `computePreliminaryStreamId` — acquire the stream after resolution, not before.
- Split `resolveAgentBase` into `resolveAgentConfig` (pure data: parse + load +
  validate) and `initializeAgentRuntime` (side effects: logging, events, monitors).
- Move model validation to the entry point for fail-fast behavior.

---

## 2. Cycle Service Re-packing — 15+ Fields Manually Reassembled Per Cycle

**Files:** `src/agent/implementations/flows/reflection/nodes/ResponseCycleNode.ts:156-180`,
`src/agent/implementations/flows/tooluse/nodes/ToolUseCycleNode.ts:82-108`

Both cycle nodes manually destructure their parent services and reassemble a new
flat service object for the inner cycle flow. This happens on **every cycle
invocation** (5-15× per agent run):

```typescript
// ResponseCycleNode L156-180: 11 of 16 fields are identity copies
const flowServices: ResponseCycleServices<C> = {
  modelHandler: this.services.modelHandler,
  setting: this.services.setting,
  prompt: this.services.prompt,
  logger: this.services.logger,
  streamId: this.services.streamId,
  executionId: this.services.executionId,
  userVarChannels: this.services.userVarChannels,
  checkInterruption: this.services.checkInterruption,
  setAbortController: this.services.setAbortController,
  config: this.services.config,
  fileService: this.services.fileService,
  client: clientRef.current,       // ← per-cycle
  round: prepRes.round,            // ← per-cycle
  run: prepRes.run,                // ← per-cycle
  workspace: prepRes.workspace,    // ← per-cycle
  onRoundFinalized,                // ← per-cycle
};
```

ToolUseCycleNode has the same pattern at L82-108 with 12 identity copies out of 17.

### Root cause

The flat `ResponseCycleServices`/`ToolUseCycleServices` design
(`CycleServices.ts:57-117`). The comment at L4-5 says *"Flattened design"* — but
this flattening forced upstream code to manually reassemble every field.

### Refactoring

Compose cycle services instead of flattening them:

```typescript
interface ResponseCycleServices<C> {
  readonly core: AgentCore<C>;           // Pass-through from parent
  readonly interrupt: InterruptHandlers;  // Pass-through from parent
  readonly cycle: CycleStateSlices;       // Per-cycle (round, run, workspace)
  readonly client: C;                     // Per-cycle
  readonly fileService: TaskRunFileService;
}
```

Reduces re-packing from 16 field assignments to ~4. Inner nodes access
`this.services.core.modelHandler` — a trivial change.

---

## 3. ResponseContinuationNode — Dual Stop-Condition Decisions + Mixed Concerns

**File:** `src/agent/core/flows/ResponseCycleFlow.ts:691-815`

This 125-line node makes **two separate calls** to the model handler with
overlapping inputs to answer the same question: should the cycle continue?

```typescript
// L733-740: Decision #1 — hard limits
const { endTurn: shouldEndTurn, shouldStop } =
  modelHandler.checkStopConditions(stopReason, processedResponse, round, run, setting);

// L742-746: Decision #2 — soft heuristics (3 of 5 args identical)
const shouldContinue = modelHandler.shouldContinue(stopReason, processedResponse, setting);
```

Then `post()` combines them with yet another condition:

```typescript
// L777-782: Decision #3 — token limit override
const reachedTokenLimit = isTokenLimitStopReason(prepRes.stopReason);
const willContinue = shouldContinue || reachedTokenLimit;
```

Three decisions on the same data, split across two model handler methods and
inline logic.

Beyond the dual decision, `post()` handles 4 additional concerns:
- Setting `shared.endTurn` / `shared.shouldStop` (state mutation)
- Incrementing `round.continuationCount` (counter management)
- Logging continuation messages
- Calling `addContinueMessageWithPrefill/WithoutPrefill` (message mutation, L799-810)

Additionally, the ResponseCycleFlow has **7 separate decision points** that set
`shouldStop = true` or return `COMPLETE` (across PrepNode, InvocationNode,
ProcessNode, ContinuationNode). ToolUseCycleFlow has 5. This fragmentation makes
it hard to trace when a cycle stops.

### Refactoring

Consolidate `checkStopConditions()` and `shouldContinue()` into a single
`determineCycleOutcome()` on the model handler returning a discriminated union:

```typescript
type CycleOutcome =
  | { action: 'end_turn' }
  | { action: 'stop'; reason: string }
  | { action: 'continue'; prefillMode: 'with' | 'without' };
```

Extract message mutation into a helper or separate node. This reduces the
3-decision chain to 1 and separates the 5 concerns in `post()`.

---

## 4. ResponseCycleNode vs ToolUseCycleNode — Asymmetric Nesting Patterns

**Files:** `ResponseCycleNode.ts:85-268` vs `ToolUseCycleNode.ts:31-175`

These two nodes do the same conceptual job — bridge outer flow ↔ inner cycle
flow — but use fundamentally different patterns:

| Aspect | ResponseCycleNode | ToolUseCycleNode |
|--------|-------------------|------------------|
| Inner shared state | Runs on outer `ReflectionFlowShared` directly (native nesting) | Creates separate `ToolUseCycleShared` (L65-78) |
| Initialization | `initializeCycleFields()` typed helper (L150) | Manual 13-field object literal (L65-78) |
| Result extraction | Reads directly from `shared` (L185) | Copies `cycleShared.messages` back (L161) |
| Object allocation | 0 per cycle | 1 per cycle (discarded after) |
| Finalization | Dedicated `ResponseCycleFinalizeNode` (L667-680), all exit paths | Inline in `ToolUseProcessNode.post()` (L531-540) |

### Problems

- **Maintenance risk:** Changing `BaseCycleFields` requires updating
  `initializeCycleFields()` in one place for Response, but hunting down the
  object literal in ToolUseCycleNode.
- **Finalization gap:** ToolUseCycleFlow embeds finalization (`recordCycleMetrics`
  + `onRoundFinalized`) inside `ToolUseProcessNode.post()` (L531-540) instead of
  a dedicated finalize node. If the cycle exits through a different path (e.g.,
  dispatch node interrupt at L631), finalization may not run.
- **Semantic confusion:** Two implementations of the same concept make it harder
  to learn and modify the codebase.

### Refactoring

Align ToolUseCycleNode to use native nesting like ResponseCycleNode:
- Add cycle fields to `ToolUseRunShared` (or extend with a mixin)
- Use a shared `initializeCycleFields()` helper
- Extract a `ToolUseCycleFinalizeNode` reachable from all exit paths

---

## 5. Triple Re-pack Chain: resolveAgentBase → createFlowContext → runFlow Input

**File:** `src/agent/runtime/executeAgent.ts:245-528`

Resolved agent data is packed into an object, spread into a new object, then
spread again into the flow function's input — three re-packs with no transformation:

```
Step 1: resolveAgentBase returns ResolvedAgentBase          (L245-257) → 11 fields
Step 2: createFlowContext({...ctx, ...interrupts, recorder}) (L435-440) → 14 fields
Step 3: Caller spreads:  {...flowContext, setting, ...}      (L513-518) → 16 fields
Step 4: runFlow spreads: {...input, outputState, ...}        (L365-378) → 23 fields
```

Concrete issues:

- **`createFlowContext` (L431-441) is trivial.** Spreads `ctx` unchanged, adds
  interrupt callbacks and a `getUsageRecorder` wrapper. Called 3× with the same
  pattern.
- **`runFlowWithLifecycle` (L285-320) has redundant params.** Takes `ctx`,
  `streamId`, `agentName` — but `streamId === ctx.streamId` and
  `agentName === ctx.config.agent`.
- **`prepareAgentUI` (L443-486) mixes 5 concerns:** filesystem (`ensureRunDir`),
  status service, logging, VS Code commands, event bus emission, config validation.

### Refactoring

- Make `resolveAgentBase` directly return a type that includes interrupt callbacks
  and the usage recorder. Eliminate `createFlowContext`.
- Remove redundant `streamId`/`agentName` params from `runFlowWithLifecycle`.
- Split `prepareAgentUI` concerns or inline trivial parts.
- Collapse the 4-step repack chain to 1-2 steps.

---

## Impact Summary

| # | Overhead | Primary Symptom | Key Files | Estimated Code Reduction |
|---|----------|----------------|-----------|-------------------------|
| 1 | Dual stream ID + mixed resolution | Acquire-release-reacquire state machine | `executeAgent.ts:81-428` | ~60 lines |
| 2 | Cycle service re-packing | 15+ identity field copies per cycle | `ResponseCycleNode.ts`, `ToolUseCycleNode.ts`, `CycleServices.ts` | ~50 lines × 2 |
| 3 | Dual stop-condition decisions | 3-part decision chain + 7 stop points | `ResponseCycleFlow.ts:691-815` | ~40 lines, cleaner model handler API |
| 4 | Asymmetric cycle nesting | Two patterns for one concept + finalization gap | `ToolUseCycleNode.ts`, `ToolUseCycleFlow.ts` | ~30 lines + correctness fix |
| 5 | Triple re-pack chain | Same 11 fields spread 3-4× | `executeAgent.ts:245-528` | ~40 lines + param cleanup |
