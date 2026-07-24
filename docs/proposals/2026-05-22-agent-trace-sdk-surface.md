# Agent Trace — SDK Surface Design

**Status:** Implemented (2026-05-23). `AgentLogger` deleted; all callers migrated to `AgentTrace`. See §8 for what landed and §9 for design deviations.
**Date:** 2026-05-22 (proposal); 2026-05-23 (implementation)
**Related:** [`2026-05-17-logger-simplification-feasibility.md`](./2026-05-17-logger-simplification-feasibility.md) (overlapping but distinct concern — that proposal is about internal LOC reduction; this one is about the _shape_ SDK consumers would see)

## TL;DR

If we ever expose `src/agent/` as an Agent SDK, the current logger surface
is the biggest readability blocker — not because it pulls in `vscode`
(it doesn't), but because **two parallel logger systems** plus
**~32 domain methods on `AgentLogger`** plus **product concerns
(`StreamLogStore`, `UsageLogService`/Supabase)** are all mixed in one class.

Recommendation: collapse to a **single discriminated-event channel
(`AgentTrace`) on `RunContext`**, with plain `debug/info/warn/error`
as sugar over the same `emit()`. SDK consumers see one interface; TeXRA's
transcript/Supabase/StreamLogStore become subscribers in
`packages/extension/`.

## 1. The problem

### Two overlapping logger systems

- `@logger/AgentLogger` — structured stages, transcript, ~32 instance methods.
- `@agent/core/logger` — thin `debug/info/warn/error` facade over `platform().log`.

256 `logger.debug()` calls in `src/agent/` use the second; 45 imports of
the structured logger thread the first. SDK consumers shouldn't have to
learn both.

### Penetration

| Directory             | Logger imports | Module-load singletons |
| --------------------- | -------------: | ---------------------: |
| `src/agent/`          |             45 |                      5 |
| `src/tools/`          |             16 |                      5 |
| `src/latex/`          |             12 |                      0 |
| `src/model/`          |              0 |                      0 |
| `packages/extension/` |         (many) |                      3 |

13 sites construct `new AgentLogger(...)` at module load (e.g.
`PlanTool.ts:46`, `executeAgent.ts:66`). These prevent injection of a
consumer-provided sink without monkey-patching.

### Host concerns leaking into core

- `StreamLogStore` — TeXRA's webview transcript persistence (multi-stream,
  in-place streamed, history-browsable). Not an SDK concern.
- `UsageLogService` — Supabase telemetry. Not an SDK concern.
- `MESSAGE_TYPES` taxonomy + group/stage IDs — TeXRA's transcript shape.
  Useful as an event vocabulary but not as a logger API.

## 2. Proposed shape: `AgentTrace`

One channel, discriminated union, single emit boundary.

```typescript
type AgentEvent =
  | { type: 'log'; level: LogLevel; message: string; data?: unknown }
  | { type: 'stage.start'; id: string; label: string; parentId?: string }
  | { type: 'stage.end'; id: string; status: EndGroupStatus }
  | { type: 'tool.start'; id: string; name: string; input: unknown }
  | { type: 'tool.end'; id: string; output: unknown; status: ToolStatus }
  | { type: 'usage'; stats: TokenUsageStats }
  | { type: 'context.state'; inputTokens: number; contextWindow: number }
  | { type: 'files.loaded'; category: string; entries: FileEntry[] }
  | { type: 'stream.start'; id: string; kind: StreamKind }
  | { type: 'stream.chunk'; id: string; text: string }
  | { type: 'stream.end'; id: string; finalText?: string }
  | { type: 'domain'; key: string; data: unknown }; // TeXRA-specific escape hatch

interface AgentTrace {
  emit(event: AgentEvent): void;

  // Sugar — pure delegation to emit():
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;

  // Stateful sub-handles for things that aren't fire-and-forget:
  openStage(label: string, opts?: StageOptions): StageHandle;
  openStream(kind: StreamKind): StreamHandle;
}
```

Lives on `RunContext` alongside the existing `RunLogger`:

```typescript
interface RunContext {
  readonly trace: AgentTrace; // ← new
  // ... existing fields (RunLogger collapses into trace via sugar)
}
```

Default `trace` is a no-op emitter, so SDK consumers who don't care get
silence for free (mirrors the existing `noopLog` pattern at
`RunContext.ts:63`).

### Why one channel (not two)

The earlier sketch had `logger` and `events` as siblings. That has a real
SSoT problem:

- `AgentLogger.logToolUseStart` (line 409–420) calls `this.debug(...)`
  **and** `this.emitToolUse(...)` atomically today. Splitting the surface
  forces callers to remember both, and they will drift.
- Today, `log()` (line 210) stamps every debug/info/warn/error with
  `resolveActiveGroupId()` so plain log lines nest under the right stage
  in the transcript. Splitting `logger` from `events` either loses this
  or re-implements the lookup on the logger side.

Folding into one channel with sugar methods avoids both. The discriminated
union is the contract — adding a new event type yields an exhaustive-switch
error in subscribers until handled, which is the SSoT enforcement we want.

