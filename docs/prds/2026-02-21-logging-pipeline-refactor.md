---
created: 2026-02-21
updated: 2026-02-21
---

# PRD: Logging Pipeline Refactor — Store-and-Notify Architecture

## Status: Draft

## Problem

The current pipeline from `AgentLogger` to progress view frontend has **~15 hops** and **5 independent buffering/throttle mechanisms**, each compensating for coupling problems in the layer above. The chain works correctly but is difficult to reason about, has unnecessary overhead on the streaming hot path, and conflates two unrelated concerns (text logging and structured UI events) through a single abstraction (Winston).

### Current Pipeline

```
AgentLogger.info("", { messageType: TOOL_USE, data })
  → logUtils.info()                              // AsyncLocalStorage group lookup
    → registry.ensure()                           // Winston logger lookup/creation
      → winston.log()                             // Format pipeline (timestamp)
        → VSCodeTransport.log()                   // Winston transport
          → channel.appendLine()                  ← Destination 1: Output Channel
          → emitLogEvent()                        // Filter, UUID, Zod parse
            → bus.emit('addLogMessage')            // EventBus (buffer if no listeners)
              → StreamEventQueue.enqueue()         // Per-stream serialization
                → handleAddLogMessage()            // Backend event handler
                  → streamTabs.addMessage()        // Duplicate state (indexes, debounced save)
                    → webviewUpdater.appendLogMessage()  // Active-stream guard
                      → webview.postMessage()      ← IPC boundary
                        → dispatchMessage()        // Command routing
                          → logSlice.APPEND_LOG    // pendingLogUpdates Map (OOO buffer)
                            → Mutative create()    // Immutable state update
                              → Signal update      // Reactive propagation
                                → willUpdate()     // Context sync
                                  → Lit render     ← Destination 2: UI
```

### Five Buffering/Throttle Mechanisms

| Buffer                              | Location                     | Why It Exists                                                     |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| EventBus replay buffer (1000 items) | `ProgressEventBus.buffer`    | Listeners might not be attached yet                               |
| StreamEventQueue                    | `StreamEventQueue.queues`    | Async handlers can reorder `add` / `update` pairs                 |
| Backend `streamTabs`                | `StreamTabsManager`          | Full duplicate of all logs for persistence + tab-switch hydration |
| Frontend `pendingLogUpdates`        | `logSlice.ts`                | `UPDATE_LOG` can arrive before `APPEND_LOG` across IPC            |
| `createStream` 100ms throttle       | `AgentLogger.createStream()` | Rate-limit streaming text updates to the bus                      |

Each buffer exists because the push-based chain doesn't guarantee ordering or listener presence at the next layer. Buffers compensating for architectural coupling problems is the core smell.

### API Design Issues

**1. Empty-string text for data-only entries**

Methods like `logToolUse` and `logWebSearch` force a text message through a text-oriented logger:

```typescript
logToolUse(data: unknown, groupId?: string): void {
  this.info('', { groupId, messageType: MESSAGE_TYPES.TOOL_USE, data });
}

logWebSearch(data: unknown, groupId?: string): void {
  this.info('', { groupId, messageType: MESSAGE_TYPES.WEB_SEARCH, data });
}
```

The `''` is a lie — these aren't text log messages. They're structured events that happen to flow through the text logging pipeline because there's no separate path for structured data.

**2. Dual emit paths**

`logToolUseStart` bypasses Winston entirely and emits directly to the bus:

```typescript
logToolUseStart(toolName, input, groupId?) {
  this.debug(`Tool started: ${toolName}`, { groupId });  // → Winston path
  bus.emit('addLogMessage', { ... });                      // → Direct bus path
  return { logId, groupId };
}
```

This direct emission exists because Winston can't return an ID for the entry it just created — the transport emits asynchronously. The method needs to return a `logId` for later `updateToolUse()` calls. This is a sign that the abstraction doesn't fit the use case.

**3. `createStream` has its own throttling**

`AgentLogger.createStream()` implements a 100ms trailing-edge throttle for streaming text updates, plus its own `add`/`update` state machine (`messageCreated` flag). This is a fifth buffering/timing mechanism, living inside the logger itself, with its own `setTimeout` lifecycle.

**4. `startGroup` has a timing band-aid**

```typescript
async startGroup(groupName, id?, parentGroupId?): Promise<string> {
  await delay(SHORT_SLEEP_MS);  // 50ms sleep!
  return logger.startGroup(...);
}
```

This `delay(50)` exists to ensure group-start events arrive at the UI before child log entries in the push-based pipeline. It's an async timing hack compensating for lack of ordering guarantees.

**5. `contextState` side-channel**

`VSCodeTransport.maybeEmitContextState()` piggybacks a second event onto `CONTEXT_STATE` log messages:

```typescript
// After emitting addLogMessage, also emits a separate event:
bus.emit('updateContextState', { streamId, contextState });
```

A log message with `messageType: CONTEXT_STATE` triggers both `addLogMessage` and `updateContextState` as a side effect. The data is Zod-parsed from the log entry's `data` field to extract `contextState`. This is the logger acting as an event router — it logs context stats via `info()`, and the transport layer extracts structured data and emits a separate event.

**6. AsyncLocalStorage group context**

The `resolveActiveGroupId` system uses `AsyncLocalStorage` to track which task group a log belongs to. This works but creates invisible coupling — the group context is ambient state that every log call implicitly depends on. The `runWithGroup` / `pushGroup` / `popGroup` dance is correct but fragile (leaks if an `await` is missed). See Phase 0 for the fix.

### Winston Overhead

Winston provides: multi-transport routing, log levels, format pipelines, and metadata merging. What we actually use:

- **1 transport** per logger (VSCodeTransport)
- **Timestamp formatting** (one `winston.format.timestamp()` call)
- **Level filtering** — but we do our own filtering in `getEmitFilter()` anyway

Winston's value proposition is for applications with multiple transports (file, console, remote). We have exactly one transport that destructures the Winston `info` object back into the same fields that were assembled _for_ Winston. The format pipeline and transport abstraction are pure overhead on every log call.

## Design: Store-and-Notify

### Industry Pattern

The core idea comes from how Chrome DevTools, VS Code's built-in output, game engines, and event sourcing systems handle the same problem:

**Instead of pushing data through a chain of transforms, write once to a store and notify consumers to pull.**

```
Producer → Store (append-only, single source of truth)
               ↓ notify              ↓ notify
          OutputChannel           WebviewBridge
          (reads store)           (batched pull → postMessage)
```

### Key Principles

1. **Single write, multiple reads**: Data is written once to the `StreamLog` store. Consumers read at their own pace.
2. **Pull over push**: Consumers decide when to read, eliminating "is the next layer ready?" buffering.
3. **Separate text logging from structured events**: OutputChannel gets text; the UI store gets typed entries. They're different consumers of the same action, not stages in a pipeline.
4. **Batch at the IPC boundary**: The webview bridge coalesces updates per 16ms frame, sending one `postMessage` per frame instead of one per entry.
5. **Append order = display order**: Sequential writes to the store guarantee ordering. No timing hacks (`delay(50)`), no serialization queues (`StreamEventQueue`), no out-of-order compensation (`pendingLogUpdates`).

### Proposed Pipeline

