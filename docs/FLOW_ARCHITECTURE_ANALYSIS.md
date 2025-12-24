# Agent Flow Architecture Analysis

## Executive Summary

The agent flow architecture in `src/agent/implementations/flows/` exhibits significant structural issues that create maintenance burden, reduce testability, and obscure the control flow. This document provides a comprehensive analysis with diagrams.

---

## 1. Architecture Overview

### 1.1 File Structure

```
src/agent/implementations/flows/
├── ToolUseRunFlow.ts          (371 lines) - Tool-use agent orchestration
├── ReflectionRunFlow.ts       (206 lines) - Workflow/CoT agent orchestration
└── common/                    (13 files)  - Shared infrastructure
    ├── AgentInitNode.ts       - Initialization node
    ├── AgentLifecycle.ts      - Phase/status state machine
    ├── AgentRunFlowRunner.ts  - Flow execution engine
    ├── buildRunFlow.ts        - Flow graph builder
    ├── createAgentRunFlow.ts  - Standard flow factory
    ├── createFinalizeNode.ts  - Finalization node factory
    ├── finalizeLifecycle.ts   - Lifecycle finalization logic
    ├── index.ts               - Barrel exports
    ├── nodeExecution.ts       - Result type utilities
    ├── runStateSchemas.ts     - Zod schemas for state
    └── types.ts               - Core type definitions
```

### 1.2 High-Level Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AGENT LAYER                                     │
├─────────────────────────────────┬───────────────────────────────────────────┤
│      BaseReflectionAgent        │         BaseToolUseAgent                  │
│  (DirectAgent, CoTAgent, etc.)  │                                           │
└────────────────┬────────────────┴─────────────────────┬─────────────────────┘
                 │                                       │
                 │ creates                               │ creates
                 ▼                                       ▼
┌─────────────────────────────────┐   ┌───────────────────────────────────────┐
│      ReflectionRunFlow          │   │         ToolUseRunFlow                │
│                                 │   │                                       │
│  Phases: idle→init→rounds→fin  │   │  Phases: idle→init→prepare→cycle→fin │
│                                 │   │                                       │
│  ┌─────────┐    ┌────────────┐  │   │  ┌─────────┐  ┌────────┐  ┌───────┐  │
│  │InitNode │───▶│RoundNode   │  │   │  │InitNode │─▶│PrepNode│─▶│CycleN │  │
│  └─────────┘    │ (loops via │  │   │  └─────────┘  └────────┘  │(while │  │
│                 │  CONTINUE) │  │   │                           │ true) │  │
│                 └────────────┘  │   │                           └───────┘  │
└────────────────┬────────────────┘   └─────────────────────┬─────────────────┘
                 │                                           │
                 │ uses                                      │ uses
                 ▼                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          COMMON INFRASTRUCTURE                               │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │AgentInitNode │  │AgentLifecycle  │  │FinalizeNode  │  │FlowRunner     │  │
│  │              │  │<Phase>         │  │              │  │               │  │
│  └──────────────┘  └────────────────┘  └──────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Critical Architectural Issues

### 2.1 Iteration Strategy Mismatch

