# Agent State Consolidation Proposal

## Problem Statement

The current agent architecture has accumulated complexity that makes changes error-prone and maintenance difficult:

1. **Snapshot pattern overhead**: 35-40 serialize/deserialize operations per round
2. **State fragmentation**: 25+ state types with unclear ownership boundaries
3. **Inconsistent patterns**: ToolUseFlow bypasses RoundPersistedFlow
4. **Unnecessary abstractions**: Classes that only delegate to underlying data

## Proposed Solution: Single State Object with Lazy Serialization

### Core Concept

Replace the current snapshot-based pattern with a **single unified state object** that:
- Uses class instances directly (no snapshot reconstruction)
- Serializes only at persistence boundaries (round end, error recovery)
- Has clear ownership for each piece of state

### New State Architecture

```typescript
/**
 * Unified agent state - SINGLE SOURCE OF TRUTH
 *
 * No snapshots, no reconstruction, no manual sync.
 * Serialization happens only at persistence boundaries.
 */
export interface UnifiedAgentState {
  // Round management (owned by RoundPersistedFlow)
  currentRound: number;
  totalRounds: number;
  continueRounds: boolean;

  // Conversation (owned by flow, mutated by cycles)
  conversation: ProviderMessage[];

  // Per-round context (reset each round)
  roundContext: {
    messages: ProviderMessage[];
    prefill: string;
  } | null;

  // Accumulated state (persists across rounds)
  usage: RunUsageAccumulator;

  // Workspace (reset each round for workflow, persists for interactive)
  workspace: {
    assembly: ResponseAssemblyState;      // Plain object
    media: MediaAttachmentState;          // Class instance
    interactions: FileInteractionState;   // Class instance
    todos: TodoState;                     // Class instance
    reasoning: ReasoningCacheState;       // Plain object
    serverToolContent: ServerToolContentState; // Ephemeral, never serialized
  };

  // Output tracking
  roundOutputs: RoundOutput[];
  outputLocation: FileLocation | null;

  // Control
  endTurn: boolean;
  lastError?: RetryErrorInfo;
}
```

### Serialization Strategy

```typescript
/**
 * Serialize only at boundaries, not per-step.
 */
interface PersistenceConfig {
  // When to serialize
  boundary: 'round' | 'step';  // 'round' for new pattern, 'step' for legacy

  // Custom serialization for class instances
  serialize: (state: UnifiedAgentState) => SerializedState;
  deserialize: (data: SerializedState) => UnifiedAgentState;
}

// Implementation in RoundPersistedFlow
class RoundPersistedFlow {
  async handleContinueToNextRound(shared: UnifiedAgentState) {
    // Only serialize here - not after every node
    await this.persist(shared);

    // Increment round (single source of truth)
    shared.currentRound += 1;

    // Reset workspace for new round
    this.resetWorkspace(shared);
  }
}
```

### What Gets Eliminated

| Component | Lines | Why Eliminated |
|-----------|-------|----------------|
| `AgentSharedStore` class | 150 | Pure delegation, replaced by direct object |
| `getWorkspaceState()` helper | 20 | No snapshots = no reconstruction needed |
| `updateWorkspaceSnapshot()` helper | 20 | No snapshots = no manual sync needed |
| `getRunState()` / `updateRunState()` | 40 | Same reason |
| `*Snapshot` type definitions | 100 | No snapshots |
| `toSnapshot()` methods | 80 | No snapshots |
| `fromSnapshot()` methods | 80 | No snapshots |
| Per-step `structuredClone()` | N/A | Lazy serialization |
| `MapToolRegistry` class | 30 | Use `Map<string, ITool>` directly |
| `buildBaseFlowServices()` | 15 | Inline at call sites |
| `buildBaseCycleOptions()` | 25 | Use consistent field names |
| **TOTAL** | **~560** | |

### What Gets Simplified

| Component | Current | Proposed |
|-----------|---------|----------|
| State types | 25+ | 1 unified + 5 nested |
| Serialize ops/round | 35-40 | 1-2 |
| Sync points | 6 manual | 0 automatic |
| Wrapper classes | 4 | 0 |
| Builder functions | 3 | 0 |

---

## Implementation Plan

### Phase 1: Lazy Serialization (Week 1)

**Goal**: Stop per-step serialization without changing state structure.

