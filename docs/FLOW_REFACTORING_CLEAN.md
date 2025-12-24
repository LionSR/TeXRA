# Flow Refactoring: Clean Design

## The Core Problem

**ReflectionFlow uses PocketFlow correctly:**
```
RoundNode.exec()  → runs ONE round
RoundNode.post()  → decides: CONTINUE or FINALIZE
Graph:            → roundNode.on(CONTINUE, roundNode)
```

**ToolUseFlow fights PocketFlow:**
```
CycleNode.exec()  → while(true) { run cycle; wait for follow-up; mutate state }
                    ↑ 60 lines of spaghetti
                    ↑ Side effects in exec() (violates purity)
                    ↑ 5 exit paths
```

---

## The Clean Fix

**Make ToolUse work like Reflection.** No new abstractions needed.

### Current ToolUse (WRONG)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ToolUseCycleNode.exec()                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ while (true) {                                                    │  │
│  │   if (!skip) runCycle();  // ← Could use PocketFlow retry         │  │
│  │   if (failed) return;     // ← Should be in post()                │  │
│  │   if (cancel) return;     // ← Should be in post()                │  │
│  │   if (intr) return;       // ← Should be in post()                │  │
│  │   wait();                 // ← Side effect in exec()!             │  │
│  │   if (!followUp) return;  // ← Should be in post()                │  │
│  │   state.conversation = x; // ← Mutation in exec()!                │  │
│  │ }                                                                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Fixed ToolUse (CORRECT)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ PrepareNode │────▶│  CycleNode  │────▶│  WaitNode   │
└─────────────┘     └──────┬──────┘     └──────┬──────┘
                           │                   │
                           │                   │ CONTINUE
                           │                   ▼
                           │            ┌─────────────┐
                           │            │  CycleNode  │ (loops back)
                           │            └─────────────┘
                           │
                           ▼ FINALIZE
                    ┌─────────────┐
                    │FinalizeNode │
                    └─────────────┘


CycleNode.exec()  → runs ONE cycle (pure, can use PocketFlow retry)
CycleNode.post()  → if ok: EXECUTE (to WaitNode) else: FINALIZE

WaitNode.prep()   → wait for follow-up (I/O in prep is OK)
WaitNode.exec()   → pure: just pass through
WaitNode.post()   → if followUp: CONTINUE else: FINALIZE
```

---

## Detailed Design

### File: `ToolUseRunFlow.ts` (Refactored)

```typescript
// ============================================================================
// Result Types - Use discriminated unions like InvocationResult
// ============================================================================

/**
 * Result of a single cycle execution.
 * Matches PocketFlow's InvocationResult pattern.
 */
type CycleExecResult =
  | { kind: 'success' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

/**
 * Result of waiting for follow-up.
 */
type WaitExecResult =
  | { kind: 'continue'; followUp: string }
  | { kind: 'stop'; reason: 'interrupted' | 'no-followup' };

// ============================================================================
// Nodes - Each does ONE thing
// ============================================================================

/**
 * Runs a single tool-use cycle.
 *
 * PocketFlow compliance:
 * - prep(): Extract what's needed
 * - exec(): Pure computation (call runCycle)
 * - post(): Side effects + routing
 */
class ToolUseCycleNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<CyclePrepResult<C>> {
    return {
      shouldSkip: shared.state.shouldSkipCycle,
      cycleOptions: shared.state.cycleOptions!,
      conversation: shared.state.conversation,
      store: shared.state.store!,
      hooks: shared.hooks,
    };
  }

  async exec(prepRes: CyclePrepResult<C>): Promise<CycleExecResult> {
    if (prepRes.shouldSkip) {
      return { kind: 'skipped' };
    }

    // Pure: just call the cycle, no state mutation
    const result = await prepRes.hooks.runCycle(
      prepRes.cycleOptions,
      prepRes.conversation,
      prepRes.store,
    );

    if (result.failedWithError) {
      return { kind: 'failed', message: result.errorMessage ?? 'Cycle failed' };
    }
    if (result.userCancelled) {
      return { kind: 'cancelled' };
    }
    return { kind: 'success' };
  }

  async post(
    shared: ToolUseRunShared<C>,
    prepRes: CyclePrepResult<C>,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    // Clear skip flag for next iteration
    if (prepRes.shouldSkip) {
      shared.state.shouldSkipCycle = false;
    }

    switch (execRes.kind) {
      case 'success':
        // Persist checkpoint (side effect belongs in post)
        await shared.hooks.persistCheckpoint(
          shared.state.conversation,
          shared.state.store!,
        );
        return FlowTransition.EXECUTE; // → WaitNode

      case 'skipped':
        return FlowTransition.EXECUTE; // → WaitNode

      case 'failed':
        shared.lifecycle.fail(new Error(execRes.message));
        return FlowTransition.FINALIZE;

      case 'cancelled':
        return FlowTransition.FINALIZE;
    }
  }
}

/**
 * Waits for user follow-up message.
 *
 * PocketFlow compliance:
 * - prep(): I/O operations (waiting is I/O)
 * - exec(): Pure pass-through
 * - post(): Routing decision
 */
class ToolUseWaitNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<WaitPrepResult> {
    const { hooks } = shared;

    // Check interruption first
    if (hooks.checkInterruption()) {
      return { interrupted: true };
    }

    // Handle waiting state
    if (hooks.hasQueuedFollowUp()) {
      await hooks.clearPersistedSnapshot();
    } else {
      await hooks.enterWaitingState();
    }

    // Wait for follow-up (I/O - belongs in prep)
    const followUp = await hooks.waitForFollowUp();

    if (!followUp || hooks.checkInterruption()) {
      return { interrupted: true };
    }

