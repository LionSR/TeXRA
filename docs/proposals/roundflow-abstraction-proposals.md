# RoundFlow Abstraction Proposals

## Executive Summary

This document presents findings from a comprehensive investigation into round orchestration patterns in TeXRA, along with 3 candidate proposals for a RoundFlow abstraction that could simplify the current implementation.

---

## Part 1: Critical Bugs Found During Investigation

### Bug 1: `_roundFinalized` Flag Not Reset (CONFIRMED)

**Location:** `src/agent/core/AgentSharedStore.ts`

**Issue:** The `_roundFinalized` flag is set to `true` in `finalizeRound()` but `resetRound()` never resets it to `false`. This causes subsequent rounds in multi-round tool-use cycles to skip finalization entirely.

**Impact:**

- Usage data from rounds 2+ not recorded
- Response time tracking incomplete
- `onRoundFinalized` callback only fires once

**Fix Required:**

```typescript
resetRound(roundIndex: number): ConversationRoundState {
  this.roundState = new ConversationRoundState(roundIndex);
  this._roundFinalized = false;  // ADD THIS LINE
  return this.roundState;
}
```

### Bug 2: PersistedFlow `roundOutputs` Always Empty (CONFIRMED)

**Location:** `src/agent/implementations/flows/reflection/runReflectionFlow.ts`

**Issue:** `PersistedFlow.run(shared)` uses `structuredClone()` to create a deep copy that gets persisted. All node mutations happen to the cloned copy in storage, NOT the original `shared` object. When the function returns `shared?.roundOutputs`, it returns the original empty array.

**Impact:**

- `roundOutputs` always returns `[]` to caller
- All accumulated round results lost in return value
- Resume works correctly (uses internal `getShared()`)

**Fix Required:**

```typescript
// BEFORE (line 298):
return {
  roundOutputs: shared?.roundOutputs ?? [],
  status,
};

// AFTER:
const finalShared = await pf.getShared();
return {
  roundOutputs: finalShared?.roundOutputs ?? [],
  status,
};
```

---

## Part 2: Current Pain Points in Round Orchestration

### 2.1 Distributed Stage Lifecycle Management

**Problem:** Round stages (r0, r1, r2) are created and finalized in 3 different locations:

| Aspect        | Location                                   |
| ------------- | ------------------------------------------ |
| r0 created    | `runReflectionFlow.ts:184`                 |
| r1+ created   | `RoundCompleteNode.ts:137`                 |
| All finalized | `runReflectionFlow.ts:281` (finally block) |

**Why problematic:**

- Tight coupling between flow runner and domain logic
- Mutable `roundStage` in services violates immutability pattern
- Error-prone coordination

### 2.2 Snapshot Serialization Overhead

**Problem:** Multiple nodes reconstruct class instances from snapshots, mutate them, and update snapshots. This pattern is repeated across:

- `MediaPreparationNode` (workspace)
- `ResponseCycleCompositionNode` (workspace, run, round)
- `ToolUseCycleNode` (store)

**Why problematic:**

- Easy to forget `toSnapshot()` calls (no compile-time safety)
- Multiple reconstruction/serialization cycles per round
- "CRITICAL" comments warning about missing updates

### 2.3 Session vs Flow State Mismatch (ToolUseFlow)

**Problem:** `ToolUseSessionLifecycle` lives outside flow persistence, but `conversation` lives inside.

**Why problematic:**

- On resume, session is recreated fresh (queued follow-ups lost)
- Two sources of truth that can diverge
- Subtle bugs if interruption happens during wait

### 2.4 Nested Flow Composition Complexity

**Problem:** ToolUseFlow has two layers:

- **Outer Flow:** ToolUseRunFlow (session management)
- **Inner Flow:** ToolUseCycleFlow (single cycle execution)

**Why problematic:**

- Hard to reason about error propagation
- State flows through multiple levels
- Two independent state machines to understand

### 2.5 Implicit Control Flow

**Problem:** `FlowTransition.CONTINUE` and `FlowTransition.DEFAULT` have different meanings in different nodes:

- PrepareContextNode: CONTINUE = "skip this round", DEFAULT = "continue normally"
- RoundCompleteNode: CONTINUE = "next round", DEFAULT = "flow ends"

**Why problematic:**

