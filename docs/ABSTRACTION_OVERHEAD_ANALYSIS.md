# Abstraction Overhead Analysis

Deep investigation of call chains and abstraction layers in TeXRA's agent system.

## Executive Summary

**Overall verdict: The codebase is WELL-OPTIMIZED with one main overhead pattern remaining.**

| Area | Status | Overhead Found |
|------|--------|----------------|
| Command → Agent call chain | Optimized | None - 9-11 layers, all add value |
| Context/Services factories | Optimized | Minor (buildCycleOptions inlinable) |
| Node/Flow execution layers | Optimized | None - prep/exec/post pattern justified |
| RetryableInvocationNode | DRY | Eliminates duplication in 2 call sites |
| **AgentSharedStore** | **OVERHEAD** | Pure wrapper with convert→pass→convert pattern |

---

## Call Chain Diagram

### Reflection/Workflow Agents

```
Command Entry (texra.execute)
│
└─ runExecuteCommand(input)
   │
   ├─ [VALIDATION] parseExecuteInput() + parseAgentConfig()
   │
   └─ executeAgent(config, executionId, options)
      │
      ├─ [PREPARATION - all add value]
      │  ├─ getAgentPath() → resolveAgent()      ← Required: agent YAML lookup
      │  ├─ validateAndGetModelConfig()          ← Required: model registry
      │  ├─ loadAgentSettingAndPrompts()         ← Required: config parsing
      │  ├─ ModelFactory.createHandler()         ← Required: provider abstraction
      │  ├─ new AgentExecutionContext()          ← Required: logger, IDs
      │  ├─ buildUserVars()                      ← Required: template vars
      │  └─ new UsageMonitor()                   ← Required: cost tracking
      │
      └─ runReflectionFlow(input, callbacks)
         │
         ├─ createReflectionFlowContext()         ← Contains real logic (7+ services)
         │
         └─ RoundPersistedFlow.run(shared)
            │
            └─ [NODE SEQUENCE per round]
               │
               ├─ PrepareContextNode.exec()       ← Build messages
               ├─ TeXCountNode.exec()             ← Add LaTeX stats
               ├─ MediaExtractionNode.exec()      ← Add figures
               │
               └─ ResponseCycleNode.exec()
                  │
                  ├─ createResponseCycleFlow()    ← Flow factory (justified)
                  │
                  └─ flow.run(cycleShared)
                     │
                     └─ [CYCLE NODES]
                        │
                        ├─ ResponsePrepNode.exec()
                        ├─ ResponseModelInvocationNode.exec()
                        │  │
                        │  └─ modelHandler.createResponse()  ← ACTUAL API CALL
                        │
                        ├─ ResponseProcessNode.exec()
                        └─ ResponseCycleFinalizeNode.exec()
```

**Call depth from command to API:** ~12-13 frames
**Pure wrapper functions found:** 0
**Each layer adds value:** Yes

### Tool-Use Agents

```
Command Entry (texra.execute)
│
└─ executeAgent(config, executionId, options)
   │
   └─ runToolUseFlow(input, callbacks)
      │
      ├─ createToolUseFlowContext()               ← Real logic (tool resolution)
      │
      └─ PersistedFlow.run(shared)
         │
         └─ [NODE SEQUENCE]
            │
            ├─ ToolUsePrepareNode.exec()
            │  │
            │  └─ prepareInitialState(services)   ← Direct helper call
            │
            └─ ToolUseCycleNode.exec()
               │
               ├─ createSharedStore({ snapshot })  ← OVERHEAD: Reconstruct
               ├─ buildCycleOptions(services, store)
               │
               ├─ createToolUseCycleFlow()        ← Flow factory (justified)
               │
               └─ flow.run(cycleShared)
                  │
                  └─ [CYCLE NODES]
                     │
                     ├─ ToolUsePrepNode.exec()
                     ├─ ToolUseCallNode.exec()
                     │  │
                     │  └─ modelHandler.createResponse()  ← ACTUAL API CALL
                     │
                     ├─ ToolUseProcessNode.exec()
                     └─ ToolUseDispatchNode.exec()
               │
               └─ store.toSnapshot()              ← OVERHEAD: Convert back
```

