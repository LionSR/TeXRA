# Duplicate Logic Analysis: Agent/Node/PocketFlow System

This document details the findings from a comprehensive analysis of code duplication and abstraction overhead in the agent flow architecture.

## Executive Summary

- **Total duplicated/extractable code:** ~150-200 lines (~10% of cycle flows)
- **Reserved classes:** 57 lines (BatchNode variants - keep for future)
- **Primary overlap:** Invocation nodes (89% similar) - could share base class
- **Verified non-issues:** CycleStateSlices (different interfaces), FlowServiceAccessors (intentional)
- **Architectural inconsistency:** Native nesting vs separate state patterns

## 1. Reserved Classes (Keep for Future)

### Location: `src/agent/node/index.ts`

Four batch-related classes are exported but not currently used:

```typescript
// Lines ~214-302 - Reserved for future use
BatchNode<S, P, Svc>        // 12 lines
ParallelBatchNode<S, P, Svc> // 9 lines
BatchFlow<S, P, Svc>         // 19 lines
ParallelBatchFlow<S, P, Svc> // 17 lines
// Total: 57 lines
```

**Status:** Keep for future parallel execution patterns.

## 2. High-Overlap Duplication: Cycle Flows

### ResponseCycleFlow.ts vs ToolUseCycleFlow.ts

| Node Pair | Lines (Resp/Tool) | Overlap | Extractable |
|-----------|-------------------|---------|-------------|
| Prep Nodes | 61 / 40 | 55% | ~20 lines |
| Invocation Nodes | 95 / 82 | **89%** | ~75 lines |
| Process Nodes | 254 / 180 | 65% | ~90 lines |
| Continuation/Dispatch | 130 / 256 | 45% | ~40 lines |

### Invocation Node Pattern (89% overlap)

Both `ResponseModelInvocationNode` and `ToolUseCallNode` extend `RetryableInvocationNode` with nearly identical implementations:

```typescript
// Both follow this pattern:
async prep(shared): Promise<BaseInvocationPrepResult>
async exec(prepRes): Promise<InvocationResult<BaseInvocationSuccessData>>
async execFallback(_prepRes, error): Promise<InvocationResult>
async post(shared, _prepRes, execRes): Promise<string | undefined>
```

**Differences:**
- Response: Includes `systemPrompt`, sets streaming=false
- ToolUse: Includes `tools` parameter, sets streaming=true

**Recommendation:** Create `GenericRetryableInvocationNode` base class.

### Process Node Patterns (65% overlap)

Duplicated patterns:
- Thinking block extraction and logging
- Usage normalization with `modelHandler.normalizeUsage()`
- Response text preview logging
- Group ID capture for logging

**Recommendation:** Extract `extractCommonProcessingData()` helper.

## 3. Implementation Flow Overlap

### ReflectionFlow vs ToolUseRunFlow

| Aspect | Reflection | ToolUse | Overlap |
|--------|------------|---------|---------|
| Context factory | createReflectionFlowContext | createToolUseFlowContext | 70% |
| Cycle node | ResponseCycleNode | ToolUseCycleNode | **85%** |
| Prepare node | PrepareContextNode | ToolUsePrepareNode | 70% |
| Entry point | runReflectionFlow | runToolUseFlow | 80% |

### Architectural Inconsistency

**ReflectionFlow (preferred pattern):**
- Uses "native nesting" - cycle runs directly on parent shared state
- Uses `RoundPersistedFlow` for round management
- Located properly in `reflection/` directory

**ToolUseRunFlow (inconsistent pattern):**
- Uses "separate state" - creates separate `cycleShared` object
- Uses basic `PersistedFlow`
- Misplaced at parent level (`implementations/flows/ToolUseRunFlow.ts`)

**Recommendation:**
1. Move `ToolUseRunFlow.ts` into `tooluse/` directory
2. Adopt native nesting pattern for consistency

## 4. Services Pattern Analysis

### CycleStateSlices - NOT a Duplicate (Verified)

**Core definition (CycleServices.ts:59-83):**
```typescript
export interface BaseCycleStateSlices {
  readonly run: AgentRunState;
  readonly workspace: AgentWorkspaceState;
  readonly onRoundFinalized?: RoundFinalizedCallback;  // ← Has callback
}
export interface CycleStateSlices extends BaseCycleStateSlices {
  round: ConversationRoundState;
}
```

**Local definition (ResponseCycleNode.ts:63-67):**
```typescript
interface CycleStateSlices {  // Private (not exported)
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  // ← No onRoundFinalized callback
}
```

**Verdict:** These are **different interfaces** with the same name:
- Local one is a **private helper type** for `CyclePrepInput` (bundles 3 objects)
- Core one is the **services contract** (includes callback)
- Name collision is unfortunate but they serve different purposes