- No clear documentation of semantics per node
- Routing is implicit via `node.on()` wiring

---

## Part 3: Three Candidate Proposals

---

### Proposal A: RoundIterator Pattern (Simple Abstraction)

**Concept:** Extract round management into an iterator-like abstraction that hides loop mechanics.

```typescript
interface RoundContext<S> {
  roundIndex: number;
  totalRounds: number;
  shared: S;
  stage: AgentLogStage;
  continueRounds: boolean;
}

abstract class RoundIterable<S, P, Svc> {
  // Template methods - implement in subclass
  abstract initializeRound(ctx: RoundContext<S>): Promise<void>;
  abstract executeRound(ctx: RoundContext<S>): Promise<void>;
  abstract finalizeRound(ctx: RoundContext<S>): Promise<void>;
  abstract shouldContinue(ctx: RoundContext<S>): boolean;

  // Orchestration - handled by base class
  async runRounds(shared: S, config: RoundConfig): Promise<void> {
    const { totalRounds, logger, runStage } = config;

    for (let i = 0; i < totalRounds; i++) {
      // Create round stage automatically
      const stage = await logger.stage(`r${i}`, { parent: runStage });

      try {
        const ctx: RoundContext<S> = {
          roundIndex: i,
          totalRounds,
          shared,
          stage,
          continueRounds: true
        };

        await this.initializeRound(ctx);
        if (!ctx.continueRounds) break;

        await this.executeRound(ctx);
        if (!ctx.continueRounds) break;

        await this.finalizeRound(ctx);
        if (!this.shouldContinue(ctx)) break;

      } finally {
        stage.end();  // Automatic cleanup!
      }
    }
  }
}

// Usage Example
class ReflectionRounds extends RoundIterable<ReflectionFlowShared, ...> {
  async initializeRound(ctx) {
    await this.prepareContext(ctx);
    await this.addTeXCount(ctx);
    await this.prepareMedia(ctx);
  }

  async executeRound(ctx) {
    await this.runResponseCycle(ctx);
  }

  async finalizeRound(ctx) {
    await this.processOutput(ctx);
  }

  shouldContinue(ctx) {
    return ctx.continueRounds && ctx.roundIndex < ctx.totalRounds - 1;
  }
}
```

**Pros:**

- Simple, intuitive API
- Automatic stage lifecycle (no manual cleanup)
- Clear three-phase structure
- Easy to understand for new developers
- Reduces ~200 lines of boilerplate per flow

**Cons:**

- Loses PocketFlow's graph-based flexibility
- Harder to integrate with PersistedFlow checkpointing (checkpoints at phase boundaries, not node boundaries)
- Tightly couples round logic to iteration
- Makes nested flows awkward
- Would require significant refactoring

**Migration Effort:** HIGH (rewrite flows from scratch)

**Best For:** New flows where simplicity > flexibility

---

### Proposal B: RoundOrchestrator Pattern (Composition-Based)

**Concept:** Use composition to wrap existing flows with round management, preserving PocketFlow patterns.

```typescript
class RoundOrchestrator<S extends RoundAwareState, P, Svc> {
  constructor(
    private readonly roundFlowFactory: () => Flow<S, P, Svc>,
    private readonly config: RoundOrchestratorConfig<Svc>,
  ) {}

  async run(shared: S, services: Svc): Promise<void> {
    const { logger, runStage, totalRounds, onRoundComplete } = this.config;

    for (let round = 0; round < totalRounds; round++) {
      // Create round stage
      const roundStage = await logger.stage(`r${round}`, { parent: runStage });

      // Inject round-specific services
      const roundServices = { ...services, roundStage };

      // Create fresh flow instance for this round
      const roundFlow = this.roundFlowFactory();
      roundFlow.setServices(roundServices);

      try {
        // Update shared state
        shared.currentRound = round;

        // Run the round flow (existing node graph)
        await roundFlow.run(shared);

        // Callback for custom finalization
        await onRoundComplete?.(shared, round);

        // Check continuation
        if (!shared.continueRounds) break;

      } finally {
        roundStage.end();
      }
    }
  }
}

// Usage - wrap existing flow
const orchestrator = new RoundOrchestrator<ReflectionFlowShared, ...>(
  () => createReflectionRoundFlow(),  // Existing flow factory
  {
    logger,
    runStage,
    totalRounds: setting.maxRounds,
    onRoundComplete: async (shared, round) => {
      // Custom finalization logic
    },
  },
);

await orchestrator.run(shared, services);
```

