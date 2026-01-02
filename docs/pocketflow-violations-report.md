# PocketFlow Dual Logical Path Violations Report

This report documents violations of PocketFlow's dual logical path pattern for native usage of nodes and flows in the TeXRA codebase.

## Overview

The **dual logical path** is the core innovation of PocketFlow where every Node executes in three distinct phases:

```
prep() → exec() → post()
```

**The two logical paths are:**
1. **Data Path (prep → post)**: Interacts with the shared store
2. **Compute Path (exec)**: Pure compute logic - MUST NOT access shared store

---

## Summary of Violations

| Category | Count | Severity |
|----------|-------|----------|
| exec() Shared Store Access | 3 | High |
| Lifecycle Pattern Violations | 5 | High/Medium |
| Flow Wiring Violations | 2 | High |
| Service Access Violations | 1 | Minor |
| State/Snapshot Violations | 0 | - |

**Total: 11 violations identified**

---

## Category 1: exec() Shared Store Access Violations

### Violation 1.1: MediaExtractionNode

**File:** `src/agent/implementations/flows/reflection/nodes/MediaExtractionNode.ts`
**Lines:** 125-139
**Severity:** Medium (documented exception)

**Issue:** The `exec()` method mutates `prepRes.workspaceState` by passing it to `latexMediaManager.processInputFiles()` and `processOutputFiles()`.

```typescript
async exec(prepRes: MediaPrepInput): Promise<MediaExecResult> {
  // ...
  await latexMediaManager.processInputFiles(
    prepRes.files,
    prepRes.workspaceState,  // ← MUTATION: workspaceState is mutated here
    config.toolConfig,
    true,
    prepRes.extraMediaFiles,
  );
}
```

**Note:** Code includes documented exception citing NODE_NO_RETRY.

---

### Violation 1.2: ToolUseCycleNode - setOnUpdate in exec()

**File:** `src/agent/implementations/flows/ToolUseRunFlow.ts`
**Lines:** 337-343
**Severity:** High

**Issue:** The `exec()` method calls `setOnUpdate()` on `prepRes.store.workspace.todos`, which mutates workspace state.

```typescript
async exec(prepRes: CycleNodePrepResult<C>): Promise<CycleExecResult> {
  prepRes.store.workspace.todos.setOnUpdate((todos: TodoItem[]) => {
    bus.emit('updateTodos', { ... });
  });
}
```

---

### Violation 1.3: ToolUseWaitNode - State Mutation + Blocking I/O

**File:** `src/agent/implementations/flows/ToolUseRunFlow.ts`
**Lines:** 438-461
**Severity:** High

**Issue:** The `exec()` method:
1. Calls `session.enterWaitingState()` which mutates session state (line 449)
2. Performs blocking I/O with `session.waitForFollowUp()` (line 454)

```typescript
async exec(prepRes: WaitNodePrepResult): Promise<WaitExecResult> {
  const { hasQueuedFollowUp, session } = prepRes;

  if (!hasQueuedFollowUp) {
    await session.enterWaitingState();  // ← State mutation
  }

  const followUp = await session.waitForFollowUp(checkInterruption);  // ← Blocking I/O
}
```

---

## Category 2: Lifecycle Pattern Violations

### Violation 2.1: ToolUsePrepareNode - Empty prep()

**File:** `src/agent/implementations/flows/ToolUseRunFlow.ts`
**Lines:** 213-230
**Severity:** Medium

**Issue:** The `prep()` method is empty; `exec()` directly accesses `this.services`.

```typescript
async prep(_shared: ToolUseRunShared): Promise<void> {
  // No prep needed - services accessed via this.services
}

async exec(_prepRes: void): Promise<...> {
  const prepared = await prepareInitialState(this.services);  // ← Should use prepRes
  const cycleOptions = await buildCycleOptions(this.services, prepared.store);
}
```

---

### Violation 2.2: ToolUseDispatchNode - Tool Execution in post()

**File:** `src/agent/core/flows/ToolUseCycleFlow.ts`
**Lines:** 868-968
**Severity:** High

**Issue:** The actual tool execution happens in `post()` via `executeToolCall()`, when computational work should be in `exec()`.

```typescript
async exec(prepRes): Promise<...> {
  return { kind: 'success', calls: prepRes.toolCalls };  // ← Just returns calls, no execution
}

async post(shared, prepRes, execRes): Promise<...> {
  for (const call of calls) {
    const execResult = await this.executeToolCall(...);  // ← I/O in post()
  }
}
```

---

### Violation 2.3: ResponseCycleFinalizeNode - Non-Standard Signatures

**File:** `src/agent/core/flows/ResponseCycleFlow.ts`
**Lines:** 682-703
**Severity:** High

**Issue:** Node has non-standard method signatures that lack required parameters.

```typescript
async exec(): Promise<void> {  // ← Missing prepRes parameter
  await finalizeRound(this.services);
}

async post(): Promise<string | undefined> {  // ← Missing all parameters
  return undefined;
}
```

---

### Violation 2.4: ResponsePrepNode - Missing exec() Stage

**File:** `src/agent/core/flows/ResponseCycleFlow.ts`
**Lines:** 125-208
**Severity:** Medium

**Issue:** Node only implements `prep()` and `post()`, skipping `exec()` entirely. Computation happens directly in `prep()`.