    return { interrupted: false, followUp };
  }

  async exec(prepRes: WaitPrepResult): Promise<WaitExecResult> {
    // Pure: just transform prep result
    if (prepRes.interrupted) {
      return { kind: 'stop', reason: 'interrupted' };
    }
    if (!prepRes.followUp) {
      return { kind: 'stop', reason: 'no-followup' };
    }
    return { kind: 'continue', followUp: prepRes.followUp };
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: WaitPrepResult,
    execRes: WaitExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'stop') {
      return FlowTransition.FINALIZE;
    }

    // Apply follow-up (side effect belongs in post)
    await shared.hooks.markRunning();
    await shared.hooks.clearPersistedSnapshot();
    shared.state.conversation = await shared.hooks.applyFollowUp(
      execRes.followUp,
      shared.state.conversation,
    );

    return FlowTransition.CONTINUE; // → Back to CycleNode
  }
}

// ============================================================================
// Flow Construction
// ============================================================================

export function createToolUseRunFlow<C>(): Flow<ToolUseRunShared<C>> {
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const waitNode = new ToolUseWaitNode<C>();
  const finalizeNode = createStandardFinalizeNode<ToolUseRunShared<C>>({
    finalizePhase: 'finalize',
    beforeEnd: async ({ hooks }) => {
      await hooks.clearPersistedSnapshot();
    },
  });

  return createAgentRunFlow<ToolUseRunShared<C>>({
    init: {
      phase: 'init',
      onSuccess: (shared) => {
        shared.lifecycle.begin('prepare');
        return FlowTransition.EXECUTE;
      },
    },
    finalize: finalizeNode,
    links: ({ init }) => [
      // Init → Prepare
      { from: init, on: FlowTransition.EXECUTE, to: prepareNode },
      // Prepare → Cycle (or Finalize on error)
      { from: prepareNode, on: FlowTransition.EXECUTE, to: cycleNode },
      { from: prepareNode, on: FlowTransition.FINALIZE },
      // Cycle → Wait (or Finalize on error/cancel)
      { from: cycleNode, on: FlowTransition.EXECUTE, to: waitNode },
      { from: cycleNode, on: FlowTransition.FINALIZE },
      // Wait → Cycle (loop) or Finalize (stop)
      { from: waitNode, on: FlowTransition.CONTINUE, to: cycleNode },
      { from: waitNode, on: FlowTransition.FINALIZE },
    ],
  });
}
```

---

## Type Consolidation (Minimal Changes)

### 1. Extract FlowLink to common/types.ts

```typescript
// common/types.ts - add this

/**
 * Link between flow nodes. Single source of truth.
 * (Previously duplicated in buildRunFlow.ts and createAgentRunFlow.ts)
 */
export interface FlowLink<Shared> {
  from: BaseNode<Shared>;
  on: string;
  to?: BaseNode<Shared>;
}

/**
 * Type alias for repeated generic constraint.
 * (Previously repeated 6x in AgentRunFlowRunner.ts)
 */
export type BaseFlowShared = AgentRunShared<
  BaseAgent<any>,
  any,
  AgentLifecycle<string>,
  AgentRunHooks
>;
```

### 2. Use Consistent Result Types

```typescript
// common/nodeExecution.ts - simplify

/**
 * Standard node execution result.
 * Use discriminated union with 'kind' for clarity.
 */
export type NodeResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'error'; error: unknown };

// Constructors
export const success = <T>(value: T): NodeResult<T> => ({ kind: 'success', value });
export const error = (e: unknown): NodeResult<never> => ({ kind: 'error', error: e });
```

---

## Hook Reduction

The flow-control hooks can stay, but they're now called in the RIGHT places:

| Hook | Before (wrong) | After (correct) |
|------|----------------|-----------------|
| `checkInterruption()` | exec() | WaitNode.prep() |
| `hasQueuedFollowUp()` | exec() | WaitNode.prep() |
| `enterWaitingState()` | exec() | WaitNode.prep() |
| `waitForFollowUp()` | exec() | WaitNode.prep() |
| `markRunning()` | exec() | WaitNode.post() |
| `clearPersistedSnapshot()` | exec() | WaitNode.prep/post() |
| `applyFollowUp()` | exec() | WaitNode.post() |
| `persistCheckpoint()` | exec() | CycleNode.post() |

No need to reduce hook count - just use them correctly.

---

## Summary of Changes

| Current | Fixed | Change |
|---------|-------|--------|
| `while(true)` in exec() | Graph-based CONTINUE | Use PocketFlow looping |
| 5 exit paths | 1 switch statement | Clean control flow |
| Side effects in exec() | Side effects in post() | PocketFlow compliance |
| 4-variant union type | Simple `kind` discriminant | Cleaner types |
| FlowLink in 2 files | FlowLink in 1 file | DRY |
| Generic constraint 6x | Type alias | DRY |

---

## File Changes

| File | Action |
|------|--------|
| `ToolUseRunFlow.ts` | Rewrite: Split CycleNode into CycleNode + WaitNode |
| `common/types.ts` | Add: FlowLink, BaseFlowShared |
| `common/buildRunFlow.ts` | Update: Import FlowLink from types |
| `common/createAgentRunFlow.ts` | Update: Import FlowLink from types |
| `common/AgentRunFlowRunner.ts` | Update: Use BaseFlowShared alias |
| `common/nodeExecution.ts` | Simplify: Use `kind` discriminant |

**Total: ~6 files modified, ~200 lines changed**

---

## Why This Works

1. **Leverages PocketFlow**: Uses CONTINUE like Reflection does
2. **No new abstractions**: Just fix the existing code
3. **Pure exec()**: CycleNode.exec() has no side effects
4. **Testable**: Each node is small and focused
5. **Debuggable**: Clear flow graph, no hidden loops
6. **Consistent**: Both flows now work the same way
