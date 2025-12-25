# Flow Refactoring: Design Twice

Following John Ousterhout's "Design it Twice" principle from _A Philosophy of Software Design_.

---

## The Core Problem

```
Current State:
┌─────────────────────────────────────────────────────────────────────────┐
│  ReflectionFlow                    ToolUseFlow                          │
│  ┌──────────────────┐              ┌──────────────────────────────────┐ │
│  │ RoundNode        │              │ CycleNode                        │ │
│  │                  │              │ ┌────────────────────────────┐   │ │
│  │ exec() {        │              │ │ exec() {                   │   │ │
│  │   // simple     │              │ │   while(true) {            │   │ │
│  │   execute();    │              │ │     if (!skip) runCycle(); │   │ │
│  │   return result;│              │ │     if (failed) EXIT 1     │   │ │
│  │ }               │              │ │     if (cancel) EXIT 2     │   │ │
│  │                  │              │ │     if (intr)   EXIT 3     │   │ │
│  │ Flow loops via  │              │ │     wait();                │   │ │
│  │ CONTINUE trans. │              │ │     if (noFU)   EXIT 4     │   │ │
│  └──────────────────┘              │ │     apply(followUp);       │   │ │
│                                    │ │   }                        │   │ │
│  1 hook method                     │ │ } catch { EXIT 5 }         │   │ │
│                                    │ └────────────────────────────┘   │ │
│                                    │ 12 hook methods                  │ │
│                                    └──────────────────────────────────┘ │
│                                                                         │
│  TWO COMPLETELY DIFFERENT PATTERNS FOR THE SAME CONCEPT                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Design 1: Unified Flow Abstraction

**Philosophy**: Create ONE iteration abstraction that both flows use. The variation is in _strategy_, not _structure_.

### Core Insight

Both flows do the same thing:

```
INIT → ITERATE(work units) → FINALIZE
```

The difference is:

- **Reflection**: Work units are "rounds" (bounded, no waiting)
- **ToolUse**: Work units are "cycles" (unbounded, wait between)

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         NEW: core/                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  FlowTypes.ts          FlowResult.ts           IterativeFlowNode.ts     │
│  ┌──────────────┐      ┌─────────────────┐     ┌─────────────────────┐  │
│  │ FlowLink<S>  │      │ type FlowResult │     │ class IterativeFlow │  │
│  │ (1 location) │      │   | success     │     │   Node<S,Iter,Res>  │  │
│  │              │      │   | error       │     │                     │  │
│  │ BaseFlowShar │      │   | cancelled   │     │ Uses:               │  │
│  │ (type alias) │      │   | failed      │     │ IterationStrategy   │  │
│  └──────────────┘      └─────────────────┘     └──────────┬──────────┘  │
│                                                           │              │
└───────────────────────────────────────────────────────────┼──────────────┘
                                                            │
                    ┌───────────────────────────────────────┴───────┐
                    │                                               │
                    ▼                                               ▼
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│      strategies/ReflectionStrategy  │     │      strategies/ToolUseStrategy     │
├─────────────────────────────────────┤     ├─────────────────────────────────────┤
│                                     │     │                                     │
│ shouldContinue: round < total       │     │ shouldContinue: always true         │
│                                     │     │                                     │
│ execute: agent.executeRound()       │     │ execute: hooks.runCycle()           │
│                                     │     │                                     │
│ onIterationComplete: (none)         │     │ onIterationComplete:                │
│                                     │     │   checkInterruption()               │
│                                     │     │   waitForFollowUp()                 │
│                                     │     │   applyFollowUp()                   │
│                                     │     │   → 'continue' | 'stop'             │
└─────────────────────────────────────┘     └─────────────────────────────────────┘
```

### Key Interface

```typescript
interface IterationStrategy<Shared, IterState, Result> {
  name: string;

  // Lifecycle
  initIteration(shared: Shared): IterState;
  shouldContinue(shared: Shared, state: IterState): boolean;

  // Execution
  execute(shared: Shared, state: IterState): Promise<FlowResult<Result>>;
  processResult(shared: Shared, state: IterState, result: Result): void;

  // Optional inter-iteration (where ToolUse complexity lives)
  onIterationComplete?(
    shared: Shared,
    state: IterState,
  ): Promise<'continue' | 'stop'>;
}
```

### File Changes

```
src/agent/implementations/flows/
├── core/                           # NEW
│   ├── FlowTypes.ts               # FlowLink, BaseFlowShared (consolidate)
│   ├── FlowResult.ts              # Unified result type
│   ├── FlowError.ts               # Error accumulator
│   └── IterativeFlowNode.ts       # THE iteration abstraction
├── strategies/                     # NEW
│   ├── ReflectionStrategy.ts      # Bounded iteration config
│   └── ToolUseStrategy.ts         # Interactive iteration config
├── common/                         # SIMPLIFIED
│   └── (existing files, import from core/)
├── ReflectionRunFlow.ts           # Uses IterativeFlowNode + ReflectionStrategy
└── ToolUseRunFlow.ts              # Uses IterativeFlowNode + ToolUseStrategy
```

