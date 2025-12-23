# PocketFlow Design Principles Analysis

This document analyzes how TeXRA follows PocketFlow design principles and identifies areas for improvement.

## Core PocketFlow Design Principles

### Principle 1: Separation of Concerns (prep → exec → post)

The fundamental pattern is a three-stage lifecycle:

```mermaid
flowchart LR
    subgraph Node["Node Lifecycle"]
        prep["prep(shared)"]
        exec["exec(prepRes)"]
        post["post(shared, prepRes, execRes)"]
        prep --> exec --> post
    end

    shared[(Shared Store)] -.->|read| prep
    prep -->|prepRes| exec
    exec -->|execRes| post
    post -.->|write| shared
    post -->|action| next[Next Node]
```

**Key Constraints:**
| Stage | Reads | Writes | Purpose |
|-------|-------|--------|---------|
| `prep` | shared | - | Extract data for computation |
| `exec` | prepRes only | - | Pure computation (LLM calls, APIs) |
| `post` | shared, prepRes, execRes | shared | Side effects, state updates |

### Principle 2: Graph + Shared Store Model

```mermaid
flowchart TB
    subgraph Flow["Flow Orchestration"]
        direction LR
        N1[Node A] -->|action| N2[Node B]
        N2 -->|action| N3[Node C]
        N1 -->|"branch"| N4[Node D]
    end

    SharedStore[(Shared Store<br/>Heap-like)]
    Params[("Params<br/>Stack-like")]

    SharedStore <-.->|"all nodes"| Flow
    Params -.->|"per-flow"| Flow
```

**Communication Patterns:**

- **Shared Store**: Global mutable state (heap), nodes read in `prep`, write in `post`
- **Params**: Immutable per-node config (stack), set by parent flow

### Principle 3: Retry as Built-in Concern

```mermaid
flowchart TD
    subgraph Node["Node with Retry"]
        _exec["_exec() retry loop"]
        exec["exec()"]
        fallback["execFallback()"]

        _exec -->|try| exec
        exec -->|error| retry{"retry < max?"}
        retry -->|yes + wait| _exec
        retry -->|no| fallback
        exec -->|success| done[Return result]
        fallback --> done
    end
```

### Principle 4: Services Pattern

```mermaid
flowchart TB
    subgraph "Correct Separation"
        direction TB
        Shared["shared (mutable state)<br/>- cycle state<br/>- retry state<br/>- messages"]
        Params["_params.services (immutable)<br/>- options<br/>- store<br/>- modelHandler"]
    end

    prep -->|reads| Shared
    exec -->|reads| Params
    post -->|writes| Shared
```

---

## TeXRA Compliance Analysis

### What TeXRA Does Well

#### 1. Services Pattern Implementation

TeXRA correctly separates mutable state (`shared`) from immutable services (`_params.services`):

```typescript
// Good: ResponseCycleShared separates concerns
interface ResponseCycleShared<C> {
  state: ResponseCycleState; // Mutable runtime state
  retryState: RetryState; // Mutable retry tracking
}

// Good: Services passed via params
interface ResponseCycleParams<C> {
  services: ResponseCycleServices<C>; // Immutable
}
```

#### 2. Clear Flow Transitions

TeXRA uses an enum for transitions, making flow logic explicit:

```typescript
// Good: Explicit transition names
export enum FlowTransition {
  COMPLETE = 'complete',
  CONTINUE = 'continue',
  FINALIZE = 'finalize',
  AWAIT_RETRY = 'await_retry',
  MANUAL_RETRY = 'manual_retry',
}
```

#### 3. Built-in Retry with Fallback

`ResponseModelInvocationNode` correctly extends `Node` for automatic retry:

```typescript
// Good: Leverages PocketFlow retry
class ResponseModelInvocationNode<C> extends Node<...> {
  constructor() {
    const config = getNodeRetryConfig();
    super(config.maxRetries, config.wait);  // Built-in retry
  }

  async execFallback(...): Promise<...> {
    // Graceful degradation
  }
}
```

---

### Areas Violating PocketFlow Principles

#### Violation 1: `exec()` Accessing Shared State

**Principle**: `exec()` should ONLY use `prepRes`, never access `shared`.