**Pros:**

- Preserves existing PocketFlow node graphs
- Automatic stage lifecycle
- Services updated per-round (no mutable field)
- Compatible with PersistedFlow (wrap the inner flow)
- Incremental migration possible

**Cons:**

- Extra abstraction layer
- Flow runs once per round (some state reset overhead)
- Need to split existing flows into "round" and "meta" portions
- onRoundComplete callback pattern can become complex

**Migration Effort:** MEDIUM (wrap existing flows, extract round logic)

**Best For:** Existing flows where you want better round management without rewriting

---

### Proposal C: RoundPhase Node Pattern (Minimal Abstraction)

**Concept:** Create lightweight base classes that formalize the three-phase pattern within PocketFlow's existing architecture.

```typescript
// Base class for round phases - minimal overhead
abstract class RoundPhaseNode<S extends RoundAwareState, P, Svc>
  extends Node<S, P, Svc> {

  // Standard prep: extract round info
  async prep(shared: S): Promise<RoundPrepResult<S>> {
    return {
      roundIndex: shared.currentRound,
      totalRounds: shared.totalRounds,
      shared,
    };
  }
}

// Specialized phase nodes
abstract class InitializePhaseNode<S, P, Svc> extends RoundPhaseNode<S, P, Svc> {
  // Override exec() to initialize round-specific state
}

abstract class ExecutePhaseNode<S, P, Svc> extends RoundPhaseNode<S, P, Svc> {
  // Override exec() to run core logic
}

abstract class FinalizePhaseNode<S, P, Svc> extends RoundPhaseNode<S, P, Svc> {
  // Standard post: handle round transitions
  async post(shared, prepRes, execRes): Promise<string | undefined> {
    if (execRes.shouldFinalize) {
      return FlowTransition.FINALIZE;
    }

    if (execRes.shouldContinue) {
      // Update round counter
      shared.currentRound++;

      // Create new round stage (using RoundStageManager helper)
      await this.services.roundStageManager.transitionToRound(shared.currentRound);

      return FlowTransition.CONTINUE;
    }

    return FlowTransition.DEFAULT;
  }
}

// RoundStageManager - encapsulates stage lifecycle
class RoundStageManager {
  private currentStage: AgentLogStage | null = null;

  constructor(
    private readonly logger: AgentLogger,
    private readonly runStage: AgentLogStage,
  ) {}

  async transitionToRound(roundIndex: number): Promise<void> {
    // End previous stage
    this.currentStage?.end();

    // Create new stage
    this.currentStage = await this.logger.stage(`r${roundIndex}`, {
      parent: this.runStage,
    });
  }

  get stage(): AgentLogStage | null {
    return this.currentStage;
  }

  finalize(status?: EndGroupStatus): void {
    this.currentStage?.end(status);
    this.currentStage = null;
  }
}

// Usage - ReflectionFlow becomes:
class ReflectionInitNode extends InitializePhaseNode<ReflectionState, ...> {
  async exec(prepRes) {
    // Build context, messages, media
    return { context: await this.buildContext(prepRes.shared) };
  }
}

class ReflectionExecNode extends ExecutePhaseNode<ReflectionState, ...> {
  async exec(prepRes) {
    // Run response cycle
    return { output: await this.runCycle(prepRes.shared) };
  }
}

class ReflectionFinalizeNode extends FinalizePhaseNode<ReflectionState, ...> {
  async exec(prepRes) {
    // Process output, decide continuation
    const shouldContinue = prepRes.roundIndex < prepRes.totalRounds - 1;
    return { shouldContinue, shouldFinalize: !shouldContinue };
  }
}

// Wire up (same as current PocketFlow pattern)
const init = new ReflectionInitNode();
const exec = new ReflectionExecNode();
const finalize = new ReflectionFinalizeNode();

init.next(exec).next(finalize);
finalize.on(FlowTransition.CONTINUE, init);  // Loop

const flow = new Flow(init);
```

**Pros:**

- Minimal new abstraction - extends existing patterns
- Full PocketFlow compatibility (graph, checkpointing, actions)
- Works with PersistedFlow unchanged
- RoundStageManager encapsulates stage lifecycle
- Clear semantic naming (Init/Exec/Finalize phases)
- Easy incremental migration
- Low learning curve

