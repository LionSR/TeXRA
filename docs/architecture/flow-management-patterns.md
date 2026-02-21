# Flow Management Patterns: Industry-Tested Ideas for TeXRA

> Analysis of patterns from React, Redux, Erlang/OTP, RxJS, XState, and distributed systems — mapped concretely to TeXRA's PocketFlow architecture.

---

## Table of Contents

1. [Current Architecture Diagnosis](#1-current-architecture-diagnosis)
2. [Pattern 1: Finite State Machines (XState-style)](#2-pattern-1-finite-state-machines-xstate-style)
3. [Pattern 2: Structured Concurrency (Erlang/OTP Supervision Trees)](#3-pattern-2-structured-concurrency-erlangotp-supervision-trees)
4. [Pattern 3: Reducers + Actions (Redux-style State Transitions)](#4-pattern-3-reducers--actions-redux-style-state-transitions)
5. [Pattern 4: Effect Isolation (Redux-Saga / Algebraic Effects)](#5-pattern-4-effect-isolation-redux-saga--algebraic-effects)
6. [Pattern 5: Reactive Streams (RxJS-style Event Composition)](#6-pattern-5-reactive-streams-rxjs-style-event-composition)
7. [Pattern 6: Command-Query Separation for Shared State](#7-pattern-6-command-query-separation-for-shared-state)
8. [Pattern 7: Flow Composition via Higher-Order Flows (React HOC-style)](#8-pattern-7-flow-composition-via-higher-order-flows-react-hoc-style)
9. [What Would Make the Biggest Impact](#9-what-would-make-the-biggest-impact)

---

## 1. Current Architecture Diagnosis

### What's Already Good

TeXRA's PocketFlow is clean and minimal (~300 lines for Node/Flow/BatchNode). The `prep → exec → post` lifecycle with action-based routing is elegant. Services-as-immutable-deps and Zod-validated shared state are solid foundations.

### Where Complexity Accumulates

Looking at the actual code, the pain points cluster around:

**A. The `runReflectionFlow` / `runToolUseFlow` functions are 200+ line orchestration monoliths.**
They mix: service construction, state initialization, flow wiring, persistence setup, interruption registration, error handling, and cleanup. This is the "god function" anti-pattern — everything that could go wrong is handled in one massive try/catch/finally.

**B. State mutations are implicit and untracked.**
Nodes mutate `shared` directly in `post()`. There's no way to know *what changed* after a node runs without diffing the entire state. This makes debugging hard — when `shared.continueRounds` becomes `false`, which node did it? When?

**C. Events are fire-and-forget with no backpressure.**
The `ProgressEventBus` buffers 1000 events when no listeners are attached, then replays them. But there's no concept of "this event matters for correctness" vs "this is a UI hint". A dropped `updateStreamStatus` is very different from a dropped `updateConversationProgress`.

**D. Cancellation is threaded manually through every layer.**
`checkInterruption` callbacks, `AbortController` passing, `signal` on nodes, `IInterruptible` registration — cancellation logic is spread across ~8 files. Every new flow must re-implement the same pattern.

**E. Flow composition is purely structural (node chaining), not behavioral.**
There's no way to say "retry this entire subflow" or "run these two subflows with shared cancellation" or "timeout after N seconds" without writing custom orchestration code each time.

---

## 2. Pattern 1: Finite State Machines (XState-style)

### The Idea

Your `Action`-based routing in PocketFlow is already a state machine — but an *implicit* one. The transitions are scattered across `post()` methods and `.on()` calls. XState showed the industry that making the state machine *explicit and declarative* unlocks: visualization, formal verification, and predictable behavior.

### What This Looks Like for TeXRA

Instead of wiring nodes imperatively:

```typescript
// Current: implicit state machine
prepareNode.next(cycleNode);
cycleNode.next(waitNode);
waitNode.on(FlowTransition.CONTINUE, cycleNode);
```

Define the machine declaratively:

```typescript
// Proposed: explicit state machine definition
const toolUseFlowDef = defineFlow({
  id: 'toolUseFlow',
  initial: 'preparing',

  states: {
    preparing: {
      node: ToolUsePrepareNode,
      transitions: {
        default: 'cycling',
        skip: 'waiting',    // visible! you can see the skip path exists
      },
    },
    cycling: {
      node: ToolUseCycleNode,
      transitions: {
        default: 'waiting',
        error: 'failed',
      },
    },
    waiting: {
      node: ToolUseWaitNode,
      transitions: {
        continue: 'cycling',  // the loop is visible in the definition
        stop: 'done',
      },
    },
    done: { type: 'final' },
    failed: { type: 'final' },
  },
});
```

### Why This Matters

1. **Visualization**: You can auto-generate flow diagrams from the definition. When debugging, you see the *entire* possible state space, not just what happened.

2. **Guard conditions**: Transitions can have guards that are checked *before* entering a node:
   ```typescript
   cycling: {
     node: ToolUseCycleNode,
     transitions: {
       default: {
         target: 'waiting',
         guard: (shared) => !shared.lastError,
       },
       error: 'failed',
     },
   },
   ```

3. **Impossible states become impossible**: If `waiting` can only transition to `cycling` or `done`, you can't accidentally end up in `preparing` again. The type system enforces it.

4. **Parallel states**: XState supports parallel regions — your reflection flow's "media extraction + tex count" could run concurrently as parallel states within a single round, with the machine waiting for both to complete.

### Implementation Cost: Low-Medium

This is a thin declarative layer over your existing `node.next()` / `node.on()` wiring. The `defineFlow` function just generates the same imperative calls. You keep all existing Node subclasses unchanged.

---

## 3. Pattern 2: Structured Concurrency (Erlang/OTP Supervision Trees)

### The Idea

Erlang/OTP proved that the key to reliable concurrent systems isn't preventing failures — it's *organizing failure boundaries*. A supervision tree says: "these processes are a group; if one dies, here's the restart strategy for the group."

Your `ExecutionHandle` / `interruptActiveChildren` pattern is already a baby supervision tree. But it's ad-hoc.

### What This Looks Like for TeXRA

```typescript
// Proposed: FlowScope - structured concurrency for flows
const result = await FlowScope.run(async (scope) => {
  // Everything launched in this scope shares a lifecycle
  const session = scope.own(new ToolUseSessionLifecycle(streamId));
  const interruptible = scope.own(registerInterruptible(streamId));

  // Child flows inherit the scope's cancellation
  const subResult = await scope.spawn(runReflectionFlow, { ...input });

  // If scope is cancelled, ALL children are cancelled automatically
  // If a child throws, the scope catches it and runs cleanup

  return subResult;
});
// When we exit here, EVERYTHING is cleaned up. Guaranteed.
```

### The Problem This Solves

Look at `runToolUseFlow`'s finally block:

```typescript
finally {
  try { await kv.write(...); } catch { /* best effort */ }
  if (shared.userCancelledRetry) { ... } else {
    try { await kv.delete(...); } catch { /* ignore */ }
  }
  sessionLifecycle.dispose();
  unregisterInterruptible(streamId);
}
```

This manual cleanup is error-prone. Every new resource needs a corresponding cleanup line. Miss one and you leak. Structured concurrency makes cleanup automatic and compositional.

### A Concrete `FlowScope` Design

```typescript
class FlowScope {
  private cleanups: (() => void | Promise<void>)[] = [];
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Register a resource for automatic cleanup */
  own<T extends Disposable>(resource: T): T {
    this.cleanups.push(() => resource[Symbol.dispose]());
    return resource;
  }

  /** Register an arbitrary cleanup function */
  onCleanup(fn: () => void | Promise<void>): void {
    this.cleanups.push(fn);
  }

  /** Cancel all children */
  cancel(): void {
    this.controller.abort();
  }

  /** Run cleanups in reverse order (LIFO, like destructors) */
  async dispose(): Promise<void> {
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch { /* log but don't throw */ }
    }
  }

  static async run<T>(fn: (scope: FlowScope) => Promise<T>): Promise<T> {
    const scope = new FlowScope();
    try {
      return await fn(scope);
    } finally {
      await scope.dispose();
    }
  }
}
```

### How `runToolUseFlow` Would Look

```typescript
export async function runToolUseFlow(input) {
  return FlowScope.run(async (scope) => {
    const session = scope.own(new ToolUseSessionLifecycle(streamId));
    scope.onCleanup(() => unregisterInterruptible(streamId));
    scope.onCleanup(() => retryCoordinator.clearRequest(streamId));
    scope.onCleanup(() => persistConversation(kv, shared));

    registerInterruptible(streamId, { interrupt: () => scope.cancel() });

    // ... actual flow logic, much cleaner ...
    const pf = new PersistedFlow(prepareNode, kv);
    pf.setServices(services);
    await pf.run(shared);
  });
}
```

From 245 lines of mixed concerns to ~50 lines of pure flow logic.

### Implementation Cost: Low

This is ~40 lines of infrastructure code. It uses TC39's `Disposable` protocol (`Symbol.dispose`) which TypeScript already supports.

---

## 4. Pattern 3: Reducers + Actions (Redux-style State Transitions)

### The Idea

Redux's genius wasn't the store — it was making state transitions *explicit, trackable, and replayable*. Instead of mutating state directly, you dispatch actions that describe *what happened*, and reducers compute the new state.

### The Problem in TeXRA

Nodes mutate `shared` directly:

```typescript
// In OutputNode.post():
shared.roundOutputs.push(roundOutput);
shared.continueRounds = shouldContinue;
shared.workspaceSnapshot = workspace.toSnapshot();
```

This is fine for simple flows but breaks down when:
- You want to debug "why did the flow stop at round 3?"
- You want to replay a flow from persistence with different logic
- You want to add middleware (logging, validation) to state changes

### What This Looks Like for TeXRA

```typescript
// Define typed actions for state transitions
type FlowAction =
  | { type: 'ROUND_COMPLETED'; roundIndex: number; output: RoundOutput }
  | { type: 'CONTINUE_DECIDED'; shouldContinue: boolean; reason: string }
  | { type: 'ERROR_OCCURRED'; error: RetryErrorInfo }
  | { type: 'WORKSPACE_RESET' }
  | { type: 'CONTEXT_PREPARED'; context: RoundContext };

// Reducer: pure function, no side effects
function reflectionReducer(
  state: ReflectionFlowShared,
  action: FlowAction,
): ReflectionFlowShared {
  switch (action.type) {
    case 'ROUND_COMPLETED':
      return {
        ...state,
        roundOutputs: [...state.roundOutputs, action.output],
      };
    case 'CONTINUE_DECIDED':
      return { ...state, continueRounds: action.shouldContinue };
    case 'ERROR_OCCURRED':
      return { ...state, lastError: action.error, continueRounds: false };
    // ...
  }
}

// In nodes, dispatch instead of mutate:
class OutputNode extends Node<ReflectionFlowShared> {
  async post(shared, prepRes, execRes) {
    // Instead of: shared.roundOutputs.push(output)
    this.dispatch({ type: 'ROUND_COMPLETED', roundIndex: shared.currentRound, output });
    this.dispatch({ type: 'CONTINUE_DECIDED', shouldContinue, reason: 'tex_count_ok' });
  }
}
```

### The Payoff: Action Log

Every flow execution produces a replayable log:

```
[r0] CONTEXT_PREPARED     { context: {...} }
[r0] ROUND_COMPLETED      { roundIndex: 0, output: {...} }
[r0] CONTINUE_DECIDED     { shouldContinue: true, reason: "tex_count_ok" }
[r1] WORKSPACE_RESET      {}
[r1] CONTEXT_PREPARED     { context: {...} }
[r1] ERROR_OCCURRED       { error: { message: "API rate limit" } }
```

You can:
- **Time-travel debug**: step through the action log to see state at any point
- **Replay with patches**: re-run the same actions with a modified reducer
- **Persist and resume**: the action log IS the persistence format (more compact than full state snapshots)

### Lightweight Integration with PocketFlow

You don't need a full Redux store. A thin wrapper around `shared`:

```typescript
class SharedStore<S, A> {
  private _state: S;
  private _actions: A[] = [];

  constructor(initial: S, private reducer: (state: S, action: A) => S) {
    this._state = initial;
  }

  get state(): Readonly<S> { return this._state; }
  get actionLog(): readonly A[] { return this._actions; }

  dispatch(action: A): void {
    this._actions.push(action);
    this._state = this.reducer(this._state, action);
  }
}
```

Nodes receive `SharedStore` instead of raw `shared`. The `prep/exec/post` contract stays identical — `prep` reads `store.state`, `post` calls `store.dispatch()`.

### Implementation Cost: Medium

Requires defining action types per flow and migrating `post()` methods from direct mutation to dispatch. Can be done incrementally — one flow at a time.

---

## 5. Pattern 4: Effect Isolation (Redux-Saga / Algebraic Effects)

### The Idea

Redux-Saga (and React's experimental algebraic effects) showed that the cleanest way to handle side effects is to *describe* them as data, then execute them in a separate layer. The node says "I need to call the LLM" — it doesn't actually call it.

### Why This Matters for TeXRA

`ResponseCycleNode.exec()` currently does the LLM call directly:

```typescript
async exec(prepRes) {
  const response = await this.services.modelHandler.generate(prepRes.messages);
  return response;
}
```

This means:
- Testing requires mocking the model handler
- You can't intercept/transform the call without modifying the node
- Rate limiting, caching, and retry logic live inside the handler, tightly coupled

### The Effect Pattern

```typescript
// Effects are plain objects describing what to do
type Effect =
  | { type: 'LLM_CALL'; messages: Message[]; model: string }
  | { type: 'FILE_WRITE'; path: string; content: string }
  | { type: 'TOOL_EXECUTE'; tool: string; args: unknown }
  | { type: 'WAIT_FOR_INPUT'; prompt: string }
  | { type: 'LOG'; level: string; message: string };

// Node yields effects instead of executing them
class ResponseCycleNode extends Node<Shared> {
  async exec(prepRes): Promise<Effect[]> {
    return [
      { type: 'LLM_CALL', messages: prepRes.messages, model: 'claude-3' },
    ];
  }
}

// Effect runner (separate concern) handles execution
class EffectRunner {
  constructor(private handlers: Map<string, EffectHandler>) {}

  async run(effect: Effect): Promise<unknown> {
    const handler = this.handlers.get(effect.type);
    return handler.execute(effect);
  }
}
```

### Practical Benefits

1. **Testing becomes trivial**: Assert that a node returns the right effects, no mocks needed
   ```typescript
   const effects = await node.exec(prepRes);
   expect(effects).toEqual([{ type: 'LLM_CALL', messages: [...] }]);
   ```

2. **Cross-cutting concerns via middleware**:
   ```typescript
   // Rate limiting middleware
   const rateLimited = withRateLimit(effectRunner, { maxPerMinute: 60 });

   // Caching middleware
   const cached = withCache(rateLimited, { ttl: 300 });

   // Logging middleware
   const logged = withLogging(cached, logger);
   ```

3. **Dry-run mode**: Don't execute effects, just collect them. Useful for flow validation.

### Implementation Cost: High

This is a significant paradigm shift. Best adopted for new flows, not retrofitted onto existing ones. Consider it for the next major flow type you build.

---

## 6. Pattern 5: Reactive Streams (RxJS-style Event Composition)

### The Idea

Your `ProgressEventBus` is a pub/sub system. RxJS showed that the real power comes from *composing* event streams: filtering, mapping, debouncing, combining. Your `StreamEventQueue` and throttling logic are manually implementing what RxJS operators do declaratively.

### Current Pain

```typescript
// ProgressEventHandler.ts - manual throttling
private progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
private pendingProgressUpdates = new Map<StreamTabId, ConversationProgress>();
// ... 30+ lines of manual debounce logic
```

```typescript
// StreamEventQueue.ts - manual sequential processing
streamEventQueue.enqueue(streamId, async () => {
  // Handlers for same stream run sequentially
});
```

### The Reactive Alternative

```typescript
import { Subject, groupBy, mergeMap, concatMap, debounceTime } from 'rxjs';

// Type-safe event stream
const events$ = new Subject<ProgressEvent>();

// Per-stream sequential processing (replaces StreamEventQueue)
const perStreamEvents$ = events$.pipe(
  groupBy(e => e.streamId),
  mergeMap(stream$ =>
    stream$.pipe(concatMap(event => handleEvent(event)))
  ),
);

// Throttled progress updates (replaces manual timer logic)
const progressUpdates$ = events$.pipe(
  filter(e => e.type === 'updateConversationProgress'),
  groupBy(e => e.streamId),
  mergeMap(stream$ =>
    stream$.pipe(debounceTime(500))  // replaces PROGRESS_THROTTLE_MS
  ),
);

// Combine related events (new capability)
const streamLifecycle$ = events$.pipe(
  filter(e => e.type === 'setActiveStream' || e.type === 'updateStreamStatus'),
  groupBy(e => e.streamId),
  mergeMap(stream$ => stream$.pipe(
    scan((state, event) => ({ ...state, ...deriveState(event) }), initialState),
  )),
);
```

### What You'd Actually Gain

- **Replace ~100 lines** of manual throttling/queuing with ~20 lines of operators
- **Backpressure for free**: RxJS handles slow consumers automatically
- **Event composition**: "When stream starts AND first log arrives, show the panel" — this is trivial in RxJS, painful with raw EventEmitter
- **Memory leak prevention**: Subscriptions auto-complete when the stream ends

### Pragmatic Middle Ground

You don't need to adopt RxJS wholesale. A **micro-reactive** layer using just a few operators would already help:

```typescript
// A tiny reactive primitive (~50 lines)
class EventStream<T> {
  private listeners = new Set<(value: T) => void>();

  emit(value: T): void { this.listeners.forEach(fn => fn(value)); }

  filter(predicate: (v: T) => boolean): EventStream<T> { ... }
  map<U>(transform: (v: T) => U): EventStream<U> { ... }
  debounce(ms: number): EventStream<T> { ... }
  groupBy<K>(keyFn: (v: T) => K): EventStream<[K, EventStream<T>]> { ... }
}
```

### Implementation Cost: Low (micro-reactive) to Medium (full RxJS)

---

## 7. Pattern 6: Command-Query Separation for Shared State

### The Idea

Your `prep()` reads state and `post()` writes state — this is already CQS in spirit! But the boundary leaks because `shared` is a plain mutable object. Nodes can (and do) read in `post()` and could theoretically write in `prep()`.

### Enforce It

```typescript
// Shared state wrapper with compile-time enforcement
type ReadonlyShared<S> = DeepReadonly<S>;
type WritableShared<S> = S;

class StrictNode<S, P, Svc> extends BaseNode<S, P, Svc> {
  // prep gets readonly view — can read, cannot write
  async prep(shared: ReadonlyShared<S>): Promise<unknown> { return; }

  // exec gets no shared at all — pure computation
  async exec(prepRes: unknown): Promise<unknown> { return; }

  // post gets writable view — authorized to mutate
  async post(shared: WritableShared<S>, prepRes: unknown, execRes: unknown): Promise<Action | undefined> { return; }
}
```

### Why Bother?

This seems like a small thing, but it enables **parallel node execution**. If `prep()` is guaranteed read-only, multiple nodes' `prep()` calls can run concurrently without races. This is impossible with mutable shared state and no enforcement.

### Implementation Cost: Very Low

This is a type-level change only. No runtime cost. Add `DeepReadonly<S>` to `prep()`'s signature in `BaseNode`.

---

## 8. Pattern 7: Flow Composition via Higher-Order Flows (React HOC-style)

### The Idea

React's Higher-Order Components showed that you can add behavior to components without modifying them. The same pattern works for flows.

### Current Problem

Adding cancellation, persistence, round management, and logging to a flow requires inheritance:

```
Flow → PersistedFlow → RoundPersistedFlow
```

This is a rigid hierarchy. Want persistence without rounds? Want rounds without persistence? Want to add timeout behavior? You need a new class each time.

### The Composition Alternative

```typescript
// Base flow — just nodes
const coreFlow = defineFlow(prepareNode, cycleNode, waitNode);

// Add behaviors by wrapping, not inheriting
const withPersistence = (flow, kv) => new PersistedFlowWrapper(flow, kv);
const withRounds = (flow, callbacks) => new RoundWrapper(flow, callbacks);
const withTimeout = (flow, ms) => new TimeoutWrapper(flow, ms);
const withRetry = (flow, maxRetries) => new RetryWrapper(flow, maxRetries);
const withMetrics = (flow, collector) => new MetricsWrapper(flow, collector);

// Compose like middleware
const toolUseFlow = pipe(
  coreFlow,
  withPersistence(kv),
  withTimeout(5 * 60 * 1000),
  withMetrics(usageCollector),
);

const reflectionFlow = pipe(
  coreFlow,
  withPersistence(kv),
  withRounds(roundCallbacks),
  withRetry(3),
  withMetrics(usageCollector),
);
```

### Concrete Wrapper Example

```typescript
class TimeoutWrapper<S> {
  constructor(
    private inner: { run(shared: S): Promise<Action | undefined> },
    private timeoutMs: number,
  ) {}

  async run(shared: S): Promise<Action | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Propagate abort signal to inner flow's nodes
      return await this.inner.run(shared);
    } finally {
      clearTimeout(timer);
    }
  }
}

class RetryWrapper<S> {
  constructor(
    private inner: { run(shared: S): Promise<Action | undefined> },
    private maxRetries: number,
  ) {}

  async run(shared: S): Promise<Action | undefined> {
    let lastError: Error | undefined;
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await this.inner.run(shared);
      } catch (e) {
        lastError = e as Error;
        // Could add backoff here
      }
    }
    throw lastError;
  }
}
```

### Why This Beats Inheritance

- **Mix and match**: Any combination of behaviors without combinatorial explosion
- **Testing**: Test each wrapper in isolation
- **Single Responsibility**: Each wrapper does ONE thing
- **New behaviors don't modify existing code**: Add `withCircuitBreaker` without touching `PersistedFlow`

### Implementation Cost: Medium

Requires rethinking `PersistedFlow` and `RoundPersistedFlow` as wrappers rather than subclasses. Best done as a gradual migration.

---

## 9. What Would Make the Biggest Impact

Ranked by effort-to-reward ratio:

### Tier 1: Do These First (Low effort, high reward)

| Pattern | Effort | Impact | Why |
|---------|--------|--------|-----|
| **FlowScope (Structured Concurrency)** | ~40 lines | Eliminates entire classes of cleanup bugs | Every `runXFlow` function immediately becomes 60% shorter |
| **CQS on SharedState** | Type-only change | Enables future parallel prep, catches mutation bugs at compile time | Zero runtime cost |
| **Declarative Flow Definition** | Thin layer over existing wiring | Flow visualization, impossible-state prevention | Keep all existing nodes |

### Tier 2: Do These Next (Medium effort, high reward)

| Pattern | Effort | Impact | Why |
|---------|--------|--------|-----|
| **Redux-style Actions** | Per-flow migration | Debuggability, replay, action logs | Adopt for one flow first (tool-use is the best candidate) |
| **Higher-Order Flows** | Refactor PersistedFlow hierarchy | Composability, testability | Do after FlowScope stabilizes |

### Tier 3: Consider for New Flows (Higher effort, specialized reward)

| Pattern | Effort | Impact | Why |
|---------|--------|--------|-----|
| **Micro-reactive events** | ~50 lines + migration | Replaces manual throttle/queue code | Only if event handling complexity grows |
| **Effect Isolation** | Paradigm shift | Perfect testability, middleware | Best for brand-new flow types |

---

## Appendix: How These Patterns Interact

```
┌─────────────────────────────────────────────────────┐
│                   Flow Definition                    │
│              (Declarative FSM, Pattern 1)            │
│                                                      │
│   ┌─────────┐     ┌─────────┐     ┌─────────┐      │
│   │ prepare │────▶│  cycle  │────▶│  wait   │      │
│   └─────────┘     └─────────┘     └────┬────┘      │
│                        ▲               │ continue    │
│                        └───────────────┘             │
└──────────────────────────┬──────────────────────────┘
                           │ wrapped by
              ┌────────────┼────────────────┐
              │            │                │
      ┌───────▼──────┐ ┌──▼────────┐ ┌────▼──────┐
      │  Persistence │ │  Rounds   │ │  Timeout  │
      │   Wrapper    │ │  Wrapper  │ │  Wrapper  │
      │ (Pattern 7)  │ │(Pattern 7)│ │(Pattern 7)│
      └──────────────┘ └───────────┘ └───────────┘
              │
              │ runs within
      ┌───────▼──────┐
      │  FlowScope   │
      │ (Pattern 2)  │
      │              │
      │  owns:       │
      │  - session   │
      │  - interrupt │
      │  - cleanup   │
      └──────────────┘
              │
              │ nodes dispatch to
      ┌───────▼──────┐        ┌────────────────┐
      │ SharedStore  │───────▶│  Action Log    │
      │ (Pattern 3)  │        │  (debuggable,  │
      │              │        │   replayable)  │
      └──────────────┘        └────────────────┘
              │
              │ effects handled by
      ┌───────▼──────┐
      │ Effect Runner│
      │ (Pattern 4)  │
      │              │
      │ middleware:  │
      │ - rate limit │
      │ - cache      │
      │ - logging    │
      └──────────────┘
              │
              │ emits events to
      ┌───────▼──────┐
      │  Event Bus   │
      │ (Pattern 5)  │
      │              │
      │  operators:  │
      │  - groupBy   │
      │  - debounce  │
      │  - combine   │
      └──────────────┘
```

These patterns are **independently adoptable**. Start with FlowScope (Pattern 2) and CQS (Pattern 6) — they're essentially free. Then layer in declarative definitions (Pattern 1) and reducers (Pattern 3) as you build new flows.

The key insight from all these industry patterns is the same: **make implicit things explicit**. Implicit state machines → explicit definitions. Implicit mutations → explicit actions. Implicit cleanup → explicit scopes. Implicit effects → explicit descriptions. Each one trades a tiny bit of verbosity for a massive gain in debuggability and composability.