```mermaid
flowchart LR
    subgraph Violation["ResponseProcessNode.exec()"]
        exec["exec(shared)"]
        shared[(shared)]
        exec -.->|"VIOLATION"| shared
    end

    style exec fill:#ffcccc
    style shared fill:#ffcccc
```

**Current Code (ResponseProcessNode, lines 444-563):**

```typescript
async exec(shared: ResponseCycleShared<C>): Promise<ProcessNodeResult> {
  const { options, store } = this._params.services;
  const { state } = shared;  // VIOLATION: accessing shared in exec
  if (state.shouldStop || !state.responseObject) { ... }
```

**Affected Nodes:**
| Node | File:Line | Issue |
|------|-----------|-------|
| `ResponseProcessNode` | ResponseCycleFlow.ts:444 | `exec()` receives and reads `shared` |
| `ResponseContinuationNode` | ResponseCycleFlow.ts:696 | `exec()` receives and reads `shared` |
| `ToolUseProcessNode` | ToolUseCycleFlow.ts:445 | `exec()` receives and reads `shared` |
| `ToolUseDispatchNode` | ToolUseCycleFlow.ts:644 | `exec()` receives and reads `shared` |

**Impact**:

- Breaks isolation - `exec()` should be a pure function
- Makes retries potentially non-idempotent
- Harder to test in isolation

#### Violation 2: `prep()` Returning Entire Shared Object

**Principle**: `prep()` should extract ONLY the data needed by `exec()`.

```mermaid
flowchart LR
    subgraph Correct["Correct Pattern"]
        prep1["prep(shared)"] --> extract1["return { field1, field2 }"]
    end

    subgraph Violation["TeXRA Pattern"]
        prep2["prep(shared)"] --> extract2["return shared"]
        style extract2 fill:#ffcccc
    end
```

**Current Code:**

```typescript
// ResponseProcessNode.prep() - line 440
async prep(shared: ResponseCycleShared<C>): Promise<ResponseCycleShared<C>> {
  return shared;  // VIOLATION: returns entire shared object
}
```

**Correct Pattern Would Be:**

```typescript
async prep(shared: ResponseCycleShared<C>): Promise<{
  shouldStop: boolean;
  responseObject: unknown;
  responseTime?: number;
}> {
  const { state } = shared;
  return {
    shouldStop: state.shouldStop,
    responseObject: state.responseObject,
    responseTime: state.responseTime,
  };
}
```

#### Violation 3: Side Effects in `exec()`

**Principle**: `exec()` is for pure computation; side effects belong in `post()`.

**Current Code (ToolUseProcessNode.exec(), lines 445-572):**

```typescript
async exec(shared: ToolUseCycleShared<C>): Promise<...> {
  // ...
  store.round.addResponseTime(state.responseTime);  // SIDE EFFECT
  store.round.setNormalizedUsage(normalizedUsage);  // SIDE EFFECT
  store.workspace.assembly.updateLastResponse(text); // SIDE EFFECT
  // ...
}
```

**Side Effects Found in `exec()`:**
| Node | Side Effect | Should Be In |
|------|-------------|--------------|
| `ToolUseProcessNode` | `store.round.addResponseTime()` | `post()` |
| `ToolUseProcessNode` | `store.round.setNormalizedUsage()` | `post()` |
| `ToolUseProcessNode` | `store.workspace.assembly.updateLastResponse()` | `post()` |
| `ResponseProcessNode` | `store.round.setNormalizedUsage()` | `post()` |

---

## Compliance Summary Diagram

```mermaid
pie title PocketFlow Principle Compliance
    "Compliant" : 60
    "Partial Violations" : 30
    "Significant Violations" : 10
```

```mermaid
flowchart TB
    subgraph "Compliance Scorecard"
        direction TB

        subgraph Good["Well Implemented"]
            G1["Services Pattern"]
            G2["Flow Transitions"]
            G3["Retry Architecture"]
            G4["Shared Store Slices"]
            G5["Node Class Hierarchy"]
        end

        subgraph Needs["Needs Improvement"]
            N1["exec() accessing shared"]
            N2["prep() returning shared"]
            N3["Side effects in exec()"]
            N4["Large node methods"]
        end
    end

    style G1 fill:#90EE90
    style G2 fill:#90EE90
    style G3 fill:#90EE90
    style G4 fill:#90EE90
    style G5 fill:#90EE90
    style N1 fill:#FFB6C1
    style N2 fill:#FFB6C1
    style N3 fill:#FFB6C1
    style N4 fill:#FFFACD
```