---

## Identified Overhead: AgentSharedStore

### The Anti-Pattern

```typescript
// ToolUseRunFlow.ts - The convert→pass→convert pattern

// Step 1: Convert TO snapshot (line 256)
shared.state.storeSnapshot = store.toSnapshot();

// Step 2: Convert FROM snapshot (line 284)
const store = createSharedStore({ snapshot: shared.state.storeSnapshot });

// Step 3: Only use 2 getters from the store (lines 329-332)
flow.setServices({
  ...prepRes.cycleOptions,
  run: prepRes.store.run,        // ← Could pass directly
  workspace: prepRes.store.workspace,  // ← Could pass directly
  onRoundFinalized,
});
```

### What AgentSharedStore Actually Is

```typescript
// AgentSharedStore.ts - Pure wrapper class
class AgentSharedStore {
  private roundState: ConversationRoundState;
  private runState: AgentRunState;
  private workspaceState: AgentWorkspaceState;
  private userChannels: UserVariableChannels;

  // Just getters - no logic
  get round() { return this.roundState; }
  get run() { return this.runState; }
  get workspace() { return this.workspaceState; }
  get user() { return this.userChannels; }
}
```

**The store is:**
- A holder for 4 objects with getter methods
- Created, snapshotted, then immediately destructured
- Only `.run` and `.workspace` are used by cycle flows

**Unnecessary spreads in toSnapshot():**
```typescript
// Lines 86-87 - Objects copied but could be referenced directly
user: {
  input: { ...this.userChannels.input },      // ← Spread
  transient: { ...this.userChannels.transient },  // ← Spread
}
```

### Recommended Refactoring

**Before (current):**
```
PrepareNode → store.toSnapshot() → snapshot in shared
CycleNode → createSharedStore(snapshot) → store.run, store.workspace
```

**After (proposed):**
```
PrepareNode → { runSnapshot, workspaceSnapshot, ... } in shared
CycleNode → AgentRunState.fromSnapshot(), AgentWorkspaceState.fromSnapshot()
```

**Benefits:**
- Eliminates wrapper class
- Eliminates createSharedStore() factory
- Eliminates unnecessary object spreads
- Direct snapshot/restore of only what's needed

---

## Confirmed DRY Patterns (Keep These)

### 1. buildBaseCycleOptions() - Called 3x

```typescript
// BaseFlowServices.ts - Field name mapping reused
export function buildBaseCycleOptions<C>(services) {
  return {
    modelHandler: services.modelHandler,
    agentSetting: services.setting,      // ← Rename
    agentPrompt: services.prompt,        // ← Rename
    userVars: services.userVarChannels.transient,
    logger: services.logger ?? services.executionContext.logger,
    context: services.context ?? services.executionContext,
    client: services.getClient(),        // ← Extraction
    checkInterruption: services.checkInterruption,
    setAbortController: services.setAbortController,
  };
}
```

**Called from:**
1. ResponseCycleNode (line 172)
2. ToolUsePrepareNode (line 222)
3. ToolUseCycleNode (line 287)

**Verdict:** KEEP - reused 3x with meaningful field mapping

### 2. RetryableInvocationNode - Eliminates Duplication

Used by:
1. ResponseModelInvocationNode
2. ToolUseCallNode

Provides:
- `_userCancelled` flag
- `withAbortController()` helper
- `getFallbackResult()` for consistent error formatting
- Dynamic retry config refresh

**Verdict:** KEEP - prevents code duplication in critical retry logic

### 3. Context Factories - Contain Real Logic

