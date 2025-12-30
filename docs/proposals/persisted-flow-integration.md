# PersistedFlow Integration PRD

**Status**: Draft v2
**Author**: Claude (AI Assistant)
**Date**: 2024-12-30
**Related**: [koala-code-reader PersistedFlow](https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts)

## Executive Summary

Replace the current snapshot/resume system (ToolUseSnapshotStore, reflection hydration) with a unified PersistedFlow abstraction that persists execution state after each node. This enables graceful resume from any point, preserves thinking blocks across sessions, and eliminates ~1000+ lines of accumulated complexity.

## Problem Statement

### Current State Issues

1. **Fragmented Persistence**: ToolUseFlow and ReflectionFlow use different resume mechanisms
   - ToolUseSnapshotStore saves full session state on demand
   - ReflectionFlow "hydrates" completed rounds but loses intermediate state
   - Different code paths, different bugs, inconsistent behavior

2. **Lost Thinking Blocks**: On resume, `runReflectionFlow` creates fresh `AgentWorkspaceState.create()`, losing `ReasoningCacheState.thinkingBlocks` even though the infrastructure to serialize them exists (`toSnapshot()`/`fromSnapshot()`)

3. **State Spaghetti**: ~40% of ReflectionFlowState is ephemeral or derivable:
   - `currentRound` - derivable from `nodes.length`
   - `roundStates[]` / `roundOutputs[]` - duplicates `nodes[]` history
   - `continueRounds` / `endTurn` - derivable from terminal node detection
   - `lastLLMCallTokens` - recalculated each round
   - `contentBlockIndex` - reset each node execution

4. **Resume Detection Fragility**: RetryState.lastError isn't persisted, making crash-vs-deliberate-pause indistinguishable

### Why PersistedFlow

The koala-code-reader PersistedFlow pattern provides:

- **Automatic persistence** after each node (no manual save points)
- **Graph-based resume** - navigate to current position via action history, no re-execution
- **Clean separation** - services (runtime) vs state (persisted)
- **Minimal storage** - only store actions taken, not full outputs

## Design Principles

### 1. ExecutionKVStore as First-Citizen Interface

All execution-scoped storage goes through a unified interface:

```typescript
/**
 * Execution-scoped key-value store. All keys automatically namespaced to execution.
 * No executionId threading - callers work within single execution context.
 */
export interface ExecutionKVStore {
  // Core operations
  read<T = any>(key: string): Promise<T | undefined>;
  write<T = any>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;

  // Enumeration
  listKeys(prefix?: string): Promise<string[]>;

  // Bulk operations
  clear(): Promise<void>;

  // Binary support (for artifacts)
  readBytes(key: string): Promise<Buffer | undefined>;
  writeBytes(key: string, data: Buffer): Promise<void>;

  // Context
  getExecutionId(): ExecutionId;
}

/**
 * Factory for execution-scoped stores. Manages lifecycle and cleanup.
 */
export interface ExecutionStorageRegistry {
  getStore(executionId: ExecutionId): ExecutionKVStore;
  deleteExecution(executionId: ExecutionId): Promise<void>;
  listExecutions(): Promise<ExecutionId[]>;
  cleanupExpired(maxAgeMs: number): Promise<ExecutionId[]>;
}
```

### 2. Services Never Persisted

Services are runtime dependencies injected via `setServices()`:

```typescript
// Runtime-only, never in FlowRecord
interface FlowServices {
  logger: AgentLogger;
  modelHandler: ModelHandler;
  toolRegistry: IToolRegistry;
  runStage: AgentLogStage; // UI logging state
}
```

### 3. State is Serializable and Minimal

Only persist what's needed to resume:

```typescript
interface PersistedState {
  messages: Message[]; // Full conversation (unit of persistence)
  workspaceSnapshot: {
    // AgentWorkspaceState.toSnapshot()
    assembly: ResponseAssemblySnapshot;
    media: { files: FileLocation[] };
    reasoning: ReasoningCacheSnapshot; // PRESERVES thinkingBlocks!
    document: { texcountStats: string | null };
    interactions: { readFiles: string[]; edits: EditEntry[] };
    todos: { todos: TodoItem[] };
    // serverToolContent: OMITTED - ephemeral
  };
  retryState: {
    consecutiveErrors: number;
    lastError: SerializedError | null; // Enable resume detection
    lastAttemptedAt?: string;
  };
}
```

### 4. Derive, Don't Persist

Remove from persistence (calculate on resume):

| Field                        | Derivation                      |
| ---------------------------- | ------------------------------- |
| `currentRound`               | `nodes.length` in FlowRecord    |
| `roundStates[]`              | Computed from `nodes[]` history |
| `roundOutputs[]`             | Computed from `nodes[]` history |
| `contentBlockIndex`          | Reset to 0 each node            |
| `isComplete`                 | Terminal node reached           |
| `continueRounds` / `endTurn` | Check last node action          |
| `lastLLMCallTokens`          | Recalculated each call          |

### 5. FlowRecord is Single Source of Truth

```typescript
interface FlowRecord {
  flowName: 'reflection' | 'toolUse';
  params: Record<string, unknown>; // Immutable flow config
  shared: PersistedState; // Mutable state (snapshot format)
  createdAt: string;
  nodes: NodeRecord[]; // Action history for resume navigation
}
```

## Architecture

### Three-Tier Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Consumers (PersistedFlow, TaskRunFileService replacement)  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  ExecutionKVStore                                           │
│  - Automatic execution scoping                              │
│  - Type-safe, no executionId threading                      │
│  - Key transformation: "flow" → "executions/{id}/flow.json" │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  ExecutionStorageRegistry                                   │
│  - Store factory and cache                                  │
│  - Multi-execution queries                                  │
│  - TTL-based cleanup                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  StorageFS (unchanged)                                      │
│  - VS Code-backed filesystem                                │
│  - Low-level read/write/delete                              │
└─────────────────────────────────────────────────────────────┘
```

### Storage Directory Structure

```
$STORAGE_ROOT/
├── taskRuns/                    # Legacy - deprecated
├── toolUseSessions/             # Legacy - deprecated
└── executions/                  # NEW unified structure
    └── {executionId}/
        ├── .metadata.json       # Execution metadata (createdAt, ttl)
        ├── flow.json            # PersistedFlow state (FlowRecord)
        └── artifacts/           # Optional: file outputs
```

### Retry System Integration

PersistedFlow **does NOT handle retries itself**. Separation of concerns:

```
┌─ PersistedFlow (handles persistence & resume navigation)
│  ├─ Persists state AFTER successful node execution
│  ├─ On error: throws, persists retry state, waits for external retry
│  └─ On resume: navigates via action history, never re-executes
│
├─ Node (handles auto-retry via retry loop)
│  ├─ Auto-retry: exponential backoff, configurable attempts
│  ├─ Manual retry: retryPrompt hook for UI
│  └─ Fallback: execFallback() on exhaustion
│
└─ FlowRecord (single source of truth)
   └─ Includes PersistedRetryState for resume decisions
```

**Resume detection logic**:

```typescript
function decideRetryOnResume(
  persisted: PersistedRetryState | undefined,
): RetryDecision {
  if (!persisted?.lastError) {
    return { shouldRetry: false, reason: 'clean-pause' };
  }
  if (!persisted.lastError.isRetryable) {
    return { shouldRetry: false, reason: 'fatal-error' };
  }
  if (persisted.consecutiveErrors >= 3) {
    return { shouldRetry: false, reason: 'error-limit-exceeded' };
  }
  return { shouldRetry: true, reason: 'retryable-error' };
}
```

### AgentWorkspaceState Serialization

**Serializable components** (via existing `toSnapshot()`/`fromSnapshot()`):

- `assembly` - ResponseAssemblyState
- `media` - MediaAttachmentState (converts Set to array)
- `reasoning` - ReasoningCacheState (**preserves thinkingBlocks!**)
- `document` - DocumentStatsState
- `interactions` - FileInteractionState (converts Map/Set to arrays)
- `todos` - TodoState

**Ephemeral (never persist)**:

- `serverToolContent` - ServerToolContentState (active tool streams, must restart)

**structuredClone() safety**: PersistedFlow uses `structuredClone()`. Must persist **snapshot format** (plain JSON), not class instances with Map/Set.

### Thinking Block Preservation

Current problem at `runReflectionFlow.ts:167`:

```typescript
// Current: Thinking blocks LOST!
shared = {
  state: createInitialReflectionState(
    flowContext.totalRounds,
    AgentWorkspaceState.create(), // ← Fresh instance
  ),
  // ...
};
```

After PersistedFlow integration:

```typescript
// New: Thinking blocks preserved via snapshot
const kv = registry.getStore(executionId);
const flowRecord = await kv.read<FlowRecord>('flow');