The two flows use fundamentally different iteration strategies:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    REFLECTION FLOW (Flow-Level Looping)                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────┐      ┌──────────────┐      ┌──────────────┐                  │
│   │  Init    │─────▶│  RoundNode   │─────▶│  Finalize    │                  │
│   └──────────┘      └──────┬───────┘      └──────────────┘                  │
│                            │                     ▲                           │
│                            │ CONTINUE            │ FINALIZE                  │
│                            └─────────────────────┘                           │
│                                                                              │
│   ✓ Clean separation - each round is a node invocation                      │
│   ✓ State is explicit at each boundary                                       │
│   ✓ Easy to test individual rounds                                           │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    TOOL-USE FLOW (Internal While Loop)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────┐   ┌──────────┐   ┌─────────────────────────┐   ┌──────────┐  │
│   │  Init    │──▶│ Prepare  │──▶│      CycleNode          │──▶│ Finalize │  │
│   └──────────┘   └──────────┘   │  ┌───────────────────┐  │   └──────────┘  │
│                                 │  │   while(true) {   │  │                  │
│                                 │  │     runCycle()    │  │                  │
│                                 │  │     if (exit) ──────────▶ break        │
│                                 │  │     waitFollow()  │  │                  │
│                                 │  │     mutateState() │  │                  │
│                                 │  │   }               │  │                  │
│                                 │  └───────────────────┘  │                  │
│                                 └─────────────────────────┘                  │
│                                                                              │
│   ✗ All iteration buried in single exec() method                            │
│   ✗ State mutated inside loop (hidden side effects)                          │
│   ✗ 5 different exit paths with different return types                       │
│   ✗ Hard to test individual cycles                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Impact**: Cannot apply consistent patterns, testing strategies, or error handling across both flows.

---

### 2.2 Type Duplication and Explosion

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TYPE DEFINITION LOCATIONS                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   FlowLink<Shared> interface defined TWICE:                                  │
│   ├── buildRunFlow.ts:5-9                                                    │
│   └── createAgentRunFlow.ts:12-16                                            │
│                                                                              │
│   Generic constraint repeated 6 TIMES in AgentRunFlowRunner.ts:              │
│   │                                                                          │
│   │   Shared extends AgentRunShared<                                         │
│   │     BaseAgent<any>,                                                      │
│   │     any,                                                                 │
│   │     AgentLifecycle<string>,                                              │
│   │     AgentRunHooks                                                        │
│   │   >                                                                      │
│   │                                                                          │
│   ├── AgentRunFlowOptionsBase (line 9-15)                                    │
│   ├── AgentRunFlowOptionsWithExtend (line 25-30)                             │
│   ├── AgentRunFlowOptionsWithoutExtend (line 36-46)                          │
│   ├── AgentRunFlowOptions (line 48-57)                                       │
│   ├── hasExtendHooks (line 59-65)                                            │
│   └── runAgentFlow (line 75-81)                                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.3 Error Handling Fragmentation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THREE DIFFERENT ERROR HANDLING PATTERNS                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PATTERN A: Return { error } object                                         │
│   Location: AgentInitNode.ts:68-70                                           │
│   ┌─────────────────────────────────────────┐                               │
│   │ catch (error) {                         │                               │
│   │   return { error };  ◀── Caller checks  │                               │
│   │ }                                       │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                              │
│   PATTERN B: Accumulate in array, process later                              │
│   Location: finalizeLifecycle.ts:19-38                                       │
│   ┌─────────────────────────────────────────┐                               │
│   │ const errors: Error[] = [];             │                               │
│   │ try { ... } catch (e) { errors.push(e) }│                               │
│   │ try { ... } catch (e) { errors.push(e) }│                               │
│   │ if (errors[0]) lifecycle.fail(...)      │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                              │
│   PATTERN C: Callback-based error reporting                                  │
│   Location: createFinalizeNode.ts                                            │
│   ┌─────────────────────────────────────────┐                               │
│   │ onSecondaryError: (ctx, error) => {     │                               │
│   │   ctx.hooks.logFinalizeWarning?.(...)   │                               │
│   │ }                                       │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                              │
│   RESULT: Inconsistent recovery, hard to trace failures                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 2.4 Lifecycle Phase Transition Chaos

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PHASE TRANSITIONS ARE SCATTERED                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   TOOL-USE FLOW - Phase set in 4 different locations:                        │
│                                                                              │
│   1. AgentInitNode.exec()     → lifecycle.begin('init')                      │
│      File: AgentInitNode.ts:52                                               │
│                                                                              │
│   2. ToolUsePrepareNode.post() → lifecycle.begin('prepare')                  │
│      File: ToolUseRunFlow.ts:206                                             │
│                                                                              │
│   3. ToolUsePrepareNode.post() → lifecycle.begin('cycle')     ◀── SAME FILE │
│      File: ToolUseRunFlow.ts:222                                             │
│                                                                              │
│   4. ToolUseCycleNode.post()   → lifecycle.setStatus('running')              │
│      File: ToolUseRunFlow.ts:335                                             │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │ PROBLEM: Phase transitions happen in post() methods of DIFFERENT     │  │
│   │ nodes. The cycle phase is set by PrepareNode, not CycleNode!         │  │
│   │                                                                      │  │
│   │ PrepareNode.post() sets 'cycle' phase                                │  │
│   │          ↓                                                           │  │
│   │ CycleNode.prep() assumes 'cycle' already set (comment on line 233)   │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   REFLECTION FLOW - Single clean transition:                                 │
│   1. init.onSuccess() → lifecycle.begin('rounds')                            │
│      File: ReflectionRunFlow.ts:194                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Dependency and Coupling Analysis