---

## Recommendations for Better Compliance

### 1. Strict prep/exec/post Separation

**Refactor `ResponseProcessNode`:**

```typescript
// BEFORE (violates principles)
async prep(shared) { return shared; }
async exec(shared) { /* reads shared, has side effects */ }

// AFTER (compliant)
interface ProcessPrepResult {
  shouldStop: boolean;
  responseObject: unknown;
  responseTime?: number;
  messages: ProviderMessage[];
  outputLocation: AgentFileLocation;
}

async prep(shared: ResponseCycleShared<C>): Promise<ProcessPrepResult> {
  const { state } = shared;
  return {
    shouldStop: state.shouldStop,
    responseObject: state.responseObject,
    responseTime: state.responseTime,
    messages: state.messages,
    outputLocation: state.outputLocation!,
  };
}

async exec(prepRes: ProcessPrepResult): Promise<ProcessNodeResult> {
  if (prepRes.shouldStop || !prepRes.responseObject) {
    return { skipped: true };
  }
  // Pure computation - no shared access, no store mutations
  // Return data; let post() handle side effects
}

async post(shared, prepRes, execRes): Promise<string | undefined> {
  // All side effects here
  const { store } = this._params.services;
  store.round.addResponseTime(execRes.responseTime);
  store.round.setNormalizedUsage(execRes.normalizedUsage);
  // ...
}
```

### 2. Create Typed PrepResult Interfaces

For each node, define explicit prep result types:

```mermaid
classDiagram
    class InvocationPrepResult {
        +boolean shouldStop
        +ProviderMessage[] messages
        +string systemPrompt
    }

    class ProcessPrepResult {
        +boolean shouldStop
        +unknown responseObject
        +number responseTime
        +ProviderMessage[] messages
    }

    class ContinuationPrepResult {
        +boolean shouldStop
        +ProviderStopReason stopReason
        +string processedResponse
    }

    class DispatchPrepResult {
        +boolean shouldStop
        +SdkToolCall[] toolCalls
        +string text
    }
```

### 3. Move Side Effects to `post()`

**Principle**: All state mutations happen in `post()`. This makes retry safe.

```typescript
// Pattern: exec() returns data, post() applies it
async exec(prepRes): Promise<{
  normalizedUsage: NormalizedUsage;
  lastResponse: string;
  // ... other computed values
}> {
  // Pure computation only
  return { normalizedUsage, lastResponse };
}

async post(shared, prepRes, execRes): Promise<string> {
  const { store } = this._params.services;
  // Safe to apply side effects here (outside retry loop)
  store.round.setNormalizedUsage(execRes.normalizedUsage);
  store.workspace.assembly.updateLastResponse(execRes.lastResponse);
  return undefined;
}
```

### 4. Consider Smaller, Focused Nodes

The current `ResponseProcessNode` and `ToolUseDispatchNode` do many things. Consider splitting:

```mermaid
flowchart LR
    subgraph Current["Current: Large Node"]
        ProcessNode["ResponseProcessNode<br/>~200 lines"]
    end

    subgraph Proposed["Proposed: Focused Nodes"]
        Extract["ExtractResponseNode"]
        Transform["TransformResponseNode"]
        Persist["PersistResponseNode"]
        Extract --> Transform --> Persist
    end
```

---

## Architecture Diagram: Current vs Ideal

### Current Architecture

```mermaid
flowchart TB
    subgraph ResponseCycleFlow["ResponseCycleFlow"]
        PrepNode["ResponsePrepNode<br/>prep: extracts data<br/>post: writes state"]
        InvokeNode["ResponseModelInvocationNode<br/>prep: extracts data<br/>exec: model call<br/>post: writes response"]
        ProcessNode["ResponseProcessNode<br/>prep: returns shared<br/>exec: reads shared + side effects<br/>post: writes state"]
        ContNode["ResponseContinuationNode<br/>prep: returns shared<br/>exec: reads shared<br/>post: writes state"]

        PrepNode --> InvokeNode
        InvokeNode --> ProcessNode
        ProcessNode --> ContNode
        ContNode -->|CONTINUE| PrepNode
    end

    style ProcessNode fill:#FFB6C1
    style ContNode fill:#FFB6C1
```