### Metrics

| Before                       | After               |
| ---------------------------- | ------------------- |
| FlowLink: 2 definitions      | 1 definition        |
| Generic constraint: 6 copies | 1 type alias        |
| Iteration patterns: 2        | 1 (with strategies) |
| ToolUseCycleNode exits: 5    | 1 (via FlowResult)  |
| ToolUseRunHooks: 12 methods  | 7 methods           |

---

## Design 2: Layered Responsibility Separation

**Philosophy**: Separate concerns into distinct _layers_, each a "deep module" with a simple interface.

### Core Insight

The current code mixes four concerns:

1. **State** (lifecycle, phase, data)
2. **Errors** (result types, accumulation)
3. **Iteration** (loops, waits, continuation)
4. **Orchestration** (node wiring, transitions)

Separating them creates focused, testable modules.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 4: ORCHESTRATION                                                  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ FlowBuilder                                                       │  │
│  │   .node('init', initNode, { enterPhase: 'init' })                │  │
│  │   .node('cycle', cycleNode, { enterPhase: 'cycle' })             │  │
│  │   .transition('init', EXECUTE, 'cycle')                          │  │
│  │   .build()                                                        │  │
│  │                                                                   │  │
│  │ Hides: Node wiring, phase transitions, link resolution           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────┤
│  LAYER 3: ITERATION                                                      │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ IterationController                                               │  │
│  │   shouldContinue(): boolean                                       │  │
│  │   prepareIteration(): Promise<void>                              │  │
│  │   recordIteration(result): void                                  │  │
│  │   wait(): Promise<WaitResult>                                    │  │
│  │                                                                   │  │
│  │ Implementations:                                                  │  │
│  │   BoundedIterator (for Reflection: max N rounds)                 │  │
│  │   InteractiveIterator (for ToolUse: wait for follow-up)          │  │
│  │                                                                   │  │
│  │ Hides: Loop mechanics, retry state, interruption, waiting        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────┤
│  LAYER 2: ERROR                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ NodeResult<T> = { ok: true, value: T }                           │  │
│  │              | { ok: false, error: NodeError }                   │  │
│  │                                                                   │  │
│  │ NodeError { kind: 'exception'|'cancelled'|'failed', message }    │  │
│  │                                                                   │  │
│  │ ErrorCollector.capture(fn) → accumulates errors                  │  │
│  │                                                                   │  │
│  │ Hides: Error wrapping, chain management, secondary errors        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────┤
│  LAYER 1: STATE                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ RunState<Phase, Data>                                             │  │
│  │   readonly phase, status, error, isComplete, hasFailed           │  │
│  │   transition(phase), complete(), fail(error)                     │  │
│  │   readonly data, update(changes)                                 │  │
│  │   snapshot(): Serializable                                       │  │
│  │                                                                   │  │
│  │ Hides: Phase validation, status machine, serialization           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Interfaces

```typescript
// Layer 1: State
interface RunState<Phase, Data> {
  readonly phase: Phase;
  readonly status: RunStatus;
  readonly isComplete: boolean;
  readonly hasFailed: boolean;
  readonly data: Data;

  transition(phase: Phase): void;
  complete(): void;
  fail(error: unknown): void;
  update(changes: Partial<Data>): void;
}

// Layer 2: Error
type NodeResult<T> = { ok: true; value: T } | { ok: false; error: NodeError };

// Layer 3: Iteration
interface IterationController {
  shouldContinue(): boolean;
  prepareIteration(): Promise<void>;
  recordIteration(result: NodeResult<void>): void;
  wait(): Promise<WaitResult>;
}

// Layer 4: Orchestration
interface FlowBuilder<S, Phase> {
  node(name: string, node: FlowNode<S>, config: { enterPhase?: Phase }): this;
  transition(from: string, on: string, to: string): this;
  build(): Flow<S>;
}
```

### File Changes