## 3. Single emit boundary (kills the `resolve*` smell)

`AgentLogger.resolveActiveGroupId()` is called from **10 sites inside
`AgentLogger.ts`** (lines 210, 321, 399, 414, 439, 448, 454, 459, 492, 512).
Every domain method does its own `options.groupId ?? this.resolveActiveGroupId()`
dance. This is stage-context resolution happening at the wrong layer.

In `AgentTrace`, the stamp happens once:

```typescript
class TraceEmitter implements AgentTrace {
  private stageStack = new AsyncLocalStorage<StageId[]>();

  emit(event: AgentEvent): void {
    const stamped = { ...event, stageId: this.stageStack.getStore()?.at(-1) };
    for (const sub of this.subscribers) sub(stamped);
  }

  debug(msg: string, data?: unknown): void {
    this.emit({ type: 'log', level: 'debug', message: msg, data });
  }
  // every other method is one emit() line. No resolve calls.
}
```

10 call sites collapse to 1. `resolveActiveGroupId` ceases to exist as a
public method.

### Same smell elsewhere: `MemoryTool.resolveMemoryPath`

`src/tools/memory/MemoryTool.ts` — every public op (`view`, `create`,
`strReplace`, `insert`, `delete`, `rename`, `pin`, `unpin`) opens with
`this.resolveMemoryPath(inputPath)` as its first line: 9 calls across 7
methods. Fix is identical — resolve once at `execute()` dispatch, then
ops receive an already-normalized path (ideally a branded
`ResolvedMemoryPath` type so a raw input string becomes a compile error
inside ops).

### General rule worth writing into review guidelines

> If `foo ?? this.resolveX()` (or `this.resolveX(input)` as the first
> line of an operation) appears at 3+ method entries of the same class,
> the resolution belongs at the dispatch boundary, not the method
> boundary.

## 4. What moves where

| Bucket         | Today                                                                                         | After                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Plain logging  | `debug/info/warn/error` on `AgentLogger`                                                      | `AgentTrace` sugar → emits `{type:'log'}`                                     |
| Domain events  | `stage/logToolUse*/statistics/logContext*/fileList/missingOutputs/createStream` (~20 methods) | `AgentEvent` union arms                                                       |
| Host product   | `StreamLogStore` writes, throttling, `UsageLogService`, `MESSAGE_TYPES` taxonomy              | TeXRA subscriber(s) in `packages/extension/`                                  |
| TeXRA-specific | `latexDiff`, `logScratchpad`                                                                  | `{type:'domain', key:'latexDiff', data}` (escape hatch keeps SDK union clean) |

`StreamLogEntry` becomes a thin serialization of `AgentEvent` (ideally same
field names and shapes — one transform from event to stored entry, not
three).

## 5. Migration order (cheap → expensive)

1. **Add `trace: AgentTrace` to `RunContext` with no-op default emitter.**
   Zero call-site changes. `RunLogger` keeps working in parallel.
2. **Implement `TexraTranscriptRecorder`** subscribing to `AgentTrace`,
   writing to `StreamLogStore`. Wire it in `AgentLaunchContext.ts:210`
   alongside today's `new AgentLogger(streamId, true)`. AgentLogger keeps
   working in parallel. Pure addition, no risk.
3. **Migrate one domain at a time** — recommended order:
   1. `tool.start/end` (touches 16 tool files, of which 5 are module-load
      singletons that also get rewired to receive trace via context)
   2. `usage` + `context.state`
   3. `stage.start/end`
   4. `stream.*` (the createStream path)
   5. `files.loaded`, `domain` escape hatch consumers
4. **Delete `AgentLogger`** when no callers remain. `AgentTrace` is the
   SDK surface; `RunLogger` becomes an alias for the sugar methods.

Steps 1–2 are pure addition. Steps 3–4 are the real refactor but each
domain is independent and individually shippable.

## 6. Precursor cleanup (no SDK work required)

The two `resolve*` lifts in §3 are mechanical and worth doing before any
broader refactor. They reduce ~19 callsites to 2 and establish the
"resolve at dispatch boundary, not method boundary" pattern in the
codebase, which makes the AgentTrace single-emit story easier to argue
for in review.

- `AgentLogger.resolveActiveGroupId` → stamped once in `log()` /
  `emit()` rather than 10 method entries.
- `MemoryTool.resolveMemoryPath` → resolved once in `execute()` rather
  than 7 op entries; ops take a `ResolvedMemoryPath` brand.

## 7. Open questions

1. **Naming collision with `src/eventBus/ProgressEventBus`.** `AgentTrace`
   sidesteps it; if we prefer `AgentEvents`, we should at minimum
   restructure or rename so SDK readers don't conflate the two.
2. **Domain escape hatch shape.** `{type:'domain', key, data}` is
   simple but type-unsafe. Alternative: parameterize as
   `AgentTrace<DomainExt>` so TeXRA layers types on top. Lean toward the
   simple escape hatch — generics in every signature is a heavier price.