---

### Violation 2.5: ToolUsePrepNode - Missing exec() Stage

**File:** `src/agent/core/flows/ToolUseCycleFlow.ts`
**Lines:** 196-250
**Severity:** Medium

**Issue:** Like ResponsePrepNode, this node implements only `prep()` and `post()`, skipping `exec()`.

---

## Category 3: Flow Wiring Violations

### Violation 3.1: ToolUseRunFlow - Missing Default Successor

**File:** `src/agent/implementations/flows/ToolUseRunFlow.ts`
**Lines:** 517-536
**Severity:** High

**Issue:** The `ToolUseWaitNode` lacks a `.next()` successor but returns `FlowTransition.DEFAULT` from its `post()` method, creating a dead-end transition.

```typescript
export function createToolUseRunFlow<C = unknown>(): Flow<...> {
  prepareNode.next(cycleNode);
  cycleNode.next(waitNode);
  waitNode.on(FlowTransition.CONTINUE, cycleNode);
  // ❌ No .next() on waitNode, but post() returns FlowTransition.DEFAULT
}
```

---

### Violation 3.2: ToolUseCycleFlow - Missing COMPLETE Handlers

**File:** `src/agent/core/flows/ToolUseCycleFlow.ts`
**Lines:** 984-1004
**Severity:** High

**Issue:** Multiple nodes return `FlowTransition.COMPLETE` but the flow defines no `.on(FlowTransition.COMPLETE, ...)` handlers.

**Nodes returning unhandled COMPLETE:**
| Node | Line | Trigger |
|------|------|---------|
| ToolUsePrepNode | 234 | Interrupted |
| ToolUseCallNode | 378 | Error fallback |
| ToolUseProcessNode | 585, 627 | Skipped/End turn |
| ToolUseDispatchNode | 883 | Skipped/interrupted |

**Compare to ResponseCycleFlow (correct pattern):**
```typescript
prepNode.on(FlowTransition.COMPLETE, finalizeNode);
invokeNode.on(FlowTransition.COMPLETE, finalizeNode);
processNode.on(FlowTransition.COMPLETE, finalizeNode);
```

---

## Category 4: Service Access Pattern Violations

### Violation 4.1: WaitNodePrepResult Contains Session Service

**File:** `src/agent/implementations/flows/ToolUseRunFlow.ts`
**Lines:** 162-166, 429-436, 438-454
**Severity:** Minor

**Issue:** The `session` service is passed through `WaitNodePrepResult` instead of being accessed exclusively via `this.services`.

```typescript
interface WaitNodePrepResult {
  session: IToolUseSession;  // ← Service in prep result
}

async prep(shared): Promise<WaitNodePrepResult> {
  return { ..., session };  // ← Service passed through
}

async exec(prepRes): Promise<...> {
  const { session } = prepRes;  // ← Accessing from prepRes
}

async post(shared, _prepRes, execRes): Promise<...> {
  const session = this.services.session;  // ← Inconsistent: accessing from this.services
}
```

---

## Category 5: State/Snapshot Violations

**No violations found.** All implementations correctly:
- Store snapshots (serializable) instead of class instances
- Use `toSnapshot()`/`fromSnapshot()` conversions
- Keep non-serializable objects (callbacks, services) out of shared state

---

## Compliant Implementations (Reference)

The following nodes correctly follow the dual logical path pattern:

| File | Nodes |
|------|-------|
| PrepareContextNode.ts | PrepareContextNode |
| TeXCountNode.ts | TeXCountNode |
| RoundCompleteNode.ts | RoundCompleteNode |
| OutputNode.ts | OutputNode |
| ResponseCycleNode.ts | ResponseCycleNode |
| ResponseCycleFlow.ts | ResponseModelInvocationNode, ResponseProcessNode, ResponseContinuationNode |
| ToolUseCycleFlow.ts | ToolUseCallNode, ToolUseProcessNode |

**ReflectionFlow** is the gold-standard implementation with proper wiring:
- Linear main flow with explicit transitions
- All COMPLETE actions routed to finalize node
- Proper round continuation via `FlowTransition.CONTINUE_NEXT_ROUND`

---

## Recommended Fixes

### High Priority

1. **ToolUseCycleFlow** - Add `.on(FlowTransition.COMPLETE, ...)` handlers following ResponseCycleFlow pattern
2. **ToolUseRunFlow** - Add explicit `.next()` on waitNode or document DEFAULT as intentional flow end
3. **ToolUseDispatchNode** - Move tool execution from `post()` to `exec()`
4. **ResponseCycleFinalizeNode** - Restore standard method signatures with proper parameters

### Medium Priority

5. **ToolUseWaitNode** - Move `session.enterWaitingState()` to `post()`, blocking I/O to `prep()`
6. **ToolUsePrepareNode** - Move service extraction to `prep()`, update `exec()` to use prepRes
7. **ResponsePrepNode/ToolUsePrepNode** - Add proper `exec()` stage or document as intentional deviation

### Low Priority

8. **WaitNodePrepResult** - Remove session from prep result, access exclusively via `this.services`
9. **MediaExtractionNode** - Consider moving workspace mutation to `post()` (currently documented exception)

---

## Report Generated

Date: 2026-01-02
Files Analyzed: 27 flow-related files
Total Nodes Analyzed: 28 node classes