### Ideal Architecture

```mermaid
flowchart TB
    subgraph ResponseCycleFlow["ResponseCycleFlow (Compliant)"]
        PrepNode["ResponsePrepNode<br/>prep: extracts data<br/>exec: none<br/>post: writes state"]
        InvokeNode["ResponseModelInvocationNode<br/>prep: extracts shouldStop, messages<br/>exec: pure model call<br/>post: writes response"]
        ProcessNode["ResponseProcessNode<br/>prep: extracts responseObject, etc<br/>exec: pure transformation<br/>post: writes all state changes"]
        ContNode["ResponseContinuationNode<br/>prep: extracts stopReason, response<br/>exec: pure decision logic<br/>post: writes state + action"]

        PrepNode --> InvokeNode
        InvokeNode --> ProcessNode
        ProcessNode --> ContNode
        ContNode -->|CONTINUE| PrepNode
    end

    style PrepNode fill:#90EE90
    style InvokeNode fill:#90EE90
    style ProcessNode fill:#90EE90
    style ContNode fill:#90EE90
```

---

## Summary: Action Items

| Priority | Issue                       | Fix                                   |
| -------- | --------------------------- | ------------------------------------- |
| High     | `exec()` accessing `shared` | Refactor to only use `prepRes`        |
| High     | Side effects in `exec()`    | Move all mutations to `post()`        |
| Medium   | `prep()` returning `shared` | Extract specific fields needed        |
| Low      | Large node methods          | Consider splitting into focused nodes |

By following these recommendations, TeXRA will achieve:

1. **Testability**: `exec()` becomes a pure function
2. **Retry Safety**: Side effects only in `post()`, after retry loop
3. **Clarity**: Clear data flow through node lifecycle
4. **Maintainability**: Smaller, focused nodes easier to modify

---

# Part 2: Abstraction Layer Analysis

## The Problem: 10 Layers Deep

```
┌─────────────────────────────────────────┐
│  runAgentFlow()                         │  Layer 10
├─────────────────────────────────────────┤
│  Agent-Specific Flows                   │  Layer 9
│  (ReflectionRunFlow / ToolUseRunFlow)   │
├─────────────────────────────────────────┤
│  createAgentRunFlow()                   │  Layer 8
├─────────────────────────────────────────┤
│  buildRunFlow()                         │  Layer 7
├─────────────────────────────────────────┤
│  AgentInitNode + createFinalizeNode()   │  Layer 6
├─────────────────────────────────────────┤
│  lifecycle helpers (5 functions)        │  Layer 5
├─────────────────────────────────────────┤
│  nodeExecution wrappers                 │  Layer 4
├─────────────────────────────────────────┤
│  CycleFlows (ResponseCycle/ToolUse)     │  Layer 3
├─────────────────────────────────────────┤
│  RetryState + CycleServices             │  Layer 2
├─────────────────────────────────────────┤
│  PocketFlow (BaseNode, Flow)            │  Layer 1
└─────────────────────────────────────────┘
```

---

## Workflow Agent vs Tool-Use Agent: Deep Comparison

### Architectural Diagram

```mermaid
flowchart TB
    subgraph Shared["Shared Infrastructure"]
        direction TB
        createAgentRunFlow["createAgentRunFlow()"]
        buildRunFlow["buildRunFlow()"]
        AgentInitNode["AgentInitNode"]
        createFinalizeNode["createAgentFinalizeNode()"]
        lifecycle["lifecycle helpers<br/>(5 functions)"]
        nodeExecution["runNodeExecution()<br/>runNodeEffect()"]

        createAgentRunFlow --> buildRunFlow
        createAgentRunFlow --> AgentInitNode
        buildRunFlow --> createFinalizeNode
        AgentInitNode --> lifecycle
        AgentInitNode --> nodeExecution
    end

    subgraph Reflection["Reflection Agent"]
        direction TB
        R_Flow["ReflectionRunFlow"]
        R_RoundNode["ReflectionRoundNode<br/>(1 node)"]
        R_Hooks["ReflectionRunHooks<br/>(3 extra methods)"]
        R_State["ReflectionRunState<br/>(5 fields)"]

        R_Flow --> R_RoundNode
    end

    subgraph ToolUse["Tool-Use Agent"]
        direction TB
        T_Flow["ToolUseRunFlow"]
        T_PrepNode["ToolUsePrepareNode"]
        T_CycleNode["ToolUseCycleNode"]
        T_Hooks["ToolUseRunHooks<br/>(12 extra methods!)"]
        T_State["ToolUseRunState<br/>(5 fields)"]
        T_CycleFlow["ToolUseCycleFlow<br/>(4 proper nodes)"]

        T_Flow --> T_PrepNode --> T_CycleNode
        T_CycleNode -.->|delegates to| T_CycleFlow
    end

    Shared --> Reflection
    Shared --> ToolUse

    style lifecycle fill:#FFB6C1
    style nodeExecution fill:#FFB6C1
    style T_Hooks fill:#FFB6C1
```