**Recommendation:** Rename local interface to `CyclePrepSlices` for clarity.

### FlowServiceAccessors - Intentional Convenience Layer

Creates shorter access paths:
```typescript
services.logger  // via FlowServiceAccessors shortcut
services.executionContext.logger  // original nested path
```

**Verdict:** This is an **intentional ergonomic choice**:
- Nodes frequently access logger/context
- The `buildBaseCycleOptions()` function handles both patterns via `??` fallback
- Not a redundancy issue, just API convenience

**Recommendation:** Keep as-is (minor stylistic preference).

## 5. Refactoring Plan

### Phase 1: Quick Wins (Immediate)

1. **Rename local CycleStateSlices** - Clarity improvement
   - Location: `src/agent/implementations/flows/reflection/nodes/ResponseCycleNode.ts:63-67`
   - Rename to `CyclePrepSlices` to avoid name collision with core type

2. **Move ToolUseRunFlow.ts** - Better structure
   - From: `src/agent/implementations/flows/ToolUseRunFlow.ts`
   - To: `src/agent/implementations/flows/tooluse/ToolUseRunFlow.ts`

### Phase 2: Extract Common Patterns

4. **Create GenericRetryableInvocationNode** - ~30-40 lines extracted
   ```typescript
   abstract class GenericRetryableInvocationNode<C, TOptions> {
     protected abstract getInvocationParams(prepRes): InvocationParams;
     protected abstract getPostDebugOptions(): DebugFileOptions;
     // Shared prep() and post() implementations
   }
   ```

5. **Create shared debug saving helper** - ~20-25 lines extracted
   ```typescript
   async function saveResponseDebugObject(response, services, options)
   ```

6. **Create thinking/usage extraction helper** - ~25-30 lines extracted
   ```typescript
   function extractCommonProcessingData(response, modelHandler, workspace, responseTimeMs)
   ```

### Phase 3: Architecture Alignment (Future)

7. Standardize on native nesting pattern for ToolUseFlow
8. Unify cycle options with discriminated union
9. Evaluate FlowServiceAccessors necessity

## 6. File References

### Core Files with Duplication
- `src/agent/core/flows/ResponseCycleFlow.ts` (975 lines)
- `src/agent/core/flows/ToolUseCycleFlow.ts` (1022 lines)
- `src/agent/core/flows/CycleServices.ts` (225 lines)

### Implementation Files with Overlap
- `src/agent/implementations/flows/ToolUseRunFlow.ts` (misplaced)
- `src/agent/implementations/flows/reflection/nodes/ResponseCycleNode.ts`
- `src/agent/implementations/flows/reflection/ReflectionServices.ts`
- `src/agent/implementations/flows/tooluse/ToolUseServices.ts`

### Node Base Classes
- `src/agent/node/index.ts` (311 lines, includes 57 dead)
- `src/agent/node/persisted-flow.ts` (228 lines)
- `src/agent/node/round-persisted-flow.ts` (407 lines)
- `src/agent/core/flows/RetryState.ts` (559 lines)

## 7. Why Invocation Nodes Duplicate (Root Cause)

Both `ResponseModelInvocationNode` and `ToolUseCallNode` call `modelHandler.createResponse()` but with different parameters:

| Parameter | ResponseModelInvocationNode | ToolUseCallNode |
|-----------|---------------------------|-----------------|
| streaming | `false` | `true` |
| systemPrompt | ✅ Passed | ❌ Not used |
| endTag | ✅ Passed | ❌ Not used |
| tools | Conditional on capabilities | Always required |
| logger stage | Wraps in stage | No stage |
| isBackgroundModeActive | Overrides | Uses default |

**The flows** (ResponseCycleFlow vs ToolUseCycleFlow) are correctly separate:
- ResponseCycle: Text generation → file output → continuations
- ToolUseCycle: Model call → tool extraction → tool dispatch

**The invocation nodes** should share a common base because:
- Both wrap `modelHandler.createResponse()` with identical retry/abort boilerplate
- Only 6 parameters differ between them
- Could parameterize: `{ streaming, systemPrompt?, endTag?, toolsMode, useStage }`

## 8. Summary Statistics

| Category | Lines | Notes |
|----------|-------|-------|
| Batch classes | 57 | Reserved for future (keep) |
| Invocation node overlap | 75-80 | 89% similarity - extractable |
| Process node overlap | 90-100 | 65% similarity |
| Prep node overlap | 20 | 55% similarity |
| Debug pattern duplication | 20-25 | 4 nodes |
| Services redundancy | 0 | Verified as intentional |
| **Total Extractable** | **~150-200** | ~10% of flows |