```
AgentLogger.info("message")
  → StreamLog.append(entry)          // O(1), assigns seqNo
  → OutputChannel.appendLine(text)   // Sync, immediate
  → WebviewBridge.notify(streamId)   // Schedules batched send

AgentLogger.emit({ type: TOOL_USE, data })
  → StreamLog.append(entry)          // Same store, typed entry
  → WebviewBridge.notify(streamId)   // No output channel (no text)
```

**~4 hops instead of ~15.** One store. One notification. One batched send.

## Detailed Design

### Layer 1: StreamLog (Append-Only Store)

The single source of truth for all log entries and task groups per stream.

```typescript
interface StreamLogEntry {
  seqNo: number;              // Monotonic, store-assigned
  id: string;                 // UUID for update correlation
  type: EntryType;            // 'log' | 'group-start' | 'group-end'
  level: LogLevel;
  timestamp: number;
  groupId?: string;
  messageType: MessageType;
  text?: string;              // Optional — structured events don't need text
  data?: unknown;             // Typed payload for tool-use, web-search, etc.
}

class StreamLog {
  private entries: StreamLogEntry[] = [];
  private seqCounter = 0;
  private indexById = new Map<string, number>();
  private dirtyUpdates = new Set<string>();  // CDC: tracks mutated entries
  private listeners = new Set<(streamId: string) => void>();

  /** O(1) append, assigns seqNo, notifies listeners */
  append(entry: Omit<StreamLogEntry, 'seqNo'>): StreamLogEntry { ... }

  /** O(1) in-place update. Adds entry to dirty set so the bridge re-sends it. */
  update(id: string, patch: Partial<StreamLogEntry>): boolean { ... }

  /** New entries from cursor to head. */
  getRange(fromSeq: number, toSeq?: number): StreamLogEntry[] { ... }

  /** Returns and clears all entries mutated since last drain. */
  drainDirtyUpdates(): StreamLogEntry[] { ... }

  /** Current head sequence number */
  get head(): number { return this.seqCounter; }

  /** Subscribe to changes */
  onChange(listener: (streamId: string) => void): () => void { ... }
}
```

**What this replaces:**

- `ProgressEventBus` replay buffer (store _is_ the buffer — always available)
- `StreamEventQueue` (append-only = naturally ordered, no async handlers to reorder)
- Backend `StreamTabsManager` message storage (StreamLog _is_ the persistence-ready store)
- Frontend `pendingLogUpdates` (sequential seqNo = no out-of-order possible)
- `startGroup` 50ms `delay()` (append order guarantees group-start before child entries)

**Update semantics**: `update()` mutates in-place and adds the entry to a `dirtyUpdates` set. The bridge drains this set on each flush, re-sending entries the cursor has already passed. Without this, `updateToolUse()` (fired seconds after the entry was first sent) would be silently lost. Multiple updates to the same entry coalesce naturally — Set is idempotent, bridge reads final state.

**Persistence**: StreamLog owns its own debounced save (inherits the current 300ms pattern from `StreamTabsManager`). Consumers never wait for persistence.

### Layer 2: AgentLogger (Simplified API)

```typescript
class AgentLogger {
  constructor(
    private streamId: string,
    private store: StreamLogStore, // StreamLog per stream
    private channel?: OutputChannel, // Optional, for text output
  ) {}

  // --- Text logging (goes to both OutputChannel and store) ---
  info(message: string, opts?: LogOptions): void {
    this.channel?.appendLine(formatLine('info', message));
    if (!this.shouldEmit(opts)) return;
    this.store.append(this.streamId, {
      id: randomUUID(),
      type: 'log',
      level: 'info',
      timestamp: Date.now(),
      groupId: opts?.groupId ?? this.resolveActiveGroupId(),
      messageType: opts?.messageType ?? MESSAGE_TYPES.DEFAULT,
      text: message,
      data: opts?.data,
    });
  }

  // --- Structured events (store only, no text) ---
  emitToolUse(
    data: ToolUseLog,
    groupId?: string,
  ): { logId: string; groupId?: string } {
    const id = randomUUID();
    const resolvedGroup = groupId ?? this.resolveActiveGroupId();
    this.store.append(this.streamId, {
      id,
      type: 'log',
      level: 'info',
      timestamp: Date.now(),
      groupId: resolvedGroup,
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: { ...data, status: 'in_progress' },
    });
    return { logId: id, groupId: resolvedGroup };
  }

  updateToolUse(logId: string, data: ToolUseLog): void {
    this.store.update(this.streamId, logId, {
      data: { ...data, status: 'completed' },
    });
  }

  emitWebSearch(data: unknown, groupId?: string): void {
    this.store.append(this.streamId, {
      id: randomUUID(),
      type: 'log',
      level: 'info',
      timestamp: Date.now(),
      groupId: groupId ?? this.resolveActiveGroupId(),
      messageType: MESSAGE_TYPES.WEB_SEARCH,
      data,
    });
  }

  // --- Context state (direct state update, no log-as-side-channel) ---
  emitContextState(
    inputTokens: number,
    contextWindow: number,
    groupId?: string,
  ): void {
    const utilizationPercent = (inputTokens / contextWindow) * 100;
    // OutputChannel gets the text representation
    this.channel?.appendLine(
      formatLine(
        'info',
        `Context: ${inputTokens}/${contextWindow} tokens (${utilizationPercent.toFixed(1)}%)`,
      ),
    );
    // Store gets structured data — no Zod parse needed, no piggyback event
    this.store.append(this.streamId, {
      id: randomUUID(),
      type: 'log',
      level: 'info',
      timestamp: Date.now(),
      groupId: groupId ?? this.resolveActiveGroupId(),
      messageType: MESSAGE_TYPES.CONTEXT_STATE,
      data: { inputTokens, contextWindow, utilizationPercent },
    });
  }

  // --- Task groups (store entries, not separate event types) ---
  startGroup(name: string, id?: string, parentGroupId?: string): string {
    // No delay(50ms) needed — append order = display order
    const groupId = id ?? randomUUID();
    this.store.append(this.streamId, {
      id: groupId,
      type: 'group-start',
      level: 'info',
      timestamp: Date.now(),
      groupId: parentGroupId,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: name,
    });
    return groupId;
  }

  endGroup(groupId: string, status: EndGroupStatus): void {
    this.store.update(this.streamId, groupId, {
      type: 'group-end',
      data: { status, endTime: Date.now() },
    });
  }

  // --- Streaming text ---
  createStream(type: MessageType, opts?: StreamOptions): AgentLogStream {
    const id = randomUUID();
    const groupId = opts?.groupId ?? this.resolveActiveGroupId();
    let buffer = '';
    let created = false;

    return {
      append: (text: string) => {
        if (!text) return;
        buffer += text;
        if (!created) {
          // First chunk: append a new entry
          this.store.append(this.streamId, {
            id,
            type: 'log',
            level: 'info',
            timestamp: Date.now(),
            groupId,
            messageType: type,
            text: buffer,
          });
          created = true;
        } else {
          // Subsequent chunks: update in place.
          // No setTimeout throttle needed — store.update() is O(1),
          // and the bridge caps postMessage at ~60fps (16ms).
          this.store.update(this.streamId, id, { text: buffer });
        }
      },
      finalize: (finalText?: string) => {
        if (typeof finalText === 'string') buffer = finalText;
        if (!created) {
          this.store.append(this.streamId, {
            id,
            type: 'log',
            level: 'info',
            timestamp: Date.now(),
            groupId,
            messageType: type,
            text: buffer,
          });
        } else {
          this.store.update(this.streamId, id, { text: buffer });
        }
        return buffer;
      },
    };
  }
}
```

