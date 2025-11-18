# Naming Consistency Analysis

## Current State

### BaseReflectionAgent (Workflow)

```typescript
// Lifecycle
public beginRound(roundIndex, runState, messages): void
public async executeCurrentRound(): Promise<ReflectionRoundResult>
public recordRoundResult(result): void

// Preparation
public async prepareAgentWorkspaceState(): Promise<void>
public async prepareRoundContext(): Promise<{...}>

// Utilities
public resetPromptBuilder(): void
public getOutputFileLocation(currRound): AgentFileLocation
protected getTotalRounds(): number
private createResponseCycleOptions(): ResponseCycleOptions<C>
```

### BaseToolUseAgent (Interactive)

```typescript
// Lifecycle
public async prepareInitialSessionState(): Promise<{...}>  // ❌ Inconsistent with beginRound
public buildToolUseCycleOptions(store): ToolUseCycleOptions<C>  // ❌ "build" vs "create"

// Session Management
public async waitForFollowUp(): Promise<string | null>
public hasQueuedFollowUp(): boolean
public async enterWaitingState(): Promise<void>
public async markRunning(): Promise<void>
public async clearPersistedSnapshot(): Promise<void>
public async applyFollowUpMessage(followUp, messages): Promise<...>

// Utilities
private getActiveState(): ToolUseRunState<C>
private getTools(): ToolDefinition[]
```

## Inconsistencies Identified

### 1. ❌ Lifecycle Method Naming

- **Reflection**: `beginRound()` - clear initialization
- **Tool-Use**: `prepareInitialSessionState()` - verbose, not parallel

**Issue**: Different verbs for initialization (begin vs prepare)

### 2. ❌ Options/Config Method Naming

- **Reflection**: `createResponseCycleOptions()` - uses "create"
- **Tool-Use**: `buildToolUseCycleOptions()` - uses "build"

**Issue**: Inconsistent verb for same operation type

### 3. ❌ State Access Naming

- **Reflection**: Uses instance state directly (`this.currentXXX`)
- **Tool-Use**: `getActiveState()` - getter method

**Issue**: Different patterns for accessing execution state

### 4. ✅ Result Recording

- **Reflection**: `recordRoundResult()` - explicit
- **Tool-Use**: N/A (reactive model, no explicit rounds)

**Issue**: None - this is legitimately different

## Proposed Consistent Naming

### Pattern: Lifecycle Methods

```typescript
// Initialization
begin<Context>(); // Set up execution context
execute<Context>(); // Execute using context (if applicable)
record<Result>(); // Record results (if applicable)
```

### Pattern: Preparation Methods

```typescript
prepare<Resource>(); // Prepare a resource/state for use
create<Options>(); // Create configuration/options objects
```

### Pattern: State Access

```typescript
// Use instance state directly when possible
private current<State>  // Instance variables

// Or use getters when encapsulation needed
protected get<State>()  // Getter methods
```

## Recommended Changes

### BaseToolUseAgent

```typescript
// BEFORE
public async prepareInitialSessionState(): Promise<{...}>
public buildToolUseCycleOptions(store): ToolUseCycleOptions<C>
private getActiveState(): ToolUseRunState<C>

// AFTER
public beginSession(resumeSnapshot?): void  // Parallel to beginRound()
public async prepareInitialState(): Promise<{...}>  // Shorter, consistent
public createCycleOptions(store): ToolUseCycleOptions<C>  // Parallel to createResponseCycleOptions()
// Remove getActiveState(), use this.currentState directly
```

### BaseReflectionAgent

```typescript
// Already consistent, minor clarifications:
public beginRound(...)              // ✅ Good
public async executeCurrentRound()  // ✅ Good
public recordRoundResult(...)       // ✅ Good
public async prepareAgentWorkspaceState()  // Consider: prepareWorkspaceState() (shorter)
public async prepareRoundContext()  // ✅ Good
private createResponseCycleOptions()  // ✅ Good
```

## Balanced Organization

### Common Lifecycle Pattern

Both should follow:

```typescript
class BaseWorkflowAgent {
  // 1. LIFECYCLE METHODS (public)
  begin<Context>(); // Initialize execution context
  execute<Context>(); // Execute using context
  record<Result>(); // Record results

  // 2. PREPARATION METHODS (public/protected)
  prepare<Resource>(); // Prepare resources

  // 3. FACTORY METHODS (private/protected)
  create<Options>(); // Create configuration objects

  // 4. UTILITIES (private/protected)
  get<Property>(); // Property accessors
  has<Condition>(); // Condition checkers
}
```

### Applied to Both

```typescript
// BaseReflectionAgent (Workflow)
class BaseReflectionAgent {
  // Lifecycle
  public beginRound();
  public async executeCurrentRound();
  public recordRoundResult();

  // Preparation
  public async prepareWorkspaceState(); // Shorter
  public async prepareRoundContext();

  // Factory
  private createResponseCycleOptions();

  // Utilities
  protected getTotalRounds();
  public getOutputFileLocation();
  public resetPromptBuilder();
}

// BaseToolUseAgent (Interactive)
class BaseToolUseAgent {
  // Lifecycle
  public beginSession(); // NEW: parallel to beginRound()
  public async prepareInitialState(); // Renamed from prepareInitialSessionState
  // No execute method (reactive model)
  // No record method (no explicit rounds)

  // Factory
  public createCycleOptions(); // Renamed from buildToolUseCycleOptions

  // Session Management (unique to tool-use)
  public async waitForFollowUp();
  public hasQueuedFollowUp();
  public async enterWaitingState();
  public async markRunning();
  public async clearPersistedSnapshot();
  public async applyFollowUpMessage();

  // Utilities
  protected getTools();
  // Remove getActiveState(), use instance state
}
```

## Summary of Changes

### 1. Rename for Consistency

- `prepareInitialSessionState()` → `prepareInitialState()` (shorter, consistent)
- `buildToolUseCycleOptions()` → `createCycleOptions()` (parallel to createResponseCycleOptions)

### 2. Add for Clarity

- `beginSession()` - parallel to `beginRound()`, sets up session context

### 3. Simplify

- Remove `getActiveState()`, use `this.currentState` directly (like BaseReflectionAgent)
- Shorten `prepareAgentWorkspaceState()` → `prepareWorkspaceState()` (agent is implied)

### 4. Maintain Differences

- Tool-use has session management methods (reactive model)
- Reflection has round execution methods (proactive model)
- These differences are legitimate and should remain

## Result

**Consistent naming patterns** while respecting the **fundamental difference** between:

- **Workflow agents** (proactive, round-based, sequential)
- **Interactive agents** (reactive, session-based, event-driven)

Both follow same lifecycle pattern (`begin → prepare/execute → record`) adapted to their execution model.