let workspaceSnapshot = AgentWorkspaceSnapshot.create();
if (flowRecord?.shared?.workspaceSnapshot) {
  workspaceSnapshot = flowRecord.shared.workspaceSnapshot; // ← Preserved!
}

const shared = {
  state: createInitialReflectionState(
    flowContext.totalRounds,
    AgentWorkspaceState.fromSnapshot(workspaceSnapshot),
  ),
  // ...
};
```

## Testing Strategy

### In-Memory KVStore for Unit Tests

```typescript
class InMemoryKVStore implements ExecutionKVStore {
  private store = new Map<string, any>();
  private executionId: ExecutionId;

  constructor(executionId: ExecutionId) {
    this.executionId = executionId;
  }

  async read<T = any>(key: string): Promise<T | undefined> {
    return structuredClone(this.store.get(key)) as T;
  }

  async write(key: string, value: any): Promise<void> {
    this.store.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    return Array.from(this.store.keys()).filter(
      (k) => !prefix || k.startsWith(prefix),
    );
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  getExecutionId(): ExecutionId {
    return this.executionId;
  }
}
```

**Testing approach**:

- Unit tests: InMemoryKVStore (no VS Code dependencies)
- Integration tests: Temp directory with real file I/O
- No mocking at VS Code layer - mock at ExecutionKVStore interface

## Migration Path

### Phase 1: Foundation (No Behavior Change) ✅ COMPLETE

- [x] Copy `persisted-flow.ts` from koala-code-reader
- [x] Fix `setServices` bug
- [x] Create `ExecutionKVStore` interface (`src/agent/storage/ExecutionKVStore.ts`)
- [x] Create `ExecutionStorageRegistry` implementation
- [x] Add `InMemoryKVStore` for testing (pure Node.js, no VS Code deps)
- [x] Update PersistedFlow to use `FlowStore` (union of KVStore | ExecutionKVStore)
- [ ] Write tests for PersistedFlow with InMemoryKVStore (VS Code test limitations)

### Phase 2: Integrate with ReflectionFlow

- [ ] Create `ReflectionPersistedFlow` wrapper
- [ ] Persist workspace snapshot (preserves thinking blocks)
- [ ] Add retry state to FlowRecord.shared
- [ ] Remove duplicated state (currentRound, roundStates, etc.)
- [ ] Remove hydration code paths

### Phase 3: Integrate with ToolUseFlow

- [ ] Create `ToolUsePersistedFlow` wrapper
- [ ] Migrate from ToolUseSnapshotStore
- [ ] Unify resume behavior with ReflectionFlow
- [ ] Remove ToolUseSessionPersistence

### Phase 4: Cleanup (~1000+ lines)

- [ ] Remove `ToolUseSnapshotStore.ts`
- [ ] Remove `ToolUseSessionPersistence.ts`
- [ ] Remove `ToolUseSessionManager.ts` snapshot code
- [ ] Remove `toSnapshot()`/`fromSnapshot()` from deprecated stores
- [ ] Remove hydration code from model handlers
- [ ] Remove ephemeral fields from state interfaces
- [ ] Update tests
- [ ] Update documentation

## Dead Code Inventory

Code that becomes unnecessary with PersistedFlow:

### Tool-Use Snapshot System (Remove Entirely)

| File                                       | Lines | Reason                       |
| ------------------------------------------ | ----- | ---------------------------- |
| `ToolUseSnapshotStore.ts`                  | ~200  | Replaced by ExecutionKVStore |
| `ToolUseSessionPersistence.ts`             | ~150  | Replaced by PersistedFlow    |
| `ToolUseSessionManager.ts` (snapshot code) | ~70   | Replaced by FlowRecord       |

### Snapshot Serialization (Simplify)

| File                                            | Lines | Reason                              |
| ----------------------------------------------- | ----- | ----------------------------------- |
| `AgentSharedStore.ts` (fromSnapshot/toSnapshot) | ~50   | Use FlowRecord.shared directly      |
| `AgentState.ts` (fromSnapshot/toSnapshot)       | ~50   | Derive from nodes[]                 |
| `AgentWorkspaceState.ts`                        | Keep  | Still needed for workspace snapshot |

### Round Replay Logic (Remove)

| File                                                           | Lines     | Reason                       |
| -------------------------------------------------------------- | --------- | ---------------------------- |
| `ReflectionFlowState.ts` (replay comments)                     | ~30       | PersistedFlow handles resume |
| `ResponseCycleCompositionNode.ts` (initializeOutputAndPrefill) | ~50       | No more hydration            |
| Model handlers (initializeOutputAndPrefill)                    | ~100/each | No more prefill              |

**Total**: ~1000+ lines can be removed or simplified

## State Audit Summary

### Must Persist

| Field                         | Reason                                          |
| ----------------------------- | ----------------------------------------------- |
| `messages[]`                  | Full conversation history - unit of persistence |
| `workspaceSnapshot.reasoning` | Thinking blocks preservation                    |
| `workspaceSnapshot.assembly`  | Model outputs for UI                            |
| `workspaceSnapshot.*` (other) | Cross-round context                             |
| `retryState.lastError`        | Resume detection (crash vs pause)               |

### Can Derive (Don't Persist)

| Field               | Derivation              |
| ------------------- | ----------------------- |
| `currentRound`      | `nodes.length`          |
| `roundStates[]`     | Computed from `nodes[]` |
| `roundOutputs[]`    | Computed from `nodes[]` |
| `roundIndex`        | Position in `nodes[]`   |
| `continueRounds`    | Terminal node detection |
| `endTurn`           | Last node action        |
| `contentBlockIndex` | Reset to 0 each node    |
| `isComplete`        | Terminal node reached   |
| `lastLLMCallTokens` | Recalculated each call  |

### Ephemeral (Never Persist)

| Field                    | Reason                            |
| ------------------------ | --------------------------------- |
| `serverToolContent`      | Active tool streams, must restart |
| `logger`, `modelHandler` | Runtime services                  |
| `runStage`, `roundStage` | UI logging state                  |
| `abortSignal`            | Request-scoped                    |

## Benefits

1. **Unified Resume**: Same mechanism for both flow types
2. **Thinking Preserved**: No more lost thinking blocks
3. **Automatic Persistence**: No manual save points to forget
4. **Clean Recovery**: Distinguish crash from pause via lastError
5. **Minimal Storage**: Only actions, not full outputs
6. **Testable**: InMemoryKVStore enables pure Node.js tests
7. **Simpler State**: ~40% less state to manage
8. **Less Code**: ~1000+ lines removed

## Risks & Mitigations

| Risk                            | Mitigation                                          |
| ------------------------------- | --------------------------------------------------- |
| Migration complexity            | Phased approach, feature flags                      |
| Storage format changes          | Version field in FlowRecord                         |
| structuredClone limits          | Persist snapshots (plain JSON), not class instances |
| Performance (JSON I/O per node) | Profile first; batch writes if needed               |

## Open Questions (Resolved)

1. **Storage location**: Use `executions/{id}/` (new unified structure)
2. **TTL/cleanup**: Match `texra.toolUse.persistence.ttlHours` (default 24h)
3. **Concurrent flows**: Single flow per execution, use sub-flows for nesting
4. **KVStore first-citizen**: Yes - ExecutionKVStore with automatic scoping

## Progress Log

### 2024-12-30: Phase 1 Complete

**Completed:**

- ✅ `ExecutionKVStore` interface created (`src/agent/storage/ExecutionKVStore.ts`)
- ✅ `ExecutionStorageRegistry` implementation
- ✅ `StorageFSKVStore` - VS Code storage backend
- ✅ `InMemoryKVStore` - pure Node.js testing backend
- ✅ `InMemoryRegistry` - test registry
- ✅ PersistedFlow updated to use `FlowStore` (union type for backward compat)
- ✅ Fixed dead code in `modelHandlerGoogleGenAI.ts` (placeholder params)

**Analysis completed via subagents:**

1. **Dead code audit**: 2 no-op methods fixed, unused params documented
2. **ReflectionFlow integration plan**: Detailed code changes for `runReflectionFlow.ts`
3. **Hydration code inventory**: ~1000+ lines identified for removal in phases
4. **Test strategy**: InMemoryKVStore fully testable without VS Code

**Key insight**: Existing test patterns (ReadTool, BashTool) show how to mock VS Code deps. InMemoryKVStore designed specifically for testing with zero VS Code dependencies.

**Next steps (COMPLETED - see Phase 1.5 below):**

- ~~Write tests for InMemoryKVStore (easy - no VS Code deps)~~ ✅
- ~~Integrate PersistedFlow with ReflectionFlow (preserve thinking blocks)~~ ✅
- Begin Phase 2 hydration code removal

### 2024-12-30: Phase 1.5 Complete (Session 2)

**Completed:**

- ✅ PersistedFlow integrated with ReflectionFlow (`runReflectionFlow.ts`)
  - Automatic state persistence after each node via PersistedFlow
  - Workspace state restoration from persisted snapshot on resume
  - **PRESERVES THINKING BLOCKS** across resume via `AgentWorkspaceState.fromSnapshot()`
- ✅ Added index signature to `ReflectionFlowShared` for `Record<string, unknown>` compatibility
- ✅ Exported `FlowRecord` interface from persisted-flow.ts
- ✅ InMemoryKVStore tests written (`src/test/agent/storage/InMemoryKVStore.test.ts`)
  - 71 comprehensive test cases covering all methods
  - Pure Node.js - NO VS Code dependencies
  - Covers: read, write, delete, exists, listKeys, clear, getExecutionId
  - Edge cases: non-existent keys, null values, deep cloning, prefix filtering

**Hydration Code Analysis (ready for Phase 2 removal):**

Files to completely remove (~597 lines):
1. `src/agent/toolUse/ToolUseSnapshotStore.ts` (207 lines)
2. `src/agent/toolUse/ToolUseSessionPersistence.ts` (245 lines)
3. `src/agent/toolUse/ToolUseSessionManager.ts` (145 lines)

Files requiring updates:
- `src/extension.ts` - Remove snapshot initialization (lines 206-213, 351)
- `src/agent/implementations/flows/ToolUseRunFlow.ts` - Replace snapshot calls
- `src/commands/agent/resumeCommand.ts` - Use PersistedFlow.attach()
- `src/agent/toolUse/ToolUseFollowUp.ts` - Remove snapshot-based resume

**Next steps:**

- Phase 2: Remove ToolUse hydration code (ToolUseSnapshotStore, ToolUseSessionPersistence)
- Phase 3: Integrate PersistedFlow with ToolUseFlow (similar to ReflectionFlow)
- Phase 4: Simplify AgentSharedStore.toSnapshot() usage

## References

- [koala-code-reader PersistedFlow](https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts)
- [PocketFlow Documentation](../pocketflow/)
- [AgentWorkspaceState.toSnapshot()](../../src/agent/core/AgentWorkspaceState.ts)
- [ToolUseSnapshotStore](../../src/agent/toolUse/ToolUseSnapshotStore.ts)