**Changes**:
1. Add `serializationBoundary` option to PersistedFlow
2. Implement `'round'` mode that only serializes in `handleContinueToNextRound()`
3. Update RoundPersistedFlow to use `'round'` mode

**Files**:
- `src/agent/node/persisted-flow.ts`
- `src/agent/node/round-persisted-flow.ts`

**Tests**: Run full test suite, verify resumability still works.

### Phase 2: Direct State Access (Week 2)

**Goal**: Nodes access class instances directly, no reconstruction.

**Changes**:
1. Change `ReflectionFlowState` to use class instances
2. Remove `getWorkspaceState()`, `updateWorkspaceSnapshot()` helpers
3. Update all nodes to access `shared.workspace` directly

**Files**:
- `src/agent/implementations/flows/reflection/ReflectionFlowState.ts`
- All nodes in `src/agent/implementations/flows/reflection/nodes/`

**Tests**: Integration tests for each node, full flow tests.

### Phase 3: Unify Round Management (Week 2)

**Goal**: ToolUseFlow uses same round pattern as ReflectionFlow.

**Changes**:
1. Wrap ToolUseCycleFlow in RoundPersistedFlow
2. Remove manual `round.reset()` and `run.incrementRounds()` from nodes
3. Use same lifecycle hooks

**Files**:
- `src/agent/implementations/flows/tooluse/runToolUseFlow.ts`
- `src/agent/core/flows/ToolUseCycleFlow.ts`

### Phase 4: Remove Abstractions (Week 3)

**Goal**: Eliminate pure delegation patterns.

**Changes**:
1. Replace `AgentSharedStore` class with type alias
2. Replace `MapToolRegistry` with `Map<string, ITool>`
3. Inline builder functions at call sites
4. Remove single-implementation interfaces

**Files**:
- `src/agent/core/AgentSharedStore.ts`
- `src/agent/core/ToolTypes.ts`
- `src/agent/implementations/flows/common/BaseFlowServices.ts`

### Phase 5: Consolidate Types (Week 3)

**Goal**: Single unified state definition.

**Changes**:
1. Create `UnifiedAgentState` interface
2. Migrate flows to use it
3. Remove deprecated types
4. Simplify `UserVariableChannels` to single object

---

## Migration Strategy

### Backward Compatibility

During migration, support both patterns:

```typescript
interface PersistedFlowConfig {
  // Legacy mode (default for existing flows)
  serializationMode?: 'legacy' | 'lazy';
}

// Existing flows continue to work unchanged
const flow = new PersistedFlow(node, kv, { serializationMode: 'legacy' });

// New/migrated flows use lazy serialization
const flow = new PersistedFlow(node, kv, { serializationMode: 'lazy' });
```

### Testing Strategy

1. **Unit tests**: Each phase has dedicated tests
2. **Integration tests**: Full flow execution tests
3. **Resumability tests**: Verify persistence still works
4. **Performance tests**: Measure serialization reduction

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Resumability breaks | LOW | HIGH | Per-phase testing, rollback plan |
| State corruption | LOW | HIGH | Comprehensive test coverage |
| Performance regression | LOW | MEDIUM | Benchmark before/after |
| Large merge conflicts | MEDIUM | MEDIUM | Small, focused PRs |

---

## Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Serialize ops/round | 35-40 | 1-2 | Count in tests |
| State type count | 25+ | 6 | Grep codebase |
| Lines of code | N/A | -560 | Diff stats |
| Cognitive load | HIGH | LOW | Code review feedback |

---

## Decision Record

### Why Now?

The snapshot pattern was introduced to support `structuredClone()` in PersistedFlow. However:
- The overhead (35-40 ops/round) was not anticipated
- The manual sync pattern (`updateWorkspaceSnapshot()`) is error-prone
- State has fragmented across too many types

### Why Not Incremental?

Small fixes would leave the fundamental architecture unchanged:
- Reducing serialize calls still leaves reconstruction overhead
- Fixing one state type leaves 24 others
- Pattern inconsistencies would remain

### Alternatives Considered

1. **Keep snapshots, reduce frequency**: Still has reconstruction overhead
2. **Use Immer for mutations**: Adds dependency, doesn't fix fragmentation
3. **Full rewrite**: Too risky, loses working code

The proposed approach balances impact with risk by:
- Maintaining backward compatibility during migration
- Making changes in focused phases
- Preserving core flow logic