**Key changes:**

- No more `this.info('', { data })` — structured events use `emit*` methods
- `logToolUseStart` → `emitToolUse` — returns `logId` directly (no dual-emit hack)
- `logContextState` → `emitContextState` — writes to store directly instead of logging text then piggybacking a second event via `maybeEmitContextState()`
- `startGroup` is synchronous — no `await delay(50ms)` timing hack
- `createStream` — no 100ms `setTimeout` throttle. `store.update()` is O(1), and the `WebviewBridge` 16ms frame-rate cap handles rate limiting. If token chunks arrive at 200/sec, the store gets 200 in-place updates (each just a string reference swap + dirty set add), but the bridge only sends once per 16ms frame (~60 `postMessage` calls/sec). This is 6x more responsive than the current 100ms throttle with identical IPC throughput characteristics.
- `ToolUseCycleFlow` tool output streaming — no 500ms `STREAM_THROTTLE_MS`. Routes through `logger.updateToolUse()` instead of direct `bus.emit`. The 50KB `STREAM_BUFFER_MAX` truncation stays at the call site (tool-output-specific concern).
- `channel.appendLine()` is called directly — no Winston transport layer

### Layer 3: WebviewBridge (Batched IPC)

Replaces `WebviewUpdater` for **log-related messages only**. Batches updates at ~60fps via `setTimeout(16)`.

- **WebviewBridge**: log entries, task groups (cursor-based deltas, 16ms batching)
- **WebviewUpdater** (slimmed): everything else (low-frequency, push-based via EventBus)

```typescript
class WebviewBridge {
  private pending = false;
  private cursors = new Map<StreamTabId, number>(); // "How far I've read" per stream

  constructor(
    private store: StreamLogStore,
    private webview: () => vscode.Webview | undefined,
    private getActiveStream: () => StreamTabId | null,
  ) {
    store.onChange(() => this.scheduleFlush());
  }

  private scheduleFlush(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => this.flush(), 16); // ~60fps cap
  }

  private flush(): void {
    this.pending = false;
    const wv = this.webview();
    const activeStream = this.getActiveStream();
    if (!wv || !activeStream) return;

    const log = this.store.get(activeStream);
    if (!log) return;

    // New entries: everything past the cursor
    const cursor = this.cursors.get(activeStream) ?? 0;
    const entries = cursor < log.head ? log.getRange(cursor, log.head) : [];

    // Late updates: entries mutated after cursor moved past them (e.g. tool completion)
    const updates = log.drainDirtyUpdates().filter((e) => e.seqNo <= cursor); // Only entries we already sent

    if (entries.length === 0 && updates.length === 0) return;

    wv.postMessage({
      command: 'LOG_DELTA',
      streamId: activeStream,
      entries,
      updates,
    });
    this.cursors.set(activeStream, log.head);
  }

  /** Full hydration on tab switch — reset cursor so next flush sends everything */
  syncStream(streamId: StreamTabId): void {
    this.cursors.set(streamId, 0);
    this.scheduleFlush();
  }
}
```

**Cursor** = integer tracking "how far have I sent" per stream. Same concept as a Kafka consumer offset. On each flush: send entries from cursor to head, plus any dirty updates for entries already sent. Advance cursor.

**Why `setTimeout(16)` not `queueMicrotask`**: Each HTTP/SSE token chunk is a separate event loop iteration. `queueMicrotask` fires between iterations → one `postMessage` per chunk (~200/sec). `setTimeout(16)` caps at ~60/sec. 6x more responsive than the current 100ms throttle but with natural batching.

**What this eliminates:**

- Per-message `postMessage` → one per 16ms frame
- Separate `APPEND_LOG` / `UPDATE_LOG` / `UPDATE_LOGS` / `SYNC_STREAM_CONTENT` → one `LOG_DELTA`
- `createStream` 100ms throttle → bridge 16ms cap subsumes it
- `STREAM_THROTTLE_MS` 500ms in ToolUseCycleFlow → bridge handles rate limiting
- `pendingTaskGroups` buffer → store handles buffering

### Layer 4: Frontend (Simplified State Update)

```typescript
// Single handler for all log updates
handlers['LOG_DELTA'] = (data, ctx) => {
  const { streamId, entries, updates } = data;

  ctx.setStreamLogs(streamId, (prev) => {
    const { logs, logIndex } = prev;

    // 1. Append new entries (cursor-based, always in order)
    for (const entry of entries) {
      logIndex.set(entry.id, logs.length);
      logs.push(entry); // O(1) append
    }

    // 2. Patch late updates (dirty set entries that were already appended)
    for (const entry of updates) {
      const idx = logIndex.get(entry.id);
      if (idx !== undefined) {
        logs[idx] = entry; // In-place replace
      }
      // If idx is undefined, entry was never appended (shouldn't happen).
    }

    return { logs, logIndex, generation: prev.generation + 1 };
  });
};
```

**What this eliminates:**

- `pendingLogUpdates` Map (no out-of-order possible with sequential seqNo)
- `[...prev.logs, newLog]` array copies → in-place `push()` with generation counter
- Separate `APPEND_LOG` / `UPDATE_LOG` / `UPDATE_LOGS` handlers → one handler
- Per-entry `Mutative create()` → one state update per frame

## Migration Strategy

### Phase 0: Fix AsyncLocalStorage Group Scoping

**Goal**: Replace `enterWith()` with `run()` to get lexically-scoped group context, eliminating manual push/pop discipline.

**This phase has zero dependencies on the rest of the refactor and can ship immediately.**

#### Current Problem

The group context system uses `AsyncLocalStorage` to track which task group a log entry belongs to. The nesting looks like:

```
executeAgent()
  → taskStage = logger.stage("Task: agent@model")     // pushGroup(taskId)
    → taskStage.run(async () => {                       // within() → runWithGroup()
        logger.info("Executing...")                     // resolveActiveGroupId() → taskId ✓
        → roundStage = logger.stage("r0")               // pushGroup(r0Id)
          → roundStage.within(async () => {
              logger.info("Processing...")              // resolveActiveGroupId() → r0Id ✓
              → logger.logToolUseStart(...)              // resolveActiveGroupId() → r0Id ✓
            })                                          // popGroup(r0Id)
      })                                                // popGroup(taskId)
```

The `AsyncLocalStorage<Map<string, string[]>>` in `logUtils.ts` holds a per-channel stack of group IDs. The problem is **how** the stack is managed:

```typescript
// logUtils.ts — current implementation
function pushGroup(channel: string, groupId: string, isAgent: boolean): void {
  const store = getStore();
  const key = getKey(channel, isAgent);
  store.set(key, [...(store.get(key) ?? []), groupId]);
  contextStorage.enterWith(store); // ← Mutates current async context globally
}

function popGroup(channel: string, groupId: string, isAgent: boolean): void {
  const store = getStore();
  const key = getKey(channel, isAgent);
  const stack = store.get(key);
  // ... find and remove groupId from stack
  contextStorage.enterWith(store); // ← Must be perfectly paired with push
}
```