---

## Side-by-Side Comparison

| Aspect              | Reflection Agent                | Tool-Use Agent                           |
| ------------------- | ------------------------------- | ---------------------------------------- |
| **Purpose**         | Multi-round text generation     | Interactive tool calling                 |
| **Phases**          | idle → init → rounds → finalize | idle → init → prepare → cycle → finalize |
| **Run-Level Nodes** | 1 (`ReflectionRoundNode`)       | 2 (`PrepareNode`, `CycleNode`)           |
| **Hooks Interface** | 3 extra methods                 | **12 extra methods**                     |
| **State Fields**    | 5 simple fields                 | 5 fields + nullable types                |
| **Sub-flows Used**  | None (inline)                   | `ToolUseCycleFlow` (4 nodes)             |
| **Complexity**      | Simple                          | High                                     |

---

## Reflection Agent: Simple Task, Over-Engineered

### What It Actually Does

```mermaid
flowchart LR
    Init["Initialize"] --> Round["Execute Round"]
    Round -->|"continue"| Round
    Round -->|"done"| Finalize["Finalize"]
```

**The actual logic is just a loop with 3 transitions.**

### What PocketFlow Needs (Minimal)

```typescript
// ~30 lines - pure PocketFlow
class RoundNode extends BaseNode<ReflectionShared> {
  async prep(shared) {
    return {
      agent: shared.agent,
      round: shared.currentRound,
      shouldFinalize: shared.currentRound >= shared.totalRounds,
    };
  }

  async exec(prepRes) {
    if (prepRes.shouldFinalize) return { done: true };
    return await prepRes.agent.executeRound(prepRes.round);
  }

  async post(shared, prep, exec) {
    if (exec.done) return 'finalize';
    shared.currentRound++;
    return exec.shouldContinue ? 'continue' : 'finalize';
  }
}

// Flow setup
const roundNode = new RoundNode();
roundNode.on('continue', roundNode);
const flow = new Flow(roundNode);
```

### What TeXRA Actually Has

```
createReflectionRunFlow() (225 lines)
├── createAgentRunFlow()
│   ├── new AgentInitNode(config)
│   │   ├── beginLifecyclePhase()
│   │   ├── runNodeEffect()
│   │   │   └── hooks.start() → hooks.init() → hooks.initializeClient()
│   │   └── failLifecycle() on error
│   ├── links({ init }) => [...]  ← callback returning array
│   └── buildRunFlow()
│       └── init.next(finalize).on(FINALIZE)
│           └── for (link of links) from.on(on, to)
├── createAgentFinalizeNode()
│   └── finalizeLifecycle()
│       ├── runFinalize()
│       └── runCleanup()
└── ReflectionRoundNode
    ├── agent.beginRound()
    └── agent.executeCurrentRound()
```

**7 layers of factories and wrappers for a simple loop.**

---

## Tool-Use Agent: Where's The Logic?

### The 12-Method Hooks Interface

```typescript
interface ToolUseRunHooks<C> extends AgentRunHooks {
  // State setup (2)
  prepareState(): Promise<{ messages; store; shouldSkipCycle }>;
  buildCycleOptions(store): ToolUseCycleOptions<C>;

  // Cycle execution (2)
  runCycle(options, messages, store): Promise<void>;
  persistCheckpoint(messages, store): Promise<void>;

  // Interruption (1)
  checkInterruption(): boolean;

  // Interactive session (6)
  hasQueuedFollowUp(): boolean;
  enterWaitingState(): Promise<void>;
  waitForFollowUp(): Promise<string | null>;
  markRunning(): Promise<void>;
  applyFollowUp(followUp, messages): Promise<ProviderMessage[]>;
  clearPersistedSnapshot(): Promise<void>;

  // Error handling (1)
  logFinalizeWarning?(message, error): void;
}
```