### 3.1 Import Dependency Graph

```
                                    ┌─────────────────────┐
                                    │   @agent/node       │
                                    │  (Flow, BaseNode)   │
                                    └──────────┬──────────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    │                          │                          │
                    ▼                          ▼                          ▼
          ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
          │  types.ts       │        │ AgentLifecycle  │        │ runStateSchemas │
          │                 │        │                 │        │                 │
          │ AgentRunShared  │◀───────│ Lifecycle class │        │ Zod schemas     │
          │ AgentRunHooks   │        │                 │        │                 │
          └────────┬────────┘        └────────┬────────┘        └────────┬────────┘
                   │                          │                          │
                   └────────────┬─────────────┴──────────────────────────┘
                                │
                                ▼
          ┌─────────────────────────────────────────────────────────────────┐
          │                    AgentRunFlowRunner.ts                         │
          │                                                                  │
          │  runAgentFlow() - Main execution engine                          │
          │  - Creates shared state                                          │
          │  - Manages hook extension                                        │
          │  - Propagates errors                                             │
          └──────────────────────────────┬──────────────────────────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
              ▼                          ▼                          ▼
    ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
    │ AgentInitNode   │        │ buildRunFlow    │        │createFinalizeN. │
    │                 │        │                 │        │                 │
    │ Generic init    │        │ Flow graph      │        │ Finalize node   │
    │ phase handler   │        │ builder         │        │ factory         │
    └────────┬────────┘        └────────┬────────┘        └────────┬────────┘
             │                          │                          │
             └──────────────────────────┼──────────────────────────┘
                                        │
                                        ▼
                            ┌───────────────────────┐
                            │ createAgentRunFlow    │
                            │                       │
                            │ Standard flow factory │
                            │ init → nodes → final  │
                            └───────────┬───────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    │                                       │
                    ▼                                       ▼
          ┌─────────────────────┐               ┌─────────────────────┐
          │ ReflectionRunFlow   │               │  ToolUseRunFlow     │
          │                     │               │                     │
          │ Uses:               │               │ Uses:               │
          │ - createAgentRunFlow│               │ - createAgentRunFlow│
          │ - AgentInitNode     │               │ - AgentInitNode     │
          │ - createStandardFin │               │ - createStandardFin │
          │ + ReflectionRoundN. │               │ + ToolUsePrepareN.  │
          │                     │               │ + ToolUseCycleNode  │
          └─────────────────────┘               └─────────────────────┘
```