3. **Streams as events vs. handles.** Treating `stream.start/chunk/end`
   as events keeps the union exhaustive, but callers want a
   `StreamWriter` handle. Resolved by `openStream()` returning a handle
   that internally emits the three event types. Same pattern for stages
   via `openStage()`.
4. **Redaction.** `redactSecrets` runs per-method in AgentLogger today.
   In the new model, applied once at `emit()`, before subscribers see
   anything. Confirm this is the right boundary (it almost certainly is).

## 8. Implementation status (2026-05-23)

All four migration steps from §5, plus both precursor cleanups from §6,
shipped on `claude/agent-trace-sdk-surface-UzsKR`:

- **`src/agent/trace/`** — `AgentEvent` discriminated union, `AgentTrace`
  interface, `TraceEmitter` with a single stage-stamp at `emit()`, and
  `noopTrace` for SDK consumers who don't subscribe.
- **`RunContext.trace`** — defaults to `noopTrace`; populated by
  `AgentLaunchContext` with the live emitter so every run has an SDK
  channel attached. The default `RunLogger` (`debug/info/warn/error`)
  forwards into the trace so plain log lines arrive as `{type:'log'}`.
- **`src/logger/TexraTranscriptRecorder.ts`** — subscriber that converts
  `AgentEvent` into the existing `StreamLogStore` writes (webview
  transcript). The exhaustive `switch (event.type)` enforces SSoT —
  adding a new arm forces an error here.
- **`logUtils.attachChannelSubscriber`** — single function that routes
  `log` events from a trace into the per-channel output sinks (VS Code
  output channels in the extension, console elsewhere). Replaces the
  former `consoleSubscriber.ts` shim and the structuredLogger middleman
  inside logUtils — there is now one write per log event, straight from
  the subscriber into the sink.
- **`src/logger/runTrace.ts`** — `createChannelTrace(name)` for module-
  load debug singletons; `createRunTrace(streamId)` for agent runs
  (wires console + transcript subscribers and a `dispose()` for
  shutdown). These factories replace `new AgentLogger(...)`.
- **`AgentLogger` deleted** — every one of the ~36 production `new
AgentLogger(...)` call sites, the ~50 `AgentLogger` type annotations,
  and every test using the class migrated to `AgentTrace` /
  `createChannelTrace` / `createRunTrace`. The single-emit boundary
  collapsed the ~10 internal `resolveActiveGroupId()` calls to one
  (precursor §6 #1).
- **`MemoryTool.resolveMemoryPath`** — precursor §6 #2 was already done
  by an earlier change: `execute()` dispatches via `locate()` and ops
  receive a normalized `MemoryLocation` instead of raw paths.

What this buys us: the trace channel is the single emission point, every
event is structured, subscribers are independent, and SDK consumers can
attach with `runContext.trace.subscribe(fn)`. No code path writes to
`StreamLogStore` directly anymore.

## 9. Trade-off vs. the lean-AgentTrace vision

The proposal envisioned ~10 methods on `AgentTrace`. The implementation
keeps ~30 — every sugar method `AgentLogger` historically exposed
(`logError`, `logProgress`, `logFileCategory`, `statistics`,
`logToolUseStart`, `updateToolUse`, `stage`, `createStream`, etc.) lives
on `AgentTrace`. Every one is a one-liner over `emit()`, so subscribers
still see a clean structured event stream — the trade-off is purely
interface size.

Why: the alternative was inlining the helper bodies at ~810 call sites,
which would have turned the migration into a multi-day surgery
(`agentLogger.logError(msg, err, ctx)` → `trace.error(msg, {
messageType: MESSAGE_TYPES.ERROR, data: buildErrorLogData(err, ctx) })`)
without changing the runtime behavior. Keeping the sugar made deletion
of `AgentLogger` a same-day mechanical rename. The SSoT property the
proposal cared about (single emit channel, exhaustive subscriber
switch, no product coupling) is unaffected.

If future SDK consumers want the leaner surface, the helpers can be
peeled off one at a time — they're already structured so each method
body is the inlined version.

## 10. Verification

Counts and line refs in this proposal:

- `AgentLogger.resolveActiveGroupId` callsites: confirmed 10 in
  `src/logger/AgentLogger.ts` (definition at line 621).
- `MemoryTool.resolveMemoryPath` callsites: confirmed 9 across 7 public
  methods in `src/tools/memory/MemoryTool.ts`.
- Logger imports: `src/agent/` 45, `src/tools/` 16, `src/latex/` 12,
  `src/model/` 0.
- `logger.debug()` callsites in `src/agent/`: 256.
- `AgentLogger` instance methods: ~32.
- Module-load `new AgentLogger(...)` sites (non-test): 13 total (5
  `src/agent/`, 5 `src/tools/`, 3 `packages/extension/`).
- `src/logger/` vscode imports: 0.
- `AgentLogger.logToolUseStart` atomic debug+emit: confirmed at
  `src/logger/AgentLogger.ts:409–420`.