### ToolUseCycleNode.exec(): Just Calling Hooks!

```typescript
async exec(shared: ToolUseRunShared<C>): Promise<ToolUseCycleExecResult> {
  return runNodeExecution(async () => {
    while (true) {
      if (!state.shouldSkipCycle) {
        await hooks.runCycle(...);          // HOOK
        await hooks.persistCheckpoint(...); // HOOK
      }
      if (hooks.checkInterruption()) return; // HOOK

      if (hooks.hasQueuedFollowUp()) {       // HOOK
        await hooks.clearPersistedSnapshot(); // HOOK
      } else {
        await hooks.enterWaitingState();     // HOOK
      }

      const followUp = await hooks.waitForFollowUp(); // HOOK
      if (!followUp) return;

      await hooks.markRunning();             // HOOK
      await hooks.clearPersistedSnapshot();  // HOOK
      await hooks.applyFollowUp(...);        // HOOK
    }
  });
}
```

**The node is just an orchestrator calling 10 hooks in a loop!**

---

## The Abstraction Inversion Problem

```mermaid
flowchart TB
    subgraph Current["Current: Logic in Hooks"]
        RunFlow["ToolUseRunFlow<br/>(thin shell)"]
        Hooks["Hooks Object<br/>(12 methods, ALL logic)"]
        CycleFlow["ToolUseCycleFlow<br/>(proper PocketFlow)"]

        RunFlow -->|"delegates to"| Hooks
        Hooks -->|"calls internally"| CycleFlow
    end

    subgraph Ideal["Ideal: Logic in Nodes"]
        RunFlow2["ToolUseRunFlow"]
        WaitNode["WaitForInputNode"]
        ApplyNode["ApplyFollowUpNode"]
        CycleFlow2["ToolUseCycleFlow"]
        Agent2["Agent<br/>(minimal callbacks)"]

        RunFlow2 -->|"contains"| WaitNode
        RunFlow2 -->|"contains"| ApplyNode
        RunFlow2 -->|"contains"| CycleFlow2
        WaitNode -->|"simple callback"| Agent2
    end

    style Hooks fill:#FFB6C1
    style WaitNode fill:#90EE90
    style ApplyNode fill:#90EE90
```

---

## Quantified Analysis

### Lines of Code by Layer

| Layer                  | Lines | Purpose                       | Justified?    |
| ---------------------- | ----- | ----------------------------- | ------------- |
| PocketFlow Core        | 210   | Framework                     | ✅ Yes        |
| CycleFlows             | 1,817 | Response/ToolUse cycles       | ✅ Yes        |
| common/ infrastructure | ~600  | Builders, lifecycle, wrappers | ⚠️ Partially  |
| Run Flows              | 492   | Orchestration                 | ❌ Over-built |

**600 lines of infrastructure to support 492 lines of run flows**

### Node Distribution

```mermaid
pie title "Node Categories"
    "CycleFlow Nodes (proper PocketFlow)" : 8
    "RunFlow Nodes (hook wrappers)" : 5
```

- **CycleFlows**: 8 nodes doing real work (model calls, tool dispatch)
- **RunFlows**: 5 nodes that mostly delegate to hooks

---

## What Should Be Nodes vs Hooks

### Current State

| Component           | Implementation | Problem                      |
| ------------------- | -------------- | ---------------------------- |
| Wait for follow-up  | Hook method    | Should be a WaitNode         |
| Apply follow-up     | Hook method    | Should be an ApplyNode       |
| Persist checkpoint  | Hook method    | Could be a PersistNode       |
| Enter waiting state | Hook method    | UI concern, maybe ok as hook |
| Check interruption  | Hook method    | Cross-cutting, ok as hook    |

### Proposed Split