**Cons:**

- Less automation than Proposals A/B
- Still need per-flow implementations of 3 phase nodes
- RoundStageManager is a new service to inject

**Migration Effort:** LOW (rename + add base classes)

**Best For:** Gradual improvement with minimal disruption

---

## Part 4: Comparison Matrix

| Criterion                       | Proposal A (Iterator) | Proposal B (Orchestrator) | Proposal C (RoundPhase) |
| ------------------------------- | --------------------- | ------------------------- | ----------------------- |
| **PocketFlow Fidelity**         | Low                   | Medium                    | Very High               |
| **PersistedFlow Compatibility** | Requires changes      | Compatible                | Fully compatible        |
| **Simplicity**                  | High                  | Medium                    | Medium                  |
| **Flexibility**                 | Low                   | High                      | Very High               |
| **Migration Effort**            | High                  | Medium                    | Low                     |
| **Stage Lifecycle**             | Automatic             | Automatic                 | Via RoundStageManager   |
| **Preserves Existing Code**     | No                    | Partially                 | Yes                     |
| **Learning Curve**              | Low                   | Medium                    | Low                     |
| **Future Extensibility**        | Limited               | Good                      | Excellent               |

---

## Part 5: Recommendation

### Recommended: Proposal C (RoundPhase Node Pattern)

**Why:**

1. **Minimal disruption** - Builds on existing patterns, not replacement
2. **Full compatibility** - Works with PersistedFlow, retry patterns, etc.
3. **Incremental migration** - Can adopt gradually, flow by flow
4. **Encapsulates complexity** - RoundStageManager handles stage lifecycle
5. **Clear semantics** - Three-phase structure is explicit in code
6. **Low risk** - Small changes, easy to test

### Implementation Roadmap

**Phase 1: Fix Immediate Bugs (1-2 hours)**

- [ ] Fix `_roundFinalized` flag in `AgentSharedStore.resetRound()`
- [ ] Fix `roundOutputs` retrieval in `runReflectionFlow.ts`

**Phase 2: Add Base Abstractions (2-4 hours)**

- [ ] Create `RoundPhaseNode` base class
- [ ] Create `InitializePhaseNode`, `ExecutePhaseNode`, `FinalizePhaseNode`
- [ ] Create `RoundStageManager` service
- [ ] Add to `src/agent/implementations/flows/common/`

**Phase 3: Refactor ReflectionFlow (4-8 hours)**

- [ ] Extract nodes to use phase base classes
- [ ] Integrate `RoundStageManager` into services
- [ ] Remove mutable `roundStage` from services
- [ ] Update `runReflectionFlow.ts` to use RoundStageManager

**Phase 4: Refactor ToolUseFlow (4-8 hours)**

- [ ] Apply same pattern to ToolUseFlow
- [ ] Consider if session state should move into persistence

**Phase 5: Documentation (2 hours)**

- [ ] Add `docs/pocketflow/design_pattern/round_orchestration.md`
- [ ] Update AGENTS.md with round pattern guidance

---

## Appendix: Files to Modify

### Bug Fixes (Immediate)

- `src/agent/core/AgentSharedStore.ts` - Add flag reset
- `src/agent/implementations/flows/reflection/runReflectionFlow.ts` - Use getShared()

### New Files (Proposal C)

- `src/agent/implementations/flows/common/RoundPhaseNode.ts`
- `src/agent/implementations/flows/common/RoundStageManager.ts`

### Refactored Files (Proposal C)

- `src/agent/implementations/flows/reflection/nodes/PrepareContextNode.ts` → extends `InitializePhaseNode`
- `src/agent/implementations/flows/reflection/nodes/ResponseCycleCompositionNode.ts` → extends `ExecutePhaseNode`
- `src/agent/implementations/flows/reflection/nodes/RoundCompleteNode.ts` → extends `FinalizePhaseNode`
- `src/agent/implementations/flows/reflection/ReflectionServices.ts` - Add RoundStageManager
- `src/agent/implementations/flows/reflection/runReflectionFlow.ts` - Use RoundStageManager

---

_Document generated from comprehensive codebase analysis. Please review and select your preferred approach._
