# Agent Overhead Analysis: Top 5 Refactoring Targets for Subagent/Parallel Support

## Summary

Analysis of abstraction overhead in the agent execution lifecycle, flow system, and
PocketFlow layer. Each item was audited against actual code to distinguish real
blockers from theoretical concerns.

**Key finding:** The inner cycle flows (ResponseCycleFlow, ToolUseCycleFlow) are
load-bearing (~80% logic-to-ceremony ratio) and should NOT be flattened. The real
blockers are infrastructure-level: flat registries, UI coupling, and mutable shared
state.

---

## #1 — Flat Interrupt + Stream Lock Registry (HARD BLOCKER)

**Files:**
- `src/agent/toolUse/ToolUseAgentRegistry.ts:34` — `Map<StreamTabId, IInterruptible>`
- `src/agent/runtime/StreamStatusService.ts:28-35` — `tryAcquire()` flag check
- `src/agent/runtime/RetryRequestCoordinator.ts` — keyed by streamId

**Problem:** One slot per `streamId`. A subagent on the same stream overwrites the
parent's interrupt handler. `StreamStatusService.tryAcquire()` rejects any second
execution on the same stream. `retryCoordinator` would resolve the wrong promise.

**Evidence:**
```typescript
// ToolUseAgentRegistry.ts:34,43 — single-slot Map
const registry = new Map<StreamTabId, IInterruptible>();
export function registerInterruptible(streamTabId, interruptible) {
  registry.set(streamTabId, interruptible); // overwrites previous
}
```

**Fix (~100 lines):**
- Replace flat Map with tree structure (parent/child relationships)
- Make `streamId` hierarchical: `streamId/sub1`
- Use `AbortSignal.any()` to link child abort signals to parent
- `InterruptCallbacks` closure pattern is already per-flow — just needs separate instances

---

## #2 — `executeAgent` UI Coupling Blocks Headless Execution (BLOCKER)

**File:** `src/agent/runtime/executeAgent.ts:381-493`

**Problem:** `executeAgent()` entangles three concerns:
1. Config resolution (`resolveAgentBase`, 117 lines)
2. UI lifecycle (progress view, notifications, stream status, event bus)
3. Flow dispatch (`runReflectionFlow` / `runToolUseFlow`)

A subagent needs (1) and (3) but not (2). Currently impossible to run a flow
without going through `acquireStreamOrThrow()` (line 393), showing progress views
(line 440-441), and emitting `setActiveStream` events (line 207).

**Evidence:**
```typescript
// executeAgent.ts:439-444 — UI side effects in execution path
if (!runStorage.isViewVisible()) {
  await vscode.commands.executeCommand('texra.showProgressView');
}
if (!runStorage.isViewVisible()) {
  showAgentNotification(config);
}
```

**Fix (~50 lines):**
Extract `runAgentFlow(agentCore, flowInput)` that takes an already-resolved
`AgentCore` and dispatches to the correct flow runner. `executeAgent` becomes a
thin wrapper that does UI + lock + calls `runAgentFlow`. Subagents call
`runAgentFlow` directly.

---

## #3 — Per-Node Persistence When Only Round-Boundary Resume Exists (WASTE)

**Files:**
- `src/agent/node/persisted-flow.ts:107-148` — `stepWithResult()` writes every step
- `src/agent/implementations/flows/reflection/runReflectionFlow.ts:291-303` — resume reads final state only

**Problem:** `PersistedFlow.stepWithResult()` performs `structuredClone() + fs write`
after every single node. But resume logic only uses the final persisted state and
replays from the graph start. `PersistedFlow.attach()` exists but is never called.

**Evidence — persistence every step:**
```typescript
// persisted-flow.ts:139-141
flow.nodes.push({ action });
flow.shared = this.serializeShared(shared);  // structuredClone()
await this.kv.write(key, flow);              // filesystem JSON write
```

**Evidence — resume ignores mid-round state:**
```typescript
// runReflectionFlow.ts:291-299
const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);
const validated = flowRecord?.shared
  ? ReflectionFlowStateSchema.safeParse(flowRecord.shared)
  : null;
if (validated?.success) {
  shared = validated.data;  // Uses final state, replays from start node
}
```

**Cost:** 3-round reflection flow = 18 structuredClone() + 18 fs writes.
Each write serializes full conversation history, workspace snapshots, round outputs.