`enterWith()` replaces the context for the **entire** current execution chain — it doesn't create a child scope. This means:

1. **Manual stack discipline**: Every `pushGroup` must have a matching `popGroup` in a `try/finally`. The `runWithGroupContext` wrapper handles this, but `stage.within()` → `runWithGroup()` → `runWithGroupContext()` is three layers of indirection to ensure one push is popped.

2. **Concurrent visibility**: If two async operations share the same channel key and overlap in time, `enterWith` makes each operation's push visible to the other. This doesn't bite us today because per-stream operations are effectively sequential, but it's a latent bug.

3. **Stack corruption on missed cleanup**: If an error propagates without hitting the `finally`, the group stack is permanently corrupted for that channel.

#### Industry Context

This problem — "which parent scope does this operation belong to?" — is solved in three ways across the industry:

| Pattern                            | Used By                                                                                     | Mechanism                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Explicit context passing**       | OpenTelemetry spans, Go `context.Context`, Rust `tracing::Span`                             | Scope passed as parameter to every function                  |
| **Structured concurrency scoping** | Kotlin coroutines, Swift `TaskLocal`, Java `ScopedValue`, Node.js `AsyncLocalStorage.run()` | Scope tied to the structured concurrency tree, auto-cleaned  |
| **Scoped logger instances**        | Go zap/zerolog `.With()`, Rust `tracing::span::Entered`, Python `structlog.bind()`          | Logger carries its scope; child loggers inherit parent scope |

Our `AsyncLocalStorage` usage is closest to **structured concurrency scoping** — but `enterWith()` breaks the structured guarantee. `enterWith` is explicitly documented by Node.js as "for rare cases where `.run()` isn't applicable" and comes with the caveat that "the store is not restored by exiting the function."

#### Fix: `enterWith` → `run`

Replace the push/pop stack with `contextStorage.run()` which creates a scoped child context that is automatically cleaned up when the callback exits:

```typescript
// logUtils.ts — fixed implementation

// Before: manual push/pop with enterWith
function pushGroup(channel, groupId, isAgent) { ... enterWith(store) ... }
function popGroup(channel, groupId, isAgent) { ... enterWith(store) ... }
export async function runWithGroupContext<T>(channel, groupId, isAgent, fn) {
  pushGroup(channel, groupId, isAgent);
  try { return await fn(); }
  finally { popGroup(channel, groupId, isAgent); }
}

// After: scoped via .run(), no push/pop
export function runWithGroupContext<T>(
  channel: string,
  groupId: string,
  isAgent: boolean,
  fn: () => Promise<T> | T,
): Promise<T> {
  const parentStore = contextStorage.getStore() ?? new Map();
  // Create a child store (shallow clone) with the new group pushed
  const childStore = new Map(parentStore);
  const key = getKey(channel, isAgent);
  childStore.set(key, [...(childStore.get(key) ?? []), groupId]);
  // .run() scopes the store to this callback — automatic cleanup
  return contextStorage.run(childStore, fn);
}
```

**What this eliminates:**

- `pushGroup()` function — no longer needed
- `popGroup()` function — no longer needed
- `try/finally` discipline in callers — `run()` guarantees cleanup
- Risk of stack corruption on missed cleanup

**What stays the same:**

- `getActiveGroupId()` — still reads from `contextStorage.getStore()`
- `resolveActiveGroupId()` on `AgentLogger` — still calls `getActiveGroupId()`
- `stage.within()` → `runWithGroup()` → `runWithGroupContext()` call chain — same behavior, just safer internals
- All call sites in `executeAgent.ts`, `RoundPersistedFlow`, `ToolUseCycleFlow` — no changes needed

**Files modified:**

| File                     | Change                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/logger/logUtils.ts` | Replace `pushGroup`/`popGroup`/`enterWith` with `contextStorage.run()` in `runWithGroupContext`. Remove `pushGroup`, `popGroup` functions. `startGroup` calls `runWithGroupContext` internally instead of raw `pushGroup`. |

**Risk**: Low. The external API (`runWithGroupContext`, `getActiveGroupId`, `startGroup`, `endGroup`) is unchanged. Only the internal scoping mechanism changes. The `stage.within()` / `stage.run()` usage patterns in all call sites remain identical.

### Phase 1: StreamLog Store + Direct OutputChannel (Backend Only)

**Goal**: Replace Winston + EventBus + StreamTabsManager with StreamLog for log messages.

**Migration pattern**: Strangler fig with dual-write verification. Both old and new paths run simultaneously during transition, allowing output comparison before cut-over. This is how Stripe, GitHub, and Netflix handle data infrastructure migrations — build new alongside old, verify parity, then remove old.

#### Phase 1a: New Store (Additive Only)

Implement `StreamLog`, `StreamLogStore`, and `WebviewBridge`. No existing code modified or removed.

**Files created:**

| File                                         | Purpose                                                     |
| -------------------------------------------- | ----------------------------------------------------------- |
| `src/logger/StreamLog.ts`                    | Append-only store with seqNo, dirty tracking, delta reads   |
| `src/logger/StreamLogStore.ts`               | Per-stream StreamLog manager with persistence               |
| `src/progressView/managers/WebviewBridge.ts` | Batched IPC with cursor tracking + dirty set, 16ms throttle |

**Rollback**: Delete new files.

#### Phase 1b: Dual-Write

`AgentLogger` writes to **both** old Winston path AND new store. Both paths active. This lets us verify the store captures every entry the old path does.

**Files modified:**

| File                                       | Change                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/logger/AgentLogger.ts`                | Add store writes alongside existing Winston/bus calls. Add `emit*` methods for structured events (initially calling both old + new paths). `createStream` writes to both old bus.emit and new store.update().                                                                                               |
| `src/agent/core/flows/ToolUseCycleFlow.ts` | Route tool output through `options.logger.updateToolUse()` instead of direct `bus.emit('updateLogMessage')`. Removes the 500ms `STREAM_THROTTLE_MS` — bridge's 16ms frame cap handles rate limiting. Keeps `STREAM_BUFFER_MAX` truncation at call site (tool-output-specific, not a generic store concern). |

**Rollback**: Remove store write calls from AgentLogger.

#### Phase 1c: Bridge Alongside Old Handlers

Frontend receives `LOG_DELTA` alongside old `APPEND_LOG` / `UPDATE_LOG`. Verify parity — same entries appear in both paths.

**Files modified:**

| File                                              | Change                                                   |
| ------------------------------------------------- | -------------------------------------------------------- |
| `src/progressView/frontend/slices/logSlice.ts`    | Add `LOG_DELTA` handler (existing handlers stay for now) |
| `src/progressView/events/ProgressEventHandler.ts` | Wire `WebviewBridge` into event handler lifecycle        |

**Rollback**: Disable bridge, revert to old handlers only.

#### Phase 1d: Cut-Over

Remove old log path. Winston, VSCodeTransport, old bus emits, and old frontend log handlers are deleted.

**Task group bridging**: `startGroup()` / `endGroup()` keep temporary direct `bus.emit('addTaskGroup')` / `bus.emit('updateTaskGroup')` calls (moved from deleted VSCodeTransport into AgentLogger). These stay until Phase 3 replaces them with store entries. Without this, task groups disappear from the UI between Phase 1 (VSCodeTransport deleted) and Phase 3 (store entries replace bus events).

**Files modified:**

