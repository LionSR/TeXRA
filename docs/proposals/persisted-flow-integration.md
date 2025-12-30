# PersistedFlow Integration PRD

**Status**: Draft
**Author**: Claude (AI Assistant)
**Date**: 2024-12-30
**Related**: [koala-code-reader PersistedFlow](https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts)

## Executive Summary

Replace the current snapshot/resume system (ToolUseSnapshotStore, reflection hydration) with a unified PersistedFlow abstraction that persists execution state after each node. This enables graceful resume from any point, preserves thinking blocks across sessions, and eliminates accumulated complexity from organic growth.

## Problem Statement

### Current State Issues

1. **Fragmented Persistence**: ToolUseFlow and ReflectionFlow use different resume mechanisms
   - ToolUseSnapshotStore saves full session state on demand
   - ReflectionFlow "hydrates" completed rounds but loses intermediate state
   - Different code paths, different bugs, inconsistent behavior

2. **Lost Thinking Blocks**: On resume, `runReflectionFlow` creates fresh `AgentWorkspaceState.create()`, losing `ReasoningCacheState.thinkingBlocks` even though the infrastructure to serialize them exists (`toSnapshot()`/`fromSnapshot()`)

3. **State Spaghetti**: ~40% of ReflectionFlowState is ephemeral or derivable:
   - `lastLLMCallTokens` - recalculated each round
   - `contentBlockIndex` - reset each node execution
   - `currentRoundCompleted` - derivable from `rounds[currentRound].status`
   - `isComplete` - derivable from all rounds being COMPLETED

4. **Resume Detection Fragility**: RetryState.lastError isn't persisted, making crash-vs-deliberate-pause indistinguishable

### Why PersistedFlow

The koala-code-reader PersistedFlow pattern provides:
- **Automatic persistence** after each node (no manual save points)
- **Graph-based resume** - navigate to current position via action history, no re-execution
- **Clean separation** - services (runtime) vs state (persisted)
- **Minimal storage** - only store actions taken, not full outputs

## Design Principles

### 1. Services Never Persisted
Services are runtime dependencies injected via `setServices()`:
```typescript
// Runtime-only, never in FlowRecord
interface FlowServices {
  logger: AgentLogger;
  modelHandler: ModelHandler;
  toolRegistry: IToolRegistry;
  // etc.
}
```

### 2. State is Serializable and Minimal
Only persist what's needed to resume:
```typescript
interface PersistedState {
  messages: Message[];           // Full conversation (unit of persistence)
  workspaceState: {              // Serialized via toSnapshot()
    reasoning: ReasoningCacheState;  // Includes thinkingBlocks!
    scratchpad: ScratchpadState;
    // ServerToolContent is ephemeral - omitted
  };
  retryState: {
    consecutiveErrors: number;
    lastError: SerializedError | null;  // NEW: Enable resume detection
  };
}
```

### 3. Derive, Don't Persist
Remove from persistence (calculate on resume):
- `currentRound` - length of `nodes[]` in FlowRecord
- `contentBlockIndex` - reset each node
- `isComplete` - check if terminal node reached
- `lastLLMCallTokens` - ephemeral, recalculated

### 4. FlowRecord is the Single Source of Truth
```typescript
interface FlowRecord {
  flowName: 'reflection' | 'toolUse';
  params: Record<string, unknown>;  // Immutable flow config
  shared: PersistedState;           // Mutable state
  createdAt: string;
  nodes: NodeRecord[];              // Action history for resume navigation
}
```

## Architecture

### KVStore Adapter

Implement KVStore interface using existing StorageFS:

```typescript
// src/agent/node/FlowKVStore.ts
import { StorageFS } from '@utils/files';
import type { KVStore } from './persisted-flow';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

const FLOW_STORAGE_DIR = 'flows';

export function createFlowKVStore(executionId: ExecutionId): KVStore {
  const keyToPath = (key: string) =>
    `${FLOW_STORAGE_DIR}/${executionId}/${key}.json`;

  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {
        return await StorageFS.readJson<T>(keyToPath(key));
      } catch {
        return undefined;
      }
    },

    async write(key: string, value: any): Promise<void> {
      await StorageFS.ensureDir(`${FLOW_STORAGE_DIR}/${executionId}`);
      await StorageFS.writeJson(keyToPath(key), value);
    },

    async delete(key: string): Promise<void> {
      await StorageFS.delete(keyToPath(key));
    },

    async listKeys(prefix?: string): Promise<string[]> {
      const entries = await StorageFS.readDir(
        `${FLOW_STORAGE_DIR}/${executionId}`
      );
      return entries
        .filter(([name]) => !prefix || name.startsWith(prefix))
        .map(([name]) => name.replace(/\.json$/, ''));
    },
  };
}
```

### Integration Points

#### ReflectionFlow

```typescript
// Before (runReflectionFlow.ts)
shared = {
  state: createInitialReflectionState(totalRounds, AgentWorkspaceState.create()),
  retryState: createRetryState(),
  runStage,
};

// After
const kv = createFlowKVStore(executionId);
const persistedFlow = new PersistedFlow<ReflectionShared>(start, kv, executionId);
persistedFlow.setServices(services);

// Resume loads state from KV store automatically
await persistedFlow.run(initialShared);
```

