# Separation of Concerns - Parameter Passing Refactoring

## Problem Statement

The previous implementation had redundant parameter passing through multiple levels:

```typescript
// Flow level
executeRound(roundIndex, runState, messages)
  ↓
// Agent level
prepareRoundContext(roundIndex, runState, messages, workspaceState)
  ↓
// Pipeline level
runRoundPipeline({roundIndex, runState, workspaceState, preparedMessages, prefill, outputLocation})
```

**Issues:**

1. `roundIndex` passed 3 times
2. `runState` passed 3 times
3. `messages` passed 2-3 times
4. Cognitive overhead tracking parameters through layers
5. Unclear ownership - who owns the execution context?

## Solution: Instance State Pattern

### Proper Separation of Concerns

**Flow's Responsibility:**

- Lifecycle management (init, rounds loop, finalize)
- State transitions between rounds
- Error handling and interruption

**Agent's Responsibility:**

- Round execution context (owns the data during execution)
- Internal orchestration of round steps
- State recording and management

### New Architecture

```typescript
// Flow initializes agent with context (ONE TIME)
agent.beginRound(roundIndex, runState, messages);

// Agent executes using its internal context (NO PARAMETERS)
const result = await agent.executeCurrentRound();
  ↓ prepareAgentWorkspaceState()     // Uses this.currentWorkspaceState
  ↓ prepareRoundContext()             // Uses this.currentMessages, this.currentRoundIndex
  ↓ runRoundPipeline(...)             // Uses this.currentRunState, this.currentWorkspaceState

// Flow records result (CLEAR BOUNDARY)
agent.recordRoundResult(result);
```

## Implementation

### Agent Instance State

```typescript
class BaseReflectionAgent {
  // Round execution context - set when round begins
  private currentRoundIndex: number = 0;
  private currentMessages: any[] = [];
  private currentRunState: AgentRunState | null = null;
  private currentWorkspaceState: AgentWorkspaceState | null = null;

  /**
   * Initialize round execution context.
   * Sets up all state needed for the round execution.
   */
  public beginRound(
    roundIndex: number,
    runState: AgentRunState,
    messages: any[],
  ): void {
    this.currentRoundIndex = roundIndex;
    this.currentMessages = messages;
    this.currentRunState = runState;
    this.currentWorkspaceState = new AgentWorkspaceState();
    this.resetTransientUserVars({ CURRENT_ROUND: roundIndex });
  }

  /**
   * Execute the round using internal context.
   * No parameters needed - uses instance state.
   */
  public async executeCurrentRound(): Promise<ReflectionRoundResult> {
    // All methods access this.currentXXX instead of parameters
    await this.prepareAgentWorkspaceState();
    const preparation = await this.prepareRoundContext();
    return await this.runRoundPipeline(
      preparation.stateRound,
      preparation.preparedMessages,
      preparation.prefill ?? '',
    );
  }
}
```

### Method Signatures

**Before:**

```typescript
prepareAgentWorkspaceState(
  currRound: number,
  workspaceState: AgentWorkspaceState
): Promise<void>

prepareRoundContext(
  currRound: number,
  runState: AgentRunState,
  messages: any[],
  workspaceState: AgentWorkspaceState
): Promise<{...}>

runRoundPipeline({
  roundIndex,
  roundState,
  runState,
  workspaceState,
  preparedMessages,
  prefill,
  outputLocation,
}): Promise<ReflectionRoundResult>
```

**After:**

```typescript
prepareAgentWorkspaceState(): Promise<void>
// Uses: this.currentRoundIndex, this.currentWorkspaceState

prepareRoundContext(): Promise<{...}>
// Uses: this.currentRoundIndex, this.currentMessages, this.currentWorkspaceState

runRoundPipeline(
  roundState: ConversationRoundState,
  preparedMessages: any[],
  prefill: string
): Promise<ReflectionRoundResult>
// Uses: this.currentRoundIndex, this.currentRunState, this.currentWorkspaceState
```

## Benefits

### 1. Clear Ownership ✅

- **Agent owns round execution context** during execution
- Flow doesn't need to track execution details
- Clear lifecycle: `beginRound() → execute → done`

### 2. Reduced Cognitive Load ✅

- **Before**: Track 7+ parameters through 3 layers
- **After**: Set context once, methods access instance state
- Obvious what data is available at each level

### 3. Cleaner Method Signatures ✅

- **Before**: `prepareRoundContext(currRound, runState, messages, workspaceState)`
- **After**: `prepareRoundContext()` - all data available internally

### 4. Single Source of Truth ✅

- Context set in one place (`beginRound`)
- All methods read from same source (`this.currentXXX`)
- No parameter threading/transformation between layers

### 5. Better Encapsulation ✅

- Internal methods access internal state
- External API is minimal and clear
- Agent manages its own execution lifecycle

## Comparison

### Parameter Count Reduction

**Before:**

```typescript
executeRound(3 params)
  → prepareAgentWorkspaceState(2 params)
  → prepareRoundContext(4 params)
  → runRoundPipeline(1 object with 7 fields)
Total: 16 parameter slots
```

**After:**

```typescript
beginRound(3 params) - ONE TIME
executeCurrentRound(0 params)
  → prepareAgentWorkspaceState(0 params)
  → prepareRoundContext(0 params)
  → runRoundPipeline(3 params)
Total: 6 parameter slots (62% reduction)
```

### Flow Code

**Before:**

```typescript
// Flow has to pass everything through
prepRes.agent.setCurrentRound(prepRes.roundIndex);
const result = await prepRes.agent.executeRound(
  prepRes.roundIndex,
  prepRes.state.runState,
  prepRes.state.conversation,
);
```

**After:**

```typescript
// Flow sets context once, then executes
prepRes.agent.beginRound(
  prepRes.roundIndex,
  prepRes.state.runState,
  prepRes.state.conversation,
);
const result = await prepRes.agent.executeCurrentRound();
```

## Design Principles Validated

### ✅ Separation of Concerns

- **Flow**: Manages round loop and lifecycle
- **Agent**: Owns execution context and orchestration
- **Clear boundary**: Set context → Execute → Return result

### ✅ Minimize Redundant Passing

- Parameters set once at agent boundary
- Internal methods access instance state
- No threading of same data through layers

### ✅ Solve at Right Abstraction Level

- **Flow level**: Round sequencing, lifecycle
- **Agent level**: Execution context, orchestration
- **Method level**: Specific transformations

### ✅ Single Source of Truth

- Round context lives in agent during execution
- All methods read from same source
- No duplicate tracking across layers

## Edge Cases Handled

### Guard Rails

```typescript
public async executeCurrentRound(): Promise<ReflectionRoundResult> {
  if (!this.currentRunState || !this.currentWorkspaceState) {
    throw new Error('Round context not initialized. Call beginRound() first.');
  }
  // ... execution
}
```

All methods check context initialization and provide clear error messages.

### State Lifecycle

```typescript
// Context is only valid during round execution
beginRound(...)      // Initialize context
executeCurrentRound() // Use context
// After execution, context can be reinitialized for next round
```

## Migration Path

### External Code: ✅ NO CHANGES

The flow calls the updated API, but external code using `agent.run()` sees no changes.

### Internal Code: ✅ SIMPLIFIED

- Removed redundant parameters
- Methods more focused and clear
- Better testability (can mock instance state)

### Backward Compatibility: ✅ MAINTAINED

- No changes to `IAgent` interface
- No changes to serialization
- No changes to external APIs

## Result

**Parameter passing reduced by 62%** while improving:

- Code clarity
- Separation of concerns
- Maintainability
- Testability

**The right data lives at the right level of abstraction.**