| File                                              | Change                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/logger/AgentLogger.ts`                       | Remove Winston delegation. Remove `createStream` 100ms throttle. Remove `startGroup` 50ms `delay()`. `emitContextState` replaces `logContextState`. Add temporary `bus.emit('addTaskGroup')` / `bus.emit('updateTaskGroup')` in `startGroup()` / `endGroup()` (removed in Phase 3). Remove `addLogMessage` / `updateLogMessage` bus imports. |
| `src/progressView/events/ProgressEventHandler.ts` | Remove inline `addLogMessage`, `updateLogMessage`, `updateContextState` handlers from the unified `registerHandlers` call. `WebviewUpdater` retained for non-log messages.                                                                                                                                                                   |
| `src/eventBus/ProgressEventBus.ts`                | Remove `addLogMessage` / `updateLogMessage` / `updateContextState` event types                                                                                                                                                                                                                                                               |
| `src/progressView/managers/WebviewUpdater.ts`     | Remove `appendLogMessage` / `updateLogMessage` / `updateContextState` methods. Strip log fields from `sendSyncStreamContent`. Keep all non-log methods.                                                                                                                                                                                      |

**Files removed:**

| File                                       | Reason                                          |
| ------------------------------------------ | ----------------------------------------------- |
| `src/logger/transports/VSCodeTransport.ts` | Replaced by direct OutputChannel + store writes |
| `src/logger/LogChannelRegistry.ts`         | Winston logger registry no longer needed        |

**Rollback**: Revert to dual-write (Phase 1b) — old path still works.

### Phase 2: Frontend Simplification

**Goal**: Clean up old frontend handlers now that `LOG_DELTA` (added in Phase 1c) is the sole log delivery path.

1. Replace `[...prev.logs]` copies with in-place mutation + generation counter
2. Remove `pendingLogUpdates` Map
3. Remove `APPEND_LOG` / `UPDATE_LOG` / `UPDATE_LOGS` handlers
4. Remove `SYNC_STREAM_CONTENT` handler (WebviewBridge.syncStream handles hydration)

**Files modified:**

| File                                            | Change                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/progressView/frontend/slices/logSlice.ts`  | Remove old `APPEND_LOG` / `UPDATE_LOG` handlers, `pendingLogUpdates` Map, `clearPendingLogUpdatesForStream`/`clearAllPendingLogUpdates` helpers, and `applyLogUpdate` shared function  |
| `src/progressView/frontend/store.ts`            | Add `generation` to `StreamLogs`, remove array spread                                                                                                                                  |
| `src/progressView/frontend/slices/syncSlice.ts` | Rewrite — `SYNC_STREAM_CONTENT` no longer delegates to `applyLogUpdate`; WebviewBridge.syncStream handles log hydration, sync handler only handles todos/follow-ups/instruction/badges |

### Phase 3: Task Groups as Store Entries

**Goal**: Unify task groups into the StreamLog store instead of separate event types.

1. `startGroup` / `endGroup` write to StreamLog as typed entries
2. Remove `addTaskGroup` / `updateTaskGroup` from EventBus
3. Remove `StreamEventQueue` (append-only store has no ordering issues)
4. Remove `pendingTaskGroups` buffer in `ProgressEventHandler`
5. Frontend derives task group tree from log entries (filter by `type: 'group-start' | 'group-end'`)

**Files modified/removed:**

| File                                              | Change                                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/eventBus/StreamEventQueue.ts`                | Remove entirely                                                                                                                                                                                                                         |
| `src/eventBus/ProgressEventBus.ts`                | Remove task group event types                                                                                                                                                                                                           |
| `src/progressView/events/ProgressEventHandler.ts` | Remove inline `addTaskGroup` / `updateTaskGroup` handlers, `pendingTaskGroups` buffer, `bufferTaskGroupForReplay`/`replayPendingTaskGroups`/`clearPendingTaskGroups`/`clearAllPendingTaskGroups` methods, and `streamEventQueue` import |
| `src/progressView/frontend/slices/taskSlice.ts`   | Remove `ADD_TASK_GROUP` / `UPDATE_TASK_GROUP` handlers (task groups now derived from `LOG_DELTA` entries)                                                                                                                               |

### Phase 4: Cleanup

1. Remove `logUtils.ts` intermediate layer (inline into `AgentLogger`)
2. Remove `filterUtils.ts` (emit filtering inlined into `AgentLogger.shouldEmit()`)

Note: Winston dependency removal from `package.json` happens in Phase 1d (when all Winston imports are removed), not here.

### Future: Scoped Logger Instances (Evaluate Later)

The long-term industry standard for the group context problem is **scoped logger instances** — the logger object itself carries its group context, and child loggers inherit from parents. This eliminates `AsyncLocalStorage` entirely.

```typescript
class ScopedLogger {
  constructor(
    private base: AgentLogger,
    private groupId?: string,
  ) {}

  info(message: string, opts?: LogOptions): void {
    this.base.info(message, {
      ...opts,
      groupId: opts?.groupId ?? this.groupId,
    });
  }

  /** Create a child logger scoped to a new group */
  child(groupName: string): ScopedLogger {
    const childGroupId = this.base.startGroup(
      groupName,
      undefined,
      this.groupId,
    );
    return new ScopedLogger(this.base, childGroupId);
  }
}

// Usage in executeAgent.ts:
const taskLogger = logger.child('Task: agent@model');
taskLogger.info('Executing...'); // → grouped under task

// Usage in RoundPersistedFlow:
createRoundStage: (roundIndex) => {
  const roundLogger = taskLogger.child(`r${roundIndex}`);
  // All logs within this round are grouped automatically
  return roundLogger;
};
```

**Used by**: Go's `zap.Logger.With()`, Rust's `tracing::span`, Python's `structlog.bind()`, Java's MDC-based loggers, JavaScript's `pino.child()`.

**Pros**:

- Zero ambient state — no `AsyncLocalStorage`, no `getStore()`, no hidden coupling
- Concurrent operations naturally get independent loggers with independent scopes
- Easy to test — pass a mock logger, no global context to set up
- Natural fit with `services.logger` pattern — swap the logger per scope

**Cons**:

- Requires threading the scoped logger through the call chain. Since `services.logger` already exists, this means updating it per scope (e.g., `{ ...services, logger: roundLogger }`)
- Significant call-site changes across `executeAgent.ts`, `RoundPersistedFlow`, `ToolUseCycleFlow`, `ResponseCycleFlow`
- The Phase 0 fix (`enterWith` → `run`) gets us 80% of the safety benefit with 5% of the effort

**Decision**: Defer. The `run()` fix in Phase 0 eliminates the main safety risk (stack corruption, missed cleanup). Scoped logger instances are a cleaner long-term architecture but require touching every call site. Evaluate after the store-and-notify pipeline is stable.

## What Stays Unchanged

- **Active-stream optimization**: Only the active stream gets deltas sent to the frontend. Inactive streams hydrate on tab switch. This moves from `ProgressEventHandler`'s inline log handlers to `WebviewBridge` but the behavior is identical.
- **Non-log events on EventBus**: `updateStreamStatus`, `showRetryRequest`, permission events, todos, usage, badges, follow-ups, etc. continue using the EventBus → `ProgressEventHandler` → `WebviewUpdater` path. These are low-frequency and well-served by push-based pub/sub.
- **`WebviewUpdater` for non-log messages**: Retained with `sendIfActive` pattern for stream metadata, permissions, todos, usage stats, badges, parent stream updates, etc.
- **Debounced persistence**: 300ms trailing-edge save pattern moves from `StreamTabsManager` to `StreamLog`.
- **`AsyncLocalStorage` group context** (after Phase 0 fix): Stays as structured concurrency scoping via `contextStorage.run()`. All call sites unchanged.

## Portability

`StreamLog.onChange()` is the reactive seam. The bridge is a transport adapter over it. Swapping the adapter is the only change needed per platform:

```
VS Code (two processes, IPC):
  StreamLog.onChange → WebviewBridge → postMessage → LOG_DELTA handler → state → render