**Fix (~20 lines):**
Add `persistEveryStep` option to `PersistedFlow` (default true for backward compat).
`RoundPersistedFlow` sets it to false and persists only at round transitions via
`setShared()` which it already calls. Subagent flows skip persistence entirely.

---

## #4 — Mutable `modelHandler` State (RACE CONDITION)

**File:** `src/agent/modelHandlers/ModelHandler.ts:148-200`

**Problem:** `modelHandler` has three mutators called during execution:
- `setOutputStreaming(false)` — called by ResponseCycleFlow (line 263)
- `setOutputStreaming(true)` — called by ToolUseCycleFlow (line 323)
- `setAgentCategory()` / `setLogger()` — called at init (lines 204-205)

If two concurrent agents share a `modelHandler` instance, streaming flags race.
Currently safe because only one agent runs per stream, but blocks parallel execution.

**Evidence:**
```typescript
// ModelHandler.ts:198-200
public setOutputStreaming(enabled: boolean): void {
  this.outputStreaming = enabled;  // mutable instance state
}
// ResponseCycleFlow.ts:263 — set false for workflow
services.modelHandler.setOutputStreaming(false);
// ToolUseCycleFlow.ts:323 — set true for tool-use
services.modelHandler.setOutputStreaming(true);
```

**Fix (~30 lines):**
Pass `outputStreaming` as a parameter to `createResponse()` instead of mutable state.
`agentCategory` can be set once at construction (already only set during init).

---

## #5 — Service Type Hierarchy Rigidity (DX FRICTION)

**Files:**
- `src/agent/implementations/flows/common/BaseFlowServices.ts` — `AgentCore`, `BaseFlowContextInit`
- `src/agent/implementations/flows/reflection/ReflectionServices.ts` — `ReflectionServices` (23 fields)
- `src/agent/implementations/flows/tooluse/ToolUseServices.ts` — `ToolUseServices`
- `src/agent/core/flows/CycleServices.ts` — `ResponseCycleServices`, `ToolUseCycleServices`

**Problem:** Adding a field for subagent coordination requires changes in 4 interface
files across 4 directories. The 4-layer spread chain
(`resolveAgentBase → flowContext → services → flowServices`) creates verbose
composition but the runtime cost is negligible.

**Evidence — 4-layer type hierarchy:**
```
AgentCore (8 fields)
  ↓ extends
BaseFlowContextInit (+4 interrupt fields)
  ↓ extends
ReflectionServices (+11 workflow fields = 23 total)
  ↓ composed into
ResponseCycleServices (CycleStateSlices & ResponseCycleOptions)
```

**Assessment:** This is a developer experience problem, not a runtime problem. Object
spread is <1ms. The hierarchy is idiomatic TypeScript. Low priority for refactoring —
address only if subagent coordination needs a new cross-cutting field.

---

## What Was Dropped from Original Analysis

### Double Flow Orchestration — NOT OVERHEAD

The inner cycle flows (ResponseCycleFlow, ToolUseCycleFlow) were audited and found
load-bearing:

- **ResponseCycleFlow:** 620 lines of actual logic. The continuation loop
  (token limit → add continuation prompt → re-invoke model) is essential.
- **ToolUseCycleFlow:** 775 lines of actual logic. ToolUseDispatchNode alone is
  358 lines of tool execution logic.
- **RetryableInvocationNode:** Handles proactive JWT refresh, reactive 401 retry,
  abort controller lifecycle — inherent complexity.

Flattening these into the outer flow would create a 1000+ line monolithic graph.
The nested flow structure provides clear error boundaries and separation of concerns.

**Minor optimization:** Cache the inner flow graph instance across rounds (the graph
shape is static, all state is in `shared`). Saves 5 node instantiations per round.

---

## Minimal Path to Subagent Support (~250 lines total)

```
Step 1: Hierarchical interrupt registry         (~100 lines)
  - Unblocks everything else
  - Tree-based Map, parent/child propagation

Step 2: Extract headless agent runner           (~50 lines)
  - runAgentFlow(core, flowInput) — no UI/lock
  - executeAgent becomes thin wrapper

Step 3: Immutable modelHandler                  (~30 lines)
  - outputStreaming as createResponse() param
  - Enables safe sharing across concurrent agents

Step 4: Round-boundary persistence              (~20 lines)
  - persistEveryStep option on PersistedFlow
  - Subagent flows skip persistence entirely
```