### 3.2 Circular Responsibility Problem

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              STATE INITIALIZATION RESPONSIBILITY CONFUSION                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   BaseToolUseAgent.run()                                                     │
│   ├── Creates lifecycle                                                      │
│   ├── Creates initial state via createState callback                         │
│   ├── Stores reference: this.activeState = state     ◀── Side effect        │
│   └── Calls executeAgentRunFlow()                                            │
│                                                                              │
│         ┌──────────────────────────────────────────────────────────────┐    │
│         │                                                              │    │
│         ▼                                                              │    │
│   ToolUseRunFlow                                                       │    │
│   ├── ToolUsePrepareNode.exec()                                        │    │
│   │   ├── Calls hooks.prepareState()     ◀── Re-prepares state?       │    │
│   │   ├── Calls hooks.buildCycleOptions()                              │    │
│   │   └── Returns prepared data                                        │    │
│   │                                                                    │    │
│   └── ToolUseCycleNode.exec()                                          │    │
│       └── Uses state.cycleOptions  ◀── Set by PrepareNode, not agent  │    │
│                                                                              │
│   QUESTION: Who owns state initialization?                                   │
│   - Agent creates initial empty state                                        │
│   - Flow's PrepareNode populates it                                          │
│   - Agent stores reference for external access (getActiveState)              │
│   - Flow mutates the state during execution                                  │
│                                                                              │
│   CONTRAST with ReflectionFlow:                                              │
│   - State fully encapsulated in flow                                         │
│   - No external activeState reference                                        │
│   - Cleaner ownership model                                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Hook Interface Asymmetry

### 4.1 Hook Method Comparison