Electron / Web SPA (one process, no IPC):
  StreamLog.onChange → signal.set(log.entries) → render
```

In a single-process app, the bridge, `postMessage`, and `LOG_DELTA` handler all disappear. The frontend subscribes directly to the store:

```typescript
store.onChange((streamId) => {
  if (streamId !== activeStream) return;
  const log = store.get(streamId);
  logSignal.set(log.entries);
});
```

| Component           | VS Code                                               | Electron / Web SPA                     |
| ------------------- | ----------------------------------------------------- | -------------------------------------- |
| StreamLog           | As-is                                                 | As-is                                  |
| AgentLogger         | As-is (swap `OutputChannel` for console or log panel) | As-is                                  |
| WebviewBridge       | `setTimeout(16)` + `postMessage`                      | Delete — direct signal binding         |
| LOG_DELTA handler   | Deserializes and applies to frontend state            | Delete — frontend reads store directly |
| Frontend components | As-is                                                 | As-is                                  |

No producer code changes. No store changes. Only the transport layer swaps.

## Non-Goals

- **Replacing the EventBus entirely**: Non-log events (permissions, status, UI callbacks) are low-frequency and well-served by pub/sub. Only high-frequency log events move to the store.
- **Changing the frontend component tree**: `LogList`, `TaskGroupList`, `StreamTabs` etc. stay the same. Only their data source changes (delta-based instead of per-message).
- **Ring buffer / fixed-size log**: Logs are bounded by session lifetime, not a fixed count. Append-only array is sufficient.

## Success Criteria

1. Pipeline from logger call to UI render is ≤5 hops
2. Zero buffering mechanisms outside the StreamLog store itself
3. No empty-string text in structured event logging (`logToolUse('')` pattern eliminated)
4. No timing hacks (`delay(50ms)` in `startGroup`, 100ms `setTimeout` in `createStream`)
5. No side-channel events (`maybeEmitContextState` piggyback eliminated)
6. Single `postMessage` per 16ms frame during streaming (not per log entry)
7. Frontend log append is O(1) (no array copy)
8. `WebviewUpdater` and `WebviewBridge` have clear, non-overlapping responsibilities
9. Winston dependency removed
10. `npm run typecheck` passes
11. No behavioral changes visible to the user

## Surface Area Inventory

Complete inventory of all EventBus producers, subscribers, and affected files for migration planning.

### bus.emit Producers — Log Events (Move to Store)

These 10 call sites emit log-related events that will migrate to `StreamLog.append()` / `StreamLog.update()`:

| File                                   | Line       | Event                | Trigger                                  | Phase                    |
| -------------------------------------- | ---------- | -------------------- | ---------------------------------------- | ------------------------ |
| `logger/AgentLogger.ts`                | 308        | `addLogMessage`      | `logToolUseStart()` — new tool-use entry | 1                        |
| `logger/AgentLogger.ts`                | 427        | `addLogMessage`      | `createStream()` first chunk             | 1                        |
| `logger/transports/VSCodeTransport.ts` | 120        | `addLogMessage`      | Any Winston `log()` call                 | 1 (file deleted)         |
| `logger/AgentLogger.ts`                | 332        | `updateLogMessage`   | `updateToolUse()` — finalize tool result | 1                        |
| `logger/AgentLogger.ts`                | 422        | `updateLogMessage`   | `createStream()` subsequent chunks       | 1                        |
| `agent/core/flows/ToolUseCycleFlow.ts` | 707        | `updateLogMessage`   | Throttled tool output flush              | 1                        |
| `logger/transports/VSCodeTransport.ts` | 59         | `addTaskGroup`       | `startGroup()` — stage begins            | 3 (file already deleted) |
| `logger/transports/VSCodeTransport.ts` | 73         | `updateTaskGroup`    | `endGroup()` — stage ends                | 3 (file already deleted) |
| `logger/transports/VSCodeTransport.ts` | 143        | `updateContextState` | `maybeEmitContextState()` piggyback      | 1 (file deleted)         |
| `logger/AgentLogger.ts`                | (indirect) | `updateContextState` | via VSCodeTransport side-channel         | 1                        |

### bus.emit Producers — Non-Log Events (Stay on EventBus)

These 33 call sites emit non-log events that remain on the EventBus unchanged:

| Event                                                  | Count | Key Files                                                           |
| ------------------------------------------------------ | ----- | ------------------------------------------------------------------- |
| `setActiveStream`                                      | 3     | `executeAgent.ts`, `bashApproval.ts`, `toolEditApproval.ts`         |
| `setTaskState`                                         | 1     | `executeAgent.ts`                                                   |
| `updateStreamStatus`                                   | 1     | `StreamStatusService.ts`                                            |
| `updateConversationProgress`                           | 2     | `executeAgent.ts` (round + tool-use callbacks)                      |
| `updateQueuedFollowUps`                                | 5     | `executeAgent.ts` (2), `followUpCommand.ts` (2), `resumeCommand.ts` |
| `setParentStream`                                      | 1     | `executionRegistry.ts`                                              |
| `updateActiveSubagents`                                | 1     | `ExecutionHandle.ts`                                                |
| `updateActiveProcesses`                                | 1     | `ExecutionHandle.ts`                                                |
| `updateStreamUsage`                                    | 1     | `AgentUsageReporter.ts`                                             |
| `updateTodos`                                          | 2     | `ToolUseCycleNode.ts` (skip + update callbacks)                     |
| `addOutputFiles`                                       | 1     | `OutputNode.ts`                                                     |
| `updateMissingOutputs`                                 | 2     | `OutputNode.ts`, `OutputFileProcessor.ts`                           |
| `clearMissingOutputs`                                  | 1     | `streamEventUtils.ts`                                               |
| `showBashPermission` / `resolveBashPermission`         | 2     | `bashApproval.ts`                                                   |
| `showToolEditPermission` / `resolveToolEditPermission` | 2     | `toolEditApproval.ts`                                               |
| `updateToolEditApprovalBypassState`                    | 1     | `toolEditApproval.ts`                                               |
| `updateSuperYoloBypassState`                           | 1     | `proposalApproval.ts`                                               |
| `showRetryRequest` / `resolveRetryRequest`             | 2     | `BasePromiseCoordinator.ts` (via `RetryRequestCoordinator`)         |
| `showAgentProposal` / `resolveAgentProposal`           | 2     | `BasePromiseCoordinator.ts` (via `AgentProposalCoordinator`)        |
| `extensionDeactivating`                                | 1     | `extension.ts`                                                      |

### bus.on Subscribers — Impact Per Phase

| Subscriber                                                          | Events Consumed                                                                                                                                                                                                                                                                                                                                                                                                                           | Phase Impact                                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProgressEventHandler` (unified via single `registerHandlers` call) | All domain events inline: `setActiveStream`, `updateStreamStatus`, `setTaskState`, `addTaskGroup`, `updateTaskGroup`, `updateConversationProgress`, `updateActiveSubagents`, `updateActiveProcesses`, `setParentStream`, `extensionDeactivating`, `addLogMessage`, `updateLogMessage`, `addOutputFiles`, `updateMissingOutputs`, `clearMissingOutputs`, `updateStreamUsage`, `updateContextState`, `updateTodos`, `updateQueuedFollowUps` | Phase 1: Remove `addLogMessage`, `updateLogMessage`, `updateContextState` handlers. Phase 3: Remove `addTaskGroup` / `updateTaskGroup`. Rest stays. |
| `ProgressEventHandler` (UI callbacks via `registerUIEvents`)        | All `show*` / `resolve*` permission events + bypass state events                                                                                                                                                                                                                                                                                                                                                                          | No change — stays on EventBus                                                                                                                       |
| `executionRegistry.ts`                                              | `updateStreamStatus`                                                                                                                                                                                                                                                                                                                                                                                                                      | No change                                                                                                                                           |
| `extension.ts` (status bar)                                         | `updateStreamStatus`                                                                                                                                                                                                                                                                                                                                                                                                                      | No change                                                                                                                                           |

