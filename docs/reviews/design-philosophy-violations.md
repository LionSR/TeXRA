# Design Philosophy Violations Report

This document catalogs violations of PocketFlow philosophy and Ousterhout's software design principles found in the TeXRA codebase.

## Summary

| Category | Severity | Count | Primary Files |
|----------|----------|-------|---------------|
| Node Lifecycle (exec() mutations) | CRITICAL | 1 | MediaPreparationNode.ts |
| State Slice Exposure in Services | HIGH | 2 | CycleServices.ts, ToolUseServices.ts |
| Snapshot Pattern Complexity | MEDIUM | 1 | ReflectionFlowState.ts |
| Services Interface Size | MEDIUM | 1 | BaseFlowServices.ts |

---

## Critical Violations

### 1. exec() Mutates State via latexMediaManager

**File**: `src/agent/implementations/flows/reflection/nodes/MediaPreparationNode.ts:116-148`

**PocketFlow Principle Violated**: `exec()` should be compute-only with NO side effects on shared state.

**The Problem**:

```typescript
async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
  // ...
  if (prepRes.currentRound === 0) {
    await latexMediaManager.processInputFiles(
      prepRes.files,
      prepRes.workspaceState,  // ← PASSED FROM PREP
      config.toolConfig,
      true,
      prepRes.extraMediaFiles,
    );  // ← THIS MUTATES prepRes.workspaceState IN-PLACE
  }
  // ...
  const mediaFiles = prepRes.workspaceState.media.files;  // ← READS MUTATED STATE
  return { mediaFiles };
}
```

The node documents this violation explicitly (lines 9-10):
> `exec(): Extract media (mutates workspaceState via latexMediaManager)`

**Impact**:
- If `exec()` is retried (maxRetries > 1), mutations apply multiple times
- State leaks between lifecycle phases
- Violates separation of concerns

**Correct Pattern**:
```typescript
// prep() should extract files and pass as immutable data
// exec() should process and return new media list (no mutations)
// post() should update workspaceState with the returned media
```

---

## High Severity Violations

### 2. State Slices Exposed Directly via Services

**File**: `src/agent/core/flows/CycleServices.ts:72-87`

**Principle Violated**: Services should be immutable dependencies, not mutable state containers.

**The Problem**:

```typescript
export interface CycleStateSlices {
  /** Current round state for statistics (mutable for tool-use multi-round) */
  round: ConversationRoundState;
  readonly run: AgentRunState;
  readonly workspace: AgentWorkspaceState;
}
```

Nodes access and mutate state directly:
```typescript
// From various nodes:
services.round.incrementContinuation();
services.round.reset(nextRoundIndex);
```

**Impact**:
- Creates tight coupling between nodes and internal state structure
- Changes to state classes propagate to all nodes
- Violates encapsulation - nodes see internal implementation details

**Better Approach**: Expose operations on services, not raw state:
```typescript
interface CycleOperations {
  incrementContinuation(): void;
  resetRound(index: number): void;
  // ...
}
```

### 3. Information Leakage in ToolUseServices

**File**: `src/agent/implementations/flows/tooluse/ToolUseServices.ts:48-94`

**The Problem**: Services expose too many interdependent concerns:

```typescript
export interface ToolUseServices<C = unknown> extends BaseFlowContextInit<C> {
  readonly logger: AgentLogger;
  readonly context: AgentExecutionContext;
  readonly setting: AgentToolUseSetting;
  readonly toolRegistry: IToolRegistry;
  readonly session: IToolUseSession;
  readonly prepareState: () => Promise<PrepareStateResult>;
  readonly buildCycleOptions: (store: AgentSharedStore) => ToolUseCycleOptions<C>;
  readonly applyFollowUpMessage: (message: string, conversation: ProviderMessage[]) => Promise<ProviderMessage[]>;
  readonly getUsageRecorder: () => RoundFinalizedCallback;
}
```

Combined with `BaseFlowContextInit` (9 more fields), nodes receive 13+ service dependencies.

**Impact**:
- High cognitive load on developers
- Change amplification when modifying any field
- Difficult to understand which services a node actually needs

---

## Medium Severity Violations

### 4. Snapshot Pattern Creates Shallow Wrapper Module

**File**: `src/agent/implementations/flows/reflection/ReflectionFlowState.ts:160-344`

