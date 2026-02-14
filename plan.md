# Simplify Agent/Flow Architecture — Revised Proposal

## Previous Plan vs Reality

The original plan proposed flattening the CycleNode wrappers into the parent flows
for ~425 lines saved. After tracing every code path, **Changes 1-3 are NOT feasible
as proposed.** Here's why, and what IS actually doable.

---

## Why Flattening Doesn't Work

### The Serialization Boundary (the real reason the wrappers exist)

Both parent flows use **persisted flows** (`RoundPersistedFlow` for reflection,
`PersistedFlow` for tool-use). After every node step, the entire shared state is
serialized via `structuredClone()` to a KV store (`persisted-flow.ts:86,153`).

The inner cycle flows are **plain `Flow`** instances (not persisted). They hold
transient, non-serializable state:

**ResponseCycleFlow** (`ResponseCycleFlow.ts:83-88`):
```typescript
// CycleTransientFields — explicitly NOT serialized
interface CycleTransientFields {
  systemPrompt?: string;
  responseObject?: unknown;  // Raw provider response — NOT structuredClone-safe
}
```

**ToolUseCycleFlow** (`ToolUseCycleFlow.ts:150-158`):
```typescript
response: z.unknown().optional(),           // Raw provider response
toolCalls: z.array(z.unknown()).optional(),  // SdkToolCall[] — class instances
```

If these fields were on `ReflectionFlowShared` or `ToolUseRunShared`, the
`structuredClone()` call in `PersistedFlow.serializeShared()` would **throw**
on non-cloneable provider response objects.

The wrapper nodes (`ResponseCycleNode`, `ToolUseCycleNode`) are **not just
wrappers** — they are **serialization adapters** that create a transient sandbox
(`ResponseCycleShared` / `ToolUseCycleShared`) for the cycle to operate in,
then extract only the serializable results back to the persisted shared state.

### The Service Lifetime Mismatch

`Flow._orchestrate()` (`node/index.ts:274`) calls `current.setServices(this._services)`
on every node. Services are set once for the entire flow.

The cycle services include per-cycle mutable values:
- `client: C` — lazily fetched API client (via `buildCycleServices` getter)
- `round: ConversationRoundStateSnapshot` — mutated during the cycle
- `workspace: AgentWorkspaceState` — mutated during the cycle

These can't be on the flow-level services (which are set once and shared across
all round iterations). They need to be created fresh each cycle — which is
exactly what the wrapper nodes do.

### The Type Parameter Mismatch

All nodes in a single `Flow<S, P, Svc>` must share the same `S` type.
The inner cycle nodes are typed against `ResponseCycleShared` / `ToolUseCycleShared`.
The parent flow nodes are typed against `ReflectionFlowShared` / `ToolUseRunShared`.
These are fundamentally different shapes. Flattening would require retyping all
inner cycle node classes — 4 classes for response, 4 for tool-use.

---

## What IS Actually Possible

### Change A: Eliminate CycleOutcome double-interpretation (SAVE ~60 lines)

Both wrappers construct an intermediate discriminated union from the cycle's
mutable shared state, then interpret that union in `post()`.

**ResponseCycleNode** (`ResponseCycleNode.ts:31-34,108-118,150-174`):
```typescript
// Current: exec() reads cycleShared → constructs CycleOutcome
type CycleOutcome =
  | { outcome: 'completed'; endTurn: boolean }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; error: Error; retryable?: boolean };

// exec() builds it:
if (cycleShared.lastError) return { outcome: 'failed', ... };
if (cycleShared.shouldStop && !cycleShared.endTurn) return { outcome: 'cancelled' };
return { outcome: 'completed', endTurn: cycleShared.endTurn };

// post() interprets it:
if (execRes.outcome === 'failed') { throw execRes.error; }
shared.endTurn = execRes.outcome === 'completed' ? execRes.endTurn : false;
if (execRes.outcome === 'cancelled') { shared.continueRounds = false; }
```

**Proposed:** Return `cycleShared` directly from `exec()`. In `post()`, read
the cycle's fields directly. No intermediate enum.

```typescript
// New: exec() returns cycleShared itself
async exec(prepRes): Promise<ResponseCycleShared> {
  // ... same setup ...
  await flow.run(cycleShared);
  return cycleShared;
}

// New: post() reads cycle fields directly
async post(shared, prepRes, cycleShared): Promise<string | undefined> {
  if (cycleShared.lastError) {
    shared.lastError = { message: cycleShared.lastError.message, retryable: ... };
    throw new Error(cycleShared.lastError.message);
  }
  if (cycleShared.shouldStop && !cycleShared.endTurn) {
    shared.continueRounds = false;
    return FlowTransition.DEFAULT;
  }
  shared.endTurn = cycleShared.endTurn;
  // ... rest stays same ...
}
```