```mermaid
flowchart LR
    subgraph Nodes["Should Be Nodes"]
        WaitNode["WaitForInputNode"]
        ApplyNode["ApplyFollowUpNode"]
        PersistNode["PersistCheckpointNode"]
    end

    subgraph Hooks["Can Stay as Hooks"]
        checkInterruption["checkInterruption()"]
        enterWaitingState["enterWaitingState()"]
    end

    style Nodes fill:#90EE90
    style Hooks fill:#E6E6FA
```

---

## Specific Recommendations

### 1. Reflection Agent: Flatten to Single File

```typescript
// From 225 lines across 5 files → 80 lines in 1 file
export class ReflectionFlow<C> extends Flow<ReflectionShared<C>> {
  constructor(agent: BaseReflectionAgent<C>) {
    const initNode = new InitNode(agent);
    const roundNode = new RoundNode(agent);
    const finalizeNode = new FinalizeNode(agent);

    initNode.next(roundNode);
    roundNode.on('continue', roundNode);
    roundNode.on('finalize', finalizeNode);

    super(initNode);
  }
}
```

### 2. Tool-Use Agent: Move Hook Logic into Nodes

```typescript
// Instead of hooks.waitForFollowUp() called from exec()
class WaitForInputNode extends BaseNode<ToolUseShared> {
  async prep(shared) {
    return { streamId: shared.streamId, hasQueued: shared.hasQueuedFollowUp };
  }

  async exec(prepRes) {
    if (prepRes.hasQueued) return { followUp: shared.queuedFollowUp };
    return { followUp: await this.waitForInput(prepRes.streamId) };
  }

  async post(shared, prep, exec) {
    if (!exec.followUp) return 'finalize';
    shared.pendingFollowUp = exec.followUp;
    return 'apply';
  }
}
```

### 3. Remove Wrapper Layers

| Remove                                    | Replace With                         |
| ----------------------------------------- | ------------------------------------ |
| `buildRunFlow()` + `createAgentRunFlow()` | Single `createFlow()`                |
| `runNodeExecution()` / `runNodeEffect()`  | Inline try/catch                     |
| 5 lifecycle setters                       | Single `lifecycle.transition(phase)` |
| `NodeExecResult<T>` discriminated union   | Native Promise + error               |
| `links()` callback pattern                | Direct `node.on()` calls             |

### 4. Reduce Hook Interface

```typescript
// From 12+4 = 16 methods
interface ToolUseRunHooks {
  // 16 methods...
}

// To 5 essential callbacks
interface ToolUseCallbacks {
  onCycleComplete(messages: Message[]): Promise<void>;
  onWaitingForInput(): Promise<void>;
  onError(error: Error): void;
  shouldInterrupt(): boolean;
  persistState(snapshot: Snapshot): Promise<void>;
}
```

---

## Summary: Workflow vs Tool-Use

|                           | Workflow Agent            | Tool-Use Agent            |
| ------------------------- | ------------------------- | ------------------------- |
| **Complexity Justified?** | ❌ No                     | ⚠️ Partially              |
| **Core Issue**            | 7 layers for a loop       | Logic in hooks, not nodes |
| **CycleFlow Quality**     | N/A (uses agent directly) | ✅ Good                   |
| **RunFlow Quality**       | ❌ Over-abstracted        | ❌ Just hook orchestrator |
| **Fix**                   | Flatten entirely          | Move logic into nodes     |

### The Key Insight

**CycleFlows are proper PocketFlow** — they have real nodes doing real work (model invocation, tool dispatch, response processing).

**RunFlows are NOT PocketFlow** — they're just hook orchestrators wearing a PocketFlow costume. The nodes are shells that delegate everything to callback interfaces.

This creates a split personality:

- Bottom layer (CycleFlows): Clean, node-based architecture
- Top layer (RunFlows): Callback-based architecture pretending to be nodes

### Recommendation Priority

| Priority   | Change                                         | Impact                      |
| ---------- | ---------------------------------------------- | --------------------------- |
| **High**   | Flatten ReflectionRunFlow                      | Remove 5+ files, ~500 lines |
| **High**   | Move ToolUse hook logic into nodes             | True PocketFlow compliance  |
| **Medium** | Merge buildRunFlow + createAgentRunFlow        | Remove indirection          |
| **Medium** | Replace 5 lifecycle helpers with state machine | Cleaner state management    |
| **Low**    | Remove NodeExecResult wrappers                 | Minor cleanup               |