```
src/agent/implementations/flows/
├── layers/
│   ├── state/
│   │   ├── RunState.ts            # Unified state container
│   │   └── RunStateSchema.ts      # Zod schemas
│   ├── error/
│   │   ├── NodeResult.ts          # Unified error type
│   │   └── ErrorCollector.ts      # Multi-error handling
│   ├── iteration/
│   │   ├── IterationController.ts # Abstract interface
│   │   ├── BoundedIterator.ts     # For Reflection
│   │   └── InteractiveIterator.ts # For ToolUse
│   └── orchestration/
│       ├── FlowBuilder.ts         # Declarative construction
│       └── FlowLink.ts            # Single type definition
├── nodes/
│   ├── AgentInitNode.ts           # Uses NodeResult
│   ├── AgentFinalizeNode.ts       # Uses ErrorCollector
│   └── IteratingNode.ts           # Uses IterationController
├── flows/
│   ├── ReflectionRunFlow.ts       # Simplified
│   └── ToolUseRunFlow.ts          # Simplified
└── types.ts                        # AgentFlowShared alias only
```

### Metrics

| Before                           | After                               |
| -------------------------------- | ----------------------------------- |
| Lifecycle + RunState: separate   | Merged RunState                     |
| Error patterns: 3                | 1 (NodeResult)                      |
| Phase transitions: scattered     | Declarative in FlowBuilder          |
| ToolUseCycleNode: 5 exits, CC=12 | 1 exit, CC=4                        |
| ToolUseRunHooks: 12 methods      | 5 methods (7 → InteractiveIterator) |

---

## Comparison Matrix

| Criterion              | Design 1: Unified            | Design 2: Layered           |
| ---------------------- | ---------------------------- | --------------------------- |
| **Core Abstraction**   | IterationStrategy (behavior) | 4 Layers (responsibility)   |
| **Type Consolidation** | ✓ FlowTypes.ts               | ✓ layers/\*/index.ts        |
| **Error Handling**     | FlowResult (union)           | NodeResult + ErrorCollector |
| **Iteration**          | Strategy pattern             | Controller pattern          |
| **Phase Transitions**  | Still in nodes               | Centralized in FlowBuilder  |
| **Hook Reduction**     | 12 → 7                       | 12 → 5                      |
| **New Files**          | ~5                           | ~12                         |
| **Migration Risk**     | Medium                       | Medium-High                 |
| **Testing**            | Test strategies              | Test each layer             |
| **Extensibility**      | Add new strategy             | Add to any layer            |

---

## Trade-off Analysis

### Design 1: Unified Flow Abstraction

**Strengths**:

- **Simpler mental model**: "Flows use strategies"
- **Fewer files**: Core abstraction in ~5 files
- **Direct mapping**: Strategy = flow type
- **Easier migration**: Less structural change

**Weaknesses**:

- **Strategy coupling**: `onIterationComplete` conflates waiting with iteration
- **Phase transitions still scattered**: Not addressed
- **State management unchanged**: AgentLifecycle stays as-is

**Best for**: Teams that want quick wins with minimal structural change.

---

### Design 2: Layered Responsibility Separation

**Strengths**:

- **True separation of concerns**: Each layer independently testable
- **Phase transitions centralized**: FlowBuilder handles all
- **State unified**: RunState merges lifecycle + data
- **Maximum hook reduction**: 12 → 5

**Weaknesses**:

- **More files**: ~12 new files
- **Higher learning curve**: 4 layers to understand
- **Bigger migration**: More refactoring needed
- **Risk of over-abstraction**: Layers may feel heavy for simple cases

**Best for**: Teams willing to invest more upfront for cleaner long-term architecture.

---

## Recommendation

### Start with Design 1, Evolve to Design 2

```
Phase 1: Quick Wins (Design 1 partial)
├── Consolidate FlowLink, BaseFlowShared
├── Introduce FlowResult type
└── Create IterativeFlowNode + strategies

Phase 2: If needed, add layers (Design 2)
├── Extract State layer (if RunState grows complex)
├── Extract Error layer (if error handling expands)
└── Add FlowBuilder (if more flow types emerge)
```

**Rationale**:

1. Design 1 solves the _immediate_ pain (iteration mismatch, type duplication)
2. Design 2 is available if complexity warrants it
3. Incremental refactoring reduces risk
4. "You Ain't Gonna Need It" for 4 layers if 2 flow types work fine

---

## Ousterhout Principles Applied

| Principle                          | Design 1                           | Design 2                          |
| ---------------------------------- | ---------------------------------- | --------------------------------- |
| **Deep modules**                   | IterativeFlowNode hides loop       | Each layer is deep                |
| **Information hiding**             | Strategy hides flow-specific logic | Layers hide concerns              |
| **Define errors out of existence** | FlowResult has explicit variants   | NodeResult + RunState.hasFailed   |
| **Pull complexity downward**       | Strategy absorbs hooks             | InteractiveIterator absorbs hooks |
| **Design it twice**                | ✓ This document                    | ✓ This document                   |

---

## Next Steps

1. **Choose design direction** (or hybrid)
2. **Create implementation plan** with phases
3. **Write tests first** for new abstractions
4. **Migrate incrementally** with feature flags if needed