**Principle Violated**: Avoid shallow modules that just pass data through.

**The Problem**: 344 lines devoted to snapshot conversion helpers:

```typescript
export function getWorkspaceState(shared: ReflectionFlowShared): AgentWorkspaceState {
  return AgentWorkspaceState.fromSnapshot(shared.workspaceSnapshot);
}

export function updateWorkspaceSnapshot(
  shared: ReflectionFlowShared,
  workspaceState: AgentWorkspaceState,
): void {
  shared.workspaceSnapshot = workspaceState.toSnapshot();
}
// ... same pattern repeated for runState
```

The "reconstruct → mutate → update snapshot" pattern requires:
1. Documentation explaining when to use each helper
2. Developers must remember to call update functions or lose data
3. The pattern is error-prone - forgetting `updateWorkspaceSnapshot()` silently loses changes

**Evidence of brittleness** (MediaPreparationNode.ts:173-176):
```typescript
// CRITICAL: Save mutated workspace state back to snapshot
// The latexMediaManager mutated workspaceState in exec(), so we must
// update the snapshot to persist those changes
updateWorkspaceSnapshot(shared, prepRes.workspaceState);
```

**Impact**:
- Adds cognitive overhead (must understand serialization constraints)
- Brittle - forgetting to update loses state silently
- Module is mostly boilerplate rather than meaningful abstraction

### 5. Services Interface Change Amplification

**File**: `src/agent/implementations/flows/common/BaseFlowServices.ts:52-82`

**Principle Violated**: Avoid change amplification (from Ousterhout).

**The Problem**: `BaseFlowContextInit` combines 9 fields across multiple concerns:

```typescript
export interface BaseFlowContextInit<C = unknown> {
  modelHandler: IModelHandler<any, any, any, any, C>;
  config: AgentConfig;
  setting: AgentSetting;
  prompt: AgentPrompt;
  executionContext: AgentExecutionContext;
  userVarChannels: UserVariableChannels;
  checkInterruption: () => boolean;
  setAbortController: (ctrl: AbortController | null) => void;
  getClient: () => C;
  onInterrupt?: () => void;
}
```

Then `ReflectionServices` and `ToolUseServices` extend this, creating deep inheritance chains.

**Impact**:
- A small change to logging or configuration propagates through all service interfaces
- Difficult to add a new flow type without inheriting all 9+ base fields
- Testing requires mocking many unrelated dependencies

---

## Low Severity Issues

### 6. Imperative Array Mutations

**File**: `src/agent/implementations/flows/reflection/nodes/ResponseCycleCompositionNode.ts:323`

```typescript
shared.roundStateSnapshots.push(prepRes.context.stateRoundSnapshot);
```

While mutations in `post()` are allowed by PocketFlow, using imperative `.push()` instead of immutable patterns (`[...array, item]`) makes state changes harder to track.

### 7. Sub-flow Composition Passes State Through exec()

**File**: `src/agent/implementations/flows/reflection/nodes/ResponseCycleCompositionNode.ts:147-253`

The `exec()` method runs an entire sub-flow and passes state slices through:

```typescript
async exec(prepRes: CyclePrepInput): Promise<CycleExecResult> {
  // ...
  this.cycleFlow.setServices({
    ...cycleOptions,
    round: prepRes.round,
    run: prepRes.run,
    workspace: prepRes.workspace,
    // ...
  });
  await this.cycleFlow.run(cycleShared);
  // ...
}
```

The sub-flow mutates `prepRes.round`, `prepRes.run`, and `prepRes.workspace` in place. This works but stretches the PocketFlow model where `exec()` should be compute-only.

---

## Recommendations

1. **MediaPreparationNode**: Refactor to extract media in `prep()` as immutable data, process in `exec()` without mutations, and apply changes in `post()`.

2. **CycleStateSlices**: Replace direct state exposure with operation interfaces that encapsulate mutations.

3. **Snapshot pattern**: Consider a proxy or facade that auto-tracks changes, eliminating manual `updateXxxSnapshot()` calls.

4. **BaseFlowContextInit**: Split into smaller, composable interfaces (LoggingServices, InterruptionServices, ModelServices) that flows can pick selectively.

5. **Sub-flow composition**: Consider whether ResponseCycleFlow should be a true nested Flow (using PocketFlow's native nesting) rather than being invoked from `exec()`.