**Lines eliminated per wrapper:**
- CycleOutcome type definition: 4 lines
- Outcome construction in exec(): ~10 lines
- Outcome interpretation switch in post(): ~8 lines
- Error catch → CycleOutcome conversion: ~10 lines
- Total: ~32 lines per wrapper

**Savings: ~60 lines** (ResponseCycleNode ~32, ToolUseCycleNode ~28)

### Change B: Extract shared prep pattern (SAVE ~20 lines)

Both `ResponsePrepNode` (`ResponseCycleFlow.ts:120-164`) and `ToolUsePrepNode`
(`ToolUseCycleFlow.ts:239-300`) share this exact pattern:

```typescript
// Shared: check interruption (both prep nodes)
const interrupted = this.services.checkInterruption();

// Shared: handle interruption (both post nodes)
if (prepRes.interrupted) {
  shared.shouldStop = true;
  shared.endTurn = false;
  return FlowTransition.COMPLETE;
}

// Shared: reset + debug save (both post nodes, ~12 lines each)
resetCycleState(shared, [...]);
await maybeSaveDebugObject({
  object: shared.messages,
  objectType: 'messages',
  context: getDebugContext(this.services, { modelName, isRemote }),
  fileOptions: { continuationCount: ..., baseName: ... },
});
```

**Unique logic that stays:**
- ResponsePrepNode: derives systemPrompt, checks outputLocation existence
- ToolUsePrepNode: injects queued follow-ups, resets cycleResponseTimeMs

**Proposed:** Extract `handleCycleInterruption()` (~5 lines) and
`saveCycleDebugMessages()` (~10 lines) helpers in `CommonCycleTypes.ts`.

**Savings: ~20 lines** (replacing ~12 duplicated lines in each prep node with
function calls)

### Change C: Simplify buildCycleServices (SAVE ~15 lines)

`buildCycleServices()` (`CycleServices.ts:57-80`) creates a lazy client getter.
It's only called from the two wrapper nodes with near-identical arguments.

**Proposed:** The wrapper nodes already have access to `this.services.modelHandler`.
Replace the generic `buildCycleServices()` with inline client creation:

```typescript
// In ResponseCycleNode.exec():
const client = await this.services.modelHandler.getClient();
flow.setServices({
  ...this.services,
  client,
  round: prepRes.round,
  run: prepRes.run,
  workspace: prepRes.workspace,
});
```

This eliminates:
- `buildCycleServices()` function (24 lines)
- `refreshClient` abstraction (unused by cycle nodes after creation)

**Savings: ~15 lines**

---

## Revised Summary

| Change | What | Lines Saved | Risk |
|---|---|---|---|
| A | Eliminate CycleOutcome enums | ~60 | Low — mechanical refactor |
| B | Extract shared prep pattern | ~20 | Low — pure extraction |
| C | Simplify buildCycleServices | ~15 | Low — inline + delete |
| **Total** | | **~95** | |

4,293 lines → ~4,198 lines (2.2% reduction)

---

## Honest Assessment

**The agent/flow system does not have a large consolidation opportunity.**

The two-level flow architecture (persisted parent flow + transient inner cycle) exists
for a real reason: **the serialization boundary**. The wrapper nodes are legitimate
adapters, not gratuitous indirection. The CLAUDE.md guidance on "Flattening Abstraction
Layers" applies to wrappers that exist for no reason — these wrappers manage a genuine
concern (transient vs persisted state).

The two cycle flows (Response: 690 lines, ToolUse: 938 lines) are genuinely different:
- Response: file writing, LaTeX connectors, text replacement, continuation/prefill
- ToolUse: tool execution, deduplication, batching, streaming, media

They share ~80 lines of common pattern (already factored into `ModelInvocationNode`
and `CommonCycleTypes`). Forcing them together would create a god-class.

**Where the real code volume is:**
| Component | Lines | Justified? |
|---|---|---|
| ToolUseDispatchNode (tool execution) | 362 | Yes — real tool dispatch complexity |
| ResponseProcessNode (response handling) | 252 | Yes — file I/O, replacements, connectors |
| OutputNode (XML/diff processing) | 275 | Yes — output processing domain logic |
| RetryState (retry infrastructure) | 357 | Yes — retry + token refresh logic |
| runReflectionFlow (orchestration) | 324 | Mostly setup — hard to reduce |
| runToolUseFlow (orchestration) | 212 | Mostly setup — hard to reduce |

These are all doing real, unique work. The ~95 lines of genuine waste (CycleOutcome
enums, duplicated prep patterns, buildCycleServices indirection) are worth cleaning
but aren't a "big" win.

## Implementation Order

1. **Change B** (extract prep helpers) — smallest, safest, self-contained
2. **Change A** (eliminate CycleOutcome) — moderate, touchees only 2 files
3. **Change C** (simplify buildCycleServices) — cleanup after A