#### ToolUseFlow

```typescript
// Before (ToolUseSnapshotStore - manual save/load)
await ToolUseSnapshotStore.save({ executionId, messages, store, ... });
const snapshot = await ToolUseSnapshotStore.load(executionId);

// After (automatic persistence per node)
const kv = createFlowKVStore(executionId);
const persistedFlow = await PersistedFlow.attach(kv, executionId, startNode);
persistedFlow.setServices(services);
await persistedFlow.run(shared);
```

### Thinking Block Preservation

Currently lost because fresh workspace created. Fix:

```typescript
// In PersistedFlow.step()
const flow = await this.kv.read<FlowRecord>(key);
const shared = flow.shared as PersistedState;

// workspaceState.reasoning.thinkingBlocks preserved automatically
// because we load from persisted state, not create fresh
```

### Retry Integration

```typescript
interface PersistedRetryState {
  consecutiveErrors: number;
  lastError: {
    message: string;
    code?: string;
    isRetryable: boolean;
  } | null;
}

// On resume, check lastError to determine:
// - null: clean pause (user interrupted)
// - non-null + isRetryable: crash, should retry
// - non-null + !isRetryable: fatal error, don't resume
```

## Migration Path

### Phase 1: Add PersistedFlow (no behavior change)
- [x] Copy `persisted-flow.ts` from koala-code-reader
- [x] Fix `setServices` bug
- [ ] Add `FlowKVStore` adapter
- [ ] Add tests for PersistedFlow with FlowKVStore

### Phase 2: Integrate with ReflectionFlow
- [ ] Create `ReflectionPersistedFlow` wrapper
- [ ] Migrate state to minimal persisted form
- [ ] Preserve thinking blocks via workspace state
- [ ] Add resume detection via persisted lastError
- [ ] Remove hydration code paths

### Phase 3: Integrate with ToolUseFlow
- [ ] Create `ToolUsePersistedFlow` wrapper
- [ ] Migrate from ToolUseSnapshotStore
- [ ] Unify resume behavior with ReflectionFlow
- [ ] Deprecate ToolUseSnapshotStore

### Phase 4: Cleanup
- [ ] Remove ToolUseSnapshotStore
- [ ] Remove reflection hydration code
- [ ] Remove ephemeral fields from state interfaces
- [ ] Update tests
- [ ] Update documentation

## State Audit Results

### Must Persist
| Field | Reason |
|-------|--------|
| `messages[]` | Full conversation history - unit of persistence |
| `workspaceState.reasoning` | Thinking blocks, reasoning cache |
| `workspaceState.scratchpad` | Cross-round context |
| `retryState.consecutiveErrors` | Error backoff |
| `retryState.lastError` | Resume detection (crash vs pause) |

### Can Derive (Don't Persist)
| Field | Derivation |
|-------|------------|
| `currentRound` | `nodes.length` in FlowRecord |
| `contentBlockIndex` | Reset to 0 each node |
| `isComplete` | Terminal node reached |
| `currentRoundCompleted` | `rounds[i].status === COMPLETED` |
| `lastLLMCallTokens` | Recalculated each call |

### Ephemeral (Never Persist)
| Field | Reason |
|-------|--------|
| `ServerToolContentState` | Active tool streams, must restart |
| `logger`, `modelHandler` | Runtime services |
| `abortSignal` | Request-scoped |

## Benefits

1. **Unified Resume**: Same mechanism for both flow types
2. **Thinking Preserved**: No more lost thinking blocks
3. **Automatic Persistence**: No manual save points to forget
4. **Clean Recovery**: Distinguish crash from pause via lastError
5. **Minimal Storage**: Only actions, not full outputs
6. **Testable**: KVStore interface enables in-memory testing
7. **Simpler State**: ~40% less state to manage

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Migration complexity | Phased approach, feature flags |
| Storage format changes | Version field in FlowRecord |
| structuredClone limits | Custom serializer for Maps/Sets if needed |
| Performance (JSON I/O per node) | Profile first; batch writes if needed |

## Open Questions

1. **Storage location**: Use existing `taskRuns/{id}/` or new `flows/{id}/`?
   - Recommendation: New `flows/` to avoid coupling with file artifacts

2. **TTL/cleanup**: How long to keep flow records?
   - Recommendation: Match `texra.toolUse.persistence.ttlHours` (default 24h)

3. **Concurrent flows**: Multiple flows per execution?
   - Recommendation: Single flow per execution, use sub-flows for nesting

## References

- [koala-code-reader PersistedFlow](https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts)
- [PocketFlow Documentation](../pocketflow/)
- [AgentWorkspaceState.toSnapshot()](../../src/agent/core/AgentWorkspaceState.ts)
- [ToolUseSnapshotStore](../../src/agent/toolUse/ToolUseSnapshotStore.ts)