### Files That Import `bus` — Removal Schedule

| File                                                            | Current bus Usage                                                                        | Removal Phase                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `logger/transports/VSCodeTransport.ts`                          | Emits log events + `updateContextState`                                                  | Phase 1: **Delete file**                                                       |
| `logger/AgentLogger.ts`                                         | Direct `addLogMessage` / `updateLogMessage` emits                                        | Phase 1: Replace with `store.append()` / `store.update()`. Bus import removed. |
| `agent/core/flows/ToolUseCycleFlow.ts`                          | Direct `updateLogMessage` for tool output                                                | Phase 1: Replace with `store.update()`. Bus import removed.                    |
| `logger/AgentUsageReporter.ts`                                  | `updateStreamUsage`                                                                      | **Stays** — non-log event                                                      |
| `agent/runtime/executeAgent.ts`                                 | `setActiveStream`, `setTaskState`, `updateConversationProgress`, `updateQueuedFollowUps` | **Stays** — non-log events                                                     |
| `agent/runtime/StreamStatusService.ts`                          | `updateStreamStatus`                                                                     | **Stays**                                                                      |
| `agent/runtime/ExecutionHandle.ts`                              | `updateActiveSubagents`, `updateActiveProcesses`                                         | **Stays**                                                                      |
| `agent/runtime/executionRegistry.ts`                            | `setParentStream` + subscribes `updateStreamStatus`                                      | **Stays**                                                                      |
| `agent/runtime/BasePromiseCoordinator.ts`                       | `show*` / `resolve*` (retry, proposal)                                                   | **Stays**                                                                      |
| `tools/approval/bashApproval.ts`                                | `setActiveStream`, `showBashPermission`, `resolveBashPermission`                         | **Stays**                                                                      |
| `tools/approval/toolEditApproval.ts`                            | `setActiveStream`, `showToolEditPermission`, `resolveToolEditPermission`                 | **Stays**                                                                      |
| `tools/approval/proposalApproval.ts`                            | `updateSuperYoloBypassState`                                                             | **Stays**                                                                      |
| `commands/agent/followUpCommand.ts`                             | `updateQueuedFollowUps`                                                                  | **Stays**                                                                      |
| `commands/agent/resumeCommand.ts`                               | `updateQueuedFollowUps`                                                                  | **Stays**                                                                      |
| `commands/housekeeping/streamEventUtils.ts`                     | `clearMissingOutputs`                                                                    | **Stays**                                                                      |
| `agent/implementations/flows/reflection/nodes/OutputNode.ts`    | `addOutputFiles`, `updateMissingOutputs`                                                 | **Stays**                                                                      |
| `agent/output/OutputFileProcessor.ts`                           | `updateMissingOutputs`                                                                   | **Stays**                                                                      |
| `agent/implementations/flows/tooluse/nodes/ToolUseCycleNode.ts` | `updateTodos`                                                                            | **Stays**                                                                      |
| `extension.ts`                                                  | `extensionDeactivating` + subscribes `updateStreamStatus`                                | **Stays**                                                                      |

**Net result**: 3 files lose their bus import (AgentLogger, VSCodeTransport, ToolUseCycleFlow). 16 files keep it for non-log events.

### Duplicate State Stores — Removal Schedule

| Store                              | Location                                     | What It Holds                            | Removal                                  |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `StreamTabsManager` message arrays | `progressView/managers/StreamTabsManager.ts` | Full copy of all log messages per stream | Phase 1: Replaced by `StreamLog`         |
| Frontend `pendingLogUpdates` Map   | `progressView/frontend/slices/logSlice.ts`   | Out-of-order update buffer               | Phase 2: Removed (sequential seqNo)      |
| Frontend `logIndex` Map            | `progressView/frontend/store.ts`             | Entry lookup by ID                       | Phase 2: Kept but built from `LOG_DELTA` |

### WebviewUpdater Methods — Removal Schedule

| Method                                     | Purpose                           | Phase                                                                                                    |
| ------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `appendLogMessage()`                       | Push single log entry to frontend | Phase 1: Removed (WebviewBridge)                                                                         |
| `updateLogMessage()`                       | Push log update to frontend       | Phase 1: Removed (WebviewBridge)                                                                         |
| `sendSyncStreamContent()` (log portions)   | Full log hydration on tab switch  | Phase 1: Log fields removed (WebviewBridge.syncStream); non-log fields (todos, badges, instruction) stay |
| `updateContextState()`                     | Push context utilization          | Phase 1: Removed (store entry)                                                                           |
| `updateTaskGroup()`                        | Push task group updates           | Phase 3: Removed (store entry)                                                                           |
| `addTaskGroup()`                           | Push new task group               | Phase 3: Removed (store entry)                                                                           |
| `updateStreamStatus()`                     | Push stream status change         | **Stays**                                                                                                |
| `sendStreamMetadata()`                     | Push stream tab metadata          | **Stays**                                                                                                |
| `updateTodos()` / `sendTodos()`            | Push todo list                    | **Stays**                                                                                                |
| `sendPermission()` / `resolvePermission()` | Push permission cards             | **Stays**                                                                                                |
| `updateBadge()` / other badge methods      | Push notification badges          | **Stays**                                                                                                |

### Frontend Handlers — Removal Schedule

| Handler               | Slice          | Phase                                                               |
| --------------------- | -------------- | ------------------------------------------------------------------- |
| `APPEND_LOG`          | `logSlice.ts`  | Phase 2: Replaced by `LOG_DELTA`                                    |
| `UPDATE_LOG`          | `logSlice.ts`  | Phase 2: Replaced by `LOG_DELTA`                                    |
| `UPDATE_LOGS`         | `logSlice.ts`  | Phase 2: Replaced by `LOG_DELTA`                                    |
| `SYNC_STREAM_CONTENT` | `syncSlice.ts` | Phase 2: Log portion replaced by `LOG_DELTA`; non-log portions stay |
| `ADD_TASK_GROUP`      | `taskSlice.ts` | Phase 3: Merged into `LOG_DELTA`                                    |
| `UPDATE_TASK_GROUP`   | `taskSlice.ts` | Phase 3: Merged into `LOG_DELTA`                                    |
| `UPDATE_TODOS`        | `taskSlice.ts` | **Stays** — non-log event                                           |