```
┌────────────────────────────────────────┬────────────────────────────────────┐
│         ReflectionRunHooks             │         ToolUseRunHooks            │
│            (1 method)                  │           (12 methods)             │
├────────────────────────────────────────┼────────────────────────────────────┤
│                                        │                                    │
│  resetPromptBuilder(): void            │  prepareState()                    │
│                                        │  buildCycleOptions()               │
│                                        │  runCycle()                        │
│                                        │  checkInterruption()               │
│                                        │  hasQueuedFollowUp()               │
│                                        │  enterWaitingState()               │
│                                        │  clearPersistedSnapshot()          │
│                                        │  waitForFollowUp()                 │
│                                        │  markRunning()                     │
│                                        │  applyFollowUp()                   │
│                                        │  persistCheckpoint()               │
│                                        │  logFinalizeWarning?()             │
│                                        │                                    │
├────────────────────────────────────────┴────────────────────────────────────┤
│                                                                              │
│  ANALYSIS:                                                                   │
│                                                                              │
│  The 12:1 ratio indicates ToolUseRunFlow has NOT properly abstracted its    │
│  control flow. Many of these hooks are flow-control operations that should  │
│  be internal to the flow, not exposed as hooks:                              │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Flow-Control Hooks (should be internal):                            │    │
│  │ • checkInterruption()    - Flow should handle                       │    │
│  │ • hasQueuedFollowUp()    - Flow should handle                       │    │
│  │ • enterWaitingState()    - Flow should handle                       │    │
│  │ • waitForFollowUp()      - Flow should handle                       │    │
│  │ • markRunning()          - Flow should handle                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Domain Hooks (correctly exposed):                                   │    │
│  │ • prepareState()         - Agent-specific                           │    │
│  │ • buildCycleOptions()    - Agent-specific                           │    │
│  │ • runCycle()             - Agent-specific                           │    │
│  │ • persistCheckpoint()    - Agent-specific                           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Result Type Inconsistency

### 5.1 NodeExecResult Usage

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RESULT TYPE USAGE ACROSS FLOWS                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   DEFINED in nodeExecution.ts:8-17:                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ export type NodeExecResult<T> =                                     │   │
│   │   | { result: T; error?: undefined }                                │   │
│   │   | { error: unknown; result?: undefined };                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   TOOL-USE FLOW:                                                             │
│   ├── ToolUsePrepareNode: Uses NodeExecResult<T>  ✓                         │
│   └── ToolUseCycleNode:   CUSTOM discriminated union  ✗                     │
│       ┌─────────────────────────────────────────────────────────────────┐   │
│       │ type ToolUseCycleExecResult =                                   │   │
│       │   | { result: void; error?: undefined; ... }                    │   │
│       │   | { error: unknown; result?: undefined; ... }                 │   │
│       │   | { failedWithError: true; errorMessage?: string; ... }       │   │
│       │   | { userCancelled: true; ... }                                │   │
│       └─────────────────────────────────────────────────────────────────┘   │
│       4 variants with overlapping optional fields - confusing!               │
│                                                                              │
│   REFLECTION FLOW:                                                           │
│   └── ReflectionRoundNode: CUSTOM inline types  ✗                           │
│       ┌─────────────────────────────────────────────────────────────────┐   │
│       │ interface ReflectionRoundExec<C> extends ReflectionRoundPrep<C> │   │
│       │   result?: ReflectionRoundResult;                               │   │
│       │   error?: unknown;                                              │   │
│       │ }                                                               │   │
│       └─────────────────────────────────────────────────────────────────┘   │
│       Optional fields instead of proper discriminated union!                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. ToolUseCycleNode Complexity Analysis

### 6.1 Control Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 ToolUseCycleNode.exec() - Lines 241-304                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   START                                                                      │
│     │                                                                        │
│     ▼                                                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     while (true)                                    │   │
│   │   │                                                                 │   │
│   │   ▼                                                                 │   │
│   │ ┌─────────────────────┐                                             │   │
│   │ │ shouldSkipCycle?    │──YES──▶ state.shouldSkipCycle = false       │   │
│   │ └─────────┬───────────┘                  │                          │   │
│   │           │ NO                           │                          │   │
│   │           ▼                              │                          │   │
│   │   ┌───────────────────┐                  │                          │   │
│   │   │ hooks.runCycle()  │                  │                          │   │
│   │   └─────────┬─────────┘                  │                          │   │
│   │             │                            │                          │   │
│   │   ┌─────────┴─────────┐                  │                          │   │
│   │   │ !failed && !cancel│──YES──▶ persistCheckpoint()                 │   │
│   │   └─────────┬─────────┘                  │                          │   │
│   │             │                            │                          │   │
│   │   ┌─────────┴─────────┐                  │                          │   │
│   │   │ failedWithError?  │──YES──▶ EXIT 1: return { failedWithError }  │   │
│   │   └─────────┬─────────┘                                             │   │
│   │             │ NO                                                    │   │
│   │   ┌─────────┴─────────┐                                             │   │
│   │   │ userCancelled?    │──YES──▶ EXIT 2: return { userCancelled }    │   │
│   │   └─────────┬─────────┘                                             │   │
│   │             │ NO                                                    │   │
│   │             ◀────────────────────────────┘                          │   │
│   │             │                                                       │   │
│   │   ┌─────────┴─────────┐                                             │   │
│   │   │checkInterruption? │──YES──▶ EXIT 3: return { result: undefined }│   │
│   │   └─────────┬─────────┘                                             │   │
│   │             │ NO                                                    │   │
│   │   ┌─────────┴─────────┐                                             │   │
│   │   │hasQueuedFollowUp? │──YES──▶ clearPersistedSnapshot()            │   │
│   │   └─────────┬─────────┘                  │                          │   │
│   │             │ NO                         │                          │   │
│   │             ▼                            │                          │   │
│   │     enterWaitingState()                  │                          │   │
│   │             │                            │                          │   │
│   │             ◀────────────────────────────┘                          │   │
│   │             │                                                       │   │
│   │             ▼                                                       │   │
│   │   ┌─────────────────────┐                                           │   │
│   │   │ waitForFollowUp()   │◀── BLOCKING WAIT                          │   │
│   │   └─────────┬───────────┘                                           │   │
│   │             │                                                       │   │
│   │   ┌─────────┴──────────────────┐                                    │   │
│   │   │ !followUp || interrupted?  │──YES──▶ EXIT 4: return { result }  │   │
│   │   └─────────┬──────────────────┘                                    │   │
│   │             │ NO                                                    │   │
│   │             ▼                                                       │   │
│   │     markRunning()                                                   │   │
│   │     clearPersistedSnapshot()                                        │   │
│   │     applyFollowUp()                                                 │   │
│   │     state.conversation = [...]  ◀── MUTATION                        │   │
│   │             │                                                       │   │
│   │             └──────────────────────────────────────────▶ LOOP BACK  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   } catch (error) {                                                          │
│       EXIT 5: return { error }                                               │
│   }                                                                          │
│                                                                              │
│   COMPLEXITY METRICS:                                                        │
│   • 5 exit paths                                                             │
│   • 2 state mutations inside loop                                            │
│   • 3 conditional branches                                                   │
│   • 1 blocking wait                                                          │
│   • 11 hook calls                                                            │
│   • Cyclomatic complexity: ~12                                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Recommendations

### 7.1 Immediate Fixes (Low Effort, High Impact)

| Issue | Fix | Files |
|-------|-----|-------|
| FlowLink duplication | Extract to types.ts | buildRunFlow.ts, createAgentRunFlow.ts |
| Generic constraint repetition | Create type alias | AgentRunFlowRunner.ts |
| FinalizeNodeContext verbosity | Create type alias | createFinalizeNode.ts |
| Inline anonymous class | Extract to named class | createFinalizeNode.ts |

### 7.2 Structural Refactoring (Medium Effort)

| Issue | Recommendation |
|-------|----------------|
| Iteration strategy mismatch | Refactor ToolUseCycleNode to use flow-level looping like Reflection |
| Result type inconsistency | Standardize on NodeExecResult everywhere |
| Error handling fragmentation | Create unified error handling utility |
| Hook interface asymmetry | Extract flow-control hooks from ToolUseRunHooks |

### 7.3 Architectural Improvements (High Effort)

| Issue | Recommendation |
|-------|----------------|
| Phase transition chaos | Centralize phase transitions in node boundaries |
| State ownership confusion | Document and enforce single ownership model |
| ToolUseCycleNode complexity | Decompose into multiple nodes with explicit state |

---

## 8. Priority Matrix

```
                        HIGH IMPACT
                             │
     ┌───────────────────────┼───────────────────────┐
     │                       │                       │
     │  Iteration Strategy   │   Type Aliases        │
     │  Mismatch            │   (FlowLink, etc)     │
     │                       │                       │
     │  Error Handling       │   Result Type         │
     │  Unification         │   Standardization     │
     │                       │                       │