```typescript
// ReflectionFlowContext.ts - Not just restructuring
export function createReflectionFlowContext(init) {
  // Real initialization:
  const fileService = new TaskRunFileService(executionContext.executionId);
  const outputHandler = new OutputHandler(/* 8 params */);
  const promptBuilder = new PromptBuilder(/* 4 params */);
  const latexMediaManager = new LatexMediaManager(/* 2 params */);

  // Real logic:
  let shouldEnsureXmlStructure = /* computed from xmlStructureMode */;
  let totalRounds = /* computed from setting.maxRounds or agentType */;

  return { services, totalRounds, setActiveRun(), interrupt(), dispose() };
}
```

**Verdict:** KEEP - initializes 7+ services with computed configuration

### 4. Snapshot Pattern - Required by PersistedFlow

```typescript
// Required for structuredClone() in PersistedFlow
const snapshot = AgentWorkspaceState.toSnapshot();  // Class → plain object
const restored = AgentWorkspaceState.fromSnapshot(snapshot);  // Plain object → class
```

**Verdict:** KEEP - necessary for PersistedFlow serialization (uses structuredClone)

---

## Minor Refactoring Opportunities

### 1. buildCycleOptions() - Inlinable (Low Priority)

```typescript
// ToolUseFlowContext.ts - Only adds 3 fields to base
export function buildCycleOptions(services, store) {
  return {
    ...buildBaseCycleOptions(services),  // Delegates 80%
    agentSetting: { ...setting, tools: resolvedTools },
    toolRegistry,
    modelName: config.model,
    agentName: config.agent,
  };
}
```

**Called from:** 2 locations
**Verdict:** Inlinable but low priority - doesn't save much

### 2. Thin Nodes with Minimal prep/post

Some nodes have trivial prep/post phases:
- ResponseCycleFinalizeNode - just calls shared helper
- RoundCompleteNode - just checks result kind

**Verdict:** Keep for architectural consistency with PocketFlow

---

## Summary

| Finding | Type | Action | Status |
|---------|------|--------|--------|
| AgentSharedStore | OVERHEAD | **REMOVE** - pass state slices directly | ✅ FIXED |
| Unnecessary spreads in toSnapshot() | OVERHEAD | Optimized with store removal | ✅ FIXED |
| buildCycleOptions() store param | OVERHEAD | Removed unused parameter | ✅ FIXED |
| buildBaseCycleOptions() | DRY | Keep - called 3x | N/A |
| RetryableInvocationNode | DRY | Keep - eliminates duplication | N/A |
| Context factories | JUSTIFIED | Keep - contain real logic | N/A |
| Snapshot pattern | REQUIRED | Keep - PersistedFlow needs it | N/A |

---

## Refactoring Applied

The AgentSharedStore overhead has been completely eliminated:

1. **Removed unused `store` parameter** from `buildCycleOptions()` - it was never used
2. **`prepareInitialState()`** now returns individual state slices directly:
   - `runState: AgentRunState`
   - `workspaceState: AgentWorkspaceState`
   - `userChannels: UserVariableChannels`
3. **`ToolUseRunState`** now stores individual snapshots:
   - `stateSlices: { runStateSnapshot, workspaceSnapshot, userChannels }`
4. **`ToolUseCycleNode`** reconstructs states directly from snapshots:
   - `AgentRunState.fromSnapshot(stateSlices.runStateSnapshot)`
   - `AgentWorkspaceState.fromSnapshot(stateSlices.workspaceSnapshot)`
5. **`ToolUseSessionLifecycle`** no longer holds store reference - removed `setStore()`/`getStore()`
6. **Snapshot schema v2** - state slices stored directly at top level (no `store` wrapper)
7. **`AgentSharedStore.ts` deleted** - no longer needed

**Files changed:**
- `src/agent/implementations/flows/ToolUseRunFlow.ts`
- `src/agent/implementations/flows/tooluse/ToolUseFlowContext.ts`
- `src/agent/implementations/flows/tooluse/ToolUseServices.ts`
- `src/agent/implementations/flows/tooluse/ToolUseSessionLifecycle.ts`
- `src/agent/implementations/flows/tooluse/ToolUseSessionTypes.ts`
- `src/test/agent/toolUse/ToolUseFollowUp.test.ts`

**Files deleted:**
- `src/agent/core/AgentSharedStore.ts`