### EventBus Event Types — Removal Schedule

| Event Type           | Phase Removed | Replacement                                |
| -------------------- | ------------- | ------------------------------------------ |
| `addLogMessage`      | Phase 1       | `StreamLog.append()`                       |
| `updateLogMessage`   | Phase 1       | `StreamLog.update()`                       |
| `updateContextState` | Phase 1       | `StreamLog.append()` (typed entry)         |
| `addTaskGroup`       | Phase 3       | `StreamLog.append()` (type: 'group-start') |
| `updateTaskGroup`    | Phase 3       | `StreamLog.update()` (type: 'group-end')   |

## Resolve\* Pattern Audit

The codebase has **41 `resolve*` functions** across 6 domains. The user identified a design smell: many of these return nullable types, forcing callers into defensive gating at every call site.

### The Problem: Inconsistent Fallibility Convention

The `resolve*` functions use three different return conventions with no naming signal:

| Convention                                          | Count | Examples                                                                                                                                                                                               |
| --------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Returns `T \| null \| undefined` (caller must gate) | 9     | `resolveFile`, `resolveAgent`, `resolveStoragePath`, `resolveRunDir`, `resolveConfiguredCustomDir`, `resolveBaseUrl`, `resolveSoxPath`, `resolveFigurePath`, `resolveActiveGroupId`                    |
| Throws on failure (caller uses directly)            | 8     | `resolveWorkspaceRelativePath`, `resolveLatexFileOrThrow`, `resolveMemoryStoragePath`, `resolveMemoryPath`, `resolveExecutionId`, `resolveAgentBase`, `resolveAndAcquireStream`, `resolveSourceFile`   |
| Always returns valid value (no gating)              | 9     | `resolveAgentKey`, `resolveVisibleModel`, `resolveVsCodeApi`, `resolveThemeFromCssVars`, `resolveSymlinks`, `resolveTools`, `resolveToolDefinitions`, `resolveUploadMimeType`, `resolveTerminalStatus` |
| Returns `void` (side-effect only)                   | 7     | `resolveWebviewView`, `resolvePermission`, `resolveProgressViewApprovalPrompt`, `resolveWait`, `resolveRequest` (bool), `resolve` (ApprovalRequestHandler)                                             |
| Other                                               | 8     | Misc utilities (`resolveValue`, `resolvePath`, etc.)                                                                                                                                                   |

The worst offenders force **every caller** into the same gating pattern:

```typescript
// Pattern repeated across 15+ call sites:
const x = resolveFile(path);
if (!x) { throw new Error(...); }  // or return null, or return 0, or show error UI

const agent = resolveAgent(identifier);
if (!agent) { throw new Error(...); }

const dir = resolveRunDir(id);
if (!dir) { await ensureRunDir(id); dir = getRunDir(id); }
```

### Industry Patterns

**1. OrThrow / OrDefault Convention** (Rust `unwrap`/`unwrap_or`, Kotlin `getOrNull`/`getOrThrow`):

Provide paired functions — one that returns `T | null` for callers that handle absence, one that throws for callers that expect presence:

```typescript
// src/tools/latex/figureExtractionShared.ts already does this right:
resolveLatexFileOrThrow(path)  // throws ToolError — name signals it

// Apply universally:
resolveAgent(id): ResolvedAgent | undefined      // for callers that handle absence
resolveAgentOrThrow(id): ResolvedAgent            // for callers that expect presence

resolveStoragePath(...): string | undefined       // for callers that handle absence
resolveStoragePathOrThrow(...): string            // for callers that expect presence
```

**2. Result Type / Discriminated Union** (Rust `Result<T, E>`, Go `(T, error)`):

Return a discriminated union that forces the caller to handle both cases explicitly:

```typescript
type Resolution<T> = { ok: true; value: T } | { ok: false; reason: string };

function resolveFile(path: string): Resolution<string> {
  const abs = WorkspaceFS.toAbsolute(path);
  if (!existsSync(abs)) return { ok: false, reason: `File not found: ${path}` };
  return { ok: true, value: abs };
}
```

**3. Eliminate the Resolve** (simplest — often the right answer):

Many `resolve*` functions exist because lookup + validation are separated from use. If the caller always needs the value and always throws on absence, the "resolve" step is unnecessary indirection — inline the lookup and throw at the source:

```typescript
// Before: resolve returns nullable, every caller gates
const dir = resolveRunDir(id);
if (!dir) {
  await ensureRunDir(id);
  dir = getRunDir(id);
}

// After: ensureRunDir always returns a valid path
const dir = await ensureRunDir(id); // creates if needed, throws if truly impossible
```

### Recommendation for This Refactor

The logging pipeline refactor touches two `resolve*` functions directly:

1. **`resolveActiveGroupId()`** — Returns `string | undefined`. Used in `AgentLogger` methods as a `??` fallback. This is fine: `undefined` means "no active group" which is a valid state (ungrouped log entry). **No change needed** — the nullable return is semantically correct here.

2. **`resolveAgent()`** / **`resolveAgentBase()`** — Not in the logging pipeline scope. Leave for a separate pass.

For the broader codebase, adopt the **OrThrow convention** as a naming standard:

- Functions that return nullable: keep the base name (`resolveFile`, `resolveAgent`)
- Functions that throw on failure: suffix with `OrThrow` (`resolveFileOrThrow`, `resolveAgentOrThrow`)
- Functions that always succeed: no suffix needed, but consider renaming away from `resolve` to `get` or `compute` to signal infallibility

This is orthogonal to the store-and-notify refactor but worth standardizing in a separate pass.

## Design Decisions Summary

| Decision                                     | Pattern                                                 | Why                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dirty set for late updates                   | **Dirty page tracking** (OS buffer pools, database CDC) | Cursor-only delta misses entries updated after the cursor passes them (e.g. tool completion). Dirty set tracks _which_ entries mutated — O(1) per update, typically 1 entry. |
| `setTimeout(16)` flush cap                   | **Frame-rate cap** (VSync, React batching)              | `queueMicrotask` won't batch across HTTP chunks. 16ms gives ~60fps, 6x better than current 100ms throttle.                                                                   |
| Dual-write sub-phases                        | **Strangler fig** (Stripe, GitHub migrations)           | Run old + new paths simultaneously, verify parity, then cut over. Each sub-phase is revertible.                                                                              |
| Temporary `bus.emit` for task groups         | **Bridge pattern**                                      | VSCodeTransport deletion kills task group events before Phase 3 replaces them. Temporary direct emits fill the gap.                                                          |
| ToolUseCycleFlow → `logger.updateToolUse()`  | **Single write point**                                  | Eliminates direct `bus.emit` bypass and the separate 500ms throttle. All mutations flow through store.                                                                       |
| `AsyncLocalStorage.run()` over `enterWith()` | **Structured concurrency** (Kotlin, Swift, Java)        | `.run()` scopes context to callback lifetime. No manual push/pop, no corruption on missed cleanup.                                                                           |