HIGH ├───────────────────────┼───────────────────────┤ LOW
EFFORT                       │                       EFFORT
     │                       │                       │
     │  Phase Transition     │   Inline Class        │
     │  Centralization      │   Extraction          │
     │                       │                       │
     │  State Ownership      │   Documentation       │
     │  Model               │   Updates             │
     │                       │                       │
     └───────────────────────┼───────────────────────┘
                             │
                        LOW IMPACT
```

---

## Appendix: File-by-File Issue Index

| File | Issues Found | Severity |
|------|--------------|----------|
| `AgentRunFlowRunner.ts` | Generic constraint repeated 6x | High |
| `buildRunFlow.ts` | FlowLink duplication | High |
| `createAgentRunFlow.ts` | FlowLink duplication | High |
| `createFinalizeNode.ts` | Inline class, verbose types, dual factory | Medium-High |
| `AgentInitNode.ts` | Side effects in exec() | Medium |
| `finalizeLifecycle.ts` | Error side-channel pattern | Medium |
| `types.ts` | Over-generic constraints | Medium |
| `ToolUseRunFlow.ts` | Complex while loop, 4-variant union, scattered phases | High |
| `ReflectionRunFlow.ts` | Doesn't use NodeExecResult | Medium |
| `runStateSchemas.ts` | cycleOptions: z.unknown() | Medium |
